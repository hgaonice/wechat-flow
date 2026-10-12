# wechat-flow · 多账号公众号内容编排与自动发布

用 **pi coding agent** 生成文章，并按周计划自动发布到微信公众号（草稿箱）。
不依赖 openclaw：调度用 systemd timer，生成用 pi CLI，发布用 `baoyu-post-to-wechat` skill 脚本。

> 📖 **日常操作、内容维护、账号开关、周与周衔接、manim 动图、LaTeX 公式、排障**
> → 看 **[操作手册.md](./docs/操作手册.md)**（全部命令均已真机实测）。
> 本文只讲项目结构与安装。

引擎本身**与题材无关**：选题依据是 `contentDir/syllabus.md`，文风与人设是 `promptsDir/`，
两者都由**每个账号分别指定**。默认账号 `second`（巧思初数）用初中数学那套；
换一个题材就是给新账号一套自己的 `content-*/` + `prompts-*/`，引擎代码不用动。

**支持多个公众号**：每个账号有独立的选题池、计划、文章、封面、幂等状态、日志、Chrome 登录态与通知收件人；
不指定账号时用默认号，`-a <alias>` 指定就用那个号，`--all` 对所有已启用账号依次执行。

```
┌─────────────┐  每周日 20:00   ┌──────────────────┐
│ systemd     │ ───────────────►│ cli.ts plan      │  pi agent 读取 syllabus + 已发布清单
│ timers      │                 │ → plans/Wxx.json │  对每个启用账号产出 7 天计划
│             │  每天 07:30     ├──────────────────┤
│             │ ───────────────►│ cli.ts publish   │  ① pi agent 写文章 md（--all 依次跑）
└─────────────┘                 │                  │  ② ImageMagick 生成封面
                                │                  │  ③ 会话自愈（必要时邮件二维码扫码）
                                │                  │  ④ Chrome CDP → 草稿箱
                                │                  │  ⑤ 回查草稿箱校验 → 邮件通知
                                └──────────────────┘
```

## 目录结构

```
wechat-flow/
├── config.json            # 运行配置（由 config.example.json 复制而来）
├── src/                   # 应用代码（TypeScript，bun 直接运行，零依赖）
│   ├── pi.ts              # pi CLI 集成（--print --mode json）+ 重试/模型降级
│   ├── planner.ts         # 周编排
│   ├── publisher.ts       # 每日生成 + 发布 + 草稿校验
│   ├── wechat.ts          # 调用 baoyu skill + 草稿箱查询 + **正文校验 verifyDraftBody**
│   ├── browser.ts         # Xvfb + Chrome CDP 生命周期（冷启动/清理僵尸 socket）
│   ├── session.ts         # 登录态自愈（检查→截图二维码→邮件→轮询扫码）
│   ├── cover.ts           # ImageMagick 模板封面
│   ├── state.ts           # published.json 幂等状态
│   ├── mailer.ts          # 调用 email-sender skill 发通知
│   ├── notify.ts          # 通知分发
│   ├── config.ts          # 配置加载（多账号解析 / 按账号隔离路径）
│   └── cli.ts             # 命令行入口（-a <alias> / --all）
├── bin/send-image.py      # 用 email-sender 的 SMTP 凭据把图片作为附件发出（二维码）
├── prompts/               # 提示词（editor / plan / article）——可被单账号覆盖
├── content/syllabus.md    # 初中数学知识点大纲（选题依据）——可被单账号覆盖
├── data/<alias>/          # 每个公众号独立的数据根（互不干扰）
│   └── plans/ articles/ imgs/ state/ logs/ sessions/
└── deploy/                # systemd service/timer + install.sh + deploy.sh + patch-baoyu-skill.sh
```

> 账号隔离靠两点：**独立数据目录**（`data/<alias>/`）和**独立 Chrome 调试端口**（`cdpPort`）。
> 后者关键：skill 是按 `--cdp-port` 附着到「已经在跑的那个 Chrome」的，如果两个账号共用端口，
> 第二个账号会把稿子发进第一个账号的登录态里。

## 安装

