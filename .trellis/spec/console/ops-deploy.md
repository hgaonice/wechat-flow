# Ops & Deploy（控制台部署与加固）—— C6

> **状态：v1.1（2026-10-20 增补「浏览器 unit 契约」；C1 Step5 实现后校准）**。
> 契约与代码冲突时：**先改本文件，再改代码**。
> 关联：`ops-tunnel.md`（隧道监督）、`security.md`（K1 限流/暴露面）、`api.md`（429/`/health`）。

---

## 一、部署模式（D28）

| 模式 | 组成 | `CONSOLE_TUNNEL` | 说明 |
|---|---|---|---|
| **Mode A（唯一支持）** | `wechat-console.service`（进程内监督 `cloudflared`） | `1` | console 启动 `TunnelSupervisor`，C5 `/api/tunnels` 与地址变更邮件可用 |
| Mode B（备用，**互斥**） | `wechat-console.service` + `cloudflared.service` | `0` | 外部托管隧道；**会使 C5 隧道状态与变更邮件失效**，unit 与手册必须醒目标注 |

- **D28**：两种模式**互斥**；同时启用会双隧道冲突。安装脚本默认 Mode A。
- 控制台只监听 **`127.0.0.1`**（`CONSOLE_HOST`）；由隧道/反代对外。
- **I34**：**CDP 端口绝不暴露**（沿用 I27/`security.md` §8）；反代示例仅反代控制台端口。

---

## 二、systemd 契约（I6-1/I6-2）

- `wechat-console.service`：`Type=simple`、`Restart=on-failure`、`RestartSec=5`、`KillSignal=SIGTERM`（触发 `main.ts` 优雅退出：`scheduler→worker→chat→tunnel→server→db`）。
- 环境：`EnvironmentFile=-/etc/default/wechat-console`（`wechat-console.env.example` 为模板）；**环境文件不含明文密钥**（master key 走 0600 文件）。
- 沙箱：**保守**（`NoNewPrivileges=true` + 必要 `ReadWritePaths`）；**禁用会阻断 Chrome/CDP 的指令**（如 `ProtectSystem=strict`）。
- 旧 systemd timer（`wechat-plan.timer`/`wechat-publish.timer`）**保留不删**，由 `disable-timer.sh` 停用以便回退。

### 二·补 浏览器 unit 契约（C1 Step5 / R3-R4）

> 目的：**重启/部署 console 不得影响公众号登录态**。E1/E2 已证明重启 console 不会杀 Chrome，
> 但 Chrome 的 renderer 当时寄生在 SSH 会话 cgroup（E4），且没有任何机制阻止同 profile 双开。

| unit | 拥有什么 | 契约 |
|---|---|---|
| `wechat-xvfb.service` | `Xvfb :99`（共享显示） | `Restart=always` + `StartLimitBurst=10/300s`（**不用** `RemainAfterExit`：`is-active` 必须等价于“X server 真的在跑”，部署自检依赖这一条）；显示是共享资源（两个 Chrome 都要可见性），**不得**放进 console 的 cgroup |
| `wechat-browser@<alias>.service` | 一个 Chrome（每 alias 一个） | 模板 unit，`%i`=alias；`Requires=wechat-xvfb.service`、`KillMode=mixed`、`TimeoutStopSec=20`、`Restart=always`、`RestartPreventExitStatus=0`、`StartLimitBurst=10/300s` |
| `wechat-console.service` | **只是 CDP 客户端** | 不再 spawn Chrome（`WFC_BROWSER_MODE=external` 时）；重启它是登录态的 no-op |

**契约条款**

1. **单实例是硬约束**：unit 名就是锁。inline 模式 spawn 前必须检查 `systemctl is-active wechat-browser@<alias>`，active 则**报错拒绝**（不降级、不强起）。同 profile 双开＝微信判定异常登录＝踢线 + 强扫码。
2. **Chrome 参数单一真相源**：只在 `src/browser.ts#buildChromeArgs`；unit 的 `ExecStart` 只调 `src/browser-agent.ts --account %i`，agent 用 `execve` 把自己换成 Chrome（systemd `MainPID` 即 Chrome）。**禁止**把 flags 复制进 unit 文件（指纹漂移 = 风控）。
3. **停止语义**：`KillMode=mixed` 先给主进程 SIGTERM（Chrome 有窗口 flush Cookies SQLite），`TimeoutStopSec=20` 之后才 SIGKILL 残留。**禁止** cgroup 级硬杀（`KillMode=control-group` / `systemctl kill -s SIGKILL`）—— 那是 `session restore` 需要的“干净文件”前提。
4. **external 模式绝不回退 spawn**：unit 不存在 / `systemctl start` 失败 → 抛明确错误（带 `systemctl status` 摘要与 `inline` 回滚提示），**不得**静默 spawn 第二个 Chrome。
5. **托管方式判定**：`WFC_BROWSER_MODE=external|inline` 优先；未设置时按 unit 是否存在自动判定（250=external、开发机=inline）。非法值在 `ensureBrowser` 抛错、在 `doctor` 显形（`browser 托管方式` 行）。
6. **部署后自检**：`deploy/deploy.sh` 跑完 rsync 后调用 `deploy/session-check.sh`，① `wechat-xvfb.service` active ② 每 alias 的浏览器 unit active **且 MainPID 是 chrome** ③ `session probe --no-persist` 逐账号无 `invalid`（`unknown` 不算失败）。任一失败 → **非零退出**并打印证据；`WFC_DEPLOY_SKIP_CHECKS=1`（只跳过自检，不修任何东西）。
   两个豁免，避免把迁移中间态/部署自身判成故障：**(a)** unit 装了但从未 enable（`systemctl is-enabled` = `disabled`）→ 黄字提示「迁移未完成」而非失败；**(b)** 探针必须带 `--no-persist`，部署不得推高 `consecutiveFailures` 而间接触发扫码。
