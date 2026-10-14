<!--
  AGENT.md —— 项目唯一续接入口 / 进度看板
  协议：任何 AI Agent 接手本项目，先读本文件（≤3 分钟），再只按「下一步」点名读 1–3 个文件。
  禁止：未经本文件指引就整读 README/操作手册/全仓；禁止无证据声称完成。
  维护：每完成一个任务/阶段，必须同步更新本文件的「进度看板 / 当前任务+Checkpoint / 变更日志」。
  状态真相源：.trellis/（tasks / spec / workspace），本文件是人的看板与 Agent 的入口。
-->

# AGENT.md · wechat-flow · 续接入口 / 进度看板

> **一句话**：用 pi agent 按周计划写公众号文章 → 确定性后处理（封面/公式/动图）→ Chrome CDP 写入草稿箱（可选自动设封面）→ **回查草稿箱真实 DOM** 确认成功。

- 宏观架构：[`ARCHITECTURE.md`](./ARCHITECTURE.md)
- 模块微观上下文：[`src/README.md`](./src/README.md)
- 文件/符号索引：[`TREE.md`](./TREE.md)
- 引擎编码规范：[`.trellis/spec/engine/index.md`](./.trellis/spec/engine/index.md)
- 安装/结构：[`README.md`](./README.md)　日常/维护/排障：[`操作手册.md`](./docs/操作手册.md)

---

## 0. 开工前必读（Agent 三分钟续接协议）

```
1. 读本文件（全局进度 + 当前任务 + 下一步）
2. 按「下一步」只读它点名的 1–3 个文件；用 TREE.md / src/README.md / spec 定位，不要整读仓库
3. 执行；按 §6 带「产物路径」或「真实命令输出」打勾
4. 更新本文件「进度看板 / 当前任务+Checkpoint / 变更日志」
```

**核心纪律（硬约束，违反视为失败）**

- **读取上限**：单次任务最多读 3 个非本文件；优先 `TREE.md` → `src/README.md` → `spec`。禁止整读 `README.md` / `操作手册.md`（只在安装/运维/排障时**按节**读）。
- **先计划后改**：动手前先给出【改动方案 + 影响文件 + 验证命令】；涉及 `src/` 或发布链路时，等确认再改。
- **完成 = 证据**：产物真实存在 **或** 命令真实输出；不接受“我记得做过了”“应该没问题”。
- **单活动任务**：一次只跑一个 `.trellis/tasks/` 任务；完成即总结 Checkpoint → 清空上下文 → 重读 §5 继续。
- **两条铁律**（见 spec）：① AI 只做内容，其余确定性；② 唯一真相源是草稿箱真实 DOM。
- 需求有分歧 → 写进对应 task 的 `prd.md`，**不要臆测**。

---

## 1. 全局进度看板

| Stage | 名称 | 状态 | GATE | 证据/产物 |
|-------|------|------|------|-----------|
| **S0** | 基础设施：多账号配置 / 路径隔离 / CLI 骨架 | ✅ 完成 | G1 | `src/config.ts`、`src/cli.ts`、`config.example.json` |
| **S1** | pi 集成：JSON 事件流 + 重试 + 模型降级 | ✅ 完成 | — | `src/pi.ts` |
| **S2** | 周编排 `plan`（含 `--dry-run` 旁路文件） | ✅ 完成 | — | `src/planner.ts`、`plans/<周>.json` |
| **S3** | 内容生成 + 确定性后处理（封面 / LaTeX→SVG / manim GIF） | ✅ 完成 | — | `src/publisher.ts`、`math.ts`、`media.ts`、`cover.ts` |
| **S4** | 发布链路：Chrome CDP + 会话自愈 + 多账号隔离 | ✅ 完成 | G2 | `src/wechat.ts`、`browser.ts`、`session.ts` |
| **S5** | 真相源安全网：草稿箱回查 + 正文 DOM 校验（空正文事故修复） | ✅ 完成 | G2 | `verifyDraftPublished` / `verifyDraftBody` |
| **S6** | 幂等状态 / 通知 / 邮件 | ✅ 完成 | — | `src/state.ts`、`notify.ts`、`mailer.ts` |
| **S7** | 部署与调度：systemd timer + `deploy.sh` 防呆 + skill 补丁自适应 | ✅ 完成 | G1 | `deploy/` |
| **S8** | 文档：README + 操作手册 | ✅ 完成 | — | `README.md`、`操作手册.md` |
| **S9** | **上下文治理**：`.trellis` + `AGENT.md` + 分层文档 + repomap | ✅ 完成 | G4 | 已归档 `archive/2026-10/10-12-context-governance/` |
| **S10** | 封面自动上传到草稿（O-B：CDP 驱动封面弹窗） | ✅ 完成 | G2 | `archive/2026-10/10-12-cover-auto-upload/` |

图例：⚪ 未开始 ／ 🟡 进行中 ／ ✅ 完成 ／ 🔴 阻塞

> **S10 已完成并归档**：O-B（CDP 驱动编辑器封面弹窗）在 250 真机通过——成功路径（设封面 + 持久化 + 完整发布）与降级路径（封面失败不阻断正文）均实测。开关 `cover.uploadToDraft` 默认关，需显式打开。详见 §5 与 `archive/2026-10/10-12-cover-auto-upload/implement.md`。

### 控制台路线（S11+，第二阶段）

> 引擎 S0–S10 完成后的第二阶段：**公众号多账号 Web 管理控制台**（父任务 `10-13-wechat-flow-console`）。
> 复用 engine、不改发布铁律；规划真源：里程碑 M0–M5 / 子任务 C1–C6 / 验收 AC-1..AC-11 见父任务 `prd.md` 与 `.trellis/spec/console/`。

| Stage | 名称 | 里程碑 | 子任务 | 状态 | GATE | 证据/产物 |
|-------|------|--------|--------|------|------|-----------|
| **S11** | 控制台规划定稿（spec 骨架 + AGENT 更新） | M0 | — | ✅ 完成 | — | `.trellis/spec/console/*`、本文件 §1/§3 |
| **S12** | 控制台基座：服务/DB/鉴权/账号CRUD/配置覆盖/迁移 | M1 | C1 | ✅ 完成 | — | `src/console/**`、`archive/2026-10/10-13-console-foundation/`、spec v1 |
| **S13** | 调度与任务模型：计划表 + jobs + 调度器 + 每账号互斥 | M2a | C2 | ✅ 完成 | — | `src/console/jobs/**`、`deploy/console-scheduler.md`、`deploy/systemd/`、spec v2 |
| **S14** | 内容工作台：计划编辑 → pi 生成 → 草稿箱推送 → 重生成/版本历史 | M2b | C3 | ✅ 完成 | G2（真机待 250） | `src/console/{content,db/dao/articles,http/sse,ui/workbench.*}`、`archive/2026-10/10-13-console-content-workbench/`、spec v3 |
| **S15** | 会话与人在环：pi RPC + 流式 + 决策卡片 + 最小权限 | M3 | C4 | ✅ 完成 | G2（真机待 250） | `src/console/agent/**`、`src/console/ui/chat.*`、`archive/2026-10/10-13-console-agent-session/`、spec v4（agent-session v2） |
| **S16** | 运维与公网：邮箱 + CF 隧道地址下发 + 凭据加密 + 管理员视图 | M4 | C5 | ✅ 完成 | G7（真机待 250） | `src/console/{tunnel,notify}/**`、`db/dao/{emails,secrets,tunnels}.ts`、`ui/admin.*`、`archive/2026-10/10-13-console-ops-tunnel/`、spec v5（ops-tunnel v1） |
| **S17** | 部署与加固：systemd/反代/限流/备份/回归 | M5 | C6 | ✅ 完成 | G6/G7（真机待 250） | `src/console/http/ratelimit.ts`、`deploy/{systemd/*,install-console.sh,console-backup.sh,console-restore.sh,console-deploy.md,console-acceptance.md}`、`archive/2026-10/10-13-console-deploy-hardening/`、spec v6（ops-deploy v1） |

> **C4 已完成并归档（S15/M3，2026-10-14）**：每账号多会话 ↔ `pi --mode rpc` 长活子进程；严格 JSONL 切帧（禁 readline）；进程内 `ChatBus` → SSE 流式；`extension_ui_request` → 决策卡片（`pending→{answered,cancelled,expired,lost}`，**预期/异常关闭均同事务清算 pending**，无悬挂，I21/I23）；双层最小权限（`--tools read,grep,find,ls,console_ask` + `console-decision.ts` 硬阻断 `wechat*/publish*/mail*/backup*`）。engine 零改动；`CONSOLE_CHAT_MAX`(3)/`CONSOLE_CHAT_TTL_MS`(30min)。详见 §5。

