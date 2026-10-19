# PRD：账号改名 `gaoh的技术分享` → `每天讲点理`（定位：每天一个理科小道理）

## 目标

把公众号账号 **`gaoh`（别名不变）** 的**对外显示名 / 署名 / 邮件主题前缀 / 文案自称**从「gaoh的技术分享」改为「**每天讲点理**」，并把内容定位措辞顺势调整为「**每天一个理科小道理**」，覆盖：250 控制台 DB（真源）→ `config.json`、仓库文档与文案、250 已生成文章署名；以 10-16 草稿重发作为真机验收。

## 已确认事实（仓库/250 证据）

| 项 | 现状 | 证据 |
|---|---|---|
| 真源链路 | 控制台 DB `accounts` → `syncConfigFile()` 回渲染 `config.json`；**worker 每个任务执行时重新 `loadConfig`** | `src/console/server.ts:537–555`、`src/console/jobs/worker.ts:63` |
| DB 行 | `id=2, alias=gaoh, display_name=gaoh的技术分享, author=gaoh的技术分享` | 250 `console.db` 只读查询 |
| overrides（逐字节保留） | `displayName/author/subjectPrefix` 三键含旧名；`cdpPort=9223, dataDir=./data/gaoh, promptsDir=./prompts, emailTo=[2 个邮箱], cover.mode=ffmpeg` | 同上 |
| alias 不可改 | `PUT /api/accounts/:id` 显式拒绝 `alias` 变更 | `src/console/server.ts:542` |
| 文章提示词 | `prompts/article.md` 用 `{{accountName}}` 变量 → **自动跟随改名** | `src/publisher.ts:buildArticlePrompt` |
| 唯一硬编码处 | `prompts/cta/gaoh.md:4` 写死「关注「gaoh的技术分享」」 | grep |
| 计划数据 | `plans` 表 **62 行 0 命中**；`data/gaoh/plans/*.json` 0 命中 | 250 查询 + grep |
| 已生成文章 | 8 个文件含旧名（frontmatter `author`；10-16 另有 CTA 行） | `grep -rc` |
| 仓库文本 | 26 处 / 12 文件（`config.example.json`、`README.md`、`docs/操作手册.md`、`tools/gen-grade9-plans.ts`、`prompts/cta/gaoh.md`、`AGENT.md`、归档任务文档） | grep |
| 控制台凭据 | 250 本机 `.credentials-note`（「控制台账号/密码」），已有可复用的登录范式 | `tools/upload-plans-250.py:79–104` |

## 用户决策（已确认）

- **D1 定位调整**：顺势调成「**每天一个理科小道理**」——只体现在**对外文案/署名/CTA 收尾句**。
- **D2 别名 `gaoh` 保留**（`data/gaoh/`、cdp 9223、console `id=2`、systemd、计划文件路径都不动；PUT 本身也拒绝改 alias）。
- **D3 CTA 变体（V1/V2/V3）不在本任务范围**：本次只改名称与定位句，保持现有 V1 风格措辞。

## 需求

- **R1 真源改名**：经 `PUT /api/accounts/2` 更新 `overrides`（`displayName`/`author`/`subjectPrefix`）→ `syncConfigFile()` 回渲染 `config.json`；**无需重启**（worker 逐任务读盘）。
- **R2 署名与邮件**：`author = 每天讲点理`；`subjectPrefix = "[每天讲点理] "`（后续邮件标题随之变化）。
- **R3 文案对齐定位**：`prompts/cta/gaoh.md` 的账号名改为 `{{accountName}}` 占位符（**以后再改名无需动文案**），收尾句体现「每天一个理科小道理」。
- **R4 仓库文本同步**：`config.example.json`、`README.md`、`docs/操作手册.md`、`tools/gen-grade9-plans.ts`（含 gaoh 的视角/标题模板措辞）、`AGENT.md` 当前状态区。
- **R5 250 已生成文章**：8 个文件里的旧名替换为新名（含 `.math.md` 副本），使后续 `--reuse`/重发署名正确。
- **R6 历史记录边界**：`AGENT.md §9 变更日志`、`archive/**` 归档任务文档、`data/gaoh/{logs,sessions}` 属**历史事实记录**，本次保留旧名（另加一条改名记录说明 old→new）；如需一并替换，一条 `sed` 即可（待确认）。
- **R7 不动的东西**：`src/**`（零代码改动）、`plans` 数据（62 行）、历史已发布草稿（10-12~10-15 不回炉）、别名与目录结构、运行时依赖（零新增）。
- **R8 审计与可回滚**：改名经控制台 API → 自动写 `audit(account.update)`；执行前备份旧值（3 个字符串）；回滚 = 把 3 个字符串改回并再 PUT 一次。

## 验收标准

- **AC1**：250 `config.json` 的 `accounts.gaoh.{displayName,author,subjectPrefix}` = `每天讲点理` / `每天讲点理` / `[每天讲点理] `；`GET /api/accounts/2` 返回一致（真源与派生一致）。
- **AC2**：仓库 `grep -rn "gaoh的技术分享"` 仅剩**白名单**（历史记录类：`AGENT.md §9`、`archive/**`）；业务文件（config 示例/README/操作手册/prompts/tools）为 **0**。
- **AC3**：`prompts/cta/gaoh.md` 不再硬编码账号名（用 `{{accountName}}`），且渲染结果包含「每天讲点理」；文本含 ≥3 类动作词（引擎校验阈值）。
- **AC4**：250 `data/gaoh/articles/*.md`（8 文件）旧名 **0 命中**，`author:` 为新名。
- **AC5**：真机重发 10-16 gaoh：`publish --force --reuse` 日志 `cta: present`（文本已含引导语）→ `drafts -a gaoh --date 2026-10-16` 显示 `✅ 正文校验`；**草稿箱真实 DOM 末尾 320 字**含「每天讲点理」。
- **AC6**：`plans` 表 62 行与 `data/gaoh/plans/*.json` 未被改动（行数 + 内容抽样比对）。
- **AC7**：`bun build --target=bun src/cli.ts` 与 `bunx tsc --noEmit` 零错误（证明未误伤代码）。
- **AC8**：控制台 `audit` 表新增 `account.update`（`target=gaoh`）行作为改名留痕。

## 非目标

- 不改别名 `gaoh`、不改数据目录、不改 cdpPort。
- 不重写 211 天计划数据（`angle`/`titleSuggestion` 里的「技术视角」措辞属**历史数据**，如需按新定位重写，另立任务）。
- 不回炉历史已发布草稿（10-12~10-15）；不为改名新增 CLI 命令或代码路径。
- 不切换 CTA 变体（V1/V2/V3 选择另议）。
