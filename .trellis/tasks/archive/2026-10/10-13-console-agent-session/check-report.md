# C4 独立验收报告 · console-agent-session

- 任务：`.trellis/tasks/10-13-console-agent-session`（C4 · Agent 会话窗口与人在环）
- 验收对象：AC-6 / R3.4 / R3.5，契约 `.trellis/spec/console/agent-session.md`(v1)、`data-model.md` I19–I23
- 环境：`/workspaces/other/weixin/wechat-flow`，Bun 1.4.2，Node v22.23.2，`export PATH="$HOME/.bun/bin:$PATH"`
- 角色：独立 Check Agent（**未修改任何产品源码**；仅新增报告与临时脚本 `/tmp/wfc-c4-*`）
- 复核日期：2026-10-14

## 0. 判定

**Verdict: FAIL（1 个 blocking 缺陷）**

其余 AC-6 / R3.4 / R3.5 项全部通过（见 §2）。唯一阻塞项 **B1** 违反 `data-model.md` I21 的**明文契约**（“`sweepIdle` 均把 `pending`→`lost`”）与 AC-6“无悬挂 pending”，且现有自测**未覆盖**该路径。B1 修复面很小（一个事务 + 一个 DAO 调用），修完即可转 PASS。

> 若评审把 B1 定性为“可自愈的陈旧展示态”而非硬约束违反，可降级为 PASS-with-issues；但按 spec 字面 + AC-6 显式验收点，本报告判定为 **blocking / FAIL**。

---

## 1. 验收命令（全部真实执行）

| 命令 | 结果 | 证据 |
|---|---|---|
| `node_modules/.bin/tsc --noEmit` | **OK**（0 错） | `TSC_OK` |
| `bun build --target=bun src/console/main.ts` | **OK** | `/tmp/wfc-c4-build.js` 生成 |
| 零运行时依赖断言 | **OK** | `deps: []` → `ZERO_DEPS_OK` |
| 纯增量守卫 `git diff --quiet HEAD -- src/pi.ts src/wechat.ts src/publisher.ts` | **OK** | `ENGINE_UNTOUCHED_OK` |
| console bundle 不得含 `@earendil-works` | **OK** | `OK: bundle pi-free` |
| `bash /tmp/wfc-c4-verify.sh`（全量） | **OK** | `SUMMARY: pass=8 fail=0` |
| `bun /tmp/wfc-c4-unit.ts` | **OK** | `ALL C4 UNIT TESTS PASSED`（56 条 PASS） |
| `bash /tmp/wfc-c4-e2e.sh` | **OK** | `ALL C4 E2E TESTS PASSED`（54 条 PASS） |
| 独立迁移检查 `/tmp/wfc-c4-check-migration.ts` | **OK** | `MIGRATION CHECKS PASSED`（8 条） |
| 独立 sanity `/tmp/wfc-c4-check-sanity.ts` | **OK** | `SANITY CHECKS PASSED`（16 条） |
| 独立对抗 `/tmp/wfc-c4-adversarial*.ts` | **B1 复现** | 见 §3 |

---

## 2. MUST-verify 表（逐项）

