# C3 · design.md · 内容工作台（console-content-workbench）

> 需求：`prd.md`（AC-5 / AC-7 / AC-11）。父设计：`../10-13-wechat-flow-console/design.md` §5.4。
> 依赖：C1（基座 + DB）、C2（jobs/worker/scheduler；`generate`/`regenerate` 在 C2 显式未实现）。
> 契约：`.trellis/spec/console/{api,data-model,security}.md`。
> 铁律：① AI 只产内容，其余确定性；② 草稿箱真实 DOM（`verifyDraftBody`）是唯一真相源。

---

## 1. 目标与边界

**做**：计划编辑 → 触发生成 → SSE 看进度 → 看产物 → 推送草稿箱 → 带反馈重生成 → 版本对比。
**不做**：改 `verifyDraftBody` 本身/发布判定；agent 对话（C4）；隧道/邮件（C5）；公网加固（C6）。

**范围外但会被调用**：`runPublish`（推送）、`verifyDraftBody`（引擎内部收尾）——C3 **只复用、不改判定**。

## 2. 组件与依赖方向

```
src/console/
  content/generate.ts     ← 新增：文章生成的编排（调 engine + 版本快照 + 落 DB）
  db/dao/articles.ts      ← 新增：articles / drafts 的 DAO
  http/sse.ts             ← 新增：零依赖 SSE（job 进度流）
  server.ts               ← 增 articles 路由 + `GET /api/jobs/:id/stream`
  jobs/worker.ts          ← `generate` / `regenerate` 从占位改为真实现
  ui/workbench.{html,js}  ← 新增：工作台页（计划编辑 + 进度 + 产物 + 版本）
src/publisher.ts          ← 【需确认】抽出可复用的 `runArticleGeneration`
```

依赖方向仍是 `console/* → ../*.ts`；engine **不**反向依赖 console。

## 3. 与 engine 的接口（关键决策）

### D1 · 文章生成：抽出 `runArticleGeneration`（**本计划唯一的 engine 改动，需用户确认**）

现状：文章生成逻辑**内联在 `runPublish` 里**（`src/publisher.ts:66-113`），无独立导出。
C3 需要「只生成文章、不推送草稿箱」以及「带用户反馈重生成」，现有导出无法表达。

**方案（推荐，改动最小且行为保持）**：把内联块抽成导出函数，`runPublish` 改为调用它。

```ts
// src/publisher.ts —— 新增导出（纯提取，不改逻辑）
export interface ArticleGenResult {
  ok: boolean; date: string; articlePath: string; title?: string; error?: string; reused?: boolean;
}
export async function runArticleGeneration(
  cfg: AppConfig,
  opts: { date?: string; feedback?: string; reuse?: boolean } = {},
): Promise<ArticleGenResult>;
```

- `runPublish` 内部把原内联块替换为 `await runArticleGeneration(cfg, { date, reuse: opts.reuse })`，**其余流程逐字不变**。
- `feedback` **仅在非空时**追加一段提示词（`## 修改要求（用户反馈）\n<feedback>`）；**为空时提示词与今天逐字节相同**（用快照对比验证）。
- 失败通知（`notify`）沿用原样；返回值语义与今天一致。

**替代方案（不推荐）**：console 侧自己 `renderTemplate` + `runPi` → 提示词/超时/兜底模型逻辑会被复制，必然漂移，违反「单一真源」。故不采纳。

> **GATE**：这是对发布链路的**附加式重构**（不改成功判定、不改 `verifyDraftBody`）。开工前需用户明确确认（见 `implement.md` §0 G-C3）。

### D2 · 版本链：base 文件恒为「最新」，历史按版本快照

- engine 发布只认 `<date>-<slug>.md`（`runPublish` 内算的 base 路径），**不可改**。
- 约定：**base 路径永远保存最新一版**；每次生成后把内容快照为 `<date>-<slug>.v<N>.md`。
  - `generate`（v1）：引擎写 base → 快照 `.v1.md` → `articles` 行 `version=1, parent_id=NULL, file_path=.v1.md`。
  - `regenerate`（vN+1）：带 `feedback` 让引擎重写 base → 覆盖 `articles.file_path` 的旧版本已在 `.vN.md` 保留 → 快照 `.v(N+1).md` → 新行 `version=N+1, parent_id=旧行 id`。
- 好处：**旧版本永不丢**、可 diff；`publish` 无需改（永远发 base = 最新）；engine 零感知。
- `articles.status`：`draft`（已生成未推送）/ `pushed`（已推送）——由 C3 在推送成功后更新。

### D3 · 推送与真相源

- 「推送」= C2 已有的 `publish` job（`runPublish`）。C3 **不新增发布路径**。
- `runPublish` 返回 `ok:true` **当且仅当**引擎内部 `verifyDraftBody` 通过（铁律②，engine 既有语义）。
- 推送后写 `drafts`：`verified = res.ok ? 1 : 0`，`verify_detail = res.error ?? "ok"`，`push_at`。UI 据此显示 `✅ 正文校验` 或失败详情；**UI 不自行判成功**。
- UI 的「推送」按钮入队 `{kind:'publish', payload:{date, reuse:true}}`（`reuse:true` 复用刚生成的 base，避免二次生成）。

## 4. 数据模型（复用 C1 已建表，**不加列**）

`articles(id, account_id, plan_id, date, title, slug, file_path, status, version, parent_id, feedback, created_at)`
`drafts(id, account_id, article_id, wechat_title, push_at, verified, verify_detail, created_at)`

