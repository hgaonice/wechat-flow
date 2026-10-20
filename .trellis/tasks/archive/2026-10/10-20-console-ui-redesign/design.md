# 设计（C3）：控制台前端设计系统重构

> 父任务 `10-20-ops-resilience-upgrade` 的 #2 · PRD 见 `prd.md`
> 目标：把 2617 行"够用但难看"的 vanilla UI，换成**有设计系统**的 vanilla UI。
> **红线不变**：0 运行时依赖、0 构建链、0 内联 `style=`（CSP `style-src 'self'`）。

---

## 1. 借 cdk 什么、不借什么

| 维度 | cdk（Next.js + shadcn + tailwind） | 本项目取法 |
|---|---|---|
| 视觉语言 | 深色优先、1px 细边、极浅阴影、单一 accent、语义色药丸、紧凑表格 | **全要**（纯 CSS 手写） |
| 信息层级 | 左侧分组导航 + 顶栏面包屑 + 卡片分区块 | **全要** |
| 密度 | 行高 1.45、字号 13/14、卡片 padding 16 | **全要**，比现状更紧凑 |
| 状态表达 | badge/骨架屏/空态/toast/dialog 一律系统化 | **全要**，这是现状最大缺口（`app.css` 只有 115 行） |
| 技术栈 | tailwind / radix / tanstack-table / lucide | **一个都不要**（否则破 H3/AC-10） |
| 图标 | lucide-react | **内联 SVG sprite**（`ds.js` 内置 8 个图标字符串，CSP 允许 `img-src 'self' data:`，SVG `use` 不受限） |

---

## 2. 文件布局与加载顺序

```
src/console/ui/
  ds.css            ← 新增：唯一样式源（令牌 + 布局 + 组件 + 工具类，单文件 ≤ ~900 行）
  ds.js            ← 新增：shell 组装 + 主题 + toast/dialog/tooltip + 图标（≤ ~260 行）
  _ds.html         ← 新增：组件演示页（仅 WFC_DS_PREVIEW=1 时可达，默认 404）
  app.css / chat.css / workbench.css  ← 保留到 **Step 7 才删**（未迁移页仍靠它们）
  *.html / *.js    ← 逐页迁移
```

**每个页面 `<head>` 的加载顺序（迁移后）**：

```html
<link rel="stylesheet" href="/ds.css">
<link rel="stylesheet" href="/app.css">        <!-- 迁移完成后删除 -->
<link rel="stylesheet" href="/<page>.css">     <!-- 迁移完成后删除 -->
<script src="/ds.js" defer></script>           <!-- 必须在页面 js 之前 -->
<script src="/app.js" defer></script>
<script src="/<page>.js" defer></script>
```

理由：`ds.css` 先加载 → 旧 CSS 的页面级覆盖仍然生效（未迁移页不会被 ds 改变观感）；`ds.js` 先执行 → shell 在页面 JS 绑定事件前就已就位，`#who` / `#logout` / `#nav-admin` 全部存在。

---

## 3. 契约 S-1：shell 组装（**不改 HTML 结构也能迁移布局**）

`ds.js` 在 `DOMContentLoaded` 之前（`defer` 首次执行）做一次纯 DOM 搬移，**不新增/不删除任何页面节点，只移动**：

```
body
├─ aside.ds-sidebar                     ← 新建
│   ├─ .ds-sidebar__brand               ← 移动 header > .brand
│   └─ nav.ds-nav
│       ├─ .ds-nav__group "内容"        ← 新建（按 href 分组）
│       │   └─ a.ds-nav__item           ← 移动 header > a[href]（含 #nav-admin 原 id）
│       └─ .ds-nav__group "系统"
└─ .ds-main                             ← 新建
    ├─ header.ds-topbar                 ← 原 header（加 class，保留全部子节点：#who / #account-name / #logout）
    └─ main.ds-content                  ← 原 main（保留原 class 如 chat-main，追加 ds-content）
```

**不变式（必须由 selftest/验收守住）**
1. 页面里原有 id 一个不丢：`#who`、`#logout`、`#nav-admin`、`#nav-settings`、`#account-name`、以及所有业务 id。
2. 页面 JS **无需修改**即可工作（它只查 id，不查层级）。
3. 搬移是幂等的：`DS.mount()` 二次调用不再搬。
4. 没有 `<header>` 的页（`login.html`）→ 只建 `body > .ds-main > main.ds-content`，不建 sidebar（登录页无导航）。
5. 搬移失败（异常）→ `catch` 后保持原 DOM 不动并 `console.error`，页面仍可用（**降级不白屏**）。

