# C2 · design.md · 调度与任务模型（console-scheduler）

> 需求见 `prd.md`；契约见 `.trellis/spec/console/{data-model,api,security}.md`；
> 父设计见父任务 `design.md` §4（任务模型）/§5.3（调度）；父排期见父 `implement.md` M2a。
> 铁律不变（H1）：AI 只产内容，其余确定性；唯一真相源仍是草稿箱真实 DOM（`verifyDraftBody`，C3 消费）。

---

## 1. 目标与边界

把「每周/每月计划 + 每日发布」的**触发与状态**从 systemd timer 迁到 **DB 真源**：
计划落库、任务入队、调度到期、worker 调 engine 执行、**每账号互斥**、幂等、失败显形。
**不重写发布逻辑**——worker 只调用既有 `runPlan` / `runPublish`。

C2 交付：`plans`/`jobs`/`job_logs` 的读写 + `queue`/`worker`/`scheduler` + 最小 API + timer 迁移脚本。
C2 不做：计划编辑 UI、SSE、生成/重生成（C3）、会话（C4）、邮件（C5）。

---

## 2. 组件与依赖方向

```
console/jobs/
  types.ts      JobKind / JobPayload / JobRecord 类型
  plans.ts      计划 CRUD + period_key 解析/校验
  queue.ts      入队 / 原子认领 / 心跳 / 超时回收 / 状态迁移
  worker.ts     pump：认领 → 调 engine → 写 progress/job_logs/终态
  scheduler.ts  定时扫描到期计划 → 入队（幂等）
```

依赖方向：`console/jobs/* → console/db,console/auth,console/config` + `../planner.ts`,`../publisher.ts`,`../state.ts`。
**engine 不 import console**（H2）。worker 用 `loadConfig(alias)` 得到 `AppConfig` 交 engine。

---

## 3. 数据模型（复用 C1 已建的 v1 表，不再加列）

- `plans(id, account_id, period_type∈{week,month}, period_key, items_json, status, created_by, created_at, updated_at)`，`UNIQUE(account_id,period_type,period_key)`。
- `jobs(id, account_id, kind, payload_json, status∈{queued,running,succeeded,failed,canceled}, progress, message, error, attempts, created_by, queued_at, started_at, ended_at, pid)`。
- `job_logs(id, job_id, ts, level, message)`。

**`items_json` 形态**（与 engine `Plan[]`/`PlanDay[]` 对齐，见 `src/planner.ts`）：
```jsonc
// period_type=week, period_key="2026-W42" —— 条目 ≤7 天，date 必须落在该 ISO 周内
{ "week": "2026-W42", "days": [ { "date":"2026-10-13", "module":"...", "topic":"...", "summary":"...", "targetWords":1200 } ] }
// period_type=month, period_key="2026-10" —— 月摘要，days 为概览条目（不强制 ≤7、不按周校验）
{ "month": "2026-10", "days": [ { "date":"2026-10-13", "topic":"...", "summary":"..." } ] }
```

**调度参数**（`settings(key='global')` 内 `schedule` 子树，全部可缺省）：
```jsonc
{ "schedule": { "enabled": true, "publishHour": 7, "planWeekday": 0, "tickSec": 60 } }
```
- `publishHour`：当天该时刻后允许入队 `publish`（默认 7 点，按 engine 时区）。
- `planWeekday`：周几检查「本周无计划则入队 `plan`」（默认 0=周日）。
- `enabled=false`：scheduler 空转（手动入队仍可用）。