> **C5 已完成并归档（S16/M4，2026-10-14）**：CF Quick Tunnel 监督（`TunnelSupervisor`）+ 地址变更邮件下发 + 凭据加密存取 + 管理员总览。**安全加固**：隧道构造期强校验 `host∈回环 ∧ port===CONSOLE_PORT ∧ port∉accounts.cdp_port`（fail-fast，防误配把 CDP 暴露公网，T1/I27）。发信复用 engine `sendMail` + `email-sender` 共享 SMTP（收件人=账号邮箱 ∪ 管理员副本），`smtp` kind 保留不参与发信。地址变更按 `tunnels.id` 去重 + 重试封顶停发。engine 零改动；`CONSOLE_TUNNEL`(0)/`CONSOLE_TUNNEL_MAIL_MAX_ATTEMPTS`(3)/`CONSOLE_TUNNEL_MAIL_ADMIN`(1)。详见 §5。

> **C6 已完成并归档（S17/M5，2026-10-14）**：systemd 服务（Mode A 主 / Mode B 互斥，`deploy/systemd/*` + `install-console.sh`）+ 备份/恢复脚本（`main.ts --backup`/`--restore-check`）+ 反代示例 + 部署/验收手册；API 限流（仅 `/api/*`，429 + `Retry-After`，不写审计）；`/health` 收紧为 `{status,version,uptimeSec,db,tunnel}`（`tunnel` 取最新 DB 状态）；调度失败退避（预算 + 冷却）；修复 C4/C5 遗留 N1–N3（SSE 监听泄漏 / `ChatBus.close` 未广播 / 已 abort 未清理）。engine 零改动、零新增依赖。`deploy/console-acceptance.md` 列 AC-1…AC-11 供真机回归。**第二阶段 C1–C6 全部交付（父任务 6/6）**。详见 §5。

---

## 2. 人工确认门（GATE）

| GATE | 位置 | 放行条件 | 状态 |
|------|------|----------|------|
| **G1** | 上线 250 | `doctor --all` 通过 + 端到端发布邮件送达 | ✅ 已放行（2026-10-12） |
| **G2** | 发布链路改动后 | 真机 `publish --force --reuse` → `drafts --date` 显示 `✅ 正文校验` | ✅ 已放行（2026-10-12，含空正文修复复验） |
| G3 | 内容真源策略变更 | 确认“本地仓库为真源”或改 `--keep-remote-content` | ✅ 已确认（本地为真源） |
| **G4** | 上下文治理交付 | 用户确认 `AGENT.md` + 分层文档 + `.trellis` 可用 | ✅ 已放行（2026-10-12） |
| **G5** | 封面自动化方案 | 用户选定 O-A / O-B 后再动发布链路 | ✅ 已选定 **O-B** 并经 **G2 真机验收通过**（2026-10-13） |
| **G6** | 控制台公网放行 | 强鉴权 + 限流锁定 + 审计 + 仅映射控制台端口（绝不暴露 CDP）+ 备份/回滚手册就绪；用户确认后才上线 | 🟡 C6 已交付（含限流/备份/回滚），真机 250 验收后请用户确认 |
| **G7** | 凭据加密与隧道放行 | AES-256-GCM fail-fast + 不回显明文 + CF Quick Tunnel 地址订阅邮件可用；用户确认 | 🟡 C5 已交付，真机 250 验收（隧道/邮件）后请用户确认 |

---

## 3. 任务地图（`.trellis/tasks/`）

| 任务目录 | 对应 Stage | 说明 | 状态 |
|----------|-----------|------|------|
| `archive/2026-10/10-12-cover-auto-upload/` | S10 | 封面自动上传 O-B（真机验收通过） | ✅ 已归档 |
| `archive/2026-10/10-12-context-governance/` | S9 | 上下文治理（已交付） | ✅ 已归档 |
| `archive/2026-10/00-bootstrap-guidelines/` | — | 填充 `spec/engine/` 的初始化任务 | ✅ 已归档 |
| `10-13-cross-env-handoff/` | —（规范治理） | 跨环境交接约定 + 模板 + 交接稿归档 | ✅ 已交付（2026-10-13） |
| `10-13-wechat-flow-console/` | S11+ | 控制台父任务（需求集 + AC-1..AC-11 + 任务地图） | ✅ 完成（6/6：C1–C6 ✅） |
| `archive/2026-10/10-13-console-foundation/` | S12 | C1 控制台基座（服务/DB/鉴权/RBAC/配置继承/迁移） | ✅ 已归档（2026-10-13） |
| `archive/2026-10/10-13-console-scheduler/` | S13 | C2 调度与任务模型（plans/jobs/queue/worker/scheduler + timer 迁移脚本） | ✅ 已归档（2026-10-14） |
| `archive/2026-10/10-13-console-content-workbench/` | S14 | C3 内容工作台 | ✅ 已归档（2026-10-14） |
| `archive/2026-10/10-13-console-agent-session/` | S15 | C4 Agent 会话与人在环 | ✅ 已归档（2026-10-14） |
| `archive/2026-10/10-13-console-ops-tunnel/` | S16 | C5 运维与公网（邮箱/隧道地址下发/凭据/管理员视图） | ✅ 已归档（2026-10-14） |
| `archive/2026-10/10-13-console-deploy-hardening/` | S17 | C6 部署与加固（systemd/限流/备份/回归 + 文档/spec/AGENT） | ✅ 已归档（2026-10-14） |

> 实时状态：`python3 .trellis/scripts/task.py list`；归档：`python3 .trellis/scripts/task.py list-archive`。

**规范系统**：`.trellis/spec/engine/`（入口 `index.md`）—— 改 `src/` 前必读。
单层结构（单仓项目）：`get_context.py --mode packages` → `Spec layers: engine`。

---

## 4. 上下文分层索引（先读什么，只读需要的）

| 想知道… | 读 | 代价 |
|---|---|---|
| 现在做到哪、下一步 | **`AGENT.md`**（本文件，永远第一） | 小 |
| 系统长什么样 / 边界与不变量 | [`ARCHITECTURE.md`](./ARCHITECTURE.md) | 中 |
| 某个模块的职责/导出/坑 | [`src/README.md`](./src/README.md) 对应小节 | 小 |
| 某个符号/文件在哪 | [`TREE.md`](./TREE.md) | 小 |
| 写 `src/` 代码的约定 | [`.trellis/spec/engine/index.md`](./.trellis/spec/engine/index.md) | 中 |
| 换环境 / 换 Agent 怎么交接 | [`.trellis/spec/guides/cross-env-handoff.md`](./.trellis/spec/guides/cross-env-handoff.md)（模板：[`docs/handoffs/TEMPLATE.md`](./docs/handoffs/TEMPLATE.md)） | 小 |
| 怎么安装/部署 | [`README.md`](./README.md)（按节） | 大 |
| 日常操作/维护/排障 | [`docs/操作手册.md`](./docs/操作手册.md)（按节） | 大 |

> 原则：**能读 3KB 就不读 30KB。**`TREE.md` 由 `bash tools/repomap.sh` 生成，改代码后请刷新。

---

## 5. 当前任务 + Checkpoint

**当前任务**：**控制台 C6 `console-deploy-hardening` 已完成并归档（父任务 6/6，S11+ 第二阶段收官）→ 转真机验收（G2/G6/G7）。**

### 当前（控制台）· C6 部署与加固（M5）

