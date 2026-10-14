# design.md · C5 运维与公网（console-ops-tunnel）

> 配套：需求见 `prd.md`，排期见 `implement.md`，父设计见 `../10-13-wechat-flow-console/design.md` §5.6/§7。
> 定位：在 C1 骨架之上加**隧道监督 + 邮件下发 + 凭据加密 API + 管理员总览**；**不改 engine 与发布铁律**。

---

## 1. 边界与总体形态

```text
        cloudflared (quick tunnel, 子进程)
             │  --url http://127.0.0.1:8787
             ▼
    https://<rand>.trycloudflare.com ──► 127.0.0.1:8787 (Bun.serve)
                                             │
        ┌────────────────────────────────────┴──────────────────────────┐
        │ console (Bun.serve)                                            │
        │  server.ts   ── /api/accounts/:id/{email,secrets}              │
        │              ── /api/tunnels[/current,/restart,:id/notify]     │
        │              ── /api/admin/overview                            │
        │  tunnel/cloudflared.ts  ── spawn/解析/健康/变更检测/监督        │
        │  notify/tunnel-mail.ts  ── 组装 + 去重 + 重试 + 审计            │
        │  db/dao/{emails,secrets,tunnels}.ts                            │
        │  crypto/secrets.ts (C1，复用)                                   │
        └───────────────────────────────┬───────────────────────────────┘
                                        ▼
                                  console.db (WAL)
        engine: src/mailer.ts sendMail()  (复用，不改)
```

**边界原则**：C5 只做「监督 + 通知 + 凭据存取 + 总览」。**CDP 端口绝不入隧道**；隧道**只**映射控制台端口。

## 2. 数据模型（迁移 v3，纯加法）

C1 已建 `account_email` / `secrets` / `tunnels`（见 `spec/console/data-model.md`）。C5 仅需在 `tunnels` 上加两列：

```sql
-- migration v3 "tunnel_notify"
ALTER TABLE tunnels ADD COLUMN notified_at      TEXT;      -- 成功下发邮件的时刻（去重键）
ALTER TABLE tunnels ADD COLUMN notify_attempts  INTEGER NOT NULL DEFAULT 0;  -- 失败重试计数（上限封顶）
```

DDL 唯一真相源仍是 `db/schema.ts` 的 `MIGRATIONS`。**不改 CHECK**，不动既有表结构。

### 不变量（新增 I24–I28，写入 `data-model.md`）

- **I24** `tunnels` 中 `status='up'` 的行**至多 1 行**（全局单例当前地址）。地址变更时：插入新 `up` 行 →
  旧行 `UPDATE ... SET status='expired', replaced_by=<newId>, expires_at=datetime('now')`，两动作**同一事务**。
- **I25** `secrets.ciphertext`/`nonce` 为密文，明文**永不落库、永不回显**；`key_version` 只增不降。
- **I26** 地址变更通知按 `tunnels.id` **去重**（`notified_at IS NULL` 才发）；失败累计 `notify_attempts`，
  达 `CONSOLE_TUNNEL_MAIL_MAX_ATTEMPTS` 后置 `detail` 并不再自动重发。**绝不无限轰炸**。
- **I27** 隧道目标只能是 `127.0.0.1:<console_port>`（解析自 `CONSOLE_TUNNEL_URL`，默认由 `CONSOLE_PORT` 推导）；
  服务默认监听 `127.0.0.1`。CDP 端口（`accounts.cdp_port`）**不得**出现在任何隧道参数 / 邮件内容 / API 响应里。
- **I28** `cloudflared` 异常退出（非预期的 `close`）→ 立即 `status='down'|'error'` 且 `detail` 含
  `exit=<code> signal=<sig> stderr=<尾 2KB>`；随后按退避**重启**并在获得新地址时写新行。**不伪装 up**。

## 3. DAO 层（`db/dao/*`）

DAO 只做 SQL + 行↔对象映射，不掺业务（C1 惯例）。

### 3.1 `db/dao/emails.ts`
```ts
export interface EmailRow { id; account_id; to_json; cc_json; subject_prefix }
getEmail(db, accountId): EmailRow | null
upsertEmail(db, accountId, { to: string[]; cc: string[]; subjectPrefix?: string }): EmailRow // INSERT ... ON CONFLICT(account_id) DO UPDATE
deleteEmail(db, accountId): number
```

