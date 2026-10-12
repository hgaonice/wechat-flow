# Quality Guidelines

> 没有测试框架，所以“质量”靠**转译检查 + 真机自检 + 草稿箱回查**三件事保证。
> 这里的命令都是本项目实际的验收方式，不是理想化要求。

---

## 改动后必跑（按代价从低到高）

```bash
# ① 转译/语法检查（零依赖，必须过）
bun build --target=bun src/cli.ts >/dev/null

# ①b 类型检查（devDependencies 已随仓库提供：typescript + @types/node；
#     本仓库 runtime 零依赖，devDeps 仅用于类型检查，不违反 runtime 零依赖）
bunx tsc --noEmit          # 或 npm run typecheck

# ② 环境自检：pi / bun / convert / skill 能力 / Chrome / Xvfb / email
bun src/cli.ts doctor            # 单账号（默认号）
bun src/cli.ts doctor --all      # 所有启用账号；会检查 cdpPort 冲突

# ③ 只生成、不发布（最常用的干跑）
bun src/cli.ts publish --dry-run
bun src/cli.ts publish -a gaoh --dry-run

# ④ 真机端到端（触碰发布链路时必做）
bun src/cli.ts publish --date <YYYY-MM-DD> --force --reuse
bun src/cli.ts drafts  -a <alias> --date <YYYY-MM-DD>   # → ✅ 正文校验
```

---

## 健康基线（对照用，来自 README 已实测）

| 项目 | 期望 |
|---|---|
| `doctor` | 全项通过（含 browser: Chrome CDP :99 / :9222） |
| 端到端发布 | 正文 > 2000 字，`✅ 正文校验`，邮件送达 |
| 排版保留 | 草稿 DOM 有 `<h2>`×N、`<p>`×N、`<strong>`×N、列表 |
| 幂等 | 重复运行自动跳过；`--force` 能重发 |
| 多账号隔离 | 两个 Chrome 同时在线，草稿箱查询互不串号 |
| 别名校验 | `-a nope` 报错并列出可用别名，退出码 1 |

---

## 代码规范

- TypeScript `strict`；不新增运行时依赖。
- 模块单一职责；文件名即职责（见 `src/README.md` / `TREE.md`）。
- 日志走 `src/log.ts`，按账号落 `data/<alias>/logs/`；**不打印密钥/token/授权码**。
- 子进程调用集中在对应模块，不散落到 `cli.ts`。
- 常量/路径不硬编码，走 `config.ts`。

---

## 文档与状态规范

- 结论/决策写回 `AGENT.md` 变更日志；新约定写回本 spec。
- 真机验证留下**原始数字**（字数、DOM 计数、耗时、退出码），不要只写“验证通过”。
- `.trellis/`、`AGENT.md`、`docs/` 是给下一个 AI 会话看的，写完即“交接”。
