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
| **S15** | 会话与人在环：pi RPC + 流式 + 决策卡片 + 最小权限 | M3 | C4 | 🟡 规划（下一步） | — | 子任务 `10-13-console-agent-session/` |
| **S15** | 会话与人在环：pi RPC + 流式 + 决策卡片 + 最小权限 | M3 | C4 | ⚪ 未开始 | — | 子任务 `10-13-console-agent-session/` |
| **S16** | 运维与公网：邮箱 + CF 隧道地址下发 + 凭据加密 + 管理员视图 | M4 | C5 | ⚪ 未开始 | G7 | 子任务 `10-13-console-ops-tunnel/` |
| **S17** | 部署与加固：systemd/反代/限流/备份/回归 | M5 | C6 | ⚪ 未开始 | G6/G7 | 子任务 `10-13-console-deploy-hardening/` |

---

## 2. 人工确认门（GATE）

| GATE | 位置 | 放行条件 | 状态 |
|------|------|----------|------|
| **G1** | 上线 250 | `doctor --all` 通过 + 端到端发布邮件送达 | ✅ 已放行（2026-10-12） |
| **G2** | 发布链路改动后 | 真机 `publish --force --reuse` → `drafts --date` 显示 `✅ 正文校验` | ✅ 已放行（2026-10-12，含空正文修复复验） |
| G3 | 内容真源策略变更 | 确认“本地仓库为真源”或改 `--keep-remote-content` | ✅ 已确认（本地为真源） |
| **G4** | 上下文治理交付 | 用户确认 `AGENT.md` + 分层文档 + `.trellis` 可用 | ✅ 已放行（2026-10-12） |
| **G5** | 封面自动化方案 | 用户选定 O-A / O-B 后再动发布链路 | ✅ 已选定 **O-B** 并经 **G2 真机验收通过**（2026-10-13） |
| **G6** | 控制台公网放行 | 强鉴权 + 限流锁定 + 审计 + 仅映射控制台端口（绝不暴露 CDP）+ 备份/回滚手册就绪；用户确认后才上线 | ⚪ 待放行（C6） |
| **G7** | 凭据加密与隧道放行 | AES-256-GCM fail-fast + 不回显明文 + CF Quick Tunnel 地址订阅邮件可用；用户确认 | ⚪ 待放行（C5/C6） |

---

## 3. 任务地图（`.trellis/tasks/`）

| 任务目录 | 对应 Stage | 说明 | 状态 |
|----------|-----------|------|------|
| `archive/2026-10/10-12-cover-auto-upload/` | S10 | 封面自动上传 O-B（真机验收通过） | ✅ 已归档 |
| `archive/2026-10/10-12-context-governance/` | S9 | 上下文治理（已交付） | ✅ 已归档 |
| `archive/2026-10/00-bootstrap-guidelines/` | — | 填充 `spec/engine/` 的初始化任务 | ✅ 已归档 |
| `10-13-cross-env-handoff/` | —（规范治理） | 跨环境交接约定 + 模板 + 交接稿归档 | ✅ 已交付（2026-10-13） |
| `10-13-wechat-flow-console/` | S11+ | 控制台父任务（需求集 + AC-1..AC-11 + 任务地图） | 🟡 进行中（M1 已收口） |
| `archive/2026-10/10-13-console-foundation/` | S12 | C1 控制台基座（服务/DB/鉴权/RBAC/配置继承/迁移） | ✅ 已归档（2026-10-13） |
| `archive/2026-10/10-13-console-scheduler/` | S13 | C2 调度与任务模型（plans/jobs/queue/worker/scheduler + timer 迁移脚本） | ✅ 已归档（2026-10-14） |
| `10-13-console-content-workbench/` | S14 | C3 内容工作台 | ✅ 已交付（2026-10-14） |
| `10-13-console-agent-session/` | S15 | C4 Agent 会话与人在环 | ⚪ 规划（下一步） |
| `10-13-console-ops-tunnel/` | S16 | C5 运维与公网 | ⚪ 规划 |
| `10-13-console-deploy-hardening/` | S17 | C6 部署与加固 | ⚪ 规划 |

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