```bash
# 0) 目标机依赖（浏览器发布方式，Debian/Ubuntu）
apt-get install -y xvfb xclip xdotool imagemagick   # Chrome 需已安装（本项目 /usr/bin/google-chrome）

# 1) 部署代码到目标机（此处为 192.168.0.250）
#    用带护栅的部署脚本：单一源 + --checksum + 运行时目录排除，且**不会静默覆盖内容**
./deploy/deploy.sh -n          # 先预演，看清会改什么
./deploy/deploy.sh             # 正式部署
#    它做的事：
#      · 只用一个源（多个源 + --delete 会清空目标目录——本项目踩过）
#      · 排除 config.json / data/ / plans/ / articles/ / state/ / imgs/ / sessions/ / logs/ / .env
#      · 部署前比对 content/ 与 prompts/：250 上有真实改动就**拦下并要求你选择**（见下节）
#    想看/手写原始命令：
#      rsync -a --checksum --delete --exclude config.json --exclude 'data/' \
#            --exclude 'plans/' --exclude 'articles/' --exclude 'state/' \
#            --exclude 'imgs/' --exclude 'sessions/' --exclude 'logs/' \
#            ./ root@192.168.0.250:/root/wechat-flow/

# 2) 打 skill 补丁（自适应：上游 >=1.118.2 已原生修复会自动跳过；
#    只装旧版时必做，否则浏览器发布会把正文写空。幂等）
ssh root@192.168.0.250 '/root/wechat-flow/deploy/patch-baoyu-skill.sh'

# 3) 生成配置
ssh root@192.168.0.250 'cd /root/wechat-flow && cp config.example.json config.json && chmod 600 config.json'

# 4) 自检（pi / bun / convert / skill / 补丁 / Chrome / Xvfb / email）
ssh root@192.168.0.250 'cd /root/wechat-flow && DISPLAY=:99 bun src/cli.ts doctor'

# 5) 首次登录公众号（截图二维码并发到邮箱，扫码后自动继续）
#    多账号：每个账号都要单独登录一次（各自独立的 Chrome profile）
ssh root@192.168.0.250 'cd /root/wechat-flow && DISPLAY=:99 bun src/cli.ts login --wait 900'          # 默认号
ssh root@192.168.0.250 'cd /root/wechat-flow && DISPLAY=:99 bun src/cli.ts login -a gaoh --wait 900' # 指定号

# 6) 安装并启动定时器（install.sh 会再打一次补丁）
ssh root@192.168.0.250 'bash /root/wechat-flow/deploy/install.sh'
```

## 手动使用

```bash
cd /root/wechat-flow
export PATH=/root/.nvm/versions/node/v24.14.1/bin:$PATH HOME=/root DISPLAY=:99

# 生成本周 7 天计划（写入 plans/2026-W42.json）
bun src/cli.ts plan

# 生成并发布今天的文章（草稿箱）
bun src/cli.ts publish

# 只生成、不发布（dry-run）
bun src/cli.ts publish --dry-run

# 复制上一次的 md，跳过重新生成，只重跑发布
bun src/cli.ts publish --reuse

# 忽略已发布记录，强制重发（修复历史草稿用）
bun src/cli.ts publish --date 2026-10-12 --force --reuse

# 指定日期
bun src/cli.ts publish --date 2026-10-20

# 登录公众号（截图二维码 → 邮件 → 等扫码）；--wait 指定等待秒数
bun src/cli.ts login --wait 900

# 查看草稿箱；带 --date 会校验当天文章是否在草稿箱中（标题 + **正文字数**）
bun src/cli.ts drafts
bun src/cli.ts drafts --date 2026-10-13

# 草稿封面自动上传（O-B）。--probe 只读探测封面弹窗 DOM，不改任何内容
bun src/cli.ts cover --date 2026-10-13
bun src/cli.ts cover --date 2026-10-13 --probe
bun src/cli.ts cover --date 2026-10-13 --title "标题" --cover /path/cover.png

# 查看状态 / 已发布清单
bun src/cli.ts status
bun src/cli.ts status --all

# —— 多账号 ——
bun src/cli.ts accounts                # 列出所有公众号（★ 默认 / 启用 / 停用）
bun src/cli.ts publish -a gaoh         # 指定公众号
bun src/cli.ts publish --all           # 对所有已启用公众号依次执行
bun src/cli.ts plan -a gaoh            # 给指定号重新编排
bun src/cli.ts drafts -a gaoh          # 看指定号的草稿箱
bun src/cli.ts doctor --all            # 逐个账号自检
```

## 多公众号（多账号）怎么用

**1. 在 `config.json` 声明账号**