**不变量（新增/强化 I3/I4/I5）**
| # | 不变量 | 保障 |
|---|---|---|
| I3′ | `jobs.status` 单向：`queued→running→{succeeded,failed,canceled}`；终态不可再迁移 | `queue.ts` 仅用带 `WHERE status=...` 的条件 UPDATE |
| I4′ | **每账号同时 ≤1 个 `running`** | 认领 SQL 含 `NOT EXISTS(...status='running')` + 进程内 `runningAccounts:Set` 双保险 |
| I5′ | 同账号+同日期已有 `succeeded` 的 `publish` → 跳过（`ok:true, skipped`） | 认领前查 `jobs` + engine `isPublished(stateDir,date)` |
| I11 | 崩溃安全：进程重启时遗留 `running` → `failed('interrupted by restart')` | worker 启动 reaper |
| I12 | `plans` 变更与 `job` 入队均落 `audit` | `dao/audit` |
| I13 | **`plans` 表为计划唯一真源；engine 计划文件为派生物** | `plans.ts#materializePlans`（DB→`data/<alias>/plans/<week>.json`，`tmp`+`rename` 原子） |

**计划 ↔ engine 文件物化契约（I13，实现补充）**

方向固定：**DB → 文件**（派生）；反向导入仅作为迁移/兼容通道。

| 函数 | 方向 | 时机 | 语义 |
|---|---|---|---|
| `materializePlans(db,cfg,accountId)` | DB → 文件 | `PUT /plans` 成功后；`kind=publish` 执行前防御性再跑一次 | 原子覆写该账号全部周计划文件 |
| `importPlansFromFiles(db,cfg,accountId)` | 文件 → DB | `kind=plan` 任务成功后（吸收 agent 写出的文件） | `upsert`；跳过 `*.dryrun.json` |
| `fillMissingPlansFromFiles(db,cfg,accountId)` | 文件 → DB | scheduler 每轮（迁移桥） | **仅当 DB 无该周计划**才采纳 → 控制台编辑永不被文件回灌覆盖 |

三者都会再过 `validatePlanInput`（周 ≤7 天、日期须在该 ISO 周内、`topic` 必填）。

---

## 4. 关键流程

### 4.1 入队（`POST /api/accounts/:id/jobs`）
1. RBAC：`assertAccountAccess`（owner 仅授权账号）。
2. 校验 `kind∈{plan,publish}`（C2；`generate`/`regenerate` 预留 → 400 `bad_request: kind not supported yet`）。
3. 写 `jobs(queued)` + `audit(action='job_enqueue', target=job:id, detail={kind,payload})`。
4. 返回 `201 {job}`。

### 4.2 认领与互斥（worker pump，默认 poll 2s）
```sql
-- 原子认领（并发下仅一行成功）；每账号互斥由 NOT EXISTS 保证
UPDATE jobs
   SET status='running', started_at=datetime('now'), attempts=attempts+1, pid=?
 WHERE id = (
   SELECT id FROM jobs j
    WHERE j.status='queued'
      AND NOT EXISTS (SELECT 1 FROM jobs r WHERE r.account_id=j.account_id AND r.status='running')
    ORDER BY j.id LIMIT 1
 )
 RETURNING *;
```
- 进程内再加 `runningAccounts` 集合（防同进程竞态）；`runningJobs.size` 受 `CONSOLE_MAX_CONCURRENCY`（默认 2）约束。
- 无到期行（或达并发上限）→ sleep。

### 4.3 执行（`worker.executeJob`）
- `kind=plan`：`loadConfig(alias)` → `runPlan(cfg,{date?,dryRun?})`。
- `kind=publish`：
  - 幂等预检：`isPublished(cfg.paths.state, date)` 或 已 `succeeded` 的 publish → 直接 `succeeded, message="already published"`。
  - 否则 `runPublish(cfg,{date,reuse,force})` → 依 `PublishRunResult.ok` 落 `succeeded/failed`。
- 执行期：`log()` 写 `job_logs`；阶段回调更新 `progress`（0→100）与 `message`。
- **失败显形（AC-11）**：`ok:false` / 抛错 → `jobs.status='failed', error=<原因>, ok:false`；**绝不落 succeeded**。

### 4.4 调度（scheduler tick，默认 60s）
对每个 `enabled` 账号：
- **publish**：若「今天在计划内」且 `now.hour ≥ publishHour` 且 今天无 `queued/running/succeeded` 的 publish 且 `!isPublished(today)` → 入队 `{kind:'publish', payload:{date:today}}`。
- **plan**：若「本周无 plan」且 `weekday==planWeekday` → 入队 `{kind:'plan'}`。
- 每次入队同样去重（DB 唯一性检查），保证 tick 幂等。

