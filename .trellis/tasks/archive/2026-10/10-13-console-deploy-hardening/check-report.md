# C6 `console-deploy-hardening` — 独立复核报告（Check Report）

> 复核人：**check agent（独立验证，不采信实现者 §5 摘要）**
> 复核日期：2026-10-14
> 复核方式：从源码/产物逐条重读 + 自写对抗性复现脚本（含独立 pass/fail 计数）
> 复核范围：M5 最后一个控制台子任务 C6（S17，G6/G7 前置）

---

## 0. 结论

**判定：PASS-with-issues（核心代码与部署产物全部通过；2 项必需的治理文档交付缺失/不新鲜）** → **复核第 2 轮：PASS**（F1–F4 全部确认修复，见文末「复核（第 2 轮）」）。

- **运行时正确性：全绿。** 限流、失败退避、`/health`、SSE 泄漏修复、备份原子性、部署产物、引擎未改动、零新增依赖、无 CDP 暴露——全部经独立复现脚本验证通过（自写脚本 22+17+11+1 = **51 pass / 0 fail**；实现者聚合脚本 **12 pass / 0 fail** 复跑一致）。
- **治理文档：存在缺口。** ① `AGENT.md` **未更新**（S17 仍 `⚪ 未开始`、任务图 `⚪ 规划`、无 D28–D33、无 C6 变更日志）；② `TREE.md` **不新鲜**（`bash tools/repomap.sh --check` 退出 1）。二者均为任务书明确要求的交付项，但不影响运行期行为。
- 另有两处**低危文档措辞**与代码不符（`clientKey` 回落值、`/health` 信封），已在发现/观察中登记。

> 约束遵守：本次复核**未修改任何 `src/` 或部署产物**，仅新增本 `check-report.md`。所有发现均附最小复现命令，代码保持原样。

---

## 1. 复核环境与命令

```bash
cd /workspaces/other/weixin/wechat-flow
export PATH="$HOME/.bun/bin:$PATH"
bun --version            # 运行环境
```

**独立复现脚本（本次自写，位于 /tmp/c6check/）：**

| 脚本 | 覆盖 | 结果 |
|---|---|---|
| `/tmp/c6check/probe.ts` | 退避风暴/按日隔离/限流 key 隔离/ChatBus.close 广播/SSE 已 abort 清理 | **pass=22 fail=0** |
| `/tmp/c6check/http-probe.ts` | 真 HTTP：429+`Retry-After`、不写审计、`/health`+静态豁免、user/ip 隔离、`/health` 精确字段与 db=error | **pass=17 fail=0** |
| `/tmp/c6check/backup-atomic.sh` | 残留 `.tmp` 清理、不可写路径失败、缺参失败、`--restore-check` 只读、快照行数一致 | **pass=11 fail=0** |
| 内联 `RateLimiter` API 探针 | `size/remove/sweep`、`retryAfterSec` 随速率缩放 | **pass=1 fail=0** |

**实现者聚合脚本复跑：** `bash /tmp/wfc-c6-verify.sh` → `==== C6 aggregate: pass=12 fail=0 ====`（static 5 + C6 specials 6 + C1–C5 回归 1）。

---

## 2. 逐项核验表

> 状态：✅ 通过　/　⚠️ 通过但文档/边界有瑕　/　❌ 未交付

### 2.1 新增代码