### 3.2 `db/dao/secrets.ts`
```ts
export const SECRET_KINDS = ["wechat_login", "cf_token", "smtp"] as const;   // kind 白名单
export type SecretKind = (typeof SECRET_KINDS)[number];
export interface SecretMeta { kind; key_version; updated_at }               // 绝不含密文/明文
listSecretMetas(db, accountId): SecretMeta[]
putSecret(db, accountId, kind, enc: Encrypted): void                        // 加密在调用方（server）
getSecretCipher(db, accountId, kind): {ciphertext, nonce, key_version} | null // 内部解密用
deleteSecret(db, accountId, kind): number
```
- **全局凭据**（`cf_token`）约定 `account_id IS NULL`。因 SQLite 的 `UNIQUE(account_id,kind)` 对 NULL 不去重，
  DAO 必须在写入前 `SELECT ... WHERE account_id IS NULL AND kind=?` 显式判重（UPDATE 或 INSERT），并在 spec 记录。

### 3.3 `db/dao/tunnels.ts`
```ts
export interface TunnelRow { id; kind; url; hostname; pid; status; detail;
                             created_at; expires_at; last_checked_at; replaced_by; notified_at; notify_attempts }
getCurrentTunnel(db): TunnelRow | null                       // status='up' 最新一行（I24）
listTunnels(db, limit=20): TunnelRow[]
openTunnel(db, {kind,url,hostname,pid}): TunnelRow           // 事务：插入 up + 旧 up → expired/replaced_by（I24）
setTunnelStatus(db, id, status, detail?): void
markHeard(db, id, {url?, pid?, status?, detail?}): void       // 心跳：last_checked_at/status/url
markNotified(db, id): void                                   // notified_at=datetime('now')
bumpNotifyAttempts(db, id): number                           // notify_attempts+1，返回新值
```

## 4. 隧道监督（`tunnel/cloudflared.ts`）

与 C4 `agent/manager.ts` 同构：**懒启动 + 子进程 + 事件 + 状态机 + fail-surfacing**。

```ts
export interface TunnelDeps {
  db: Database;
  masterKey: Buffer;              // 交给 notify 解开 wechat_login
  bin?: string;                   // CONSOLE_TUNNEL_BIN ?? "cloudflared"
  mode?: "quick";                 // C5 仅 quick
  targetUrl?: string;             // CONSOLE_TUNNEL_URL ?? `http://127.0.0.1:${CONSOLE_PORT}`
  pollMs?: number;                // CONSOLE_TUNNEL_POLL_MS ?? 5000
  debounceMs?: number;            // CONSOLE_TUNNEL_DEBOUNCE_MS ?? 30000
  maxNotifyAttempts?: number;     // CONSOLE_TUNNEL_MAIL_MAX_ATTEMPTS ?? 3
  adminCopy?: boolean;            // CONSOLE_TUNNEL_MAIL_ADMIN ?? true
  send?: typeof sendMail;         // 测试注入点（默认 engine sendMail）
  log?: (msg: string) => void;
}
export class TunnelSupervisor {
  start(): void; stop(): Promise<void>;
  status(): TunnelStatusView;     // {running, pid, url, since, detail, attempts, notifiedAt}
  async restart(): Promise<TunnelStatusView>;   // 强制重建（admin 用）
}
```

**启动**：`spawn(bin, ["tunnel","--url",targetUrl,"--no-autoupdate"], { cwd, env, stdio:["ignore","pipe","pipe"] })`。
- **解析**：stderr 逐行（`setEncoding("utf8")` + 自写切分，沿用 C4 `frames.ts` 的产物），正则
  `/https:\/\/[a-z0-9-]+\.trycloudflare\.com/`（大小写不敏感）。同时保留**尾 2KB stderr** 到 `detail`。
- **获得地址**：`openTunnel()`（同事务 I24）。若与当前 `up` 行 url 相同则只 `markHeard`。
- **健康检查**（`pollMs` 定时）：① `GET http://127.0.0.1:<port>/health` 期望 200；② `HEAD <url>` 期望 2xx/3xx。
  失败累计 → `status='down'`；恢复 → `status='up'`。
- **进程退出**：非 `stop()` 触发的 `close` → I28（`down`/`error` + detail），退避重启
  （`min(pollMs*2^n, 60s)`，n 封顶 5），重启后拿到新地址 → 新行 + 触发 notify。
- **去抖**：同一 `debounceMs` 窗口内多次地址变化，只对**最后稳定**地址发信（保留一个 `pending` 定时器）。
- **`stop()`**：置 `byStop=true`、`SIGTERM` + `gracefulMs` 后 `SIGKILL`，当前 `up` 行 → `status='down'`（`detail='stopped'`）。
- **告警**：每次地址变更 / 进程退出写 `audit(action='tunnel.change'|'tunnel.exit')`。

## 5. 邮件下发（`notify/tunnel-mail.ts`）

