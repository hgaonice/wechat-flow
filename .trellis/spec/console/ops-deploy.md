# Ops & Deploy（控制台部署与加固）—— C6

> **状态：v0（C6 规划，2026-10-14）**，实现后校准为 v1。
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

---

## 三、限流（I29 / D29）

- 机制：**进程内令牌桶**，容量 `CONSOLE_RATE_BURST`（默认 120），速率 `CONSOLE_RATE_PER_MIN`（默认 600）/分钟；`CONSOLE_RATE_PER_MIN=0` 关闭。
- 作用域：仅 `/api/*`；`/health` 与静态资源不计数。
- key：已登录 = `u:<userId>`；未登录 = `ip:<clientKey>`，`clientKey` 优先 `CF-Connecting-IP`（仅 `CONSOLE_TRUST_CF=1`），否则 `x-forwarded-for` 首段，否则 `unknown`。
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
{"status":"ok","version":"0.1.0","uptimeSec":12,"db":"ok","tunnel":"up"}
```

- 免鉴权；`db` ∈ `ok|error`（`SELECT 1`）；`tunnel` = 监督状态 `status` 或 `null`（未启用）。
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

---

## 八、校准记录

- v0：C6 规划稿（待实现后校准为 v1）。
