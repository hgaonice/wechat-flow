# Console · Ops & Tunnel（运维与公网）

> **状态：v1（C5 实现后校准，2026-10-14）**。
> 契约与代码冲突时：**先改本文件，再改代码**；校准依据见 §九。
> 关联：`data-model.md`（I24–I28、迁移 v3）、`api.md`（新端点）、`security.md`（凭据/暴露面）、`index.md`（H8）。
> 定位：Cloudflare Quick Tunnel 监督 + 地址变更邮件下发 + 凭据加密存取 + 管理员总览。**不改 engine**。

---

## 一、硬约束

| # | 约束 | 来源 |
|---|---|---|
| T1 | 隧道**只**映射 `127.0.0.1:<console_port>`（回环主机 + **端口必须等于控制台端口**，且**绝不为任何账号的 CDP 端口**）；**CDP 端口绝不入隧道 / 邮件 / API 响应** | 父 `design.md` §7、H8 |
| T2 | 未显式 `CONSOLE_HOST` 时**不监听** `0.0.0.0` | H8 |
| T3 | 凭据 AES-256-GCM 加密落库；**明文永不落库/回显**；无 master key **fail-fast** | H7、AC-9 |
| T4 | 邮件正文含账密 → **只发该账号自己的邮箱**（+ 管理员副本）；审计**不记正文** | K1、`security.md` |
| T5 | 发信**去重**（`tunnels.notified_at`）+ **重试封顶**；绝不无限轰炸 | 父 R2 风险 |
| T6 | 监督进程异常退出**必须显形**（`down`/`error` + detail），不伪装 up | H5、AC-11 |
| T7 | 零新增 runtime 依赖；engine 零改动（`pi.ts`/`wechat.ts`/`publisher.ts`/`mailer.ts`） | H3、`index.md` |
| T8 | `ops.tunnel` 缺失时隧道路由返回 **503 `tunnel_unavailable`**，不得 200 空 | `api.md` 反模式 |

---

## 二、组件

```text
tunnel/cloudflared.ts   TunnelSupervisor：spawn/解析/健康/变更检测/监督/去抖
notify/tunnel-mail.ts   notifyTunnelChange()：组装 + 收件人 + 去重 + 重试 + 审计
db/dao/emails.ts        account_email CRUD
db/dao/secrets.ts       secrets 元数据 / 密文存取（加密在调用方）
db/dao/tunnels.ts       tunnels 生命周期（openTunnel 事务 / 心跳 / 通知标记）
ui/admin.{html,js}      /admin 总览页
```

依赖方向仍 `console/* → ../*.ts(engine)`；engine 不反向依赖。

---

## 三、数据模型（迁移 v3，纯加法）

```sql
-- migration v3 "tunnel_notify"
ALTER TABLE tunnels ADD COLUMN notified_at     TEXT;                          -- 成功下发时刻（去重键）
ALTER TABLE tunnels ADD COLUMN notify_attempts INTEGER NOT NULL DEFAULT 0;   -- 失败重试计数
```

### 不变量 I24–I28（与 `data-model.md` 同步）

- **I24** `status='up'` 的 `tunnels` 行**至多 1**（全局单例）。地址变更 = 同事务内「插入新 `up` 行 + 旧行 → `expired` +
  `replaced_by=新行 id`」。
- **I25** `secrets.ciphertext`/`nonce` 为密文，明文永不落库/回显；`key_version` 只增不降。
- **I26** 通知按 `tunnels.id` 去重（`notified_at IS NULL` 才发）；失败累加 `notify_attempts`，达上限置 `detail` 并停发。
- **I27** 隧道目标只允许 `127.0.0.1:<console_port>`（`host` ∈ {`127.0.0.1`,`localhost`,`::1`} **且** `port === CONSOLE_PORT`，
  且该 port 不在 `SELECT DISTINCT cdp_port FROM accounts` 中）；违反则**构造期抛错**（fail-fast）。CDP 端口不得出现在隧道参数/邮件/API。
- **I28** `cloudflared` 非预期退出 → `status='down'|'error'` + `detail`（exit/signal/stderr 尾），按退避重启。

### `secrets` 唯一性注意

`UNIQUE(account_id, kind)` 在 SQLite 中对 `account_id IS NULL` **不去重**。全局凭据（`cf_token`）写入前必须
`SELECT ... WHERE account_id IS NULL AND kind=?` 显式判重（UPDATE 或 INSERT），保证全局 kind 只有一行。

