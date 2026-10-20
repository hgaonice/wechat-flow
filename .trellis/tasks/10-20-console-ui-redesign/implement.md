# 实施计划（C3）：控制台前端设计系统重构

> 契约见 `design.md`（S-1…S-7）。**一页一 commit，每步独立可验收、可回滚。**
> 全程红线：0 运行时依赖 · 0 构建链 · 0 内联 `style=` · 不改后端 API。

---

## Step 0 · 基线（先能"看见"再改）

- [x] 0.1 落库截图脚本 `tools/ui-visual.py`（Python Playwright 1.64，本机已有；**不进 package.json**）
  - 参数：`--base-url`（默认 `http://127.0.0.1:8787`）`--page all|<name>` `--theme dark|light|both` `--update`（写基线）`--diff-dir`
  - 首轮以 `--update` 生成 **现状 7 页 × dark** 基线 → `tools/ui-baselines/`（这是"改之前"的样子，作为回滚参照，不与终版共用文件名：存 `<page>-before.png`）
  - 断言与失败口径：`console` 有 `error` / 触发 `securitypolicyviolation` / 关键元素不可见 → 退出码 2 并列出原因（不静默）
- [x] 0.2 落库静态闸门 `tools/ui-gates.sh`（G1–G5，见 design §9.1；Step 7 前 G4 只警告不失败）
- [x] 0.3 记录现状类清单：`grep -ho 'class="[^"]*"' src/console/ui/*.html | sort -u` → 存 `tools/ui-baselines/classes-before.txt`（迁移时对照，避免漏迁）
- [x] 0.4 起本地控制台跑通基线（`bun src/console/main.ts` 或既有启动方式；登录用临时管理员）

**Done**：`bash tools/ui-gates.sh` 全绿（G4 除外）；`python3 tools/ui-visual.py --theme dark --update` 生成 7 张 `*-before.png` 且无 error 断言。

---

## Step 1 · DS-1 令牌 + 布局骨架（结构变、观感只变导航）

**新增**
- [x] 1.1 `src/console/ui/ds.css`：§4 全部令牌 + §7 布局（`.ds-sidebar/.ds-nav/.ds-topbar/.ds-content/.ds-scrim`）+ 极简 base（`box-sizing`、`:focus-visible`、`.ds-sr-only`、`.ds-no-anim`）
- [x] 1.2 `src/console/ui/ds.js`：`DS.mount()`（design §3 的纯搬移）+ `DS.setTheme/theme` + 汉堡按钮（<768）+ 幂等与 `catch` 降级
- [x] 1.3 7 个 HTML 各加两行：`<link rel="stylesheet" href="/ds.css">`（在旧 CSS 之前）、`<script src="/ds.js" defer>`（在页面 js 之前）；`<head>` 加 `<meta name="color-scheme" content="dark light">`

**Gate 1（人工 + 自动）** ✅ 2026-10-20
- [x] `bash tools/ui-gates.sh` → G1/G2 绿
- [x] 逐页冒烟：登录 → 账号表有行 → 工作台能载入周期 → 会话列表能出 → admin 区块在 → 设置页在
- [x] `python3 tools/ui-visual.py --page all --theme dark` → 只有"导航从顶栏移到侧栏"的预期差异，**无 JS 错误、无 CSP 违规**
- [x] `#who` `#logout` `#nav-admin` `#account-name` 在 DOM 中存在（`ui-visual.py` 内置 DOM 断言）

> 本步**不动**任何业务 HTML/JS，不改观感（字体/卡片仍走旧 CSS）。回滚：删两行。

---

## Step 2 · DS-2 组件层 + `/_ds` 演示页 + 主题切换 + 可访问性

- [x] 2.1 `ds.css` 补齐 design §5 全部组件类（card/stat/table/badge/btn/field/tabs/dialog/toast/skeleton/empty/tip/工具类）
- [x] 2.2 `ds.js` 补 `toast()` / `confirm()`（原生 `<dialog>`）/ `icon()`（8 个内联 SVG）
- [x] 2.3 `src/console/ui/_ds.html` + `src/console/http/static.ts` 路由：`/_ds` 仅 `WFC_DS_PREVIEW=1` 可达，否则 404
- [x] 2.4 顶栏加主题切换按钮（`DS.setTheme`，`aria-pressed`），侧栏加 `aria-current="page"`，内容区前加 `.ds-sr-only` 跳转链接
- [x] 2.5 对比度实测：把两套主题的 `text/bg`、`muted/panel`、`accent/panel`、`danger/panel` 实测值写进 `design.md` §4 附注