| # | 步骤 | 状态 | 证据 |
|---|------|------|------|
| I6-1 | spec 先行 `ops-deploy.md` v0 | ✅ | `.trellis/spec/console/ops-deploy.md`（I29–I34 / D28–D33） |
| I6-2 | systemd 单元（Mode A 主 / Mode B 互斥）+ `env.example` + `install-console.sh` | ✅ | `deploy/systemd/*`；`systemd-analyze verify` 仅报开发机无 bun 路径 |
| I6-3 | API 限流（`http/ratelimit.ts` 令牌桶 + `server.ts` 仅 `/api/*`；429 + `Retry-After`；不写审计） | ✅ | `/tmp/wfc-c6-ratelimit.ts` **38/0**；HTTP 探针 17/0 |
| I6-4 | `/health` 收紧为 `{status,version,uptimeSec,db,tunnel}`（`tunnel` 优先 DB 最新 status） | ✅ | `/tmp/wfc-c6-health.ts` **20/0** |
| I6-5 | 调度失败退避（`queue.countFailed`/`lastFailureAt` + `scheduler` 预算/冷却） | ✅ | `/tmp/wfc-c6-backoff.ts` **23/0**（29 tick 0 新增） |
| I6-6 | SSE/事件遗留修复 N1–N3 + 前端关流 | ✅ | `/tmp/wfc-c6-sse.ts` **20/0** |
| I6-7 | 备份/恢复（`main.ts --backup`/`--restore-check` + `console-backup.sh`/`console-restore.sh`） | ✅ | `/tmp/wfc-c6-backup.sh` **17/0**；恢复强制停服 + 预检 + 现状快照 |
| I6-8 | 部署手册/反代/验收清单 + README/手册 | ✅ | `deploy/{console-deploy,console-acceptance}.md`、`nginx-console.conf.example`、`README.md`、`docs/操作手册.md` §10.5；`/tmp/wfc-c6-deploy.sh` **37/0** |
| AC-10 | 零新增运行时依赖 / tsc / bun build / engine 未动 | ✅ | `dependencies` 缺失、`tsc --noEmit` 0 错、engine 4 文件 `git diff --quiet` 空 |
| AC-11 | 失败显形（429 不伪装成功；备份/恢复/退避失败必报错/留痕） | ✅ | 各专项脚本 + 独立探针 |
| 独立复核 | trellis-check | ✅ | `check-report.md`：**PASS-with-issues**（自写探针 51/0 + 聚合 12/0；F1/F2 治理文档缺失已修、F3/F4 措辞已修） |
| spec | 校准 console spec v5→v6（`ops-deploy.md` v1 + I29–I34） | ✅ | `.trellis/spec/console/{api,security,index,ops-deploy}.md` |

**下一步**：真机（250）执行 `deploy/console-acceptance.md`（AC-1…AC-11）→ G6/G7 请用户确认；引擎侧无需再改。

### 上一子任务（控制台）· C5 运维与公网（M4）

| # | 步骤 | 状态 | 证据 |
|---|------|------|------|
| I5-0 | spec 先行 `ops-tunnel.md` v0→v1 | ✅ | `.trellis/spec/console/{ops-tunnel,api,data-model,security,index}.md`（v5） |
| I5-1 | migration v3（`tunnels.notified_at`/`notify_attempts`）+ `dao/{emails,secrets,tunnels}.ts` | ✅ | v2→v3 单测 8/8；`openTunnel` 单事务收编旧 `up`/`down`（I24）；NULL 判重 |
| I5-2 | `tunnel/cloudflared.ts` `TunnelSupervisor`（spawn/解析/健康/变更/退避/去抖） | ✅ | `bun /tmp/wfc-c5-tunnel.ts` → `pass=19 fail=0`（退出码映射/健康/退避/去抖） |
| I5-3 | `notify/tunnel-mail.ts` `notifyTunnelChange`（收件人/去重/重试封顶/审计） | ✅ | `c5-check-smtp.ts` 7/0；按 `tunnels.id` 去重，`attempts` 封顶后停发（I26） |
| I5-4 | `server.ts` 11 条路由 + `ops` 注入 + `requireTunnel→503` | ✅ | `c5-check-http.ts` 50/0（401/403/404/400/503/CSRF/隔离） |
| I5-5 | `main.ts` 接线 + 关闭顺序（`scheduler→worker→chat→tunnel→server→db`） | ✅ | `main.ts` +15/−1；`tsc`/`bun build` OK |
| I5-6 | UI：`account` 邮箱/凭据表单 + `/admin` 总览 + 隧道徽标 + 导航 | ✅ | `c5-check-static.sh` 14/0；403/503/401 处理 |
| AC-C5-6 | 管理员总览：跨账号 + 凭据仅布尔 + 无明文 | ✅ | `c5-check-deviations.ts` 18/0 |
| AC-C5-7 | 隧道**只**指向 `127.0.0.1:<console_port>`，CDP 端口绝不入隧道 | ✅ | `c5-recheck-i27.ts` 24/0；复核 §7 判定 **CLOSED** |
| AC-C5-8 | `cloudflared` 崩溃 → `down`/`error` + 非空 `detail`（不伪装 up） | ✅ | 崩溃 e2e：`status∈{down,error}` + detail 含 exit/signal/stderr 尾 |
| AC-C5-9 | 零新增运行时依赖 / tsc / bun build / engine 未动 / C1–C4 回归 | ✅ | `dependencies=undefined`、`tsc --noEmit` 0 错、engine 4 文件 `git diff --quiet` = 空；C3 7/0、C4 8/0 |
| 独立复核 | trellis-check（两轮） | ✅ | `check-report.md`：首轮 **PASS-with-issues**（1 高：I27 端口未校验）→ 修复 → 复审 **PASS**，独立 196/0 |
| spec | 校准 console spec v4→v5（`ops-tunnel.md` v1 + I24–I28） | ✅ | `.trellis/spec/console/*` |

**下一步**：C6 `console-deploy-hardening`（systemd/反代/限流/备份/端到端回归；携带 C2–C5 遗留观察项：C2 plan-job 失败无退避、C4 N1–N3、`decision.expired` 命名）。
**真机待验（G2，250 主机）**：真实 `cloudflared` quick tunnel + 真实 `email-sender` 发信 + 浏览器 `/admin`；真实 `pi` 生成/流式与微信草稿推送（C3/C4）。
**推进顺序**：C1 ✅ → C2 ✅ → C3 ✅ → C4 ✅ → C5 ✅ → C6。

### 上一子任务（控制台）· C4 Agent 会话窗口与人在环（M3）

| # | 步骤 | 状态 | 证据 |
|---|------|------|------|
| I4-1 | `agent/frames.ts` 严格 JSONL 切帧（只按 `\n`，剥 `\r`，U+2028/2029 不切，禁 readline） | ✅ | 单测：跨 chunk 半帧 / CRLF / 空行 / U+2028 / 大帧 |
| I4-2 | `agent/rpc.ts` 极简 RPC（按 `id` 关联、`writeChain` 背压、stderr 200 行 ring、有序/意外退出可区分） | ✅ | 8 条命令 round-trip；`close()` 后 exit 不算 `lost` |
| I4-3 | migration v2（`chat_sessions.session_file`）+ `db/dao/chats.ts`（终态不可逆 I20 / 同事务 lost I23 / `closeChatSession`） | ✅ | 旧库 v1→v2 不丢数据；`answerDecision` 非 pending 返回 `null`；`closeChatSession` 原子性断言 |
| I4-4 | `agent/extensions/console-decision.ts`（`console_ask` 唯一通道 + fail-safe 拦截 + 永久拒绝名单） | ✅ | 单测断言危险工具无应答**必 block**；`--tools` 白名单可查 |
| I4-5 | `agent/events.ts`（ChatBus 500 环 + seq）+ `agent/manager.ts`（懒 spawn/TTL/上限/`handleExit`/`reapStale`） | ✅ | fake-pi e2e：`delta→message→settled`、决策往返、崩溃 lost、TTL 清算、`chat_limit` |
| I4-6 | `http/chat-sse.ts` + 12 条路由（复数 `/api/chats/*`、CSRF、RBAC、`Last-Event-ID` 重放 + `chat.resync`） | ✅ | HTTP e2e：201/200/403/409 + SSE + 重放 |
| I4-7 | `ui/chat.{html,css,js}` + `index.html` 入口 | ✅ | `bun build` 含新资源；浏览器手工加载**待 250/本地浏览器** |
| AC-6 | 流式可见 + 决策卡片人在环 + 超时/取消明确 + **无悬挂 pending** | ✅ | B1 修复后 TTL 清算 e2e（pending→0）；对抗复现 `PROBE(S) PASSED` |
| 失败显形 | 异常退出 → 会话/决策同事务 `lost` + SSE `chat.lost` + 非空 `reason` | ✅ | fake-pi `CRASH` e2e：`status='lost'`、`decisions=['lost']`、横幅 |
| 最小权限 | `--tools` 白名单 + 扩展硬阻断 + **无放开开关** | ✅ | 单测 + 启动参数断言 + `audit(agent.tool)` |
| AC-10 | 零新增运行时依赖 / tsc / bun build / engine 未动 | ✅ | `dependencies=undefined`、`tsc --noEmit` 0 错、`bun build` 49 modules、`git diff -- src/pi.ts src/wechat.ts src/publisher.ts` 空 |
| 独立复核 | trellis-check | ✅ | `check-report.md`：首轮 **FAIL**（唯一阻塞 B1 已修复并复审 **PASS**） |
| spec | 校准 console spec v3→v4（`agent-session.md` v2 + I19–I23） | ✅ | `.trellis/spec/console/{agent-session,index,api,data-model,security}.md` |

