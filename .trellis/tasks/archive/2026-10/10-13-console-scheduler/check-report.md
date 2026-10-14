# C2 · check-report.md · 调度与任务模型（console-scheduler）

> 任务：`.trellis/tasks/10-13-console-scheduler`
> 验收对象：未提交工作区（`src/console/jobs/**` 新增；`src/console/{server,main}.ts`、`.gitignore` 修改；`deploy/**` 新增）
> 依据：`prd.md`（AC-5/AC-10/AC-11）、`design.md`（I3′/I4′/I5′/I11/I12、D1–D6）、`implement.md`（I2-1..I2-9、§6 证据）、`.trellis/spec/console/{data-model,api,security}.md`、`.trellis/spec/engine/{index,error-handling,verification,quality-guidelines}.md`
> 结论日期：2026-10-14

---

## 0. Verdict

**PASS-with-issues（无阻塞缺陷）**

- 代码实现与 C2 需求/不变量/契约一致；AC-5、AC-11、AC-10 均有可复现真实证据。
- 发布链路**零改动**，无新增 runtime 依赖。
- 本次 check 直接修复 2 类问题：**死代码/未用导出**（5 处）与 **403 审计 actor 归属改为请求局部**（消除共享可变状态，防未来并发串号）。
- 未发现阻塞发布/安全的缺陷。遗留项均为「非阻塞观察 + 建议」，列于 §4。

> 注：`implement.md` §5 DoD 已勾选「spec v2 校准 / AGENT.md 更新 / task archive + 提交」，但工作区实际**未做**（见 §3 问题 D1）。这属于 I2-9 收口动作，预期在 check 通过后执行；但**当前打勾是虚假完成声明**，归档前必须补齐或去掉勾选。

---

## 1. 逐项检查结论（含命令与真实输出）

### 1.1 发布链路零改动（H1 / H2）

```bash
$ git status --porcelain src/ | grep -v 'src/console/'
(仅输出 src/console 外为空)
$ git status --porcelain src/
 M src/console/main.ts
 M src/console/server.ts
?? src/console/jobs/
```

- `src/console/jobs/worker.ts` 只 import engine 既有导出：`loadConfig`（`../../config.ts`）、`runPlan`（`../../planner.ts`）、`runPublish`（`../../publisher.ts`）、`isPublished`（`../../state.ts`）、`todayInTz`（`../../date.ts`）；计划物化复用 `planPath`（`../../planner.ts`）。未复制/改写发布逻辑。
- 依赖方向仍为 `console/* → ../*.ts`，engine 无反向 import。
- **结论：通过。**

### 1.2 不变量 I3′/I4′/I5′/I11/I12

命令：`bun /tmp/wfc-c2-jobs.ts`（本次改动后重跑）

```
===== RESULT: 35 passed, 0 failed =====
  ✅ 首次认领成功
  ✅ 同账号已被占用 → 不认领其它 queued — got=3 want=3
  ✅ 全局都 running 后无新认领
  ✅ 每账号 running ≤1 — [{"account_id":1,"n":1},{"account_id":2,"n":1}]
  ✅ 释放后继续认领 — id=2
  ✅ cancel queued 成功 / cancel 终态再次 cancel=false / cancel running=false（仅 queued）
  ✅ finish running→succeeded / 终态再 finish=false
  ✅ reap 至少回收 1 条 — n=2 / 无遗留 running / 标记 interrupted by restart
  ✅ hasPublishJobForDate 命中 / 其它日期不命中 / canceled 不算 live
  ✅ 首次 tick 入队 — alpha:publish,beta:plan / 二次 tick 不重复入队 — n=0
```

