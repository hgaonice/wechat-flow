# C2 · implement.md · 执行计划（console-scheduler）

> 设计见 `design.md`；契约见 `.trellis/spec/console/{data-model,api,security}.md`；父排期见父 `implement.md` M2a。
> 完成 = 产物路径 或 真实命令输出；禁止“我记得做过了”。

---

## 0. 开工前置检查

- [x] `prd.md` 就绪
- [x] `design.md` 就绪（本目录）
- [x] `implement.md` 就绪（本文件）
- [x] `implement.jsonl` / `check.jsonl` 写入真实条目（非占位）
- [x] 用户批准本规划摘要（“批准 C2 开工”）→ `python3 .trellis/scripts/task.py start 10-13-console-scheduler`（`planning → in_progress`）

---

## 1. 实施顺序（每步含验证）

### I2-1 `jobs/types.ts` + `jobs/plans.ts`（计划模型）
- 定义 `JobKind`/`JobPayload`/`JobRecord`；计划 CRUD（upsert/find/list）+ `period_key` 解析与校验。
- 周：`items.days.length ≤ 7` 且每个 `date` 落在该 ISO 周内；月：`YYYY-MM`。
- **验证**：`tsc` 通过；单测 35/35（8 条周计划 400、空 days 400、跨周 400、缺 topic 400、非法 period_key 400、合法 200、`weekday` 自动补 `周二`）。
- **实现要点**：DB 为计划真源，engine 计划文件为派生物——`materializePlans(db,cfg,accountId)` 原子写 `data/<alias>/plans/<week>.json`；反向 `importPlansFromFiles(db,cfg,accountId)` 吸收 agent 写出的文件（跳过 `*.dryrun.json`）。

### I2-2 `jobs/queue.ts`（入队/认领/心跳/回收）
- `enqueue`（写 queued + audit `job_enqueue`）、`claimNext`（原子条件 UPDATE + `NOT EXISTS` 互斥）、`finish`、`cancel`、`reapStartup`。
- **验证**：单测——首次认领成功；同账号已有 running 时不认领其 queued；全局占满后无新认领；每账号 running ≤1；`finish` 释放后可继续认领；`cancel` 仅对 queued（200 / 再 cancel 409）；终态不可再迁移；`reapStartup` 把遗留 running 标 `interrupted by restart`。

### I2-3 `jobs/worker.ts`（pump + 调 engine）
- `startWorker(db)`：pump 循环 + 进程内 `runningAccounts` Set + 并发上限（`CONSOLE_MAX_CONCURRENCY`，默认 2；`CONSOLE_WORKER_POLL_MS` 默认 2000）。
- `executeJob`：`kind=plan` → `runPlan` + `importPlansFromFiles`；`kind=publish` → 幂等预检 + `materializePlans` + `runPublish`；写 progress/job_logs/终态。
- **验证**：真实 HTTP e2e——`kind=plan,dryRun` 走 `queued→running→failed(planner agent failed: timeout)`（沙箱内 `pi` 15s 超时，状态机与失败显形均已证明）；`kind=publish` 坏日期 → `failed` + `error='no plan entry for 1999-01-01; run "plan" first'`。
- **注意**：`generate`/`regenerate` 属 C3，worker 收到即 `failed`（显式说明“C3 未实现”），不伪装成功（H5）。

### I2-4 `jobs/scheduler.ts`（到期扫描）
- `readSchedule(db)` 读 `settings(global).schedule`（`{enabled,publishHour=7,planWeekday=0,tickSec=60}`）；`schedulerTick(db,now?)` 纯函数返回 `ScheduleAction[]`；`startScheduler` 用 `setInterval` + `ticking` 防重入，**启动即跑一次**（不等首个间隔）。
- 判定：publish —— 当天在计划内 && `hour≥publishHour` && `!isPublished` && 无 live publish job；plan —— `weekday===planWeekday` && 本周无计划 && 无 live plan job。
- **验证**：真实 e2e——置 `publishHour=0,tickSec=5` + 当天计划 → 启动后 8s 内出现 1 条 `publish`（`created_by=NULL`，audit `actor='scheduler'`, `detail.source='scheduler'`）；再等 12s 仍为 1 条（去重幂等）。

### I2-5 幂等
- `publish` 执行前 `isPublished(cfg.paths.state,date)` → `succeeded`；同账号同日期重复入队由 `hasPublishJobForDate`（`json_extract(payload_json,'$.date')`）去重。
- **验证**：单测 `hasPublishJobForDate` 命中/非命中/`canceled` 不算 live；publish 调度去重（I2-4 e2e：两次 tick 仅 1 条）。
- **真源优先级**：engine `state/published.json` **优先**于 `jobs` 表（设计 D5′）。

