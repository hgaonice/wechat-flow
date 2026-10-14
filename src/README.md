# src/ · 模块微观上下文

> **用途**：改某个模块前，只读它这一节就够，不必整读 `README.md` / `操作手册.md`。
> **依赖方向**：见 [`../ARCHITECTURE.md`](../ARCHITECTURE.md)；符号级索引见 [`../TREE.md`](../TREE.md)。
> **通用约定**：见 [`.trellis/spec/engine/`](../.trellis/spec/engine/index.md)。

每个模块按 **职责 / 关键导出 / 输入→输出 / 坑** 四段描述。

---

## cli.ts · 命令入口

- **职责**：解析 argv → 解析目标账号（`-a` / `--all` / `MW_ACCOUNT`）→ 调对应模块 → 汇总退出码。`USAGE` 是命令清单的单一来源。
- **关键导出**：无（可执行入口，`#!/usr/bin/env bun`）。
- **命令**：`plan` `publish` `run` `status` `accounts` `doctor` `login` `drafts` `cover` `mail-test`。
- **坑**：flag 解析是手写的（`parseFlags`），新增 flag 要同时改 `USAGE`、`short` 映射和文档；账号解析必须走 `resolveTargets`，别别名错了要报错列可用别名，**不得静默回退默认号**。

## config.ts · 配置与账号解析

- **职责**：读 `config.json` → 合并默认值 → 按 `-a`/环境变量解析出**当前账号**的 `AppConfig`（含所有隔离路径）。
- **关键导出**：`loadConfig(alias?)`、`ensureDirs(cfg)`、`listAccounts()`、`defaultAlias()`、`APP_DIR`、类型 `AppConfig`/`AccountCfg`/`ModelCfg`。
- **输入→输出**：`config.json` + 别名 → `AppConfig`（`paths.{data,content,prompts,plans,articles,imgs,state,logs,formula}`、`browser`、`model`、`notify`）。
- **坑**：**所有运行时路径都必须来自 `cfg.paths`**，禁止硬编码 `./data/...`；`ensureDirs` 负责建目录；新增账号必须先看 `directory-structure.md` 的端口隔离规则。

## planner.ts · 周编排

- **职责**：渲染 `prompts/plan.md` → 调 pi 让 agent 写 `plans/<ISO周>.json` → 校验（`validatePlan`：7 天、日期、结构）→ 落盘。
- **关键导出**：`runPlan(cfg,{date,dryRun})`、`findEntryForDate(cfg,date)`、`planPath(cfg,week)`、`loadPlan(file)`、`proxyEnv(cfg)`。
- **输入→输出**：`content/syllabus.md` + 已发布清单 → `plans/<周>.json`（7 天选题）。
- **坑**：**`--dry-run` 写旁路文件 `*.dryrun.json`**，校验通过后删掉，绝不能覆盖本周真实计划（历史事故）；agent 不写文件视为失败并发邮件；计划是发布时才读的。

## publisher.ts · 每日全流程

- **职责**：串起「查计划 → 生成文章 → 媒体预处理 → 封面 → 登录自愈 → 发布 → **草稿箱回查 + 正文校验 + 封面自动上传** → 状态 → 通知」。
- **关键导出**：`runPublish(cfg,{date,dryRun,reuse,force})`、`runArticleGeneration(cfg,{date,feedback,reuse})`（C3 抽出的**纯生成**，不推送）、`buildArticlePrompt(cfg,day,date,articlePath,feedback?)`（空/缺 `feedback` 时字节不变）、`parseFrontmatter(md)`；返回 `PublishRunResult` / `ArticleGenResult`。
- **输入→输出**：`plans/<周>.json` + `prompts/article.md` → `articles/<日期>-<slug>.md`、`imgs/<日期>/cover.png`、`state/published.json`。
- **坑**：`reuse` 复用已有文章、`force` 忽略已发布记录（修复历史草稿用）；发布成功后**必须**过 `verifyDraftBody`，标题在但正文空要判失败；失败写 `ok:false` 并告警。

## media.ts · 确定性后处理

- **职责**：发布前把文章里的 LaTeX 转内联 SVG、把当天 `scene.py` 渲染成 GIF；产出**可发布文件**与 warning 列表。
- **关键导出**：`prepareArticleForPublish(cfg,articlePath,date)`、`mediaDirFor(cfg,date)`、`ensureManimGif(cfg,date)`。
- **输入→输出**：`.md` → 可能生成 `*.math.md` / `scene.gif`；返回 `{file, warnings, gif?}`。
- **坑**：**任何一步失败都不阻断发布**，降级为“保留原文”，只在日志/邮件提示（见 `ai-determinism.md`）。

