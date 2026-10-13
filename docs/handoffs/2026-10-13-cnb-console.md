# 交接词 · 在 CNB Agent 中继续 wechat-flow 全部开发任务

> **生成时间**：2026-10-13　**生成者**：pi（本地）
> **基线 commit**：`c796b1f`（GitHub `origin` 与 cnb 双远端均已同步）
> **失效条件**：控制台 M0 收口 + C1–C6 全部验收并归档，**或**被更新的交接稿取代，**或** `HEAD` 落后本基线超过 20 个提交（届时先看 `git log --oneline c796b1f..HEAD`）
> **状态**：有效
> **配套约定**：[`.trellis/spec/guides/cross-env-handoff.md`](../../.trellis/spec/guides/cross-env-handoff.md)（本次交接即该约定的首个实例）
>
> 用途：把「可直接粘贴的交接词」一节整段粘贴到 CNB（cnb.cool）的 Agent 会话/CLI 中，作为接手提示词。

---

## 可直接粘贴的交接词（复制以下整段）

```text
你是 wechat-flow 项目的接手 Agent，在 CNB 环境中继续该项目"公众号多账号 Web 管理控制台"的全部开发任务。
请严格按下面的续接协议执行，不要自由发挥、不要臆测需求、不要整读仓库。

【0. 仓库与环境】
- 仓库：https://cnb.cool/gaohnice/wechat-flow（镜像 https://github.com/hgaonice/wechat-flow），分支 main，基线 commit c796b1f。
- 技术栈：TypeScript + Bun（bun >= 1.3，本地实测 1.4.2），运行时**零第三方 npm 依赖**（只用 bun 内置能力实现 HTTP/WS/SQLite/哈希）。
- devDeps 仅 @types/node + typescript；静态检查用 `bunx tsc --noEmit`，转译检查用 `bun build --target=bun src/cli.ts >/dev/null`。
- 任务框架自带：`python3 .trellis/scripts/task.py {list,current,start,archive}`、`python3 .trellis/scripts/get_context.py --mode phase --step <x>`。
- 不在仓库内的东西（.gitignore）：`config.json`、`.env`、`data/`（各账号运行时数据与草稿状态）、`~/.git-credentials`。
  → 需要凭据/密钥/真实配置时**向我索取**，绝不猜测、绝不把密钥写进代码或提交。

【1. 开工三分钟续接协议（有硬性读取上限）】
按顺序读，读完即开工：
 1) `AGENT.md`（项目唯一续接入口：进度看板 / GATE / 任务地图 / 下一步）
 2) `.trellis/tasks/10-13-wechat-flow-console/prd.md`（控制台源需求 + AC-1..AC-11）
 3) `.trellis/tasks/10-13-wechat-flow-console/implement.md`（里程碑 M0–M5 与分任务清单）
按需再读（不要整读）：父任务 `design.md` / `research.md`、对应子任务 `prd.md`+`design.md`、`.trellis/spec/engine/index.md`、
`ARCHITECTURE.md`、`src/README.md`、`TREE.md`。**禁止整读** `README.md` 与 `docs/操作手册.md`（只在安装/部署/排障时按节读）。
单次任务最多读 3 个非 AGENT.md 文件；优先 TREE.md → src/README.md → spec。

【2. 铁律与硬约束（违反即视为失败）】
 - 铁律①：**AI 只做内容，其余确定性**（可复现/可重跑/可自动验收）。
 - 铁律②：**唯一真相源 = 微信草稿箱真实 DOM**（`verifyDraftBody`）；任何"自检通过"都不算数。
 - 既有发布链路（`src/wechat.ts` / `src/publisher.ts` / CDP 会话 / 发布会话自愈）**未经我确认不得改动**。
 - 先计划后改：动手前必须给出【改动方案 + 影响文件 + 验证命令】，等我确认；涉及 `src/` 或发布链路必须等确认。
 - 完成 = 证据：必须给出**产物真实路径**或**真实命令输出**；禁止"应该没问题""我记得做过了"。
 - 单活动任务：一次只跑一个 `.trellis/tasks/` 任务，完成即写 Checkpoint、清空上下文、重读 `AGENT.md` §5 继续。
 - 零依赖红线：`package.json` 的 runtime `dependencies` 必须保持为空（AC-10）。
 - 迁移期兼容：任何里程碑结束时 `bun src/cli.ts publish --dry-run` 必须仍可用。
 - 需求有分歧 → 写进对应任务的 `prd.md`，不要自行决策。
 - 每个子任务开工前先读 `.trellis/spec/engine/index.md`；C1 之后按 P7 建 `.trellis/spec/console/`，此后 console 代码先读该 spec。

【3. Trellis 工作流（每个子任务都走这套）】
 Phase 1 规划：`task.py start` **之前**，确认 `prd.md`（必须）+ `design.md` + `implement.md`（复杂任务必须）齐备 → 输出规划摘要 → **等我批准**。
 → `python3 .trellis/scripts/task.py start`（status 变 in_progress）→ Phase 2 实现 + 自检 → Phase 3 更新 spec/journal、提交、归档。
 需要 DDL/契约变更时同步更新 spec，不要只改代码。

【4. 已知偏差（你必须先修，再动代码）——M0 收口项】
 - P6：把规划摘要发我确认（Phase 1 收口门）。
 - P7：建 `.trellis/spec/console/` 骨架（`index.md` + `api.md` + `data-model.md` + `security.md` + `agent-session.md`）。
 - P8：更新 `AGENT.md`——§1 进度看板新增控制台阶段（S11+）、§2 GATE 新增控制台相关门、§3 任务地图补 6 个子任务、§8 ADR 补 D11–D14。
 - 说明：当前 `AGENT.md` §1/§3 尚未包含控制台的 S11 阶段与 C1–C6 任务，**这是已知缺口，不是 Agent 漏读**；P8 完成后该缺口消失。

【5. 待办任务清单（严格按依赖推进）】
 顺序：M0 收口（P6–P8）→ C1 → C2 → C3 → C4 → C5 → C6；C4 与 C2 相互独立（都只依赖 C1），可插队。
 - C1 `console-foundation`：Bun.serve 骨架 + bun:sqlite（WAL/foreign_keys/user_version 迁移）+ AES-256-GCM 凭据加密（无 master key 必须 fail-fast）
   + 鉴权/RBAC/CSRF + 账号 CRUD（alias 与 cdpPort 唯一、冲突给可用端口提示，不静默回退）+ 全局默认与单账号覆盖（含"恢复继承"）
   + `config.json` 无损迁移与原子回渲染。验收 AC-1/2/3/4/10。依赖：无。
 - C2 `console-scheduler`：周计划（`period_key=2026-W42`，条目 ≤7 天）/月摘要 CRUD；`jobs`+`job_logs`（queued→running→succeeded/failed/canceled，progress/attempts/pid）；
   worker 调用既有 engine（`runPlan`/`runPublish`）；**同账号同时最多 1 个运行中任务**（cdpPort/profile 独占）+ 全局并发上限 + 审计。
   验收 AC-5（调度侧）。依赖：C1 验收通过（尤其 AC-3 迁移）后才可接管 systemd timer。
 - C3 `console-content-workbench`：计划编辑 UI → 触发生成（SSE `job.progress` 实时状态）→ 推送草稿箱 → 产物查看（md/封面/公式/正文校验结果）→ 重生成与版本历史。
   验收 AC-5/7。依赖：C1、C2。
 - C4 `console-agent-session`：`pi --mode rpc` 长活子进程、严格 JSONL（**只在 `\n` 切分，禁用 readline**）、命令 prompt/steer/follow_up/abort/get_state/get_messages/set_model、
   流式 WebSocket/SSE 输出、决策卡片（选择/确认/输入）人在环、最小权限工具集。验收 AC-6。依赖：C1。
 - C5 `console-ops-tunnel`：每账号接收邮箱（多邮箱 + 主题前缀）；cloudflared 子进程监督（quick/named tunnel）、解析 `*.trycloudflare.com`、健康检查；
   地址变更/过期自动重生成并邮件下发（服务器信息 + 当前地址 + 该账号后台账密）；凭据加密存储；管理员全局视图。验收 AC-8/9。依赖：C1。
 - C6 `console-deploy-hardening`：`wechat-console.service` + `cloudflared.service`（systemd，Restart=on-failure）；反代/隧道参数化；**只映射控制台端口，绝不暴露 CDP 端口**；
   备份/恢复、限流与锁定、迁移与回滚手册、文档与 spec/AGENT 更新；AC-1..AC-11 全量端到端回归。依赖：C1–C5 全部验收。
 命令与验证姿势：见父任务 `implement.md` §2 每个子任务的「验证命令」；不要臆造命令。

【6. 部署与真机门（GATE）】
 - 目标机：192.168.0.250；部署脚本与验收清单在 `deploy/`（`deploy.sh`、`install.sh`、`ACCEPTANCE-250.md`）。
 - G2：**任何发布链路相关改动**，必须在 250 真机跑 `publish --force --reuse` → `drafts --date <日期>` 显示 `✅ 正文校验` 才算过；不能只在本地自测。
 - 上线/部署/重装前必须先经我确认（G1 类门）。C6 的部署动作同样要先给我方案再执行。
 - systemd timer 是既有唯一触发器（ADR D7）；C2 接管调度时必须保留可回退路径（旧 timer 不删，先停用）。

【7. 汇报格式（每次给结果都按这个来）】
 - 一句话结论 → 产物路径列表 / 关键命令与输出摘要（贴数字）→ 未决问题或需要我确认的点。
 - 每完成一个子任务：更新 `AGENT.md`（§1 进度看板、§5 当前任务+Checkpoint、§9 变更日志）、写 journal、`task.py archive`，然后提交。

【8. Git 约定】
 - 在 cnb 上工作：分支 main，提交信息用 `feat(console): ...` / `fix(...): ...` / `chore(trellis): ...`，一个子任务一个任务粒度提交。
 - 推送：`git push cnb main`；如配置了 GitHub 远端，同步 `git push origin main`，两端保持同一 commit，推送后回报两侧 SHA。
 - 禁止提交密钥、`config.json`、`.env`、`data/`。

【9. 现在开始】
先执行【4】的 P6–P8 三件收口事，然后给出 C1 的规划摘要（改动方案 + 影响文件 + 验证命令 + 回滚点）等我确认。
在我批准之前，不要写任何实现代码。
```

---

## 附：本地侧待办（CNB 接手前建议在此侧完成）

> 说明：以下三项属**交接出稿时**的本地侧缺口。P7/P8 已同时被写入交接词 §4，作为 CNB 侧 M0 收口项；
> 无论哪一侧先做，都必须在 `AGENT.md` §9 变更日志登记，避免两边重复施工。

- [ ] `AGENT.md` P8 更新（进度看板 S11+ / ADR D11–D14 / 任务地图）——本交接词已把该缺口列为 CNB 侧 P8，若你希望本地先补，可让我执行。
- [ ] `.trellis/spec/console/` 骨架（P7）——同上。
- [ ] 若 CNB Agent 需要真实配置：准备 `config.json` / `.env` / master key 的安全传递方式（不要走聊天记录）。
