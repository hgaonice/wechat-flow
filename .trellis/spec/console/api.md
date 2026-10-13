# API Contract（控制台 HTTP / SSE）

> 状态：**v1（C1 已校准；C2–C6 端点仍为契约先验）**，源 `design.md` §5。
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
> 409 冲突可带 `detail.suggestions:number[]`（如可用 `cdpPort` 列表）；403 由服务端统一写 `audit(action='denied')`。
>
> **落地状态**：§2.1、§2.2 已随 **C1** 实现（另含 `GET /api/meta`、`GET /api/users`、`POST /api/users`、`PUT /api/users/:id`）；
> §2.3 属 **C2/C3**，§2.4 属 **C4**，§2.5 属 **C5**。

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

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/accounts/:id/plans` | 计划列表（可按 `period_type`/`period_key` 过滤） |
| PUT | `/api/accounts/:id/plans` | 创建/覆盖周（≤7 条目）或月摘要计划 |
| POST | `/api/accounts/:id/jobs` | 入队 `{kind: plan\|generate\|publish\|regenerate, payload}` |
| GET | `/api/jobs/:id` | 任务状态（`queued→running→succeeded/failed/canceled`）+ progress |
| GET | `/api/jobs/:id/stream` | SSE：`job.progress` / `job.log` / `job.done`（`Last-Event-ID` 续传） |
| GET | `/api/accounts/:id/articles` | 产物列表（md/封面/校验结果、版本链） |
| POST | `/api/articles/:id/regenerate` | 重生成 `{feedback}` → 新 `version`，`parent_id` 指向旧版 |

### 2.4 会话与人在环

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/accounts/:id/chat` | 新建会话（起 pi RPC 子进程） |
| GET | `/api/chat/:id` | 会话信息 + 历史消息 + pending 决策 |
| POST | `/api/chat/:id/message` | 发消息（流式中转 `streamingBehavior:"steer"`；可 `follow_up`） |
| GET | `/api/chat/:id/stream` | SSE：`chat.delta` / `chat.settled` / `decision.pending` / `notify` / `status` |
| POST | `/api/chat/:id/abort` | 中止当前轮次 |
| POST | `/api/decisions/:id` | 应答决策 → 写回 `extension_ui_response` |

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

- 事件名固定；`data:` 为 JSON；每条事件带 `id:`（单调递增）以支持 `Last-Event-ID` 续传。
- 心跳：每 15s 发送注释行 `: ping`，防止反代/隧道掐断。
- 断线重连由浏览器 `EventSource` 自动完成；服务端按 `Last-Event-ID` 从 `job_logs` / `chat_messages` 补发。

## 4. 静态 UI

- `src/console/ui/` 下静态文件由 `server.ts` 直接送出；无打包。
- 所有动态数据经上述 JSON API / SSE 获取；**不在 HTML 内嵌任何凭据**。
