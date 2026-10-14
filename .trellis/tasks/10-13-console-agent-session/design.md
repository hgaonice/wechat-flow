# C4 · design.md · Agent 会话窗口与人在环（console-agent-session）

> 父任务 `10-13-wechat-flow-console` §5.5；协议契约 `.trellis/spec/console/agent-session.md`（v0）。
> 本设计**以已安装 pi 的官方文档为准**（`docs/rpc.md`、`rpc-commands.md`、`rpc-extension-ui.md`、`json.md`、`extensions.md`、`cli.md`），
> 并在 §9 列出对 v0 契约的**校准项**（实现阶段随 spec 一起升级到 v1）。

## 1. 目标与边界

**做**：每账号可开多个「聊天会话窗口」，与 `pi --mode rpc` 长活子进程多轮对话；流式输出实时可见；
agent 的 `ctx.ui.*` 交互以**决策卡片**形式交用户操作；危险工具**无绕过路径**；进程异常退出**失败显形**。

**不做**（Out of Scope，沿用 prd）：原生 App、语音、Telegram Mini App、E2E 中继、Web 终端、Work Graph；
SDK 进程内集成；**发布权限下放给 agent**。

**硬边界**：
- 不改 `src/pi.ts` / `src/wechat.ts` / `src/publisher.ts` / `runPublish` 推送链路。
- 不新增任何 runtime 第三方依赖（`package.json.dependencies` 保持缺省）；只用 `node:*` + `Bun.spawn` + `bun:sqlite`。
- 不复用 pi 包导出的 `RpcClient`（会把 pi 变成运行时依赖）→ 自实现极简客户端。

## 2. 组件与依赖方向

```
http/server.ts ──► agent/manager.ts ──► agent/rpc.ts ──► (spawn) pi --mode rpc
     │                    │                  │
     │                    │                  └── stdio: 严格 JSONL
     │                    ├── agent/events.ts      (EventBus + 环形缓冲，进程内)
     │                    └── db/dao/chats.ts ──► chat_sessions / chat_messages / decisions
     └── http/chat-sse.ts ◄── EventBus
ui/chat.{html,css,js} ◄── SSE + REST
agent/extensions/console-decision.ts  (pi 侧扩展，--extension 加载)
```

- `agent/manager.ts` 是**唯一**持有 `Map<chatSessionId, RpcHandle>` 的地方；HTTP 层不直接碰子进程。
- `agent/events.ts` 是**进程内** bus（worker 与 server 同进程，不同于 C3 的 DB 轮询 SSE）。
- 依赖方向单向：`http → agent → db`；`db` 不 import `agent`。

## 3. 关键决策

### D1 · 进程模型：懒启动、每会话 1 进程、有上限
- `chat_sessions` 行 ↔ 1 个 pi 子进程；**首次 `prompt`/`stream` 时才 spawn**（列表页不烧进程）。
- 并发上限 `CONSOLE_CHAT_MAX`（默认 3）；超限则新建会话返回 `409 chat_limit`（**显式失败**，不静默降级）。
- 空闲 TTL `CONSOLE_CHAT_TTL_MS`（默认 30min）：到期**有序关闭**（关 stdin，等退出，超时 SIGKILL），会话标 `closed`。
- `serve` 退出（SIGINT/SIGTERM）时关闭全部会话。
- 启动参数（基线）：
  ```
  pi --mode rpc
     --session-dir <dataDir>/sessions/console
     --tools read,grep,find,ls,console_ask
     --extension <repoRoot>/src/console/agent/extensions/console-decision.ts
     [--provider <p> --model <m>]        # 来自账号生效配置，缺省则用 pi 默认
     [--thinking <level>]
  ```
  cwd = repo 根（只读工具集，无需写权限）；账号上下文用 `--append-system-prompt <file>` 注入（临时文件，见 D8）。
- 可注入二进制：`CONSOLE_PI_BIN`（默认 `pi`）——测试用 fake pi 的入口（见 §7）。

### D2 · 帧协议：严格 JSONL，自实现切帧（纯函数、可单测）
- `agent/frames.ts`：`createFrameDecoder(): { push(chunk: string): string[] ; flush(): string[] }`。
  - 只按 `\n` 切；剥尾部单个 `\r`；**绝不**把 `U+2028`/`U+2029` 当行界。
  - 禁用 `readline`（pi 文档明确点名）。
  - 不缓存未完成帧以外的状态；跨 chunk 半帧由内部 buffer 承接。