| # | 验收项（来源） | 结论 | 证据 |
|---|---|---|---|
| 1 | 严格 JSONL：只按 `\n` 切；剥单个尾随 `\r`；丢空行 | ✅ | `frames.ts:24-30`；单测 + 独立 sanity（CRLF/空行/半帧） |
| 2 | `U+2028`/`U+2029` 不作行界 | ✅ | `frames.ts` 仅 `indexOf("\n")`；独立 sanity：含原始 `\u2028\u2029` 的 JSON 串 → 恰 1 record |
| 3 | 禁 `readline`/`createInterface` | ✅ | `grep -rn` 仅命中 `frames.ts:7` **注释** |
| 4 | 按 `id` 关联命令应答（非到达顺序） | ✅ | `rpc.ts:120-134`；单测 `concurrent correlation` |
| 5 | 流式 delta **不落库** | ✅ | `manager.ts:476-500` 仅 `bus.emit`；对抗 probe：无 `message_end` → `chat_messages` 无 assistant 行 |
| 6 | `message_end`（**仅 assistant**）落库；用户回声不重复 | ✅ | `manager.ts:501-521`（`role!=='assistant'` 跳过）；e2e `detail: user+assistant` |
| 7 | `agent_settled` → `chat.settled`（不用 `agent_end`） | ✅ | `manager.ts:553-558`；e2e `SSE chat.settled after prompt` |
| 8 | HITL 生命周期 `pending → 终态`，**无悬挂** | ❌ **B1** | 见 §3 B1 |
| 9 | DB-first 作答；非 pending → 409 | ✅ | `manager.ts:703-716`（先落库再写回）；`rpc.ts` 无 DB；e2e `I20: expired … 409`；独立 sanity I20 |
| 10 | pi 侧超时权威；console 仅展示计时器→`expired` | ✅ | `manager.ts:592-604`（`setTimeout` 只 `expireDecision`+emit，**不写 stdout**）；e2e `decision.expired` |
| 11 | 双层最小权限：`--tools read,grep,find,ls,console_ask` | ✅ | `manager.ts:343-347` |
| 12 | 扩展层：只读白名单 + 永久拒绝名单 + 逐次 confirm + 无 UI 阻断 | ✅ | `console-decision.ts:23-50,146-180`；`needsApproval` 不信任 annotations |
| 13 | 无 `dangerouslyAllowAll` / 提权后门 | ✅ | `grep` 仅注释命中 |
| 14 | I19 `request_id` 全局唯一去重 | ✅ | DDL `UNIQUE`(`schema.ts:202`) + `INSERT OR IGNORE`；pi 侧 id = `crypto.randomUUID()`（已核对 pi 源码 `dist/modes/rpc/rpc-mode.js`）；独立 sanity |
| 15 | I20 终态不可逆 | ✅ | `chats.ts:266-300`；独立 sanity（二次作答 → `undefined`，原响应不变） |
| 16 | I21 pending ⇒ 活进程；进程不在 ⇒ 清算 | ❌ **B1** | `data-model.md:97` 明确要求 `sweepIdle` 清算；`manager.ts:222-232`→`608-614` 未清算 |
| 17 | I22 只由 `message_end` 写 `chat_messages` | ✅ | 同 #5/#6；单测 + 对抗 probe |
| 18 | I23 `lost` + pending→`lost` **同事务** | ✅ | `chats.ts:312-322`（`db.transaction`）；e2e `pending decision lost` |
| 19 | D13 意外退出：`lost`+pending lost+审计+SSE | ✅ | `manager.ts:615-630`；e2e `chat.lost`（携带 stderr/lostDecisions） |
| 20 | D13 启动回收 `reapStale()` | ✅ | `main.ts` 启动调用；`manager.ts:203-209`；独立迁移/reap 单测 |
| 21 | D13 命令失败显形（reject→HttpError，不伪成功） | ✅ | `rpc.ts:127-133` + 路由 `await`；e2e 4xx/409 |
| 22 | D13 spawn 失败（`chat_limit`）不拖垮 SSE | ✅ | `server.ts:825` `void manager.ensureSpawn(row).catch(()=>{})`；e2e `chat_limit 409` + SSE 建流成功 |
| 23 | D11 路由集**精确匹配** | ✅ | `server.ts:718-876` 十四条与 spec §8 一一对应 |
| 24 | 鉴权：owner 限 `account_grants`（越权 403+审计） | ✅ | `server.ts:996` CSRF + `assertAccountAccess`；e2e `owner denied other account 403` |
| 25 | 所有写操作 CSRF | ✅ | `server.ts:996`（非 GET/HEAD 全覆盖）；e2e 带 CSRF 通过 |
| 26 | `ChatManager` 缺失 → `503 chat_unavailable` | ✅ | `server.ts requireChat()`；e2e `503 without manager` |
| 27 | migration v2 纯增量 + 旧库保数据 | ✅ | `schema.ts:247-256`；独立 `v1→v2` 检查（数据保留、`session_file` 为 NULL） |
| 28 | `--session` 续接（D9） | ✅ | `manager.ts:359`；e2e `respawn after lost` |
| 29 | 上下文文件不含密钥/凭据（D8） | ✅ | 实读 `agent-context-<id>.txt`：仅 alias/名/路径/权限文案，**无凭据**；`data/` 已 gitignore |
| 30 | H1 纯增量；H2 engine 不 import console；H3 零依赖 | ✅ | `git status` 修改文件全在 `.trellis/`+`src/console/`；`grep` engine 无 console import；`deps: []` |
| 31 | UI 无 XSS（agent/工具输出走 `textContent`） | ✅ | `app.js:30-41` `el({text})→textContent`；`chat.js` 仅用 `innerHTML=""` 清空 |
| 32 | `chat.resync` 落后窗口回落 | ✅ | `events.ts since().gap` + `chat-sse.ts`；单测 gap + e2e replay |
| 33 | C1–C3 回归不受影响 | ✅ | `pass=8 fail=0`（含 C3 回归子套件全绿） |