- I3′：`queue.finish`、`cancel`、`claimNext` 全部是带 `WHERE status=...` 的条件 UPDATE，终态不可再迁移（单测覆盖）。
- I4′：`claimNext` 的认领子查询含 `NOT EXISTS(...r.status='running')`，配合进程内 `runningAccounts:Set` 双保险；`SELECT account_id,count(*) ... GROUP BY account_id` 实测每账号 `n<=1`。
- I5′：`executeJob` publish 分支先查 `isPublished(cfg.paths.state, date)`（engine 真源优先），`res.ok` 才 `succeeded`；调度去重另用 `hasPublishJobForDate`（jobs 表，含 succeeded）。
- I11：`startWorker` 启动即 `reapStartup`，遗留 `running` → `failed('interrupted by restart')`。
- I12：`enqueue` 内写 `audit(action='job_enqueue')`；计划变更写 `plan.upsert`；取消写 `job_cancel`（见 §1.4 审计输出）。

**结论：通过。**

### 1.3 失败显形（H5 / AC-11）

命令：`bash /tmp/wfc-c2-http.sh`（真实 HTTP e2e）

```
== 6) unsupported kind → 400 ==
  kind=generate status=400
== 7) AC-11: publish 坏日期 → failed + error ==
  job id=1
  status=failed error='no plan entry for 1999-01-01; run "plan" first' logs=3
== 8) AC-5: kind=plan dryRun 状态流转 ==
  job id=2 initial=queued
  status=failed msg='' err='planner agent failed: timeout'
```

- 失败一律落 `status='failed'` + 非空 `error`，绝不 `succeeded`。
- `generate`/`regenerate` 在 API 层 400，在 worker 层兜底 `failed('kind ... 尚未实现（C3）')`——不伪装成功（H5）。
- 状态流转 `queued→running→failed` 可见（`GET /api/jobs/:id` 轮询）。

**结论：通过。** 唯一措辞偏差：AC-11 原文「写 `ok:false`」，实现以 `jobs.status='failed'` + `error` 表达（`jobs` 表无 `ok` 列，C1 schema 已冻结）。见 §4 建议 B。

### 1.4 RBAC / CSRF / 审计

命令：`bash /tmp/wfc-c2-http.sh`

```
== 4) CSRF missing on write → 403 ==  no-csrf POST jobs status=403
== 11) RBAC: owner 只能访问被授权账号 ==
  owner sees=['beta'] isAdmin=False
  owner→alpha plans status=403   owner→beta plans status=200
  owner→settings status=403      owner→POST users status=403
  owner→POST beta job status=201 owner→POST alpha job status=403
== 12) 未登录 → 401 ==  anon /api/jobs/1 status=401
== 13) audit ==
   ('denied', 'admin', 0, 'POST /api/accounts/1/jobs')
   ('plan.upsert', 'admin', 1, 'alpha:week:2026-W42')
   ('job_enqueue', 'admin', 1, 'job:1')
   ('job_cancel', 'admin', 1, 'job:6')
   ('denied', 'own1', 0, 'GET /api/accounts/1/plans')
   ('denied', 'own1', 0, 'GET /api/settings')
   ('denied', 'own1', 0, 'POST /api/users')
   ('denied', 'own1', 0, 'POST /api/accounts/1/jobs')
```

- 所有 C2 新路由均先 `assertAccountAccess`；`/api/jobs/:id`、`/api/jobs/:id/cancel` 经 `loadJob()` 由 `job.account_id` 反查鉴权（`server.ts:411-416`）。
- 写操作由全局 CSRF 门统一强制（`server.ts:646`），无遗漏。
- **C2 顺带修复已验证**：403 `denied` 审计 `actor` 不再是写死的 `'unknown'`，而是真实用户名（`'admin'` / `'own1'`）。

**结论：通过。**

### 1.5 并发正确性（原子认领 / cancel / finish）

- `claimNext` 为**单条** `UPDATE jobs SET status='running' ... WHERE id=(SELECT ...) RETURNING *`（`queue.ts:79-93`），SQLite 单语句原子，并发下只有一个赢家；`RETURNING` 实测可用。
- `cancel` 仅 `WHERE status='queued'`（`queue.ts:120-128`）；e2e：首次 200、再次 409（`任务当前状态为 canceled，仅 queued 可取消`）。
- `finish` 仅 `WHERE status='running'`（`queue.ts:99-116`）；终态再 finish 返回 false。
- 认领子查询 `ORDER BY j.id LIMIT 1`，公平 FIFO。

