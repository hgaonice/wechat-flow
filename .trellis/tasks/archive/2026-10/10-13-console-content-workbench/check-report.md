# C3 独立复核报告 · console-content-workbench

- **任务**：`.trellis/tasks/10-13-console-content-workbench`
- **复核对象**：**当前未提交工作树**（`git status` 见 §0）
- **复核人**：Check Agent（`trellis-check`）—— 不采信实施者总结，全部命令在本机重跑
- **日期**：2026-10-14
- **环境**：bun 1.4.2 · node v22.23.2 · `convert`(ImageMagick) 缺失 · Chrome 缺失 · 无 repo 根 `config.json`（`loadConfig` 回落内置默认，打印 `[config] … not found` 属预期）
- **结论**：**PASS**（无阻断项；2 条 Low + 2 条 Info 观察项，均不阻断合入）

> 声明：本报告所有「PASS」均附**真实命令 + 真实输出**；所有结论可复现。测试脚本落在 `/tmp/c3-check-*.ts`（见 §10），运行期临时文件均用 `/tmp` 或临时 `config.json`，用后清理。

---

## 0. 受复核面（工作树实际改动）

```
 M src/console/http/static.ts        M src/console/server.ts
 M src/console/jobs/types.ts         M src/console/ui/index.html
 M src/console/jobs/worker.ts        M src/publisher.ts
 M src/console/main.ts               (+ task .trellis 文件)
?? src/console/content/generate.ts   ?? src/console/db/dao/articles.ts
?? src/console/http/sse.ts           ?? src/console/ui/workbench.{css,html,js}
```

真源文件 `src/wechat.ts` / `src/media.ts` / `src/cover.ts` / `src/state.ts` / `src/notify.ts` / `src/pi.ts` **均未改动**：

```
$ git status --porcelain src/wechat.ts src/media.ts src/cover.ts src/state.ts src/notify.ts src/pi.ts
(empty)
```

---

## 1. 类型 / 构建 / 零依赖 —— PASS

```
$ node_modules/.bin/tsc --noEmit
TSC_OK=0
$ bun build --target=bun src/console/main.ts   → CONSOLE_BUILD_OK
$ bun build --target=bun src/cli.ts            → CLI_BUILD_OK
```

**零运行时依赖**：`package.json` `dependencies` 仍为 `{}`（devDeps 仅 `@types/node`、`typescript`）。
`src/console` 下无任何第三方裸导入（仅相对路径 / `bun:` / `node:`）：

```
$ grep -rEn "from ['\"](@|[a-z]...)" src/console --include='*.ts' | grep -v (相对/bun:/node:)
NONE (only relative/bun:/node:)
```

**H6 迁移期兼容**：`bun src/cli.ts publish --dry-run` 可跑（exit 0，输出 `[WARN] no plan entry …`）；`bun src/cli.ts doctor --all` 可跑（exit 0；`convert`/Chrome/skill 脚本在沙箱缺失属环境，非回归）。

---

## 2. 引擎改动 = 纯提取（D1）+ 提示词逐字节一致 —— PASS

**未依赖实施者的 `/tmp/wfc-c3-prompt-eq.ts`**；用自写脚本 `/tmp/c3-check-prompt-eq.ts` 重建 **HEAD 内联的 `renderTemplate(...)` 调用**，与 `buildArticlePrompt` 对比：

```
PASS  undefined feedback byte-identical        sha=true
PASS  empty feedback byte-identical
PASS  whitespace feedback byte-identical (trim → 仅非空才追加)
PASS  feedback appends exact section           ("\n\n## 修改要求（用户反馈）\n<text>\n")
PASS  feedback section ends with newline
PASS  feedback never alters prefix
base_bytes=3167  new_undef_bytes=3167  new_fb_bytes=3236
```

- 未传/空/纯空白 feedback → **逐字节相同**（base=3167B，sha256 一致）。
- feedback 仅在 **尾部追加** 固定小节，前缀从不改写。

**发布路径唯一性**：`runPublish` 是唯一推送入口；`verifyDraftBody` 仅 `publisher.ts`/`cli.ts` 调用，未改。

---

## 3. `runPublish` 行为不变 —— PASS