未覆盖/需真机：见 §5。

---

## 3. 缺陷清单

### B1 ·【blocking】`sweepIdle`/预期关闭不清算 `pending` 决策 → 悬挂，违反 I21 与 AC-6

- **契约**：`data-model.md:97` I21 明写“`manager.handleExit`（意外退出）/ `reapStale`（启动）/ **`sweepIdle` 均把 `pending`→`lost`**，与 `chat_sessions.status` 同事务（I23）”。`design.md:243` 亦把“无 `pending` 残留”列为 AC-6 验收点。
- **实现**：`manager.ts:222-232` 的 `sweepIdle()` 在空闲 TTL 到达时 `close(2000)`（`expectStatus="idle"`）；`handleExit()` 在 `info.expected` 分支（`manager.ts:610-614`）**只**更新会话 `idle/closed` 并发 `chat.closed`，**从不**调用 `chats.loseDecisionsForSession`/`markChatLost`（后者只在非预期退出分支 `manager.ts:615`）。`chats.ts:302` 已备有 `loseDecisionsForSession` 却未被此路径使用。
- **可达路径（真实产品面，非仅合成）**：agent 弹出决策卡（`busy=true`）→ 操作者点「Abort」`POST /api/chats/:id/abort`（`manager.ts:672-679`）→ `live.busy=false` → 该会话随后被 `sweepIdle` 关闭 → **进程已不在但 `decisions.status` 仍为 `pending`**。期间/之后 `GET /api/accounts/:id/chats` 的 `pendingDecisions` 徽标常驻；`POST /api/decisions/:id` 仍返回 200 `answered`，但因 `live` 已不存在而**静默不投递**（`manager.ts:718` 的 `if (live && live.handle.alive)` 为假）。唯一回收时机是**下一次进程重启**的 `reapStaleChats()`（`chats.ts:349-364` 对任意非 live 会话的 pending 一律置 lost）。
- **独立复现**（`/tmp/wfc-c4-adversarial2.ts`，使用仓库自带 `/tmp/fake-pi.ts`）：
  ```
  PASS  decision pending after prompt   ["pending"]
  PASS  decision still pending after abort  ["pending"]
  [chat 1] idle for 0s, closing subprocess
     live=false session.status=idle decisions=["pending"]
  FAIL  I21: no pending decision while process is gone  live=false decisions=["pending"]
  ```
  另一路 `/tmp/wfc-c4-adversarial.ts` probe 2（`agent_start` 前自发 dialog + TTL）同样复现 `live=false / session.status=idle / decisions=["pending"]`。
- **建议修复（最小面）**：
  1. 新增/复用 DAO：在**同一事务**内 `chat_sessions.status='idle'`（或 `closed`）与 `decisions.status='lost'`，即在 `handleExit` 的 `expected` 分支调用 `chats.loseDecisionsForSession(this.db, live.chatId)` 并与状态更新包在一个 `db.transaction`（满足 I23）。
  2. 对落库结果发 `decision.expired`（或新增 `decision.lost`）SSE，使前端卡片即时转终态。
  3. 可选：`abort()` 结束时把该会话 `pending → cancelled`（`cancelled:true` 语义），避免“Abort 后卡片仍可点”的窗口期。
  4. 补 e2e：`abort 或 TTL 关闭 → 断言无 pending 残留`（当前 e2e 仅覆盖“意外退出”）。

### N1 ·【non-blocking】`chat-sse.ts` 重放阶段 enqueue 抛错时清理闭包仍是 no-op

`chat-sse.ts:38-47,60-70`：`cleanup` 初始为 `() => {}`，直到重放与 `chat.open` 之后才被赋值为真正的清理函数。若客户端恰在重放阶段断开导致 `controller.enqueue` 抛错，`safeEnqueue` 调用的 `cleanup()` 是空实现，监听器/`setInterval(ping)` 仍会被挂上，直到下一次 enqueue 失败（≤1 个 ping 周期）才自愈。影响有界。建议：把 `cleanup` 用 `let cleanup!: () => void` 前置并提前赋值，或在 `safeEnqueue` 中直接判断 `controller.desiredSize === null`。

### N2 ·【non-blocking】`bus.close()` 不通知已建 SSE 流

