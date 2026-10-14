# Agent Session（pi RPC + 人在环）

> 状态：**v2（已随 C4 校准；v2 明确预期关闭也须清算 pending）**。源：父任务 `design.md` §5.5、子任务 `10-13-console-agent-session/design.md`（D1–D13）、
> 以及**已安装 pi 版本**的官方文档 `docs/rpc.md` / `rpc-commands.md` / `rpc-extension-ui.md` / `docs/json.md` / `docs/extensions.md`。
> 契约与代码冲突时：**先改本文件，再改代码**。pi 侧协议细节以官方文档为准；本文件只固定控制台的**映射与不变量**。

---

## 1. 进程模型（D1）

- 每条 `chat_sessions` 行 ↔ **1 个**长活 `pi --mode rpc` 子进程（`node:child_process.spawn`，见 `agent/rpc.ts`）。
- **懒启动**：`GET /api/chats/:id/stream` 或首条 `POST .../messages` 时 `manager.ensureSpawn()` 才真正拉起；
  并发多次调用由 `live.spawning` Promise 去重。
- **并发上限** `CONSOLE_CHAT_MAX`（默认 **3**）：超出 → `409 chat_limit`（失败显形，不静默排队）。
- **空闲回收** `CONSOLE_CHAT_TTL_MS`（默认 **30min**）：`sweepIdle` 优雅关闭（`close(2000)`→超时 SIGKILL），
  会话落 `idle`（非 `lost`），保留 `session_file` 以便下次 `--session` 续接。
  **关闭时若仍有 `pending` 决策，同事务置 `lost`（I21/I23，`chats.closeChatSession`）**，否则会留下"进程已死但卡片仍可点"的悬挂。
- **退出清理**：`main.ts` 在 `serve` 退出时 `await chat.shutdown()` 关闭全部子进程。
- 启动参数基线（`manager.buildSpawnArgs`）：

  ```
  <pi|CONSOLE_PI_BIN> --mode rpc \
    --tools read,grep,find,ls,console_ask \
    --extension <repoRoot>/src/console/agent/extensions/console-decision.ts \
    --append-system-prompt <dataDir>/console/agent-context-<accountId>.txt \
    --session-dir <dataDir>/sessions/console \
    [--session <session_file>]      # 仅当 DB 已有持久化会话文件
    [--model <model>] [--thinking <level>]
  ```

  末尾 `argv[0]` 解析：`CONSOLE_PI_BIN` > `repoRoot`? 否；优先级 = `CONSOLE_PI_BIN` → `deps.piBinOverride` → `AppConfig.piBin` → `"pi"`。`cwd = repoRoot`。
- **不传 `--no-session`**：会话必须持久化，`fork`/`clone`/续接才有意义（D9）。
- 边界：**stdout 只读协议帧**；诊断/日志走 **stderr**（200 行环形缓冲，`handle.stderrTail()`），**绝不当协议解析**。

---

## 2. 帧协议（严格 JSONL —— 硬约束）

- 解码器 `agent/frames.ts#createFrameDecoder`：
  - 记录 = 一个 JSON 对象 + `LF(\n)`；**只在 `\n` 切分**，剥掉单个尾随 `\r`，丢弃**零长度**行；
  - **`U+2028` / `U+2029` 永不作为行界**（合法 JSON 字符串内容）；**禁止 `readline`**；
  - `flush()` 在流结束时返回残余；`setEncoding("utf8")`。
- 背压：持续读 stdout；写 stdin 经 `writeChain` 串行化，`write()` 返回 `false` 时等 `drain`。
- 记录族：

| 方向 | 记录 | 用途 |
|---|---|---|
| stdin | `{id,type:"<command>",...}` | 下发命令 |
| stdout | `{id,type:"response",success,data\|error}` | 命令应答（**按 `id` 关联，不按顺序**） |
| stdout | session event（`message_*` / `tool_execution_*` / `agent_settled` …） | 会话活动流 |
| 双向 | `extension_ui_request` / `extension_ui_response` | 人在环交互子协议 |