**Gate 2** ✅ 2026-10-20
- [x] `WFC_DS_PREVIEW=1` 时 `/_ds` 200 且 14 个组件在 dark/light 都可渲染；未设该变量时 `curl -o /dev/null -w '%{http_code}' localhost:8787/_ds` = **404**
- [x] 主题切换后刷新仍保持（localStorage）；`prefers-color-scheme` 生效
- [x] 键盘走查：Tab 顺序 侧栏→顶栏→内容；`Escape` 关 dialog；focus ring 可见
- [x] `ui-visual.py --page _ds --theme both --update` 生成组件基线

---

## Step 3 · 迁移 `index`（账号表）+ `account`（详情/表单）

- [x] 3.1 `index.html` + `app.js` 渲染层：`.card`→`.ds-card`、`table`→`.ds-table`（包 `.ds-table-wrap`）、空态→`.ds-empty`、状态→`.ds-badge`、按钮→`.ds-btn--*`、表单→`.ds-field`
- [x] 3.2 表格首列显示**会话剩余时长**（C1 的只读 `session` 字段）用 `.ds-badge--ok/warn/danger`；无字段时显示 `.ds-badge--neutral 未知`
- [x] 3.3 `account.html` 同族迁移（表单 error 态用 `.is-invalid` + `aria-invalid`）
- [x] 3.4 新账号创建/改密码流程手工冒烟 + `ui-visual.py --page index,account --theme both`

**Gate 3** ✅ 2026-10-20：账号 CRUD 全通；表格窄屏可横滚不破版；`/api/accounts` 失败时显示 `.ds-empty` 而非空白区。

---

## Step 4 · 迁移 `settings` + `admin` + `login`

- [x] 4.1 `login.html`：居中卡片 + 错误用 `.ds-flash`（`role=status`，错误时 `role=alert`）；不建 sidebar
- [x] 4.2 `settings.html`：全局配置 `.ds-field` + `.ds-textarea`；用户/审计表格 `.ds-table`（审计用 `--compact`）
- [x] 4.3 `admin.html`：隧道状态 `.ds-stat` + `.ds-badge` + 当前地址 `.ds-mono` + 账号/隧道表 `.ds-table-wrap`（窄屏不再横滚）
- [x] 4.4 三页 `ui-visual.py --theme both`（`login/settings/admin` × dark/light = 6 张 `-step4.png`，0 error / 0 CSP / 0 缺失 id）

**Gate 4** ✅ 2026-10-20：登录失败仍是 `role=alert` 文本可见；admin 的「重启隧道 / 重发邮件」按钮可点，
`#tunnel-stats` 7 个 stat 在 1280 一屏内换行不溢出；settings 非法 JSON 不提交（前端先 `JSON.parse`）。

## Step 5 · 迁移 `workbench`（最重：版本链 / 对比 / SSE 进度）

> 与设计稿的偏差（2026-10-20，实测后修正）：原计划把工作台改成「左计划 / 中任务 / 右版本」三栏。
> 实测计划编辑表有 8 列可编辑输入，三栏会把它压到 500px 以内导致每格 <80px，反而不可用。
> 改为**纵向工作流**（账号 → 计划 → 生成/推送 → 任务历史 → 文章版本 → 详情），
> 详情内部才用 `.ds-split` 左右分栏（正文 2fr / 封面+校验+推送记录 1fr）。

- [x] 5.1 结构：`.ds-card` 纵向串起 6 个区块；详情用 `.ds-split`（<860px 降单栏）
- [x] 5.2 进度：`.ds-progress` + `.ds-progress__bar`（宽度由 JS 写 `el.style.width`，CSSOM 允许，无内联 `style=` 属性）；状态行 `.ds-status-line`
- [x] 5.3 版本链：`.ds-chips` + `.ds-chip.is-active`（版本选择器语义；`.ds-timeline` 保留给时间轴场景，`_ds` 页已演示）
- [x] 5.4 对比视图：`.ds-diff-box` 内 `.ds-diff__add/__del/__ctx`，加/删行整行浅底
- [x] 5.5 长内容：`.ds-md`（正文快照）与 `.ds-log`（SSE 日志）各自 `max-height` + 内部滚动；`.ds-log:empty` 不占位
- [x] 5.6 `ui-visual.py --page workbench --theme both`（2 张 `-step5.png`）；计划行输入改 `.ds-input--sm`（此前无类名 → 亮色主题下仍是深色输入框，已修）

**Gate 5** ✅ 2026-10-20：1440/1280/1024/390 四档 0 横向溢出；任务表/文章表在 390px 内部横滚
（`.ds-table-wrap`）；进度条与日志只更新文本/宽度，不重绘整块；生成/推送按钮为普通按钮，
重复提交仍由后端 job 去重兜底（沿用现状逻辑，本次未改）。

> 已知未验：真实 SSE 进度数字（dev 实例无 250 的 job 队列），留到 7.6 真机验收。

## Step 6 · 迁移 `chat`（气泡 / 决策卡片 / 流式）