`manager.ts` 在 `deleteSession`/`shutdown` 调 `this.bus.close(chatId)`（`events.ts:84-88`），但已建立的 `ReadableStream` 的 `unsubscribe`/`ping` 不会被触发，该响应会继续按 15s 心跳存活直到客户端自行断开（前端在收到 `chat.closed` 后 `es.close()`，`chat.js:243,393`）。有界，但建议服务端在 close 时向订阅者发最后一个事件并 `controller.close()`。

### N3 ·【non-blocking】已 abort 的 `signal` 不会触发 SSE 清理

`chat-sse.ts:57` 无条件 `options.signal?.addEventListener("abort", ...)`；若传入时 `signal.aborted` 已为 `true`，则监听器永不触发，流不会被清理。新增 `if (options.signal?.aborted) cleanup()` 更稳。

### FA1 ·【false-alarm】I20“存储响应被覆盖”假警报

本次独立脚本一度报 `I20: stored response unchanged` FAIL；经查为**脚本断言写错**（对已是字符串的 `response_json` 又做了一次 `JSON.stringify` 造成双重转义）。实际落库为 `{"confirmed":true}`，二次作答被拒且原值不变。实现**正确**，非缺陷。

### 说明（非缺陷）

- `reapStaleChats`（`chats.ts:349-364`）对 `pending` 的清算范围是“任意非 live 会话”，比 spec §5 所述的 `active|idle` 更宽（也覆盖 `closed`）。这只会**更早**回收悬挂，属于良性偏差。
- `console-decision.ts` 实际 `import` 了 `Type`/`defineTool` 运行时值（非纯 `import type`），与 `implement.md` I4-4 的措辞不同；但该文件只由 pi 以 `--extension` 路径加载，**不会进入 console bundle**（已验证 bundle pi-free），因此不影响 H3。
- `console_ask` 调用 `ctx.ui.confirm(title,msg)` 未传 `signal`/`timeout`，故对话框无 pi 侧超时；此属产品选择（控制台展示计时器只用于带 `timeout` 的对话框），本身不违反契约，但会与 B1 叠加出更长的悬挂窗口。

---

## 4. 独立复现命令

```bash
export PATH="$HOME/.bun/bin:$PATH"
cd /workspaces/other/weixin/wechat-flow

node_modules/.bin/tsc --noEmit
bun build --target=bun src/console/main.ts --outfile=/tmp/wfc-c4-build.js
node -e 'process.exit(Object.keys(require("./package.json").dependencies||{}).length)'
git diff --quiet HEAD -- src/pi.ts src/wechat.ts src/publisher.ts && echo ENGINE_UNTOUCHED_OK
grep -q "@earendil-works" /tmp/wfc-c4-build.js && echo "PI_LEAK" || echo "OK: bundle pi-free"

bash /tmp/wfc-c4-verify.sh                                  # pass=8 fail=0
bun  /tmp/wfc-c4-check-migration.ts                         # 8/8
bun  /tmp/wfc-c4-check-sanity.ts                            # 16/16
bun  /tmp/wfc-c4-adversarial.ts                             # probe2 复现 B1
bun  /tmp/wfc-c4-adversarial2.ts                            # abort→TTL 复现 B1（退出码 1）
```

临时脚本（**非产品源码**）位于：`/tmp/wfc-c4-check-migration.ts`、`/tmp/wfc-c4-check-sanity.ts`、`/tmp/wfc-c4-adversarial.ts`、`/tmp/wfc-c4-adversarial2.ts`、`/tmp/fake-pi-ask-idle.ts`。

---

## 5. 未能验证项（AC-6 的 G2 边界）

以下依赖真机/外部条件，本轮以 fake-pi 协议面覆盖，**未**在真实环境验证：

1. 真实模型下的流式增量、`text_end`/`thinking_end` 与实际工具事件序列（fake-pi 的时序为脚本化模拟）。
2. 真实 `pi --extension src/console/agent/extensions/console-decision.ts` 的加载与 `tool_call` 拦截（本地仅以 `tsc` + 纯函数单测覆盖；extension 运行时 import 由 pi 提供）。
3. 真实 pi 的 `--tools read,grep,find,ls,console_ask` + `--append-system-prompt` 组合是否按预期裁剪工具集。
4. 浏览器人测（决策卡片交互、流式渲染、失败横幅）——需真实前端环境。
5. `fork` 的 `entryId` 在真实消息是否携带（spec 已列为边界：不带则 UI 隐藏分支按钮）。

> 以上不改变 §0 判定；B1 与它们无关，已在本地可复现。

---

## 6. 复审（B1 修复后）