- `response` 只代表**命令被受理**，不代表模型工作完成；必须继续消费事件流直到 `agent_settled`。
- 关联语义（`rpc.ts#send`）：为每命令生成 `id`（`c<seq>`），`Map<id,{resolve,reject,timer}>`；
  默认超时 **15s**（`timer.unref()`）；`success:false` → reject（`rpc <type> failed: <error>`）；超时 → reject（`rpc <type> timed out after Nms`）。
  进程退出 → 所有 in-flight 以 `rpc process exited` reject；`onRecord/onStderr` 抛错不影响协议。

---

## 3. 命令封装（`agent/rpc.ts` / `agent/manager.ts`）

| 控制台动作 | RPC 记录 | 备注 |
|---|---|---|
| 发消息 | `{type:"prompt",message[,streamingBehavior:"steer"]}` | 运行中（`live.busy`）才带 `streamingBehavior`；读 `data.disposition`（`started`/`queued`/`handled`） |
| 追加指令 | `{type:"steer",message}` / `{type:"follow_up",message}` | 多轮追加；未落 `chat_messages` 权威消息前不落 assistant 行 |
| 中止 | `{type:"abort"}` | 中止当前轮次；UI 事件 `chat.aborted` |
| 换模型 | `{type:"set_model",provider,modelId}` | 回填到 `SessionView`/UI；**无 `--provider` 启动参数** |
| 分支/克隆 | `{type:"fork",entryId}` / `{type:"clone"}` | 结果经 `refreshState`（`get_state`）回填 `pi_session_id`/`session_file` |
| 状态 | `{type:"get_state"}` | spawn 后 `afterSpawn` 与 fork/clone 后 `refreshState` 均调用 |
| 断连 | `handle.close(gracefulMs)`：`expectedExit=true` + `stdin.end()` → 超时 SIGKILL | 与意外退出严格区分（`onExit({code,signal,expected})`） |

- 用户消息在 prompt/steer/followUp **受理时立即落库**（`role:"user"`），assistant 仅在 `message_end` 落库（I22）。

---

## 4. 事件 → 控制台映射（`agent/events.ts#ChatBus` → SSE）

> EventBus 为**进程内**（同一 `serve` 进程内即 pi 子进程所在进程）：每会话 500 条环形缓冲，
> `seq` 单调且 = SSE `id:`；重连用 `Last-Event-ID` 回放，落后窗口 → `gap` 触发客户端 `chat.resync`（D5）。
> **订阅必须在 `prompt` 之前建立**，避免错过快速完成的事件。SSE 由 `http/chat-sse.ts` 渲染（15s 心跳 `ping`）。

| pi 记录 | 控制台行为 | SSE 事件（`data`） |
|---|---|---|
| `message_update.assistantMessageEvent.text_delta` | 流式渲染（**不落库**） | `chat.delta {contentIndex,delta}` |
| `…thinking_delta` | 思考流渲染（**不落库**） | `chat.thinking {contentIndex,delta}` |
| `…text_end` / `…thinking_end` | 区块结束标记 | `chat.block_end {contentIndex,block,content}` |
| `…toolcall_start` | 工具调用开始（流内） | `chat.tool_call {contentIndex,phase:"start",toolCallId,toolName}` |
| `message_end`（role=assistant） | 落 `chat_messages`（权威完整消息） | `chat.message`（`MessageView`） |
| `tool_execution_start` / `tool_execution_end` | 活动流 + 审计 `agent.tool` | `chat.tool {phase,toolCallId,toolName,args?/isError?}` |
| `agent_start` | 标记忙碌 | `chat.busy {busy:true}` |
| `agent_settled` | 该轮真正结束（**不要**用 `agent_end` 当结束） | `chat.settled {busy:false}` |
| `extension_ui_request`（dialog 方法） | 落 `decisions(status=pending)` + 审计 `agent.decision.pending` | `decision.pending`（`DecisionView`） |
| `extension_ui_request`（`notify`/`setStatus`/`setTitle`） | fire-and-forget 提示/状态条/标题 | `chat.notify` / `chat.status` / `chat.title` |
| `extension_ui_request`（`setWidget`/`set_editor_text`） | 忽略（控制台暂不渲染） | — |
| 应答写回 | `{type:"extension_ui_response",id,...}` 写 stdin | `decision.answered` |
| response `success:false` | 失败显形（**SSE 无独立 `chat.error`**；命令调用处 reject 并回 HTTP 错误） | — |
| 进程**意外**退出 | 会话 `lost` + pending→`lost` + 审计 `chat.lost` | `chat.lost {reason:"process_exit",code,signal,stderr,lostDecisions}` |
| 进程**预期**关闭（TTL `sweepIdle` / 删除 / 退出） | 会话 `idle`（TTL）或 `closed`（删除/退出），**同事务**把该会话所有 `pending` 置 `lost`（I21/I23，`chats.closeChatSession`） | `chat.closed {reason:"idle"\|"closed",lostDecisions}`；每条被判终态的决策另发 `decision.expired` |
| SSE 建流 | 回放 + 打开 | `chat.open {chatId,lastEventId,replayGap}`；落后窗口先 `chat.resync {chatId,lastEventId}` |