7. **迁移顺序**（一次性，不需要扫码）：`install.sh` → 停 console → 停裸 Chrome（SIGTERM）→ 停裸 Xvfb → `start wechat-xvfb` → `enable --now wechat-browser@<alias>` ×N → `restart wechat-console` → `session-check.sh`。顺序反了会出现“unit active 但 MainPID 不是 chrome”（裸 Chrome 占着 CDP 端口），`session-check.sh` 会当场报出来。
8. **回滚**：`WFC_BROWSER_MODE=inline` + `systemctl disable --now wechat-browser@<alias>` + `restart wechat-console`（先 disable 再 restart，否则 inline 守卫会拒绝 spawn）。

---

## 三、限流（I29 / D29）

- 机制：**进程内令牌桶**，容量 `CONSOLE_RATE_BURST`（默认 120），速率 `CONSOLE_RATE_PER_MIN`（默认 600）/分钟；`CONSOLE_RATE_PER_MIN=0` 关闭。
- 作用域：仅 `/api/*`；`/health` 与静态资源不计数。
- key：已登录 = `u:<userId>`；未登录 = `ip:<clientKey>`，`clientKey` 优先 `CF-Connecting-IP`（仅 `CONSOLE_TRUST_CF=1`），否则 `x-forwarded-for` 首段，否则退 `x-real-ip`，最终 `local`（`clientIp`）。
- 超限：**429** `rate_limited`，响应带 `Retry-After: <sec>`；**不写审计**（避免被放大成审计洪泛）。
- 与登录锁定互补：`login_attempts` 仍按用户名 15 分钟窗口锁定（`security.md` §2）。

---

## 四、备份 / 恢复（I30/I31 / D30）

- **备份**：`main.ts --backup <file>` 用 `VACUUM INTO`（先写 `<file>.tmp` 再 `rename`，**原子**），随后 `PRAGMA integrity_check`。
  `deploy/console-backup.sh` 打包 `console.db` + `data/` + `config.json` + `master.key`（`0600`）+ `manifest.txt`（不含密钥内容）；保留最近 `KEEP`（默认 7）份。
- **预检**：`main.ts --restore-check <file>` 只读校验 `integrity_check` + `user_version` + 表计数。
- **恢复**：`deploy/console-restore.sh <tgz>` **要求服务未运行**（否则拒绝，除非 `--force`）；先备份现状 → 预检 → 替换 → 提示启动。
- **I30**：快照原子（无 `.tmp` 残留）；**I31**：恢复前停服 + 预检 + 自动备份现状。

---

## 五、失败退避（I32 / D31）

- `queue.countFailed`/`queue.lastFailureAt`：同 `(account_id, kind, json.date)` 的 `failed` 计数与最近失败时刻（`ended_at ?? queued_at`）。
- `schedulerTick`：达 `CONSOLE_JOB_MAX_ATTEMPTS`（默认 3，`0`=不限）→ **skip**（`attempts-exhausted`）；最近失败距今 < `CONSOLE_JOB_RETRY_COOLDOWN_MIN`（默认 30，`0`=不冷却）→ **skip**（`backoff`）。
- `now` 仍为入参（可测）；skip 留痕（日志/审计），**不伪装成功**（AC-11）。

---

## 六、`/health`（I33 / D32）

```json
{"ok":true,"data":{"status":"ok","version":"0.1.0","uptimeSec":12,"db":"ok","tunnel":"up"}}
```

- 免鉴权；遵循全局信封 `{ok,data}`（字段在 `data` 内）。`db` ∈ `ok|error`（`SELECT 1`）；`tunnel` = 最新 DB 行 `status`，无行时回落监督器存活（`up|down`），未启用监督器则 `null`。
- **I33**：**不含**账号数/队列长度/URL/密钥等敏感字段。

---

## 七、反模式

