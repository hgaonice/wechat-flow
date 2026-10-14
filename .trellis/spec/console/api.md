# API Contract（控制台 HTTP / SSE）

> 状态：**v4（C1+C2+C3+C4 已校准；C5–C6 端点仍为契约先验）**，源 `design.md` §5。
> 零依赖约束：路由与响应由 `src/console/http/{router,respond}.ts` 自实现，不引第三方框架。

---

## 1. 通用约定

| 项 | 约定 |
|---|---|
| 基路径 | `/api/*` 为 JSON API；`/health` 免鉴权；其余路径回静态 UI |
| 请求/响应 | `application/json; charset=utf-8`；SSE 用 `text/event-stream` |
| 认证 | `Cookie: wfc_sid=<opaque>`，`HttpOnly; Secure; SameSite=Lax`，服务端存 `token_hash` |
| CSRF | 写请求（POST/PUT/PATCH/DELETE）必须带 `X-CSRF-Token`，与 `login_sessions.csrf_token` 比对 |
| 角色 | `admin`（全通）/ `owner`（仅 `account_grants` 授权账号） |
| 时间 | 一律 ISO-8601（带时区），由 engine `date.ts` 统一时区 |

### 错误包（统一）

```json
{ "ok": false, "code": "forbidden", "message": "account not granted", "detail": {} }
```

| HTTP | code | 触发 |
|---|---|---|
| 400 | `bad_request` | 参数/校验失败 |
| 401 | `unauthorized` | 无/过期/无效会话 |
| 403 | `forbidden` | 越权（跨账号或角色不足）——同时落 `audit` |
| 404 | `not_found` | 资源不存在 |
| 409 | `conflict` | 唯一约束冲突（`alias` / `cdp_port`） |
| 429 | `rate_limited` | 限流 / 登录锁定 |
| 500 | `internal` | 未预期错误（**不得**吞成成功） |

> **失败显形**：任何业务失败必须 `ok:false` + `code` + 可读 `message`；禁止 200 + 伪装成功。
> 409 冲突可带 `detail.suggestions:number[]`（如可用 `cdpPort` 列表）；403 由服务端统一写 `audit(action='denied')`，并记真实 `actor`（未登录时为 `unknown`）。
>
> **任务失败 ≠ HTTP 失败**（C3 UI 必读）：`POST /api/accounts/:id/jobs` 成功受理就返回 `201` 且外层 `ok:true`；
> 任务失败会表现在 **`job.status='failed'` + `job.error`**（`jobs` 表无 `ok` 列）。前端**必须按 `status` 渲染**，不得以 `envelope.ok` 判成败。
>
> **落地状态**：§2.1、§2.2 已随 **C1** 实现（另含 `GET /api/meta`、`GET /api/users`、`POST /api/users`、`PUT /api/users/:id`）；
> §2.3 的**计划 CRUD + 入队/查询/取消已随 C2 落地**；**`generate`/`regenerate` 与 articles + SSE 已随 C3 落地**；
> **§2.4 已随 C4 落地**（路径为**复数** `/api/chats/*`，见下，取代早期单数草案）；§2.5 属 **C5**。

---

## 2. 端点清单（按资源）

### 2.1 认证 / 会话

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/login` | `{username,password}` → 建会话 + Set-Cookie；失败计入锁定 |
| POST | `/api/logout` | 吊销当前会话 |
| GET | `/api/me` | 当前用户 `{user:{id,username,role},csrfToken,grantedAccounts,accounts[],isAdmin}` |
| POST | `/api/password` | 改密（改后吊销其它会话） |

### 2.2 账号与配置

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/accounts` | 列表（owner 仅授权账号） |
| POST | `/api/accounts` | 新建；**校验 alias 唯一 + cdpPort 唯一**，冲突 409 并返回可用端口提示 |
| GET | `/api/accounts/:id` | 详情（含字段来源：`inherited` / `overridden`） |
| PUT | `/api/accounts/:id` | 更新基本信息 + `overrides` |
| DELETE | `/api/accounts/:id` | 删除（**不删** `data/<alias>/`，仅解除登记，显式确认） |
| POST | `/api/accounts/:id/reset-override` | 恢复继承：删除 `overrides` 中某个**顶层键**（`{key}`），返回更新后详情 |
| GET | `/api/settings` | 全局默认（`settings` 表） |
| PUT | `/api/settings` | 更新全局默认 → 触发受影响账号的原子回渲染 `config.json` |

### 2.3 计划 / 任务