对 HEAD 与新工作树分别截取 `runPublish` **生成之后到文件末尾**（192 行）逐行 diff：

```
$ diff /tmp/pub.head.post.txt /tmp/pub.new.post.txt
IDENTICAL (192 lines)
```

生成前区域（`isPublished` 跳过 + 生成委托）diff 仅显示「内联块 → `runArticleGeneration` 委托」，语义一致：

- `isPublished && !reuse && !force` → `skipped:true, ok:true` 复用逻辑**未动**。
- notify / 状态码 / 返回结构在成功路径**逐字节保留**。
- 生成失败仍返回 `{skipped:false, ok:false, error, articlePath}`，**绝不伪造成功**。

**失败显形实测**（`/tmp/c3-check-publish-fail.ts`，`timeoutSec.article=1`，假 pi `exec sleep 30`）：

```
PASS  runPublish ok=false   {"date":"2026-10-21","skipped":false,"ok":false,
                             "error":"article generation failed: timeout","articlePath":"…"}
PASS  runPublish skipped=false
PASS  runPublish error non-empty
PASS  no article file written
PASS  no published.json success
elapsed_ms=1013
PUBLISH-FAIL: ALL PASS
```

---

## 4. 版本链 I15–I18 —— PASS

`/tmp/c3-check-unit.ts`（内存库 + 注入假 runner）与 `/tmp/c3-check-worker.ts`（真 worker + 假 pi）双重跑：

```
# 单调 + 链
PASS  v1 parent_id NULL / v1 file_path = 快照 / status draft
PASS  v2 parent -> v1   PASS  v2 feedback persisted
PASS  v3 parent -> v2   PASS  versions monotonic 1,2,3
PASS  listArticles newest first 3,2,1
# 不可变 + base=最新
PASS  v1 & v2 snapshots preserved (immutable)
PASS  base == latest (v3) / 全 3 快照在盘
# 失败
PASS  failure ok=false + error  PASS  failure inserted NO row  PASS  failure wrote NO v4
# drafts 镜像 res.ok（I18）
PASS  draft ok verified=1 detail=ok → status=pushed
PASS  fail draft verified=0 + detail（复用 latest，不新增版本）
PASS  skipped = no-op
# 账号隔离
PASS  other account starts at v1 / row isolated
```

**假阳性排除（连续两次 regenerate）**：v1→v2→v3 链 `1,2,3`，父链连续，base 恒等最新 v3。

> **观察 ISSUE-1（Low，非阻断）**：`nextVersion` 在写事务**之外**计算，且 `articles` 仅在 `(account_id,date,version)` 上建了**非唯一索引** `idx_articles_acc`（`schema.ts:163`）。`generateArticle`/`recordDraftResult` 都传**显式 version**，故未走 `insertArticle` 的「事务内自动编号」路径；唯一性实际由 **I4（同账号单运行任务）** + Bun 单线程保证。设计 I15 明确「唯一性由 DAO 插入前查 max+1 保证」，因此**符合设计**；仅 `articles.ts` 顶部注释「two inserts can never claim the same」表述强于 DB 层事实。建议二选一：调用点去掉显式 version（让 DAO 事务内分配），或加 UNIQUE 索引 / 收敛注释。

---

## 5. 失败显形（AC-11 / H5）—— PASS

`/tmp/c3-check-worker.ts`（真 `executeJob`）：

```
PASS  generate(missing date) failed + error "missing payload.date"，未写文章
PASS  generate(no plan) failed + error "no plan entry…"，未写文章
PASS  regenerate(missing/bad articleId) failed + error 且命名 article id
PASS  publish(no plan) failed，未写 drafts 行、未写 articles 行
PASS  publish(生成/封面错误) failed + 非空 error，无新增 articles/drafts
```

- 生成失败 → `failed` + 非空 error，**不写 `articles` 行、不落快照**。
- 推送失败且 **未产生任何产物** → **不写伪造 `drafts` 行**（`skipped` 路径直接返回；无 base 文件时不 adopt）。
- 失败推送若已有 `articles` 行 → 按设计 D3/L73 落 `drafts.verified=0` + `verify_detail=error`（是「显形失败」，非伪造成功）。