```json
{
  "defaultAccount": "second",
  "accounts": {
    "second": { "displayName": "巧思初数", "cdpPort": 9222, "enabled": true,
                "dataDir": "./data/second", "subjectPrefix": "[巧思初数] ",
                "emailTo": ["2199382542@qq.com"] },
    "gaoh":   { "displayName": "gaoh的技术分享", "cdpPort": 9223, "enabled": true,
                "dataDir": "./data/gaoh", "contentDir": "./content-tech",
                "subjectPrefix": "[gaoh的技术分享] ", "emailTo": ["me@example.com"] }
  }
}
```

**2. 选择规则**（优先级从高到低）

| 场景 | 结果 |
|------|------|
| `bun src/cli.ts publish` | 用 **默认号**（`defaultAccount`） |
| `bun src/cli.ts publish -a gaoh` | 用 **gaoh** |
| `MW_ACCOUNT=gaoh bun src/cli.ts publish` | 用 **gaoh**（环境变量，方便给 systemd 单独配） |
| `bun src/cli.ts publish --all` | 依次跑所有 `enabled: true` 的账号 |
| 别名写错 | 直接报错并列出可用别名，**不会**静默退回到默认号 |

**3. 每个账号可独立覆盖的项**

| 键 | 说明 |
|----|------|
| `displayName` / `author` | 文章署名、封面副标题、邮件标题 |
| `cdpPort` | **必须唯一**（9222 / 9223 / …）——决定用哪个 Chrome 实例 |
| `dataDir` | 数据根，默认 `./data/<alias>`，含 plans/articles/imgs/state/logs/sessions |
| `contentDir` / `promptsDir` | 内容主题不同时各自一套大纲与人设（默认 `./content`、`./prompts`） |
| `theme` / `color` | 排版主题与主题色 |
| `enabled` | `--all` 是否包含它；**新号先设 `false`**，登录成功后再改 `true` |
| `subjectPrefix` / `emailTo` | 通知邮件标题前缀与收件人 |
| `model.plan` / `model.article` | 该号专用的模型与降级链 |
| `publishMethod` / `draftOnly` | 该号的发布方式 |

**4. 换题材（不同内容类型）**

题材 = `contentDir`（知识点大纲/选题依据）+ `promptsDir`（人设与写作风格）+ `model`（可选，便宜的题材用便宜模型）。
新建一套目录即可，引擎零改动：

```bash
mkdir -p content-tech prompts-tech
cp prompts/editor.md prompts/plan.md prompts/article.md prompts-tech/   # 当模板改
# content-tech/syllabus.md 写这个题材的知识点池
```

```json
"gaoh": { "displayName": "gaoh的技术分享", "cdpPort": 9223, "enabled": true,
          "contentDir": "./content-tech", "promptsDir": "./prompts-tech",
          "model": { "plan": { "model": "agentrouter/deepseek-v4-flash", "thinking": "medium" },
                     "article": { "model": "justwoker/claude-opus-4-8", "thinking": "medium" } } }
```

数据（`data/<alias>/`）、登录态（Chrome profile）、通知收件人、定时任务也都各自独立，
所以「一个数学号 + 一个技术号 + 一个英语号」可以完全并行。

**5. 新增一个公众号的完整步骤**

```bash
# ① 加配置：追加 accounts.<新别名>，cdpPort 用没占用的端口，enabled 先设 false
#    同时确认该号 app_id/secret 已写入 skill 的账号表：
#    /root/.baoyu-skills/baoyu-post-to-wechat/EXTEND.md
# ② 登录（二维码发到邮箱；加 --qr 可主动发）
bun src/cli.ts login -a <新别名> --wait 900 --qr
# ③ 自检（会检查 CDP 端口是否与其他账号冲突）
bun src/cli.ts doctor -a <新别名>
# ④ 试跑（只生成、不发布）
bun src/cli.ts publish -a <新别名> --dry-run
# ⑤ 正式跑一次，确认草稿进了「这个号」的草稿箱
bun src/cli.ts publish -a <新别名>
bun src/cli.ts drafts  -a <新别名>
# ⑥ 一切正常后把 enabled 改成 true
```

## 配置要点（config.json）

