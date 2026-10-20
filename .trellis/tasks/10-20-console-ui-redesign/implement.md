# 实施计划（C3）：控制台前端设计系统重构

> 契约见 `design.md`（S-1…S-7）。**一页一 commit，每步独立可验收、可回滚。**
> 全程红线：0 运行时依赖 · 0 构建链 · 0 内联 `style=` · 不改后端 API。

---

## Step 0 · 基线（先能"看见"再改）

- [ ] 0.1 落库截图脚本 `tools/ui-visual.py`（Python Playwright 1.64，本机已有；**不进 package.json**）
  - 参数：`--base-url`（默认 `http://127.0.0.1:8787`）`--page all|<name>` `--theme dark|light|both` `--update`（写基线）`--diff-dir`
  - 首轮以 `--update` 生成 **现状 7 页 × dark** 基线 → `tools/ui-baselines/`（这是"改之前"的样子，作为回滚参照，不与终版共用文件名：存 `<page>-before.png`）
  - 断言与失败口径：`console` 有 `error` / 触发 `securitypolicyviolation` / 关键元素不可见 → 退出码 2 并列出原因（不静默）
- [ ] 0.2 落库静态闸门 `tools/ui-gates.sh`（G1–G5，见 design §9.1；Step 7 前 G4 只警告不失败）
- [ ] 0.3 记录现状类清单：`grep -ho 'class="[^"]*"' src/console/ui/*.html | sort -u` → 存 `tools/ui-baselines/classes-before.txt`（迁移时对照，避免漏迁）
- [ ] 0.4 起本地控制台跑通基线（`bun src/console/main.ts` 或既有启动方式；登录用临时管理员）

**Done**：`bash tools/ui-gates.sh` 全绿（G4 除外）；`python3 tools/ui-visual.py --theme dark --update` 生成 7 张 `*-before.png` 且无 error 断言。

---

## Step 1 · DS-1 令牌 + 布局骨架（结构变、观感只变导航）

**新增**
- [ ] 1.1 `src/console/ui/ds.css`：§4 全部令牌 + §7 布局（`.ds-sidebar/.ds-nav/.ds-topbar/.ds-content/.ds-scrim`）+ 极简 base（`box-sizing`、`:focus-visible`、`.ds-sr-only`、`.ds-no-anim`）
- [ ] 1.2 `src/console/ui/ds.js`：`DS.mount()`（design §3 的纯搬移）+ `DS.setTheme/theme` + 汉堡按钮（<768）+ 幂等与 `catch` 降级
- [ ] 1.3 7 个 HTML 各加两行：`<link rel="stylesheet" href="/ds.css">`（在旧 CSS 之前）、`<script src="/ds.js" defer>`（在页面 js 之前）；`<head>` 加 `<meta name="color-scheme" content="dark light">`

**Gate 1（人工 + 自动）**
- [ ] `bash tools/ui-gates.sh` → G1/G2 绿
- [ ] 逐页冒烟：登录 → 账号表有行 → 工作台能载入周期 → 会话列表能出 → admin 区块在 → 设置页在
- [ ] `python3 tools/ui-visual.py --page all --theme dark --diff-dir /tmp/ui-diff` → 只有"导航从顶栏移到侧栏"的预期差异，**无 JS 错误、无 CSP 违规**
- [ ] `#who` `#logout` `#nav-admin` `#account-name` 在 DOM 中存在（脚本断言）

> 本步**不动**任何业务 HTML/JS，不改观感（字体/卡片仍走旧 CSS）。回滚：删两行。

---

## Step 2 · DS-2 组件层 + `/_ds` 演示页 + 主题切换 + 可访问性

- [ ] 2.1 `ds.css` 补齐 design §5 全部组件类（card/stat/table/badge/btn/field/tabs/dialog/toast/skeleton/empty/tip/工具类）
- [ ] 2.2 `ds.js` 补 `toast()` / `confirm()`（原生 `<dialog>`）/ `icon()`（8 个内联 SVG）
- [ ] 2.3 `src/console/ui/_ds.html` + `src/console/http/static.ts` 路由：`/_ds` 仅 `WFC_DS_PREVIEW=1` 可达，否则 404
- [ ] 2.4 顶栏加主题切换按钮（`DS.setTheme`，`aria-pressed`），侧栏加 `aria-current="page"`，内容区前加 `.ds-sr-only` 跳转链接
- [ ] 2.5 对比度实测：把两套主题的 `text/bg`、`muted/panel`、`accent/panel`、`danger/panel` 实测值写进 `design.md` §4 附注

**Gate 2**
- [ ] `WFC_DS_PREVIEW=1` 时 `/_ds` 200 且 14 个组件在 dark/light 都可渲染；未设该变量时 `curl -o /dev/null -w '%{http_code}' localhost:8787/_ds` = **404**
- [ ] 主题切换后刷新仍保持（localStorage）；`prefers-color-scheme` 生效
- [ ] 键盘走查：Tab 顺序 侧栏→顶栏→内容；`Escape` 关 dialog；focus ring 可见
- [ ] `ui-visual.py --page _ds --theme both --update` 生成组件基线

---

## Step 3 · 迁移 `index`（账号表）+ `account`（详情/表单）

