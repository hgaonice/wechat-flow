# Implement（C1）：登录态长期保存与滚动更新

> 顺序原则：**先把判定变可靠（低风险、立刻止痛）→ 再动部署拓扑（高风险、需真机窗口）**。
> 每步都要有验证命令；未通过不进入下一步。

## Step 0 — 归因定案（只读，先做，不改代码）

- [x] 0.1 采集并归档证据快照（时间窗：10-19 22:50 → 10-20 09:00）：
  `journalctl -u wechat-console --since "2026-10-19 22:50" --no-pager > /tmp/c1-console.log`
  `journalctl -u wechat-keepalive --since "-14 days" --no-pager > /tmp/c1-keepalive.log`
  记录：Chrome 根 PID / cgroup / etimes、`systemctl show wechat-console -p KillMode`、cookie 文件 mtime
- [x] 0.2 对 `data/<alias>/Default/Cookies` 做只读解析，记录 `slave_sid` 当前到期时间（作为基线）
- [x] 0.3 产出 `research.md`：E1–E7 + 07:02/07:18 对照 → 判定 10-19 与 10-20 事件是"真失效"还是"误判"，写明依据

**验证**：`research.md` 里每个结论都有可复制的命令与输出片段。**Gate 1**：用户 review 归因结论。

## Step 1 — 本地证据层（零网络）

- [x] 1.1 新增 `src/session-state.ts`：`readCookieFacts(profileDir)` 用 `bun:sqlite` **只读**打开 `Default/Cookies`（`busy_timeout=200`），读 `host_key LIKE '%weixin%'` 的 `slave_sid/data_ticket/bizuin/wxuin`，把 `expires_utc` 转 Unix 秒（`/1e6 - 11644473600`）；`expires_utc=0` 视为会话 cookie
- [x] 1.2 任何异常（文件缺失/BUSY/表结构异常）→ 返回 `{ok:false, reason}`，**不得抛**
- [x] 1.3 单测：正常 / 文件不存在 / 表缺失 / BUSY 四种输入 → 断言不抛且语义正确

**验证**：`bun tools/session-selftest.ts`（新建）全绿；`bunx tsc --noEmit` 0 错。

## Step 2 — 三态判定 + 抗抖动（止痛核心）

- [x] 2.1 `src/session-probe.ts`：`decideVerdict(facts)` 纯函数 + `probeSession(opts)`（组合 cookie / in-page 鉴权请求 / DOM）
- [x] 2.2 DOM 侧显式识别 `page_timeout` 壳页（含「登录超时」「重新登录」）→ 归入 `unknown`，**不是** invalid
- [x] 2.3 连续失败计数落盘 `data/<alias>/state/session-probe.json`（含 lastVerdict/lastEvidence/consecutiveFailures/lastProbeAt）
- [x] 2.4 `src/session.ts#ensureLoggedIn` 改为消费 `probeSession`：只有 `invalid` 或"连续失败 ≥ 阈值"才发二维码；扫码超时邮件必须携带证据摘要
- [x] 2.5 `log.info("[session] verdict=… evidence=cookie,http,dom")`；`src/cli.ts` 增 `session probe --all`（只读、幂等）
- [x] 2.6 对抗测试：故意让 DOM 探测超时 / 返回壳页 → **不**发码、**不**发失败邮件、`verdict=unknown`

**验证**：`bun tools/session-selftest.ts` 含对抗用例；`bun src/cli.ts session probe --all` 两账号输出 verdict+证据。
**Gate 2**：本地单测 + 本机（非 250）行为确认。

## Step 3 — 保活提速与预警

- [x] 3.1 `deploy/systemd/wechat-keepalive.timer`：12h → 5h（`WFC_KEEPALIVE_HOURS` 可覆盖），`AccuracySec=5m`
  - 落地：unit 里 `OnUnitActiveSec=5h` + `AccuracySec=5m`；覆盖走 `deploy/install.sh` 渲染 `wechat-keepalive.timer.d/interval.conf`（`WFC_KEEPALIVE_HOURS=4 bash deploy/install.sh`；不带变量则删除 drop-in）。`install.sh` 同时把 keepalive 两个 unit 纳入安装/启用。