| 键 | 说明 |
|----|------|
| `defaultAccount` | 默认公众号别名；不指定 `-a` 时用它 |
| `accounts` | 账号表（别名 → 覆盖项），见上一节 |
| `publishMethod` | `api`（需 IP 白名单）或 `browser`（Chrome CDP，本项目默认） |
| `browser` | 浏览器方式参数：`display`/`cdpPort`/`chromePath`/`width`/`height`/`loginWaitSec` |
| `model.plan` / `model.article` | 模型、思考等级、`fallbacks`（降级模型链） | 
| `cover.mode` | `template`（ImageMagick，默认）/ `agent`（由 pi 调 baoyu-cover-image） |
| `cover.uploadToDraft` | `true` 时浏览器发布后自动把 `cover.png` 传为草稿封面（O-B，默认 `false`）。失败降级为后台手选，不影响发布 |
| `notify.telegram` | 可选；`botToken` 也可由 `.env` 的 `TELEGRAM_BOT_TOKEN` 提供 |
| `notify.email` | 可选；推送草稿箱后向指定邮箱发通知（见下节）。`pass` 建议用 `.env` 的 `SMTP_PASS` |
| `proxy` | pi 的联网工具与微信 API 走的代理；`noProxy` 已包含内网网段 |

模型 ID 来自 250 上 `/root/.pi/agent/models.json` 配置的 provider，例如
`agentrouter/deepseek-v4-flash`（便宜，适合编排）、
`justwoker/claude-opus-4-8`（默认，适合正文）。

### 模型重试与降级（重要）

pi 在**上游失败时仍以 exit 0 退出**（错误只出现在事件流里），因此 `src/pi.ts` 会：

1. 监听 assistant 事件的 `stopReason`/`errorMessage`，把 `503 all nodes exhausted`、`402 quota`
   等上游错误当作失败；
2. 对同一模型重试（`retries`，默认 1 次，间隔 30s）；
3. 仍失败则依次尝试 `model.*.fallbacks` 中的下一个模型。

实测（Claude 全池不可用时）：

```
[pi] attempt 1 failed (provider: 503 all nodes exhausted); retrying in 30s
[pi] model justwoker/claude-opus-4-8 unavailable; trying fallback agentrouter/claude-opus-4-8
... trying fallback anyrouter/claude-opus-4-7
... trying fallback anyrouter/claude-sonnet-4-5-20250929
... trying fallback agentrouter/deepseek-v4-flash   → 成功
```

## 邮件通知（推送草稿箱后）

直接复用 250 上已装并配置好的 **`email-sender` skill**（python3 + QQ SMTP，账号/授权码在其
`config.env` 中），应用不再自己实现 SMTP，只负责调用：

```bash
python3 /root/.claude/skills/email-sender/scripts/send-mail.py \
  -b "<通知正文>" [-f "<文章.md>"] -s "<主题>" [-t "<收件人>"]
```

> skill 同时支持 `-b` 正文与 `-f` 附件：正文渲染为 HTML 通知，文章作为 `.md` 附件。

配置 `config.json`：

```json
"notify": {
  "email": {
    "enabled": true,
    "on": "publish",          // publish=仅发布事件发邮件；all=编排也发
    "to": [],                  // 留空=用 skill 的默认收件人；可填多个
    "subjectPrefix": "[巧思初数] ",
    "attachArticle": true,     // 附带文章 .md 附件（-f）
    "skill": {
      "dir": "/root/.claude/skills/email-sender",
      "python": "python3"
    }
  }
}
```

发送内容：日期/星期/模块/选题/标题/字数/account/`media_id`/正文与封面路径/时间，
并注明「已进入草稿箱，请登录后台确认并群发」。

测试发信（不传 `--to` 则发给 skill 默认收件人）：

```bash
cd /root/wechat-flow
export PATH=/root/.nvm/versions/node/v24.14.1/bin:$PATH HOME=/root
bun src/cli.ts mail-test
bun src/cli.ts mail-test --to someone@163.com
# 二维码附件测试
python3 bin/send-image.py -i state/wechat-login-qr.png -s "测试图片" -b "测试" -t someone@163.com
```

> 更换发件账号/授权码：编辑 `/root/.claude/skills/email-sender/config.env`。

## 调度

| Timer | 时间 | 动作 |
|-------|------|------|
| `wechat-plan.timer` | 每周日 20:00（Asia/Shanghai） | `cli.ts plan --all` |
| `wechat-publish.timer` | 每天 07:30（Asia/Shanghai） | `cli.ts publish --all` |

