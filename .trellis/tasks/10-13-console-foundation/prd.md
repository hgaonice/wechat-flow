# C1 · 控制台基座（console-foundation）

> 父任务：`.trellis/tasks/10-13-wechat-flow-console/`（源需求 R1/R4）。设计见父 `design.md` §2–§4、§6。
> 交付一个**可登录、可管账号、可改配置**的最小可用控制台；这是后续全部子任务的地基。

## Goal
用 `Bun.serve` + `bun:sqlite` 建立控制台服务骨架与数据层，实现鉴权/RBAC、账号 CRUD、
全局默认与单账号覆盖（含"恢复继承"），并把现有 `config.json` 无损迁移为 DB 派生模型。

## Requirements
- R1.1 账号增删改查 + 启用/禁用；新增时校验 `alias` 与 `cdpPort` 唯一，冲突给可用端口提示（不静默回退）。
- R1.2 沿用 `data/<alias>/` 隔离；控制台不改动隔离规则。
- R1.3 全局默认（`settings`）⊕ 账号 `overrides_json` 深合并；数组整体替换，`null` 清空。
- R1.4 UI 显示字段来源（继承/覆盖）并可"恢复继承"。
- 鉴权：用户名 + `Bun.password`（argon2id）；Cookie 会话（HttpOnly/Secure/SameSite=Lax）+ CSRF。
- 角色：`admin`（全账号）/ `owner`（仅 `account_grants`）；越权 403 + 审计。
- 凭据加密容器：AES-256-GCM + master key 装载（`CONSOLE_MASTER_KEY` 或 `~/.wechat-console/master.key` 0600），无 key fail-fast。
- 迁移：`config.json` → DB（先备份 `.bak`）；账号/全局变更后**原子回渲染** `config.json`。
- 零新增 runtime 依赖；engine 反向依赖禁止。

## Acceptance Criteria
- AC-1 新建 A/B 两账号，`dataDir`/`cdpPort` 互不相同；重复 `cdpPort` 被拒并提示可用端口。
- AC-2 全局 `math.enabled=false`，A 覆盖 `true` → A 生效 `true`、B `false`；清除覆盖后 A 回落 `false`。
- AC-3 DB 解析出的 `AppConfig` 与原 `loadConfig()` 逐字段一致（paths/browser/model/notify/cover）；回渲染 diff 无非预期变化。
- AC-4 未登录 API=401；跨账号越权=403 且写审计；admin 可见全部。
- AC-10 `bunx tsc --noEmit` + `bun build` 零错误；`package.json` 无新增 `dependencies`；`bun src/cli.ts doctor --all` 仍通过。

## Out of Scope
计划/调度（C2）、内容生成（C3）、agent 会话（C4）、隧道与邮件（C5）、部署（C6）。

## Dependencies
无前置。C2–C6 均依赖本任务的 DB/鉴权/配置解析。

## Notes / 关联文件
`src/console/{main,server}.ts`、`src/console/{http,db,auth,crypto,config,ui}/**`、`src/config.ts`（仅新增 `resolveConfig`）。
