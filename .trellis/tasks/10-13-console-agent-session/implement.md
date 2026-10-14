# C4 · implement.md · 执行计划（console-agent-session）

> 设计见 `design.md`；契约 `.trellis/spec/console/agent-session.md`（v0，实现期同步升 v1）；父排期见父 `implement.md` M3。
> 完成 = 产物路径 或 真实命令输出；禁止“我记得做过了”。

---

## 0. 开工前置检查

- [x] `prd.md` 就绪
- [x] `design.md` 就绪（本目录）
- [x] 本文件就绪
- [x] `implement.jsonl` / `check.jsonl` 写入真实条目
- [x] 协议已核对已安装 pi 文档（`rpc.md`/`rpc-commands.md`/`rpc-extension-ui.md`/`json.md`/`extensions.md`/`cli.md`）
- [ ] **G-C4（用户确认）**：用户「批准 C4 开工」（含同意 design D10「新增 migration v2 一列」与 D7「双层最小权限」）
- [ ] `python3 .trellis/scripts/task.py start 10-13-console-agent-session` → `planning → in_progress`

> 未获 G-C4 前**不动** `src/`。本任务是**纯增量**：不触碰 `src/pi.ts` / `src/wechat.ts` / `src/publisher.ts` / 推送链路。

---

## 1. 实施顺序（每步含验证）

### I4-1 `agent/frames.ts` —— 严格 JSONL 切帧（纯函数）
- `createFrameDecoder()`：`push(chunk)` 累积，只按 `\n` 切，剥尾部 `\r`；`flush()` 返回残余。
- **验证**：单测——跨 chunk 半帧、CRLF、空行跳过、**`U+2028`/`U+2029` 不切帧**、大帧。

### I4-2 `agent/rpc.ts` —— 极简 RPC 客户端（不依赖 pi 包）
- `spawnRpc(opts)` → `RpcHandle { pid, send(cmd,{timeoutMs}), on(event,fn), onExit(fn), close(gracefulMs), kill(), alive }`。
- 按 `id` 关联 `response`；`extension_ui_request` 单独回调；stderr → 诊断 ring（200 行）；stdout 只喂 decoder。
- `close()`：关 stdin → 等退出 → 超时 SIGKILL；**有序 vs 非有序**要能区分（`close()` 后的 exit 不算 `lost`）。
- **验证**：`tsc --noEmit` 0 错；对 fake pi 的 8 条命令 round-trip 单测。

### I4-3 DB：migration v2 + `db/dao/chats.ts`
- `schema.ts`：`MIGRATIONS` 追加 `{version:2, name:"chat_session_file", sql:"ALTER TABLE chat_sessions ADD COLUMN session_file TEXT;"}`。
- `dao/chats.ts`：见 design D10 的 16 个函数；终态不可逆（I20）+ 同事务 `lost`（I23）。
- **验证**：单测——旧库（user_version=1）升到 2 且数据不丢；新建库直达 2；`answerDecision` 对非 pending 返回 `null`（不覆盖）；
  `reapStaleChats` 把 `active` + `pending` 一次性置 `lost`。

### I4-4 `agent/extensions/console-decision.ts` —— 最小权限扩展
- 注册 `console_ask` 工具（唯一人在环通道）；`pi.on("tool_call")` fail-safe 拦截 + 永久拒绝名单（design D7）。
- 只 import 类型：`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"`（**仅类型**，不产生运行时依赖）。
- **验证**：`pi --extension <file> --print "say hi"`（有真实 pi 时）启动无错；无 pi 时以 `tsc --noEmit` + 逻辑单测覆盖
  （导出 `needsApproval(toolName, hints)` / `isForbidden(toolName)` 纯函数供单测，扩展入口只做接线）。