> 复审角色：**Check Agent（独立复现）**。范围：仅上一轮唯一 blocking 缺陷 **B1**（预期关闭未清 `pending`，违反 I21）。
> 约束遵守：**未改动任何产品源码**；仅新增/扩展 `/tmp` 下的临时脚本，并向本报告追加本节。
> 结论先行：**B1 已关闭；未引入新缺陷；本轮判定 PASS。**

### 6.0 复审判定

| 项 | 结果 |
|---|---|
| B1（预期关闭未清 pending） | ✅ **CLOSED** |
| 新引入缺陷 | ✅ 无 |
| 回归（tsc / build / C4 全量 / C3 全量） | ✅ 全绿 |
| spec ↔ code 一致性 | ✅ 一致（`agent-session.md` v2 / `data-model.md` v4 / `index.md`） |
| **本轮判定** | **PASS** |

### 6.1 变更点核对（原子性）

被修复的两处源码（本任务为纯加法，`src/console/agent/` 与 `db/dao/chats.ts` 均为新文件，故 `git diff` 不显示，直接读原文核对）：

`src/console/db/dao/chats.ts:331` —— `losePending` 与状态更新在**同一个** `db.transaction` 内：

```ts
export function closeChatSession(db: Database, chatId: number, status: ChatStatus): ChatLostCounts {
  const run = db.transaction((): ChatLostCounts => {
    const decisions = losePending(db, chatId);                 // pending → lost
    const info = db.run(
      `UPDATE chat_sessions SET status = ?, updated_at = datetime('now') WHERE id = ?`,
      status, chatId,
    );
    return { sessions: Number(info.changes), decisions };
  });
  return run();                                                // 单事务提交/回滚
}
```

`src/console/agent/manager.ts:608` —— `handleExit` 预期分支：先收集 pending（用于逐条广播），再调用 `closeChatSession`，无 `await` 间隔（同步函数），随后发 `chat.closed` 与逐条 `decision.expired`：

```ts
const pending = chats.listDecisions(this.db, { chatId: live.chatId, status: "pending" });
const settled = chats.closeChatSession(this.db, live.chatId, status);
this.bus.emit(live.chatId, "chat.closed", { reason: live.expectStatus, lostDecisions: settled.decisions });
for (const p of pending) {
  const after = chats.getDecision(this.db, p.id);
  if (after) this.bus.emit(live.chatId, "decision.expired", decisionView(after));
}
```

**判定：真原子。** `handleExit` 是同步的，读取 pending → 事务提交之间不存在事件循环让渡，不存在「状态已变但决策仍 pending」或反之的可观测窗口。

### 6.2 独立复现（我方脚本，不复用实现者测试）

**（a）上一轮我方原始复现器——现均 PASS**

```
$ bun /tmp/wfc-c4-adversarial.ts
PASS I22: no assistant row without message_end
PASS I21: no pending decision while process is gone pending=0 live=false session=idle
ADVERSARIAL PROBES PASSED          exit=0

$ bun /tmp/wfc-c4-adversarial2.ts
PASS decision pending after prompt
PASS decision still pending after abort
PASS I21: no pending decision while process is gone live=false decisions=["lost"]
PROBE PASSED                       exit=0
```

**（b）新增独立对抗用例 `/tmp/wfc-c4-recheck-b1.ts`（4 组）**

- **A1 顺序性**：在 `chat_sessions` 状态 UPDATE 上挂 `AFTER UPDATE OF status` 触发器，记录此刻该会话的 `pending` 计数。
- **A2 回滚原子性**：在状态 UPDATE 上挂 `BEFORE UPDATE ... RAISE(ABORT)`，断言 `closeChatSession` 抛出且**决策回滚为 `pending`**（证明两条语句共用一个事务）。
- **B 端到端 TTL 预期关闭**：新写的 fake pi 自发投递 `extension_ui_request`（无 `agent_start`，故 `busy=false` 可被 `sweepIdle` 回收），`ttlMs=400`。
- **C 端到端 `shutdown()`**：带 pending 决策直接关闭全部。
- **D `deleteSession`**：带 pending 决策删除会话。

