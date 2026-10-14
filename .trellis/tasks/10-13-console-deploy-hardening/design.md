# design.md · C6 部署与加固（console-deploy-hardening）

> 父任务 `10-13-wechat-flow-console`（源需求 R5 + 全局验收 K1/AC-10/AC-11）。
> 依赖 C1–C5 全部交付。本任务**不改发布链路**、**不动 engine**、**零新增运行时依赖**。

---

## 0. 决策门（G-C6）

开工前需用户确认的关键取舍（已按工程最优给出推荐）：

| # | 议题 | 推荐 | 备选 | 影响 |
|---|------|------|------|------|
| G-C6-1 | `cloudflared` 由谁托管 | **console 进程内监督（Mode A，`CONSOLE_TUNNEL=1`）**，单一 `wechat-console.service` | 外部 `cloudflared.service`（Mode B） | Mode B 会让 C5 `/api/tunnels` 与「地址变更邮件」失效（见 D28） |
| G-C6-2 | 公网前置身份门 | 可选 **Cloudflare Access**（文档化，不强制） | 仅强口令 + 限流锁定 | 影响 `security.md` §1 描述 |
| G-C6-3 | 备份是否含 `master.key` | **含**（否则凭据不可解），但单独标注敏感、`0600` | 不含（恢复后需重新录入凭据） | 影响 `console-backup.sh` 产物 |
| G-C6-4 | systemd 沙箱强度 | **保守**（`NoNewPrivileges` + 必要 `ReadWritePaths`），不启用会阻断 Chrome 的指令 | 激进（`ProtectSystem=strict`…） | 激进会破坏浏览器发布（engine 需写 profile/`/tmp`） |

> 推荐项默认按上表执行；若用户否决，只改对应子部件，不动其余。

---

## 1. 目标与边界

**做**：把控制台安全部署到 250 并通过 Cloudflare 公网可达；限流与锁定；备份/恢复；迁移与回滚手册；
systemd 服务化；文档/spec/AGENT 同步；AC-1…AC-11 全量端到端回归；登记 G6/G7。

**不做**：新业务功能；改 `runPublish`/`verifyDraftBody`/CDP/`pi.ts`/`wechat.ts`/`publisher.ts`/`mailer.ts`；
迁移既有 `data/` 目录结构；引入前端构建或第三方依赖。

---

## 2. 交付物地图

| 类别 | 产物 |
|---|---|
| 代码（`src/console/**`，纯增量） | `http/ratelimit.ts`（令牌桶）；`server.ts` 接限流 + `/health` 增强 + 429/`Retry-After`；`jobs/{queue,scheduler}.ts` 失败退避；`agent/events.ts` + `http/chat-sse.ts` 遗留修复；`main.ts` `--backup`/`--restore-check` 子命令 |
| 部署脚本 | `deploy/systemd/wechat-console.service`、`deploy/systemd/cloudflared.service`（可选）、`deploy/systemd/wechat-console.env.example`、`deploy/install-console.sh` |
| 备份/恢复 | `deploy/console-backup.sh`、`deploy/console-restore.sh` |
| 反代示例 | `deploy/nginx-console.conf.example`（可选） |
| 手册 | `deploy/console-deploy.md`（部署/迁移/回滚）、`deploy/console-acceptance.md`（AC e2e 清单） |
| 文档 | `README.md`、`docs/操作手册.md`（相关节） |
| spec | 新增 `.trellis/spec/console/ops-deploy.md`；`api.md`/`security.md`/`index.md` 校准 v6 |
| 治理 | `AGENT.md`（S17 ✅、任务图 6/6、D28–D33、G6/G7）、`src/README.md`、`TREE.md` |

---

## 3. 关键决策