**结论：通过。**

### 1.6 计划 ↔ engine 文件一致性

- `materializePlans`（DB→文件，`plans.ts`）：`tmp-<pid>` 写入 + `rename` 原子替换；PUT `/plans` 后立即调用；publish 前防御性再调用。
- `importPlansFromFiles`（文件→DB，`plans.ts`）：仅吸收 `week`+`days` 形态，跳过 `*.dryrun.json`（`f.endsWith(".dryrun.json")`），并经 `validatePlanInput` 再校验后 `upsertPlan`。
- e2e：`PUT plan` 返回 200 且 `find?date=` 命中；`kind=plan,dryRun` 只写 `2026-W42.dryrun.json`（未被导入 DB）。
- **实现 vs design 偏差**：`design.md` §3 只写「DB 复式表 + items_json 形态」，未描述「DB 真源 ↔ 计划文件物化」的方向；`implement.md` I2-1 已明确该契约。判定为**设计需补**（非实现错）；已记录于 §4 建议 E。

**结论：通过（设计文档需补一句）。**

### 1.7 时间语义

- 单一时钟 `Asia/Shanghai`（`scheduler.ts:23` `TZ`；`date.ts` 默认 tz 一致）。
- `readSchedule` clamp：`publishHour∈[0,23]`、`planWeekday∈[0,6]`、`tickSec∈[5,3600]`；缺省 `{enabled:true,publishHour:7,planWeekday:0,tickSec:60}`。
- `hourInTz` 对 `hour12:false` 的 `"24"` 做了 `%24` 归零；`weekdayInTz` 固定 `en-US` short 名映射。
- `startScheduler`：`ticking` 标志防 tick 重入，且**启动即跑一次**（不首个间隔）。
- 单测 `readSchedule planWeekday — =3`；调度 e2e 8s 内入队、再 12s 不增。

**结论：通过。**

### 1.8 零新增 runtime 依赖（H3 / AC-10）

```bash
$ node_modules/.bin/tsc --noEmit && echo tsc-ok        → tsc-ok
$ bun build --target=bun src/console/main.ts >/dev/null && echo build-ok → build-ok
$ node -e "const p=require('./package.json');if(p.dependencies)process.exit(1)" && echo zero-deps-ok → zero-deps-ok
```

`package.json` `dependencies` 仍为空；仅用 `bun:sqlite`、`Bun.serve`、`node:fs`、`Intl`。

**结论：通过。**

### 1.9 死代码 / 类型逃逸 / SQL 注入

- **SQL 注入面**：全部查询参数化。`countJobs` 的 `placeholders`/`dateClause` 由固定字符串构造（statuses 为字面量数组），无用户输入拼接。`listPlans` 的 where 子句来自固定字段。`json_extract(payload_json,'$.date')` 用绑定参数。**无注入面。**
- **死代码**：发现并删除 5 处未用导出（见 §2 修复）。
- **类型逃逸**：保留 `as unknown as Json` 5 处（`queue.ts:46`、`server.ts:225/241/457/473`）。成因：`JobPayload`/`PlanItems` 索引签名值为 `unknown`，而 console `Json` 值域严格。非 `any`，tsc strict 通过；建议后续对齐（§4 建议 F）。

**结论：修复后通过。**

### 1.10 systemd timer 迁移脚本 + 文档

```bash
$ bash -n deploy/systemd/disable-timer.sh && echo disable-bashn-ok → disable-bashn-ok
$ bash -n deploy/systemd/enable-timer.sh  && echo enable-bashn-ok  → enable-bashn-ok
$ bash deploy/systemd/disable-timer.sh --dry-run   → 打印 + systemctl list-timers；exit=0
$ bash deploy/systemd/disable-timer.sh --dry-run   → 重复执行仍 exit=0（幂等）
$ bash deploy/systemd/disable-timer.sh --bogus     → 未知参数: --bogus；exit=2
```