| 项 | 状态 | 证据（命令/观察） |
|---|---|---|
| 新增 `src/console/http/ratelimit.ts` | ✅ | `git status --porcelain -- src/` → `?? src/console/http/ratelimit.ts`；109 行令牌桶；导出 `RateLimiter`（`take/size/remove/sweep`，`now` 可注入，`perMin<=0` 关闭）；**LIMITER API PROBE pass=1** 验证 `size/remove/sweep` 与 `retryAfterSec`（perMin=60→1s、perMin=1→60s，缩放正确） |
| `server.ts` 限流接入 | ✅ | `grep -n 'rate_limited\|RateLimiter\|trustCf' src/console/server.ts`：限流在 `handle()` 内、`route()` 之前，仅 `pathname.startsWith("/api/")`；key `u:<userId>` 或 `ip:<clientKey>`。**HTTP PROBE R1–R5/R10–R13**：429 `rate_limited` + `Retry-After: 60`、**不写 audit**、user 隔离、anon IP 隔离 |
| `server.ts` `/health` | ✅ | **HTTP PROBE R6–R8/H1–H3**：`/health` 免鉴权、耗尽后仍 200、`db=error` 仍 200；`data` 精确字段 `{status,version,uptimeSec,db,tunnel}`；无账号/队列/URL/密钥；`tunnel=null`（未启用） |
| `jobs/queue.ts` 退避查询 | ✅ | `countFailed`/`lastFailureAt` 按 `(account_id,kind)` + `json_extract(payload,'$.date')` **或** `'$.periodKey'`；`lastFailureAt=COALESCE(ended_at,queued_at)`。**probe A5/B2**：failed 计数=3、succeeded 不计数 |
| `jobs/scheduler.ts` 退避 | ✅ | `CONSOLE_JOB_MAX_ATTEMPTS`(3)/`CONSOLE_JOB_RETRY_COOLDOWN_MIN`(30)，skip 日志 `(attempts-exhausted)`/`(backoff)`。**probe A1–A6**：首次入队 1 个；冷却内 **29 个 tick 0 新增**（风暴被压制，total=1）；过冷却+1；2 次失败仍可重试；3 次后永久 skip |
| 退避「按日/按 kind」隔离 | ✅ | **probe B1**：昨日 3 次 failed 不抑制今日；**probe B2** kind 过滤使 OR 子句不跨 kind 污染 |
| `agent/events.ts` `close()` | ✅ | 先向订阅者广播 `chat.closed` 再删除 listeners，try/catch 包裹。**probe D1–D3**：广播到、会话被遗忘、**抛异常订阅者不破坏清理** |
| `http/chat-sse.ts` 泄漏修复 | ✅ | `cleanup` 在任何 enqueue 前安装；已 abort 立即 `cleanup`；重放失败即清理。**probe E1–E3**：已 abort 立即 `done`、未残留订阅 |
| `ui/chat.js` 前端关流 | ✅ | `grep -nE 'chat\.closed\|chat\.lost' src/console/ui/chat.js` → 299/308 收事件即 `state.es.close()`（另有 243/401/492 兜底） |
| `main.ts --backup/--restore-check` | ✅ | **backup-atomic.sh 全 11 项**：`VACUUM INTO <file>.tmp` → `integrity_check` → 原子 rename；**预存垃圾 `.tmp` 被清除并替换为合法快照**；不可写路径非零退出且无残留；缺参非零；`--restore-check` 只读（sha256 不变）、`user_version` 保留、行数一致 |

### 2.2 部署产物

| 项 | 状态 | 证据 |
|---|---|---|
| `deploy/systemd/wechat-console.service` | ✅ | `Type=simple`、`Restart=on-failure`、`RestartSec=5`、`KillSignal=SIGTERM`、`TimeoutStopSec=30`、`NoNewPrivileges=true`、必要 `ReadWritePaths`；注释明确**不加** `ProtectSystem=strict`/`ProtectHome`（会阻断 Chrome/CDP）。`systemd-analyze verify` 仅报开发机无 bun 路径（已文档化） |
| `deploy/systemd/cloudflared.service` | ✅ | 抬头 `Mode B (OPTIONAL / NOT RECOMMENDED)` + `CONSOLE_TUNNEL=0` 否则双隧道竞态 + 「会禁用 C5 隧道状态/邮件」醒目标注 |
| `deploy/systemd/wechat-console.env.example` | ✅ | `EnvironmentFile` 模板；明文密钥扫描=无；含 `CONSOLE_RATE_PER_MIN/BURST`、`CONSOLE_TRUST_CF`、`CONSOLE_JOB_MAX_ATTEMPTS/RETRY_COOLDOWN_MIN`、`CONSOLE_TUNNEL=1` |
| `deploy/install-console.sh` | ✅ | 默认 Mode A；`--mode-b` 才装 `cloudflared.service`；停用旧 timer 且保留 unit 可回退 |
| `deploy/console-backup.sh` | ✅ | 打包 db+data+config+master.key+manifest；`install -m 0600` 密钥、`chmod 0600` 归档、保留 `KEEP`(7) 份 |
| `deploy/console-restore.sh` | ✅ | `systemctl is-active` 运行中拒绝（除非 `--force`）；预检 `--restore-check`；替换前快照现状 |
| `deploy/nginx-console.conf.example` | ✅ | `proxy_pass http://127.0.0.1:8787`；IRON RULE 注释禁止转发 CDP 端口 |
| CDP/9222 暴露 | ✅ | C6 产物中 grep `9222\|cdp` **仅命中保护性注释/警告**，无任何实际端口转发或暴露 |
| `deploy/console-deploy.md` | ✅ | 9 节齐全（速览/模式/环境/迁移 timer/回滚/备份恢复/限流安全/排障/验证入口）；含 I29–I34 |
| `deploy/console-acceptance.md` | ✅ | AC-1…AC-11 全列；C6 关注 AC-10/AC-11；含 G7 确认门 |