```ts
export interface NotifyResult { sent: boolean; skipped?: string; attempts: number; error?: string }
export async function notifyTunnelChange(
  db: Database, key: Buffer, tunnel: TunnelRow, opts: NotifyOpts,
): Promise<NotifyResult>
```

**组装**（每账号一封）：
- 收件人 = `account_email.to ∪ cc`（去重、去空）。仅 `enabled` 账号（未禁用的不发）。
- `subject` = `${subject_prefix ?? ""}[wechat-flow] 控制台地址已更新 (${yyyy-MM-dd HH:mm})`。
- `body`（纯文本 + 简单 HTML 兜底）：
  1. **服务器信息**：`os.hostname()`、内网 IP（`os.networkInterfaces()` 取首个非内部 IPv4）、控制台端口、更新时间。
  2. **当前地址**：`tunnel.url`。
  3. **该账号后台账密**：解密 `secrets(account_id, 'wechat_login')`；若未配置则写「未配置（请管理员在控制台补录）」。
  4. 安全提示：地址随时会变，请勿转发。
- **管理员副本**（D-C5-4）：若 `adminCopy`，把 `settings(global).notify.to` 列表并入收件人（去重）。
- **发送**：`send(cfg, {subject, body})`，`cfg` = 由 `settings(global)` 有效 `notify` 构造的 `EmailConfig`
  （`skill.dir` 等原样），`to` 用上面算出的收件人覆盖。**engine `mailer.ts` 保持不变**（D-C5-2）。
- **去重 / 重试（I26）**：进入前 `if (tunnel.notified_at) return {sent:false, skipped:"already-notified"}`。
  成功 → `markNotified` + `audit('tunnel.mail', ok:true)`；失败 → `bumpNotifyAttempts`，
  达上限 → `setTunnelStatus(...,'error', detail)` + `audit('tunnel.mail', ok:false, detail)`，否则交给退避重试。
- **可测试性**：`send` 可注入（默认 engine `sendMail`）；测试用 fake sender 断言 mail 只发一次。

## 6. HTTP 路由（`server.ts`，纯增量）

复用统一信封 `{ok:true,data}` / `{ok:false,code,message,detail}`、CSRF（写请求）、`assertAdmin`/`assertAccountAccess`。

| 方法 | 路径 | 授权 | 说明 |
|------|------|------|------|
| GET | `/api/accounts/:id/email` | owner(账号) / admin | 读邮箱配置 |
| PUT | `/api/accounts/:id/email` | owner(账号) / admin | upsert（校验邮箱格式、数组去重） |
| DELETE | `/api/accounts/:id/email` | owner(账号) / admin | 删除 |
| GET | `/api/accounts/:id/secrets` | owner(账号) / admin | **仅元数据**：`[{kind,configured,keyVersion,updatedAt}]` |
| PUT | `/api/accounts/:id/secrets/:kind` | owner(账号) / admin | 写入（加密后落库），**响应不含明文** |
| DELETE | `/api/accounts/:id/secrets/:kind` | owner(账号) / admin | 删除 |
| GET | `/api/tunnels` | 任意登录 | 最近 20 行（含历史 expired） |
| GET | `/api/tunnels/current` | 任意登录 | 当前 `up` 行或 `{url:null}` |
| POST | `/api/tunnels/restart` | **admin** | 强制重建；`ops.tunnel` 缺失 → 503 `tunnel_unavailable` |
| POST | `/api/tunnels/:id/notify` | **admin** | 强制（重）发该行邮件；清 `notified_at` 后调用 `notifyTunnelChange` |
| GET | `/api/admin/overview` | **admin** | 跨账号总览 |

**错误语义**：`400`（邮箱/kind 非法）、`403`（越权，写 `audit('denied')`）、`404`（账号/行不存在）、
`409`（并发 open 冲突等）、`503 tunnel_unavailable`（未启用隧道时点 restart/notify）。**不得 200 空伪装成功**（反模式）。

**`ops` 注入**：`createApp(state, chat?, ops?: { tunnel?: TunnelSupervisor })`。`ops.tunnel` 的 `status()` 供
`/api/tunnels/current` 与 `/api/admin/overview` 合并「进程态」与「DB 态」。

## 7. 管理员总览与 UI

- `GET /api/admin/overview` 返回：
  ```jsonc
  {
    "tunnel": { "running": true, "pid": 1234, "url": "https://x.trycloudflare.com",
                "status": "up", "since": "...", "attempts": 0, "notifiedAt": "..." },
    "accounts": [ { "id","alias","displayName","enabled","email":{"configured":true,"to":["…"]},
                    "secrets":{"wechat_login":true,"cf_token":false,"smtp":false},
                    "cdpPort":9222,"jobsRunning":0,"lastNotifiedAt":"…" } ],
    "server": { "hostname":"…", "internalIp":"192.168.0.250", "port":8787, "now":"…" }
  }
  ```
  > 注意：`internalIp`/`port` 属于「服务器信息」，允许返回；**`cdpPort` 仅展示账号隔离用，绝不拼进隧道/邮件**（I27）。
