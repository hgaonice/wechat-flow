# C6 · 部署与加固（console-deploy-hardening）

> 父任务：`10-13-wechat-flow-console`（源需求 R5 + 全局验收）。设计见父 `design.md` §7–§9。
> 依赖 C1–C5 全部验收。

## Goal
把控制台安全地部署到 192.168.0.250 并通过 Cloudflare 公网可达，完成加固、备份、回滚手册、
文档与 `.trellis` 治理更新，并做 AC-1…AC-11 的全量端到端回归。

## Requirements
- `wechat-console.service`（systemd，`Restart=on-failure`）；`cloudflared` **由 console 进程内监督（Mode A，`CONSOLE_TUNNEL=1`，唯一支持模式）**；另附 `cloudflared.service` 供外部托管（Mode B）作备用，**与 Mode A 互斥**且会关闭 C5 隧道状态/变更邮件（见 `design.md` D28）。
- 反代/隧道参数化；只映射控制台端口（`127.0.0.1`），**不暴露 CDP 端口**。
- 限流 + 登录失败锁定 + 安全响应头（CSP/HSTS/X-Frame-Options）——后三者 C1 已实现，C6 补齐 **API 全局限流**。
- 备份/恢复脚本（`VACUUM INTO` + `data/` + `config.json` + `master.key`）。
- 调度器**失败退避**（修复 C2 遗留 D2：失败作业每分钟重试风暴）。
- 修复 C4 遗留 N1–N3 与 `chat.closed` 前端不关流。
- 迁移与回滚手册（恢复 `config.json.bak` + 停用控制台服务 + 重启 systemd timer）。
- 更新 `README.md` / `docs/操作手册.md` 相关节。
- 更新 `.trellis/spec/console/*`（index + api/data-model/security/agent-session）与 `AGENT.md`（S11+ 看板、D11–D14、任务地图）。
- 记录新 GATE：G6（控制台公网放行）、G7（凭据加密与隧道放行）。

## Acceptance Criteria
- AC-10 `bunx tsc --noEmit` + `bun build` 零错误；无新增 runtime `dependencies`；`bun src/cli.ts doctor --all` 与 `publish --dry-run` 通过。
- AC-11 所有失败路径显形（日志/邮件/UI），无"伪装成功"。
- AC-1…AC-11 全量回归通过并留证据（命令输出/产物路径写回 `AGENT.md` 与父任务 `implement.md`）。

## 关键决策（G-C6，详见 `design.md` §0/§3）
- D28 `cloudflared` 托管：Mode A（进程内监督）优先；Mode B 互斥且降级 C5。
- D29 API 限流：进程内令牌桶，只限 `/api/*`，429 + `Retry-After`，可 env 关闭。
- D30 备份 = `VACUUM INTO` + `data/`/`config.json`/`master.key` 打包；恢复强制停服 + 预检。
- D31 调度失败退避：`CONSOLE_JOB_MAX_ATTEMPTS`(3) + `CONSOLE_JOB_RETRY_COOLDOWN_MIN`(30)。
- D32 `/health` 增强为安全子集 `{status,version,uptimeSec,db,tunnel}`。
- D33 修 C4/C5 遗留 N1–N3 + 前端关流。

## Out of Scope
新功能开发；修改发布链路铁律；迁移既有 `data/` 目录结构。

## Dependencies
C1、C2、C3、C4、C5。

## GATE
- **G6（控制台公网放行）** / **G7（凭据加密与隧道放行）**：C6 交付后在真机（250）验证并请用户确认，落档 `AGENT.md` §2。

## Notes / 关联文件
`deploy/`、`docs/`、`.trellis/spec/console/*`、`AGENT.md`、`ARCHITECTURE.md`（新增控制面层）。