- 两脚本只 `disable --now` / `enable --now` 既有 unit，**不删 unit 文件**，可回退；`--dry-run` 只打印。
- 脚本引用的 unit 名 `wechat-plan.timer` / `wechat-publish.timer` 与仓库 `deploy/*.timer`、`deploy/install.sh` 一致。
- `deploy/console-scheduler.md` 含：两种触发路径对比、`schedule` 参数、三种启动方式、迁移步骤、AC-5/AC-11 验收命令、回退命令、常见问题。

**结论：通过。**

### 1.11 生命周期（`--no-worker` / `--worker` / 优雅退出）

命令：自建临时环境实测（`/tmp/wfc-c2-flags`）

```
== --no-worker ==   log: off ✓        SIGTERM handled ✓
== --worker (no HTTP) ==  HTTP not listening ✓ / log: headless ✓ / SIGTERM handled ✓
```

- `serve` 默认内联 scheduler+worker，`--no-worker` 关闭。
- `--worker` 不监听 HTTP（`curl /health` 不通），仍跑调度+执行。
- SIGINT/SIGTERM：停调度 → `await worker.stop()` → 关 server/DB。

**结论：通过。** 见 §4 建议 C（`worker.stop()` 无超时上限）。

### 1.12 未触碰发布真源（engine verification）

- worker 不解析草稿箱、不判成功；publish 成功与否完全由 engine `runPublish` 的 `PublishRunResult.ok` 决定，engine 内部仍走 `verifyDraftBody` 收尾。
- C2 未新增任何「上游自报即成功」的判定。

**结论：通过。**

---

## 2. 本次修复（修前 / 修后）

### 修复 1 · 删除死代码/未用导出（5 处）

**修前**（`grep -rn` 仅命中定义处，`/tmp` 测试脚本亦未引用）：

| 符号 | 文件 | 问题 |
|---|---|---|
| `periodTypeFor` | `src/console/jobs/plans.ts` | 未被任何调用方使用 |
| `TERMINAL_STATUSES` | `src/console/jobs/types.ts` | 未使用 |
| `asJsonObject` | `src/console/jobs/types.ts` | 未使用（`asObject` 已够用） |
| `payloadDate` | `src/console/jobs/types.ts` | 未使用；注释「used in dedup SQL」与事实不符（去重在 SQL 用 `json_extract`） |
| `countJobsFor` | `src/console/jobs/queue.ts` | 注释「Public for scheduling tests」但无任何测试/调用引用 |

**修后**：

```bash
$ grep -rn "periodTypeFor\|TERMINAL_STATUSES\|asJsonObject\|payloadDate\|countJobsFor" src/
none
$ node_modules/.bin/tsc --noEmit && echo tsc-ok    → tsc-ok
$ bun build --target=bun src/console/main.ts && echo build-ok → build-ok
$ bun /tmp/wfc-c2-jobs.ts | tail -1                 → ===== RESULT: 35 passed, 0 failed =====
```

### 修复 2 · 403 审计 actor 归属改为请求局部（消除共享可变状态）

**修前**（C2 引入）：`createApp` 作用域内 `let lastSession: SessionContext | null`，`route()` 每请求赋值、`handle()` 的 catch 读取它写 `denied` 审计。属于**跨请求共享可变状态**。

**修后**（`server.ts`）：把 `try/catch` 移入 `route()`，用该请求的局部 `session` 记录 `denied`；`handle()` 只负责把 `HttpError` 转响应。