补充事件：`chat.aborted`（abort）、`chat.forked {entryId,cancelled}`、`chat.cloned {cancelled}`。

---

## 5. 决策生命周期（人在环，D6）

`decisions.status`：`pending → {answered, cancelled, expired, lost}`，**不留悬挂**（`data-model.md` I6/I19/I20/I21/I23）。

| 触发 | 结果 |
|---|---|
| `POST /api/decisions/:id` | 先落库 `answered`/`cancelled`（I20：非 `pending` → `409 decision_not_pending`），**再**把 `extension_ui_response` 按原 `id` 写回 stdin；审计 `agent.decision.answer`/`cancel` |
| pi 侧超时（request 带 `timeout`） | **权威超时在 pi 侧**自动解决；控制台仅按 `timeout_ms` 起一个**展示计时器**，到点把该行标 `expired` + 审计 + `decision.expired` |
| 用户取消 | `cancelled`（`cancelled:true` 短路，任何方法适用） |
| 进程异常退出 | 该会话所有 `pending` 置 `lost`（与 `chat_sessions.status='lost'` **同事务**，I23），UI 显式提示 |
| 进程**预期**关闭（TTL `sweepIdle` / 删除 / `shutdown`） | 该会话状态置 `idle`/`closed`，其 `pending` **同事务**置 `lost`（I23，`chats.closeChatSession`）并发 `decision.expired`；**不允许**把 `pending` 留在无进程的会话上（I21） |
| 启动回收 | `manager.reapStale()`：无活子进程的 `active`/`idle` 会话 → `lost` + pending→`lost`（同事务） |

- 方法参数校验（路由侧）：`select` 要求 `value` ∈ `options_json`（否则 400）；`confirm` 取 `confirmed:boolean`；
  `input`/`editor` 取字符串 `value`（截断 20000）；`cancelled:true` 一律优先。
- 去重（I19）：`request_id` 全局唯一，`INSERT OR IGNORE`；重复投递不重复建卡。

---

## 6. 最小权限（R3.5 —— 硬约束，D7）

**两层防护，缺一不可**：

1. **CLI 白名单**：`--tools read,grep,find,ls,console_ask` —— 进程根本看不到其它工具。
2. **扩展兜底**：`agent/extensions/console-decision.ts`
   - `READ_ONLY_TOOLS = ["read","grep","find","ls","console_ask"]`（`isReadOnly`）；
   - `FORBIDDEN_PATTERNS = [/^wechat/i,/^publish/i,/_publish$/i,/^mail/i,/^email/i,/^smtp/i,/^backup/i]` → `pi.on("tool_call")` 直接 `{block:true,reason}`（**绝不转卡片**，连人工放行都没有）；
   - 其余非只读工具 → **逐次** `ctx.ui.confirm` 转人工决策卡；无 UI 时阻断（fail-safe）；
   - `console_ask` 是**唯一**人机问答通道（`kind:confirm|select|input|editor` → `ctx.ui.<method>`），供 agent 主动提问。
   - **注解（annotations）不是放行依据**——`needsApproval` 只认名字白名单。
