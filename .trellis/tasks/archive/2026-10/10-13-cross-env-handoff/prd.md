# 跨环境交接约定沉淀（cross-env-handoff）

> 轻量任务：**PRD + implement 清单**，无 `design.md`（无生产代码与数据模型变更，纯规范与文档）。
> 来源：用户 2026-10-13 需求——"把这套『跨环境交接』沉淀成 `.trellis/spec/` 约定或轻量 task"。

---

## Goal

把本项目已经在用的**跨环境 / 跨 Agent 交接**做法（本地 pi ↔ CNB Agent、跨机器续接、跨会话续接）
从「一次性的聊天文本」升级为**仓库内的可执行约定**：

1. 写进 `.trellis/spec/`，使任何接手 Agent 在开工前就能读到「交接稿该怎么写、必须含什么、什么不能写」；
2. 提供**可直接复制的交接模板**，避免每次从零起草；
3. 建立**交接稿归档目录**，把本次生成的 CNB 全量开发交接稿落入其中，形成可追溯的交接历史。

**非目标**：不引入交接自动化脚本（如自动生成 prompt）；不改动 `src/` 引擎与发布链路；不新增运行时依赖。

---

## 背景与已确认事实

- 现状：`AGENT.md` 已是「项目唯一续接入口」，解决了**同仓同环境**的续接；但**换环境**（换 Agent / 换机器 / 换平台，如本地 → CNB）时，
  交接内容仍靠临时起草，存在三类风险：
  1. **缺项**：漏掉 GATE、密钥边界、环境差异（如 `config.json` / `data/` / master key 不在仓库），接手方误判或误提交密钥；
  2. **口径漂移**：脱离 `AGENT.md` / task 结构另起一套说法，导致与真实进度看板不一致；
  3. **不可追溯**：交接文本散落聊天记录，事后无法复盘"当时交接了什么、对方按哪版执行"。
- 已存在的事实基线：`docs/HANDOFF-CNB.md`（2026-10-13 生成，尚未纳入任何目录约定）。
- `.trellis/spec/` 现有层：`engine/`（代码规范）+ `guides/`（技术无关思维指南）→ **本约定属 `guides/`**（与语言/框架无关的协作约定）。

---

## Requirements

- **R1 约定（spec）**：新增 `.trellis/spec/guides/cross-env-handoff.md`，必须定义：
  - R1.1 **触发条件**：何时必须写交接稿（换 Agent / 换环境 / 换机器 / 长任务分段 / 需要对方独立开工）。
  - R1.2 **必含章节清单**：仓库与环境基线、续接读取顺序与读取上限、铁律与硬约束、GATE 与真机门、
    待办与依赖顺序（对齐 `.trellis/tasks/`）、汇报格式与证据规则、Git 约定、开工第一步。
  - R1.3 **证据与密钥边界**：哪些内容**禁止**写入交接稿（明文凭据、token、master key、`~/.git-credentials`），
    以及接收方需要密钥时的正确索取路径。
  - R1.4 **口径原则**：交接稿是 `AGENT.md` 的**投影**而非替代；`AGENT.md` 与 task 目录始终是状态真相源。
  - R1.5 **生命周期**：交接稿生成 → 归档 → 任务完成后是否失效/如何标记（避免过期交接稿被继续执行）。
- **R2 模板**：新增 `docs/handoffs/TEMPLATE.md`，章节与 R1.2 逐条对应，占位符可填空，可直接整段复制粘贴。
- **R3 归档目录**：新增 `docs/handoffs/README.md` 说明用途、命名约定（`YYYY-MM-DD-<用途>.md`）与生命周期；
  把 `docs/HANDOFF-CNB.md` **迁移**为 `docs/handoffs/2026-10-13-cnb-console.md`（不留重复来源）。
- **R4 索引可达**：`.trellis/spec/guides/index.md` 与 `AGENT.md`（§4 上下文分层索引）均给出指向该约定的入口；
  `AGENT.md` §3 任务地图 / §9 变更日志同步本次改动。
- **R5 约束**：不新增运行时依赖；不改 `src/`；不改 `package.json` 的 `dependencies`。

---

## Acceptance Criteria

- **AC-1（约定可执行）** `.trellis/spec/guides/cross-env-handoff.md` 存在且 R1.1–R1.5 五项均可定位；**无占位符/空章节**（`grep -n 'TODO\|TBD\|<.*>'` 无命中除模板代码块外）。
- **AC-2（模板可用）** `docs/handoffs/TEMPLATE.md` 的章节集合与 spec R1.2 清单**逐项对应**，可直接复制使用。
- **AC-3（归档就位且无重复）** `docs/handoffs/2026-10-13-cnb-console.md` 存在；
  `docs/HANDOFF-CNB.md` **不再存在**（`test ! -e docs/HANDOFF-CNB.md`）。
- **AC-4（索引可达）** `AGENT.md` 与 `.trellis/spec/guides/index.md` 均含指向该 spec / `docs/handoffs/` 的链接；
  链接目标路径逐一存在（用命令验证，不靠肉眼）。
- **AC-5（不动引擎）** `bun build --target=bun src/cli.ts` 与 `bunx tsc --noEmit` 仍零错误。
- **AC-6（双端一致）** 本地 `HEAD` 与 `origin/main`、`cnb/main` 三处 SHA 相同（推送后回报）。

---

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| 交接稿与 `AGENT.md` 口径分叉、越用越假 | spec 明写"投影而非替代"，并要求交接稿**引用 `AGENT.md` 章节号**而非复述其内容 |
| 过期交接稿被后续 Agent 当作现役指令执行 | R1.5 规定生命周期：交接稿头部必须写"生成时间 + 基线 commit + 有效期/失效条件"，任务归档即标记失效 |
| 交接稿里夹带明文凭据（已发生过一次 token 明文入 URL） | R1.3 列为硬禁止项，并在模板中留"需要凭据时如何索取"的固定段落 |