- [x] 3.2 `keepalive` 成功后自动 `session snapshot`（见 Step 4）
  - 落地：`reason:"keepalive"`；快照失败只 `log.warn` + 控制台一行，**不改 keepalive 结果**（票据已顺延）。
- [x] 3.3 到期前 24h 预警（每 24h ≤1 封，独立于失败告警）
  - 落地：`src/session-warn.ts#maybeWarnExpiringSession`，状态 `data/<alias>/state/session-warn.json`；主题带 ⏳「提前预警，非失败」，发送失败**不推进** `lastWarnAt`（下次重试）；永不阻断发布。
- [x] 3.4 `keepalive --wait <sec>` 支持阻塞等待扫码
  - 落地：`keepalive` 上一轮已把 `--wait` 透传给 `ensureLoggedIn({waitSec})`，本轮仅确认并写进 `USAGE`/手动；`wechat-keepalive.service` 仍用无 `--wait` 的版本（无人值守不该挂 900s）。

**验证**：`systemctl show wechat-keepalive.timer -p NextElapseUSecRealtime` 显示 ≤6h 后；预警邮件真机收到 1 封。

## Step 4 — Cookie 快照 / 回滚

- [x] 4.1 `src/session-snapshot.ts`：`snapshot()`（tmp→fsync→rename，含 `Local State`，`manifest.json` 记 sha256+slaveSidExpiresAt）、`restore()`（停 unit → 校验 → 替换 → 启 unit → 复验）、`list()`
  - 落地 `src/session-snapshot.ts`：`snapshot/listSnapshots/pruneSnapshots/restore/sha256File/verifyCookiesDb`；`restore` 顺序为 **验 → stop → 备份 `*.pre-restore` → 删 `-wal/-shm/-journal` → 替换 → 再验 integrity → start → `needsReverify:true`**，中途失败自动回滚（幂等，内容一致不重复写）。
- [x] 4.2 `bun src/cli.ts session snapshot|restore|list --alias <a>`；保留 N=10
  - 落地：`session snapshot [--reason R] [--keep N]` / `restore --id <id|前缀>` / `list`，账号用 `-a|--all`（不是 `--alias`）；`DEFAULT_KEEP=10`，每轮 snapshot 后自动 prune。
- [x] 4.3 目录 `0700`；`.gitignore` 与 `deploy.sh` EXCLUDES 双重确认快照不进 git/不进部署
  - 落地：目录 `0700`、文件 `0600`（selftest 断言 mode）；快照落 `data/<alias>/session-snapshots/` → 被 `.gitignore` 的 `data/` 与 `deploy.sh` 的 `--exclude 'data/'` 覆盖（两处都补了注释说明是登录凭证）。
- [x] 4.4 本地演练：破坏快照源文件 → restore → 断言文件恢复且 `integrity_check=ok`
  - 落地：`tools/session-snapshot-selftest.ts`（含坏快照拒执行 / 半替换回滚 / stop 失败阻塞）+ 真 CLI 端到端（临时 alias + 伪 profile：snapshot → 破坏 live → restore → sha256 与 `PRAGMA integrity_check` 均复原）。

**验证**：本地演练通过；250 上 AC5 真机验证（Step 7）。

## Step 5 — 浏览器生命周期解耦（Q2 方案 A）