**不变量（新增）**

| # | 不变量 | 保障 |
|---|---|---|
| I15 | 同账号+同日期，`articles.version` 单调递增且不重复 | `(account_id,date,version)` 唯一性由 DAO 插入前查 max+1 保证；快照文件同名即同版本 |
| I16 | `parent_id` 链：v(N+1).parent_id = vN.id（v1 为 NULL） | `regenerate` 由传入 `articleId` 反查 |
| I17 | base 文件 = 最新版本内容 | 每次生成后 `copy(base → .vN.md)`；`publish` 恒读 base |
| I18 | 推送成败 = 引擎 `verifyDraftBody` 结果 | C3 只落 `drafts.verified`，**不增设**「上游自报即成功」判定（H5） |

## 5. API（C3 增量，沿用统一错误包）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/accounts/:id/articles?date=&limit=` | 列表（按日期/版本倒序）；含每篇的 `version`/`parentId`/`status`/`drafts.verified` |
| GET | `/api/articles/:id` | 详情：行 + `content`（md）+ `coverPath` + 版本链（`versions[]`）+ `drafts[]` |
| POST | `/api/articles/:id/regenerate` | `{feedback}`（可空）→ 入队 `regenerate` 任务 → `201 {job}`；写 audit `article.regenerate` |
| POST | `/api/accounts/:id/articles/generate` | `{date}` → 入队 `generate` → `201 {job}`（与 `POST /jobs` 语义相同，UI 便利入口） |
| GET | `/api/jobs/:id/stream` | **SSE**：`job.progress` / `job.log` / `job.done`；`Last-Event-ID` 续传；15s 心跳 |

- 鉴权：全部先 `assertAccountAccess`；`articles/:id` / `jobs/:id/stream` 由 `account_id` 反查（同 C2 `loadJob` 模式）。
- `POST /api/accounts/:id/jobs` 的 `kind=generate|regenerate` 在 C3 起**返回 201**（C2 为 400），`payload`：`generate`=`{date}`、`regenerate`=`{date, articleId, feedback?}`。

### SSE 契约

- 事件：`job.progress {jobId,status,progress,message}`、`job.log {jobId,ts,level,message}`（`id=` 用 `job_logs.id`）、`job.done {jobId,status,error}`。
- 实现：`Bun.serve` 返回 `ReadableStream`；服务端每 ~700ms 轮询 `jobs` 行 + 自 `Last-Event-ID` 起的 `job_logs`，状态终态后发 `job.done` 并关闭。心跳注释行 `: ping`。
- 零依赖；不引入 EventEmitter/WS。

## 6. 关键流程

### 6.1 generate
`POST /jobs {kind:'generate',payload:{date}}` → worker：`loadConfig(alias)` → `runArticleGeneration(cfg,{date})`
→ ok：读 base → 快照 `.v1.md` → 插 `articles`(v1) → `succeeded`；否则 `failed(error)`（AC-11）。

### 6.2 regenerate
`POST /api/articles/:id/regenerate {feedback}` → 入队 `regenerate {date,articleId,feedback}`
→ worker：`runArticleGeneration(cfg,{date,feedback})` → 快照 `.v(N+1).md` → 插 `articles`(v(N+1),parent_id) → `succeeded`。

### 6.3 push（复用 C2）
`POST /jobs {kind:'publish',payload:{date,reuse:true}}` → `runPublish` → 成功写 `drafts.verified=1` + `articles.status='pushed'`；失败 `failed` + 详情。

### 6.4 UI（`workbench.html`）
左：计划编辑器（周/月，add/remove 行，保存 = `PUT /plans`）。中：生成/推送按钮 + SSE 进度条 + 日志。
右：产物列表（版本链）→ 选中看 md/封面/校验结果 → 输入反馈 → 重生成 → 版本 diff（纯文本行对比）。

## 7. 权衡与替代

- **不做独立 `articles/` 目录结构改造**：沿用 engine 既有 `data/<alias>/articles/` 与命名，快照只加 `.vN` 后缀。
- **SSE 用轮询而非 pub/sub**：worker 与 server 同进程但不共享事件总线；轮询 `jobs`/`job_logs` 零依赖、可续传、崩溃后仍正确。代价是 ~700ms 延迟（可接受）。
- **不动 `runPublish` 判定**：`ok` 语义完全保留；C3 只读结果。这是能通过 AC-11 的关键。

## 8. 回滚

- engine 侧：`runArticleGeneration` 是纯提取，回滚 = 还原 `publisher.ts` 单文件（行为不变，风险极低）。
- console 侧：C3 新增文件独立；`worker.ts` 的 `generate`/`regenerate` 分支回到「`failed('C3 未实现')`」即回退。
- 数据：`articles`/`drafts` 为纯增量表，回滚不影响 `plans`/`jobs` 与发布幂等（`state/published.json`）。

## 9. 验收映射

| AC | 落地 |
|---|---|
| AC-5 | UI 配「下周 7 天」→ `PUT /plans` → 生成任务可见流转 → `data/<alias>/articles/` 落文件 → 真机 `bun src/cli.ts drafts --date <日期>` 含 `✅ 正文校验`（250 上执行，G2） |
| AC-7 | 对已生成文章重生成 + 反馈 → 新 `articles` 行（`version+1`、`parent_id` 指旧）→ 旧版本文件可查/可比 → 新版本可再次推送 |
| AC-11 | 生成/推送失败 → `jobs.status='failed'` + 非空 `error` → UI 失败面板 + 重试入口；**绝不显示成功** |