`--all` 会按 `config.json` 里 `enabled: true` 的账号**依次**执行（各账号独立数据目录 + 独立 CDP 端口）。
只跑默认号就把 service 里的 `--all` 去掉；要给某个号单独配时间，复制一份 unit 并加
`Environment=MW_ACCOUNT=<alias>`。

```bash
systemctl list-timers 'math-*' --no-pager
systemctl start wechat-publish.service          # 立即手动跑一次
journalctl -u wechat-publish.service -n 120 --no-pager
```

两个 timer 均 `Persistent=true`（错过的任务开机后会补跑）。`wechat-publish.service` 设置了
`DISPLAY=:99` 与 `XDG_RUNTIME_DIR=/tmp/runtime-root`，并给足 `TimeoutStartSec=3000`
（模型降级重试 + 生成 + 发布 + 校验可能需要几分钟）。

> systemd 默认 `KillMode=control-group`，oneshot 结束后会 SIGKILL 掉 detached 的 Xvfb/Chrome；
> `browser.ts` 会在下次运行时清理僵尸 X socket 与 Chrome Singleton 锁并重新拉起，已实测通过。

## 已实测验证（2026-10-12）

| 项目 | 结果 |
|------|------|
| `doctor` | 全部通过（含 browser: Chrome CDP :99 / :9222） |
| 周编排 | `plan` 产出 `plans/2026-W42.json`（7 天选题） |
| 端到端发布 | `publish --date 2026-10-12` → 正文 2415 字，**草稿箱已确认**，邮件已送达 |
| systemd 冷启动发布 | `publish --date 2026-10-13`（Xvfb/Chrome 全死后）→ 正文 3202 字，**草稿箱已确认**，邮件已送达，6min49s |
| 模型降级 | Claude 全池不可用时自动降级到 `agentrouter/deepseek-v4-flash`，日志逐次记录 |
| 草稿持久性 | 发布后 6 分钟内每分钟回查，一直存在 |
| 回归 | 早期 skill 的「假成功」已由草稿箱回查捕获 |
| 多账号隔离 | 两个账号各自 Chrome 同时在线（:9222 profile=wechat-second / :9223 profile=wechat-gaoh），草稿箱查询互不串号 |
| 多账号迁移 | 旧扁平目录一次性迁入 `data/second/`，`status` 仍显示 2 篇已发布 + `plans/2026-W42.json` |
| 别名校验 | `-a nope` 报错并列出可用别名（`second, gaoh`），退出码 1 |
| **空正文事故复现** | 2026-10-12 复查发现：两个号所有草稿**只有标题、正文为空**。根因见下方「⚠️ 空正文事故」 |
| **`--force` 重发** | `publish --force --reuse` 重发 gaoh 10-12 / second 10-12 / second 10-13 |
| **正文校验** | 后台实测正文：gaoh 2391 字 / second 2806 字 / second 3741 字，**均为 ✅** |
| **skill 升级** | `baoyu-post-to-wechat` 1.56.1 → **1.118.2**（`clawhub update`）；上游已原生修复，补丁自动跳过；升级后重新端到端实测 ✅ |
| **部署防呆** | `deploy/deploy.sh`：一致→放行；250 改内容→拦下(exit 1)；250 多文件→报 `*deleting`；`--force-content`→先备份再覆盖 ✅ |
| **排版保留** | 校验草稿正文 DOM：`<h2>`×6、`<p>`×32、`<strong>`×34、`<ul>`×7、`<li>`×25、引用×5 |


## ⚠️ 空正文事故与 skill 补丁（必读）

**现象**：点开草稿箱里的文章，**只有标题，正文是空的**（编辑器里还显示占位符「从这里开始写正文」）。

**根因（两层假校验叠加）**