### I2-6 API 路由（server.ts 增量）
- 新增：`GET/PUT /api/accounts/:id/plans`、`GET /api/accounts/:id/plans/find?date=`、`POST/GET /api/accounts/:id/jobs`、`GET /api/jobs/:id`、`POST /api/jobs/:id/cancel`；RBAC（`assertAccountAccess`，job→account 反查）+ 全局 CSRF + audit（`plan.upsert`/`job_enqueue`/`job_cancel`）。
- **验证**：真实 HTTP——合法计划 200（返回 `periodKey`/自动 `weekday`）；8 条 400；`kind=generate` 400；缺 CSRF 403；owner 仅见被授权账号（alpha 403 / beta 200 / settings 403 / POST users 403 / POST beta job 201 / POST alpha job 403）；匿名 401。
- **顺带修复（C1 遗留）**：403 `denied` 审计原写死 `actor='unknown'`，现记录真实操作用户（`lastSession`），审计行变为 `('denied','own1',0,...)`。

### I2-7 `main.ts` 接入
- `serve` 默认内联 `startScheduler`+`startWorker`（`--no-worker` 关）；新增 `--worker` 子命令（无 HTTP）；SIGINT/SIGTERM 优雅退出（停调度 → 等 worker 收敛 → 关 DB）。
- **验证**：`--no-worker` 日志 `scheduler + worker: off` 且不入队；`--worker` 不监听 HTTP 且正常调度/执行；SIGTERM 日志 `[console.worker] SIGTERM → 停止…` / `[console] SIGTERM → 停止调度/worker…`。

### I2-8 timer 迁移脚本 + 文档
- `deploy/console-scheduler.md`、`deploy/systemd/{disable-timer.sh,enable-timer.sh}`（幂等、`--dry-run`、可回退）。
- **验证**：两脚本 `bash -n` 通过；`--dry-run` 输出正确且重复执行安全；文档含迁移步骤与回退命令。

### I2-9 AC 回归 + 收口
- 跑 §2 全套；更新 `AGENT.md`（§1 S13、§5 Checkpoint、§9 日志）、console spec（如需）、journal；归档任务。
- **验证**：`tsc`/`build`/zero-deps 全绿；单测 35/35；engine 源码零改动（`git status` 仅 `src/console/**` + `deploy/**`）。

---

## 2. 验收命令（AC 映射）

```bash
# AC-10（不回归）—— 实测全绿
node_modules/.bin/tsc --noEmit && echo tsc-ok
bun build --target=bun src/console/main.ts >/dev/null && echo build-ok
node -e "const p=require('./package.json');if(p.dependencies)process.exit(1)" && echo zero-deps-ok

# 起服务（含调度+worker）
CONSOLE_DB=/tmp/wfc-c2/console.db bun src/console/main.ts &   # 先 --init-key/--create-admin/--import-config

# 手动入队 kind=plan（AC-5）
curl -s -b cookie -H "X-CSRF-Token: $CSRF" -H 'content-type: application/json' \
  -X POST localhost:8787/api/accounts/1/jobs -d '{"kind":"plan","payload":{"dryRun":true}}'
sleep 3
sqlite3 /tmp/wfc-c2/console.db "select id,kind,status,progress from jobs order by id desc limit 5"

# 每账号互斥（AC-5）：同账号并发入队 2 个 → 第 2 个保持 queued
sqlite3 /tmp/wfc-c2/console.db \
  "select account_id, count(*) from jobs where status='running' group by account_id"   # 每账号 ≤1

# AC-11：失败显形
curl -s -b cookie -H "X-CSRF-Token: $CSRF" -H 'content-type: application/json' \
  -X POST localhost:8787/api/accounts/1/jobs -d '{"kind":"publish","payload":{"date":"1999-01-01"}}'
sleep 3
sqlite3 /tmp/wfc-c2/console.db "select id,status,substr(error,1,60) from jobs order by id desc limit 3"

# 审计
sqlite3 /tmp/wfc-c2/console.db "select action,actor,target from audit order by id desc limit 5"

# 兼容（迁移期）—— 需用户自备 config.json（本次未跑，engine 未改动 + cli.ts 编译通过代替）
bun src/cli.ts doctor --all
bun src/cli.ts publish --dry-run
```

**AC 映射**：AC-5（I2-1/3/4）、AC-11（I2-3/6）、AC-10（I2-9 / 全程零依赖）。

---

## 3. 影响文件与回滚

| 文件/区域 | 动作 | 回滚 |
|---|---|---|
| `src/console/jobs/**` | 新增 | 删除目录 |
| `src/console/server.ts` | 增量路由 | 移除路由 |
| `src/console/main.ts` | 增量启动 + `--worker` | 移除调用 |
| `deploy/systemd/*`、`deploy/console-scheduler.md` | 新增 | 删除；timer 用 `enable-timer.sh` 恢复 |
| DB | 复用 C1 表，无 DDL 变更 | 无需迁移回滚 |

