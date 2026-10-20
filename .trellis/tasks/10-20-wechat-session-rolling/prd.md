# PRD（C1）：公众号登录态长期保存与滚动更新

> 父任务：`10-20-ops-resilience-upgrade`（执行顺序 #1，最高优先）

## 问题陈述

用户反馈「每次代码调整都要重新扫码登录公众号」。已做**只读真机诊断**（2026-10-20，250），结论与初始假设不同：

### 已有证据（只读采集，未改任何配置）

| # | 观测 | 证据来源 |
|---|---|---|
| E1 | `wechat-console` 的 `KillMode=control-group`，但 **Chrome 不在 console 的 cgroup**（Chrome 根进程在 `user@0.service/app.slice/app-com.google.Chrome-<pid>.scope`）→ 重启 console **不会**杀 Chrome | 250: `systemctl show wechat-console -p KillMode` + `/proc/<pid>/cgroup` |
| E2 | 10-20 00:55–01:06 连续 **6 次** console 重启（AI 封面部署）后，11:11 keepalive 两账号**均成功**、无扫码 | `journalctl -u wechat-console` + `-u wechat-keepalive` |
| E3 | 10-20 07:02:25 gaoh 判「session expired」→ 发二维码 → 900s 未扫 → **失败邮件**；**07:17:37 同账号重试 job 在 07:18:44 判 `session valid`，07:19:44 成功推送（正文 3148 chars + AI 封面）** | `journalctl -u wechat-console` 07:15–07:20 |
| E4 | 浏览器 renderer 子进程寄生在 `session-1955.scope` / `session-2022.scope`（SSH 登录会话），不在任何服务 unit 内 → 会话清理/SSH 断连有连带杀进程风险 | `/proc/<pid>/cgroup` |
| E5 | 近 14 天 keepalive **仅 1 次**真失效（10-19 23:12 gaoh），其余 13 次全绿；10-20 08:04 一次真实扫码后恢复 | `journalctl -u wechat-keepalive --since -14d` |
| E6 | 会话有效性判定**只有 DOM 一条证据**，日志只记 `url:`；`reloadAndWaitForNewContext()` 依赖 `window.__wfcProbe` marker 时序，浏览器繁忙时可能读到旧 DOM | `src/session.ts:119–160`、`:438–460` |
| E7 | MP 票据硬上限 96h，需**真实鉴权请求**滑动续期（单纯访问首页不续期）；现 keepalive 每 12h 一次 | 10-16 变更日志实测（+95.9h → +96.0h）+ `deploy/systemd/wechat-keepalive.timer` |

**诊断结论（待 C1 内正式定案）**：用户感知的「改代码就要重登」主要由 **①会话探测误判（E3/E6）** 放大而成，叠加 **②浏览器进程寄生 SSH 会话 scope 的结构性隐患（E4）**；真正失效频率低（E5）。**不是** console 重启杀 Chrome（E1/E2 已否证）。

## 需求

- **R1 会话判定证据链加固**：把「判过期」从单一 DOM 改为三层证据 —— ① Chrome `Default/Cookies` 的 `slave_sid` 到期时间（本地、零请求）② 页面内鉴权请求结果 ③ DOM。**判 `invalid` 必须有强证据**（cookie 已过期 / 鉴权请求明确跳登录）；证据不足只能判 `unknown`。
- **R2 抗抖动，禁止误告警**：单次探测失败**不得**立即发二维码、不得发「登录失效」失败邮件；需连续 N 次（默认 3，间隔 ≥60s）失败或 cookie 已过期才进入扫码流程。扫码等待超时与"误判"必须在日志/邮件中可区分。
- **R3 浏览器与 console 解耦**：Chrome + Xvfb 归独立 systemd unit 托管，生命周期与 console 无关；重启/部署 console 不触碰浏览器（消除 E4 的寄生 scope 风险）。
- **R4 优雅停机**：console 停止时不杀浏览器；确有需要时通过 CDP `Browser.close` 优雅关闭（让 cookie DB 落盘），**禁止** cgroup 级硬杀。
- **R5 Cookie 快照与回滚**：keepalive 成功后原子快照 `Default/Cookies` + `Local State`（cookie 解密密钥所在），保留最近 N 份；提供 CLI `session snapshot|restore|list`；restore 前做完整性校验（sha256 + SQLite `integrity_check`）。
- **R6 保活提速与预警**：keepalive 间隔 12h → **4–6h**（可配）；到期前 24h 预警（只提示、不阻塞发布）；`keepalive --wait` 可在失败时等待扫码。
- **R7 可观测**：`doctor --all` 增会话行（各账号 cookie 到期时间、最近保活、判定来源与证据）；控制台 `/health` 或账号视图可见会话剩余时长。
- **R8 部署零打扰**：`deploy.sh` 部署后只重启 console（必要时不动浏览器），并新增部署后会话自检（fail-fast 报错，不静默）。