```
$ bun /tmp/wfc-c4-recheck-b1.ts
PASS  A1 decisions cleared BEFORE status flips (trigger sees 0 pending)  [{"pending_seen":0}]
PASS  A1 session now idle / decisions lost
PASS  A2 aborted status UPDATE threw
PASS  A2 decisions rolled back with the failed transaction (stay pending)  ["pending"]
PASS  A2 session status not flipped on rollback  status=active
PASS  A2 normal close after rollback works (decisions=1, sessions=1)  {"sessions":1,"decisions":1}
PASS  B I21: no pending after expected close
PASS  B process gone
PASS  B session terminal (idle)  idle
PASS  B decision terminal (lost)
PASS  B chat.closed{reason:'idle',lostDecisions:1}  {"reason":"idle","lostDecisions":1}
PASS  B decision.expired delivered with terminal status  ["lost"]
PASS  B invariant: no pending on non-live sessions  []
PASS  C I21: no pending after shutdown
PASS  C process gone
PASS  C session closed  closed
PASS  C decision terminal (lost)
PASS  C chat.closed{reason:'closed',lostDecisions:1}  {"reason":"closed","lostDecisions":1}
PASS  C decision.expired delivered  ["lost"]
PASS  D session row removed
PASS  D decisions cascade-deleted
PASS  D process gone
RECHECK-B1 PROBES PASSED           exit=0
```

**A1/A2 是「真原子」的强证据**：触发器在状态行翻转的**那一刻**观测到 `pending=0`（说明 `losePending` 先于状态更新执行）；把状态更新人为 abort 后决策**完整回滚**（说明二者共享一个事务，而非两条独立提交）。

> 说明（测量口径，非缺陷）：`closeChatSession` 返回的 `sessions` 用 `db.run().changes` 计数；bun 的该值会把**触发器**影响的行也算进来（微探针验证：挂 `AFTER UPDATE` 触发器后返回 `changes=2`，而 SQLite `changes()` 仍为 `1`）。我方 A1 用例挂了自己的触发器，故只断言 `decisions`；A2 去掉触发器后断言 `sessions===1`，符合产品语义。

### 6.3 回归（无回归）

```
$ node_modules/.bin/tsc --noEmit
TSC_OK

$ bun build --target=bun src/console/main.ts --outfile=/tmp/check-c4-build2.js
Bundled 49 modules in 12ms
  check-c4-build2.js  242.82 KB  (entry point)

$ bash /tmp/wfc-c4-verify.sh
...（tsc OK / build OK / zero-deps OK / engine untouched OK / console bundle pi-free OK /
     C4 unit ALL PASSED / C4 e2e ALL PASSED / C3 regression SUMMARY: pass=7 fail=0）
══════ SUMMARY: pass=8 fail=0 ══════     exit=0
```

引擎纯加法守卫：`git diff --quiet HEAD -- src/pi.ts src/wechat.ts src/publisher.ts` → `ENGINE_UNTOUCHED_OK`。

### 6.4 spec ↔ code 一致性（item 6）

- `agent-session.md` §1：**「关闭时若仍有 `pending` 决策，同事务置 `lost`（I21/I23，`chats.closeChatSession`）」** ↔ `chats.closeChatSession` 单事务实现 ✔
- `agent-session.md` §4 预期关闭行：**「会话 `idle`/`closed`，同事务把 pending 置 `lost`；`chat.closed {reason,lostDecisions}`；每条被判终态的决策另发 `decision.expired`」** ↔ `manager.handleExit` 预期分支逐条实现 ✔
- `agent-session.md` §5 预期关闭行 ↔ 同上 ✔
- `data-model.md` I21 ↔ 明确写入 `sweepIdle` 路径 ✔；I23 同事务 ✔
- `index.md` 反模式新增：「预期关闭只改会话状态、不清 pending」（指向 §1/§5）✔

**观察（非缺陷，已随 spec 明确）**：预期关闭触发的逐条事件名为 `decision.expired`，而该决策终态实际是 `lost`。spec §4/§5 与代码在此**一致**（约定用 `decision.expired` 承载「决策被判终态、卡片需停用」语义），故不算缺陷；仅提示读者不要据事件名推断 `decisions.status`，应以 `data.status` 为准。前端 `chat.js` 的 `chat.closed` 处理**不**关闭 EventSource，故 `chat.closed` 之后发出的 `decision.expired` 仍能送达并刷新卡片。

### 6.5 结论

- **B1 已关闭**：预期关闭路径（TTL `sweepIdle` / 删除 / `shutdown`）现在**原子地**把会话状态与会话内 `pending` 决策一并清算，无悬挂窗口；我方原复现器与新对抗用例全 PASS。
- **未引入新缺陷**：`deleteSession`（整行删除 + 级联）、`shutdown`（全量关闭）行为均保持正确；回归全绿；引擎纯加法未破。
- **本轮判定：PASS。**