### 2.3 文档与治理

| 项 | 状态 | 证据 |
|---|---|---|
| `.trellis/spec/console/ops-deploy.md` | ✅ | v1；I29–I34 与「校准记录 v0→v1」表齐全；逐条比对代码一致（限流文件/接入/env、`/health`、tunnel 状态源、退避查询/env/时间归一、备份子命令/脚本、systemd、SSE 修复） |
| `.trellis/spec/console/api.md` | ⚠️ | 429/`Retry-After` 已补（v6）；`/health` 行写 `{status,version,uptimeSec,db,tunnel}` **未体现 `{ok,data}` 信封**（见发现 F4，低危） |
| `.trellis/spec/console/security.md` | ⚠️ | §6 限流规则齐全（key、豁免、不写审计、`PER_MIN=0` 关闭）；`clientKey` 回落写 `unknown` 而代码回落 `x-real-ip`/`local`（见发现 F3） |
| `.trellis/spec/console/index.md` | ✅ | 状态行含 C6；Deploy & Hardening `ops-deploy.md v1` 已登记 |
| `src/README.md` | ✅ | 113–115 行新增 ratelimit/退避/deploy 模块说明 |
| `README.md` | ✅ | 101–114 行控制台 C1–C6 + `install-console.sh` + 手册/验收链接 |
| `docs/操作手册.md` | ✅ | 1304–1315 行控制台部署/限流/备份/回滚节 |
| `ARCHITECTURE.md` | ✅（非 C6 目标） | 未在 C6 变更集，但未要求改动；不判失败 |
| `TREE.md` | ❌ | `bash tools/repomap.sh --check` → **exit 1**（需刷新）；唯一差异为 `src/console/server.ts` 行数 1403→1411（见发现 F2） |
| `AGENT.md` | ❌ | **未更新**：`git status --porcelain -- AGENT.md` 为空；`grep -n 'S17' AGENT.md` 仍 `⚪ 未开始`、任务图 `⚪ 规划`、G6 `⚪ 待放行`、无 D28–D33、无 C6 变更日志（见发现 F1） |

### 2.4 硬约束

| 约束 | 状态 | 证据 |
|---|---|---|
| 引擎未改动 | ✅ | `git diff --quiet -- src/pi.ts src/wechat.ts src/publisher.ts src/mailer.ts` → **ENGINE_UNTOUCHED_OK** |
| `src/` 仅允许 `src/console/*`（+未跟踪 ratelimit.ts） | ✅ | `git status --porcelain -- src/`：`M src/README.md` + 7 个 `src/console/**` + `?? ratelimit.ts`。`src/README.md` 为任务书明列的文档交付，可接受 |
| 零新增运行时依赖 | ✅ | `grep -c '"dependencies"' package.json` → **0** |
| 无 CDP/9222 暴露 | ✅ | 见 2.2；仅 127.0.0.1:8787 被反代 |
| I29–I34 与代码一致 | ✅ | 见 2.3 `ops-deploy.md` 行；仅 F3/F4 两处措辞级偏差 |

---

## 3. 发现（Findings）

### F1 — `AGENT.md` 未更新（**严重度：中 / 交付缺失**）

**现象：** 任务书（`prd.md` §交付/验收、`design.md` L44、`implement.md` L58）明确要求更新 `AGENT.md`（S17 ✅、任务图 6/6、D28–D33、G6/G7、§9 变更日志、§10 下一步）。实际该文件**未被改动**，看板仍停在 C5 完成态。

