# Engine Development Guidelines

> 本项目是**单仓 TypeScript / bun 引擎**：一个 CLI（`src/cli.ts`）+ 一组无状态库（`src/*.ts`），
> 用 `pi` CLI 生成内容、用 Chrome CDP 把内容写进公众号草稿箱、用 systemd timer 触发。
> 没有前端、没有服务端、没有数据库；运行时**零第三方依赖**（bun + 系统工具 + 已装 skill）。

---

## 技术栈与硬约束

| 维度 | 约定 |
|---|---|
| 运行时 | **bun ≥ 1.3**，直接执行 `.ts`（`bun src/cli.ts ...`），不编译、不打包 |
| 语言 | TypeScript，`strict: true`，`verbatimModuleSyntax: false`，ESM（`"type": "module"`） |
| 依赖 | **运行时不新增 npm 依赖**（`package.json` 无 dependencies）；外部能力一律通过子进程调用（`pi` / python skill / `convert` / `ffmpeg`） |
| 类型检查 | `bun build --target=bun src/cli.ts`（零依赖） + `bunx tsc --noEmit`（devDeps 已随仓库提供：typescript/@types/node） |
| 系统工具 | ImageMagick `convert`、`ffmpeg`、`Xvfb`、`google-chrome`（仅浏览器发布方式需要） |
| 平台 | 目标机 Debian/Ubuntu + systemd（见 `deploy/`） |

> **不要为了省事引入 npm 包。** 需要解析、并发、HTTP 时优先用 bun/Node 内置 + `spawnSync`/`fetch`。

---

## Guidelines Index

| Guide | 说明 | 状态 |
|-------|------|------|
| [Directory Structure](./directory-structure.md) | 目录、依赖方向、按账号隔离路径 | v1 实测 |
| [AI / Determinism Boundary](./ai-determinism.md) | “AI 只做内容、其余确定” 的分层铁律 | v1 实测 |
| [Verification & Truth Source](./verification.md) | 只信草稿箱真实 DOM，不信上游自报成功 | v1 实测 |
| [Error Handling & Degradation](./error-handling.md) | 重试/降级/失败邮件/退出码 | v1 实测 |
| [Quality Guidelines](./quality-guidelines.md) | 改动后必跑的自检命令与验收基线 | v1 实测 |

---

## Pre-Development Checklist

动手前逐条确认：

- [ ] 已读本文件 + 与改动相关的 1–2 篇 guide（**不要**整读 `README.md` / `操作手册.md`）
- [ ] 已确认改动落在哪个 `src/<module>.ts`，以及它的上游/下游调用者（见 `TREE.md`）
- [ ] 已确认改动是否触碰 **AI/确定性边界**（是否会让非确定性逻辑混进代码层）
- [ ] 已确认是否影响 **按账号隔离**（`data/<alias>/`、`cdpPort`）
- [ ] 若是发布链路，想清楚 **失败如何被检出**（是否有草稿箱回查兜底）
- [ ] 没有新增运行时依赖

## Quality Check

改动完成、声明“做完”之前必须实测：

- [ ] `bun build --target=bun src/cli.ts` 与 `bunx tsc --noEmit` 均零错误
- [ ] 受影响命令能跑通：`bun src/cli.ts doctor --all`（干跑/自检）
- [ ] 若触碰发布：`bun src/cli.ts publish --dry-run` 至少生成成功
- [ ] 若触碰发布：真机实测 `publish --force --reuse` 后 `drafts --date <日期>` 显示 `✅ 正文校验`
- [ ] 日志/邮件里**没有**把“上游打印成功”当成“已发布成功”
- [ ] 关键结论已写回 `AGENT.md` 变更日志；新约定已写回本 spec

> **打勾规则**：完成 = 产物存在（文件路径）**或**命令真实输出。禁止“我记得做过了”。

---

## 反模式（本项目已经踩过、禁止重犯）

| 反模式 | 为什么 | 见 |
|---|---|---|
| 用 `document.querySelector('.ProseMirror')` 定位正文 | 编辑器里有多个 `.ProseMirror`，会命中标题框 → 空正文 | `.trellis/spec/engine/verification.md` |
| 用 `xdotool` 发 ctrl+c/v 做复制粘贴 | headless 无窗口管理器，焦点不可靠 → 静默丢正文 | 同上 |
| 相信 skill 打印的 `Done.` / “Body verified OK” | 那是上游的假阳性 | 同上 |
| 在代码里做“选题/写文/润色” | 这些是非确定性的，属于 pi agent 的职责 | `.trellis/spec/engine/ai-determinism.md` |
| 多账号共用 `cdpPort` / `dataDir` | 会串号发错公众号 | `.trellis/spec/engine/directory-structure.md` |
| 在 250 上直接改 `content/` `prompts/` 后部署 | 会被本地真源静默覆盖 | 见 `操作手册.md` §10.3 |