## 验收标准

- [x] **AC1 诊断定案**：产出 `research.md`，用 E1–E7 证据对 10-19 23:12 与 10-20 07:02 两次事件给出归因（真失效 / 误判），并附判定依据。
- [x] **AC2 误判不打扰（对抗测试）**：注入一次 DOM 探测超时/读到 `page_timeout` 壳页 → **不**发二维码、**不**发失败邮件、不中断发布（有单元/集成测试证据）。
- [ ] **AC3 真失效才扫码**：连续 3 次失败或 cookie 已过期 → 触发扫码流程；250 真机至少验证 1 次真实扫码恢复。
- [x] **AC4 部署不打扰（核心）**：250 上连续 **3 次** `deploy.sh` + `systemctl restart wechat-console` 后，两账号会话仍判定 valid，**全程 0 次扫码**；`doctor` 显示 cookie 到期时间未缩短。
- [x] **AC5 快照可回滚**：故意破坏/删除 cookie 文件 → `session restore` → 会话恢复、无需扫码（真机验证）。
- [x] **AC6a 保活间隔**：12h→5h 已在 250 生效（`NextElapse 16:11`，drop-in `interval.conf` 已渲染）。
- [ ] **AC6b 到期前 24h 预警邮件**：代码+单测完成，**真机未收到过**（当前票据剩 96h，需构造临近到期场景才能验）。
- [x] **AC7 引擎零回退**：`bun build` / `bunx tsc --noEmit` 通过；无新增运行时依赖；当天 `drafts --all --date <today>` 两账号 `✅ 正文校验`。

## 开放决策

| # | 问题 | 建议 | 影响 |
|---|---|---|---|
| Q2 | 浏览器解耦方式：A) 独立 `wechat-browser@<alias>.service`（彻底，拓扑变化，需 250 手工 enable）；B) 保守：仍由 console spawn，但用 `systemd-run --scope/--unit` 脱离 cgroup | **A**，且保留 `WFC_BROWSER_MODE=external\|inline` 开关可回滚 | R3/R4 |

## 非目标

- 不承诺「永久免扫码」：96h 硬上限与"真实鉴权续期"规则由微信侧决定。目标 = **服务器不中断运行则长期无需扫码**。
- 不修改 `verifyDraftBody` 等发布铁律判定，不改「唯一真相源 = 草稿箱真实 DOM」。
- 不存放/代理公众号账密，不做多机冗余登录（多个 Chrome 同时登录同账号会被微信踢线）。

## 风险与依赖

- **多实例风险**：同账号多个 Chrome 同时登录会被微信判为异常登录 → 解耦后必须保证「每 alias 唯一 browser instance」。
- 读 `Cookies` 时 Chrome 持有该 SQLite；只读打开需处理 `SQLITE_BUSY`，失败必须降级为 `unknown`（不得判 invalid）。
- 验收涉及 250 部署与真实扫码，需用户在场配合 1 次（AC3/AC5）。