**最小复现：**
```bash
cd /workspaces/other/weixin/wechat-flow
git status --porcelain -- AGENT.md          # 输出为空（未修改）
grep -n 'S17' AGENT.md                       # 仍为 "⚪ 未开始" / G6 "⚪ 待放行"
grep -nE 'D2[89]|D3[0-3]' AGENT.md           # 无命中
```

**影响：** 续接入口（`AGENT.md` 是项目唯一进度看板）与任务图与实际进度不一致；G6/G7 确认门、D28–D33 决策、C6 证据均未落档。运行期无影响。

**建议修复（由实现者执行，非本次复核改动）：** 更新 `AGENT.md` §1（S17 ✅）、§2（G6/G7 状态）、§3 任务图（C6 = 完成）、§4/§8（D28–D33）、§9 变更日志（C6 行）、§10 下一步，并将 AC-1…AC-11 证据路径回写。

---

### F2 — `TREE.md` 不新鲜（**严重度：低 / 自检门失败**）

**现象：** 文档自检门 `bash tools/repomap.sh --check` 退出码 1。差异仅为 `src/console/server.ts` 行数（1403 vs 实际 1411），即实现者在限流接入 `server.ts` **之后**未重跑 repomap。

**最小复现：**
```bash
cd /workspaces/other/weixin/wechat-flow
bash tools/repomap.sh --check; echo "exit=$?"   # exit=1 → "TREE.md 需要刷新"
# 定位唯一差异（安全，不改动）：
cp TREE.md /tmp/T.bak && bash tools/repomap.sh >/dev/null
diff <(grep -v '^> 生成命令' /tmp/T.bak) <(grep -v '^> 生成命令' TREE.md)
# → 287c287: ### `src/console/server.ts`  (1403 行)  vs  (1411 行)
cp /tmp/T.bak TREE.md
```

**影响：** 索引行数与源码不符，违反项目「改动代码后请重跑本脚本」约定。功能无影响。

**建议修复：** `bash tools/repomap.sh` 重新生成并提交 `TREE.md`。

---

### F3 — `clientKey` 回落值与 spec 不符（**严重度：低 / 文档措辞**）

**现象：** `ops-deploy.md` §三 与 `security.md` §6 均写未登录 key 回落为 `unknown`；实际 `server.ts#clientKey` 在无 `CF-Connecting-IP`/`x-forwarded-for` 时回落 `clientIp(req)`，后者返回 `x-real-ip` 或字符串 **`"local"`**，代码中**不存在** `"unknown"` 分支。

**最小复现：**
```bash
grep -n 'local\|unknown' src/console/server.ts   # 110-111 行 clientIp → "local"
grep -n 'unknown' .trellis/spec/console/ops-deploy.md .trellis/spec/console/security.md
```

**影响：** 隧道/反代正常时 `clientKey` 始终为真实 IP，`local` 仅在直连 loopback 的极少数场景出现（此时所有无头请求共享同一 `ip:local` 桶）。属措辞级瑕疵，非安全缺陷。**建议**将两处文档改为「否则 `x-real-ip` / `local`」，或按设计把代码回落字符串统一为 `unknown`（二选一，保持文档-代码一致）。

---

### F4 — `/health` 文档未体现统一信封（**严重度：低 / 文档措辞**）

**现象：** `api.md` L133 与 `ops-deploy.md` §六示例写 `/health` 返回 `{status,version,uptimeSec,db,tunnel}`；实际响应为全局信封 `{"ok":true,"data":{...}}`（字段位于 `data` 内）。

**最小复现：**
```bash
curl -s http://127.0.0.1:<port>/health   # → {"ok":true,"data":{"status":"ok",...,"tunnel":null}}
# 或见本次 /tmp/c6check/http-probe.ts R8 输出
```

**影响：** 若监控/验收脚本按顶层 `status` 取值会取不到；按 HTTP 200 判活的用法不受影响。属文档精度问题。**建议**在 api.md/ops-deploy.md 标注 `/health` 亦遵循 `{ok,data}` 信封。

---

## 4. 非阻塞观察