| # | 决策 | 理由 |
|---|------|------|
| **D28** | `cloudflared` 托管 = **Mode A（console 进程内监督）为唯一支持模式**；`cloudflared.service` 仅作 Mode B（外部托管）备用，**与 Mode A 互斥**，并在 unit 注释/手册醒目标注 Mode B 会使 C5 `/api/tunnels` 与地址变更邮件失效 | C5 已定隧道**全局单例**由 `TunnelSupervisor` 管理（D-C5-5）；两处同时 spawn 会双隧道冲突且邮件不可信 |
| **D29** | 限流 = **进程内令牌桶**，只作用于 `/api/*`；key = 已登录 `userId`，未登录用客户端 IP（`CONSOLE_TRUST_CF=1` 时取 `CF-Connecting-IP`，否则 `x-forwarded-for` 首段，再否则 `unknown`）；超限 429 `rate_limited` + `Retry-After`；`/health`、静态资源不计数 | 零依赖、可预测；登录暴力另有 `login_attempts` 锁定兜底 |
| **D30** | 备份 = **`VACUUM INTO`** 一致性快照（`main.ts --backup`）+ `data/`/`config.json`/`master.key` 打包；恢复 = 停服→校验→替换→启动，脚本幂等且**先备份现状** | WAL 下直接拷 `.db` 会不一致；不迁移 `data/` 结构 |
| **D31** | 调度器失败退避：同 `(account,kind,date)` 的 `failed` 计数计入预算（`CONSOLE_JOB_MAX_ATTEMPTS` 默认 3）+ 冷却窗（`CONSOLE_JOB_RETRY_COOLDOWN_MIN` 默认 30min，按 `ended_at`/`queued_at` 与 `now`）；超预算/窗内不再入队 | 修复 C2 遗留：失败作业被每分钟重试（重试风暴），且对内容/发布重试应封顶 |
| **D32** | `/health` 增强为**免鉴权安全子集** `{status,version,uptimeSec,db,tunnel}`（无账号/队列/密钥）；原字段保持 | 可监控且不泄露；同时修正 design.md §9 与 `api.md` 的旧描述 |
| **D33** | 修复 C4/C5 遗留：`chat-sse` 重放阶段失败可清理；`ChatBus.close` 广播终态；`signal` 已 abort 立即清理；`chat.js` 收 `chat.closed`/`chat.lost` 关闭 EventSource | 消除 SSE 泄漏与前端悬挂长连接（N1–N3） |

---

## 4. 部件设计

### 4.1 限流（`http/ratelimit.ts`）

```ts
export class RateLimiter {
  constructor(opts: { perMin: number; burst: number; now?: () => number });
  /** true=放行；false=限流，附 retryAfterSec */
  take(key: string): { ok: true } | { ok: false; retryAfterSec: number };
  size(): number;
}
```

- 令牌桶：容量 `burst`，补充速率 `perMin/60000` 每毫秒；`take` 惰性补令牌。
- `key` 计算：`session ? "u:"+userId : "ip:"+clientKey(req)`；`clientKey` 优先 `CF-Connecting-IP`（仅 `CONSOLE_TRUST_CF=1`），否则 `x-forwarded-for` 首段，否则 `"unknown"`。
- 接入点：`server.ts#handle()` 在 `route()` 之前；仅当 `pathname` 以 `/api/` 开头（且**排除** `/api/*/stream` 之类长连接？——SSE 建立只计 1 次即可）时计数。
- 429 响应带 `Retry-After: <sec>`；**不写审计**（避免被放大成审计洪泛）。
- 环境变量：`CONSOLE_RATE_PER_MIN`（默认 600）、`CONSOLE_RATE_BURST`（默认 120）；`CONSOLE_RATE_PER_MIN=0` → 关闭限流。
- 清扫：`take` 时对空桶做惰性回收；`setInterval(unref)` 兜底（可选）。

### 4.2 失败退避（`jobs/queue.ts` + `jobs/scheduler.ts`）

