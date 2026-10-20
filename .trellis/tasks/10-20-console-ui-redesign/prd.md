# PRD（C3）：控制台前端设计系统重构

> 父任务：`10-20-ops-resilience-upgrade`（执行顺序 #3，工作量最大，分 4 步增量交付）

## 问题陈述

用户反馈「界面太丑」，希望参考 `https://github.com/linux-do/cdk` 等优秀项目改进前端设计。

### 已采集事实

| # | 事实 | 证据 |
|---|---|---|
| E1 | 现状 UI 为纯 vanilla HTML/CSS/JS，共 **2617 行**（`app.js` 431 / `workbench.js` 607 / `chat.js` 542 / 其余页面 + CSS） | `wc -l src/console/ui/*` |
| E2 | `app.css` 仅 **115 行**：只有 CSS 变量（9 个）+ 基础控件，**无布局骨架、无组件层、无空态/骨架屏** | `src/console/ui/app.css` |
| E3 | 三个页面各自带独立 CSS（`app.css` / `chat.css` / `workbench.css`），存在重复与不一致 | 目录结构 |
| E4 | 参考项目 cdk 是 **Next.js + shadcn/radix + tailwind + @tanstack/table** 等数十个 npm 依赖 | `frontend/package.json`（已拉取） |
| E5 | 本项目红线 **H3/AC-10：运行时不新增 npm 依赖**，静态资源由 `Bun.serve` 直接托管 | `.trellis/spec/console/index.md:18` |
| E6 | 曾有 8 处内联 `style` 被 CSP（`style-src 'self'`）拦截的历史缺陷，已修为 `.row.mt` 类 | 10-15 验收报告 |

**结论**：cdk 可借鉴的只有**设计语言**（信息层级、配色、布局、组件形态），不能照搬技术栈（E4 vs E5）。

## 需求

- **R1 设计系统层（纯 CSS，0 依赖）**：新建 `src/console/ui/ds.css`（设计令牌 + 布局骨架 + 组件类），三份旧 CSS 收敛为「ds.css + 页面级少量补充」。
  - 令牌：中性色阶（5–7 级）+ 单一 accent + 语义色（ok/warn/danger/info）+ 间距/圆角/阴影/字号阶梯 + 明暗双主题
  - 布局：左侧固定 sidebar（含折叠）+ 顶栏（面包屑/账号切换/用户菜单）+ 内容区（12 栅格或 max-width 容器）
  - 组件：card / stat / table（含粘性表头、行 hover）/ badge（状态语义）/ button（primary/secondary/ghost/danger，含 loading）/ input+select+textarea（含 error 态）/ tabs / dialog / toast / skeleton / empty-state / tooltip / focus-ring
- **R2 页面迁移（7 页）**：`login` → `index`（账号表）→ `account` → `settings` → `workbench`（版本链/对比/SSE 进度，最重）→ `chat`（气泡/决策卡片/流式）→ `admin`（隧道/凭据/统计）。
- **R3 约束（默认，不破红线）**：纯 CSS + 原生 JS，**不新增运行时依赖**、不引入构建链；若用户改判允许构建期工具（Q1=B），必须先更新 `.trellis/spec/console/index.md` 并经确认。
- **R4 合规与可访问性**：**0 内联 `style`/`style=`**（CSP `style-src 'self'`，避开 E6 历史缺陷）；语义化标签 + `aria-*` + 键盘可达（Tab 顺序、focus-visible）；对比度 ≥ 4.5:1。
- **R5 响应式**：≥1280 三栏 / 768–1280 两栏 / <768 单栏（sidebar 抽屉化）；workbench 对比视图与版本链在窄屏可用。
- **R6 视觉回归**：Playwright 截图基线（7 页 × 暗/亮 2 主题）+ 断言「无 JS 错误、无 CSP 违规、关键元素可见」。

## 验收标准（分 4 步，每步独立可验收）

- [ ] **DS-1 令牌 + 布局骨架**：`ds.css` 落地并被所有页面引用；sidebar + 顶栏 + 内容区在 7 个页面统一；无内联 style。
- [ ] **DS-2 组件类**：R1 列出的组件全部有可复用类与 1 个 `/_ds` 演示页（仅开发用，生产不暴露或明确标注）；每个组件在暗/亮主题下正确。
- [ ] **DS-3 逐页迁移**：7 页全部迁移完成；功能零回退（登录/账号 CRUD/工作台生成推送/会话决策/管理员视图全部可操作）。
- [ ] **AC-V 视觉回归**：7 页 × 2 主题截图基线入库；`playwright` 跑通且 0 差异（或差异经人工确认后更新基线）；CSP 违规 0；无 JS 错误。
- [ ] **AC-X 零依赖**：`dependencies` 仍为空；`bun build` / `tsc --noEmit` 通过；`grep -c 'style='` 在 `ui/*.html` 为 0。
- [ ] **AC-F 功能等价**：既有 `10-15-console-acceptance-250/report.md` 的 V1–V13 浏览器用例全部重跑通过。

## 开放决策

| # | 问题 | 建议 |
|---|---|---|
| Q1 | 是否允许引入构建期依赖（tailwind/组件库，产物仍静态） | **不允许**（保持零依赖红线）；纯 CSS 手写设计系统 |

## 非目标

- 不改任何后端 API 契约（除必要的只读展示字段，如 C1 的会话剩余时长）。
- 不重写业务逻辑（`workbench.js`/`chat.js` 的 SSE 与决策逻辑不动，只换渲染层）。
- 不做移动端 App / 不做 SSR / 不引入前端路由框架。
