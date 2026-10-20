# Verification & Truth Source

> **唯一真相源是公众号后台草稿箱的真实 DOM，不是 skill 的 stdout，也不是我们自己的中间状态。**
> 这条规则来自一次真实事故：草稿箱里只有标题、正文为空，而整条链路都在报“成功”。

---

## 三层置信度（从弱到强）

| 层 | 判据 | 可信度 |
|---|---|---|
| ① skill 自报 | 打印 `Done.` / `Body content verified OK` | **不可信**（无条件打印的假阳性） |
| ② 草稿箱标题匹配 | 在已登录页面查 `action=list_ex`，标题命中 | 中等（只证明标题在） |
| ③ 正文 DOM 校验 | 读 `.rich_media_content .ProseMirror` 的真实长度 | **强（发布成功的唯一依据）** |

`verifyDraftPublished()` 做 ②；`verifyDraftBody()` 做 ③。发布流程必须在 ② 通过后**再过 ③**。

---

## 硬性规则

1. **正文选择器**：只用 `.rich_media_content .ProseMirror`。绝不用裸 `.ProseMirror`
   （编辑器里有多个，裸选择器会命中标题框 `title-editor__input`）。
2. **正文长度判定**：剔除占位符“从这里开始写正文”后再计数，低于阈值判失败
   （公式文章按加权规则，见 `操作手册.md` §8.2）。
3. **粘贴**：必须走 CDP 编辑命令 `Input.dispatchKeyEvent { commands: ['copy'|'paste'] }`
   （在 Blink 内部执行，不依赖 X 焦点）；粘贴前必须重新聚焦正文
   （`prepareEditorPasteTarget()`）。
4. **上游升级后**：`deploy/patch-baoyu-skill.sh` 是**自适应**的 —— 检测到上游已原生修复就跳过，
   只给旧版打补丁。`doctor` 检查的是**能力**（选择器 + 聚焦），不是“补丁是否存在”。
5. **失败要显形**：`publish` 失败时写 `published.json(ok:false)` 并发失败邮件，
   **不得**静默记成成功。

---

## 验收命令（真机，唯一可信凭证）

```bash
# 草稿箱到底有什么 + 正文是否正常（带日期会做正文校验）
bun src/cli.ts drafts -a second --date 2026-10-12
# → ✅ 正文校验: ✅ 正文正常 (body=2806 chars («开学一个多月…») (min 200))

# 三维核对：草稿箱 / 状态文件 / 日志
systemctl start wechat-publish.service
journalctl -u wechat-publish.service -n 120 --no-pager
```

---

## 封面（S10 / O-B）验收

封面同属“确定性产物”，验收口径一致：**只认草稿编辑器里封面预览的真实 `background-image`**。

- **成功判据**：上传前后 `#js_cover_area` 内 `.js_cover_preview_new` 的 `background-image` 由空变为真实 `https://mmbiz.qpic.cn/...` URL。
- **只读复验**：`bun src/cli.ts cover -a <acct> --date <d> --probe` → `coverVisuals` 里 `js_cover_preview_new` 的 `bg` 非空即已持久化（重开编辑器仍成立）。
- **发布链路**：`publish` 会重写草稿从而清掉旧封面，故封面必须由 `publisher` 在 `verifyDraftBody` 通过后设置（不能只靠事后单独 `cover`）。
- **降级即通过**：封面任一步失败必须只 `warn` + 保留“手动选封面”，`publish` 仍 `done`（正文不受影响）。这本身就是一条必须验的路径。

真机步骤与踩坑记录见 [`deploy/ACCEPTANCE-250.md`](../../../deploy/ACCEPTANCE-250.md)。

---

## 登录态：URL 不是真相源（2026-10-16 事故）

**症状**：发布连续失败 `Error: Editor did not load (#title not found)`；同时 `runPublish` 还把前一天
的失败记录当成"已发布"，回报 `ok:true, skipped:already published`，使调度器**永不重试**。

**根因（三层，缺一不可）**：

1. MP 会话真的过期了，但 URL 仍带 `token=...`，且被复用的 tab 会用**缓存响应**继续渲染已登录首页
   （`.new-creation__menu` 存在）→ 假 "session valid" → 跳过二维码自愈。