```ts
const session = sess.lookupSession(db, token);
try {
  ... // CSRF / RBAC / dispatch，403 在此抛出
} catch (err) {
  if (err instanceof HttpError && err.status === 403) {
    recordAudit(db, { userId: session?.user.id, actor: session?.user.username ?? "unknown",
                      action: "denied", target: `${method} ${pathname}`, ok: false,
                      ip: clientIp(req), detail: err.message });
  }
  throw err;
}
```

**证据（重跑 HTTP e2e，行为不变且 actor 正确）**：

```
('denied', 'admin', 0, 'POST /api/accounts/1/jobs')
('denied', 'own1',  0, 'GET /api/accounts/1/plans')
('denied', 'own1',  0, 'GET /api/settings')
('denied', 'own1',  0, 'POST /api/users')
('denied', 'own1',  0, 'POST /api/accounts/1/jobs')
```

**定性说明（诚实标注）**：经逐 handler 核验，当前**所有** `assertAccountAccess`/`assertAdmin` 都发生在任何 `await readJson` **之前**，403 均在同一同步片段内抛出，因此旧写法在当前代码下**未观察到实际串号**。本次改动是**消除潜在竞态的加固**（任何未来在 await 之后才鉴权/抛 403 的 handler 都不会再误记 actor），非已发生的线上缺陷。

---

## 3. 发现的问题（按严重度）

| # | 严重度 | 问题 | 位置 | 阻塞? |
|---|---|---|---|---|
| D1 | 中（流程） | `implement.md` §5 DoD 勾选了 `.trellis/spec/console/*` v2 校准、`AGENT.md` §1/§5/§9 + journal 更新、`task.py archive` + 提交，但工作区**零证据**：`git status` 对 `.trellis/spec/`、`AGENT.md` 无 diff（spec 仍写 v1 / C2 为契约先验；AGENT §5 仍标 C2「🟡 规划（下一步）」）；`task.json` `status:"in_progress"`；无 C2 提交。违反「完成=产物/命令证据」。 | `implement.md` §5；`.trellis/spec/console/*.md`；`AGENT.md` | 否（代码），**归档前必须补齐或撤销勾选** |
| D2 | 低（运维） | 计划 job 持续失败时**无退避**：只要 `weekday===planWeekday` 且本周无 DB 计划且无 live plan job，每个 tick（默认 60s）都会重新入队 plan，可能当天反复触发 pi/邮件。 | `scheduler.ts:103` | 否（符合 design 字面），C6 加固建议 |
| D3 | 低（迁移） | 调度只认 **DB** 计划。迁移期用 `bun src/cli.ts plan` 生成、未经控制台 `kind=plan` 任务导入的计划文件，scheduler 看不到 → 不会自动入队 publish（手动入队 publish 仍可用）。 | `scheduler.ts:88`；`plans.ts#importPlansFromFiles`（仅在 plan 任务后调用） | 否，建议文档明示或加启动导入 |
| D4 | 低（健壮性） | `worker.stop()` 无超时上限：SIGTERM 会无限等待在跑的 publish/plan 收敛后才 `server.stop`/`db.close`；一个卡死的任务会拖住退出。 | `worker.ts:172-177`；`main.ts` shutdown | 否，design 写明「best-effort」 |
| D5 | 低（信息面） | `GET /api/jobs/:id` 先 404（不存在）后 403（无权），对越权 owner 泄露「该 job 是否存在」；`jobView` 额外下发内部 `pid`。 | `server.ts:411-416`、`jobView` | 否 |
| D6 | 低（一致性） | AC-11 字面「写 `ok:false`」，实现为 `jobs.status='failed'` + `error`（表无 `ok` 列）。语义等价，但 `GET /api/jobs/:id` 的**外层包裹仍是 `ok:true`**，C3 UI 必须读 `status` 而非 `envelope.ok`，否则可能误显示成功。 | `prd.md` AC-11；`api.md` | 否，C3 契约需明确 |
| D7 | 极低 | `readSchedule` 用 `s.enabled !== false`：若配置写成数字 `0` 会被当作 enabled；`finish(failed)` 把 `progress` 重置为 0，丢失失败时进度。 | `scheduler.ts:33`、`queue.ts:107` | 否 |
| D8 | 极低 | `as unknown as Json` 5 处类型逃逸（非 `any`，strict 通过）。 | 见 §1.9 | 否 |

