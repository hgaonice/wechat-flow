# C3 · implement.md · 执行计划（console-content-workbench）

> 设计见 `design.md`；契约见 `.trellis/spec/console/{api,data-model,security}.md`；父排期见父 `implement.md` M2b。
> 完成 = 产物路径 或 真实命令输出；禁止“我记得做过了”。

---

## 0. 开工前置检查

- [x] `prd.md` 就绪
- [x] `design.md` 就绪（本目录）
- [x] 本文件就绪
- [x] `implement.jsonl` / `check.jsonl` 写入真实条目
- [ ] **G-C3（用户确认）**：批准本规划摘要 **且** 明确同意 `design.md` D1 的 **engine 附加式重构**
      （抽出 `runArticleGeneration`；不改成功判定、不改 `verifyDraftBody`）→ 之后才 `task.py start`
- [ ] `python3 .trellis/scripts/task.py start 10-13-console-content-workbench`（`planning → in_progress`）

> 未获 G-C3 前**不动** `src/`（含 engine 与 console）。

---

## 1. 实施顺序（每步含验证）

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
