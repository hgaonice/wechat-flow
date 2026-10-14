# C5 · 运维与公网（console-ops-tunnel）

> 父任务：`10-13-wechat-flow-console`（源需求 R2 / R2.4 / R2.5）。设计见本任务 `design.md`，排期见 `implement.md`；
> 父设计见 `../10-13-wechat-flow-console/design.md` §5.6、§7。依赖 C1（C2/C3/C4 已交付，表结构已就位）。

## Goal

为每个公众号配置接收邮箱；把内网控制台经 **Cloudflare Quick Tunnel** 映射成公网地址并**监督**其生命周期，
在地址**变更 / 过期**时自动重建、落 `tunnels` 新行（旧行失效可追溯），并把
「服务器信息 + 当前可用地址 + 该账号后台账密」**邮件下发**给该账号自己的邮箱（管理员可选另收副本）；
凭据 AES-256-GCM 加密存储、API 永不回显明文；管理员可跨账号总览。

## Requirements（承接父 R2）

- R2.1 每账号配置**接收邮箱**（`to` 可多个 + `cc` + `subject_prefix`），落 `account_email`。
- R2.2 系统监督 `cloudflared` 子进程（C5 只做 **quick tunnel**），解析 `https://<host>.trycloudflare.com`，
  健康检查（本地 `/health` + 远端 `HEAD`），**地址变更/过期自动重建**。
- R2.3 地址变更/过期 → 新 `tunnels` 行（`replaced_by` 指向旧行，旧行 `expired`）→ 触发**邮件下发**：
  当前服务器信息（主机 / 内网 IP / 端口 / 时间）+ 当前 CF 地址 + 该账号后台登录账号密码（解密后）。
- R2.4 **管理员全局视图**：跨账号配置总览 + 操作入口（重启隧道 / 重发地址邮件）。
- R2.5 手机可直开该地址（网关授权邮件式体验）——由隧道 + 邮件共同达成；UI 需移动端可用。

## 本地验收标准（父 AC-8 / AC-9 在本任务的展开）

- **AC-C5-1（监督与可用）** 启用隧道后 `cloudflared` 被监督运行；解析出的地址在 ≤ `pollMs` 内落库为唯一 `up` 行；
  本地 `/health` 与远端 `HEAD` 均可达。
- **AC-C5-2（变更/过期）** 地址变更或判定过期后 **≤ 60s** 内出现新 `up` 行，旧行 `expired` 且 `replaced_by` 指向新行；
  DB 当前地址 = 新地址。
- **AC-C5-3（邮件下发）** 地址变更后，向该账号 `account_email.to`（并 `cc`）发出含「服务器信息 + 新地址 + 该账号后台账密」的邮件；
  管理员（全局 `notify` 列表）可另收副本；**同一 `tunnels.id` 只发一次**。
- **AC-C5-4（发信不轰炸）** 地址抖动去抖；失败重试 ≤ `MAX_ATTEMPTS`；超限后置 `detail` + 审计失败，不再自动重发。
- **AC-C5-5（凭据安全 = AC-9）** `secrets` 落库字段为密文（数据库字节 ≠ 明文）；`GET` 读取只返回
  `{kind, configured, keyVersion, updatedAt}`；写接口只收不发；**无 master key 服务拒绝启动**（既有 fail-fast）。
- **AC-C5-6（管理员视图 = AC-4）** `GET /api/admin/overview` 仅 `admin`；`owner` 越权 403 + 审计。
- **AC-C5-7（暴露面 = AC-8 / H8）** 隧道**只**指向 `127.0.0.1:<console_port>`；**任何路径都不暴露 CDP 端口**；
  未显式 `CONSOLE_HOST` 时不监听 `0.0.0.0`。
- **AC-C5-8（失败显形 = AC-11）** `cloudflared` 异常退出 → `status='down'|'error'` + `detail`（exit code / signal / stderr 尾），
  **不伪装 up**；邮件发送失败 → 审计 `ok:false` + 非空原因。
- **AC-C5-9（零依赖 / 兼容 = AC-10 / H6）** `tsc --noEmit` 零错误、`bun build` 通过、`package.json` `dependencies` 仍为空、
  **engine 零改动**（`src/{pi,wechat,publisher,mailer}.ts` 不变）；`bun src/cli.ts publish --dry-run` 仍可用。

## 关键决策 / 待确认（G-C5 门，动工前需用户确认）

| # | 决策 | 建议 | 影响 |
|---|------|------|------|
| D-C5-1 | 隧道形态 | **仅 Quick Tunnel**（`kind='quick'`，无自有域名）；`named` 仅预留（父 K3 已定） | — |
| D-C5-2 | 发信通道 | **复用 engine `mailer.ts` + `email-sender` skill 的共享 SMTP**，收件人由 `account_email` 覆盖；**不改 engine** | 决定了是否触碰 engine |
| D-C5-3 | `smtp` secret kind | C5 **不消费**每账号 SMTP（需改 engine 才能用）。建议：**保留该 kind 入库但标记为 reserved**（write-only、永不回显），不做每账号发信 | 需求是否缩水 |
| D-C5-4 | 管理员副本 | 默认向 `settings(global).notify.to` 列表发副本；`CONSOLE_TUNNEL_MAIL_ADMIN=0` 可关 | 收件范围 |
| D-C5-5 | 隧道粒度 | **全局单例**（一个 `cloudflared` 映射 8787；`tunnels` 无 `account_id`），非每账号一隧道 | 数据模型 |
| D-C5-6 | 迁移 | **v3 纯加法**：`tunnels.notified_at TEXT`、`tunnels.notify_attempts INTEGER DEFAULT 0` | 回滚 |
| D-C5-7 | 服务注入 | `createApp(state, chat?, ops?)`；`ops.tunnel` 缺省时隧道路由返回 **503 `tunnel_unavailable`**（不得 200 空） | API 契约 |
| D-C5-8 | UI | `account.html` 增加邮箱 + 凭据表单；新增 `/admin` 页面（`ui/admin.{html,js}`）+ 隧道状态徽标 | 工作量 |

## Out of Scope

- 公网部署 / 反代 / systemd / 限流锁定 / 备份恢复（→ **C6**）。
- 每账号独立 SMTP 发信（需改 engine `mailer.ts`；D-C5-3 决定不在 C5）。
- named tunnel（自有域名）、Cloudflare Access 配置（C6 安全加固可评估）。
- 内容生成（C3）、任务调度（C2）、会话（C4）、账号 CRUD（C1）。

## Dependencies

- **C1**（必须）：表结构 `account_email` / `secrets` / `tunnels`、`AppState.masterKey`、`crypto/secrets.ts`、
  `auth/rbac.ts`（`assertAdmin`）、`audit` DAO、`http/respond.ts` 信封。
- C2/C3/C4 已交付（本任务不依赖它们的运行时，仅共用 server 骨架）。

## Notes / 关联文件

- 新增：`src/console/tunnel/cloudflared.ts`、`src/console/notify/tunnel-mail.ts`、
  `src/console/db/dao/{emails,secrets,tunnels}.ts`、`src/console/ui/admin.{html,js}`。
- 修改（纯加法）：`src/console/db/schema.ts`（v3）、`server.ts`（路由 + `ops` 注入）、`main.ts`（接线）、
  `ui/{index,account}.html`、`ui/app.js`/`app.css`。
- 复用：engine `src/mailer.ts`（`sendMail` / `EmailConfig` / `MailInput`）、console `crypto/secrets.ts`。
- 参考：`tiann/hapi` 的 tunnel 章节、`bsahane/Auth-Proxy-Tunnel` 架构（概念，不引入代码）。