- `queue.countFailed(db, accountId, kind, date)`、`queue.lastFailureAt(db, accountId, kind, date)` → 返回 `ended_at ?? queued_at`。
- `schedulerTick`：为 publish/plan 各自维护预算：
  - `failed >= maxAttempts` → **skip**（`actions` 不含；`console.log("[scheduler] skip ... attempts-exhausted")`）。
  - `now - lastFailure < cooldownMin*60_000` → **skip**（`backoff`）。
  - 否则照旧入队。
- 参数来自 env（读一次/clamp）：`CONSOLE_JOB_MAX_ATTEMPTS`（默认 3，0=不限）、`CONSOLE_JOB_RETRY_COOLDOWN_MIN`（默认 30，0=不冷却）。
- `now` 仍是参数 → 单测可注入时间。

### 4.3 备份 / 恢复

- `main.ts --backup <file>`：`VACUUM INTO '<tmp>'`（`<file>.tmp`，成功 `rename` 到 `<file>`），随后 `PRAGMA integrity_check` + 打印 `user_version`；**只做 DB**。
- `main.ts --restore-check <file>`：只读打开，`integrity_check` + 表计数，供恢复前预检。
- `deploy/console-backup.sh`：
  1. `--backup` 出 `console.db` 快照 → `$OUT/console.db`；
  2. `tar czf $OUT/backup-<ts>.tgz console.db data/ config.json master.key manifest.txt`（缺失项跳过并记录）；
  3. 保留最近 `KEEP`（默认 7）份，旧份删除；
  4. `manifest.txt` 含版本/时间/文件清单（不含任何密钥内容）。
- `deploy/console-restore.sh <tgz>`：要求 `systemctl is-active wechat-console` 未运行（否则拒绝，除非 `--force`）；解包到临时目录 → `--restore-check` → 备份现状 → 替换 `console.db`/`data/`/`config.json`/`master.key`（0600）→ 提示 `systemctl start`。

### 4.4 systemd（I6-1/I6-2）

`deploy/systemd/wechat-console.service`（Mode A）：

```ini
[Unit]
Description=wechat-flow console (HTTP + scheduler + worker + tunnel)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/wechat-flow
EnvironmentFile=-/etc/default/wechat-console
ExecStart=/root/.nvm/versions/node/v24.14.1/bin/bun src/console/main.ts
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=30
# 保守沙箱：不启用会阻断 Chrome/CDP 的指令
NoNewPrivileges=true
ReadWritePaths=/root/wechat-flow /root/.wechat-console
[Install]
WantedBy=multi-user.target
```

- `deploy/systemd/cloudflared.service`（**Mode B，可选，与 Mode A 互斥**）：注释写明「启用本服务须设 `CONSOLE_TUNNEL=0`，否则双隧道；且会关闭 C5 隧道状态与变更邮件」。
- `deploy/systemd/wechat-console.env.example`：`CONSOLE_HOST=127.0.0.1`、`CONSOLE_PORT=8787`、`CONSOLE_TUNNEL=1`、`CONSOLE_TUNNEL_*`、`CONSOLE_RATE_*`、`CONSOLE_JOB_*`、`CONSOLE_MAX_CONCURRENCY`、`CONSOLE_ALLOW_INSECURE_COOKIE`（保持未设置）。
- `deploy/install-console.sh`：装 unit → 建 `/etc/default/wechat-console`（若缺）→ `daemon-reload` → 停用旧 timer（调用既有 `disable-timer.sh`）→ `enable --now wechat-console` → 打印状态。
- `deploy/nginx-console.conf.example`：可选本机反代示例（`listen 127.0.0.1`，只反代 8787），注释强调**绝不放行 CDP 端口**。

### 4.5 `/health` 增强

```json
{"status":"ok","version":"0.1.0","uptimeSec":12,
 "db":"ok","tunnel":"up"}
```

- `db`：`SELECT 1` 成功=ok，异常=error（`status` 仍 200，便于探活区分）。
- `tunnel`：`ops?.tunnel?.status().status ?? null`（未启用 = null）。
- **不含**账号数/队列长度/URL。