---

## 四、隧道状态机

```text
(start) --spawn--> starting --解析到 url--> up --单次健康失败--> down --恢复--> up
                                │                                │
                                │                                └--非预期退出--> down(code=0) | error(code≠0|signal)
                                │                                                   │
                                │                                                   └--退避重启--> starting
                                └--stop()--> down(detail 含 stopped)
   up --地址变化(去抖后)--> 新行 up + 旧行 expired(replaced_by=新行 id) --> 触发 notify
```

- 解析正则：`/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i`，来源 stderr 逐行（`setEncoding("utf8")` + 自写切分，**禁 readline**）。
- 健康检查：本地 `GET http://127.0.0.1:<port>/health` **精确 200** 且 远端 `HEAD <url>` **2xx/3xx**（`redirect:"manual"`）。
  **单次探测失败即 `down`**；下一次成功回到 `up`。探测前若 `!child || stopped` 直接跳过（不把停机误报为 down）。
- 退避重启：`min(pollMs * 2^n, 60s)`，`n` 封顶 5。
- 去抖：`debounceMs` 窗口内取最后稳定地址再发信；`0` 表示立即。
- **I24 方向**：`replaced_by` 写在**旧行**上、指向**新行 id**（前向链）；新行 `replaced_by=NULL`。
- `openTunnel` 同事务把旧 `up` **与 `down`** 行一并置 `expired`（不只 `up`），保证全局至多一行 `up`。

---

## 五、邮件语义

- 收件人 = `account_email.to ∪ cc` ∪（`CONSOLE_TUNNEL_MAIL_ADMIN=1` 时 **`settings(global).notify.email.to`**），去重去空。
- 仅 `accounts.enabled != 0` 的账号发信；某账号无任何收件人时，只有 `adminCopy` 开启才退化为**仅管理员副本**（避免漏报又不去轰炸无关账号）。
- 正文三段：服务器信息（hostname/内网 IP/端口/时间）、当前地址、该账号 `wechat_login`（解密；未配置则显式标注）。
- 发送经 engine `sendMail(cfg, {subject, body})`；`cfg` 由 `emailConfigFor()` 从全局 `notify.email` 派生，`enabled` 恒为 `true`、`to` 覆盖为上面的收件人、缺省 `skill.dir`/`python` 用默认值补齐（**不改 engine**）。
  -> 因此当 `email-sender` skill 在 250 主机未配置时，C5 只保证「失败必显形」（`ok:false` → 重试封顶 → `error`+detail），**不伪造成功**。
- **D-C5-3（已确认）**：SMTP **全局共用**（`email-sender` skill）；**每账号接收邮箱可动态配置**（改 `account_email` 即时生效）；
  `smtp` kind 仍接受入库（write-only、永不回显）但**当前不参与发信**（reserved）。
- 去重：`notified_at` 已存在 → `skipped:"already-notified"`，不发。无收件人 → `skipped:"no-recipients"`。
- 失败：`bumpNotifyAttempts`；`attempts >= maxNotifyAttempts` → `tunnels.status='error'` + detail + `audit('tunnel.mail', ok:false)`。
  仅 `!sent && !skipped && error && attempts < max` 时排下一轮重试（封顶后停发，I26）。
- **at-least-once**：多账号部分失败时，下一轮会重发给已成功账号（按收件人去重=无）；属可接受折中，不敏感（正文不含跨账号信息）。
- 审计：`tunnel.change` / `tunnel.exit` / `tunnel.mail`，`detail_json` **不含正文与账密**。

---

## 六、HTTP 契约（增量）