**已落地（C2）**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/accounts/:id/plans` | 计划列表（可选 `period_type`/`period_key`/`limit`）；返回 `items` 已解析 |
| PUT | `/api/accounts/:id/plans` | 创建/覆盖计划；**校验**：week 为 `YYYY-Www` 且 `days.length∈[1,7]` 且日期落在该周内；month 为 `YYYY-MM`；每条需 `topic`；`weekday` 服务端自动补齐。入库后**物化**回 `data/<alias>/plans/<week>.json`。写 `audit(plan.upsert)` |
| GET | `/api/accounts/:id/plans/find?date=YYYY-MM-DD` | 反查该日的计划条目 → `{found,planId,periodKey,day}` 或 `{found:false}` |
| POST | `/api/accounts/:id/jobs` | 入队 `{kind, payload}`；C3 起执行 `plan`/`publish`/`generate`/`regenerate` → `201 {job}`；写 `audit(job_enqueue)` |
| GET | `/api/accounts/:id/jobs?status=&limit=` | 该账号任务列表（默认 50） |
| GET | `/api/jobs/:id` | `{job, logs[]}`；`job.status∈{queued,running,succeeded,failed,canceled}`、`progress`、`message`、`error`、`attempts`、`pid`、`payload` |
| POST | `/api/jobs/:id/cancel` | 仅 `queued` 可取消；否则 **409**；写 `audit(job_cancel)` |

- `job` 路由鉴权：由 `job.account_id` 反查（`loadJob()`）而非信任 URL；越权 → 403。
- `payload`：`plan` = `{date?, dryRun?}`；`publish` = `{date?, dryRun?, reuse?, force?}`。

**C3 新增（内容工作台）**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/accounts/:id/articles?date=&limit=` | 文章列表（`date DESC, version DESC`）；每项含 `id/date/title/version/parentId/status/filePath/verified/verifyDetail` |
| GET | `/api/articles/:id` | 详情：`{article, content, coverPath, coverUrl, versions[], drafts[]}`；`content` = 该版快照 md |
| GET | `/api/articles/:id/cover` | 封面 PNG（`image/png`，`private`）；无则 404 |
| POST | `/api/articles/:id/regenerate` | `{feedback?}`（≤8000 字）→ 入队 `regenerate {date,articleId,feedback}` → `201 {job}`；写 `audit(article.regenerate)` |
| POST | `/api/accounts/:id/articles/generate` | `{date:YYYY-MM-DD}` → 入队 `generate` → `201 {job}`（`POST /jobs` 的便利入口） |
| GET | `/api/jobs/:id/stream` | **SSE**（见 §3） |

- `generate`/`regenerate` 的 `payload`：`generate={date}`；`regenerate={date,articleId,feedback?}`。
- **articles 路由鉴权**：`/api/articles/*` 不信任 URL——先取行，再用 `row.account_id` 走 `assertAccountAccess`（同 C2 `loadJob` 模式）。
- **版本链**：`articles.version` 每 (account,date) 单调；`parent_id` 指向上一版；`file_path` 指向不可变快照 `<base>.v<N>.md`，而 engine base（`<date>-<slug>.md`）恒为最新一版——发布读 base。
- **推送结果**：`drafts.verified` 仅镜像 engine `verifyDraftBody` 结果（`runPublish.ok`）；UI 不得自判成功。

### 2.4 会话与人在环（**已落地（C4）**，复数路径）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/accounts/:id/chats` | 列出该账号会话（含 `live`/`busy`/`pendingDecisions`） |
| POST | `/api/accounts/:id/chats` | 新建会话 → `201 {chat}`（**懒启动**：此时不起子进程） |
| GET | `/api/chats/:id` | 详情 `{session,messages,decisions,live,busy}` |
| DELETE | `/api/chats/:id` | 删除并关闭子进程（`expected` 退出 → `closed`） |
| POST | `/api/chats/:id/messages` | 发消息（`{message}` ≤20000）→ `{disposition,busy}`；懒惰 spawn |
| POST | `/api/chats/:id/steer` | 追加（运行中）→ `{disposition}` |
| POST | `/api/chats/:id/follow-up` | 后续轮次 → `{disposition}` |
| POST | `/api/chats/:id/abort` | 中止 → `{aborted:true}` |
| POST | `/api/chats/:id/model` | 换模型（`{provider,modelId}` 必填）→ `{model}` |
| POST | `/api/chats/:id/fork` | 分支（`{entryId}`）→ `{text,cancelled}` |
| POST | `/api/chats/:id/clone` | 克隆 → `{cancelled}` |
| GET | `/api/chats/:id/stream` | **SSE**（见 §3） |
| POST | `/api/decisions/:id` | 作答 → 写回 `extension_ui_response`；非 `pending` → **409 `decision_not_pending`** |
| GET | `/api/decisions?status=` | 决策列表（`status` 限 `pending/answered/cancelled/expired/lost`；按账号可见性过滤；limit 100） |