`data-page` 决定高亮：`login|index|account|settings|workbench|chat|admin` → 对应 `href` 加 `aria-current="page"` + `.is-active`。

---

## 4. 契约 S-2：令牌（`ds.css` 第 1 段）

`:root` = 暗色（默认，与现状一致）；`html[data-theme="light"]` 覆盖。

| 组 | 令牌 | 值（暗 / 亮） |
|---|---|---|
| 中性 | `--n-0…--n-900` | `#0b0d12 / #0f1115 / #151922 / #1b2029 / #222834 / #2a3140 / #374052 / #525c70 / #8b97ab / #e6e9ef`（亮色反序） |
| 语义 | `--bg` `--panel` `--panel-2` `--border` `--border-strong` `--text` `--muted` | 映射到中性阶 |
| 品牌 | `--accent` `--accent-hover` `--accent-weak` | `#4f8cff / #6ea0ff / rgba(79,140,255,.14)` |
| 状态 | `--ok` `--warn` `--danger` `--info`（各带 `-weak`） | `#3ddc97 / #f5a623 / #ff5f6d / #4cc9f0` |
| 间距 | `--s-1…--s-8` | 4 / 8 / 12 / 16 / 20 / 24 / 32 / 40 px |
| 圆角 | `--r-sm/md/lg/full` | 6 / 10 / 14 / 999px |
| 阴影 | `--sh-1/2/3` | 极浅，暗色只靠 `--border` 分层 |
| 字号 | `--fs-xs/sm/md/lg/xl/2xl` | 11 / 12 / 14 / 16 / 20 / 24（附 `--lh-tight/normal`） |
| 布局 | `--sidebar-w` `--topbar-h` `--content-max` | 236px / 56px / 1240px |
| 动效 | `--t-fast` `--t-med` | 120ms / 200ms（`prefers-reduced-motion` 全关） |
| 圆点/网格 | `--ring` | `0 0 0 2px var(--panel), 0 0 0 4px var(--accent)`（focus-visible） |

对比度（提交前实测并写进 design 附注）：`--text` on `--bg` ≈ 15:1；`--muted` on `--panel` ≈ 6.7:1；`--accent` on `--panel` ≈ 5.1:1 —— 均 ≥ 4.5:1。

---

## 5. 契约 S-3：组件类 API（前缀统一 `ds-`，**状态用 `.is-*`**）

| 组件 | 类 | 关键约束 |
|---|---|---|
| 卡片 | `.ds-card` `.ds-card__head` `.ds-card__title` `.ds-card__body` `.ds-card--flush` | 1px `--border`，`--r-lg`，padding `--s-4` |
| 统计块 | `.ds-stat` `.ds-stat__label` `.ds-stat__value` `.ds-stat__delta` | 数字用 `font-variant-numeric: tabular-nums` |
| 表格 | `.ds-table` `thead` 粘性 `.ds-table--compact` `.ds-table__empty` | 行 hover 用 `--panel-2`，横向滚动容器 `.ds-table-wrap` |
| 徽标 | `.ds-badge` + `--ok/--warn/--danger/--info/--neutral` | 药丸形，含 `::before` 圆点（纯 CSS） |
| 按钮 | `.ds-btn` + `--primary/--secondary/--ghost/--danger` + `.is-loading` + `.ds-btn--sm/--block` | `:disabled` 与 `.is-loading` 都不响应点击；loading 用 CSS 旋转伪元素 |
| 表单 | `.ds-field` `.ds-field__label` `.ds-field__hint` `.ds-field__error` `.ds-input` `.ds-select` `.ds-textarea` | `.is-invalid` 时边框 `--danger` + `aria-invalid` 由页面 JS 设 |
| 页签 | `.ds-tabs` `.ds-tabs__item` `.is-active` | `role="tablist"`（Step 2 补 aria） |
| 对话框 | `.ds-dialog` `dialog.ds-dialog` | 用原生 `<dialog>` + `::backdrop`（0 依赖，自带 focus trap/Esc） |
| Toast | `.ds-toast-wrap` `.ds-toast` + `--ok/--warn/--danger` | `aria-live="polite"`，4s 自动消失，可 `DS.toast(msg,'warn')` |
| 骨架 | `.ds-skeleton` `.ds-skeleton--text/--row/--card` | `prefers-reduced-motion` 时不动 |
| 空态 | `.ds-empty` `.ds-empty__icon/title/desc/action` | 表空/列表空一律用它，禁止只留一句 muted 文字 |
| 提示 | `[data-tip]` + `.ds-tip` | 纯 CSS `::after`，不引 JS |
| 工具类 | `.ds-row` `.ds-col` `.ds-grid--2/3/4` `.ds-gap-*` `.ds-spacer` `.ds-muted` `.ds-mono` `.ds-truncate` `.ds-sr-only` | 只允许"结构性"工具类，不允许在 HTML 写视觉数值 |

