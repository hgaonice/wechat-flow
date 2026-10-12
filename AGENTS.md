<!-- TRELLIS:START -->
# Trellis Instructions

These instructions are for AI assistants working in this project.

This project is managed by Trellis. The working knowledge you need lives under `.trellis/`:

- `.trellis/workflow.md` — development phases, when to create tasks, skill routing
- `.trellis/spec/` — package- and layer-scoped coding guidelines (read before writing code in a given layer)
- `.trellis/workspace/` — per-developer journals and session traces
- `.trellis/tasks/` — active and archived tasks (PRDs, research, jsonl context)

If a Trellis command is available on your platform (e.g. `/trellis:finish-work`, `/trellis:continue`), prefer it over manual steps. Not every platform exposes every command.

If you're using Codex or another agent-capable tool, additional project-scoped helpers may live in:
- `.agents/skills/` — reusable Trellis skills
- `.codex/agents/` — optional custom subagents

Managed by Trellis. Edits outside this block are preserved; edits inside may be overwritten by a future `trellis update`.

<!-- TRELLIS:END -->

<!-- 本项目续接入口（手工维护，trellis update 不会覆盖） -->
## 续接入口

**接手本项目，先读 [`AGENT.md`](./AGENT.md)** —— 它是唯一的续接入口与进度看板：
续接协议、全局进度看板、人工确认门（GATE）、任务地图、上下文分层索引、当前任务与 Checkpoint、
证据打勾规则、变更日志、下一步。

其余上下文按需读：

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — 宏观架构与不变量
- [`src/README.md`](./src/README.md) — 每个模块的职责/导出/坑
- [`TREE.md`](./TREE.md) — 文件与符号索引（`bash tools/repomap.sh` 生成）
- [`.trellis/spec/engine/index.md`](./.trellis/spec/engine/index.md) — 写 `src/` 代码前必读
- `README.md` / `操作手册.md` — 仅安装/部署/排障时按节读

