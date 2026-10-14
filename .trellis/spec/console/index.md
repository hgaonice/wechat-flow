# Console Development Guidelines

> 控制面（control plane）：在既有 engine（`src/*.ts`，见 `../engine/index.md`）之上加一层**带鉴权的 Web 管理控制台**，
> 让非命令行使用者能自助管理多账号、编排内容计划、与 pi agent 会话并在环审批。
>
> **状态：C1 + C2 + C3 + C4 已落地；`api.md`/`data-model.md` 已校准为 v4；`agent-session.md` 校准为 v2。**
> 于 M0 编写（源：父任务 `design.md`）。
> 契约与代码冲突时：**先改本目录，再改代码**；DDL / API / 安全语义变更必须同步本目录。

---

## 一、硬约束（违反视为失败）

| # | 约束 | 来源 |
|---|---|---|
| H1 | **不改发布铁律**：AI 只做内容，其余确定性；`verifyDraftBody()` 是唯一真相源 | `../engine/ai-determinism.md`、`../engine/verification.md` |
| H2 | **engine 不得反向依赖 console**；依赖方向 `console/* → ../*.ts` | `design.md` §2 |
| H3 | **运行时不新增 npm 依赖**（`package.json` 的 `dependencies` 保持为空）；只用 `Bun.serve` / `bun:sqlite` / WebCrypto | AC-10 |
| H4 | **多账号隔离**：`data/<alias>/` 且 `cdpPort` 唯一；冲突**报错**，不静默回退 | `../engine/directory-structure.md` |
| H5 | **失败显形**：`ok:false` + 原因 + 告警；降级可接受，伪装成功不可接受 | `../engine/error-handling.md` |
| H6 | **迁移期兼容**：任何里程碑结束时 `bun src/cli.ts publish --dry-run` 必须仍可用 | `design.md` §6 |
| H7 | **凭据永不回显明文**；无 master key 必须 fail-fast（拒绝启动/拒绝解密） | AC-9、`security.md` |
| H8 | **只暴露控制台端口**；Chrome CDP 端口绝不入隧道 | `design.md` §7 |

---

## 二、技术栈

| 维度 | 约定 |
|---|---|
| 运行时 | `bun >= 1.3`（实测 1.4.2），直接执行 `.ts`，不编译不打包 |
| 服务端 | `Bun.serve`（HTTP + SSE/WS 升级） |
| 数据 | `bun:sqlite`，WAL + `foreign_keys=ON`，`console/console.db`（不入 git） |
| 加密 | **`node:crypto`** AES-256-GCM（`createCipheriv`，**非** WebCrypto）；口令 `Bun.password`（argon2id） |
| 前端 | 静态页面（`src/console/ui/`）+ 原生 JS，**无构建步骤**（R5.1） |
| 类型检查 | `node_modules/.bin/tsc --noEmit`（本地）或 `bunx tsc --noEmit`；另 `bun build --target=bun src/console/main.ts` |

---

## 三、代码结构（新增层）

```text
src/console/
  main.ts  server.ts
  http/{router,respond,sse}.ts
  auth/{users,sessions,rbac}.ts
  crypto/secrets.ts
  db/{schema,migrate,import-config,render-config}.ts + db/dao/*.ts
  config/resolve.ts
  jobs/{queue,worker,scheduler}.ts
  content/generate.ts
  agent/{frames,rpc,events,manager}.ts + agent/extensions/console-decision.ts
  tunnel/cloudflared.ts
  notify/tunnel-mail.ts
  ui/{index.html,login.html,app.js,app.css,workbench.*,chat.*}
```

详见 `design.md` §1（架构图）/ §2（目录）。**依赖方向单向**，见 H2。

---

## 四、Guidelines Index

| Guide | 说明 | 状态 |
|-------|------|------|
| [API Contract](./api.md) | HTTP/SSE 约定、错误包、端点清单、鉴权头 | v4（C1–C4） |
| [Data Model](./data-model.md) | SQLite DDL、不变量、迁移、`config.json` 派生关系（AC-3） | v4（C1–C4） |
| [Security](./security.md) | 鉴权/RBAC/CSRF/限流/凭据加密/暴露面/审计（K1） | v4（C1–C4） |
| [Agent Session](./agent-session.md) | pi `--mode rpc` 帧协议、决策生命周期、最小权限 | v2（C4） |

---

## 五、Pre-Development Checklist（写 console 代码前逐条确认）

- [ ] 已读本文件 + 涉及的 1–2 篇 guide（**不要**整读 `README.md` / `操作手册.md`）
- [ ] 已读 `../engine/index.md` 与该改动相关的 engine guide
- [ ] 确认改动**不触碰**发布链路铁律（H1）；若必须触碰，先写 `prd.md` 并等用户确认
- [ ] 确认没有新增 runtime npm 依赖（H3）
- [ ] 若涉及账号/端口：确认隔离不变量（H4）
- [ ] 若涉及凭据：确认加密落库 + 不回显（H7）
- [ ] 若涉及 DDL / API / 安全语义：已同步本目录对应 guide
- [ ] 失败路径想清楚：如何被检出、如何显形（H5）

## 六、Quality Check（声明「做完」前必须实测）

- [ ] `bunx tsc --noEmit` 零错误；`bun build --target=bun src/console/main.ts` 通过
- [ ] `bun src/cli.ts doctor --all` 与 `bun src/cli.ts publish --dry-run` 仍可用（H6）
- [ ] 受影响 API 有真实 `curl` 输出（含 401/403 越权路径）
- [ ] `package.json` `dependencies` 仍为空（H3）
- [ ] 关键结论写回 `AGENT.md` 变更日志；新约定写回本目录

> 打勾规则：完成 = 产物存在（路径）**或**命令真实输出。禁止「我记得做过了」。

---

## 七、反模式（禁止重犯）

| 反模式 | 为什么 | 见 |
|---|---|---|
| console 直接内联「选题/写文/润色」逻辑 | 违反 AI 只做内容（H1） | `../engine/ai-determinism.md` |
| engine 里 `import` console 的模块 | 反向依赖，破坏可独立运行 | H2 |
| 为图省事引入 express/sqlite3 等 npm 包 | 违反零依赖红线 | H3 |
| 新增账号复用已有 `cdpPort` | 会串号发错公众号 | H4 |
| API 读接口把 `secrets` 明文/密文返回前端 | 凭据泄露 | H7 |
| 无 `CONSOLE_MASTER_KEY` 时降级为明文存储 | 静默降级，违反 H5/H7 | `security.md` |
| 用 `readline` 解析 pi RPC 帧 | 会按行缓冲丢/并帧；必须只在 `\n` 切分 | `agent-session.md` |
| SSE 订阅晚于 `prompt`，或用 `agent_end` 当轮次结束 | 漏掉快速事件 / 提前判完；必须先订阅、认 `agent_settled` | `agent-session.md` §4 |
| 会话失联时把会话与 pending 决策分两个事务清 | 崩溃/中断会留下悬挂决策 | `agent-session.md` §5、`data-model.md` I23 |
| 预期关闭（TTL `sweepIdle` / 删除 / 退出）只改会话状态、不清 pending | 进程已死但决策卡仍 `pending`（I21），直到下次重启才回收 | `agent-session.md` §1/§5 |
| `ChatManager` 缺失时把 `/api/chats*` 降级为 200 空结果 | 伪装成功，调用方误以为无会话 | `api.md` §2.4（应 503 `chat_unavailable`） |
| 经隧道暴露 CDP 端口或监听 `0.0.0.0` | 远程接管 Chrome | H8、`security.md` |