1. 新版公众号编辑器页面里有**多个 `.ProseMirror` 节点**，而 `document.querySelector('.ProseMirror')` 命中的是**标题框**（父元素 `title-editor__input`），真正的正文在 `.rich_media_content` 下面。上游 `wechat-article.ts` 就是用这个选择器点「正文」的。
2. 正文不是用 DOM 写入的，而是把 HTML 渲染成临时 `file://` 页 → 选中 `#output` → 复制 → 切回编辑器 → 粘贴，而复制/粘贴走的是 `xdotool key ctrl+c / ctrl+v`。**headless Xvfb 下没有窗口管理器**，按键找不到可靠的焦点窗口；再加上开/关那个临时标签页会把编辑器页的 DOM 焦点重置掉，粘贴就静默丢了。
3. 而 skill 自己的「正文非空」校验是 `document.querySelector('.ProseMirror').innerText.length > 0` —— 标题早就填好了，**所以它永远报 “Body content verified OK”**。
4. 我们自己的 `verifyDraftPublished()` 当时也只比对草稿**标题**，于是又一层假阳性：
   `draft verified in 草稿箱 ✓` 其实是「标题在」而不是「文章在」。

**修复**

- `src/wechat.ts` 新增 **`verifyDraftBody()`**：打开草稿编辑页，只读 `.rich_media_content .ProseMirror` 的正文长度（并剔除「从这里开始写正文」占位符），低于阈值即判失败。发布流程里标题校验通过后**必须再过这一关**。
- `deploy/patch-baoyu-skill.sh`：给上游 skill 打两处补丁（幂等、自动备份为 `wechat-article.ts.orig`）
  - **v1**：所有正文相关选择器改为 `.rich_media_content .ProseMirror`；复制/粘贴改用 **CDP 编辑命令** `Input.dispatchKeyEvent { commands: ['copy'|'paste'] }`（在 Blink 内部执行，**完全不需要 X 焦点**）。
  - **v2**：粘贴前**重新聚焦正文**（保留正文内已有选区，以免破坏图片占位符插入流程）。
- `doctor` 新增 `skill 补丁（正文写入）` 检查项；`deploy/install.sh` 会自动打补丁。
- `--force` 支持忽略已发布记录重发；`publish` 失败时会写 `published.json(ok:false)` 并发失败邮件，**不会**再默默记成成功。

**skill 版本：已升级到 `1.118.2`（上游已原生修复）**

上游在 v1.118.2 里**独立修了同一个 bug**，而且比我们的补丁更严谨：

| | 我们打的补丁（v1.56.1） | 上游 v1.118.2 |
|---|---|---|
| 正文选择器 | `.rich_media_content .ProseMirror` | 同（`BODY_EDITOR_SELECTOR`） |
| 复制/粘贴前 | CDP `commands:['copy'/'paste']` | `Target.activateTarget` 先激活标签页 |
| 粘贴前聚焦 | `focus()` + 末尾 caret | `prepareEditorPasteTarget()`：检查 `document.activeElement`/选区，**能识别 `#title/#author/#js_description` 抢焦**，不对就修复，修不好就**直接报错** |
| 自检 | 我们外部量正文字数 | 同选择器，自检终于真实 |

> 已在 250 上实测：新版本独立发布 → 正文 2298 字 / `<h2>`×6 / `<strong>`×34；
> 走本应用完整链路（`publish --force --reuse`）→ 正文 2391 字 ✅。

因此 `deploy/patch-baoyu-skill.sh` 现在是**自适应的**：

- 检测到上游已修（`BODY_EDITOR_SELECTOR` + `prepareEditorPasteTarget`）→ **跳过，不动文件**；
- 只装了旧版（如 1.56.1）→ 照旧打 v1+v2 补丁。

`doctor` 的检查项也从「补丁是否存在」改成**能力检查**：

```
✅ skill 正文写入能力  正文选择器 + 粘贴前聚焦 ✓ (上游原生修复)
```

**升级步骤**（以后升级 skill 用这个）：

```bash
# 备份 + 升级（--force 因为本地可能被补丁改过 / 需要覆盖）
ssh root@192.168.0.250 'tar czf /root/baoyu-post-to-wechat.$(date +%F).tgz -C /root/.agents/skills baoyu-post-to-wechat'
ssh root@192.168.0.250 'export http_proxy=http://127.0.0.1:7890 https_proxy=http://127.0.0.1:7890; \
  clawhub --workdir /root/.agents update baoyu-post-to-wechat --force'
# 装依赖（升级后 node_modules 会丢，需联网；代理已开）
ssh root@192.168.0.250 'export http_proxy=http://127.0.0.1:7890 https_proxy=http://127.0.0.1:7890; \
  cd /root/.agents/skills/baoyu-post-to-wechat/scripts && bun install'
# 重打补丁（新版本会自己跳过）+ 自检
ssh root@192.168.0.250 '/root/wechat-flow/deploy/patch-baoyu-skill.sh; cd /root/wechat-flow && bun src/cli.ts doctor --all'
```