- stdout 用 `setEncoding("utf8")` 持续读取（背压：不断读）；写 stdin 检查 `write()` 返回值/`drain`。
- stderr 只进诊断 ring buffer（每会话最近 200 行）**绝不**当协议解析。

### D3 · 命令关联：按 `id`，不按顺序
- `RpcHandle.send(cmd, { timeoutMs })` → 生成 `id`（`c<seq>`），注册 `Map<id, {resolve, reject, timer}>`。
- 收到 `{type:"response", id}` → 兑现；无 `id` 的 parse 响应 → 广播为会话错误事件。
- 命令超时（默认 15s，`abort`/`fork` 放宽）→ reject 且**不**吞掉（UI 显形）。
- `prompt` 的 `data.disposition`：`started|queued|handled`；`handled` 表示无 run 启动 → **不**等待 `agent_settled`（否则永久悬挂）。
- 流式中发 `prompt` 必须带 `streamingBehavior:"steer"`（不带则 pi 返回错误）；`followUp` 走 `follow_up` 命令。

### D4 · 事件 → 控制台映射（SSE）

| pi 事件 | 控制台动作 | SSE |
|---|---|---|
| `message_update` + `assistantMessageEvent.type==="text_delta"` | 流式渲染（**不落库**） | `chat.delta {contentIndex, delta}` |
| `message_update` + `thinking_delta` | 折叠区流式（不落库） | `chat.thinking {delta}` |
| `message_end` | 落 `chat_messages`（权威完整消息；`meta_json` 存 role/stopReason/usage/toolCalls 摘要） | `chat.message` |
| `tool_execution_start` / `tool_execution_end` | 落 `audit`（`agent.tool`，args 摘要截断 2KB） | `chat.tool` |
| `agent_settled` | 本轮真正结束 | `chat.settled` |
| `extension_ui_request`（dialog） | 落 `decisions(pending)` | `decision.pending` |
| `extension_ui_response`（控制台写回后） | `decisions→answered` | `decision.answered` |
| `extension_ui_request`（notify/setStatus/setWidget/setTitle） | fire-and-forget | `notify` / `status` / `widget` / `title` |
| response `success:false` | 失败显形 | `chat.error {reason}` |
| 子进程非有序退出 | 会话/决策 `lost` | `chat.error` + `chat.lost` |

- **订阅先于 prompt**：`manager.chat()` 先 `attach()`（拿 seq 基线）→ 再 `send(prompt)`。
- 事件都带单调 `seq`（见 D5），SSE 的 `id:` = `seq`。

### D5 · 进程内 EventBus + 环形缓冲（含 `Last-Event-ID` 重放）
- `agent/events.ts`：
  ```ts
  type ChatEvent = { seq: number; type: string; data: unknown };
  class ChatBus {
    attach(sessionId: number, fn: (e: ChatEvent) => void): () => void;
    emit(sessionId: number, type: string, data: unknown): ChatEvent; // seq 自增，写环形缓冲
    since(sessionId: number, seq: number): ChatEvent[];             // 重放
    close(sessionId: number): void;                                  // 断开所有订阅者
  }
  ```
- 每会话环形缓冲 **500 条**；`Last-Event-ID` 落后于缓冲 → 发 `chat.resync` 事件，前端重新 `GET /api/chats/:id` 拉全量（**显式**，不假装连续）。
- SSE 心跳 15s（`: ping`）；`idleTimeout: 120`（C3 已在 `main.ts` 设，沿用）。
- 为什么不用 C3 的 DB 轮询：C4 的 bus 与 SSE 在**同一进程**，内存事件零延迟、无需轮询；DB 只存**权威**消息（`message_end`）。

### D6 · 决策生命周期（人在环）——**对 v0 契约的校准点**
`pending → {answered, cancelled, expired, lost}`，无悬挂。

| 触发 | 处置 |
|---|---|
| `extension_ui_request{method:select/confirm/input/editor}` | `insertDecision(pending)` + `decision.pending`；同时在 `RpcHandle` 登记 `requestId → {method, timeoutMs}` |
| `POST /api/decisions/:id` | 校验 `status='pending'` → 写回 `extension_ui_response`（select/input/editor→`value`；confirm→`confirmed`；取消→`cancelled:true`）→ `answered`(带 `answered_by/at`) + audit `agent.decision.answer` |
| pi 侧自动超时 | pi 用默认值自行解决（控制台**不**参与应答） |
| **控制台本地展示计时器** | 按 `timeout_ms` 起一个**只读**定时器：到点仍 `pending` → 标 `expired`（**不**写 stdout），清登记表，SSE `decision.expired` |
| 子进程崩溃 | 该会话所有 `pending` → `lost` + SSE |
| `serve` 启动 reaper | DB 中 `pending` 决策而进程已不存在 → `lost`（重启遗留清理） |