- [x] 5.1 新增 `deploy/systemd/wechat-xvfb.service`、`wechat-browser@.service`（template，`%i`=alias，`KillMode=mixed`、`Requires=wechat-xvfb.service`、`Restart=always`、Chrome 参数逐字沿用 `browser.ts:128-150`）
  - 落地：`wechat-xvfb.service`（`Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp`，`Restart=always`、`StartLimitBurst=10/300s`；不留 `RemainAfterExit`，让 `is-active` 等价于“X 真在跑”）+ `wechat-browser@.service`（`Type=simple`、`DISPLAY=:99`、`KillMode=mixed`、`KillSignal=SIGTERM`、`TimeoutStopSec=20`、`Restart=always`、`RestartPreventExitStatus=0`、`StartLimitBurst=10/300s`、`SyslogIdentifier=wechat-browser-%i`）。
  - **偏差**：Chrome 参数没有抄进 unit，而是新增 `src/browser-agent.ts` 作为 `ExecStart`，由它调 `browser.ts#buildChromeArgs` 后 `execve` 换进程（`MainPID` 仍=Chrome）。理由：抄进 unit 就有了第二份真相，指纹一漂移就是风控；这样一来参数逐字没变（`tools/browser-selftest.ts` 1a 逐字锁死 15 个参数）。
- [x] 5.2 `src/browser.ts`：`WFC_BROWSER_MODE=external|inline`；external 走 `systemctl start wechat-browser@<alias>` + 等 CDP；`inline` 前置检查 unit 是否 active（active 则拒绝 spawn，防双实例）
  - 落地：`describeBrowserMode`（env 优先 / 非法值标 `invalid` / 未设置按 unit 存在性自动判定）、`resolveBrowserMode`（非法值抛错，不猜）、`ensureBrowser` 分派；external 先在 `cdpVersion` 短路（已就绪则完全不碰 systemctl）→ `systemctl cat` 必须存在 → `start` → 轮询 CDP ≤30s → 失败抛错并附 `systemctl status` 摘要，**永不** fallback spawn。inline 在 spawn 前查 `systemctl is-active`，active 即报错拒绝。SingletonLock 清理仅保留在 inline 路径。
  - `doctor --all` 增 `browser 托管方式` 行（含来源 env/auto 与 unit 是否存在）。
- [x] 5.3 `deploy/install-console.sh`/`console-deploy.md` 更新：enable Xvfb + 两 browser unit；说明迁移窗口与回滚
  - 落地：`deploy/install.sh`（安装 `wechat-xvfb.service` + `wechat-browser@.service` 模板并 **仅 enable** xvfb；不自动 enable 具体 alias 实例；末尾打印 7 步迁移顺序）；`docs/操作手册.md` 新增 §2.5「浏览器独立托管」；`.trellis/spec/console/ops-deploy.md` 新增「二·补 浏览器 unit 契约」。
  - **偏差**：`install-console.sh`/`console-deploy.md` 在仓库里不存在，实际落点是 `deploy/install.sh` + 操作手册 + ops-deploy.md（与仓库现状一致）。
- [x] 5.4 `deploy.sh` 后置检查：`systemctl is-active wechat-browser@{second,gaoh}` + `session probe --all` 必须 valid，否则非零退出并打印证据
  - 落地：新增 `deploy/session-check.sh`（xvfb active；每 alias unit active **且 MainPID 的 cmdline 是 chrome**；`session probe -a <alias> --json` 逐账号判定），`deploy.sh` rsync 后调用它，失败即非零退出并打印取证命令；`WFC_DEPLOY_SKIP_CHECKS=1` 可跳过。
  - **偏差**：口径从「必须 valid」放宽为「**不得 invalid**」——`unknown`（证据不足）不算失败，否则网络抖一下就会把部署判红（与 Step 2 的三态语义一致）。

**验证**：本机无 systemd 场景下用 `WFC_BROWSER_MODE=inline` 回归（不得破坏现有行为）；unit 文件 `systemd-analyze verify`。

- [x] 本机已验证：`tsc` 0 错；`tools/browser-selftest.ts` 19 项全通过（含 15 个 Chrome 参数逐字锁定、4 种 external 失败路径、inline 双实例守卫）；`WFC_BROWSER_MODE=inline bun src/cli.ts doctor --all` 不报错（新守卫未误伤）；`WFC_BROWSER_MODE=external` 时 `ensureBrowser` 明确抛错且不 spawn；`systemd-analyze verify` 仅报本机缺 `bun` 路径（250 上存在）；`bash -n` 全部通过。
- [ ] 250 真机迁移与 AC5 验收按 Step 7（本轮**未**动 250）。