升级依赖清单：`baoyu-md` `baoyu-chrome-cdp` `jimp` `@jsquash/webp` `socks`（旧版把前两个 vendor 到 `scripts/vendor/`，新版从 npm 拉），联网走代理。

**修复前后对比（2026-10-12 实测）**

| | 修复前 | 修复后 |
|---|---|---|
| `publish` 日志 | `draft verified in 草稿箱 ✓`（假） | `draft verified in 草稿箱 ✓` + `draft body verified ✓ body=2391 chars` |
| 草稿正文 | 0 字，只有占位符 | 2391 字，含 6 个 `<h2>`、34 处 `<strong>`、7 个列表 |

> 后续又把 skill 升级到上游 v1.118.2（它已原生修复同一问题），本补丁自动退化为 no-op；
> 无论哪条路径，**`verifyDraftBody()` 始终是最后一道闸**。

**自查命令**（任何时候怀疑草稿是空的）：

```bash
bun src/cli.ts drafts -a second --date 2026-10-12
# ✅ 正文校验: ✅ 正文正常 (body=2806 chars («开学一个多月…») (min 200))
```

## content/ 与 prompts/ 谁是真源（内容维护策略）

这是**策略层的决定，不是功能**：`content/`（选题大纲）和 `prompts/`（提示词）放哪、改了怎么发布。
它和「要不要做 Anki/Manim 之类的功能」是两件事，但必须先定，否则改东西会丢。

### 已定：**本地仓库是真源**

```
改大纲 / 提示词 → 改本地仓库 → ./deploy/deploy.sh → 250
```

理由：应用、代码、内容都在同一个仓库里，diff/回溯/多账号扩展都靠 git；
新机器/新号上线时也能一次丢过去，不会出现「代码有、内容没有」。

### 防呆：250 上被改过会被拦下来

以前这个决定是隐形的：rsync **不排除** `content/` `prompts/`，在 250 上改的任何东西
下一次部署就被静默覆盖。现在 `deploy/deploy.sh` 会先比对，发现真实差异（增/删/改）就中止：

```
⚠️  250 上的 content/ 或 prompts/ 与本地有真实差异（本地部署会覆盖它们）：
      <fcst...... syllabus.md
      *deleting   only-on-250.md
当前策略：**本地仓库为真源**。请选一个：
  1) 想保留 250 上的改动 → 先把它们同步回本地仓库，再重新部署
       rsync -av root@192.168.0.250:/root/wechat-flow/content/ ./content/
       rsync -av root@192.168.0.250:/root/wechat-flow/prompts/ ./prompts/
  2) 以后就想在 250 上改 → ./deploy/deploy.sh --keep-remote-content
  3) 确认要丢弃 250 的改动 → ./deploy/deploy.sh --force-content   # 先自动备份到 data/_content-backup/<时间戳>/
```

> 只看**内容增删改**；仅 mtime 不同的文件（`.f..t`）不算冲突，不会误导报错。

### 如果你想反过来（250 为真源）

```bash
./deploy/deploy.sh --keep-remote-content
```

即 rsync 时加 `--exclude 'content/' --exclude 'prompts/'`：代码照常更新，内容不动。
适合「在 250 上直接编辑、且只有这一台机器会改内容」的工作方式。代价是内容脱离 git，
且换机器/加账号时要手动搬。

## pi 集成方式

采用**CLI 子进程 + JSON 事件流**（`pi --print --mode json`），而不是进程内 SDK，原因：

- 与 pi 版本解耦（目标机 pi 1.0.2 即可，无需在应用内安装同版本 SDK）；
- 复用 pi 已有的认证、模型/provider 配置、skill 自动发现（`~/.agents/skills`）；
- 事件流可审计：`src/pi.ts` 逐行解析 JSONL，取最后一条 assistant `message_end` 作为最终文本；
- 通过 `--append-system-prompt prompts/editor.md` 注入编辑人设，`--session-id` 保留可追溯会话。

如需进程内 SDK 集成（`createAgentSession`），可在 `src/pi.ts` 之外另加 `src/pi-sdk.ts`，
但需在应用内 `npm i @earendil-works/pi-coding-agent` 并保持版本一致。