1. **退避 OR 子句的潜在边界（非 C6 回归）：** 手动计划任务（`plan`，payload `{date,dryRun?}`）失败时，其 `date` 不等于周 key，`countFailed(account,"plan",WEEK)` 不会计入，调度器可能在同一冷却窗口内另起一次周计划入队。`hasActivePlanJob` 仅挡 `queued/running`，故该路径存在极窄的重复尝试窗口。设计（D31）明确 key 为 `payload.date|periodKey`，非本任务引入，登记备查。
2. **`ChatBus.close` 双投递：** `close()` 与应用层 `emit("chat.closed")` 可能重复投递终态；前端对 `chat.closed` 幂等（只关一次 ES），`ops-deploy.md` 校准表已登记。
3. **`/api/*` 每请求一次 session 查询：** 为限流 key 判定需先查会话，属可接受成本；与审计查询复用，未见重复放大。
4. **`README.md` L53 顶层树注释**未列出 C6 新增的 `deploy/console-*`（但 L101–114 正文已完整覆盖），措辞可后续顺手补齐。
5. **`systemd-analyze verify`** 在开发机仅报 `/root/.nvm/.../bun` 不存在（真机路径不同），非单元语法错误，已在文档登记。

---

## 5. 复核结论明细

| 维度 | 结果 |
|---|---|
| 运行时正确性（含对抗性复现） | ✅ 51/51 自写探针 + 12/12 聚合脚本 |
| 交付完整性（代码 + 部署产物） | ✅ 全部齐备 |
| 文档/规范校准 | ⚠️ `api.md`/`security.md` 两处措辞（F3/F4） |
| 治理文档交付 | ❌ `AGENT.md` 未更新（F1）、`TREE.md` 不新鲜（F2） |
| 硬约束（引擎/依赖/CDP/端口） | ✅ 全部满足 |

**最终判定：PASS-with-issues** — 可在完成 F1/F2（必需）后放行 G6；F3/F4 建议一并修正以保持「文档-代码一致」契约。

---

## 复核（第 2 轮）· 修复确认

> 复核人：check agent（第 2 轮 narrow re-verify，独立确认，不采信实现者摘要）
> 日期：2026-10-14
> 范围：仅核验第 1 轮 F1–F4 修复 + 任务洁净度；**未修改 `src/` 或部署产物**。
> 另在复核范围内顺手修掉 2 处文档一致性瑕疵（见 §4「本轮新增修正」）。

### 0. 第 2 轮结论

**PASS —— F1–F4 全部确认修复。** 第 1 轮两条必需项（F1 `AGENT.md`、F2 `TREE.md`）已闭环；两条低危措辞（F3 `clientKey` 回落、F4 `/health` 信封）已与代码对齐。任务洁净度保持（engine 未动、零运行时依赖、聚合全绿）。

### 1. 逐 finding 确认表

| Finding | 声称修复 | 独立确认 | 关键证据（原始命令/输出） |
|---|---|---|---|
| **F1** `AGENT.md` 治理 | §1 S17 ✅、§2 G6/G7 🟡、§3 任务图 6/6、§5 C6 Checkpoint、§8 D28–D33、§9 变更日志、§10 | ✅ | `grep -n 'S17' AGENT.md` → `74:… \| M5 \| C6 \| ✅ 完成 \| G6/G7（真机待 250） …`；`grep -nE 'D2[89]\|D3[0-3]' AGENT.md` → 358–363 六行（D28–D33）全 ✅；`grep -n 'console-deploy-hardening' AGENT.md` → `112:…✅ 已归档（2026-10-14）`、`106:…✅ 完成（6/6：C1–C6 ✅）`；§5 新表 `142:### 当前（控制台）· C6` + `161:### 上一子任务（控制台）· C5`（C5 已降级为「上一子任务」）；`grep -n 'S1[1-7].*未开始'` → 无命中；`grep -n 'G6\|G7'` → `93:🟡 C6 已交付` / `94:🟡 C5 已交付`；变更日志 `371:2026-10-14 …C6…` |
| **F2** `TREE.md` 不新鲜 | 重生成；`--check` 退 0；`server.ts` 行数 1411 | ✅ | `bash tools/repomap.sh --check; echo exit=$?` → `TREE.md 已是最新` / `exit=0`；`grep -n 'server.ts' TREE.md` → `288:### \`src/console/server.ts\`  (1411 行)` |
| **F3** `clientKey` 回落措辞 | spec 不再写 `unknown`，改为 `x-real-ip`/`local` | ✅ | `sed -n '35p' .trellis/spec/console/ops-deploy.md` → 「…否则退 `x-real-ip`，最终 `local`（`clientIp`）」；`sed -n '88p' .trellis/spec/console/security.md` → 「…再退 `x-real-ip`/`local`」；`grep -rn '否则.*unknown' .trellis/spec/console/` → **无命中**（仅审计 `actor=unknown`，语义无关）；代码 `server.ts#clientIp` = `x-real-ip \|\| "local"`、`#clientKey` = `cf→xff→clientIp`，与 spec 一致 |
| **F4** `/health` 信封 | `api.md` 与 `ops-deploy.md` §六 显示 `{ok,data}` | ✅ | `sed -n '133p' .trellis/spec/console/api.md` → 「`{status,version,uptimeSec,db,tunnel}`（**在 `{ok,data}` 信封内**；…）」；`ops-deploy.md` §六 → `{"ok":true,"data":{…}}` + 「遵循全局信封 `{ok,data}`（字段在 `data` 内）」 |
| **Bonus** `README.md` 顶层树注释 | 列出 `console-*` | ✅ | `sed -n '54p' README.md` → `#   + console-*（控制台部署/备份/恢复/验收 + systemd mode A/B）` |

