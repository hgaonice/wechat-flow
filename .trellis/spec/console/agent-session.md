# Agent Session（pi RPC + 人在环）

> 状态：**v0 契约（先行）**，源 `design.md` §5.5 + pi 官方文档 `docs/rpc.md` / `rpc-commands.md` / `rpc-extension-ui.md`。
> 权威定义以**已安装 pi 版本的文档与 `pi --help`** 为准；本文件只固定控制台的**映射与不变量**。

---

## 1. 进程模型

- 每条 `chat_sessions` 行对应 **1 个** `pi --mode rpc` 长活子进程（`Bun.spawn`）。
- 启动参数基线：`pi --mode rpc --no-session --session-dir <data/<alias>/sessions>`（模型/工具按账号配置）。
- 边界：**stdout 只读协议帧**；诊断/日志走 **stderr**，不得当协议解析。
- 空闲与回收：会话可设 TTL；进程退出即回收，见 §5 生命周期。

---

## 2. 帧协议（严格 JSONL —— 硬约束）

- 每条记录为**一个** JSON 对象 + `LF(\n)` 结束；读取时**只在 `\n` 切分**，并剥掉可选的 `\r`（兼容 CRLF）。
- **禁止使用 `readline` 或任何把 `U+2028`/`U+2029` 当行界的读取器**——它们是合法 JSON 字符串内容，会导致丢帧/并帧。
- 背压：持续读 stdout（否则子进程会卡）；写 stdin 时尊重背压。
- 记录族：

| 方向 | 记录 | 用途 |
|---|---|---|
| stdin | `{id?,type:"<command>",...}` | 下发命令 |
| stdout | `{id?,type:"response",command,success,data|error}` | 命令应答（**按 `id` 关联，不按顺序**） |
| stdout | session event（`message_*` / `tool_*` / `agent_settled` …） | 会话活动流 |
| 双向 | `extension_ui_request` / `extension_ui_response` | 人在环交互子协议 |

- `response` 只代表**命令被受理**，不代表模型工作完成；必须继续消费事件流。

---

## 3. 命令封装（`agent/rpc.ts`）

| 控制台动作 | RPC 记录 | 备注 |
|---|---|---|
| 发消息 | `{type:"prompt",message}` | 运行中则带 `streamingBehavior:"steer"`；看 `data.disposition`，`handled` 表示未开跑 |
| 追加指令 | `{type:"steer",...}` / `{type:"follow_up",...}` | 多轮追加 |
| 中止 | `{type:"abort"}` | 中止当前轮次 |
| 状态 | `{type:"get_state"}` / `{type:"get_messages"}` | 装载会话状态/历史 |
| 换模型 | `{type:"set_model",...}` | 也支持 `cycle_model` / `get_available_models` |
| 会话续接/分支 | `{type:"fork"}` / `{type:"clone"}` / `switch_session` | 复用 pi 能力 |
| 断连 | 关闭子进程 stdin | 有序关闭；仍须处理信号与意外退出 |

---

## 4. 事件 → 控制台映射（SSE）

| pi 记录 | 控制台行为 | SSE 事件 |
|---|---|---|
| `message_update.text_delta` | 流式渲染（**不落库**） | `chat.delta` |
| `message_end` | 落 `chat_messages`（权威完整消息） | `chat.message` |
| `agent_settled` | 该轮真正结束（**不要**用 `agent_end` 当结束） | `chat.settled` |
| `extension_ui_request{method:select\|confirm\|input\|editor}` | 落 `decisions(status=pending)` | `decision.pending` |
| `extension_ui_response`（由前端应答触发写回） | 更新 `decisions(status=answered)` | `decision.answered` |
| `notify` / `setStatus` | fire-and-forget 提示/状态条 | `notify` / `status` |
| response `success:false` / 进程退出 | 失败显形（`ok:false` + 原因） | `chat.error` |

> 订阅必须在 `prompt` **之前**建立，避免错过快速完成的事件。

---

## 5. 决策生命周期（人在环）

`decisions.status`：`pending → {answered, cancelled, expired, lost}`，**不留悬挂**（见 `data-model.md` I6）。

| 触发 | 结果 |
|---|---|
| 前端 `POST /api/decisions/:id` | `answered`；把 `extension_ui_response` 按原 `id` 写回 stdin（`value` / `confirmed` / `cancelled:true`） |
| pi 侧超时（request 带 `timeout`） | 由 agent 自动以默认值解决；控制台把该行标 `expired` 供 UI 显示 |
| 用户取消 | `cancelled` |
| 进程异常退出 | 把该会话所有 `pending` 置 `lost` 并在 UI 显式提示 |

**注意**：超时主要由 **agent 侧**处理（request 的 `timeout` 字段），控制台不重复实现计时逻辑，只做状态与展示。

---

## 6. 最小权限（R3.5 —— 硬约束）

- 会话以**受限工具集**启动（`--no-tools` 或只读白名单 + 仅内容目录可写）。
- 危险工具由项目内扩展 `agent/extensions/console-decision.ts` 经 `pi.on("tool_call")` **拦截并转成决策卡片**。
- **控制台不提供「完全放开」开关**；任何提权都必须由用户在决策卡片上显式确认。
- 内容生成仍走 engine 导出函数/CLI，**不把发布权限下放给 agent 会话**。

---

## 7. 参考

- pi 官方：`docs/rpc.md`、`docs/rpc-commands.md`、`docs/rpc-extension-ui.md`、`docs/json.md`、`docs/extensions.md`
- 本项目父任务：`design.md` §5.5；子任务 `10-13-console-agent-session/`