**下一步**：C5 `console-ops-tunnel` 规划（邮箱 + CF 隧道地址下发 + 凭据加密 + 管理员全局视图，G7）。
**真机待验（G2）**：真实 `pi` 流式 + 真实 `pi --extension` 加载 + 浏览器手工加载 `/chat`（需 250 主机）。
**推进顺序**：C1 ✅ → C2 ✅ → C3 ✅ → C4 ✅ → C5 → C6。

### 上一子任务（控制台）· C3 内容工作台（M2b）

| # | 步骤 | 状态 | 证据 |
|---|------|------|------|
| I3-1 | engine 抽 `runArticleGeneration`（+`buildArticlePrompt`）；`runPublish` 改为调用它 | ✅ | 空/缺 `feedback` 时 prompt **字节一致**（3012B，sha256 同）；`runPublish` 生成后区段与 HEAD **diff 相同** |
| I3-2/I3-3 | `db/dao/articles.ts`（版本链 DAO）+ `content/generate.ts`（`snapshotVersion`/`generateArticle`/`recordDraftResult`） | ✅ | 单测 30 项：v1→v3 单调、`parent_id` 链、旧 `.vN.md` 不可变、base=最新、失败不落行 |
| I3-4 | worker 真执行 `generate`/`regenerate`；publish 分支补写 `drafts`（`verified`=engine 判决）+ `articles.status='pushed'` | ✅ | 假 `pi` 正路 e2e：v1 行 + `.v1.md`、v2 父链 + 反馈、v1 快照不变 |
| I3-5 | `http/sse.ts` + 5 条新路由（articles/regenerate/generate/SSE）；`POST /jobs` 开放 `generate`/`regenerate` | ✅ | HTTP e2e：401/403/CSRF、SSE `job.progress/log/done`、`Last-Event-ID` 不重不漏 |
| I3-6 | UI `ui/workbench.{html,css,js}`（计划编辑、生成/推送、SSE 进度、版本链、LCS 对比、反馈重生成、失败面板） | ✅ | 代码审查 + 静态资源路由；浏览器手工加载**待 250/本地浏览器** |
| AC-11 | 失败必显形（`status='failed'` + 非空 `error`）且生成失败不落 `articles` 行 | ✅ | 4 类失败 e2e：均 `failed` + 非空 `error`，0 文章行 |
| AC-10 | 零新增运行时依赖 / tsc / bun build | ✅ | `dependencies=undefined`、`tsc --noEmit` 0 错、`bun build` 43 modules |
| 独立复核 | trellis-check | ✅ | `check-report.md`（**PASS**，8/8 必验项；4 项非阻塞观察） |
| spec | 校准 console spec v2→v3 | ✅ | `.trellis/spec/console/{index,api,data-model,security}.md`（I15–I18） |

**下一步**：C4 `console-agent-session` 规划（pi RPC + 流式 + 决策卡片 + 最小权限）。
**真机待验（G2）**：真实 `pi` 生成 + 微信草稿推送 + 封面/manim + 浏览器手工加载 workbench（需 250 主机）。
**推进顺序**：C1 ✅ → C2 ✅ → C3 ✅ → C4 → C5 → C6（C4 与 C2 均只依赖 C1，可并行；C3 依赖 C2；C6 依赖 C1–C5）。

### 上一子任务（控制台）· C2 调度与任务模型（M2a）

| # | 步骤 | 状态 | 证据 |
|---|------|------|------|
| I2-1..I2-7 | `src/console/jobs/{types,plans,queue,worker,scheduler}.ts`（886 行）+ 路由 + `main.ts` 生命周期 | ✅ | `archive/2026-10/10-13-console-scheduler/implement.md` §6 证据索引 |
| AC-5 | 任务状态机 `queued→running→{succeeded,failed,canceled}` + 每账号互斥 + 取消 | ✅ | 单测 **35 passed / 0 failed**（`/tmp/wfc-c2-jobs.ts`）；e2e `failed + error='no plan entry…'`、cancel 200/409 |
| AC-11 | 失败必显形（`status='failed'` + 非空 `error`），绝不伪装成功 | ✅ | `kind=plan` 实测 `status=failed`、`err='planner agent failed: timeout'` |
| AC-10 | 零新增运行时依赖 / tsc / bun build | ✅ | `dependencies=undefined`、`tsc --noEmit` 0 错、`bun build` OK |
| 调度 | `Asia/Shanghai` 到期推导 + 去重 + 启动即 tick | ✅ | 调度 e2e：1 条 publish（`actor=scheduler`）、再 tick 仍 1 |
| 迁移 | 计划文件→DB 桥（DB 优先）+ systemd timer 停用/回退脚本 | ✅ | `fillMissingPlansFromFiles` 3 项单测；D3 集成实测「仅文件计划 → 自动入队 publish」；脚本 `bash -n` + `--dry-run` 幂等 |
| 独立复核 | trellis-check | ✅ | `check-report.md`（PASS-with-issues；直接修 2 项；D1–D8 中 D3/D4/D7 本轮已修） |
| 发布链路 | engine 零改动 | ✅ | `git status --porcelain src/ \| grep -v src/console/` 为空 |
| spec | 校准 console spec v1→v2 + `design.md` 补 I13 | ✅ | `.trellis/spec/console/{index,api,data-model,security}.md` |

**下一步**：C4 `console-agent-session` 规划（pi RPC + 流式 + 决策卡片 + 最小权限）。
**推进顺序**：C1 ✅ → C2 ✅ → C3 ✅ → C4 → C5 → C6（C4 与 C2 均只依赖 C1，可并行；C3 依赖 C2；C6 依赖 C1–C5）。

### 上一子任务（控制台）· C1 基座收口（M1）

| # | 步骤 | 状态 | 证据 |
|---|------|------|------|
| I1-1..I1-10 | 服务骨架/DB/加密/鉴权RBAC/DAO/resolveConfig/导入回渲染/UI/校验/回归 | ✅ | `archive/2026-10/10-13-console-foundation/implement.md` §6 证据索引 |
| AC-1/2/4 | fail-fast / 导入 / 鉴权RBAC+CSRF+审计 | ✅ | curl 断言 17+9 项全过；`--status`、审计 `denied` 行 |
| AC-3 | DB 派生 == 文件派生（逐字段）+ 回渲染 diff=0 | ✅ | `--verify-ac3` PASS；`loadConfig` before/after 字节一致 |
| AC-10 | 零新增运行时依赖 / tsc / bun build | ✅ | `dependencies=undefined`、`tsc --noEmit` 0 错、`bun build` OK |
| 独立复核 | trellis-check | ✅ | `check-report.md`（PASS；5 项缺陷已修并回归） |
| 迁移期兼容 | engine 未回退 | ✅ | `doctor --all` / `publish --dry-run` 均可用 |
| spec | 校准 console spec v0→v1 | ✅ | `.trellis/spec/console/{index,api,data-model,security}.md` |

**下一步**：C4 `console-agent-session` 规划。
**推进顺序**：C1 ✅ → C2 ✅ → C3 ✅ → C4 → C5 → C6。

### 上一阶段（引擎 S10）

