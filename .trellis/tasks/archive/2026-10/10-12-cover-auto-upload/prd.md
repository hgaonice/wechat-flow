# PRD · 封面自动上传到草稿（当前需后台手选）

> 状态：**O-B 已实现（2026-10-13），待 250 真机验收**。设计见 [design.md](./design.md)，实现见 [implement.md](./implement.md)。

## 背景

浏览器发布方式（`publishMethod: "browser"`，见 `README.md` §发布方式）只用 CDP 把**正文**写进草稿箱，
`baoyu-post-to-wechat` skill 的浏览器流程**不会上传封面**。封面已由 `src/cover.ts`（ImageMagick）
确定性生成到 `data/<alias>/imgs/<date>/cover.png`，但需要在公众号后台**人工选为封面**。

当前通知邮件里已提醒“请登录后台确认并群发”，属于可接受但非全自动的现状。

## 目标

让每日草稿**自动带上封面**，减少人工步骤；至少做到“半自动”（一条命令/一个脚本完成剩余步骤）。

## 调研结论（2026-10-12，详见 [research.md](./research.md)）

**已确认**：上游 skill v1.118.2 的**浏览器路径（本项目所用）根本不支持封面**——这是文档化限制
（`SKILL.md` Feature Comparison：`Default cover fallback (imgs/cover.png)` 对 `Article(Browser)` 为 ✗）。
封面能力只在 **API 路径** `wechat-api.ts`（`--cover` → `thumb_media_id`）。

## 候选方案（待用户选定，G5）

| # | 方案 | 优点 | 代价 |
|---|------|------|------|
| **O-A** | 改走 API / Remote API（`publishMethod:"api"` 或 `--remote-host`） | 原生带封面；顺带去掉浏览器脆弱性 | 需 250 出口 IP 进白名单（`40164`） |
| **O-B**（推荐 fallback） | CDP 驱动编辑器封面弹窗 + `DOM.setFileInputFiles` 上传 `cover.png` | 契合现有浏览器方案（D1），无需 API | 弹窗选择器脆弱，需真机探测 |
| O-C | 给上游打 browser 路径 `--cover` 补丁 | 干净可复用 | 扩大补丁维护面 |
| O-D | 半自动（脚本打开封面弹窗，人工确认） | 简单 | 仍需人工 |

**推荐**：先验证 O-A 可行性（最高杠杆）；不可行则 O-B。

## 已选定：O-B（2026-10-13）

用户选定 **O-B**——CDP 驱动编辑器封面弹窗上传 `cover.png`。
理由：契合现有浏览器 CDP 方案（D1，不受 API IP 白名单限制），不扩大上游补丁面。
实现要点：正文校验通过后、同一 CDP 会话内完成；失败必须降级、绝不阻断发布；开关 `cover.uploadToDraft` 默认关。

## 验收（待方案选定后细化）

- [x] 调研：确认上游 browser 路径是否支持封面 → **不支持（文档化限制）**
- [x] 选定方案（G5）：**O-B（CDP 封面弹窗）**
- [x] 代码实现：`setDraftCover` / `probeDraftCover` + `cover` 命令 + `cover.uploadToDraft` 开关
- [x] 静态验证：`bun build` 与 `bunx tsc --noEmit` 均零错误
- [ ] **250 真机**：`cover --probe` 校准 `COVER_SELECTORS` → `cover --date` 成功
- [ ] **250 真机**：开 `uploadToDraft:true` 跑 `publish --reuse --force`，草稿自带封面（过 G2）
- [ ] 失败可降级实测：选择器失效时正文仍发布成功，只告警
- [x] 更新 `README.md` / `docs/操作手册.md` / `AGENT.md` / `src/README.md`

## 依赖 / 风险

- 依赖 skill 版本与编辑器页面结构，可能随平台改版失效 → 必须保底降级。
- 触碰发布链路 → 需真机端到端验收（见 `.trellis/spec/engine/verification.md`）。