| 反模式 | 后果 |
|---|---|
| 同时启用 Mode A 与 `cloudflared.service` | 双隧道冲突、邮件不可信 |
| 经反代/隧道放行 CDP 端口 | 远程接管 Chrome（I27/I34） |
| 用 `cp` 直接拷 WAL 下的 `.db` 做备份 | 快照不一致 |
| 恢复时不停服 | 覆盖中的数据/损坏 |
| 限流覆盖 `/health` 或静态资源 | 监控误报 / UI 失效 |
| 失败作业无退避地每分钟重试 | 重试风暴（D31 修复对象） |
| `/health` 暴露账号/队列细节 | 信息泄露 |
| 启用会阻断 Chrome 的强沙箱 | 浏览器发布失败 |
| 把 Chrome 参数抄进 unit 文件 | 两份真相漂移 → 指纹变化 → 微信风控/扫码 |
| external 模式下失败后“自动回退 spawn” | 同 profile 双实例 → 账号被踢线 |
| 同 alias 开两个浏览器（inline + unit） | 同上 |
| 部署后不做会话自检就宣布完成 | “部署成功但已掉线”，等当天发布才暴雷 |

---

## 八、校准记录（v0 → v1，C6 实现后）

| 项 | v0 规划 | v1 实际 | 说明 |
|---|---|---|---|
| 限流文件 | `http/ratelimit.ts`（新） | ✅ `http/ratelimit.ts`（109 行，令牌桶 + `take/size/remove`，惰性清扫） | 零依赖、`now` 可注入 |
| 限流接入 | `handle()` 前 | ✅ `server.ts#handle()`，仅 `pathname.startsWith("/api/")` | key `u:<userId>` / `ip:<clientKey>` |
| 限流 env | `CONSOLE_RATE_PER_MIN/BURST` | ✅ 同左，另 `CONSOLE_TRUST_CF` | 429 不写 audit |
| `/health` | `{status,version,uptimeSec,db,tunnel}` | ✅ 同左；`db` 由 `SELECT 1` 判定；`tunnel` 由 `tunnelHealth(ops)` | HTTP 200 即使 `db="error"` |
| tunnel 状态源 | `ops.tunnel.status().status` | `tunnelHealth(db, ops)`：**优先**最新 DB 行 `status`（`up\|down\|expired\|error`，I24/I28），无行时才回落 `running?"up":"down"` | `TunnelSupervisor.status()` 无 `status` 字段故需回落 |
| 退避查询 | `countFailed`/`lastFailureAt` | ✅ `jobs/queue.ts`，按 `payload.date`\|`periodKey` 匹配 | `COALESCE(ended_at,queued_at)` |
| 退避 env | `CONSOLE_JOB_MAX_ATTEMPTS`(3) / `CONSOLE_JOB_RETRY_COOLDOWN_MIN`(30) | ✅ 同左（每 tick 读取，clamp） | skip 日志 `[scheduler] skip … (backoff\|attempts-exhausted)` |
| 时间归一 | — | SQLite `datetime('now')` （UTC）→ `T`/`Z` 归一后 `Date.parse` | 已 ISO 的串原样解析 |
| 备份子命令 | `--backup`/`--restore-check` | ✅ `main.ts`；`VACUUM INTO <file>.tmp` → 校验 → rename | 原子、失败清理 `.tmp` |
| 备份/恢复脚本 | `deploy/console-{backup,restore}.sh` | ✅ 同左；archive `0600`；恢复强制停服 + 预检 + 现状快照 | 含 `master.key`（敏感） |
| systemd | `wechat-console.service` + `cloudflared.service` | ✅ 同左；`systemd-analyze verify` 仅报开发机无 bun 路径 | 保守沙箱（不 `ProtectSystem=strict`） |
| SSE 修复 | N1/N2/N3 | ✅ `chat-sse.ts` cleanup 前置 + 已 abort 立即清理；`events.ts close()` 先广播 `chat.closed` 再清理；`ui/chat.js` 收到 `chat.closed`/`chat.lost` 关闭 ES | `close(sessionId, payload={status:"closed"})` |
| 非阻塞观察 | — | `ChatBus.close` 可能与应用层 `emit` 重复投递 `chat.closed`（客户端幂等）；限流 key 在未登录时对直连 loopback 可能回落 `local`（受 `CONSOLE_TRUST_CF` 控制） | 仅登记 |
| 浏览器托管（C1 Step5） | （新增） | ✅ `deploy/systemd/wechat-xvfb.service` + `wechat-browser@.service` + `src/browser-agent.ts`（execve 换进程，MainPID=chrome）+ `browser.ts` 模式分派；`deploy/session-check.sh` 作为部署后自检 | `systemd-analyze verify` 仅报开发机无 `/root/.nvm/.../bun` 路径 |
| 单实例约束 | （新增） | ✅ external 由 unit 名互斥；inline 前置 `systemctl is-active` 守卫（active 即报错拒绝 spawn） | 与 `session-snapshot.restore` 的 stop/start 语义一致 |
| 部署后自检 | （新增） | ✅ `deploy.sh` → `session-check.sh`：xvfb + 每 alias unit（MainPID 必须是 chrome）+ `session probe` 无 `invalid`；`WFC_DEPLOY_SKIP_CHECKS=1` 应急跳过 | 失败非零退出且打印证据，不自动“修复” |