| # | 步骤 | 状态 | 证据 |
|---|------|------|------|
| R1 | 调研：上游 browser 路径是否支持封面 | ✅ | `research.md` §1：`SKILL.md` Feature Comparison 明示 `Article(Browser)` 的 cover 为 ✗ |
| R2 | 摸清 API 路径的封面机制 | ✅ | `wechat-api.ts`：`--cover` → `uploadImage(...,"material")` → `thumb_media_id` |
| R3 | 找可复用技术（CDP 文件注入） | ✅ | `wechat-article.ts:688-693` `DOM.setFileInputFiles` |
| R4 | **用户选定方案（G5）** | ✅ | 选定 **O-B**：CDP 驱动编辑器封面弹窗（不动 API/白名单） |
| I1 | 设计文档 | ✅ | `design.md`（流程/阶段/失败降级/回滚） |
| I2 | `setDraftCover` / `probeDraftCover` | ✅ | `src/wechat.ts` 导出两函数；失败返回 `{ok:false,stage,detail}`，绝不抛 |
| I3 | 配置开关 `cover.uploadToDraft`（默认 false） | ✅ | `src/config.ts` + `config.example.json` |
| I4 | 发布流程集成（正文校验后、失败降级） | ✅ | `src/publisher.ts`（try/catch，不改成功判定） |
| I5 | CLI `cover`（含 `--probe`） | ✅ | `src/cli.ts` + `USAGE` |
| I6 | 静态验证 | ✅ | `bun build` 通过；`bunx tsc --noEmit` 0 错误（devDeps 已装） |
| V1 | **250 真机验收** | ✅ | 成功：`cover` → `draft cover set ✓` + `--probe` 复读真实 bg（持久化）；完整发布 + 降级（非法图 / CDP 超时）均实测。证据见 `implement.md` §验证 |

**上一任务（S9 上下文治理）**：✅ 已交付并经用户确认 → `archive/2026-10/10-12-context-governance/`

**Checkpoint（下次开工先看这里）**
- **C4 已完成（S15/M3，2026-10-14）**：`pi --mode rpc` 会话窗口在 `src/console/agent/**`（`frames`/`rpc`/`events`/`manager`）+ `db/dao/chats.ts` + `http/chat-sse.ts` + `ui/chat.*`。关键点：**严格 JSONL**（只按 `\n` 切、禁 readline）；命令按 `id` 关联、`prompt` 流式带 `streamingBehavior:"steer"`、`disposition==="handled"` 不等 `agent_settled`；进程内 `ChatBus`（500 环、`seq`=`SSE id:`、`Last-Event-ID` 重放、落后发 `chat.resync`）；决策 `pending→{answered,cancelled,expired,lost}`，**预期关闭（TTL/删除/退出）与异常退出都必须把 pending 与会话状态在同一事务清算**（`chats.closeChatSession`/`markChatLost`，I21/I23）——否则悬挂（B1 教训）；双层最小权限（`--tools read,grep,find,ls,console_ask` + `console-decision.ts` fail-safe 硬阻断 `wechat*/publish*/mail*/backup*`，无放开开关）；`CONSOLE_CHAT_MAX`=3、`CONSOLE_CHAT_TTL_MS`=30min、`CONSOLE_PI_BIN` 可注入 fake-pi。engine 零改动。
- **C3 已完成（S14/M2b，2026-10-14）**：内容工作台在 `src/console/content/generate.ts` + `db/dao/articles.ts` + `http/sse.ts` + `ui/workbench.*`；engine `src/publisher.ts` 抽出 `runArticleGeneration`/`buildArticlePrompt`（空反馈 **字节一致**），`runPublish` 调用它——**推送路径/成功判定未变**。
- **版本链（I15–I18）**：engine base（`<date>-<slug>.md`）恒=**最新**（发布读它）；每版快照 `<base>.v<N>.md` **不可变**；`articles` 每版一行（`version` 单调、`parent_id` 链、v1=NULL）；`drafts.verified` **仅镜像** `runPublish.ok`（`verifyDetail = res.error ?? "ok"`），UI 绝不自判。生成失败 → **不落行** + job `failed` + 非空 `error`。
- **SSE（D18）**：`GET /api/jobs/:id/stream`；事件 `job.progress`/`job.log`（`id:`=`job_logs.id`）/`job.done`；15s `: ping`；终态关流；`Last-Event-ID` 续传不重不漏；`serve` 的 `idleTimeout=120`（默认 10s 会断流）。
- **C3 路由**：`GET /api/accounts/:id/articles`、`GET /api/articles/:id`（+`/cover`）、`POST /api/articles/:id/regenerate`、`POST /api/accounts/:id/articles/generate`、`GET /api/jobs/:id/stream`；`POST /jobs` 已开放 `generate`/`regenerate`。
- **C2 已完成并归档（S13/M2a）**：调度与任务模型在 `src/console/jobs/**`（`types`/`plans`/`queue`/`worker`/`scheduler`，886 行）。`main.ts` 默认 `serve`=HTTP+调度+worker；`--no-worker` 只 HTTP；`--worker` 无头只调度+执行。
- **任务模型**：`jobs.status∈{queued,running,succeeded,failed,canceled}`；**每账号 ≤1 个 `running`**（SQL `NOT EXISTS` + 进程内 Set 双保险）；认领/终结/取消均为条件 UPDATE（终态不可再迁移）；重启 `reap` 遗留 `running` → `failed('interrupted by restart')`。全局并发 `CONSOLE_MAX_CONCURRENCY`（默认 2）。
- **调度到期推导**（无新列）：publish = 当天在 `plans` 内 && `hour≥publishHour` && 未发布（engine `state/published.json` 优先）&& 无 live job；plan = `weekday===planWeekday` && 本周无 DB 计划 && 无 live plan job。时区固定 `Asia/Shanghai`；`settings.schedule={enabled,publishHour,planWeekday,tickSec}`。
- **计划真源（I13）**：`plans` 表为唯一真源 → `materializePlans` 原子物化 `data/<alias>/plans/<week>.json`；反向 `fillMissingPlansFromFiles`（**仅 DB 缺该周时采纳，故控制台编辑永不被回灌**）与 `importPlansFromFiles`（plan 任务后，跳过 `*.dryrun.json`）。
- **迁移**：systemd timer 停用（`deploy/systemd/disable-timer.sh`，不删 unit、可 `enable-timer.sh` 回退）；说明 `deploy/console-scheduler.md`。
- **下一步**：C5 `console-ops-tunnel` 规划（邮箱 + CF 隧道地址下发 + 凭据加密 + 管理员全局视图，G7）。复现证据：C4 `cat .trellis/tasks/archive/2026-10/10-13-console-agent-session/{prd,design,implement,check-report}.md`；C3/C2/C1 同上目录。
- **两条数据脉络**：① 配置真相源 = DB（`settings(global)` + `accounts.overrides_json` **逐字节 verbatim**）→ 回渲染 `config.json`；回渲染 = `.bak`(不覆盖) + tmp→fsync→rename。② 账号热列（`cdp_port`/`enabled`…）仅为约束/查询镜像，由单一写路径同步。
- **关键不变量**：`alias`/`cdp_port` 唯一（API 409 + 端口建议）；owner 仅 `account_grants` 账号且**看不到 global 机密**；无 master key / 无管理员 → fail-fast 拒绝启动；写请求必须 CSRF。
- **坑**：`.gitignore` 的 `console/` 必须写成 `/console/`（否则会吞掉 `src/console/`）；引擎 `model` 回退是**按嵌套 kind**，`cover`/`math` 是**整对象**回退，`null` 等价缺失（继承）。
- **C6 遗留项（历史记录；C6 D31/D33 已处理）**：C2 —— 计划 job 持续失败无退避（D2，**C6 D31 已加预算+冷却**）、调度只认 DB 计划（已加文件桥，D3）；C4 —— `chat-sse.ts` 重放阶段 cleanup 为 no-op（N1）、`ChatBus.close` 不主动通知已建 SSE 流（N2）、已 aborted 的 `signal` 不触发清理（N3）——**三项 C6 D33 已修**。
- 若上下文过长：按 §6 规则把新进展写回本节 → `/clear` → 重读本文件 §5 继续。

---

## 6. 打勾 / 证据规则（防幻觉）

- 完成任务后：把**产物路径**或**真实命令输出**写进 §1 / §5，并在 §9 追加一行。
- **没有产物、没有真实输出 → 不得标记完成。**
- 关键结论写成「文件路径 + 命令 + 输出摘要（贴数字）」。
- 需求变更先改对应 task 的 `prd.md`，再改代码/文档。
- 上下文清理协议（增量上下文）：一个子任务结束 → 写 Checkpoint → **清空会话** → 新会话只读 `AGENT.md` §5 继续。

---

## 7. 常用命令

