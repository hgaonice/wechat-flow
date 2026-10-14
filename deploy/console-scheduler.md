# C2 · 控制台调度与 systemd timer 迁移

> 任务：`.trellis/tasks/10-13-console-scheduler`；设计见其 `design.md` §6。
> 目标：把「每周计划 + 每日发布」的**触发**从 systemd timer 迁到控制台调度器（DB 真源）。
> 铁律不变：控制台只**触发**既有 engine（`runPlan` / `runPublish`），发布链路零改动。

---

## 1. 两种触发路径对比

| | systemd timer（旧） | 控制台 scheduler（新，C2） |
|---|---|---|
| 计划来源 | 计划文件 `data/<alias>/plans/*.json` | `plans` 表（落库）→ 物化回计划文件 |
| 触发时刻 | `wechat-plan.timer` 周日 20:00；`wechat-publish.timer` 每日 07:30 | `settings.schedule`：`planWeekday`（默认 0=周日）、`publishHour`（默认 7） |
| 并发 | 无跨账号协调 | **每账号同时 ≤1 个 running job**；全局并发 `CONSOLE_MAX_CONCURRENCY`（默认 2） |
| 幂等 | `state/published.json` | `state/published.json` **优先** + `jobs` 表去重 |
| 状态可见 | journalctl | `jobs` / `job_logs` + `GET /api/jobs/:id` |
| 失败显形 | 邮件 + 非零退出 | `jobs.status='failed'` + `error` + SS（C3）/邮件（C5） |

**迁移原则：先确认控制台能覆盖触发点，再停 timer；回退只需一条命令。**

---

## 2. 调度参数（`settings` key=`global` 的 `schedule` 子树）

```jsonc
{
  "schedule": {
    "enabled": true,        // false → 调度器空转（手动入队仍可用）
    "publishHour": 7,       // 当天该小时后允许入队 publish（Asia/Shanghai）
    "planWeekday": 0,       // 0=周日；该周几检查「本周无计划则入队 plan」
    "tickSec": 60           // 扫描间隔秒（5–3600；改动需重启进程）
  }
}
```

通过 `PUT /api/settings`（admin）修改。**未配置时使用上述默认值。**

---

## 3. 启动方式

```bash
# 一进程：HTTP + 调度 + worker（默认）
bun src/console/main.ts

# 一进程：只跑调度 + worker（无 HTTP，适合 systemd 独立 worker unit）
bun src/console/main.ts --worker

# 只跑 HTTP（不跑调度/worker，迁移期并行观察时用）
bun src/console/main.ts --no-worker
```

- 默认内联 `scheduler + worker`；`command + args` 见 `main.ts`。
- 退出（SIGINT/SIGTERM）：`clearInterval` + 等在跑任务收敛（best-effort）+ 关 DB。
- 重启安全：启动时 reaper 把上个进程遗留的 `running` 置 `failed('interrupted by restart')`。

---

## 4. 迁移步骤（部署环境）

```bash
# 0) 前置：控制台已按 C1 初始化（master key / admin / 导入 config）
bun src/console/main.ts --status

# 1) 起控制台（含调度），确认能覆盖触发点
CONSOLE_DB=/var/lib/wechat-console/console.db bun src/console/main.ts &

# 2) 双证据：手动入队 + 到期扫描（见 §5），确认状态流转与去重

# 3) 停用 timer（保留 unit 文件，可回退）
bash deploy/systemd/disable-timer.sh

# 4) 观测一个周期（周日 plan / 次日 publish），确认 jobs 正常终态
sqlite3 console/console.db "select id,kind,status,substr(coalesce(error,''),1,60) from jobs order by id desc limit 10"
```

---

## 5. 验收证据（AC-5 / AC-11）

### 5.1 AC-5 状态流转（手动入队）

```bash
# 登录拿 cookie + CSRF（见 api.md §2.1），然后：
curl -s -b cookie -H "X-CSRF-Token: $CSRF" -H 'content-type: application/json' \
  -X POST localhost:8787/api/accounts/1/jobs -d '{"kind":"plan","payload":{"dryRun":true}}'
sqlite3 console/console.db "select id,kind,status,progress from jobs order by id desc limit 5"
# 期望：queued → running → succeeded / failed（有终态即证明状态机流转）
```

### 5.2 AC-5 每账号互斥

```bash
# 每账号同时 running ≤ 1
sqlite3 console/console.db "select account_id,count(*) from jobs where status='running' group by account_id"
# 期望：每行 count=1（无行=当前无 running）
```

### 5.3 AC-11 失败显形

```bash
curl -s -b cookie -H "X-CSRF-Token: $CSRF" -H 'content-type: application/json' \
  -X POST localhost:8787/api/accounts/1/jobs -d '{"kind":"publish","payload":{"date":"1999-01-01"}}'
sleep 3
sqlite3 console/console.db "select id,status,substr(error,1,80) from jobs order by id desc limit 3"
# 期望：status='failed' 且 error 非空（绝不 succeeded）
```

### 5.4 幂等（重复 tick 不重复入队）

```bash
# 连续两次调度扫描：第二次不产生新 job
# （脚本级验证见任务 check 证据；核心 SQL：）
sqlite3 console/console.db "select kind,json_extract(payload_json,'\$.date'),count(*) from jobs group by 1,2"
```

---

## 6. 回退（回退脚本恢复 timer）

```bash
# 立即恢复 systemd timer 触发
bash deploy/systemd/enable-timer.sh

# 并停用控制台调度，避免双重触发
systemctl stop wechat-console.service          # 或
bun src/console/main.ts --no-worker            # 仅 HTTP，不跑调度
```

控制台 DB 无需回滚（C2 复用 C1 表，无 DDL 变更）。

---

## 7. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 到期了但没入队 | `schedule.enabled=false`；或当天不在 `plans` 内；或 `hour < publishHour`；或已 `isPublished` / 已有 live job |
| 任务一直 `queued` | 该账号已有 `running` job（互斥）；或全局并发已达 `CONSOLE_MAX_CONCURRENCY` |
| 重启后旧任务变 `failed` | 正常：reaper 将遗留 `running` 标记为 `interrupted by restart`，重新入队即可 |
| 改了 `tickSec` 不生效 | 间隔在启动时读取一次，需重启进程 |
| 双重触发（timer + 控制台） | 必须只保留一个；停 timer 用 `disable-timer.sh` |
