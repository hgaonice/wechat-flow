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

---

## 2. 人工确认门（GATE）

| GATE | 位置 | 放行条件 | 状态 |
|------|------|----------|------|
| **G1** | 上线 250 | `doctor --all` 通过 + 端到端发布邮件送达 | ✅ 已放行（2026-10-12） |
| **G2** | 发布链路改动后 | 真机 `publish --force --reuse` → `drafts --date` 显示 `✅ 正文校验` | ✅ 已放行（2026-10-12，含空正文修复复验） |
| G3 | 内容真源策略变更 | 确认“本地仓库为真源”或改 `--keep-remote-content` | ✅ 已确认（本地为真源） |
| **G4** | 上下文治理交付 | 用户确认 `AGENT.md` + 分层文档 + `.trellis` 可用 | ✅ 已放行（2026-10-12） |
| **G5** | 封面自动化方案 | 用户选定 O-A / O-B 后再动发布链路 | ✅ 已选定 **O-B** 并经 **G2 真机验收通过**（2026-10-13） |

---

## 3. 任务地图（`.trellis/tasks/`）

| 任务目录 | 对应 Stage | 说明 | 状态 |
|----------|-----------|------|------|
| `archive/2026-10/10-12-cover-auto-upload/` | S10 | 封面自动上传 O-B（真机验收通过） | ✅ 已归档 |
| `archive/2026-10/10-12-context-governance/` | S9 | 上下文治理（已交付） | ✅ 已归档 |
| `archive/2026-10/00-bootstrap-guidelines/` | — | 填充 `spec/engine/` 的初始化任务 | ✅ 已归档 |

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
| 怎么安装/部署 | [`README.md`](./README.md)（按节） | 大 |
| 日常操作/维护/排障 | [`docs/操作手册.md`](./docs/操作手册.md)（按节） | 大 |

> 原则：**能读 3KB 就不读 30KB。**`TREE.md` 由 `bash tools/repomap.sh` 生成，改代码后请刷新。

---

## 5. 当前任务 + Checkpoint

**当前任务**：无（S10 已交付并归档）。下一个任务见 §3 / `task.py list`。

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
- **S10 已完成**：O-B 封面自动上传在 250 真机验收通过（成功 + 降级双路径）。用法：`config.json` 开 `cover.uploadToDraft:true`（默认关）；发布在正文校验通过后，用同一 CDP 会话驱动封面弹窗上传 `cover.png`；失败只 warn，绝不影响正文。
- **真机要点**：保存点 `#js_submit button`（非容器）；`确认` 后须**轮询**背景图变化；上传后须等**自动选中**再点 `下一步`；**不做缩略图兜底**（避免误设旧图）。
- **无待办阻塞**。下一步候选见 §10。
- 若上下文过长：按 §6 规则把新进展写回本节 → `/clear` → 重读本文件 §5 继续。
- 复现：`cat .trellis/tasks/archive/2026-10/10-12-cover-auto-upload/{design.md,implement.md}`、`python3 .trellis/scripts/task.py list`。

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

---

## 9. 变更日志（最新在上）

| 日期 | 变更 | 作者 |
|------|------|------|
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

1. **S10 已完成并归档**：成功 + 降级双路径均过 G2；选择器已固化进 `src/wechat.ts`；验收步骤见 [`deploy/ACCEPTANCE-250.md`](./deploy/ACCEPTANCE-250.md)。
2. **可选增强**：repomap 升级为 AST 级符号图；`cover` 支持 `--all` 回填历史草稿；清理 250 上重复草稿（反复 `--force` 遗留）。
3. **日常运维**：按 `docs/操作手册.md` §5 做周与周衔接；每周五/日看 `status --all` 与 `drafts --all`。

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