**兼容策略**：迁移过程中旧类（`.card` `.primary` `.ghost` `.row` `.mt`）继续由旧 CSS 提供；`ds.css` **不覆盖**它们，避免未迁移页回归。全部页面迁完后（Step 7）才删旧 CSS，并把残留旧类改名。

---

## 6. 契约 S-4：`ds.js` 公开 API 与主题

```js
window.DS = {
  mount(),                       // 幂等；异常时保持原 DOM（不白屏）
  toast(msg, kind='ok', ms=4000),// 插入 .ds-toast-wrap
  confirm({title, body, danger}) // Promise<boolean>，基于 <dialog>
  setTheme('dark'|'light'|'auto'),
  theme(),                       // 当前生效值
  icon(name),                    // 返回 SVG 字符串（自用）
};
```

- 主题存储：`localStorage['wfc.theme']`；未设置 → `prefers-color-scheme`；`<html data-theme>` 由 `DS.setTheme` 写。
- **防闪烁**：`ds.js` 是普通脚本但 `defer` 会在首帧后执行 → 接受一次性闪烁（暗→亮的极端场景）。缓解：`index.html` 等页面 `<head>` 里加 `<meta name="color-scheme" content="dark light">`；若实测闪烁明显，允许在 `<head>` 加**外部** `ds-boot.js`（仍是 `'self'`，非内联）。
- 与页面 JS 的边界：`ds.js` 只碰 `.ds-*`、`html[data-theme]`、`header`/`main` 的搬移；**不绑定任何业务 id 的点击**，不覆盖 `$`/`fetch`/`EventSource`。

---

## 7. 响应式（S-5）

| 断点 | 布局 |
|---|---|
| ≥1280 | sidebar 236px 常驻 + 内容 `max-width: 1240px` 居中 |
| 768–1280 | sidebar 收起为 60px 图标栏（`data-sidebar="rail"`，hover 展开） |
| <768 | sidebar 变抽屉（`body[data-sidebar="open"]` + 遮罩 `.ds-scrim`），顶栏出汉堡按钮；`chat-main`/`workbench` 三栏降为单栏 |
| 表格 | 一律包 `.ds-table-wrap`（`overflow-x:auto`），窄屏不撑破布局 |

`<768` 时的三个已知重灾区：workbench 版本链 + 对比视图、chat 侧栏 + 气泡、admin 凭据卡片 —— 各自在迁移步骤里单独截图验收。

---

## 8. `/_ds` 演示页的门禁（S-6）

- 路由：`GET /_ds` → `_ds.html`，**仅当 `process.env.WFC_DS_PREVIEW === "1"`**，否则 404（与生产默认一致）。
- 页面内容：每个组件在 `dark`/`light` 下各一份 + 「复制类名」提示；不含业务数据、不请求任何 `/api/*`。
- 目的：让"设计系统"可被肉眼评审，也让未来改样式时有唯一对照物。

---

## 9. 验证设计（S-7）

### 9.1 静态闸门 `tools/ui-gates.sh`（0 依赖，bash + grep）

| 闸门 | 判据 |
|---|---|
| G1 | `grep -c 'style=' src/console/ui/*.html` 全 0 |
| G2 | 每个 `*.html` 都含 `<link rel="stylesheet" href="/ds.css">` 且 `ds.js` 在页面 js 之前 |
| G3 | `ds.css` 中定义的 `--*` 令牌被引用的比例 > 60%（防空令牌） |
| G4 | 已迁移页不含旧类残留黑名单（`.card` 之外的白名单）——Step 7 才启用 |
| G5 | `dependencies` 为空；`bun build` + `tsc --noEmit` 通过 |

### 9.2 视觉/功能回归 `tools/ui-visual.py`（Python Playwright 1.64，已装在机器上，**不进 package.json**）

- 复用 `10-15` 验收脚本骨架（`/tmp/wfc-browser-accept.py` 的思路，落库为 `tools/ui-visual.py`）。
- 覆盖：`login`（未登录跳转）、`index`、`account`、`settings`、`admin`、`workbench`、`chat` 共 **7 页 × 2 主题 = 14 张基线**，存 `tools/ui-baselines/<page>-<theme>.png`。
- 每页同时断言：`console` 无 `error`、无 `securitypolicyviolation` 事件、`document.querySelector('.ds-sidebar')` 在非登录页存在、关键元素可见（如 `#accounts tbody tr`、`#chat-list`、`#versions`）。
- 差异判定：像素差异 > 0.5% 或尺寸不同 → 输出 diff 图到 `/tmp/ui-diff/` 并退出码 2（不静默通过）。
- 动画/字体抖动：截前 `document.documentElement.classList.add('ds-no-anim')`（`ds.css` 里把 `transition/animation` 关掉）。