```bash
# —— 续接 / 任务 ——
python3 .trellis/scripts/task.py list                    # 所有任务与状态
python3 .trellis/scripts/task.py current --source        # 当前活动任务
python3 .trellis/scripts/get_context.py --mode packages  # 规范层（engine）
cat .trellis/tasks/<task>/prd.md                          # 某任务需求

# —— 上下文索引 ——
bash tools/repomap.sh                                    # 刷新 TREE.md
bash tools/repomap.sh --check                            # 是否需刷新（CI/自检）

# —— 引擎（本机需 bun；目标机见 README/操作手册）——
bun build --target=bun src/cli.ts >/dev/null             # 语法/转译检查（零依赖）
bun src/cli.ts doctor --all                              # 环境自检
bun src/cli.ts publish --dry-run                         # 只生成不发布
bun src/cli.ts drafts --date 2026-10-12                  # 草稿箱 + 正文校验
```

> 目标机（250）标准姿势与全部命令见 `操作手册.md` §2。**不要**在此臆造命令。

---

## 8. 关键决策记录（ADR 摘要）

| # | 决策 | 理由 | 状态 |
|---|------|------|------|
| D1 | 发布用**浏览器 CDP**，不用微信 API | API 受 IP 白名单限制且家庭 IP 会变 | ✅ 实测 |
| D2 | **唯一真相源 = 草稿箱真实 DOM**（`verifyDraftBody`） | 空正文事故：skill 自检是假阳性 | ✅ 实测 |
| D3 | **AI 只做内容，其余确定性** | 可复现/可重跑/可自动验收 | ✅ 铁律 |
| D4 | 内容与提示词**真源在本地仓库** | diff/回溯/换机/多账号扩展 | ✅ 已确认 |
| D5 | 多账号隔离 = 独立 `dataDir` + **唯一 `cdpPort`** | 共用端口会串号且不报错 | ✅ 实测 |
| D6 | skill 补丁**自适应**（上游已修则 no-op） | 不重复维护上游已修的东西 | ✅ 实测 |
| D7 | **systemd timer 是唯一触发器**，无常驻进程 | 简单、可审计、错过后补跑 | ✅ 实测 |
| D8 | 上下文治理：`.trellis` + `AGENT.md` + 分层文档 + repomap | 降 Token、防幻觉、可续接 | ✅ 已交付 |
| D9 | runtime **零依赖**；repomap 用脚本而非引入工具 | 部署机简单、易维护 | ✅ |
| D10 | 封面走 **CDP 驱动编辑器弹窗**（O-B），不走 API | API 受 IP 白名单限制（同 D1）；封面属确定性产物，失败必须降级、不阻断发布 | ✅ 真机验收通过（2026-10-13） |
| D11 | 控制台独立成层 `src/console/`，**engine 不反向依赖**；运行时仍**零依赖**（`Bun.serve`/`bun:sqlite`/`node:crypto`） | 控制面与发布面解耦；保持 AC-10 零依赖红线 | ✅ 已实现（C1） |
| D12 | **DB 为配置真相源**，`config.json` 降级为派生产物（原子回渲染 + AC-3 逐字段比对） | 支持「全局默认 ⊕ 单账号覆盖」与 UI 可见性；不改 engine `config.ts` 旧签名 | ✅ 已实现（C1） |
| D13 | 迁移期 **控制台调度接管，systemd timer 停用但保留回退**；每账号任务**串行**（cdpPort/profile 互斥） | 避免双触发重复发布；沿用多账号隔离不变量 | ✅ 已实现（C2；`deploy/systemd/{disable,enable}-timer.sh`） |
| D14 | Agent 会话用 `pi --mode rpc` 子进程 + **严格 JSONL**（只按 `\n` 切分，禁用 readline）+ 决策卡片人在环 + 最小权限 | 进程隔离、保持零依赖；控制在环审批、不放开权限 | ✅ 已实现（C4） |
| D15 | **调度器/worker 内嵌 `serve` 进程**（不再用 systemd timer）；计划真源 = `plans` 表，engine 计划文件为派生物；到期时刻由数据推导而非新列 | 一个进程易部署可观测；避免双触发；保留 timer 回退 | ✅ 已实现（C2） |
| D16 | 内容生成抽出 `runArticleGeneration(cfg,{date?,feedback?,reuse?})`（engine **附加式**重构，`runPublish` 调用它）；`feedback` 仅**追加** `## 修改要求（用户反馈）`，空反馈时 prompt **字节不变** | 控制台需「先出稿、再推送、可重生成」，但必须守住发布铁律与唯一真相源；纯抽取可回归比对 | ✅ 已实现（C3） |
| D17 | 版本链：engine base（`<date>-<slug>.md`）恒=最新；每版快照 `<base>.v<N>.md`（不可变）；`articles` 每版一行（`parent_id` 链）；推送结果由 `drafts.verified` 镜像 `verifyDraftBody` | 发布读 base 保持 engine 语义不变；历史可回滚可 diff；UI 绝不自判成功 | ✅ 已实现（C3） |
| D18 | SSE 用「同进程 + 无事件总线」的 ~700ms 轮询 `jobs`/`job_logs`，`id:`=`job_logs.id` 支持 `Last-Event-ID` 续传；Bun `serve` `idleTimeout:120` | 零依赖、崩溃可续；默认 10s idle 会切断 15s 心跳间隔的流 | ✅ 已实现（C3） |
| D19 | 会话事件用**进程内 EventBus**（`ChatBus`，500 条环形 + 单调 `seq`=`SSE id:`），DB 只存 `message_end` 权威消息 | 同进程零延迟、零依赖；断线 `Last-Event-ID` 重放、落后发 `chat.resync` | ✅ 已实现（C4） |
| D20 | 决策**终态不可逆**且**无悬挂**：`pending→{answered,cancelled,expired,lost}`；**任何**会话终止路径（异常 / 预期关闭 / 启动回收）都把 pending 与会话状态**同事务**清算 | AC-6「无悬挂」；分事务会在崩溃/中断留下可点的死卡片（B1） | ✅ 已实现（C4） |
| D21 | 最小权限**双层且不可放开**：CLI `--tools` 白名单 + 扩展 `pi.on("tool_call")` fail-safe 硬阻断 `wechat*/publish*/mail*/backup*` | R3.5；发布/外发能力绝不下放给会话，且不提供 `dangerouslyAllowAll` | ✅ 已实现（C4） |
| D22 | CF 隧道**只**映射回环控制台，构造期强校验 `host∈回环 ∧ port===CONSOLE_PORT ∧ port∉accounts.cdp_port`（**fail-fast**） | 误配把 CDP(9222) 暴露公网 = 远程接管 Chrome（T1/H8）；只校验主机不够（复核发现） | ✅ 已实现（C5） |
| D23 | 隧道**全局单例**（`tunnels` 无 `account_id`）；地址变更 = 单事务「插新 `up` + 旧 `up`/`down` → `expired`+`replaced_by=新 id`」（I24） | 一台机一个 quick tunnel；历史可追溯且全局至多一行 `up` | ✅ 已实现（C5） |
| D24 | 地址变更邮件按 `tunnels.id` 去重（`notified_at`）+ 失败重试封顶（`CONSOLE_TUNNEL_MAIL_MAX_ATTEMPTS`）后置 `detail` 停发（I26） | 地址抖动不得演变为邮件轰炸（T5） | ✅ 已实现（C5） |
| D25 | 发信**复用 engine `sendMail` + `email-sender` skill 共享 SMTP**，收件人覆盖为「该账号 `account_email` ∪ 管理员副本 `settings(global).notify.email.to`」；`smtp` kind 保留但**不参与发信**（D-C5-2/3/4，engine 零改动） | 不改 engine 发布/邮件链路；每账号接收邮箱动态可配 | ✅ 已实现（C5） |
| D26 | `secrets` 只存密文，API **永不回显明文/密文**（读仅 `{kind,configured,keyVersion,updatedAt}`）；`account_id IS NULL` 需显式判重（SQLite NULL 不参与 UNIQUE） | 凭据是最高风险资产（H7/K1） | ✅ 已实现（C5） |
| D27 | 服务注入 `createApp(state, chat?, ops?:{tunnel?})`；`ops.tunnel` 缺失 → 隧道路由 **503 `tunnel_unavailable`**（绝不 200 空） | 失败必须显形（H5/AC-11） | ✅ 已实现（C5） |
| D28 | cloudflared 托管：**Mode A（进程内，`CONSOLE_TUNNEL=1`）为唯一支持模式**；`cloudflared.service`（Mode B）**互斥**，启用即禁用 C5 `/api/tunnels` 与地址变更邮件 | C5 隧道为全局单例，双 spawn = 双隧道竞态（D23） | ✅ 已实现（C6；文档+单元警示） |
| D29 | API 限流 = 进程内令牌桶，仅 `/api/*`；key = 已登录 `userId` 否则客户端 IP（`CONSOLE_TRUST_CF=1` 时取 `CF-Connecting-IP`）；429 + `Retry-After`；`/health`/静态豁免；**不写审计** | 防公网爆破/放大；审计洪泛反成新风险 | ✅ 已实现（C6） |
| D30 | 备份 = `VACUUM INTO`（`main.ts --backup`）+ `data/`/`config.json`/`master.key` 打包；恢复 = 停服→校验→替换→启动，幂等且先快照现状 | 热拷贝 WAL 会损坏；恢复必须可回滚 | ✅ 已实现（C6） |
| D31 | 调度失败退避：`CONSOLE_JOB_MAX_ATTEMPTS`（默认 3，0=无限）+ `CONSOLE_JOB_RETRY_COOLDOWN_MIN`（默认 30，0=不退避），按 `(account,kind)` + 当日/期 key 统计 | 修复 C2 遗留的失败任务每分钟重试风暴 | ✅ 已实现（C6） |
| D32 | `/health` 收紧为安全子集 `{status,version,uptimeSec,db,tunnel}`（免鉴权，遵循 `{ok,data}` 信封） | 供监控/反代探活，不泄账号/队列 | ✅ 已实现（C6） |
| D33 | 修复 C4/C5 遗留 N1–N3（`ChatBus.close` 先广播后清监听、SSE cleanup 前置+abort 立即 done、前端收 `chat.closed`/`chat.lost` 关流） | 监听泄漏/终态不达 | ✅ 已实现（C6） |