> **观察 ISSUE-2（Low，非阻断，既有行为）**：`generateTemplateCover`（`src/cover.ts:78`）**抛异常**且 `runPublish` 未 try/catch 包裹，封面失败会在 `recordDraftResult` 之前中断，worker 外层 catch → `failed`（无 drafts 行）。生成后区域与 HEAD **逐字节相同**，属既存行为；沙箱缺 `convert` 才触发，250 主机具备 `convert`。**非 C3 回归**，仅登记。

---

## 6. API / RBAC / CSRF / 审计 —— PASS

`/tmp/c3-check-http.ts`（真 `createApp().handle` + `Bun.serve`，直接建会话/授权）：

```
PASS  anon list/article/SSE → 401
PASS  owner own list → 200
PASS  owner cross-account list/article/stream → 403
PASS  owner2(无授权) list → 403
PASS  admin cross-account → 200
PASS  regenerate/generate 无 X-CSRF-Token → 403
PASS  regenerate → 201 {job:kind=regenerate,payload{date,articleId,feedback}}
PASS  regenerate audit row: action=article.regenerate, actor=owner, target=article:1
PASS  generate malformed date → 400
PASS  owner cross-account article regenerate → 403；403 denial 已入审计
PASS  detail：content=快照正文 / versions=2 / drafts 归位 / coverPath+coverUrl
PASS  cover → 200 image/png
```

- **账号从行反查**：`loadArticle` 用 `row.account_id` 做 `assertAccountAccess`，不信任 URL（跨账号 article/stream 均 403）。
- **CSRF**：所有非 GET/HEAD 在 `route()` 统一校验 `x-csrf-token`，缺失即 403。
- **审计**：regenerate 写 `article.regenerate`；403 拒绝经请求内 `session` 落 `denied`（不跨请求串 actor）。

> **Info（非阻断）**：`POST /articles/generate` 仅校验 `date` 的 `YYYY-MM-DD` 形态；`2026-13-99` 形态合法 → `201`，随后 worker 以 `failed: no plan entry` 显形（AC-11 兜底）。设计未要求日历级校验。

---

## 7. SSE 契约 + Bun idleTimeout —— PASS

**HTTP 端到端**（同上脚本）：

```
PASS  SSE has job.progress
PASS  SSE has 3 job.log
PASS  SSE log id = job_logs.id  ids=1,2,3
PASS  SSE no job.done yet (not terminal)
PASS  SSE resume delivers L4 only（Last-Event-ID=3 → 仅第 4 条，无重复/无跳号）
PASS  SSE resume no duplicate L1-L3
PASS  SSE job.done succeeded
PASS  owner cross-account stream → 403 / admin → 200
```

**心跳 / 终态关闭 / 计时器清理**（`/tmp/c3-check-sse.ts`，直接调 `streamJobEvents`）：

```
PASS  terminal stream closes (reader done)
PASS  terminal emits job.done（succeeded）
PASS  log frame carries id
PASS  heartbeat ': ping' emitted
PASS  two timers armed (poll + ping)
PASS  client cancel clears both timers  cleared=2
PASS  missing job emits job.done failed
```

**`main.ts` `idleTimeout:120` 合理性**（`/tmp/c3-check-idle.ts`）：Bun 默认 10s idle 会割断长于 10s 的空闲 SSE；实测：

```
default idleTimeout: closedAt=12004ms   （并打印 Bun 警告 "timed out a request after 10 seconds"）
idleTimeout=120:     still open at 14s
```

15s 心跳 > 默认 10s，故提升 idleTimeout **必要且正确**。

---

## 8. 仓库污染 + .gitignore —— PASS

```
$ for p in config.json config.json.bak data console; do …; done
absent: config.json   absent: config.json.bak   absent: data   absent: console
```

`.gitignore` 覆盖正确：`/console/`、`data/`、`config.json`、`config.json.bak`、`sessions/`、`logs/`、`plans/`、`articles/`、`imgs/`、`state/`、`.env`。

> 复核期由**本 agent 的测试命令**（`publish --dry-run` / `doctor --all`）在根目录生成的 `data/second/logs/{publish,doctor}.log` 已删除；二者本就被 `.gitignore` 忽略，且非实施者遗留。