- 鉴权：`/api/chats/*` 先 `requireSession` 取行，再用 `row.account_id` 过 `assertAccountAccess`（不信任 URL）。
- `ChatManager` 未注入时全部返回 **503 `chat_unavailable`**。
- 决策校验：`select` 的 `value` 必须在 `options_json` 内（否则 400）；`confirm` 取 `confirmed`；`input`/`editor` 取字符串 `value`（截断 20000）；`cancelled:true` 优先。
- 审计：`chat.create/close/prompt/abort/fork/clone/model.set`、`agent.tool`、`agent.decision.pending/answer/cancel/expired`、`chat.lost`。
> 早期单数草案（`/api/accounts/:id/chat`、`/api/chat/:id`…）**已废弃**；实现一律用上表复数路径。

### 2.5 运维 / 管理员

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | **免鉴权**，`{version,db,tunnel,queue}` 摘要 |
| GET/PUT | `/api/accounts/:id/email` | 接收邮箱（多邮箱 + 主题前缀） |
| GET/PUT | `/api/accounts/:id/secrets` | 凭据：读**只回** `{kind,configured,updated_at}`；写只收不发 |
| GET | `/api/tunnels` | 隧道地址历史（`up/down/expired/error`，`replaced_by` 链） |
| GET | `/api/admin/overview` | 管理员全局视图（跨账号总览） |
| GET | `/api/audit` | 审计查询（admin） |

---

## 3. SSE 约定

**已落地（C3）**：`GET /api/jobs/:id/stream`（实现 `src/console/http/sse.ts`）。

- 事件：`job.progress {jobId,status,progress,message}`、`job.log {jobId,ts,level,message}`、`job.done {jobId,status,error}`。
- `job.log` 的 `id:` = `job_logs.id`（单调），支持 `Last-Event-ID` 续传（亦接受 `?last_event_id=`）；**不重不漏**。
- 心跳：每 15s 注释行 `: ping`；Bun `serve` 的 `idleTimeout` 提到 120s（默认 10s 会切断空闲 SSE）。
- 实现为 `ReadableStream` + ~700ms 轮询 `jobs`/`job_logs`（worker 与 server 同进程但**无事件总线**，零依赖且崩溃后可续）；状态进入终态即发 `job.done` 并关流；客户端断开（`cancel`）会清理定时器。
- 鉴权：先 `loadJob`（由 `job.account_id` 反查 `assertAccountAccess`）→ 401/403。

**已落地（C4）**：`GET /api/chats/:id/stream`（实现 `src/console/http/chat-sse.ts`）。

- **不走 DB 轮询**：事件来自**进程内** `agent/events.ts#ChatBus`（pi 子进程与 server 同进程）；每会话 500 条环形缓冲，`id:` = 单调 `seq`。
- 事件名：`chat.open`、`chat.delta`、`chat.thinking`、`chat.block_end`、`chat.tool_call`、`chat.message`、`chat.tool`、`chat.busy`、`chat.settled`、`chat.aborted`、`chat.forked`、`chat.cloned`、`chat.notify`、`chat.status`、`chat.title`、`chat.closed`、`chat.lost`、`chat.resync`、`decision.pending`、`decision.answered`、`decision.expired`。
- 续传：`Last-Event-ID`（或 `?last_event_id=`）→ 回放 `seq > after`；若 `after>0` 且已落后于缓冲窗口，先发 `chat.resync`（`gap:true`）让前端重取全量。
- 建流即**懒启动**子进程（`ensureSpawn` fire-and-forget；spawn 失败不影响本流）。心跳每 15s `ping`。响应头 `no-store` + `x-accel-buffering:no`。
- 鉴权：`loadChat` → `assertAccountAccess`（401/403）。

## 4. 静态 UI

- `src/console/ui/` 下静态文件由 `server.ts` 直接送出；无打包。
- 页面路由（`http/static.ts#ROUTES`）：`/`、`/login`、`/app`、`/account`、`/settings`、`/workbench`、**`/chat`**（C4）。
- 所有动态数据经上述 JSON API / SSE 获取；**不在 HTML 内嵌任何凭据**。