## math.ts · LaTeX → SVG

- **职责**：扫描 `$…$` / `$$…$$`，调 `bin/tex2svg.py` 转成内联 `<svg>` 写回（原文件不动，另存 `.math.md`）。
- **关键导出**：`renderFormulasInMarkdown(md,opts)`、`hasFormula(md)`、`mathEnabled(cfg)`。
- **坑**：为什么必须自己转 —— 上游 `baoyu-md` 只在 `window` 存在时才启用 MathJax；为什么用**内联 SVG** —— 实测微信编辑器保留内联 `<svg>`。语法/缓存/排障见 `操作手册.md` §7。

## cover.ts · 模板封面

- **职责**：用 ImageMagick `convert` 生成 900×500 确定性封面。
- **关键导出**：`generateTemplateCover(input)`、`detectCjkFont(configured?)`。
- **坑**：中文字体缺失会出方框，`detectCjkFont` 负责探测；浏览器发布默认**不自动上传封面**，可开 `cover.uploadToDraft` 用 O-B 流程上传（失败降级为后台手选，不阻断发布）。

## wechat.ts · skill 调用 + 草稿箱真相

- **职责**：驱动 `baoyu-post-to-wechat` skill 把文章写进草稿箱（API 或 browser/CDP）；并在已登录页面查询草稿列表、**校验正文真实 DOM**、清理残留 tab。
- **关键导出**：`publishArticleBrowser` / `publishArticle`、`listDrafts` / `listDraftTitles`、**`verifyDraftPublished`**、**`verifyDraftBody`**、`cleanupAppmsgTabs`、**`setDraftCover`** / **`probeDraftCover`**（O-B 封面自动上传）。
- **输入→输出**：可发布 `.md` + 标题/作者/账号 → 草稿箱草稿 + 校验结果（`{ok: boolean|undefined, detail}`）。
- **坑**：**本模块是全项目可信度的守门人**。正文选择器只能 `.rich_media_content .ProseMirror`；正文长度要剔除占位符；skill 的成功提示不可信。任何改动都要重读 `verification.md`。`setDraftCover` 的封面弹窗选择器无法在开发机观测，用 `cover --date <d> --probe` 真机 dump 后调 `COVER_SELECTORS`；失败必须降级、绝不阻断发布。

## browser.ts · Xvfb + Chrome 生命周期

- **职责**：按账号拉起/复用无头 Xvfb + Chrome（独立 `user-data-dir` 与 `cdpPort`），清理僵尸 X socket 与 Singleton 锁。
- **关键导出**：`ensureBrowser`、`ensureDisplay`、`ensureChrome`、`resolveProfileDir`、`checkBrowser`、`cdpVersion`。
- **坑**：systemd 会 SIGKILL 掉 detached 的 Xvfb/Chrome，所以每次运行都要能**冷启动自愈**；`resolveProfileDir` 必须按账号区分。

## session.ts · 登录态自愈

- **职责**：检查 MP 登录态；失效则截图二维码 → 邮件 → 轮询等扫码，实现无人值守自愈。
- **关键导出**：`ensureLoggedIn(opts)`、`emailQrImage(opts)`，复用 `captureQr`/`openWechatTab`/`connect`/`isLoggedInUrl`。
- **输入→输出**：浏览器配置 + 邮件配置 → `{ok, detail}`；必要时产出二维码 png。
- **坑**：冷启动 SPA 需要宽限等待（URL 含 `token=` 或 `/cgi-bin/home` 才算登录）；`loginWaitSec` 默认 900s。

## pi.ts · pi CLI 集成

- **职责**：以 `pi --print --mode json` 子进程跑 agent，解析 JSONL 事件流，取最后一条 assistant `message_end` 文本；负责重试与模型降级。
- **关键导出**：`runPi(opts)`、`resolvePiBin(configured)`；类型 `PiRunOptions`/`PiRunResult`。
- **坑**：**pi 上游失败仍 exit 0**，必须监听 `stopReason`/`errorMessage` 判失败；再重试；再依次试 `fallbacks`。详见 `error-handling.md`。