---

## 4. 建议但未改（供 C3/C6 决策）

- **A（D1）** 归档 C2 前补齐 I2-9：更新 `.trellis/spec/console/{api,data-model,security}.md` 到 C2 现状、`AGENT.md` §5/§9 与 journal、执行 `task.py archive` 并提交；同时**修正 `implement.md` §5 的虚假勾选**（先去掉，补齐后再勾）。
- **B（D3）** 在 `console-scheduler.md`「迁移步骤」补一句：迁移期所有计划须经控制台创建；或让 `schedulerTick` 在查 DB 未命中时回退 `engine.findEntryForDate`（当前 worker 已 import 该函数，成本低）。
- **C（D4）** 给 shutdown 的 `worker.stop()` 加 `Promise.race` 超时（如 30s），超时后仍 `failed('interrupted by shutdown')` 或直接退出。
- **D（D2）** 计划 job 失败加退避（如按 `attempts` 指数退避或当日仅重试 N 次），避免 tick 级重试风暴。
- **E（偏差）** 在 `design.md` §3 增补「plans 物化契约」：DB 为真源 → `materializePlans` 原子写 `data/<alias>/plans/<week>.json`；反向 `importPlansFromFiles` 吸收 agent 文件并跳过 `*.dryrun.json`。
- **F（D6/AC-11）** 明确 C3 UI 契约：任务失败以 `job.status==='failed'` + `error` 呈现；可选在 `jobView` 加派生的 `ok: status==='succeeded'` 便于前端。
- **G（D7）** `readSchedule` 对 `enabled` 做布尔强校验；`finish(failed)` 保留失败时 `progress`。
- **H（D8）** 让 `JobPayload`/`PlanItems` 的值域与 console `Json` 对齐，消除 `as unknown as Json`。

---

## 5. 复现证据索引

| 证据 | 命令 | 结果 |
|---|---|---|
| 类型 | `node_modules/.bin/tsc --noEmit` | 零错误 |
| 构建 | `bun build --target=bun src/console/main.ts` | 通过 |
| 零依赖 | `node -e "…p.dependencies…"` | zero-deps-ok |
| 任务层单测 | `bun /tmp/wfc-c2-jobs.ts` | **35 passed, 0 failed** |
| HTTP e2e | `bash /tmp/wfc-c2-http.sh` | CSRF 403 / 400 / 401 / 403 / 201 / 409 全符合预期；AC-11 `failed + error` |
| 调度 e2e | `bash /tmp/wfc-c2-sched.sh` | 1 条 publish（actor=scheduler, source=scheduler）；再 tick 仍 1 |
| 启动模式 | 临时环境测 `--no-worker` / `--worker` / SIGTERM | 行为符合预期 |
| timer 脚本 | `bash -n` + `--dry-run`（可重复） | 通过、幂等、未知参数 exit=2 |
| engine 零改动 | `git status --porcelain src/ \| grep -v src/console/` | 空 |
| 死代码 | `grep -rn "periodTypeFor\|TERMINAL_STATUSES\|asJsonObject\|payloadDate\|countJobsFor" src/` | none |

> 测试全部在 `/tmp` 与临时 DB 中进行；跑完已清理仓库根的 `config.json` / `config.json.bak` / `data/`，`git status` 无测试残留。

---

## 6. 结论

C2 实现**功能完整、契约一致、失败显形、零发布链路改动**，AC-5 / AC-10 / AC-11 均有可复现真实证据；本次直接修复死代码与审计归属的潜在竞态。**无阻塞缺陷。** 唯一需在归档前处理的是 `implement.md` §5 的虚假 DoD 勾选与尚未执行的收口文档/归档（D1）。