2. 过期后跳到 **不带 token 的** `cgi-bin/home?t=home/index` 会渲染 "登录超时，请重新登录" 页
   （`page_timeout`）——**即使会话是活的**。所以它既不能当"已登录"证据，也不能当探测跳转目标。
3. `published.json` 里的失败记录（`ok:false`）也被当成了已发布。

**规则**：

- 登录判据 = **禁缓存重载后的 DOM**：`.new-creation__menu` 存在 且 非 `page_timeout`/"登录超时"。
- 重载前先 `Network.setCacheDisabled{true}`；并注入 `window.__wfcProbe` 标记，**等标记消失**
  （证明 JS 上下文真的换过）才读 DOM，否则读到的是旧 DOM（假阳性）。
- 探测目标只允许：当前**带 token** 的 URL（reload）或根 `https://mp.weixin.qq.com/`（会话活则重定向到首页，
  死了就是登录页+二维码）。**绝不**导航到不带 token 的 home URL。
- 二维码只存在于登录页，必须**先跳登录页再截图**；且二维码有两种形态：
  顶层 `img.login__type__container__scan__qrcode`，或跨域 `open.weixin.qq.com/...qrconnect` iframe
  （后者读不到 DOM，只能用其 `getBoundingClientRect()` 当裁剪框）。
- 等待扫码期间**不要主动刷新页面**（会作废用户正在扫的码）；只在微信自己轮换二维码时才重发邮件。
- 裁切失败时**不得覆盖**已有的有效二维码文件（写到 `<path>.full.png` 兜底）。
- 幂等／跳过只认 `ok === true`：`if (existing?.ok === true && !reuse && !force)`。
- **引擎代码改动后必须 `systemctl restart wechat-console`**：worker 进程是常驻的，
  只改磁盘文件不会生效（本次 job 11 的假成功就是旧进程内存里的旧代码）。

真机自检：`bun src/cli.ts drafts -a <acct>`（需真实会话）是唯一能证明登录态的命令；
`login -a <acct> --qr --wait 0` 可只生成+邮件二维码用于人工扫码。

### 会话寿命与保活（实测数据，2026-10-16）

- MP 登录票据（`slave_sid` / `data_ticket` / `bizuin` / `slave_bizuin` / `rand_info` / `slave_user`）
  在 Chrome profile 里的 Cookie 到期时间 = **签发 + 96h（4 天）**，是**硬过期**。
- 但它在**有真实鉴权请求**时会**顺延**：实测调用一次草稿箱接口，`slave_sid` 到期从 `+95.9h` → `+96.0h`。
  （单纯访问首页/重载 DOM **不会**顺延 —— 必须是一次带 token 的接口请求。）
- 因此：`deploy/systemd/wechat-keepalive.{service,timer}` 每 **12h** 跑一次
  `bun src/cli.ts keepalive --all`（每个账号一次鉴权请求）→ **只要服务器不停 4 天以上，就不再需要扫码**。
- `keepalive` 失败即 exit 1（systemd 可见）并默认把新二维码发到 `emailTo`，
  让人**提前**扫码，而不是等当天发布失败才发现。
- 兜底方案（彻底免扫码）：改用 `publishMethod="api"`（`wechat-api.ts` 已支持
  `media/uploadimg` + `material/add_material` + `draft/add`），需要 AppID/AppSecret +
  后台 IP 白名单（并把 `api.weixin.qq.com` 加入 `no_proxy`，否则走代理导致白名单 IP 不对）。
- 查票据剩余寿命（只读，不扰动会话）：读 `<profile>/Default/Cookies` 的
  `slave_sid.expires_utc`（Chrome 时间基 = 1601-01-01，微秒）：

---

## 弹窗/新标签页：tab 必须可见（2026-10-17 事故）

**症状**：`publish failed: Error: New tab not found: mp.weixin.qq.com`。
卡在 skill 点击「文章」菜单后 `waitForNewTab` 30s 超时。

**根因**：同一个 Xvfb 显示上跑了两个 Chrome（9222/9223），被遮挡的那个窗口里
`document.visibilityState === "hidden"`；Chrome **只允许可见 tab 弹窗**，因此点击「文章」
根本不会开新标签页。实测对照：9222 `hidden`（失败）vs 9223 `visible`（成功）；
且单独重跑 9222 仍失败 → 与并发无关，而是该 tab 的可见性。

