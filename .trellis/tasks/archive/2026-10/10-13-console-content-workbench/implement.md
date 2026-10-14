# C3 · implement.md · 执行计划（console-content-workbench）

> 设计见 `design.md`；契约见 `.trellis/spec/console/{api,data-model,security}.md`；父排期见父 `implement.md` M2b。
> 完成 = 产物路径 或 真实命令输出；禁止“我记得做过了”。

---

## 0. 开工前置检查

- [x] `prd.md` 就绪
- [x] `design.md` 就绪（本目录）
- [x] 本文件就绪
- [x] `implement.jsonl` / `check.jsonl` 写入真实条目
- [x] **G-C3（用户确认）**：用户已「批准 C3 开工」（含同意 `design.md` D1 的 engine 附加式重构）
- [x] `python3 .trellis/scripts/task.py start 10-13-console-content-workbench` → `planning → in_progress`（2026-10-14）

> 未获 G-C3 前**不动** `src/`（含 engine 与 console）。

---

## 1. 实施顺序（每步含验证）

> **状态：I3-1..I3-7 全部已完成**（2026-10-14）。实际改动/偏差/未验证见 §6，真实命令输出见 §5。

### I3-1 engine：抽出 `runArticleGeneration`（**需 G-C3**）
- `src/publisher.ts`：把 66-113 行的内联生成块抽为导出函数（签名见 `design.md` D1）；`runPublish` 改为调用它；
  `feedback` 仅非空时追加到提示词。
- **验证**：
  - `tsc --noEmit` 0 错；`bun build` OK；
  - **提示词字节一致**：`feedback` 为空时，渲染出的 prompt 与重构前逐字节相同（脚本 diff）；
  - **行为不变**：重构后 `publish --dry-run`（250/本地）结果与重构前一致；
  - `feedback` 非空时 prompt 含 `## 修改要求（用户反馈）` 段且其余部分不变。

### I3-2 `db/dao/articles.ts`（版本链 DAO）
- `nextVersion(db,accountId,date)`；`insertArticle`（含 `parent_id`/`feedback`/`file_path`）；`getArticle`/`listArticles`；
  `setArticleStatus`；`insertDraft`（`verified`/`verify_detail`）；`listDrafts`。
- **验证**：单测——插 v1→v2（`parent_id=1`）→ v3；`version` 单调；`listArticles` 倒序；`drafts` 关联正确。

### I3-3 `content/generate.ts`（编排 + 快照）
- `snapshotVersion(articlePath, n)`：`copyFile(base → <base>.v<n>.md)`；
- `generateArticle(db,cfg,accountId,date,{feedback?,parentId?})`：
  调 `runArticleGeneration` → ok 则快照 + 落 `articles` 行（v1 或 v(N+1)）→ 返回 `{ok, articleId, version, articlePath}`。
- **验证**：单测（用假 `runArticleGeneration` 注入）——v1 落行；`regenerate` 产生 v2 且旧 `.v1.md` 仍在；
  失败路径不落行、返回 `ok:false`。

### I3-4 `jobs/worker.ts`（`generate` / `regenerate` 真实现）
- `generate`：`payload.date` 必填（缺失 → `failed('missing payload.date')`）；调 `generateArticle`；
- `regenerate`：`payload.articleId` + `date` + 可选 `feedback`；由 `articleId` 反查 `parent_id`；
- `publish` 分支补：成功后写 `drafts`（`verified=res.ok?1:0`）+ `articles.status='pushed'`；
- **保持 H5**：任何失败 → `finish('failed', {error})`，不伪装成功。
- **验证**：HTTP e2e——`kind=generate` 由 C2 的 400 变 201；失败路径（坏日期/模型超时）落 `failed`+`error`。

### I3-5 `http/sse.ts` + `server.ts` 路由
- SSE：`streamJobEvents(db, jobId, lastEventId)` → `ReadableStream`；~700ms 轮询；终态发 `job.done` 并关流；15s `: ping`。
- 路由：`GET /api/accounts/:id/articles`、`GET /api/articles/:id`、`POST /api/articles/:id/regenerate`、
  `POST /api/accounts/:id/articles/generate`、`GET /api/jobs/:id/stream`；`POST /jobs` 放开 `generate|regenerate`；均走 `assertAccountAccess`。
- **验证**：HTTP e2e——SSE 收到 `job.progress` 与 `job.done`；`Last-Event-ID` 续传不重不漏；鉴权 401/403 同 C2；
  `articles/:id` 越权 403；`regenerate` 写 audit。

