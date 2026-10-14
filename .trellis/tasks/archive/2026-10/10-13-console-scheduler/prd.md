# C2 · 调度与任务模型（console-scheduler）

> 父任务：`10-13-wechat-flow-console`（源需求 R3.1–R3.3）。设计见父 `design.md` §5.3、§4。
> 依赖 C1 已验收（DB/鉴权/配置解析）。

## Goal
把"每周/每月计划 + 每日任务"从 systemd timer 迁移到 DB 真源：计划落库、任务入队、调度到位、每账号互斥执行，并保证既有发布链路的幂等与真相源校验不变。

## Requirements
- 周计划（`period_key=2026-W42`，条目 ≤7 天）/ 月摘要（`period_key=2026-10`）CRUD。
- `jobs` + `job_logs`：queued→running→succeeded/failed/canceled，含 progress/attempts/pid。
- `worker`：调用 engine（`runPlan`/`runPublish`），**同账号同时最多 1 个运行中任务**（`cdpPort`/profile 独占），全局并发上限。
- `scheduler`：默认 60s 扫描到期计划 → 入队。
- 幂等：同账号 + 同日期已有 `succeeded` job 则跳过（对齐 `data/<alias>/state/published.json`）。
- 审计：任务触发 / 计划变更落 `audit`。
- 迁移期**停用 systemd timer**，保留可回退脚本。

## Acceptance Criteria
- AC-5（调度侧）手动入队 `kind=plan`：状态在 UI/DB 可见流转；对同一账号并发入队 2 个任务时，第二个排队而非并行。
- AC-11 任一失败任务写 `ok:false` + 原因，UI 显示失败详情而不显示成功。
- 停用 timer 后，控制台调度能覆盖既有 `plan`/`publish` 触发点；回退脚本可恢复 timer。

## Out of Scope
计划编辑 UI（C3）、agent 会话（C4）、邮件通知（C5）。

## Dependencies
C1。C3 依赖本任务的任务模型。

## Notes / 关联文件
`src/console/jobs/*`、`src/console/db/schema.ts`（plans/jobs/job_logs）、engine `src/planner.ts`、`src/publisher.ts`、`src/state.ts`。