## state.ts · 幂等状态

- **职责**：读写 `state/published.json`，原子写入。
- **关键导出**：`loadState`、`saveState`、`isPublished`、`recordPublished`、`atomicWriteJson`。
- **坑**：用 `atomicWriteJson`（临时文件 + rename）防半截文件；失败也要落 `ok:false` 记录。

## notify.ts / mailer.ts · 通知

- **职责**：`notify` 按配置分发（email/telegram）；`mailer` 调 `email-sender` skill（python3 + SMTP）。
- **关键导出**：`notify(cfg,msg)`、`sendMail(cfg,input)`、`checkEmail(cfg)`。
- **坑**：`-b` 正文 + `-f` 附件（文章 md）走 skill；凭据在 skill 的 `config.env`，应用不自己实现 SMTP；别在日志里打印授权码。

## console/ · 控制台（C1–C3，第二阶段）

> 带鉴权的 Web 控制面；**engine 不得反向依赖它**（依赖方向 `console/* → ../*.ts`）；运行时**零新增依赖**（`Bun.serve`/`bun:sqlite`/`node:crypto`）。详细约定见 [`.trellis/spec/console/`](../.trellis/spec/console/index.md)。

- **main.ts · 入口**：默认 `serve`（HTTP + 调度 + worker 同进程）；`--no-worker` 只 HTTP；`--worker` 无头；`--init-key`/`--create-admin`/`--import-config`/`--status`/`--verify-ac3`。`Bun.serve` 设 `idleTimeout:120`（SSE 必需）。
- **server.ts · 路由**：`route()` + 统一 envelope `{ok:true,data}` / `{ok:false,code,message,detail}`；写请求验 `X-CSRF-Token`；授权集中在 `auth/rbac.ts`（`assertAdmin`/`assertAccountAccess`）。
- **db/**：`schema.ts` 为 **DDL 唯一真相源**（18 表 + 索引，`PRAGMA user_version`）；`migrate.ts` 启动前滚；DAO 在 `db/dao/*`。
- **auth/**：口令哈希 + 会话 token 存 `sha256(token)` + RBAC。
- **crypto/secrets.ts**：`aes-256-gcm`（12B nonce，`KEY_VERSION=1`）；无 master key → fail-fast。
- **jobs/**（C2）：`types`/`plans`/`queue`/`worker`/`scheduler`。**每账号 ≤1 `running`**（SQL `NOT EXISTS` + 进程内 Set）；`plans` 表为计划唯一真源，engine 计划文件为派生（`materializePlans` / `fillMissingPlansFromFiles`）。
- **content/generate.ts**（C3）：`generateArticle`（调 engine，快照 `.v<N>.md`，落 `articles` 行）、`recordDraftResult`（`drafts.verified` **只镜像** `runPublish.ok`）。
- **http/sse.ts**（C3）：零依赖 SSE，`ReadableStream` + ~700ms 轮询 `jobs`/`job_logs`，`id:`=`job_logs.id`，`Last-Event-ID` 续传，15s `: ping`。
- **ui/**：静态页（`index`/`login`/`account`/`settings`/`workbench`）+ `app.css`/`app.js`。
- **坑**：`.gitignore` 必须写 `/console/`（否则吞掉 `src/console/`）；**推送铁律不变**——控制台只调 `runPublish`，成功与否只看 `verifyDraftBody`；`bun:sqlite` 无行时返回 `null`（非 `undefined`）。

## date.ts / log.ts / prompts.ts · 基础设施

- `date.ts`：`todayInTz`（默认 Asia/Shanghai）、`isoWeek`、`weekRange`、`weekdayCn`、`addDays`、`WEEKDAY_CN`。
- `log.ts`：`initLog(dir,name)` + `log`（info/warn/error/step），按账号落 `data/<alias>/logs/`。
- `prompts.ts`：`renderTemplate(file,vars)`，把 `{{var}}` 渲染进 `prompts/plan.md` / `article.md`。

---

## bin/ 脚本（非 bun）

| 文件 | 用途 | 被谁调用 |
|---|---|---|
| `bin/tex2svg.py` | LaTeX → 内联 SVG | `math.ts` |
| `bin/manim-gif.sh` | manim `scene.py` → `scene.gif` | `media.ts` |
| `bin/send-image.py` | 用 email-sender 凭据把图片作附件发出 | `session.ts` |
