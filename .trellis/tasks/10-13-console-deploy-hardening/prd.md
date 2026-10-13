# C6 · 部署与加固（console-deploy-hardening）

> 父任务：`10-13-wechat-flow-console`（源需求 R5 + 全局验收）。设计见父 `design.md` §7–§9。
> 依赖 C1–C5 全部验收。

## Goal
把控制台安全地部署到 192.168.0.250 并通过 Cloudflare 公网可达，完成加固、备份、回滚手册、
文档与 `.trellis` 治理更新，并做 AC-1…AC-11 的全量端到端回归。

## Requirements
- `wechat-console.service` + `cloudflared` service（systemd，`Restart=on-failure`）。
- 反代/隧道参数化；只映射控制台端口，**不暴露 CDP 端口**。
- 限流 + 登录失败锁定 + 安全响应头（CSP/HSTS/X-Frame-Options）。
- 备份/恢复脚本（`VACUUM INTO` + `data/` + `config.json`）。
- 迁移与回滚手册（恢复 `config.json.bak` + 停用控制台服务 + 重启 systemd timer）。
- 更新 `README.md` / `docs/操作手册.md` 相关节。
- 更新 `.trellis/spec/console/*`（index + api/data-model/security/agent-session）与 `AGENT.md`（S11+ 看板、D11–D14、任务地图）。
- 记录新 GATE：G6（控制台公网放行）、G7（凭据加密与隧道放行）。

## Acceptance Criteria
- AC-10 `bunx tsc --noEmit` + `bun build` 零错误；无新增 runtime `dependencies`；`bun src/cli.ts doctor --all` 与 `publish --dry-run` 通过。
- AC-11 所有失败路径显形（日志/邮件/UI），无"伪装成功"。
- AC-1…AC-11 全量回归通过并留证据（命令输出/产物路径写回 `AGENT.md` 与父任务 `implement.md`）。

## Out of Scope
新功能开发；修改发布链路铁律；迁移既有 `data/` 目录结构。

## Dependencies
C1、C2、C3、C4、C5。

## Notes / 关联文件
`deploy/`、`docs/`、`.trellis/spec/console/*`、`AGENT.md`、`ARCHITECTURE.md`（新增控制面层）。
