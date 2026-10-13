<!--
  跨环境 / 跨 Agent 交接模板
  用法：复制本文件 → docs/handoffs/YYYY-MM-DD-<用途>.md → 逐段填空 → 删除本注释。
  章节集合与 .trellis/spec/guides/cross-env-handoff.md §2 的必要章节清单（H1–H10）**逐项对应**；
  改一处必须改另一处（见该 spec §7）。
  填写要求：每条都落到真实路径或真实命令；禁止写入明文凭据（见 spec §3.1）。
-->

# 交接稿 · <用途一句话>（<目标环境/接手方>）

> **生成时间**：YYYY-MM-DD　**生成者**：<谁>
> **基线 commit**：`<完整或前7位 SHA>`
> **远端状态**：<如 origin(GitHub)=同一 SHA、cnb=同一 SHA>
> **失效条件**：<如「目标子任务全部验收并归档」/「被更新交接稿取代」/「HEAD 落后基线超过 N 个提交」>
> **状态**：有效

**目标**：<用一句话写清对方要完成什么；超出范围的明确列为非目标>

---

## 可直接粘贴的交接词

```text
<把下面 H1–H10 的内容整理成对方可直接执行的提示词；若对方能读仓库，也可以指向本文件的章节号>
```

---

## H1. 仓库与环境基线

- 仓库：<URL>（镜像：<URL>）；分支：<main>；基线 commit：`<SHA>`
- 技术栈与版本：<如 TypeScript + Bun ≥1.3（实测 x.y.z）>；运行时依赖策略：<如零第三方依赖>
- 验证工具链：<如 `bunx tsc --noEmit`、`bun build --target=bun src/cli.ts>`
- 任务框架命令：<如 `python3 .trellis/scripts/task.py {list,current,start,archive}`>
- 目标机器/部署位置：<如 192.168.0.250；相关脚本在 deploy/>

## H2. 不在仓库里的东西（.gitignore）

| 路径 | 内容 | 对方如何获得 |
|---|---|---|
| <config.json> | <账号配置> | <向我索取 / 从 config.example.json 复制后填> |
| <.env> | <密钥/环境变量> | <由我在部署时注入，值不写在此> |
| <data/> | <运行时数据> | <重新生成，不要搬运> |

> 规则：**需要凭据/密钥一律向我索取，不许猜测；绝不写入代码、提交或本交接稿。**（见 spec §3.1）

## H3. 续接读取顺序与读取上限

1. `<AGENT.md>`（唯一续接入口：进度看板 / GATE / 任务地图）
2. `<.trellis/tasks/<task>/prd.md>`
3. `<.trellis/tasks/<task>/implement.md>`
- 按需再读（**不要整读**）：<design.md / spec/... / ARCHITECTURE.md / TREE.md>
- 硬性上限：<单次任务最多读 N 个非 AGENT.md 文件>

## H4. 铁律与硬约束

- <铁律 1：如「AI 只做内容，其余确定性」——见 .trellis/spec/engine/ai-determinism.md>
- <铁律 2：如「唯一真相源 = 草稿箱真实 DOM」——见 .trellis/spec/engine/verification.md>
- **未经我确认不得改动**：<列出禁区，如发布链路 src/wechat.ts / src/publisher.ts>
- 先计划后改：动手前给出【改动方案 + 影响文件 + 验证命令】并等我确认
- 零依赖红线 / 隔离红线 / 其他红线：<...>

## H5. 工作流与门（GATE）

- 任务生命周期：<规划 → `task.py start` → 实现 → 自检 → 更新 spec/journal → 提交 → 归档>
- **硬停点**：<如「规划摘要必须经我批准，批准前不写任何实现代码」>
- GATE 清单：<GATE 编号 + 放行条件 + 真机要求，引用 AGENT.md §2>
- 回退要求：<如「接管调度前保留旧 timer 可回退」>

## H6. 待办与依赖顺序

| 顺序 | 任务 | 交付物 | 验收 | 依赖 |
|---|---|---|---|---|
| 1 | <C1 xx> | <一句话> | <AC-x> | <—> |
| 2 | <C2 xx> | <一句话> | <AC-y> | <C1> |

- 真相源：`<.trellis/tasks/<task>/prd.md>`（需求 + AC）与 `implement.md`（清单 + 验证命令）
- 不要在本稿重写需求；需求有分歧 → 改对应任务 `prd.md`

## H7. 已知偏差 / 坑

- <偏差 1：真相源与现状不一致之处，写明「这是已知缺口、由哪一步修复」>
- <环境坑：某命令在对方环境跑不通的前置条件>
- <历史事故提醒：如某次 token 明文入 URL 的教训>

## H8. 汇报格式与证据规则

回报固定三件：

1. 一句话结论
2. 产物**真实路径**列表 / 关键命令与输出摘要（贴数字）
3. 待确认点或阻塞

- 「完成」= 产物存在 **或** 命令真实输出；禁止"应该没问题"
- 每完成一个子任务：更新 `<AGENT.md>`（进度看板 / Checkpoint / 变更日志）、写 journal、`task.py archive`

## H9. Git 约定

- 分支：`<main / feature-xxx>`；提交信息风格：`<feat(scope): ... / fix(...) / chore(trellis): ...>`
- 推送：`<git push cnb main>` + `<git push origin main>`；推送后**回报两侧 SHA**
- **禁止提交**：密钥、`config.json`、`.env`、`data/`

## H10. 现在开始

1. 先做：<单一、明确的第一动作>
2. 然后给我：<你希望收到的第一份产出>
3. **在我批准之前**：<不要做的动作>