- [ ] 3.1 `index.html` + `app.js` 渲染层：`.card`→`.ds-card`、`table`→`.ds-table`（包 `.ds-table-wrap`）、空态→`.ds-empty`、状态→`.ds-badge`、按钮→`.ds-btn--*`、表单→`.ds-field`
- [ ] 3.2 表格首列显示**会话剩余时长**（C1 的只读 `session` 字段）用 `.ds-badge--ok/warn/danger`；无字段时显示 `.ds-badge--neutral 未知`
- [ ] 3.3 `account.html` 同族迁移（表单 error 态用 `.is-invalid` + `aria-invalid`）
- [ ] 3.4 新账号创建/改密码流程手工冒烟 + `ui-visual.py --page index,account --theme both`

**Gate 3**：账号 CRUD 全通；表格窄屏可横滚不破版；`/api/accounts` 失败时显示 `.ds-empty` 而非空白区。

---

## Step 4 · 迁移 `settings` + `admin` + `login`

- [ ] 4.1 `login.html`：居中卡片 + 错误用 `.ds-field__error` + `role="alert"`；不建 sidebar
- [ ] 4.2 `settings.html`：全局配置用 `.ds-field` + `.ds-tabs`（若分节>3）
- [ ] 4.3 `admin.html`：隧道状态 `.ds-badge` + 当前地址 `.ds-mono` + 凭据卡片 + `DS.confirm` 替换 `window.confirm`
- [ ] 4.4 三页 `ui-visual.py --theme both`

**Gate 4**：登录失败提示可读且 `role="alert"`；隧道/凭据区块与 `10-15` V9–V11 一致；`window.confirm` 0 处（`grep -c 'window.confirm'`）。

---

## Step 5 · 迁移 `workbench`（最重：版本链 / 对比 / SSE 进度）

- [ ] 5.1 结构：左「账号+计划」`aside`、中「任务+进度」、右「版本链+对比」→ `.ds-grid--3`；窄屏降单栏
- [ ] 5.2 进度：`progress` → `.ds-badge--info` + 进度条 `.ds-progress`（纯 CSS `--v` 变量由 JS 设 `el.style.setProperty`，**CSSOM 允许**；不用内联 `style=` 属性）
- [ ] 5.3 版本链：`.ds-timeline`（纯 CSS 伪元素线）+ 当前版本 `.is-active`
- [ ] 5.4 对比视图：两列 `.ds-diff`，增删行用 `.ds-diff__add/__del`
- [ ] 5.5 高度：`min-height: calc(100vh - var(--topbar-h))`；长会话滚到底验收
- [ ] 5.6 `ui-visual.py --page workbench --theme both`；手工跑一次「载入计划 → 生成 → 推送」到 queued 即可（不真发）

**Gate 5**：三栏在 1440/1024/390 三档不破版；SSE 进度数字实时更新；对比视图两列等高；生成/推送按钮 loading 态可见且不重复提交。

---

## Step 6 · 迁移 `chat`（气泡 / 决策卡片 / 流式）

- [ ] 6.1 列表侧栏 `.ds-list` + 未读/时间 `.ds-muted`；空态 `.ds-empty`
- [ ] 6.2 气泡：`.ds-bubble--user/--agent/--tool`，工具调用卡片 `.ds-card--flush` + `.ds-mono`
- [ ] 6.3 决策卡片（人在环确认）：`.ds-decision` + 主/危险按钮 + `DS.confirm` 兜底
- [ ] 6.4 流式渲染：追加文本时**不整块重绘**（保留现有逻辑，只换类名）；自动滚底仅当用户已在底部（现状逻辑保留）
- [ ] 6.5 错误消息（上游 503 / `stopReason=error`）→ `.ds-bubble--agent .is-error` + `.ds-badge--danger`（H5 失败显形，不留空气泡）

**Gate 6**：发一条消息能看到流式文本与工具卡片；决策卡点「拒绝」后会话继续；空 `content` 的 `stopReason=error` 不产生空气泡（回归 10-15 的修复）。

---

## Step 7 · 收尾：删旧 CSS、全量回归、文档

- [ ] 7.1 删除 `app.css` / `chat.css` / `workbench.css`，把残留 `.card/.primary/.ghost/.row/.mt` 全量改名到 `ds-*`；`ui-gates.sh` 开 G4 严格模式
- [ ] 7.2 全量 `python3 tools/ui-visual.py --page all --theme both --update` 生成 **14 张终版基线**，人工逐张确认
- [ ] 7.3 重跑 `10-15` V1–V13（对表），补一份 `report.md` 到本任务目录
- [ ] 7.4 文档：`.trellis/spec/console/index.md` 加"设计系统"节（令牌/组件/禁止事项）；`src/README.md` 更新 ui 目录职责；`AGENT.md` §1 加 S23 行 + §5 进度 + §9 变更日志；`TREE.md` 刷新
- [ ] 7.5 最终闸门：`bash tools/ui-gates.sh` 全绿 + `bunx tsc --noEmit` + `bun build --target=bun src/cli.ts` + `bun run typecheck`
- [ ] 7.6 `deploy/deploy.sh --keep-remote-content` → 250 真机逐页点一遍（含 390px 窄屏）；commit + `task.py archive`

---

## 验收对照（PRD → 本计划）

| PRD 项 | 落在 |
|---|---|
| DS-1 令牌 + 布局 | Step 1 |
| DS-2 组件 + `/_ds` | Step 2 |
| DS-3 逐页迁移 | Step 3–6 |
| AC-V 视觉回归 | Step 0/1/2/3–6 分页截图 + Step 7.2 终版 14 张 |
| AC-X 零依赖 | `ui-gates.sh` G5 + Step 7.5 |
| AC-F 功能等价 | Step 7.3（V1–V13）+ 各步 Gate |

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