### 9.3 功能等价（AC-F）

重跑 `10-15` 的 V1–V13，逐条对表；人工确认项（SSE 流式、决策卡片）由截图 + 录屏替代。

---

## 10. 风险与对策

| # | 风险 | 对策 |
|---|---|---|
| R1 | shell 搬移破坏页面 JS（id 丢失/时序） | 只移动不重建；`ds.js` 必须在页面 js 之前；`tools/ui-visual.py` 断言 `#who/#logout/#nav-admin` 存在；异常时不动 DOM |
| R2 | 未迁移页被 `ds.css` 意外改变 | `ds.css` 不定义 `.card/.primary/.ghost/.row/.mt`；旧 CSS 继续后加载 |
| R3 | 主题闪烁 / 两张主题下对比度不达标 | `meta color-scheme`，必要时 `ds-boot.js`；`ds.css` 里两套主题单独列对比度实测值 |
| R4 | workbench/chat 依赖固定高度，包进 `.ds-content` 后滚动失效 | 迁移这两页时把高度改为 `min-height: calc(100vh - var(--topbar-h))`，并单独做滚动验收（长列表滚到底） |
| R5 | 截图基线噪音（字体抗锯齿/时间戳） | 关动画、固定 viewport 1280×900、`deviceScaleFactor=1`、隐藏时间戳节点（`.ds-ts`）后再截 |
| R6 | 迁移中功能回归引入 | 一页一 commit；每页迁完立刻跑 `ui-visual.py --page <page>` + 手工冒烟该页主操作 |
| R7 | `/_ds` 泄露到生产 | 环境变量门禁 + `tools/ui-gates.sh` 断言默认 404 |
| R8 | 图标/emoji 风格不统一 | 统一 8 个内联 SVG（`chevron/plus/check/x/alert/info/gear/refresh`），禁止 emoji 当图标 |

---

## 11. 回滚

| 粒度 | 手段 |
|---|---|
| 单页 | `git revert <该页 commit>`（一页一提交，旧 CSS 仍在） |
| 整体 | 删 `<link ds.css>` + `<script ds.js>` 两行即回到旧 UI（shell 是运行时组装，HTML 未被改结构） |
| 演示页 | 不设 `WFC_DS_PREVIEW` 即 404 |

---

## 12. 明确不做

- 不引入 tailwind/shadcn/任何 npm 包（含 devDependency；Playwright 用系统 Python 版）。
- 不改后端 API、路由、鉴权；不引入前端路由（仍是多页跳转）。
- 不重写 `workbench.js`/`chat.js` 的 SSE 与决策逻辑（只换渲染层与类名）。
- 不做暗色以外的新视觉方向（不做玻璃拟态/大渐变/AI 味插画）。
- 不追移动端 App 级体验；`<768` 只保证"可用不破版"。

## 附注 · 对比度实测（Step 2.5，2026-10-20）

用 WCAG 相对亮度公式实测（`(L1+0.05)/(L2+0.05)`），目标 **≥4.5:1**（正文）与 **≥3:1**（非文本装饰）。
测得值（token 取自 `ds.css`「1. tokens」）：

| 组合 | 暗色 | 亮色 |
|---|---|---|
| text / bg | 15.54 | 16.24 |
| text / panel | 14.46 | 17.41 |
| muted / panel | 5.96 | 5.70 |
| muted / bg | 6.40 | 5.32 |
| accent（链接文字）/ panel | 5.47 | 5.17 |
| ok / panel | 9.95 | **5.18** |
| warn / panel | 8.68 | 5.02 |
| danger / panel | 5.95 | 4.52 |
| 白字 / accent-solid（主按钮） | **4.93** | 5.17 |

两处首测不达标、已按此调整：
1. 暗色主按钮原来用 `--ds-accent`（#4f8cff）→ 白字仅 **3.22:1**。拆分为
   `--ds-accent`（链接文字，亮）/ `--ds-accent-solid`（按钮填充，深 #2f6ae0 → 4.93:1）。
2. 亮色 `--ds-ok` #0f9d63 → 白底仅 **3.49:1**，改为 #0a7d4d（5.18:1）。

结论：**按钮填充色与链接文字色必须是两个令牌**，否则要么按钮白字不达标、要么暗色链接不达标。
