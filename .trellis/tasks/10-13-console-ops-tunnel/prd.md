# C5 · 运维与公网（console-ops-tunnel）

> 父任务：`10-13-wechat-flow-console`（源需求 R2）。设计见父 `design.md` §5.6、§7。
> 依赖 C1。

## Goal
为每个公众号配置接收邮箱；维护内网服务经 Cloudflare 映射后的公网地址并在过期/变更时自动重生成，
把"服务器信息 + 当前地址 + 该账号后台账密"邮件下发；凭据加密存储；管理员可总览全部账号。

## Requirements
- `account_email`：每账号接收邮箱（可多个）+ 主题前缀。
- `cloudflared` 子进程监督（quick tunnel 或 named tunnel）；解析 `*.trycloudflare.com`；健康检查。
- 地址变更/过期 → 新 `tunnels` 行（`replaced_by` 指向旧行，旧行 `expired`）→ 触发邮件。
- 邮件内容：当前服务器信息（主机/内网 IP/端口/时间）+ 当前 CF 地址 + 该账号后台登录账号密码（解密后）。
- 收件范围：只发该账号自己的邮箱；管理员可另发自身。
- 凭据：`secrets`（wechat_login / cf_token / smtp）AES-256-GCM 加密、支持轮换、API 永不回显明文。
- 管理员全局视图：跨账号配置总览 + 操作入口（`admin` 角色）。
- 地址抖动去抖 + 发信去重/失败重试上限（避免邮件轰炸）。

## Acceptance Criteria
- AC-8 隧道地址变更/过期后 1 分钟内更新为可用新地址，并向该账号邮箱与管理员发出含"服务器信息+新地址+该账号后台账密"的邮件；旧地址标记失效。
- AC-9 DB 凭据字段为密文；API 读取不回显明文；无 master key 时拒绝启动或拒绝解密并显式报错。
- CDP 端口绝不经隧道暴露。

## Out of Scope
公网加固与部署（C6）、账号 CRUD（C1）、内容生成（C3）。

## Dependencies
C1。参考 `tiann/hapi` 的 tunnel 章节与 `bsahane/Auth-Proxy-Tunnel` 架构。

## Notes / 关联文件
`src/console/tunnel/cloudflared.ts`、`src/console/notify/tunnel-mail.ts`、`src/console/crypto/secrets.ts`、engine `src/mailer.ts`。