> **校准**：v0 §5 写「控制台不重复实现计时逻辑」——实际**必须**有一个只读计时器，否则 UI 永远停在 `pending`（即"悬挂"），
> 违反 AC-6。落实为：**超时的权威处置仍在 pi 侧**；控制台计时器只更新展示状态。实现阶段同步改 spec/agent-session.md §5。

**去重**：同一 `request_id` 重复到达 → `INSERT OR IGNORE`（`decisions.request_id` 已有 UNIQUE 约束），不产生第二行。

### D7 · 最小权限（R3.5，无绕过路径）
**双层**收窄，两层都无条件生效：

1. **CLI 层**：`--tools read,grep,find,ls,console_ask` —— `write`/`edit`/`bash` 等**不声明给模型**。
2. **扩展层** `agent/extensions/console-decision.ts`（`--extension` 加载，pi 文档写法）：
   - 注册 `console_ask` 工具（**唯一**的人在环通道）：`{kind:"confirm"|"select"|"input"|"editor", title, message?, options?, prefill?}`
     → `ctx.ui.confirm/select/input/editor(...)` → 把用户结果返回给模型。
   - `pi.on("tool_call", async (event, ctx) => …)`：**fail-safe 无条件拦截**——任何不在只读白名单 `read|grep|find|ls` 内的工具调用
     → `ctx.ui.confirm("允许工具调用？", …)`；未通过 → `return { block: true, reason }`。
   - 硬编码**永不授权**名单（即使确认也拒绝）：`wechat*`、`publish*`、`*_publish`、`mail*`、`backup*`，reason 明确写出"控制台不把发布/外发权限下放给会话"。
   - 只读白名单内的调用**直接放行**（无副作用，不刷决策表）；`tool_execution_*` 仍落 `audit`（可验证性）。
3. **无"完全放开"开关**：控制台配置/DB/settings **不存在** `dangerouslyAllowAll` 一类键；扩展不读 settings 决定是否生效。
   提权只能通过用户在决策卡片上的**逐次**显式确认，且仅限名单之外、非永久禁止的工具。
4. **可验证**（AC 对应）：`--tools` 白名单在 `get_state`/启动参数可查；扩展的拦截在 `decisions`/`audit` 表可查；
   单测断言"危险工具在无用户应答时**必然** block"。

### D8 · 账号上下文注入（不进 engine）
- 启动时把账号上下文写入 `<dataDir>/console/agent-context.txt`（临时、每账号覆盖）：
  alias、内容目录、当前计划摘要、以及"禁止发布、需人工在决策卡片确认"的硬规则。
- `--append-system-prompt <该文件>`。引擎 `config.json` 与 `runPublish` 全不感知。
- **不**把 `config.json`（含凭据）暴露给会话；会话拿不到 WeChat 凭据。

### D9 · 会话续接 / fork / clone
- pi 会话**持久化**（`--session-dir`，**不传** `--no-session`）以便 `fork`/`clone`/`switch_session`/`get_entries` 可用。
- `get_state` 回填 `chat_sessions.pi_session_id = data.sessionId`、`session_file = data.sessionFile`、`model`。
- `POST /api/chats/:id/fork {entryId}` → `{type:"fork", entryId}`；`POST /api/chats/:id/clone` → `{type:"clone"}`。
  成功后**重读** `get_state` 更新 `session_file`，并把 fork/clone 记成 `chat_messages`（role=`system`）+ audit。
- 树形可视化 Out of Scope：UI 只提供"从这条消息分支"按钮（`entryId` 取自 `message_end.message.entryId` 有则用）。

### D10 · 数据模型（C4 增量，最小必要）
- **只加 1 列**（migration v2，additive）：
  `ALTER TABLE chat_sessions ADD COLUMN session_file TEXT;`
  （`session_file` 无法从 `sessionId` 安全推导；`--session-dir` 下文件名格式非契约）