### 4.6 遗留缺陷修复

| 项 | 修复 |
|---|---|
| N1 chat-sse 重放期清理 no-op | 先定义 `cleanup` 骨架并让 `safeEnqueue` 失败即 `abort` 整条流（标志位），订阅/心跳仅在“未失败”时建立；或用 try/finally 包裹重放 |
| N2 `ChatBus.close` 不通知订阅者 | `close()` 前向监听者广播 `chat.closed`（best-effort），再清状态 |
| N3 signal 已 abort | 订阅前 `if (signal?.aborted) → 立即 cleanup` |
| 前端 | `chat.js` 在 `chat.closed`/`chat.lost` 时 `state.es?.close(); state.es=null` |

---

## 5. 契约与不变量（C6 新增）

- **I29**：限流为单实例令牌桶；超限 429 `rate_limited` + `Retry-After`；限流事件不写 `audit`。
- **I30**：备份快照原子生成（临时名 → rename），失败不留半成品。
- **I31**：恢复前必须确认服务未运行；自动备份现状；DB 需通过 `PRAGMA integrity_check`。
- **I32**：同 `(account,kind,date)` 失败有预算与冷却；达上限后不再入队并留痕。
- **I33**：`/health` 只含 `status/version/uptimeSec/db/tunnel`，无敏感字段。
- **I34**：部署仅监听 `127.0.0.1`（或经反代）；**CDP 端口绝不暴露**（沿用 I27）；systemd 环境文件不含明文密钥。

---

## 6. 兼容性与回滚

- **向后兼容**：`/health` 只加字段；限流可用 env 关闭；退避只影响“失败后是否重试”，不改变成功路径；`--backup` 为新增子命令。
- **回滚**：恢复 `config.json.bak` + 停 `wechat-console.service` + 启用旧 timer（`enable-timer.sh`）+ 恢复 DB 快照；
  每个子步骤独立可回滚（见 `implement.md` §3）。
- **迁移期**：C6 之后默认不再使用 systemd timer 触发；timer 单元**保留**不删。

---

## 7. 风险

| 风险 | 兜底 |
|---|---|
| 激进 systemd 沙箱阻断 Chrome | 用保守沙箱；`deploy/console-deploy.md` 记录“若发布失败先放开沙箱” |
| 限流误伤 SSE / 正常 UI | 只限 `/api/*`、给足 burst、`/health`/静态豁免、可 env 关闭 |
| 备份含 `master.key` 泄露 | 产物 `0600` + 手册警示；`manifest.txt` 不含密钥 |
| 恢复覆盖线上 DB | 强制停服 + 先备份现状 + `integrity_check` |
| Mode A/B 双隧道 | D28：互斥并文档化；安装脚本默认 Mode A |

---

## 8. 验收映射

| AC | 验证 |
|---|---|
| AC-10 | `bunx tsc --noEmit`、`bun build`、`dependencies` 仍无、`cli.ts doctor --all`、`cli.ts publish --dry-run` |
| AC-11 | 失败路径 e2e：限流 429、备份失败显形、恢复前置失败拒绝、调度达上限 skip 留痕 |
| AC-1..AC-9 | 全量回归脚本（C1–C5 各自验证 + 端到端） |
| C6 专项 | 限流/退避/备份恢复/`/health`/SSE 修复 的单测与脚本 |

---

## 9. 遗留观察项登记

- C2：失败无退避 → **本任务 D31 修复**。
- C4：N1/N2/N3 + `decision.expired` 命名 → N1–N3 本任务修；命名仅登记（不改事件名，避免破坏前端契约）。
- C5：`emailConfigFor` 忽略全局 `notify.email.enabled=false` → **保留**（C5 只在隧道变更时发信，不受全局开关影响；改语义会破坏 AC-8）。仅登记。
- C5：`chat.closed` 前端不关流 → 本任务 D33 修复。