### I3-6 UI `ui/workbench.{html,js}` + 入口
- 计划编辑（周/月）、生成/推送按钮、SSE 进度、产物列表 + 版本对比、失败面板 + 重试。
- 复用 `app.js` 的 `api()`（含 CSRF 头）与既有 css；`index.html` 加入口链接。
- **验证**：`bun build`；手工加载页面（本地 `serve`）——按钮触发生成、进度可见、失败详情形显示。

### I3-7 spec + 文档收口
- `.trellis/spec/console/{api,data-model,index}.md` 校准 v3（C3 路由、SSE 契约、版本链 I15–I18、engine 接口）。
- `AGENT.md` §1（S14 ✅/S15 🟡）、§3、§5、§8、§9、§10；journal Session 8。

---

## 2. 验收命令（本地可复现）

```bash
export PATH="$HOME/.bun/bin:$PATH"
node_modules/.bin/tsc --noEmit                                   # 0 错
bun build --target=bun src/console/main.ts >/dev/null            # OK
node -e "const p=require('./package.json');if(p.dependencies)process.exit(1)" && echo zero-deps-OK

# 单元：articles 版本链 + 生成编排（注入假生成器）
bun /tmp/wfc-c3-content.ts

# HTTP e2e：articles 路由 + regenerate + SSE + RBAC
bash /tmp/wfc-c3-http.sh

# 失败显形（AC-11）
bash /tmp/wfc-c3-fail.sh
```

## 3. 真机验收（250，G2 规则）

```bash
# 1) 网页配「下周 7 天」→ 触发生成（UI 或 API）
# 2) 文章落盘
ls data/<alias>/articles/ | tail
# 3) 唯一真相源：草稿箱真实 DOM
bun src/cli.ts drafts --date <日期>          # 必须含 ✅ 正文校验
# 4) 重生成 + 反馈 → 新版本
bun src/cli.ts drafts --date <日期>          # 新版本仍可推送
```

## 4. 回滚点

| 阶段 | 回滚 |
|---|---|
| I3-1 后 | `git checkout -- src/publisher.ts`（单文件，行为不变） |
| I3-2..I3-6 后 | 移除 C3 新增文件；`worker.ts` 的 `generate`/`regenerate` 分支恢复为 `failed('C3 未实现')` |
| 数据 | `articles`/`drafts` 为纯增量表；发布幂等仍由 `state/published.json` 决定 |


---

## 5. 验证记录（2026-10-14，真实命令输出）

> 环境：`bun 1.4.2`、`node v22.23.2`、`typescript 5.9.3`（`node_modules/.bin/tsc`）。
> 仓库根无 `config.json`，`loadConfig()` 走内置默认并打印 `[config] … not found` —— 预期噪声，下方输出已过滤。
> 一键复跑：`bash /tmp/wfc-c3-verify.sh`（exit 0；`pass=7 fail=0`）。