- **控制台不提供「完全放开」开关**；无 `dangerouslyAllowAll`。任何提权都必须由用户在决策卡片上显式确认。
- 内容生成仍走 engine 导出函数/CLI，**不把发布权限下放给 agent 会话**。

---

## 7. 上下文注入 / 会话分支（D8/D9）

- 账号上下文写入 `<dataDir>/console/agent-context-<accountId>.txt`，经 `--append-system-prompt <file>` 注入；
  engine `config.json` / `runPublish` **无感知**，**不暴露**任何微信/邮箱/密钥凭据。
- 每账号上下文文件按 `accountId` 命名，隔离并发会话。
- 会话持久化到 `--session-dir`，`get_state` 回填 `chat_sessions.pi_session_id` / `session_file`（migration v2）；
  `fork`/`clone` 后 `refreshState` 再回填；会话树可视化 **Out of Scope**。

---

## 8. HTTP 面（控制台，D11）

| 方法/路径 | 说明 |
|---|---|
| `GET/POST /api/accounts/:id/chats` | 列出/新建会话 |
| `GET/DELETE /api/chats/:id` | 详情（`session`/`messages`/`decisions`/`live`/`busy`）/ 删除并关闭 |
| `POST /api/chats/:id/messages` | 发消息（≤20000 字） |
| `POST /api/chats/:id/steer` / `follow-up` | 追加指令 |
| `POST /api/chats/:id/abort` | 中止 |
| `POST /api/chats/:id/model` | 换模型（`provider`+`modelId` 必填） |
| `POST /api/chats/:id/fork` / `clone` | 分支 / 克隆 |
| `GET /api/chats/:id/stream` | SSE（`Last-Event-ID` 或 `?last_event_id=`；`x-accel-buffering:no`） |
| `POST /api/decisions/:id` | 作答（写回 pi + 落终态） |
| `GET /api/decisions` | 列表（`status`、按账号可见性过滤、limit 100） |

- Owner 仅可见 `account_grants` 内账号（越权 403 + 审计 `denied`）；所有写操作需 CSRF 头。
- 审计动作：`chat.create/close/prompt/abort/fork/clone/model.set`、`agent.tool`、`agent.decision.pending/answer/cancel/expired`、`chat.lost`。
- `ChatManager` 缺失（未初始化）→ 全部 `/api/chats*`、`/api/decisions*` → `503 chat_unavailable`（失败显形）。

---

## 9. 失败显形（D13 —— 硬约束）

- **意外退出**：同事务 会话 `lost` + pending→`lost` → 审计 `chat.lost` → SSE `chat.lost{reason,code,signal,stderr,lostDecisions}`；UI 顶部横幅。
- **启动回收**：`reapStale()` 处理上一进程崩溃遗留的 `active`/`idle`。
- **命令失败**：`send()` reject → 路由回落到 `HttpError`（4xx/5xx 带 `code`），**绝不 `ok:true`**。
- **spawn 失败**（如 `chat_limit`）：SSE 建流**不因此失败**（fire-and-forget `ensureSpawn().catch()`），错误在 `prompt` 时以 409 显形。
- 禁止伪装成功：没有 `message_end` 就没有 `chat.message`；没有 `agent_settled` 就没有 `chat.settled`。

---

## 10. 测试与参考

- 测试夹具：`/tmp/fake-pi.ts`（**仅测试**）——实现同一 RPC 帧协议，脚本化 `ASK:confirm|select|input|editor|timeout`、
  `CRASH`（意外退出）、`TOOL`、`U2028`；经 `CONSOLE_PI_BIN` 注入。单测 `/tmp/wfc-c4-unit.ts`，e2e `/tmp/wfc-c4-e2e.sh`，
  全量 `/tmp/wfc-c4-verify.sh`。
- pi 官方：`docs/rpc.md`、`docs/rpc-commands.md`、`docs/rpc-extension-ui.md`、`docs/json.md`、`docs/extensions.md`。
- 本项目：父任务 `design.md` §5.5；子任务 `10-13-console-agent-session/{design.md,implement.md}`。