| 方法 | 路径 | 授权 | 成功 data |
|------|------|------|-----------|
| GET | `/api/accounts/:id/email` | owner(账号)/admin | `{configured,to,cc,subjectPrefix}`（**无 `updatedAt`**；无行时 `{configured:false,to:[],cc:[],subjectPrefix:null}`） |
| PUT | `/api/accounts/:id/email` | owner(账号)/admin | 更新后的 email（同上，无 `updatedAt`） |
| DELETE | `/api/accounts/:id/email` | owner(账号)/admin | `{deleted:n}` |
| GET | `/api/accounts/:id/secrets` | owner(账号)/admin | `{secrets:[{kind,configured,keyVersion,updatedAt}]}`（**无密文/明文**） |
| PUT | `/api/accounts/:id/secrets/:kind` | owner(账号)/admin | `{kind,configured:true,keyVersion,updatedAt}` |
| DELETE | `/api/accounts/:id/secrets/:kind` | owner(账号)/admin | `{deleted:n}` |
| GET | `/api/tunnels?limit=` | 任意登录 | `{tunnels:[TunnelView...]}`（默认 20/上限 100，含 expired） |
| GET | `/api/tunnels/current` | 任意登录 | `{current: TunnelView|null, process: TunnelStatusView|null}` |
| POST | `/api/tunnels/restart` | **admin** | `TunnelStatusView`；无 `ops.tunnel` → 503 |
| POST | `/api/tunnels/:id/notify` | **admin** | `{sent,attempts,skipped?,error?,recipients?}`；强制重发该行（尊重 `notified_at`） |
| GET | `/api/admin/overview` | **admin** | 见 `design.md` §7 |

错误码：`400`（邮箱/kind 非法）、`403`（越权 + `audit('denied')`）、`404`（账号/行不存在）、
`503 tunnel_unavailable`。信封 `{ok,data}` / `{ok:false,code,message,detail?}`；写请求需 `X-CSRF-Token`。

---

## 七、环境变量

`CONSOLE_TUNNEL`(0) · `CONSOLE_TUNNEL_BIN`(cloudflared) · `CONSOLE_TUNNEL_MODE`(quick) ·
`CONSOLE_TUNNEL_URL`(http://127.0.0.1:${CONSOLE_PORT}) · `CONSOLE_TUNNEL_POLL_MS`(5000) ·
`CONSOLE_TUNNEL_DEBOUNCE_MS`(30000) · `CONSOLE_TUNNEL_MAIL_MAX_ATTEMPTS`(3) · `CONSOLE_TUNNEL_MAIL_ADMIN`(1)。

---

## 八、反模式（禁止重犯）

| 反模式 | 为什么 |
|---|---|
| 经隧道暴露 CDP 端口 / 监听 `0.0.0.0` | 远程接管 Chrome（T1/T2、H8） |
| API 读接口返回 secrets 明文或密文 | 凭据泄露（T3、H7） |
| 把某账号邮件群发给所有账号 | 账密外泄（T4） |
| 地址每次抖动都发信 / 无限重试 | 邮件轰炸（T5） |
| `cloudflared` 挂了仍显示 `up` | 伪装成功（T6、H5） |
| 用 `readline` 解析 cloudflared stderr | 与 C4 同类陷阱：按行缓冲丢/并帧 |
| 隧道地址用 `0.0.0.0` 或对外直接暴露 8787 | 绕过隧道与鉴权（T1/T2） |
| `ops.tunnel` 缺失时把 tunnels 路由降级为 200 空 | 伪装成功（T8） |

---

## 九、校准记录（v0 → v1，C5 实现后）

实现落地与 v0 规划稿的差异（均已以代码为准并回写本文件）：

| 项 | v0 规划 | v1 实际 |
|---|---|---|
| admin 副本收件源 | `settings(global).notify.to` | **`settings(global).notify.email.to`**（与 engine `EmailConfig` 同源） |
| `openTunnel` 收编范围 | 旧 `up` 行 | **旧 `up` 与 `down` 行**（同事务） |
| `replaced_by` 方向 | 未明 | **旧行 → 新行 id**（前向链） |
| email GET 形态 | 含 `updatedAt` | **不含**（表无该列） |
| DELETE 响应 | `{deleted:1}` | `{deleted:n}`（幂等） |
| 健康语义 | “== 200” | 本地 GET 精确 200；远端 HEAD 2xx/3xx；单次失败即 `down`；`!child||stopped` 跳过 |
| 退出码映射 | 仅“非预期→error” | `code=0→down`；`code≠0|signal→error`（detail 含 exit/signal/stderr 尾） |
| I27 端口 | 仅回环主机 | **回环主机 + 端口===CONSOLE_PORT + 非 `accounts.cdp_port`**（构造期抛错） |
| 测试缝 | 无 | `TunnelDeps.{probe,autoRestart,consolePort}` |
| `createApp` 签名 | `(state, chat?)` | `(state, chat?, ops?:{tunnel?})` |
| 非阻塞观察 | — | `emailConfigFor` 忽略全局 `notify.email.enabled=false`（总能构造 cfg）；部分失败会向已成功账号重发（at-least-once） |
