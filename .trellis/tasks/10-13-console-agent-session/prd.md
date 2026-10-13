# C4 · Agent 会话窗口与人在环（console-agent-session）

> 父任务：`10-13-wechat-flow-console`（源需求 R3.4、R3.5）。设计见父 `design.md` §5.5；协议见 `research.md` §3。
> 依赖 C1（建议在 C2 之后，与其他子任务无强耦合）。

## Goal
实现"类 HAPI 精简版"：每个任务窗口可与 pi agent 多轮对话、实时看到流式输出，
并把 agent 抛出的决策以卡片形式交用户操作，控制台只授予最小权限。

## Requirements
- `pi --mode rpc` 长活子进程；严格 JSONL 帧（只在 `\n` 切分，禁止用 `readline`）。
- 命令：`prompt`（流式中用 `streamingBehavior:"steer"`）/`steer`/`follow_up`/`abort`/`get_state`/`get_messages`/`set_model`；按 `id` 关联响应。
- 事件：`message_update.text_delta` → SSE 流式；`message_end` → 落 `chat_messages`；`agent_settled` → 该轮真正结束。
- 决策：`extension_ui_request`（`select`/`confirm`/`input`/`editor`）→ 落 `decisions(pending)` + SSE `decision.pending`；应答写回 `extension_ui_response`；超时/取消/进程崩溃分别置 `expired`/`cancelled`/`lost`。
- 最小权限：`agent/extensions/console-decision.ts` 注册决策工具 + `pi.on("tool_call")` 拦截危险工具；**不提供"完全放开"开关**。
- UI：聊天窗 + 流式渲染 + 决策卡片 + `notify`/`setStatus` 展示。
- 会话续接与 fork（复用 pi `session_id`/`fork`/`clone`）。

## Acceptance Criteria
- AC-6 会话窗口实时看到流式输出；agent 决策以卡片呈现，用户操作后 agent 继续；超时/取消有明确状态且无悬挂 pending。
- 进程异常退出：会话标 `lost`、pending 决策标 `lost`、UI 明确提示（失败显形）。
- 无危险工具的额外授权路径（最小权限可验证）。

## Out of Scope
原生 App、语音、Telegram Mini App、E2E 中继、Web 终端、Work Graph（HAPI 高级特性）。
SDK 进程内集成（选择 RPC 子进程以保住 engine 零依赖）。

## Dependencies
C1。参考：本机 pi 文档 `docs/rpc.md`、`docs/rpc-commands.md`、`docs/rpc-extension-ui.md`、`docs/json.md`、`docs/extensions.md`。

## Notes / 关联文件
`src/console/agent/{rpc,session}.ts`、`src/console/agent/extensions/console-decision.ts`、`src/console/db`（chat_sessions/chat_messages/decisions）。