```text
══════ tsc --noEmit ══════
── tsc --noEmit: OK
══════ bun build console/main.ts ══════
Bundled 43 modules in 11ms
  wfc-c3-build.js  192.82 KB  (entry point)
── bun build console/main.ts: OK
══════ zero runtime deps ══════
zero-deps-OK  (package.json dependencies = {})
══════ unit /tmp/wfc-c3-content.ts ══════
PASS  v1 ok  {"ok":true,"date":"2026-10-20","articleId":1,"version":1,"articlePath":"/tmp/wfc-c3-bZD08t/2026-10-20-topic.md","snapshotPath":"/tmp/wfc-c3-bZD08t/2026-10-20-topic.v1.md","title":"标题 v1"}
PASS  v1 parent NULL
PASS  v1 row parent_id is null
PASS  v1 file_path is snapshot  /tmp/wfc-c3-bZD08t/2026-10-20-topic.v1.md
PASS  v1 snapshot exists
PASS  v2 ok
PASS  v2 parent links v1  parent=1
PASS  v2 feedback persisted
PASS  v3 ok
PASS  versions monotonic 1,2,3
PASS  v3 parent links v2
PASS  v1 snapshot preserved
PASS  v2 snapshot preserved
PASS  v3 snapshot equals base
PASS  failure returns ok=false
PASS  failure surfaces error  boom
PASS  failure inserts NO row
PASS  failure writes NO v4 snapshot
PASS  other account independent v1  {"ok":true,"date":"2026-10-20","articleId":4,"version":1,"articlePath":"/tmp/wfc-c3-bZD08t/2026-10-20-topic.md","snapshotPath":"/tmp/wfc-c3-bZD08t/2026-10-20-topic.v1.md","title":"标题 v4"}
PASS  listDrafts empty ok
PASS  draft ok adopts base as v1
PASS  draft ok wrote v1 row pushed  status=pushed
PASS  draft ok snapshot exists
PASS  draft ok verified=1 detail=ok  {"id":1,"account_id":1,"article_id":5,"wechat_title":"草稿标题","push_at":"2026-10-14T05:20:58.856Z","verified":1,"verify_detail":"ok","created_at":"2026-10-14 05:20:58"}
PASS  draft fail reuses latest (no new version)
PASS  draft fail records verified=0 + detail
PASS  draft fail leaves status pushed
PASS  draft skipped is a no-op
UNIT: ALL PASS
── unit /tmp/wfc-c3-content.ts: OK
══════ HTTP e2e /tmp/wfc-c3-http.sh ══════
PASS  anon SSE → 401  status=401
PASS  admin login  status=200
PASS  owner login  status=200
PASS  list articles 200
PASS  list articles count=2  [2,1]
PASS  list newest first (v2,v1)
PASS  list carries verify
PASS  detail 200
PASS  detail content = v1 snapshot
PASS  detail versions=2
PASS  detail drafts=1
PASS  detail coverPath null
PASS  detail parentId null
PASS  v2 verify fail surfaced
PASS  v2 parent links v1
PASS  v2 content = v2 snapshot
PASS  regenerate 201  status=201
PASS  regenerate job kind
PASS  regenerate payload articleId
PASS  regenerate payload feedback
PASS  regenerate audit row  n=1
PASS  generate 201  status=201
PASS  generate job kind
PASS  generate bad date 400  status=400
PASS  regenerate without CSRF 403  status=403
PASS  owner cross-account article 403  status=403
PASS  owner cross-account list 403  status=403
PASS  owner own-account list 200  status=200
PASS  SSE job.progress present  n=3
PASS  SSE job.log present + ids  n=2
PASS  SSE job.done succeeded  {"jobId":3,"status":"succeeded","error":null}
PASS  SSE done has no error
PASS  SSE terminal after all logs
PASS  resume cursor captured  ids=3,4
PASS  resume no duplicate logs  ids=5
PASS  resume delivers L3 only
PASS  resume reaches job.done
HTTP: ALL PASS
── HTTP e2e /tmp/wfc-c3-http.sh: OK
══════ AC-11 /tmp/wfc-c3-fail.sh ══════
[job 1] start kind=generate account=second
[job 1] missing payload.date
PASS  generate(missing date) → failed  status=failed
PASS  generate(missing date) error non-empty  error="missing payload.date"
PASS  generate(missing date) mentions payload.date
[job 2] start kind=generate account=second
[2026-10-14T05:21:01.675Z] [WARN] no plan entry for 2026-10-20; run "plan" first
[job 2] no plan entry for 2026-10-20; run "plan" first
PASS  generate(no plan) → failed  status=failed
PASS  generate(no plan) error non-empty  error="no plan entry for 2026-10-20; run \"plan\" first"
PASS  generate(no plan) mentions no plan entry
[job 3] start kind=regenerate account=second
[job 3] regenerate 需要 payload.date 与 payload.articleId
PASS  regenerate(missing articleId) → failed  status=failed
PASS  regenerate(missing articleId) error non-empty  error="regenerate 需要 payload.date 与 payload.articleId"
[job 4] start kind=regenerate account=second
[job 4] parent article 999999 不存在或不属于该账号
PASS  regenerate(bad articleId) → failed  status=failed
PASS  regenerate(bad articleId) error non-empty  error="parent article 999999 不存在或不属于该账号"
PASS  regenerate(bad articleId) names article
PASS  no articles written on any failure
PASS  job #1 has failure logs  n=2
PASS  job #2 has failure logs  n=2
PASS  job #3 has failure logs  n=2
PASS  job #4 has failure logs  n=2
FAIL-PATH: ALL PASS
── AC-11 /tmp/wfc-c3-fail.sh: OK
══════ worker /tmp/wfc-c3-worker.sh ══════
[job 1] start kind=generate account=second
[job 1] generated v1 → /workspaces/other/weixin/wechat-flow/data/second/articles/2026-10-20-一次函数图象.v1.md
PASS  generate job succeeded  status=succeeded err=null
PASS  v1 row written  n=1
PASS  v1 parent_id NULL
PASS  v1 feedback NULL
PASS  v1 title from frontmatter  title=假标题
PASS  v1 snapshot path is .v1.md
PASS  v1 snapshot file exists
PASS  v1 snapshot content = base body
PASS  base file exists
[job 2] start kind=regenerate account=second
[job 2] regenerated v2 (parent=1) → /workspaces/other/weixin/wechat-flow/data/second/articles/2026-10-20-一次函数图象.v2.md
PASS  regenerate job succeeded  status=succeeded err=null
PASS  version chain v1,v2  got=2,1
PASS  v2 parent → v1
PASS  v2 feedback persisted  fb=精简到 800 字
PASS  v2 snapshot is a distinct file
PASS  v2 snapshot has feedback body
PASS  v1 snapshot immutable (no feedback)
PASS  base file holds latest (v2)
WORKER: ALL PASS
── worker /tmp/wfc-c3-worker.sh: OK
══════ byte-equality ══════
empty_feedback_byte_identical=true
undefined_feedback_byte_identical=true
before_bytes=3012 afterEmpty_bytes=3012
feedback_section_appended=true
feedback_prefix_unchanged=true
── byte-equality: OK
══════ SUMMARY: pass=7 fail=0 ══════
```