### 前端静默点（Info，非阻断）
- `workbench.js` 对用户数据一律 `textContent`；`innerHTML` **仅用于清空**（`= ""`），无 XSS 面。
- **ISSUE-3（Info）**：`workbench.html` 含内联 `style="margin-top:12px"`，而 CSP 为 `style-src 'self'`（无 `'unsafe-inline'`），该内联样式会被浏览器忽略；**既有** index/account/login/settings 同款写法，纯外观、无安全影响。

---

## 9. 问题汇总（编号 / 严重度 / 是否阻断 / 位置）

| # | 严重度 | 阻断 | 位置 | 摘要 |
|---|---|---|---|---|
| ISSUE-1 | Low | 否 | `src/console/content/generate.ts`（`nextVersion` 调用点）、`src/console/db/dao/articles.ts`（注释）、`db/schema.ts:163` | 版本号在写事务外分配、无非唯一约束；唯一性依赖 I4 单写者。符合设计，仅 DAO 注释表述过强。建议调用点去显式 version 或加 UNIQUE 索引。 |
| ISSUE-2 | Low | 否 | `src/publisher.ts`（封面调用）、`src/cover.ts:78` | `generateTemplateCover` 抛异常未被捕获 → 封面失败在 `recordDraftResult` 前中断。**既有行为**（生成后区域与 HEAD 逐字节相同），环境相关（缺 `convert`），非 C3 回归。 |
| ISSUE-3 | Info | 否 | `src/console/ui/workbench.html` | 内联 `style` 属性被 `style-src 'self'` CSP 忽略；既有同款写法，纯外观。 |
| ISSUE-4 | Info | 否 | `src/console/server.ts` generate 路由 | 仅校验日期**形态**；`2026-13-99` 通过并由 worker 以 `failed` 显形。设计未要求日历校验。 |

**无 blocking issue。**

---

## 10. 已应用的修复

- **代码修复：无**（未发现需改代码的阻断/正确性问题）。
- **清理（非代码）**：删除复核自身测试命令生成的仓库根 `data/`（gitignored）。清理后 `git status` 仅剩本任务预期改动（§0）。

---

## 11. 无法在本环境验证（需 250 主机 + G2 人工确认）

1. **真实 `pi` 文章生成**的内容质量/模型行为（沙箱假 pi 仅验证编排与失败面）。
2. **真实公众号草稿推送**全链路（API/browser + 封面 + `verifyDraftBody` 真判定；AC-5 的 `✅ 正文校验`）。
3. **真实封面/manim**（宿主 `convert`/`ffmpeg`/manim 具备时才成立）。
4. **浏览器真实加载 `workbench.html`** 的 DOM 行为与 `EventSource` 自动续传（本报告仅验静态语法 + HTTP/SSE 契约；UI 静态语法经 `node --check` 通过）。
5. **I3-7 的 spec / `AGENT.md` 收口**：属于主 agent 收官动作，不在本复核范围。

---

## 12. 复现资产（`/tmp`，可重跑）

| 脚本 | 覆盖 |
|---|---|
| `/tmp/c3-check-prompt-eq.ts` | §2 提示词逐字节一致（自建 HEAD 基线） |
| `/tmp/c3-check-unit.ts` | §4 DAO/版本链/drafts 镜像/隔离 |
| `/tmp/c3-check-worker.ts` | §4 §5 真 worker 编排 + AC-11 |
| `/tmp/c3-check-publish-fail.ts` | §3 生成超时失败显形 |
| `/tmp/c3-check-http.ts` | §6 §7 API/RBAC/CSRF/审计/SSE 端到端 |
| `/tmp/c3-check-sse.ts` | §7 心跳/终态/计时器清理 |
| `/tmp/c3-check-idle.ts` | §7 Bun idleTimeout 合理性 |
| `/tmp/c3chk-pi.sh` | 假 pi（`C3_FAKE_MODE=slow`→`exec sleep`，`C3_FAKE_OUT` 写正文） |

**最终裁决：PASS** —— 8 项 MUST-verify 全通过；4 条观察项均 Low/Info、非阻断，其中 ISSUE-1 建议在收官前顺手收敛（非必须）。