## 发布方式：浏览器 CDP（Plan C，本项目采用）

微信 API 发布要求服务器出口 IP 在公众号后台「基本配置 → IP 白名单」中。本项目实测返回
`40164 invalid ip 117.152.69.124 ... not in whitelist`，且家庭宽带 IP 会变化，因此**改用浏览器方式**：
用应用自己管理的 Chrome（已登录公众号后台）在 `mp.weixin.qq.com` 里模拟人工排版并保存为草稿，
不经过 `api.weixin.qq.com`，**完全绕过 IP 白名单**。

### 运行机制（`src/browser.ts` + `src/session.ts`）

| 环节 | 做法 |
|------|------|
| 显示 | 无头 `Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp`（detached） |
| 浏览器 | `google-chrome --no-sandbox --disable-dev-shm-usage --remote-debugging-port=9222 --user-data-dir=/root/.local/share/baoyu-skills/wechat-second`（detached） |
| 冷启动 | 检测僵尸 `/tmp/.X11-unix/X99` 与 `SingletonLock/Cookie/Socket` 并清理，再启动；已实测 systemd 每次杀掉 Xvfb/Chrome 后能自动恢复 |
| 登录态 | 先等 20s 宽限（冷启动 SPA 恢复）：URL 含 `token=` 或 `/cgi-bin/home` 则通过 |
| 登录态失效 | 截图二维码 → 用 `bin/send-image.py` 邮件发出 → 轮询至 `loginWaitSec`（默认 900s）等扫码，**自愈** |
| 发布 | `bun .../wechat-article.ts --markdown <md> --theme default --color blue --account second --title ... --author ... --summary ... --cdp-port 9222`（skill 内部点 `#js_submit` 保存草稿） |
| 封面 | 默认**不上传**；开 `cover.uploadToDraft` 后，在正文校验通过后用同一 CDP 会话驱动编辑器封面弹窗上传 `cover.png`（O-B，失败降级为后台手选，见下） |
| 结果校验 | **不信任 skill 的成功提示**（它无条件打印 `Done. Browser window`），而是通过 CDP 在已登录页面里查草稿列表 `action=list_ex`（**本账号草稿 `type=77`**，兼容 `type=10`），标题匹配才计成功 |
| 收尾 | 关闭 skill 残留的编辑器 tab，避免长期运行堆积 tab |

> ⚠️ **封面**：skill 的浏览器流程只保存正文到草稿箱，**不会上传封面**。封面由 ImageMagick
> 生成到 `imgs/<date>/cover.png`。打开 `cover.uploadToDraft` 后，发布流程会用 CDP 自动上传为草稿封面（O-B）；
> 若未开启或上传失败，仍需在公众号后台手动选为封面（通知邮件会提醒）。
>
> 首次启用前建议在真机跑一次只读探针校准选择器：`bun src/cli.ts cover --date <d> --probe`。

相关命令：

```bash
# 查看草稿箱（真正存在才算数）
bun src/cli.ts drafts
bun src/cli.ts drafts --date 2026-10-13   # → ✅ 已确认在草稿箱

# 从冷启动跑一次完整发布（systemd 环境）
systemctl start wechat-publish.service
journalctl -u wechat-publish.service -n 120 --no-pager
```

> 踩坑记录：skill（v1.56.1）的 `wechat-article.ts` 在失败时也会打印 `Done. Browser window`，
> 早期用它判断成功导致「假成功」。现已改为回查草稿箱；查不到就报失败并邮件告警。

### 若改用 API 方式

若将来把出口 IP 加入白名单，可把 `publishMethod` 改回 `"api"`，并在后台配置 IP 白名单：

```bash
# 查看出口 IP
curl -s https://ifconfig.me; echo
# 直接测 token
curl -s 'https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=wx2d152d122e03a77d&secret=<SECRET>'
```

## 幂等与审计

- 每个日期发布成功后写入 `state/published.json`；重复运行会自动跳过。
- 重复生成而不重复发布：`--reuse`；只生成不发布：`--dry-run`。
- 文章 `articles/<date>-<slug>.md`、封面 `imgs/<date>/cover.png`、`logs/`、`sessions/` 均留档。
- 失败会记录 `ok:false` 与错误信息，并发邮件告警（若启用）。
- 发布**成功与否以草稿箱回查为准**，不信任 skill 的成功提示。
