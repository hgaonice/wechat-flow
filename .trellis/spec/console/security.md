# Security（控制台）—— K1 本需求最高风险

> 状态：**v0 契约（先行）**，源 `design.md` §7。C1/C5/C6 落地后校准。
> 威胁前提：控制台经 **Cloudflare Quick Tunnel** 暴露到公网，且库中存有公众号后台账密 → 视为**高价值目标**。

---

## 1. 传输与暴露面收敛

| 项 | 约定 |
|---|---|
| 监听 | 服务只监听 `127.0.0.1:8787`，**不监听 `0.0.0.0`** |
| 公网入口 | 仅经 cloudflared（HTTPS）；建议叠加 **Cloudflare Access** 作为隧道前置身份门 |
| 端口 | 隧道**只**映射控制台端口；**Chrome CDP 端口绝不暴露**（H8） |
| 响应头 | `Strict-Transport-Security`、`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、CSP 最小集 |

## 2. 身份（Authentication）

- 口令存储：`Bun.password`（**argon2id**）哈希，不存明文。
- 登录：`POST /api/login` → 成功建 `login_sessions` → `Set-Cookie: wfc_sid=<opaque>; HttpOnly; Secure; SameSite=Lax`。
- 会话令牌：服务端只存 `token_hash`（可哈希，如 SHA-256），Cookie 值为不可预测随机串。
- 过期/吊销：`expires_at` 到点失效；改密/登出/管理员吊销使会话不可用。
- **无 master key 必须 fail-fast**：见 §5；不静默降级。

## 3. 授权（Authorization）

- 角色：`admin` 全通；`owner` 仅 `account_grants` 内账号。
- 每次请求装载 `{user, role, grantedAccounts}` 后判定：
  - 未登录 → **401**；跨账号/角色不足 → **403** 且落 `audit`。
- 授权判定集中在 `auth/rbac.ts`，禁止各 handler 自行判断。

## 4. 会话与 CSRF

- 写请求（POST/PUT/PATCH/DELETE）必须带 `X-CSRF-Token`，与 `login_sessions.csrf_token` 比对；不匹配 → 403。
- Cookie `SameSite=Lax` 作为第二道防线；CORS 默认关闭（同源）。

## 5. 凭据加密（Credentials）

- 算法：**AES-256-GCM**（`crypto.subtle`），每条密文独立随机 `nonce`，记录 `key_version` 以支持轮换。
- master key 装载顺序：
  1. 环境变量 `CONSOLE_MASTER_KEY`（base64，32 字节）；
  2. 否则 `~/.wechat-console/master.key`（**权限 0600**，不存在则首启生成并提示备份）。
- **无 key**：拒绝启动（或拒绝解密）并**显式报错**——绝不回退明文。
- **API 永不回显明文**：读接口返回 `{kind, configured:true, updated_at}`；写接口只收不发。
- 审计：凭据写入/轮换落 `audit`（记录操作者与时间，**不记录值**）。

## 6. 限流与锁定

- 登录失败：连续失败计数（内存 + `audit`）→ 达到阈值锁定并返回 **429**，锁定窗口可配置。
- API 全局限流：按会话/IP 令牌桶；超限 429。
- 隧道地址抖动时**发信去抖 + 失败重试上限**，避免邮件轰炸（C5）。

## 7. 审计（Audit）

必须落 `audit` 的动作：登录成功/失败、账号增删改、配置变更、凭据写入/轮换、任务触发、**决策应答**、越权尝试。
字段：`user_id, action, target, detail_json, ip, ua, ts`。查询入口 `GET /api/audit`（admin）。

## 8. 已知风险与兜底

| 风险 | 兜底 |
|---|---|
| 自动填公众号账密登录可能触发风控（K2） | **保留二维码邮件自愈**为兜底；账密仅在有显式配置时使用 |
| Quick Tunnel 地址公开可扫 | 强鉴权 + 限流锁定 + 可选 CF Access + 地址可轮换 |
| master key 丢失 → 凭据不可解 | 首启提示备份；支持 `key_version` 轮换 |
| 隧道/反代被误配暴露 CDP | 部署清单显式禁止；C6 只映射控制台端口 |