- **UI**：
  - `account.html` + `app.js`：新增「邮箱」表单（to/cc/subjectPrefix）与「凭据」表单（kind 下拉 + 只写口令/账密框；
    读回只显示 `configured` 徽标 + 更新时间 + 删除按钮）。
  - 新页 `ui/admin.html` + `ui/admin.js`：隧道状态卡（地址、PID、状态、重发/重启按钮）、账号总览表。
  - `ui/index.html`（及 workbench/chat 顶栏）加「运维」入口，仅 `admin` 可见（`/api/me` 的角色判断）。
  - `app.css` 复用既有样式；**无构建步骤**。

## 8. 主入口接线（`main.ts`）

```ts
const tunnel = process.env.CONSOLE_TUNNEL === "1"
  ? new TunnelSupervisor({ db, masterKey })
  : null;
const app = createApp(state, chat, tunnel ? { tunnel } : undefined);
...
tunnel?.start();                 // 在 server 起来之后
// shutdown: await tunnel?.stop(); （在 chat.shutdown() 之后、db.close() 之前）
```

**环境变量（C5）**：

| 变量 | 默认 | 作用 |
|------|------|------|
| `CONSOLE_TUNNEL` | `0` | 是否启用隧道监督（1 启用） |
| `CONSOLE_TUNNEL_BIN` | `cloudflared` | 二进制路径 |
| `CONSOLE_TUNNEL_MODE` | `quick` | C5 仅 quick |
| `CONSOLE_TUNNEL_URL` | `http://127.0.0.1:${CONSOLE_PORT}` | 隧道回指目标（I27） |
| `CONSOLE_TUNNEL_POLL_MS` | `5000` | 健康检查 / 地址轮询间隔 |
| `CONSOLE_TUNNEL_DEBOUNCE_MS` | `30000` | 地址变更去抖窗口 |
| `CONSOLE_TUNNEL_MAIL_MAX_ATTEMPTS` | `3` | 发信失败重试上限 |
| `CONSOLE_TUNNEL_MAIL_ADMIN` | `1` | 是否向全局 `notify` 列表发副本 |

## 9. 安全（对齐 `security.md` / 父 K1）

- 隧道**只**映射控制台端口；CDP 端口不出现于任何隧道参数、邮件正文、API 响应（I27/H8）。
- 凭据：AES-256-GCM（`node:crypto`），12B nonce，`KEY_VERSION=1`；API 永不回显；无 master key fail-fast（既有）。
- **邮件正文含账密**：仅发给该账号**自己的**邮箱（+ 管理员副本），绝不群发他人；审计只记「已发送 + 收件人数量」，
  **不记正文**。这是本任务最高敏感面 → 单测断言「收件人 ⊆ 该账号邮箱 ∪ 管理员」。
- 越权：`owner` 访问他人账号的 email/secrets/overview → 403 + `audit('denied')`。
- 隧道不做鉴权（quick tunnel 无 Access）；身份门仍靠控制台登录（C6 可评估 CF Access）。

## 10. 关键权衡（Trade-offs）

| 决策 | 取舍 |
|------|------|
| 全局单隧道 vs 每账号隧道 | 选全局：一个控制台一个入口，符合 R2.2；代价是地址共享 |
| 复用 engine `sendMail` vs 自造 SMTP | 选复用：零依赖、不改 engine；代价是不能每账号独立 SMTP（D-C5-3） |
| 邮件只发「该账号邮箱」 | 安全优先；管理员要全局就靠副本与 `/admin`，不把 A 的账密发 B |
| 去重键放 `tunnels.notified_at` | 简单、事务内一致；不引入新表 |
| 监督进程复用 C4 形态 | 一致的心智模型与 fail-surfacing，测试可注入 |

## 11. 回滚

- 运行期：`CONSOLE_TUNNEL=0`（或未设）即不启动隧道；`/api/tunnels/restart|:id/notify` 返回 503。
- 迁移：v3 仅两列加法，旧代码读新库不受影响；如需回退，删列需重建表（记录在 `implement.md`）。
- 代码：删除 `tunnel/`、`notify/`、三个新 DAO、`ui/admin.*`，还原 `server.ts`/`main.ts`/`schema.ts` 的增量即可。
