# Implement · 上下文治理

> 执行顺序 checklist。每项完成后在本文件打勾（`[x]`），并在 `AGENT.md` 变更日志追加一行。
> 验证结果要贴**真实输出**，不写“应该没问题”。

## 步骤

- [x] **T1 初始化 `.trellis/`**：`trellis init --pi -u gaoh -y`
  - 验证：`ls .trellis/{scripts,spec,tasks,workspace}`、`.trellis/.developer` 含 `name=gaoh`
- [x] **T2 规范层改为项目实际情况**：删除占位 `spec/frontend`，新建 `spec/engine/`（index + directory-structure + ai-determinism + verification + error-handling + quality-guidelines）
  - 验证：`python3 .trellis/scripts/get_context.py --mode packages` 输出 `Spec layers: engine`
- [x] **T3 宏观架构**：`ARCHITECTURE.md`（技术栈 / 拓扑 / 分层 / 5 条不变量 / 数据 / 外部依赖）
  - 验证：文件存在，≤ 200 行
- [x] **T4 微观上下文**：`src/README.md`（每模块 职责/导出/IO/坑）
  - 验证：18 个 `src/*.ts` 均有一节
- [x] **T5 repomap**：`tools/repomap.sh` → 生成 `TREE.md`
  - 验证：`bash tools/repomap.sh && bash tools/repomap.sh --check` → 退出 0
- [x] **T6 续接入口**：`AGENT.md`（协议 / 看板 / GATE / 任务地图 / 上下文索引 / 当前任务+Checkpoint / 证据规则 / 下一步 / 路线）
  - 验证：文件存在，含以上章节标题
- [x] **T7 `AGENTS.md` 指向 `AGENT.md`**（托管块之外追加说明）
  - 验证：`grep -n AGENT.md AGENTS.md`
- [x] **T8 任务建档**：创建 `10-12-context-governance`（本任务）、`10-12-cover-auto-upload`（backlog）；归档 `00-bootstrap-guidelines`
  - 验证：`python3 .trellis/scripts/task.py list`
- [x] **T9 引擎未被破坏**：`bun build --target=bun src/cli.ts >/dev/null` 退出 0
- [x] **T10 交给用户确认**（GATE）：用户回复“继续执行”= 确认；归档本任务

## 验证命令汇总

```bash
python3 .trellis/scripts/get_context.py --mode packages
python3 .trellis/scripts/task.py list
bash tools/repomap.sh && bash tools/repomap.sh --check
bun build --target=bun src/cli.ts >/dev/null && echo BUILD_OK
wc -l AGENT.md ARCHITECTURE.md src/README.md TREE.md
```

## 回滚点

- 全部新增文件（`AGENT.md`/`ARCHITECTURE.md`/`TREE.md`/`src/README.md`/`tools/repomap.sh`/`.trellis/`/`.pi/`/`.agents/`/`AGENTS.md`）。
- 仅有的源码改动：`src/cli.ts` 顶部加了一句文件级注释（无逻辑影响）。
- 回滚方式：删除上述新增文件；恢复 `src/cli.ts` 那一行即可。