### I4-5 `agent/events.ts` + `agent/manager.ts` —— 会话生命周期
- `ChatBus`（design D5）；`manager`：`ensure(id)`（懒 spawn + `get_state` 回填 + 上下文文件）、`prompt/steer/followUp/abort/setModel/fork/clone`、
  `handleExit`（有序→`closed`；异常→`lost` + pending 全 `lost`）、TTL 清理、`CONSOLE_CHAT_MAX`、`reapStaleChats` 接入启动。
- 事件→DB：`message_end` 落 `chat_messages`（I22）；`tool_execution_*` 落 `audit`；`extension_ui_request` 落 `decisions`。
- **验证**：fake-pi e2e——`delta → message → settled`；决策 `pending → answered`；崩溃 → `lost` + 无 `pending` 残留；TTL 关闭。

### I4-6 HTTP：`http/chat-sse.ts` + `server.ts` 路由
- `streamChatEvents(bus, chatId, lastEventId)`：attach → 先 `since()` 重放 → 心跳 15s → 断开清理；缓冲不足发 `chat.resync`。
- 12 条路由（design D11）+ 鉴权（重派生账号、owner 限 `account_grants`）+ CSRF + audit。
- **验证**：HTTP e2e（`curl`）——201/200/403/409 正确；SSE 收到 `chat.delta`/`decision.pending`；`Last-Event-ID` 重放。

### I4-7 UI `ui/chat.{html,css,js}` + 入口
- 会话列表/聊天窗/流式渲染/决策卡片/工具活动/失败横幅/abort/模型/fork-clone；`index.html` 加入口。
- **验证**：`bun build` 含新资源；浏览器手测（真实机器，见 §4 G2）。

### I4-8 回归、spec v4、状态同步
- spec：`agent-session.md` v0→v1（§9 校准项 + 数据模型 I19–I23）；`api.md`/`security.md`/`index.md` 增量。
- `AGENT.md`：§1/§3/§5/§8/§9/§10；`src/README.md`（`agent/` 段）；`bash tools/repomap.sh` 重生成 `TREE.md`。
- **验证**：`bash /tmp/wfc-c4-verify.sh` 全绿（见 §2）。

---

## 2. 验收命令（可复现）

```bash
export PATH="$HOME/.bun/bin:$PATH"
cd /workspaces/other/weixin/wechat-flow

# 静态
node_modules/.bin/tsc --noEmit
bun build src/console/main.ts --target bun --outdir /tmp/wfc-c4-build
grep -q '"dependencies"' package.json && echo "FAIL: deps appeared" || echo "OK: zero runtime deps"

# 单测（frames / dao / 扩展纯函数）
bun run /tmp/wfc-c4-unit.ts

# e2e（fake pi 注入）
CONSOLE_PI_BIN=/tmp/fake-pi.ts bash /tmp/wfc-c4-e2e.sh

# 汇总
bash /tmp/wfc-c4-verify.sh
```

## 3. 回滚点

| 步骤 | 回滚 |
|---|---|
| I4-1..I4-2 | 删新文件，无外部影响 |
| I4-3 | migration v2 已应用则**不删列**（向后兼容）；代码 revert |
| I4-4..I4-7 | 删新文件 + `server.ts`/`schema.ts`/`ui/index.html` 的追加段 revert |
| 运行期 | `DELETE /api/chats/:id` 关会话；停 `serve` → 子进程随父退出 |

## 4. 已知边界 / 非验收项

- **G2 真机验证（需真实 pi + 250 host）**：真实模型流式、真实 `pi --extension` 加载、浏览器手测。本地以 fake-pi 覆盖协议面。
- `fork` 的 `entryId` 依赖 pi 消息是否带 entryId；不带则 UI 隐藏"分支"按钮（**不**猜造 id）。
- 环形缓冲 500 条之外的断线重连走 `chat.resync` 全量拉取，不做逐条补帧。
- 不做跨进程多实例：`manager` 假定 `serve` 单实例（与 C2 worker/scheduler 假设一致）。

## 5. 证据（实现后填写）

> 待 I4-* 完成后逐条填真实输出。

## 6. 偏差与决策（实现后填写）

> 待填。