---

## 9. 变更日志（最新在上）

| 日期 | 变更 | 作者 |
|------|------|------|
| 2026-10-14 | **控制台 C6 部署与加固交付并归档（S17/M5，第二阶段收官）**：新增 `src/console/http/ratelimit.ts`（令牌桶，109 行）与 `server.ts` 接入（仅 `/api/*`、429 `rate_limited` + `Retry-After`、不写审计、`/health`/静态豁免）；`/health` 收紧为 `{status,version,uptimeSec,db,tunnel}`（`tunnel` 优先最新 DB 状态）；`jobs/{queue,scheduler}.ts` 失败退避（`CONSOLE_JOB_MAX_ATTEMPTS`/`CONSOLE_JOB_RETRY_COOLDOWN_MIN`）；修复 C4/C5 遗留 N1–N3（SSE 监听泄漏 / `ChatBus.close` 未广播 / 已 abort 未清理 + 前端关流）；`main.ts` 加 `--backup`/`--restore-check`。新增 `deploy/`（systemd Mode A/B 互斥单元 + `install-console.sh` + `console-backup.sh`/`console-restore.sh` + `nginx-console.conf.example` + `console-deploy.md` + `console-acceptance.md`）与 `README.md`/`docs/操作手册.md` §10.5。验证：`bash /tmp/wfc-c6-verify.sh` → `pass=12 fail=0`；专项 38/23/20/20/17/37；`tsc` 0 错/`bun build` OK/零依赖/engine **零改动**；独立复核 **PASS-with-issues**（自写探针 51/0 + 聚合 12/0；F1/F2 已修、F3/F4 措辞已修）。console spec 校准 v5→v6（`ops-deploy.md` v1 + I29–I34）。真机（250/G6/G7）待验。 | pi |
| 2026-10-14 | **控制台 C5 运维与公网交付并归档（S16/M4）**：新增 `src/console/tunnel/cloudflared.ts`（`TunnelSupervisor`，462 行）、`src/console/notify/tunnel-mail.ts`（319 行）、`db/dao/{emails,secrets,tunnels}.ts`、`ui/admin.{html,js}`；`schema.ts` 加 migration v3（`tunnels.notified_at`/`notify_attempts`，纯加法）；`server.ts` 加 11 条路由 + `createApp(state,chat,ops?)`（`ops.tunnel` 缺失 → 503 `tunnel_unavailable`）；`main.ts` 接线（`CONSOLE_TUNNEL=1`）+ 关闭顺序 `scheduler→worker→chat→tunnel→server→db`。实现：spawn cloudflared 逐行解析（禁 readline）；单次健康失败即 `down`、退出码映射（0→`down`；≠0/signal→`error`+detail）、退避重启、地址去抖；地址变更按 `tunnels.id` 去重 + 重试封顶后停发；发信复用 engine `sendMail`+共享 SMTP，收件人=账号邮箱 ∪ 管理员副本（`notify.email.to`）；凭据 AES-256-GCM，API 只回元数据。**安全加固（复核发现）**：`TunnelSupervisor` 构造期强校验 `host∈回环 ∧ port===CONSOLE_PORT ∧ port∉accounts.cdp_port`，杜绝误配把 CDP(9222) 暴露公网（T1/I27）。验证：`bash /tmp/wfc-c5-verify.sh` → `pass=22 fail=0`；独立复核 **196/0**（两轮：首轮 1 高缺陷 → 修复 → 复审 PASS）；`tsc`/`bun build`/零依赖/engine **零改动**（`git diff --quiet` 4 文件）；C3 7/0、C4 8/0 回归。console spec 校准 v4→v5（`ops-tunnel.md` v1 + I24–I28）。真机（250/G2）真实 cloudflared + 真实发信 + 浏览器 `/admin` 待验。 | pi |
| 2026-10-14 | **控制台 C4 Agent 会话窗口与人在环交付并归档（S15/M3）**：新增 `src/console/agent/**`（`frames`/`rpc`/`events`/`manager` + `extensions/console-decision.ts`）、`db/dao/chats.ts`、`http/chat-sse.ts`、`ui/chat.{html,css,js}`；`schema.ts` 加 migration v2（`chat_sessions.session_file`，纯加法）；12 条复数路由 `/api/chats/*`、`/api/decisions`（CSRF + 按行 `account_id` 鉴权）。实现：`pi --mode rpc` 长活子进程 + 严格 JSONL 切帧（禁 readline）；按 `id` 关联命令、`prompt` 流式 `streamingBehavior:"steer"`；进程内 `ChatBus`（`seq`=`SSE id:`、`Last-Event-ID` 重放 + `chat.resync`）；`extension_ui_request` → 决策卡片，`pending→{answered,cancelled,expired,lost}`；**异常退出/预期关闭/启动回收均同事务清算 pending**（`closeChatSession`/`markChatLost`，I21/I23）；双层最小权限（`--tools read,grep,find,ls,console_ask` + 扩展硬阻断 `wechat*/publish*/mail*/backup*`，无放开开关）。验证：`tsc --noEmit` 0 错、`bun build` 49 modules、零依赖、engine **零改动**、单测 + fake-pi e2e + C3 回归全绿（`pass=8 fail=0`）；`trellis-check` 首轮 **FAIL**（唯一阻塞 **B1**：预期关闭未清算 pending）→ 修复（`closeChatSession` 同事务）→ 对抗复现 `PROBE(S) PASSED` + 复审 **PASS**。console spec 校准 v3→v4（`agent-session.md` v2、I19–I23）。真机（250/G2）流式/扩展/浏览器 `/chat` 待验。 | pi |
| 2026-10-14 | **控制台 C3 内容工作台交付（S14/M2b）**：engine **附加式**重构——`src/publisher.ts` 抽出 `runArticleGeneration`/`buildArticlePrompt`，`runPublish` 改为调用它；空 `feedback` 时 prompt **字节一致（3012B）**、`runPublish` 生成后区段 diff 与 HEAD 相同（发布铁律与 `verifyDraftBody` 未动）；新增 `src/console/content/generate.ts`（`snapshotVersion`/`generateArticle`/`recordDraftResult`）与 `db/dao/articles.ts`（版本链 DAO），`http/sse.ts`（零依赖 SSE：~700ms 轮询 + 15s 心跳 + `Last-Event-ID` 续传），`ui/workbench.{html,css,js}`（计划编辑/生成/推送/版本链/对比/反馈重生成/失败面板）；worker 真执行 `generate`/`regenerate`，publish 分支补写 `drafts`（`verified` **仅镜像** engine 判决，I18）+ `articles.status='pushed'`；新增 5 条路由并开放 `POST /jobs` 的 `generate`/`regenerate`；`main.ts` `serve` 加 `idleTimeout:120`（SSE 必需）。验证：30 项单测、HTTP e2e（401/403/CSRF、SSE 不重不漏）、失败路径 e2e、假 `pi` worker e2e、字节一致比对，`tsc`/`bun build`/零依赖全绿；`trellis-check` 独立复核 **PASS**（8/8 必验；4 项非阻塞观察）。真机（250/G2）的「真 `pi` 生成 + 草稿推送 + 封面 + 浏览器 UI」待验。console spec 校准 v2→v3（I15–I18、SSE §3） | pi |
| 2026-10-14 | **控制台 C2 调度与任务模型交付并归档（S13/M2a）**：新增 `src/console/jobs/**`（`types`/`plans`/`queue`/`worker`/`scheduler`，886 行）+ 7 条路由 + `main.ts` 生命周期（`serve` 内联调度、`--no-worker`、`--worker` 无头、SIGTERM 优雅退出）；新增 `deploy/console-scheduler.md` 与 `deploy/systemd/{disable,enable}-timer.sh`（不删 unit、可回退）；新增 `fillMissingPlansFromFiles` 迁移桥（**DB 优先**，控制台编辑不被文件回灌）。AC-5/AC-10/AC-11 实测：任务层单测 **35 passed/0 failed**、HTTP e2e（CSRF 403 / 400 / 401 / 403 / 201 / 409 全符合）、调度 e2e（启动即 tick → 1 条 publish，`actor=scheduler`，再 tick 仍 1）、失败必显形（`status=failed` + 非空 `error`）。`trellis-check` 独立复核 **PASS-with-issues**（无阻塞缺陷；直接修 1）死代码/未用导出 5 处、2）403 `denied` 审计 `actor` 改为请求局部——消除共享可变状态；本轮另修 D3/D4/D7：文件计划迁移桥、`worker.stop()` 有界 drain（`CONSOLE_WORKER_DRAIN_MS`）、`readSchedule` 布尔强校验 + 失败保留进度）。engine **零改动**；console spec 校准 v1→v2 并补 `design.md` I13（计划物化契约） | pi |
| 2026-10-13 | **控制台 C1 基座交付并归档（S12/M1）**：新增 `src/console/**`（`Bun.serve` + `bun:sqlite` WAL + argon2id 会话/CSRF/RBAC + 账号CRUD/配置覆盖/导入回渲染 + 静态 UI，**零新增运行时依赖**）；`src/config.ts` 仅新增 `resolveConfig(raw,alias)` 导出（`loadConfig` 行为不变）；`.gitignore` 增 `/console/`。AC-1/2/3/4/10 实测通过（`--verify-ac3` 逐字段一致、`loadConfig` 前后**字节一致**、17+9 项 curl 断言）；`trellis-check` 独立复核 **PASS**（5 项缺陷已修并回归：cdpPort 字符串绕过 UNIQUE / owner 详情泄露 global / 畸形 Cookie 500 / 不存在 grant id 的 FK 500 + 孤儿用户 / CSP·HSTS 缺失）；engine `doctor --all`/`publish --dry-run` 未回退；console spec 校准 v0→v1 | pi |
| 2026-10-13 | **控制台 M0 规划收口（S11）**：用户批准规划摘要；新建 `.trellis/spec/console/` 骨架（`index/api/data-model/security/agent-session`，v0 契约）；更新 `AGENT.md` —— §1 新增控制台路线 S11–S17、§2 新增 G6/G7、§3 补 6 个子任务、§8 补 D11–D14 | pi |
| 2026-10-13 | **跨环境交接约定落地**：新增 `.trellis/spec/guides/cross-env-handoff.md`（触发条件 / H1–H10 必含章节 / 证据与密钥边界 / 生命周期）；新增 `docs/handoffs/`（`TEMPLATE.md` + `README.md`），`docs/HANDOFF-CNB.md` 迁入为 `docs/handoffs/2026-10-13-cnb-console.md`（含基线 SHA 与失效条件）；AGENT.md §4、spec/guides/index.md 补入口 | pi |
| 2026-10-13 | **S10 真机验收通过 + 归档**：250 上 `cover` 成功设封面并在重开编辑器后 `--probe` 复读为真实 `mmbiz` 背景图（持久化）；`cover.uploadToDraft=true` 后 `publish --reuse --force` 正文 + 封面均 OK；降级路径（非法图 / CDP 超时）publish 仍成功且邮件提示手动选封面。真机修正：保存点 `#js_submit button`、确认后轮询背景图、上传后等自动选中、去掉缩略图兜底。任务归档。 | pi |
| 2026-10-13 | **S10 O-B 实现**：`setDraftCover`/`probeDraftCover`（`src/wechat.ts`）+ `cover` 命令 + `cover.uploadToDraft` 开关（默认关、失败降级）；装 devDeps 使 `tsc --noEmit` 通过；文档同步 | pi |
| 2026-10-12 | **S9 交付并归档**：`AGENT.md`/分层文档/repomap 经用户确认（G4）；任务归档 → `archive/2026-10/` | pi |
| 2026-10-12 | **S10 封面调研**：确认 skill v1.118.2 浏览器路径不支持封面（文档化限制）；产出 `research.md` + 候选 O-A/O-B/O-C；启动任务（待 G5） | pi |
| 2026-10-12 | **S9 上下文治理动工**：`trellis init`（`.pi`/`.agents`/`AGENTS.md`）；`spec/frontend`→`spec/engine`（5 篇真实约定）；新增 `AGENT.md`/`ARCHITECTURE.md`/`src/README.md`/`TREE.md`/`tools/repomap.sh`；建任务 `context-governance`、`cover-auto-upload`；归档 bootstrap | pi |
| 2026-10-12 | skill 升级到 **1.118.2**（上游原生修复空正文）；`patch-baoyu-skill.sh` 改为自适应；`doctor` 改查“正文写入能力” | pi |
| 2026-10-12 | 修复**空正文事故**：`verifyDraftBody()` 回查真实 DOM；`--force` 重发；失败写 `ok:false` + 告警 | pi |
| 2026-10-12 | `deploy.sh` 防呆：内容真源比对、`--force-content` 先备份、`${dry:+-n}` 默认预演 | pi |
| 2026-10-12 | 多账号上线：`data/<alias>/` 迁移、独立 CDP 端口（:9222/:9223）、别名校验 | pi |
| 2026-10-12 | 端到端实测：`plan` / `publish` / 冷启动发布 / 模型降级 / 草稿持久性 全通过 | pi |

