# Check Report · 文末互动引导语 CTA（独立复核）

- **复核者**：`trellis-check` 子代理（独立于实现者，全部结论从工作区重新推导）
- **日期**：2026-10-16
- **结论**：**PASS-with-issues**（无阻塞/回归缺陷；所有确定性、幂等、降级、可达性、配置与构建声明均独立复现）

## 已独立验证（关键项）

| 检查 | 结果 |
|---|---|
| `bun build --target=bun src/cli.ts` / `bunx tsc --noEmit` | `BUILD_OK` / `TSC_OK` |
| `bun tools/cta-selftest.ts` | 全 PASS（复核时 11 条；修复 F1 后增至 **13 条**，新增 2 条 F1 回归断言） |
| 复核者独立对抗探针（`/tmp`） | **ALL PASS**：CRLF frontmatter / 无 frontmatter / 中段词 / >500 字单行无换行 / 尾部空白字节稳定 / 二次应用 / 块内动作词 <3 降级 / 块内 `$…$` 与 `{{unknownVar}}` / 文件缺失·目录·ENOTDIR |
| 独立 E2E 探针（真实 `resolveConfig` + `runArticleGeneration(reuse=true)`） | **ALL PASS**：默认开 / 账号级覆盖胜出 / 全局继承 / 注入 / 字节幂等 / 账号级与全局 `false` 均不改文件 |
| 公式路径 `prepareArticleForPublish` | CTA 在成功与降级两条路径都进入 `.math.md`；base 文件未被改写 |
| 注入点可达性 | base 文章唯一写入者是 `runArticleGeneration`；调用者仅 `runPublish` + 控制台 `generateArticle`；`media.ts` 只写 `.math.md` |
| 越界检查 | `src/media.ts`、`src/wechat.ts`、`src/console/content/generate.ts`、`data/`、`plans/` **均未改** |
| 降级 R6 | `applyCtaToArticle` 在 ENOENT/EISDIR/ENOTDIR 下不抛错，`runArticleGeneration` 仍 `ok:true` |

## 发现的 Issue 与处置

| # | 级别 | 问题 | 处置 |
|---|---|---|---|
| **F1** | MEDIUM | `ACTION_WORDS` 含 `分享`/`关注`（非必需引导词，普通结尾常见）。尾部命中 2 个即判「已有」→ **该补未补**，破坏 R1「必有」。复核者探针复现：`我们关注…下面分享一个记忆方法` 被误判为 `present` | **已修**：检测词表收敛为核心六词 `点赞/在看/转发/收藏/评论/留言`；新增 selftest 11/12 两条回归断言（`分享/关注` 不得入表 + 普通结尾仍追加） |
| F2 | LOW/MEDIUM | 「≥3 类动作词」由提示词与标准块保证，**不由代码强制**（阈值 2 有意放宽以免重复段落） | 接受（design §2.1 已记录该取舍）；标准块自带 6 词 |
| **F3** | LOW（证据） | 文档里 `chars=158` 来自本地无 `config.json` 时 `accountName` 回退别名，规范配置下应为 `156`；需确认 250 上渲染为「巧思初数」而非别名 | **已证实 + 已修文档**：250 只读探测 → `second='巧思初数'`、`gaoh='gaoh的技术分享'`、顶层 `cta: None`（默认开生效）；重跑真 CLI 得 `chars=156` / 渲染「关注「巧思初数」」 |
| F4 | LOW | 文档写「10 PASS」，实际断言数不符 | **已修**：改为 13 项（修复 F1 后） |
| **F5** | LOW（一致性） | `cta.file` 相对路径按 `process.cwd()` 解析，其他 config 路径按 `APP_DIR` | **已修**：改用 `APP_DIR`（与 `config.ts` 一致；systemd `WorkingDirectory=APP_DIR` 行为不变） |
| F6 | INFO | 自定义 CTA 文件里的未知占位符/`$…$` 会原样进入正文 | 接受（仅手改 `prompts/cta/*.md` 时可达；记录在案） |
| F7 | INFO | 日志文案 `cta: appended (from …)` 与 design §2.4 措辞略有差异 | 接受（四个状态词一致，验收断言点未变） |

## 复核者声明无法在本机验证的项

- **AC1/AC4 本机全绿**：本机无 `config.json`、无 `convert`、无 `baoyu-post-to-wechat` skill（既有环境差异，与本改动无关）→ 复核者用真实 `runArticleGeneration` 探针等价替代。
- **AC5（250 真机）**：需 250 环境 + 用户放行 G2。
- **AC6 完整控制台 job harness**：已按源码可达性 + 快照注入验证；未重跑 DB/job 全流程。