**当前任务**：**控制台 C2 `console-scheduler` 已完成并归档 → 下一步 C3 `console-content-workbench` 规划**（父任务 `10-13-wechat-flow-console`，阶段 S11+）。

### 当前（控制台）· C3 内容工作台（M2b）

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
- **C3 已完成（S14/M2b，2026-10-14）**：内容工作台在 `src/console/content/generate.ts` + `db/dao/articles.ts` + `http/sse.ts` + `ui/workbench.*`；engine `src/publisher.ts` 抽出 `runArticleGeneration`/`buildArticlePrompt`（空反馈 **字节一致**），`runPublish` 调用它——**推送路径/成功判定未变**。
- **版本链（I15–I18）**：engine base（`<date>-<slug>.md`）恒=**最新**（发布读它）；每版快照 `<base>.v<N>.md` **不可变**；`articles` 每版一行（`version` 单调、`parent_id` 链、v1=NULL）；`drafts.verified` **仅镜像** `runPublish.ok`（`verifyDetail = res.error ?? "ok"`），UI 绝不自判。生成失败 → **不落行** + job `failed` + 非空 `error`。
- **SSE（D18）**：`GET /api/jobs/:id/stream`；事件 `job.progress`/`job.log`（`id:`=`job_logs.id`）/`job.done`；15s `: ping`；终态关流；`Last-Event-ID` 续传不重不漏；`serve` 的 `idleTimeout=120`（默认 10s 会断流）。
- **C3 路由**：`GET /api/accounts/:id/articles`、`GET /api/articles/:id`（+`/cover`）、`POST /api/articles/:id/regenerate`、`POST /api/accounts/:id/articles/generate`、`GET /api/jobs/:id/stream`；`POST /jobs` 已开放 `generate`/`regenerate`。
- **C2 已完成并归档（S13/M2a）**：调度与任务模型在 `src/console/jobs/**`（`types`/`plans`/`queue`/`worker`/`scheduler`，886 行）。`main.ts` 默认 `serve`=HTTP+调度+worker；`--no-worker` 只 HTTP；`--worker` 无头只调度+执行。
- **任务模型**：`jobs.status∈{queued,running,succeeded,failed,canceled}`；**每账号 ≤1 个 `running`**（SQL `NOT EXISTS` + 进程内 Set 双保险）；认领/终结/取消均为条件 UPDATE（终态不可再迁移）；重启 `reap` 遗留 `running` → `failed('interrupted by restart')`。全局并发 `CONSOLE_MAX_CONCURRENCY`（默认 2）。
- **调度到期推导**（无新列）：publish = 当天在 `plans` 内 && `hour≥publishHour` && 未发布（engine `state/published.json` 优先）&& 无 live job；plan = `weekday===planWeekday` && 本周无 DB 计划 && 无 live plan job。时区固定 `Asia/Shanghai`；`settings.schedule={enabled,publishHour,planWeekday,tickSec}`。
- **计划真源（I13）**：`plans` 表为唯一真源 → `materializePlans` 原子物化 `data/<alias>/plans/<week>.json`；反向 `fillMissingPlansFromFiles`（**仅 DB 缺该周时采纳，故控制台编辑永不被回灌**）与 `importPlansFromFiles`（plan 任务后，跳过 `*.dryrun.json`）。
- **迁移**：systemd timer 停用（`deploy/systemd/disable-timer.sh`，不删 unit、可 `enable-timer.sh` 回退）；说明 `deploy/console-scheduler.md`。
- **下一步**：C4 `console-agent-session` 规划（pi RPC + 严格 JSONL 流式 + 决策卡片 + 最小权限）。复现证据：C3 `cat .trellis/tasks/archive/2026-10/10-13-console-content-workbench/{prd,design,implement}.md`、`check-report.md`；C2/C1 同上目录。
- **两条数据脉络**：① 配置真相源 = DB（`settings(global)` + `accounts.overrides_json` **逐字节 verbatim**）→ 回渲染 `config.json`；回渲染 = `.bak`(不覆盖) + tmp→fsync→rename。② 账号热列（`cdp_port`/`enabled`…）仅为约束/查询镜像，由单一写路径同步。
- **关键不变量**：`alias`/`cdp_port` 唯一（API 409 + 端口建议）；owner 仅 `account_grants` 账号且**看不到 global 机密**；无 master key / 无管理员 → fail-fast 拒绝启动；写请求必须 CSRF。
- **坑**：`.gitignore` 的 `console/` 必须写成 `/console/`（否则会吞掉 `src/console/`）；引擎 `model` 回退是**按嵌套 kind**，`cover`/`math` 是**整对象**回退，`null` 等价缺失（继承）。
- **C6 待办（C2 遗留，非阻塞）**：计划 job 持续失败无退避（默认 tick 60s 会重试，D2）；调度只认 DB 计划（已加文件桥缓解，D3）。
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
| D14 | Agent 会话用 `pi --mode rpc` 子进程 + **严格 JSONL**（只按 `\n` 切分，禁用 readline）+ 决策卡片人在环 + 最小权限 | 进程隔离、保持零依赖；控制在环审批、不放开权限 | 🟡 规划（C4） |
| D15 | **调度器/worker 内嵌 `serve` 进程**（不再用 systemd timer）；计划真源 = `plans` 表，engine 计划文件为派生物；到期时刻由数据推导而非新列 | 一个进程易部署可观测；避免双触发；保留 timer 回退 | ✅ 已实现（C2） |
| D16 | 内容生成抽出 `runArticleGeneration(cfg,{date?,feedback?,reuse?})`（engine **附加式**重构，`runPublish` 调用它）；`feedback` 仅**追加** `## 修改要求（用户反馈）`，空反馈时 prompt **字节不变** | 控制台需「先出稿、再推送、可重生成」，但必须守住发布铁律与唯一真相源；纯抽取可回归比对 | ✅ 已实现（C3） |
| D17 | 版本链：engine base（`<date>-<slug>.md`）恒=最新；每版快照 `<base>.v<N>.md`（不可变）；`articles` 每版一行（`parent_id` 链）；推送结果由 `drafts.verified` 镜像 `verifyDraftBody` | 发布读 base 保持 engine 语义不变；历史可回滚可 diff；UI 绝不自判成功 | ✅ 已实现（C3） |
| D18 | SSE 用「同进程 + 无事件总线」的 ~700ms 轮询 `jobs`/`job_logs`，`id:`=`job_logs.id` 支持 `Last-Event-ID` 续传；Bun `serve` `idleTimeout:120` | 零依赖、崩溃可续；默认 10s idle 会切断 15s 心跳间隔的流 | ✅ 已实现（C3） |

---

## 9. 变更日志（最新在上）

| 日期 | 变更 | 作者 |
|------|------|------|
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

1. **当前主线（控制台 S11+）**：C1 ✅ → C2 ✅ → C3 ✅ → 规划并实施 **C4 `console-agent-session`**（pi RPC 子进程 + 严格 JSONL 流式 + 决策卡片人在环 + 最小权限），随后 C5 → C6。见 §5 与父任务 `implement.md`。
2. **C3 真机待验（G2，需 250）**：真 `pi` 生成、真实微信草稿推送（`✅ 正文校验`）、封面/manim、浏览器手工加载 workbench。
2. **引擎侧已完成**：S0–S10 全部交付并归档（S10 见 §5「上一阶段」）。
3. **可选增强（非阻塞）**：repomap 升级为 AST 级符号图；`cover` 支持 `--all` 回填历史草稿；清理 250 上重复草稿（反复 `--force` 遗留）。
4. **日常运维**：按 `docs/操作手册.md` §5 做周与周衔接；每周五/日看 `status --all` 与 `drafts --all`。

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
