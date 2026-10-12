# PRD · 上下文治理：.trellis + AGENT.md + 分层文档 + repomap

## 1. 背景 / 问题

本项目已被 AI Agent 长期开发与维护（见 `README.md` §已实测验证、`操作手册.md` §9）。
痛点不是代码能力，而是**跨会话上下文治理**：

- 每次新会话容易整读 `README.md`(30KB) / `操作手册.md`(62KB)，Token 浪费且易读漏；
- 没有“上次做到哪、下一步做什么、凭什么说做完了”的单一续接入口；
- 没有硬约束限制 Agent 的读取范围与“先计划后改”的行为；
- 缺少按需索引（模块/符号），规划时只能 `ls` 全盘或整读源码。

参考 `/workspaces/dev/project/temp.md` 的“增量上下文 / 任务拆解 / 规范驱动”建议。

## 2. 目标

为 wechat-flow 建立**可续接、可验证、低 Token** 的工程上下文体系：

1. `.trellis/`：任务系统（`tasks/`）+ 规范系统（`spec/engine/`）+ 会话日志（`workspace/`）。
2. `AGENT.md`：唯一续接入口 / 进度看板（全局规则 + 当前任务 + Checkpoint + 下一步）。
3. **分层文档**：宏观（`ARCHITECTURE.md`）→ 微观（`src/README.md`）→ 索引（`TREE.md`）。
4. **规则约束**：读取上限、先计划后改、证据打勾、单活动任务、AI/确定性边界。
5. **repomap**：`tools/repomap.sh` 自动生成 `TREE.md`（文件 + 导出符号，无需全盘扫描）。

## 3. 非目标

- 不改动引擎运行逻辑（`src/` 除补一句文件头注释外零改动）。
- 不引入运行时依赖。
- 不接入向量索引 / 外部 RAG 服务（保持零依赖，`TREE.md` 即轻量 repomap）。

## 4. 交付物（验收依据）

| # | 产物 | 验收 |
|---|------|------|
| 1 | `.trellis/`（spec/tasks/workspace/workflow） | `trellis init` 产物存在；`get_context.py --mode packages` 显示 `engine` 层 |
| 2 | `.trellis/spec/engine/*`（5 篇真实约定） | 文件存在且非占位（有本项目路径/命令/反模式） |
| 3 | `AGENT.md` | 含续接协议、进度看板、GATE、任务地图、上下文索引、当前任务+Checkpoint、证据规则、下一步 |
| 4 | `ARCHITECTURE.md` / `src/README.md` / `TREE.md` | 存在；`TREE.md` 由脚本生成 |
| 5 | `tools/repomap.sh` | `bash tools/repomap.sh` 退出 0 且生成 `TREE.md` |
| 6 | `AGENTS.md` 指向 `AGENT.md` | 托管块之外有指向 AGENT.md 的说明 |

## 5. 验收命令

```bash
python3 .trellis/scripts/get_context.py --mode packages   # 应列出 engine 层
python3 .trellis/scripts/task.py list                     # 应列出本任务
bash tools/repomap.sh && bash tools/repomap.sh --check    # 退出 0
bun build --target=bun src/cli.ts >/dev/null              # 退出 0（引擎未被破坏）
```

## 6. 风险

- `trellis init` 覆盖已存在文件：已用 `--skip-existing`（非交互模式）规避。
- 无 git 仓库：`.trellis` 会话自动提交会跳过；不影响状态文件本身。
