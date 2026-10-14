# Security（控制台）—— K1 本需求最高风险

> 状态：**v4（已随 C1 + C2 + C3 + C4 校准）**。C5/C6 落地后继续校准。
> 威胁前提：控制台经 **Cloudflare Quick Tunnel** 暴露到公网，且库中存有公众号后台账密 → 视为**高价值目标**。

---

## 1. 传输与暴露面收敛

| 项 | 约定 | 落地 |
|---|---|---|
| 监听 | 默认只监听 `127.0.0.1:8787`（`CONSOLE_HOST`/`CONSOLE_PORT` 可覆盖），**不默认监听 `0.0.0.0`** | ✅ C1 |
| 公网入口 | 仅经 cloudflared（HTTPS）；建议叠加 **Cloudflare Access** 作为隧道前置身份门 | C5 |
| 端口 | 隧道**只**映射控制台端口；**Chrome CDP 端口绝不暴露**（H8） | C5/C6 |
| 响应头 | `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`X-Frame-Options: DENY`、`Cache-Control: no-store`、**CSP** | ✅ C1 |
| CSP（实际值） | `default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'` | ✅ C1 |
| HSTS | `Strict-Transport-Security: max-age=31536000; includeSubDomains` —— **仅在安全 Cookie 生效时下发**（即非 `CONSOLE_ALLOW_INSECURE_COOKIE=1` 的开发态） | ✅ C1 |

> 开发态放行明文：`CONSOLE_ALLOW_INSECURE_COOKIE=1` 让 Cookie 去掉 `Secure` 并可不下发 HSTS，**仅供本地/隧道联调**，生产禁用。

## 2. 身份（Authentication）

- 口令存储：`Bun.password`（**argon2id**）哈希，不存明文。
- 登录：`POST /api/login` → 成功建 `login_sessions` 行 → `Set-Cookie: wfc_sid=<opaque>`。
- Cookie 属性：`HttpOnly; Path=/; SameSite=Lax; Max-Age=<ttl>`，**`Secure` 除非 `CONSOLE_ALLOW_INSECURE_COOKIE=1`**。
- 会话令牌：`wfc_sid` = 32B 随机（base64url）；服务端只存 `sha256(token)` 于 `login_sessions.token_hash`，**不存明文令牌**。
- 过期/吊销：`expires_at` 到点失效（默认 TTL 12h，`CONSOLE_SESSION_TTL_HOURS` 可覆盖）；改密/停用/登出会使相关会话不可用。
- **无 master key 或 无任何用户 必须 fail-fast**：见 §5 / §2.1；不静默降级、不设默认口令。

### 2.1 启动前置校验（fail-fast，拒绝默认口令启动）

`serve` 启动顺序：`loadMasterKey()` → `countUsers()` → `countAdmins()`，任一不满足即**报错退出（exit 1）**：

1. 无 master key → 提示设置 `CONSOLE_MASTER_KEY` 或运行 `--init-key`；
2. 用户数为 0 → 提示先 `--create-admin <name>`；
3. 管理员数为 0 → 提示提升一个管理员。

## 3. 授权（Authorization）

- 角色：`admin` 全通；`owner` 仅 `account_grants` 内账号。
- 每次请求装载 `{user, role, grantedAccounts}` 后判定：
  - 未登录 → **401 `unauthorized`**；跨账号/角色不足 → **403 `forbidden`** 且落 `audit`（`action='denied'`）。
- 授权判定集中在 `auth/rbac.ts`（`assertAdmin` / `assertAccountAccess`），禁止各 handler 自行判断。
- **任务类路由（C2）**：`/api/jobs/:id` 与 `/api/jobs/:id/cancel` **不信任 URL**——先查 `jobs` 行，再用
  `job.account_id` 走 `assertAccountAccess`；不存在 → 404（在鉴权之前）。越权 → 403 且落 `denied`。
- **文章/SSE 路由（C3）**：`/api/articles/:id`（含 `/cover`、`/regenerate`）与 `/api/jobs/:id/stream` 同模式——
  `server.ts#loadArticle` / `loadJob` 先取行，再用 **行内 `account_id`** 走 `assertAccountAccess`，**绝不信任 URL 中的账号**。
- **产物路径不可被请求控制**：`/api/articles/:id/cover` 的封面路径由 `getAccountById` + `loadConfig(alias).paths.imgs`
  派生（config 缺失时 `null` → 404），请求体不参与路径拼接，无穿越面。
- **反馈长度上限**：`regenerate` 的 `feedback` 截断至 8000 字（`slice`），避免超长 prompt 滥用。
- **审计（C3）**：重生成写 `audit(action='article.regenerate', target='article:<id>')`；其余任务仍走 `job_enqueue`。
- **机密可见性**：非 admin 的 `GET /api/accounts/:id` **不下发 `global`**，且从 `effective`/`overrides` 剔除
  `notify`/`proxy`/`piBin`/`bunBin`/`skillDir`（H7，见 `server.ts#accountDetail`）。
- **会话/决策路由（C4）**：`/api/chats/:id`、`/api/chats/:id/stream`、`/api/decisions/:id` 均**不信任 URL**——
  `server.ts#loadChat` / `POST /api/decisions/:id` 先取行，再用 **行内 `account_id`** 走 `assertAccountAccess`；
  `GET /api/decisions` 用 `visibleAccountIds` 过滤（admin 无过滤，owner 仅授权账号）。