### 4.5 生命周期
- `serve` 默认内联启动 `scheduler` + `worker`（`--no-worker` 可关）；另提供 `--worker` 独立子命令（仅跑调度+执行，不起 HTTP）。
- 退出（SIGINT/SIGTERM）→ `clearInterval` + 等待在跑任务收敛（best-effort）。

---

## 5. API（C2 增量，沿用统一错误包）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/accounts/:id/plans` | 列表；`?period_type=&period_key=` 过滤 |
| PUT | `/api/accounts/:id/plans` | 创建/覆盖：`{period_type,period_key,items}`；周条目 >7 或日期越界 → 400 |
| GET | `/api/accounts/:id/plans/find?date=` | 命中当天条目（供 UI/编排） |
| POST | `/api/accounts/:id/jobs` | 入队 `{kind,payload}` → 201 |
| GET | `/api/accounts/:id/jobs` | 账号任务列表（`?status=&limit=`） |
| GET | `/api/jobs/:id` | 任务详情 + 最近 `job_logs` |
| POST | `/api/jobs/:id/cancel` | 取消（仅 `queued` 可取消 → `canceled`） |

- 全部写操作要求 CSRF（C1 已全局强制）；`cancel` 亦写 `audit`。
- 权限：`/api/jobs/:id` 需该 job 归属账号可访问（owner 校验），否则 403。
- **SSE 推迟到 C3**（C2 用 `GET /api/jobs/:id` 轮询即可满足「状态可见」）。

---

## 6. 迁移期：停用 systemd timer（可回退）

- 目标：控制台调度接管原 timer 的 `plan`/`publish` 触发点。
- 交付：`deploy/console-scheduler.md` + `deploy/systemd/disable-timer.sh` / `enable-timer.sh`（**幂等**，只 `disable --now`/`enable --now` 既有 unit，不删 unit 文件）。
- 顺序：先确认控制台 `scheduler` 能覆盖触发点（本次以**手动入队 + 到期扫描**双证据验证）→ 再停 timer；**回退 = `enable-timer.sh`**。
- 本机（开发环境）**不实际停用**生产 timer；仅提供脚本与文档，停用发生在部署环境（C6 收口）。

---

## 7. 权衡与替代

| 决策 | 选择 | 理由 / 替代 |
|---|---|---|
| 执行进程 | **内联在 `serve`**（+ 可选 `--worker`） | 零依赖、单进程即互斥简单；替代「独立常驻 worker」→ 跨进程需 DB 锁 + 心跳 |
| 互斥实现 | DB `NOT EXISTS` + 进程内 Set | 单进程下足够；多进程需 `SELECT ... FOR UPDATE` 等价（SQLite `BEGIN IMMEDIATE`） |
| 幂等真源 | engine `state/published.json` **优先**，`jobs` 表为辅 | 对齐铁律：真相在 engine 侧；`jobs` 只防重复入队 |
| 到期判定 | 由 `plans.items_json` 的 date + `schedule` 设置推导 | 不新增列；替代「每计划带 cron」→ 过度设计 |
| 定时器 | `setInterval`（`tickSec`） + 单次 tick 加锁 | 防 tick 重叠（`ticking` 标志） |

---

## 8. 回滚

| 区域 | 动作 | 回滚 |
|---|---|---|
| `src/console/jobs/**` | 新增 | 删除目录；`server.ts`/`main.ts` 去掉调用 |
| `server.ts` 路由 | 增量 | 移除路由即可 |
| `main.ts` | 增量（`--worker`/内联启动） | 移除即可 |
| systemd | `disable --now` | **`enable-timer.sh`** 恢复 |
| DB | 复用 C1 表，无 DDL 变更 | 无需迁移回滚 |

**发布链路（`wechat.ts`/`publisher.ts`/CDP）零改动**；worker 仅调用既有导出。
