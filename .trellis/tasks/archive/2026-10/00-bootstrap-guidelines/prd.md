# Bootstrap Task: Fill Project Development Guidelines

**由 AI 执行；本文件是初始化记录。** 开发者 `trellis init` 后，本任务用于把
`.trellis/spec/` 从占位模板填充为**本项目的真实约定**。

---

## Status

- [x] 扫描仓库既有约定文档（`README.md`、`操作手册.md`、`src/*.ts` 头部注释）
- [x] 确认本项目为**单仓 TypeScript/bun 引擎**（无前端、无服务端、runtime 零依赖）
- [x] 用真实约定替换占位 `spec/frontend/` → 新建 `spec/engine/`
- [x] 每篇 spec 引用真实文件路径 / 命令 / 反模式（非理想化描述）

## 已填充的 spec

| 文件 | 内容 |
|------|------|
| `.trellis/spec/engine/index.md` | 技术栈与硬约束、Pre-Development Checklist、Quality Check、反模式 |
| `.trellis/spec/engine/directory-structure.md` | 目录、依赖方向、按账号隔离（`data/<alias>` + 唯一 `cdpPort`） |
| `.trellis/spec/engine/ai-determinism.md` | “AI 只做内容、其余确定”的边界铁律 |
| `.trellis/spec/engine/verification.md` | 唯一真相源 = 草稿箱真实 DOM；`verifyDraftBody` |
| `.trellis/spec/engine/error-handling.md` | 重试/降级/失败显形（pi exit 0 的坑） |
| `.trellis/spec/engine/quality-guidelines.md` | 改动后必跑命令、健康基线、文档规范 |

## 完成

- 来源：`README.md`（已实测验证表 + 空正文事故）、`操作手册.md`（§9 Bug 历史、§8 验收）、`src/*.ts` 头部注释。
- 下一步：归档本任务。后续新约定通过 `trellis-update-spec` 或手工写回 `spec/engine/`。