- **agent 子进程最小权限（C4，R3.5）**：`pi` 子进程以 `--tools read,grep,find,ls,console_ask` 启动，
  并由 `console-decision.ts` 经 `pi.on("tool_call")` 对 `wechat*/publish*/mail*/backup*` **硬阻断**、其余非只读工具**逐次人工确认**。
  控制台**不提供**「完全放开」开关；发布/发信/备份能力**绝不下放**给会话（详见 `agent-session.md` §6）。
  注入的 `agent-context-*.txt` **不含任何微信/邮箱/密码/密钥**。

## 4. 会话与 CSRF

- 写请求（POST/PUT/PATCH/DELETE，除 `POST /api/login` 外）必须带 `X-CSRF-Token`，与 `login_sessions.csrf_token` **定时安全比较**；不匹配 → 403。
- Cookie `SameSite=Lax` 作为第二道防线；CORS 默认关闭（同源）。
- Cookie 解析对畸形百分号编码**容错**（不抛 500，等价“无令牌”→ 401）。

## 5. 凭据加密（Credentials）

- 算法：**AES-256-GCM**（`node:crypto` —— `createCipheriv("aes-256-gcm", …)`，**非 WebCrypto**，D3）。
  每条密文独立 **12 字节随机 nonce**，认证标签附于密文尾部；记录 `key_version`（当前 `KEY_VERSION=1`）以支持轮换。
- master key 文件：`~/.wechat-console/master.key`（`CONSOLE_MASTER_KEY_FILE` 可覆盖）。
- master key 装载顺序：
  1. 环境变量 `CONSOLE_MASTER_KEY`（base64，32 字节）；
  2. 否则读 `~/.wechat-console/master.key`：**校验权限必须为 0600**，组/他人可读则**拒绝启动**；
  3. 文件不存在 → **拒绝启动**，提示 `--init-key`。
- `--init-key`：在文件缺失时生成 32B 随机密钥并以 **0600** 落盘（**不覆盖已有文件**）。v0 稿“首启自动生成”已改为**显式 `--init-key`**，避免隐式落盘状态。
- **无 key**：拒绝启动（或拒绝解密）并**显式报错**——绝不回退明文。
- **API 永不回显明文**：读接口返回 `{kind, configured:true, updated_at}` 形态；写接口只收不发。
- 审计：凭据写入/轮换落 `audit`（记录操作者与时间，**不记录值**）。

## 6. 限流与锁定

- 登录失败：以 `login_attempts(username, ip, ok, ts)` 为事实来源（持久化，重启不失效）。
  **同一用户名 15 分钟窗口内失败 ≥ 5 次** → 后续登录返回 **429**（`retryAfterSec` 提示），成功登录清零失败计数。
  常量：`MAX_LOGIN_ATTEMPTS=5`、`ATTEMPT_WINDOW_MIN=15`（`sessions.ts`）。
- API 全局限流：按会话/IP 令牌桶；超限 429（C6 加固）。
- 隧道地址抖动时**发信去抖 + 失败重试上限**，避免邮件轰炸（C5）。

## 7. 审计（Audit）

必须落 `audit` 的动作：登录成功/失败、登出、改密、账号增删改、配置变更、凭据写入/轮换、任务触发、**决策应答**、越权尝试。
C4 补充：`chat.create`/`chat.close`/`chat.prompt`/`chat.abort`/`chat.fork`/`chat.clone`/`chat.model.set`、
`agent.tool`（含 `phase`/`toolName`）、`agent.decision.pending`/`agent.decision.answer`/`agent.decision.cancel`/`agent.decision.expired`、
`chat.lost`（附退出 `code`/`signal` 与丢失决策数）。
字段（v1）：`user_id`（可空）、**`actor`**（用户名文本，失败登录/未知用户也能归属）、`action`、`target`、
`detail_json`、`ip`、`ua`、`ts`、**`ok`**（0/1）。查询入口 `GET /api/audit`（admin，`?limit=`≤500）。
越权（403）由 `server.ts` 统一捕获并写 `action='denied'` 行；**`actor` 取该请求会话的真实用户名**
（`try/catch` 在 `route()` 内、用请求局部 `session`；未登录/无会话时为 `unknown`）。C2 修正了 C1 曾写死 `actor='unknown'` 的问题。

## 8. 已知风险与兜底

| 风险 | 兜底 |
|---|---|
| 自动填公众号账密登录可能触发风控（K2） | **保留二维码邮件自愈**为兜底；账密仅在有显式配置时使用 |
| Quick Tunnel 地址公开可扫 | 强鉴权 + 限流锁定 + 可选 CF Access + 地址可轮换 |
| master key 丢失 → 凭据不可解 | `--init-key` 提示备份；支持 `key_version` 轮换 |
| 隧道/反代被误配暴露 CDP | 部署清单显式禁止；C6 只映射控制台端口 |
| 账号热列与 entry 不一致导致约束失效 | 写入侧 `assertEntryTypes` 校验；镜像时对数字字符串容错 |