---

## 10. 下一步（Next Actions）

1. **当前主线（控制台 S11+）**：C1 ✅ → C2 ✅ → C3 ✅ → C4 ✅ → C5 ✅ → **C6 ✅（已归档；父任务 6/6，第二阶段收官）**。下一步 = 真机（250）按 `deploy/console-acceptance.md` 跑 AC-1…AC-11，随后 G6/G7 请用户确认。见 §5。
2. **真机待验（G2，需 250）**：C3 —— 真 `pi` 生成、真实微信草稿推送（`✅ 正文校验`）、封面/manim、浏览器手工加载 workbench；C4 —— 真实 `pi` 流式、`pi --extension` 加载、浏览器 `/chat`（流式 + 决策卡片）。
3. **引擎侧已完成**：S0–S10 全部交付并归档（S10 见 §5「上一阶段」）。
4. **可选增强（非阻塞）**：repomap 升级为 AST 级符号图；`cover` 支持 `--all` 回填历史草稿；清理 250 上重复草稿（反复 `--force` 遗留）。
5. **日常运维**：按 `docs/操作手册.md` §5 做周与周衔接；每周五/日看 `status --all` 与 `drafts --all`。

---

## 11. 演进路线（上下文治理，参考 temp.md）

| 维度 | 现状（本方案） | 下一档（按需升级） |
|---|---|---|
| Token 消耗 | 极低（`AGENT.md` + `TREE.md` + `src/README.md` 分层按需） | 更低（AST repomap / 向量索引） |
| 维护成本 | 人工维护 `AGENT.md` + spec（脚本生成 `TREE.md`） | 自动生成符号图（`repomap.sh` 升级） |
| 控制力/精度 | 极强（硬约束 + 证据打勾 + GATE） | 极强 + 子代理 spec 注入（已具备 jsonl） |
| 适用 | 单人 + 单/多账号、中大型维护 | 多文件大重构时引入 AST 索引 |

> 原则：**不引入重工具**，除非脚本 grep 明显不够用。`.trellis/spec/**` + task 的 `implement.jsonl`/`check.jsonl`
> 已能在子代理场景自动注入上下文。