### 2. 任务洁净度回归（原始命令 → 输出）

```bash
export PATH="$HOME/.bun/bin:$PATH"
bash tools/repomap.sh --check; echo "exit=$?"
#   TREE.md 已是最新
#   exit=0

git diff --quiet -- src/pi.ts src/wechat.ts src/publisher.ts src/mailer.ts && echo ENGINE_UNTOUCHED_OK
#   ENGINE_UNTOUCHED_OK

grep -c '"dependencies"' package.json
#   0

bunx tsc --noEmit && echo TSC_OK          # TSC_OK
bun build src/console/main.ts --target=bun >/dev/null && echo BUILD_OK   # BUILD_OK

bash /tmp/wfc-c6-verify.sh
#   == static ==      ok tsc / ok bun build / ok no runtime deps / ok engine untouched / ok dry-run
#   == C6 specials == ok ratelimit / backoff / health / sse / backup / deploy-artifacts
#   == C1–C5 ==       ok author aggregate C5
#   ================ C6 aggregate: pass=12 fail=0 ================
```

### 3. 反证扫描（falsification）

- **旧 `unknown` 回落**：`grep -rn '否则.*unknown' .trellis/spec/console/` → 无；仅存的两处 `unknown` 是审计 `actor=unknown`（未登录归属），与 `clientKey` 无关。
- **旧 `tunnel:<status>` / `TunnelSupervisor.status().status` 措辞**：唯一命中在 `ops-deploy.md:93` 的**校准记录表**（有意保留 v0 旧写法作为对照，其「实际」列已改为 `tunnelHealth(db, ops)` 优先 DB 行 `status`），**非残留错误**；`grep -rn 'TunnelSupervisor.status().status' | grep -v '校准\|v0\|回落'` → 无命中。
- **`AGENT.md` §5 表值 vs 第 1 轮证据**：专项数字与证据表一致（限流 38/0、health 20/0、退避 23/0、SSE 20/0、备份 17/0、部署 37/0、聚合 12/0、独立探针 51/0）。✓

### 4. 本轮新增修正（复核人直接修复，均为文档一致性，低危）

| 文件 | 修正 | 原因 |
|---|---|---|
| `.trellis/spec/console/index.md` L66/L68 | Guidelines Index 表 `api.md`/`security.md` 版本行 `v5（C1–C5）` → `v6（C1–C6）` | 与同文件 L6 状态行（已声明 v6）及两文件各自抬头（v6）矛盾；`data-model.md` 仍 v5，保持不变 |
| `AGENT.md` §5 遗留 Checkpoint 块 | 「**C6 待办**」行 → 「**C6 遗留项（历史记录；C6 D31/D33 已处理）**」 | 该行仍把 C2 D2 / C4 N1–N3 列为待办，与已交付的 D31/D33 相矛盾（历史叙述块，保留但改写为已处理） |

> 上述 2 处均为文档陈述与当前代码/状态不一致（stale statement）的修正，**不触碰任何 `src/` 或部署产物**。

### 5. 第 2 轮最终判定

**PASS** —— 第 1 轮 F1/F2（必需）与 F3/F4（建议）全部确认修复；新增 2 处文档一致性瑕疵已顺手修正。**可放行 G6/G7 的真机（250）验收。**