**规则**：

- 浏览器发布前必须 `Page.bringToFront` 把该账号的 MP tab 置前；`src/session.ts#focusMpTab`
  封装了它（返回置前后的 `visibilityState`，非 visible 会 warn）。`publisher.ts` 在
  `ensureLoggedIn` 通过后、调用 skill 前调用它。
- 验证方式：`document.visibilityState` 必须为 `visible`（日志行 `MP tab visibility: visible`）。
- **两个账号的浏览器发布不能并发**：共用一个 X 显示，最后一个置前的会把另一个变 hidden。
  因此 250 上 `CONSOLE_MAX_CONCURRENCY=1`（`/etc/default/wechat-console`）。
- 区分两种“开不出编辑器”的错误：
  - `Editor did not load (#title not found)` → 登录态过期 / 附到了死 tab（见上一节）。
  - `New tab not found` → tab 不可见（弹窗被拦），与登录态无关。

---

## 检查清单

- [ ] 改动没有把“上游成功提示”当成“发布成功”。
- [ ] 发布链路仍以草稿箱回查 + 正文 DOM 校验收尾。
- [ ] 失败路径会写状态 + 报警，而不是静默跳过。
- [ ] 封面成功以封面预览 `background-image` 变化为准；封面失败仍不阻断正文（降级已验证）。
- [ ] 结论用真实命令输出表述（贴 `body=NNNN chars` / `cover set ✓ (after=https://mmbiz.qpic.cn/…)` 这类数字），不用“应该没问题”。
- [ ] 登录态用 `drafts -a <acct>` 或“禁缓存重载 + DOM”判定，**没有**用 URL 当证据。
- [ ] 幂等跳过条件是 `ok === true`，失败记录不会阻断重试。
- [ ] 引擎改动后已 `systemctl restart wechat-console`（worker 常驻）。
- [ ] 浏览器发布方式下 `wechat-keepalive.timer` 已 enabled（否则 4 天后必过期）。
- [ ] `CONSOLE_MAX_CONCURRENCY=1`（两个 Chrome 共用一个 X 显示，不能并发发布）。

---

## 登录态判定契约（C1 / S21，2026-10-20）

**背景**：2026-10-20 07:02 一次「登录失效」误判，触发了 3 封二维码邮件 + 1 封失败邮件 + 15 分钟停摆；同一账号 07:18 被判 valid 并成功推送。单证据（DOM）二值判定不可信。

**铁律**：

1. **三态，不二值**：`valid | invalid | unknown`（`src/session-probe.ts#decideVerdict`）。日报/邮件/自检只能把 `invalid` 当故障。
2. **只有强证据能判 `invalid`**：① 本地 `Default/Cookies` 的 `slave_sid` 缺失/已过期；② 服务端明确要求重新登录（`ret=200003` 或跳登录页）。
3. **`page_timeout` / 「登录超时，请重新登录」壳页 = `unknown`**，不是退登证据。读不到 DOM、CDP 不通、Cookies 被锁（`SQLITE_BUSY`）同样是 `unknown`。
4. **`unknown` 不得打扰人**：不发二维码、不发失败邮件、不阻塞发布；只累加持久化计数（`data/<alias>/state/session-probe.json`）。
5. **进入扫码流程的条件**：`invalid`，或连续失败 ≥ `WFC_SESSION_FAIL_THRESHOLD`（默认 3，两次间隔 ≥60s）。`=1` 可回退到旧行为。
6. **判定必须留证据**：日志/邮件统一带 `verdict=… consecutive=n/m evidence=cookie:…,http:…,dom:…`；禁止只记 `url:`。
7. **浏览器归属**：Chrome/Xvfb 由 `wechat-browser@<alias>.service` / `wechat-xvfb.service` 托管，`MainPID` 必须是 chrome；重启 console **不得**影响登录态。`WFC_BROWSER_MODE=inline` 是唯一回滚开关。
8. **恢复优先于重登**：会话异常先 `session list/restore`（快照在 `data/<alias>/session-snapshots/`，含 Cookies + Local State），只有在服务端真失效时才请人扫码。
