# TREE.md · 文件与符号索引（自动生成，勿手改）

> 生成命令：`bash tools/repomap.sh`　更新时间：2026-10-12 16:36:14
> 用途：规划时先读本文件替代 `ls` 与整读源码；改动代码后请重跑本脚本。
> 相关：[ARCHITECTURE.md](./ARCHITECTURE.md) · [src/README.md](./src/README.md) · [AGENT.md](./AGENT.md)

```text
wechat-flow/
  bin
  content
  deploy
  docs
  prompts
  src
  tools

[src/ 模块]
src/browser.ts
src/cli.ts
src/config.ts
src/cover.ts
src/date.ts
src/log.ts
src/mailer.ts
src/math.ts
src/media.ts
src/notify.ts
src/pi.ts
src/planner.ts
src/prompts.ts
src/publisher.ts
src/session.ts
src/state.ts
src/wechat.ts
```

## src/ 模块与导出符号

### `src/browser.ts`  (170 行)
> Browser (Chrome CDP) publishing support.

导出：`BrowserConfig, defaultBrowserConfig, resolveProfileDir, displayUp, cdpVersion, ensureDisplay, ensureChrome, ensureBrowser, checkBrowser`

### `src/cli.ts`  (464 行)
>  Command-line entry: parse argv, resolve target accounts (-a/--all), dispatch to modules.

导出：（无，或为可执行入口）

### `src/config.ts`  (334 行)

导出：`SRC_DIR, APP_DIR, CONFIG_PATH, ModelCfg, AccountCfg, AppConfig, defaultAlias, AccountInfo, listAccounts, loadConfig, ensureDirs`

### `src/cover.ts`  (82 行)
>  Generate a deterministic 900x500 cover via ImageMagick (`convert`).

导出：`detectCjkFont, CoverInput, generateTemplateCover`

### `src/date.ts`  (45 行)
>  Date helpers (Asia/Shanghai by default).

导出：`todayInTz, addDays, isoWeek, weekRange, WEEKDAY_CN, weekdayCn`

### `src/log.ts`  (44 行)

导出：`initLog, log`

### `src/mailer.ts`  (111 行)
> Email notifications are delegated to the pre-installed `email-sender` skill

导出：`EmailSkillConfig, EmailConfig, MailInput, sendMail, checkEmail`

### `src/math.ts`  (193 行)
> math.ts — 把文章里的 LaTeX 公式（$...$ / $$...$$）在发布前转成内联 SVG。

导出：`MathOptions, MathResult, mathEnabled, renderFormulasInMarkdown, hasFormula`

### `src/media.ts`  (119 行)
> media.ts — 发布前的「媒体预处理」：

导出：`MediaResult, mediaDirFor, ensureManimGif, prepareArticleForPublish`

### `src/notify.ts`  (54 行)

导出：`NotifyMessage, notify`

### `src/pi.ts`  (216 行)
> Thin, version-independent integration with the pi CLI.

导出：`PiRunOptions, PiRunResult, runPi, resolvePiBin`

### `src/planner.ts`  (161 行)

导出：`PlanDay, Plan, planPath, loadPlan, findEntryForDate, runPlan, proxyEnv`

### `src/prompts.ts`  (10 行)

导出：`renderTemplate`

### `src/publisher.ts`  (313 行)

导出：`PublishRunResult, parseFrontmatter, runPublish`

### `src/session.ts`  (218 行)
> WeChat MP login-session helpers (browser/CDP method).

导出：`EmailCfg, emailQrImage, EnsureLoginOptions, EnsureLoginResult, ensureLoggedIn`

### `src/state.ts`  (56 行)

导出：`PublishedRecord, StateFile, atomicWriteJson, loadState, saveState, isPublished, recordPublished`

### `src/wechat.ts`  (1033 行)
>  Deterministic publisher: drives the baoyu-post-to-wechat skill script via bun.

导出：`PublishOptions, PublishResult, publishArticle, BrowserPublishOptions, publishArticleBrowser, DraftItem, listDraftTitles, listDrafts, verifyDraftPublished, verifyDraftBody, cleanupAppmsgTabs, SetCoverOptions, CoverResult, setDraftCover, probeDraftCover`

## bin/ 脚本

| 文件 | 用途 |
|---|---|
| `bin/manim-gif.sh` | manim-gif.sh — 把一个 manim 场景渲染成适合公众号正文的 GIF。 |
| `bin/send-image.py` | Send an image (e.g. the WeChat login QR screenshot) as an email attachment. |
| `bin/tex2svg.py` | — |

## tools/ 脚本

- `tools/draft-probe.ts` — —
- `tools/repomap.sh` — repomap.sh —— 生成/刷新 TREE.md（文件 + 符号索引，Aider repomap 的轻量等价物）