## Step 6 — 可观测接入

- [x] 6.1 `src/cli.ts#doctor` 增 `mp-session` 行（verdict / slave_sid 剩余 / last keepalive / evidence）
  - 落地行：`mp-session  unknown · slave_sid 71.0h · last keepalive 3.0h ago · snapshots 1 · evidence=…`（含快照份数）。
- [x] 6.2 `status` 输出各账号会话剩余时长
  - 落地行：`session   : ok(in 71.0h) · last keepalive 3.0h ago · snapshots 1`（非 browser 号打印 `n/a`）。
- [x] 6.3 控制台账号视图只读展示会话剩余时长（`GET /api/accounts` 增字段，S1 语义：只读派生，不落库）
  - 落地：`src/console/server.ts#sessionSummary` 挂到 `GET /api/accounts` 每项与 `GET /api/accounts/:id`，字段 `{ok,verdict,slaveSidExpiresAt,hoursLeft,lastKeepaliveAt,cookieReason?}`；无库列、不打开浏览器、不写文件；失败显式 `{ok:false,reason}`。契约已写入 `.trellis/spec/console/api.md` §2.2。

**验证**：`doctor --all` 与 `status --all` 输出符合预期；`tsc` 0 错。

## Step 7 — 250 真机验收（核心 AC）

- [x] 7.1 迁移窗口（当天发布完成后）：`systemctl stop` 旧裸 Chrome（优雅）→ `enable --now wechat-browser@{second,gaoh}` → `session probe --all` 两账号 **valid 且无需扫码**
- [x] 7.2 **AC4**：连续 3 轮 `bash deploy/deploy.sh` + `systemctl restart wechat-console` → 每轮后 probe valid，**0 次扫码**
- [x] 7.3 **AC5**：破坏 cookie → `session restore` → 恢复 valid
- [ ] 7.4 **AC3**：真实失效路径至少验证 1 次（可用 `session invalidate`（仅本地 cookie 删除）+ 用户扫码）
- [x] 7.5 **AC6a/AC7**：keepalive 下一触发 ≤6h；当天 `drafts --all --date <today>` 两账号 `✅ 正文校验`

**Gate 3（G2）**：发布链路相关改动后需真机 `✅ 正文校验` 证据方可放行。

## Step 8 — 收口

- [x] 8.1 `.trellis/spec/engine/verification.md` 增「会话判定三态 + 证据层级」契约；`error-handling.md` 增「page_timeout 壳页 ≠ 退登」
- [x] 8.2 `AGENT.md` §1/§2/§5/§9 更新（含新的运维事实：浏览器已由独立 unit 托管，重启 console 不再影响登录态）
- [x] 8.3 `docs/操作手册.md` 增「会话快照/回滚/回退到 inline」三节
  - 已完成三节：§2.4「会话寿命管理（保活/快照/回滚/到期预警/三态判定）」+ §1.4 keepalive timer 行 + §2.2 命令表新增 `keepalive`/`session`；「回退到 inline」落在 §2.5c「浏览器独立托管 → 回退到 inline（一键）」（含 `disable --now` 先于 `restart console` 的顺序说明，否则 inline 守卫会拒绝 spawn）。
- [ ] 8.4 `bash tools/repomap.sh` 刷新 `TREE.md`

## 回滚点

| 阶段 | 回滚动作 |
|---|---|
| Step 2/3（判定与保活） | 单个 env 关闭：`WFC_SESSION_FAIL_THRESHOLD=1` 回到"一次失败即扫码"的旧行为 |
| Step 5（拓扑） | `WFC_BROWSER_MODE=inline` + `systemctl disable --now wechat-browser@*` |
| Step 4（快照） | 快照目录独立，删除即停用；不影响现网 |
| 全局 | `git revert <commit>` + `systemctl restart wechat-console`（浏览器按 Step 5 回滚） |
