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
- [x] **G-C4（用户确认）**：用户已「批准 C4 开工」（含同意 design D10「新增 migration v2 一列 `session_file`」与 D7「双层最小权限」，替代 v0 契约的 `--no-tools`）—— 2026-10-14
- [x] `python3 .trellis/scripts/task.py start 10-13-console-agent-session` → `planning → in_progress`（2026-10-14）

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

- 静态：`tsc --noEmit` → 0 错误；`bun build --target=bun src/console/main.ts` → OK（49 modules，main.js ≈241.96 KB）；
  零依赖断言 `package.json.dependencies` 为空；`git diff --quiet HEAD -- src/pi.ts src/wechat.ts src/publisher.ts` → `ENGINE_UNTOUCHED_OK`；
  console bundle `grep @earendil-works` → `OK: bundle pi-free`（pi 仅由子进程运行期加载）。
- 单测 `/tmp/wfc-c4-unit.ts`：`ALL C4 UNIT TESTS PASSED`（frames / ChatBus / chats DAO / rpc）。
- e2e `/tmp/wfc-c4-e2e.sh`：`ALL C4 E2E TESTS PASSED`（真实 `createApp` + `Bun.serve` + `CONSOLE_PI_BIN=/tmp/fake-pi.ts`；路由 + SSE + 决策往返 + 鉴权 + 崩溃 + TTL 清算 + chat_limit）。
- C3 回归 `/tmp/wfc-c3-verify.sh`：`pass=7 fail=0`。
- 汇总 `bash /tmp/wfc-c4-verify.sh`：`SUMMARY: pass=8 fail=0`。
- 独立验收：`check-report.md`（trellis-check）→ 首轮 **FAIL**，唯一阻塞 **B1**；修复后其自带对抗复现 `bun /tmp/wfc-c4-adversarial.ts`、`bun /tmp/wfc-c4-adversarial2.ts` → 均 `PROBE(S) PASSED`。

## 6. 偏差与决策（实现后填写）

- **B1（blocking，已修）**：`handleExit` 的 **预期关闭**分支（TTL `sweepIdle` / 删除 / `shutdown`）原只改 `chat_sessions.status`，**未清算** pending，留下"进程已死但决策卡仍 `pending`"（违反 I21）。
  - 修复：新增 `chats.closeChatSession(db, chatId, status)`——会话状态与其全部 `pending→lost` **同事务**（I23）；`handleExit` 预期分支改用它，并对每条被判终态的决策补发 `decision.expired`；`chat.closed` 增带 `lostDecisions`。
  - 回归：`/tmp/wfc-c4-unit.ts` 增 `closeChatSession` 原子性断言；`/tmp/wfc-c4-e2e.ts` 增 TTL 清算场景（pending → abort → TTL 关闭 → 断言无 pending / `status=idle` / `chat.closed` / `decision.expired` / 无活进程）。
- **N1/N2/N3（non-blocking，暂不修）**：`chat-sse.ts` 重放阶段 cleanup 为 no-op（≤1 ping 周期自愈）；`ChatBus.close` 不主动通知已建 SSE 流（前端收 `chat.closed` 后自行断开）；已 aborted 的 `signal` 不触发清理。均为有界窗口，列入 C6 加固候选。
- **`reapStaleChats` 范围**：对"任意非 live 会话"清算 pending，比 §5 的 `active|idle` 更宽（也覆盖 `closed`）——良性偏差。
- **`console-decision.ts` 运行时 import**：`Type`/`defineTool` 为值导入（非 `import type`）；该文件只被 pi 以 `--extension` 加载，**不入** console bundle，不影响 H3。