- 复用 C1 已建表，不改 CHECK：`chat_sessions.status ∈ {active, idle, lost, closed}`（列无 CHECK，无需迁移）；
  `chat_messages(role, content, meta_json)`；`decisions(method/options_json/timeout_ms/status/response_json/answered_at/answered_by)`。
- 新 DAO `db/dao/chats.ts`：`createChatSession / getChatSession / listChatSessions / setChatStatus / touchChatSession /
  setChatPiRefs / insertChatMessage / listChatMessages / insertDecision / getDecision / getDecisionByRequest /
  listDecisions / answerDecision / expireDecision / loseDecisionsForSession / reapStaleChats`。
- 不变量（写入 spec `data-model.md` I19–I23）：
  - I19 `decisions.request_id` 全局唯一（已有约束），重复请求幂等。
  - I20 终态不可逆：`answered/cancelled/expired/lost` 不再回到 `pending`。
  - I21 会话进程不存在时，不得存在 `pending` 决策。
  - I22 `chat_messages` 只由 `message_end`（权威）写入，不由 `text_delta` 写。
  - I23 会话 `lost` 时 `chat_sessions.status='lost'` 与 `decisions.status='lost'` 同事务提交。

### D11 · 路由与鉴权（C4 增量）
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/accounts/:id/chats` | 会话列表（含 `pending_decisions` 计数） |
| POST | `/api/accounts/:id/chats` | 新建会话（`{title?}`）；超限 409 |
| GET | `/api/chats/:id` | 详情：会话 + 最近 200 条消息 + 未决决策 + `get_state` 快照 |
| DELETE | `/api/chats/:id` | 有序关闭 → `closed` |
| POST | `/api/chats/:id/messages` | `{message, streamingBehavior?}` → `prompt` |
| POST | `/api/chats/:id/steer` / `/follow-up` | 追加指令 |
| POST | `/api/chats/:id/abort` | `{type:"abort"}` |
| POST | `/api/chats/:id/model` | `{provider, modelId}` → `set_model` |
| POST | `/api/chats/:id/fork` / `/clone` | 分支 |
| GET | `/api/chats/:id/stream` | **SSE**（`Last-Event-ID` 支持） |
| POST | `/api/decisions/:id` | `{value?}` / `{confirmed?}` / `{cancelled?}` |
| GET | `/api/decisions` | `?status=pending&accountId=`（管理员视图） |

- 鉴权沿用 C1/C3：`route()` 内**重新**按 session 的账号判定（不信任前端传参）；`owner` 仅限 `account_grants`；越权写 audit `denied`。
- 所有写操作要求 `X-CSRF-Token`。
- audit 动作：`chat.create` / `chat.close` / `chat.prompt` / `chat.abort` / `chat.fork` / `chat.clone` /
  `chat.model.set` / `agent.decision.answer` / `agent.decision.expired` / `agent.decision.lost` / `agent.tool`。

### D12 · UI（`ui/chat.{html,css,js}`）
- 左侧会话列表 + 右侧聊天窗；顶部状态条（`status` 事件）+ 模型选择 + Abort。
- 流式：按 `contentIndex` 维护草稿块，`text_end`/`message_end` 到达即用权威内容替换（不在 `text_delta` 上算终态）。
- 决策卡片：`select` 渲染按钮组、`confirm` 是/否、`input` 单行、`editor` 多行；超时倒计时（展示用）→ 置灰标 `expired`。
- 工具活动：`chat.tool` 折叠展示（"最小权限可验证"的用户侧证据）。
- 失败：`chat.error` / `chat.lost` 红色横幅 + 原因文本（**失败显形**）。
- `chat.resync` → 重新全量拉取，UI 标注"已重新同步"。
- 入口：`ui/index.html` 加入口链接。

### D13 · 失败显形与回收（AC-6 / H5）
- 子进程 `exit`/`error`（非有序关闭）→ 同事务：`chat_sessions.status='lost'` + 该会话 `pending→lost` + audit → SSE `chat.lost{reason}`。
- `serve` 启动：`reapStaleChats()` 把 DB 里 `active|idle` 但内存无进程的会话 → `lost`，其 `pending` → `lost`。
- 任何 4xx/5xx 都带 `code`；**不**把失败包成 `ok:true`。

## 4. 关键流程

**新建 + 首次提问**：`POST /chats`（落 `active`，不 spawn）→ 前端 `GET /chats/:id/stream`（attach，拿 seq 基线）
→ `POST /chats/:id/messages`（懒 spawn + `get_state` 回填 + `prompt`）→ `chat.delta…` → `message_end` 落库 → `agent_settled`。

**决策**：pi `extension_ui_request` → 落 `pending` + `decision.pending` → 用户点卡片 → `POST /decisions/:id`
→ 写回 `extension_ui_response` → `answered` → pi 继续 → `agent_settled`。

**崩溃**：`exit`（非有序）→ 事务标记 `lost` + audit → `chat.lost` → 前端横幅；重连后 `GET /chats/:id` 显示 `lost` 与已 `lost` 的决策。

## 5. 权衡与替代

| 选择 | 替代 | 理由 |
|---|---|---|
| 自实现极简 RPC 客户端 | 导入 pi `RpcClient` / SDK | 保住 engine 零依赖；协议面只需 8 条命令 |
| 进程内 EventBus + 环形缓冲 | 复用 C3 DB 轮询 SSE | 同进程，零延迟；DB 只留权威消息 |
| 持久化 pi 会话 | `--no-session` | 否则 `fork`/`clone` 无法实现 |
| 双层权限收窄 | 仅 CLI `--tools` | 扩展层是 fail-safe，能覆盖未来新增工具，且可审计 |
| 决策超时用只读计时器 | 完全不计时 | 不计时 = UI 悬挂，违反 AC-6 |

## 6. 回滚

- 关闭全部会话（`DELETE /api/chats/:id`），停止 `serve` → 子进程随父退出（见 D1）。
- 代码回滚：C4 为纯增量（新文件 + `server.ts`/`schema.ts` 追加）；revert 提交即可。
- DB：migration v2 只加一列，回滚不删列（`ALTER TABLE DROP COLUMN` 有风险）；旧代码忽略新增列，**向后兼容**。

## 7. 测试策略

- **fake pi**（`src/console/agent/__fixtures__/fake-pi.ts`，仅测试用，不进 build 产物路径）：读 stdin 命令 → 发 `response`；
  按脚本发 `message_update`/`message_end`/`agent_settled`/`extension_ui_request`；支持 `--crash-after`、`--slow`、`--u2028` 模式。
  通过 `CONSOLE_PI_BIN` 注入，**不 mock 我们的模块**（e2e 真跑 RpcClient + manager + HTTP）。
- 单测：`frames.ts`（CRLF/半帧/U+2028）+ `chats.ts` DAO（终态不可逆/I19）+ 扩展拦截逻辑（危险工具必 block）。
- e2e：流式（delta→message→settled）、决策（pending→应答→agent 继续）、超时（→expired）、崩溃（→lost + pending 全 lost）、
  fork/clone、RBAC（他人账号 403 + audit denied）、SSE `Last-Event-ID` 重放与 `chat.resync`。
- 回归：`tsc --noEmit` 0 错；`bun build` 成功；零依赖校验（`dependencies` 缺省）；C1–C3 既有测试仍全绿。

## 8. 验收映射

| AC | 由什么证明 |
|---|---|
| AC-6 流式可见 | fake-pi e2e：`chat.delta` 序列 + `chat.settled`；浏览器手测 |
| AC-6 决策卡片 | e2e：`decisions(pending)` → 应答 → `answered` → agent 继续（`console_ask` 返回值进 `message_end`） |
| AC-6 无悬挂 | e2e：超时 → `expired`；崩溃 → `lost`；`reapStaleChats` 清重启遗留；断言无 `pending` 残留 |
| 进程异常显形 | e2e：`chat_sessions.status='lost'` + SSE `chat.lost` + 非空 `reason` |
| 最小权限可验证 | `--tools` 白名单断言 + 扩展拦截单测（无应答必 block）+ `audit` 表 `agent.tool` 记录 |

## 9. 对 v0 契约（spec/console/agent-session.md）的校准项

1. §1 启动参数：`--no-session` **删除**（改为持久化 + `--session-dir`）；补 `--tools` 白名单与 `--extension`。
2. §3 表格：`follow_up`（下划线）为命令名；`prompt` 流式中用 `streamingBehavior:"steer"`；补 `data.disposition==="handled"` 语义。
3. §5 决策：补"控制台只读展示计时器"（超时处置仍在 pi 侧），并明确 `expired` 不写 stdout。
4. §4 事件：补 `tool_execution_start/end` → `chat.tool` + audit；补 `chat.resync`（缓冲不足重放时）。
5. §2 帧协议：明确 `setEncoding("utf8")` + 自实现 decoder（禁止 `readline`）。