**发布链路零改动**。

---

## 4. Review gates

1. **本规划批准** → 才 `task.py start`。
2. **I2-3 之后**：确认 worker 调 engine 未改发布语义（`doctor --all` + `publish --dry-run` + 一次 dry-run publish job 证据）。
3. **I2-4/5 之后**：确认幂等与到期扫描证据（重复 tick 不重复入队；同日期第二次 `already published`）。
4. **完成时**：AC-5/AC-11 证据齐 → 更新 AGENT.md/journal → `task.py archive`。

---

## 5. 完成定义（DoD）

- [x] AC-5 / AC-11 有**真实命令输出或产物路径**（见 §6）；
- [x] 每账号互斥有 SQL 证据（`running` 每组 ≤1 → `[(1,1)]`）；
- [x] 幂等有证据（重复 tick 不重复入队；`hasPublishJobForDate` 单测；第二次 tick n=0）；
- [x] timer 迁移脚本 + 回退文档就绪（`bash -n` + `--dry-run` 通过）；
- [x] 无新增 runtime 依赖；engine 源码零改动（`git status` 仅 console/deploy）；
- [x] `.trellis/spec/console/*` 已校准（v2：api.md 补 C2 路由已落地 + 任务失败语义「读 `status` 不读 `envelope.ok`」、data-model.md 补 I13 计划↔文件物化契约与 I11/I12、security.md 补 denied `actor` 与 job 路由先查后鉴权）；design.md 补 I13；`AGENT.md` §1（S13 ✅/S14 🟡）/§3/§5/§8（D11–D13 ✅ + D15）/§9/§10 + journal Session 7 已更新；
- [x] 独立复核：`trellis-check` **PASS-with-issues**（无阻塞）；直接修死代码 5 处 + 403 审计 actor 局部化；
- [x] check 遗留中 D3/D4/D7 已修并回归（迁移桥 / 有界 drain / 布尔强校验 + 失败保留进度）；D2 记入 `AGENT.md` §5 C6 待办；
- [x] `task.py archive` + 提交。

---

## 6. 证据索引（可复现）

| 证据 | 命令 / 位置 | 结果 |
|---|---|---|
| 类型 + 构建 + 零依赖 | `tsc --noEmit`；`bun build src/console/main.ts`；`node -e ... dependencies` | 全绿 |
| 任务层单测 | `bun /tmp/wfc-c2-jobs.ts` | **35 passed, 0 failed** |
| HTTP e2e（AC-5/AC-11/RBAC/CSRF） | `bash /tmp/wfc-c2-http.sh` | 见 §1 I2-1..I2-6 |
| 调度器 e2e（到期 + 幂等） | `bash /tmp/wfc-c2-sched.sh` | 1 条 publish，再 tick 不增 |
| `--no-worker` / `--worker` / 优雅退出 | 同上 | 行为符合预期 |
| AC-11 失败显形 | `jobs.status='failed'`, `error='no plan entry for 1999-01-01; run "plan" first'` | ✅ |
| 每账号互斥 | `select account_id,count(*) from jobs where status='running' group by 1` | `[(1,1)]` |
| engine 零改动 | `git status --porcelain src/` | 仅 `src/console/**` |
| timer 脚本 | `bash -n` + `--dry-run` | 通过，幂等 |
| 迁移桥（D3） | `bun /tmp/wfc-c2-d3.ts`：首采 1 / 二次 0 / DB 优先（`控制台改过` 未被覆写）；集成「仅文件计划 → 自动入队 publish」 | ✅ |
| 有界 drain（D4） | `worker.stop()` `Promise.race`（`CONSOLE_WORKER_DRAIN_MS` 默认 30000） | 代码 + 优雅退出 e2e |
| 调度布尔/进度（D7） | `readSchedule` 把 `0/"0"/"false"` 均视为关闭；`finish(failed)` 保留原 progress | `tsc` OK + 35/35 |
| 独立复核报告 | `.trellis/tasks/archive/2026-10/10-13-console-scheduler/check-report.md` | PASS-with-issues |

**验收脚本快照**（保留在 /tmp，归档前可重跑）：
- `/tmp/wfc-c2-jobs.ts` —— 35 项任务层断言（验证 PRD 校验、计划 CRUD、concurrency、终态、cancel、reaper、去重、调度幂等）
- `/tmp/wfc-c2-http.sh` —— HTTP 端到端（含 RBAC/CSRF/400/401/403/409）
- `/tmp/wfc-c2-sched.sh` —— 调度器到执行链路 + 去重
