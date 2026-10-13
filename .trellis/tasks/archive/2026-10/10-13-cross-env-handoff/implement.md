# implement.md · 执行清单（cross-env-handoff）

> 配套：`prd.md`。无 `design.md`（纯 spec/文档交付，无代码与数据模型变更）。
> 纪律：完成 = 产物路径或命令真实输出；本任务**不触碰** `src/`。

---

## 交付物

| # | 路径 | 说明 |
|---|------|------|
| D1 | `.trellis/spec/guides/cross-env-handoff.md` | 约定正文（R1.1–R1.5） |
| D2 | `docs/handoffs/TEMPLATE.md` | 可复制交接模板 |
| D3 | `docs/handoffs/README.md` | 目录用途 / 命名约定 / 生命周期 |
| D4 | `docs/handoffs/2026-10-13-cnb-console.md` | 本次 CNB 交接稿（由 `docs/HANDOFF-CNB.md` 迁入） |
| D5 | `.trellis/spec/guides/index.md`、`AGENT.md` | 索引与看板同步 |

---

## 执行清单

- [ ] I1 写 D1 `cross-env-handoff.md`：触发条件 / 必含章节清单 / 证据与密钥边界 / 口径原则（投影非替代）/ 生命周期
- [ ] I2 写 D2 `TEMPLATE.md`：章节与 D1 的 R1.2 清单逐项对应，含头部「生成时间 + 基线 commit + 失效条件」
- [ ] I3 写 D3 `handoffs/README.md`：用途、命名 `YYYY-MM-DD-<用途>.md`、生成→归档→失效流程
- [ ] I4 迁移交接稿：`git mv docs/HANDOFF-CNB.md docs/handoffs/2026-10-13-cnb-console.md`，并在文首补「基线 commit + 失效条件」
- [ ] I5 索引同步：`.trellis/spec/guides/index.md` 增加一行；`AGENT.md` §4 增加一行、§3 任务地图登记本任务、§9 追加变更日志
- [ ] I6 静态检查与链接存在性验证（见下）
- [ ] I7 提交（含 task 归档）+ 双远端推送（origin + cnb），回报两侧 SHA

---

## 验证命令

```bash
# AC-1 无占位符 / 空章节（模板代码块内的占位符不在此文件）
grep -nE 'TODO|TBD|待补' .trellis/spec/guides/cross-env-handoff.md

# AC-2 模板章节 vs spec 清单逐项对应
grep -nE '^##+ ' docs/handoffs/TEMPLATE.md
grep -nE 'R1\.2|必含章节' -A 12 .trellis/spec/guides/cross-env-handoff.md

# AC-3 归档就位且无重复来源
test -f docs/handoffs/2026-10-13-cnb-console.md && echo OK-archive
test ! -e docs/HANDOFF-CNB.md && echo OK-no-dup

# AC-4 索引链接可达（逐个 test -e）
grep -n 'cross-env-handoff\|docs/handoffs' AGENT.md .trellis/spec/guides/index.md

# AC-5 引擎未受影响
bun build --target=bun src/cli.ts >/dev/null && echo OK-build
bunx tsc --noEmit && echo OK-tsc

# 任务态
python3 .trellis/scripts/task.py current --source
```

---

## 验收映射

| AC | 对应交付物 | 证据形式 |
|---|---|---|
| AC-1 | D1 | grep 输出为空 + 章节齐备截图式输出 |
| AC-2 | D2 | 两侧标题清单对照 |
| AC-3 | D4 | `test` 命令的输出 `OK-archive` / `OK-no-dup` |
| AC-4 | D5 | grep 命中行 + `test -e` 逐个通过 |
| AC-5 | — | `OK-build` / `OK-tsc` |
| AC-6 | — | `git ls-remote origin cnb` 与本地 HEAD 逐字符比对 |

---

## 回滚点

纯新增文档 + 一次 `git mv`；回滚 = `git revert` 单次提交（无 DB/配置/线上状态变更，无迁移风险）。