- [x] 6.1 列表侧栏 `.ds-chat-list` + `.ds-chat-item(.is-active)` + `.ds-badge`；空态 `.ds-empty`（`margin:auto` 垂直居中）
- [x] 6.2 气泡：`.ds-bubble--user/--agent` + `.ds-bubble.is-system/.is-thinking`；工具行 `.ds-tools` + `.ds-tool-row(.is-error)` + `.ds-tool-row__name`
- [x] 6.3 决策卡片：`.ds-decision` + `.ds-decision__actions`；`window.confirm/prompt` 全部清零（删除会话/克隆 → `DS.confirm`；分叉/切模型 → 新增 `DS.prompt`）
- [x] 6.4 流式渲染逻辑未改，仅换类名（`is-streaming` 用 CSS `::after` 光标）
- [x] 6.5 错误消息 → `.ds-bubble__error`（红字）+ `.ds-bubble.is-error`（红边），不留空气泡

**Gate 6** ✅ 2026-10-20：`DS.prompt` 实测（标题/焦点/Enter 提交 → resolve "anthropic"，关闭后 dialog 移除）；
`DS.confirm` 取消 resolve `false`、danger 按钮类为 `ds-btn--danger`；空会话渲染 `.ds-empty` 而非空白区。

> 顺带修的真实缺陷：`chat.js` 一直在 `$("#tools")` 写工具行，但 `chat.html` 从未提供该容器 →
> `renderTools()` 每次抛 null 异常并中断 `openChat` 的 Promise。已补 `#tools` 容器 + 空时 `hidden`。

## Step 7 · 收尾：删旧 CSS、全量回归、文档

- [x] 7.1 删除 `app.css` / `chat.css` / `workbench.css`；`#who` 的 `muted` → `ds-muted`、`#logout` 的 `ghost` → `ds-btn ds-btn--ghost ds-btn--sm`；
`ui-gates.sh` 的 G4 改为 **token 感知**（`ds-btn--ghost` 不再被 `\bghost\b` 误判）并同时扫 `ui/*.js`，`--strict` 通过（0 残留）
- [x] 7.2 `python3 tools/ui-visual.py --page all --theme both --update` 生成 **16 张终版基线**（7 页 × dark/light + `_ds` × 2），
rerun 无差异；过程基线 `-before/-step1/-step3/-step4/-step5` 全部保留在 `tools/ui-baselines/`
- [x] 7.3 新增 `tools/ui-accept.py` 复跑 V1–V13 + V14（1440/1024/768/390 四档横向溢出）/ V15（主题往返持久化）：**15/15 PASS**；
证据写进 `report.md`
- [x] 7.4 文档：`.trellis/spec/console/index.md` 新增 §五之二「前端设计系统」（令牌/组件/JS API/8 条硬规则/闸门命令 + 3 条反模式）；
`src/README.md` ui 目录职责改写；`AGENT.md` S23 + 进度 + 变更日志；`TREE.md` 用 `bash tools/repomap.sh` 刷新
- [x] 7.5 最终闸门：`bash tools/ui-gates.sh --strict` **7 passed / 0 failed**（含 tsc --noEmit + bun build）
- [ ] 7.6 `deploy/deploy.sh --keep-remote-content` → 250 真机逐页点一遍（含 390px 窄屏）；commit + `task.py archive`

**Step 7 新发现并修复的缺陷**：删 `app.css` 后全站横向溢出 40px —— 其 `* { box-sizing: border-box }` 是全局兜底，
`main.ds-content` 的 `width:100% + padding:24px 20px` 依赖它。实测 `scrollWidth 1320 > clientWidth 1280`。
修复：`ds.css §2` 加作用域化的 `body.ds-mounted *, ::before, ::after { box-sizing: border-box }` → `1280 == 1280`。

---

## 验收对照（PRD → 本计划）

| PRD 项 | 落在 |
|---|---|
| DS-1 令牌 + 布局 | Step 1 |
| DS-2 组件 + `/_ds` | Step 2 |
| DS-3 逐页迁移 | Step 3–6 |
| AC-V 视觉回归 | Step 0/1/2/3–6 分页截图 + Step 7.2 终版 16 张 |
| AC-X 零依赖 | `ui-gates.sh` G5 + Step 7.5 |
| AC-F 功能等价 | Step 7.3（V1–V15，`tools/ui-accept.py`）+ 各步 Gate |

## 提交切分（一页一 commit）

```
feat(console-ui): 设计系统令牌 + sidebar 布局骨架（DS-1）
feat(console-ui): 组件类 + /_ds 演示页 + 主题切换（DS-2）
feat(console-ui): 迁移账号页与账号详情页
feat(console-ui): 迁移设置/运维/登录页
feat(console-ui): 迁移工作台（版本链/对比/进度）
feat(console-ui): 迁移 Agent 会话（气泡/决策卡/流式）
refactor(console-ui): 删除旧 CSS + 视觉回归基线（AC-V）
```