I3-1 提示词字节一致（`bun /tmp/wfc-c3-prompt-eq.ts`，基线 `/tmp/wfc-c3-prompt-before.txt` = `/tmp/wfc-c3-prompt-before.ts` 生成）：

```text
empty_feedback_byte_identical=true
undefined_feedback_byte_identical=true
before_bytes=3012 afterEmpty_bytes=3012
feedback_section_appended=true
feedback_prefix_unchanged=true
```

验证脚本（保留于 `/tmp`，可复跑）：
`/tmp/wfc-c3-verify.sh`（套件入口）、`/tmp/wfc-c3-content.sh`+`.ts`（单测）、`/tmp/wfc-c3-http.sh`+`.ts`（HTTP e2e）、`/tmp/wfc-c3-fail.sh`+`.ts`（AC-11）、`/tmp/wfc-c3-worker.sh`+`.ts`（worker 正路 + 假 `pi`）、`/tmp/wfc-c3-prompt-eq.ts`（字节一致）。

---

## 6. 交付报告（文件 / 命令 / 偏差 / 未验证）

### 6.1 新增文件（行数）

| 文件 | 行数 | 内容 |
|---|---:|---|
| `src/console/db/dao/articles.ts` | 170 | 版本链 DAO：`nextVersion`（MAX+1）、`insertArticle`（**自动分配时**在 `db.transaction` 内；显式传入时原样使用）/`getArticle`/`listArticles`/`listVersions`/`setArticleStatus`、`insertDraft`/`getDraft`/`listDrafts` |
| `src/console/content/generate.ts` | 192 | 编排 + 快照：`versionedPath`/`snapshotVersion`/`generateArticle`（可注入 `runner`）、`recordDraftResult`（publish 落 `drafts`/`pushed`） |
| `src/console/http/sse.ts` | 148 | `streamJobEvents`（~700ms 轮询、15s ping、终态发 `job.done` 并关流、`Last-Event-ID` 续传） |
| `src/console/ui/workbench.html` | 127 | 工作台页面骨架 |
| `src/console/ui/workbench.css` | 109 | 新增类样式（CSP 禁内联样式） |
| `src/console/ui/workbench.js` | 527 | 计划编辑、生成/推送、SSE 进度+日志、产物/版本/LCS 对比、封面/校验/草稿、反馈重生成、失败面板 |
| **合计** | **1270** | |

### 6.2 修改文件（`git diff --stat -- src/`）

```text
 src/console/http/static.ts |   1 +
 src/console/jobs/types.ts  |   8 ++-
 src/console/jobs/worker.ts |  70 +++++++++++++++++++-
 src/console/main.ts        |   3 +
 src/console/server.ts      | 156 +++++++++++++++++++++++++++++++++++++++++++++
 src/console/ui/index.html  |   1 +
 src/publisher.ts           | 127 ++++++++++++++++++++++++++----------
 7 files changed, 329 insertions(+), 37 deletions(-)
```

- `src/publisher.ts`：抽出 `buildArticlePrompt`（导出，`feedback` 非空才追加段）与 `runArticleGeneration`（导出），新增 `ArticleGenResult`；`runPublish` 改为委托调用，成功判定 / 返回语义 / `wechat.ts` / `verifyDraftBody` 均未改（空 `feedback` 逐字节一致）。
- `src/console/jobs/worker.ts`：`generate`/`regenerate` 真实现；`publish` 成功后调 `recordDraftResult`。
- `src/console/jobs/types.ts`：`EXECUTABLE_KINDS` 增加 `generate|regenerate`；`JobPayload` 增 `articleId?`/`feedback?`。
- `src/console/server.ts`：新增 `GET /api/accounts/:id/articles`、`GET /api/articles/:id`、`GET /api/articles/:id/cover`、`POST /api/articles/:id/regenerate`（audit `article.regenerate`）、`POST /api/accounts/:id/articles/generate`、`GET /api/jobs/:id/stream`；`/api/articles/:id` 与 stream 均按行反查账号 + `assertAccountAccess`。
- `src/console/http/static.ts`：注册 `/workbench`；`src/console/ui/index.html`：加入口链接。

### 6.3 与 `design.md` 的偏差（均为加法，不改契约）

1. **`src/console/main.ts` 增加 `idleTimeout: 120`**：Bun 默认 10s idle 超时会掐断 15s 心跳之间的 SSE 流；不改则 I3-5 的 SSE 契约不成立。属必要修复（测试 harness 同步设置）。
2. **额外导出 `buildArticlePrompt`**：`design.md` D1 只点名 `runArticleGeneration`；为直接做「空 `feedback` 逐字节一致」验证而导出提示词构造器，纯导出、无行为变化。
3. **`generateArticle` 支持注入 `runner`**：测试缝，默认即真实 `runArticleGeneration`。
4. **`recordDraftResult` 落在 `content/generate.ts`**：`design.md` I3-4 只说 publish 分支「补：成功后写 `drafts`」；实现把落库逻辑放进 content 模块、由 worker 调用，保持 worker 不含 DAO 写入细节。
5. **`ArticleGenResult` 接口**：导出函数的返回类型（`design.md` 未列，属签名必需）。
6. **无 schema 变更**：`articles`/`drafts` 用既有基线；`insertArticle` 的显式 `version` 原样尊重、自动分配包在 `db.transaction` 内（I15）。

### 6.4 未验证 / 已知边界

- **真实 `pi` 模型调用**未验证（无凭据/网络）；worker 正路用假 `pi`（解析提示词中的文章路径并落盘）。engine 调用链未改，且 I3-1 已证空反馈逐字节一致。
- **真实微信草稿推送**（`publish` 经 `runPublish`+`wechat`+封面全链路）未跑（需真号/浏览器）。`recordDraftResult` 单测直接覆盖成功/失败/跳过；worker 的 publish 失败路径已被逻辑覆盖，成功路径依赖既有 engine。
- **真实封面/manim 生成**未跑；无封面时路由 404（已断言 `coverPath=null`）。
- **UI 未在浏览器手工加载**（I3-6 的手工验证项）；仅验证 `bun build` 与静态注册。
- **I3-7（spec/AGENT.md 收口）已由主 agent 完成**：`.trellis/spec/console/{index,api,data-model,security}.md` → **v3**（I15–I18、SSE §3、文章路由鉴权/审计）；`AGENT.md` §1/§3/§5/§8(D16–D18)/§9/§10；`src/README.md` 新增 `console/` 小节 + `publisher.ts` 新导出；`tools/repomap.sh` 改为递归扫描 `src/**/*.ts`（补上此前完全缺失的 `src/console/**`）；journal Session 8。
- **独立复核（trellis-check）**：`check-report.md` 结论 **PASS**（8/8 必验项重跑通过）；4 项非阻塞观察：ISSUE-1 `nextVersion` 在写事务外（注释已按事实收敛）、ISSUE-2 封面异常在 `recordDraftResult` 之前抛出（**pre-existing**，非 C3 回退）、ISSUE-3/4 CSS/日期格式提示。
- **已知边界（非验收项）**：若绕过 UI 以 `reuse=false` 触发 `publish`，发布会在 base 文件上重新生成正文，而 `recordDraftResult` 只挂到「已存在的最新 `articles` 行」（其 `file_path` 是旧快照）→ 草稿链接的版本可能与当次推送正文不完全一致。UI 的「生成并推送」固定走 `reuse=true`，不受影响；此边界仅涉及非 UI 调用方。
- **AC-5/AC-7 真机验收（G2）**：需 250 主机（真 `pi` + 真微信草稿推送 + 封面）——`bun src/cli.ts drafts --date <日期>` 应包含 `✅ 正文校验`。本机无凭据/无浏览器，无法代跑。
