# research.md · 调研（同类项目 / 技术底座 / 选型）

> 目标：回答"有没有现成可抄的"、"用什么技术底座"、"HAPI 的会话+审批怎么复刻"。
> 结论先行：**该组合在开源生态基本空白，无成熟方案可抄；但每一层都有可靠的官方/参考实现可组。**
> 检索时间：2026-10-13。检索方式：GitHub Search API + raw README + 本机 pi 官方文档。

---

## 1. 同类项目扫描（GitHub）

| 项目 | ★ | 覆盖 | 差距（为什么不直接用） |
|---|---|---|---|
| `duliangkuan/fengyun-publish` | 25 | 公众号 AI 内容流水线 | 单账号、无控制台、无多租户隔离、无人在环 |
| `PPPPanda/contentPipe` | 10 | 公众号 Scout→Write→Format | 同上，CLI/服务化为主 |
| `HsiangNianian/wechat-publisher-mcp` | 5 | 远程 MCP 发布 | 只解决"发布"一步，无管理面 |
| `majiabin2020/wechat-official-account-article-auto-publisher` | 3 | 创作+封面+草稿 | 单账号、无会话审批 |
| `bsahane/Auth-Proxy-Tunnel` | 2 | CF Tunnel + Nginx + Authentik | 只解决"安全暴露"一段，可作 C6 参考架构 |
| `CortexPrism/cortex-plugin-approval-workflow` | 0 | 人在环审批概念 | 仅概念，无可用实现 |
| `tiann/hapi` | 高 | **远程控制 agent 会话 + 审批** | 面向"编码 agent 会话"，无公众号/多账号/内容业务，**但架构与协议可直接借鉴（见 §2）** |

**结论**：`多账号 + Web 控制台 + 内容计划 + HITL 审批 + 草稿箱闭环` 无现成开源方案；需自研，但可**复用 HAPI 的架构模式**与**pi 原生 RPC 协议**，不必自己发明协议。

---

## 2. HAPI（tiann/hapi）架构拆解 —— 直接参考对象

来源：`https://github.com/tiann/hapi` README、`docs/guide/how-it-works.md`、`docs/guide/installation.md`、
`docs/api/client-contract/index.md`（2026-10-13 读取）。

**分层（可 1:1 映射到本项目）**

```text
CLI + Agent  <---- Socket.IO /cli ---->  Hub + SQLite
Runner       <---- Socket.IO /cli ---->       |
  |                                          | REST + SSE
  +-- spawns CLI sessions                    |
                                     Web / PWA / Mini App
```

| HAPI 组件 | 职责 | 本项目对应 |
|---|---|---|
| CLI wrapper | 包裹 agent、起会话、注册到 hub、转发消息与权限请求 | `src/pi.ts` + 新增 `src/console/agent/*`（RPC 会话管理） |
| Hub | REST + Socket.IO + SSE + **SQLite** 持久化 | `Bun.serve`（HTTP SSE + WS）+ `bun:sqlite` |
| Web App | 会话列表 / 聊天 / **权限审批** / 文件 / 终端 | 控制台前端（**精简**：会话/聊天/审批/计划/账号/运维） |
| Tunnel | CF Tunnel（推荐）/ Tailscale / relay | **R2 的 Cloudflare 映射**（本项目必做） |

**HAPI 的权限请求流（本项目 R3.5 的原型）**

```
1. agent 请求工具权限
2. CLI 把请求发给 hub
3. hub 落库 + SSE/通知推送
4. 用户在客户端收到
5. 用户批准/拒绝
6. hub 经 Socket.IO 回传决策
7. agent 继续执行
```

**明确不抄的部分**（超出 R5.1 "精简版"边界）：原生 iOS/Android、语音、Telegram Mini App、
WireGuard+E2E 中继、Work Graph、Web 终端、Shared Codex Sessions。

**协议参考价值**：HAPI 的 `REST + SSE` 客户端契约（`docs/api/client-contract/`）可作为本项目
API 风格与 SSE 断线续传（resume handshake / event id / 复合游标分页）的设计参考。

---

## 3. pi 底座：会话与"人在环"的官方机制（关键发现）

本项目已有 `src/pi.ts` 走 `pi --print --mode json`（**一次性**）。对"可对话的任务窗口 + 决策交互"，
pi 提供了两条**官方**路径：

### 3.1 pi SDK（`@earendil-works/pi-coding-agent`）— 进程内

来源：本机 `docs/sdk.md`（`/root/.local/share/pi-node/.../pi-coding-agent/docs/sdk.md`）。

- `createAgentSession()` → `AgentSession`；`session.prompt()` / `steer()` / `followUp()` / `abort()` / `waitForIdle()`。
- `session.subscribe((event) => ...)`：可拿 `message_update → text_delta` 做**流式**；
  `message_end` 是权威完成消息；`agent_settled` 表示 pi 不会再自动继续（判断"这一轮真的结束"用这个）。
- `SessionManager`：会话持久化 / 打开 / 继续 / **fork（分支）**；可 `SessionManager.inMemory()`。
- 代价：给宿主进程引入**运行时依赖**（与 `engine` 层"零依赖"铁律冲突）。

### 3.2 pi RPC 模式（`pi --mode rpc`）— 子进程 + JSONL（**推荐**）

来源：本机 `docs/rpc.md`、`docs/rpc-commands.md`、`docs/rpc-extension-ui.md`、`docs/json.md`。

- 长活子进程，stdin/stdout 严格 **JSONL**；命令带 `id`，响应回显 `id`（异步，按 id 关联）。
- 命令集（节选，直接对应本项目能力）：`prompt`（含 `streamingBehavior: steer|followUp`）、`steer`、
  `follow_up`、`abort`、`get_state`、`get_messages`、`set_model`、`set_thinking_level`、`compact`、
  `bash`、`fork`、`clone`、`switch_session`、`export_html`。
- 事件流（`docs/json.md`）：`message_update`（`text_delta` 流式）、`tool_execution_*`、
  `agent_end`、`agent_settled`、compaction/retry、`bash_execution_update`。
- **人在环的官方协议：`extension_ui_request` / `extension_ui_response`**（`docs/rpc-extension-ui.md`）：
  - 对话框（阻塞，需应答）：`select` / `confirm` / `input` / `editor`，带 `id`，可带 `timeout`（超时自动用默认值解决）。
  - 通知（fire-and-forget）：`notify` / `setStatus` / `setWidget` / `setTitle` / `set_editor_text`。
  - 应答：`{"type":"extension_ui_response","id":"...","value":"..."}` 或 `{"confirmed":true}` 或 `{"cancelled":true}`。
- 扩展侧 API：`pi.registerTool()` 注册模型可调用工具；`ctx.ui.confirm/select/input/editor/notify`；
  `ctx.mode === "rpc"` 时 `ctx.hasUI === true`（对话框在 RPC 下可用）；`pi.on("tool_call", ...)` 可对工具调用做**审批拦截**。
  来源：本机 `docs/extensions.md`（§UI and modes、§`pi.on("tool_call")`）。

**设计结论**：
1. 控制台用 **RPC 子进程**（保持 engine 层零依赖，进程隔离，崩溃不拖垮服务）。
2. **决策 = pi 扩展弹出的 `extension_ui_request` 对话框** → 落 `decisions` 表 → SSE 推前端 → 用户应答 →
   hub 把 `extension_ui_response` 写回 stdin。**不需要自造协议**。
3. "最小权限"通过扩展的 `tool_call` 拦截 + 受控工具白名单实现，而非把终端权限全交出去。

---

## 4. Cloudflare 隧道（R2 "过期重新生 CF 地址"）

| 方案 | 地址特性 | 适用 | 备注 |
|---|---|---|---|
| **Quick Tunnel** `cloudflared tunnel --url http://127.0.0.1:<port>` | `https://<随机>.trycloudflare.com`，**进程重启即变** | 无自有域名 | 与"过期/变更就重发邮件"的需求语义**天然吻合**；URL 需从 stderr 解析 |
| **Named Tunnel**（`tunnel create` + DNS 路由） | 固定自有域名，凭据持久 | 有域名 | 适合长期稳定；不涉及"重新生成" |
| Tailscale / ngrok | 另类 | 备选 | HAPI 亦支持；本项目以 CF 为准 |

**工程要点**：cloudflared 作为受管子进程/`systemd` 服务；`tunnel.ts` 负责解析 URL、健康检查、
变更检测、落库、触发邮件；旧地址标记 `expired`。参考 `bsahane/Auth-Proxy-Tunnel` 的"安全暴露栈"组合
（CF Tunnel + Nginx Proxy Manager + Authentik）。

---

## 5. 鉴权与会话（自研，零依赖可行）

- **口令哈希**：bun 内置 `Bun.password.hash()` / `verify()`（argon2id），无需 npm 依赖。
- **登录会话**：服务端 `sessions` 表 + HttpOnly/Secure/SameSite=Lax Cookie；状态变更请求加 CSRF token。
- **角色**：`admin`（全账号）/ `owner`（仅被授权账号）；账号级授权表。
- **加固**：登录失败限流与锁定、审计日志、可选 **Cloudflare Access** 作为隧道前置身份门（Zero Trust）。
- 参考 HAPI：首启生成 access token、`ENV > settings.json > default` 的配置优先级（本项目采用类似优先级）。

---

## 6. 数据库选型对比（R4）

| 维度 | **SQLite（`bun:sqlite`）** | DuckDB | PostgreSQL |
|---|---|---|---|
| 形态 | 事务型 OLTP 内嵌 | OLAP/列存分析 | C/S 服务 |
| 本项目负载 | 账号/用户/会话/任务/决策/审计 = **事务型 CRUD** | 日志分析/报表 | 过重 |
| 依赖 | **bun 内置，零依赖** | 需额外原生依赖/包 | 需独立服务 |
| 备份 | 单文件 + WAL | 单文件 | pg_dump |
| 并发 | 单写多读（本项目够用） | 分析型 | 高 |
| 结论 | ✅ **选它** | ❌ 不匹配（可后置做报表） | ❌ 过重 |

补充：`bun:sqlite` 提供 WAL、预编译语句、事务；文件与内容产物仍留在 `data/<alias>/`（DB 是控制面，文件系统是内容面）。

---

## 7. 语言与 HTTP/WS 选型（R4）

| 选项 | 判断 |
|---|---|
| **TS + bun（`Bun.serve` + `bun:sqlite` + `Bun.password`）** | ✅ 继续满足"零 npm 依赖"；可原地复用 `config.ts`/`pi.ts`/`planner.ts`/`publisher.ts`/`wechat.ts` |
| Go / Rust | ❌ 与既有 TS 引擎割裂，发布链路（CDP/skill/pi）需重写，收益为负 |
| Node + Nest/Next/Prisma | ❌ 破坏零依赖约束 |
| 前端框架（React/Vue + 构建） | ❌ R5.1 明确不引入重设计；用静态页 + 原生 JS + SSE/WS |

---

## 8. 调研结论摘要

1. **无现成方案可抄**；HAPI 是最接近的**架构参考**（Hub+SQLite+REST/SSE+审批流+CF Tunnel）。
2. **人在环不需要自造协议**：pi `--mode rpc` 的 `extension_ui_request/response` 就是官方答案。
3. **零依赖方案成立**：`Bun.serve` + `bun:sqlite` + `Bun.password` 覆盖 HTTP/WS/SQLite/哈希。
4. **CF Quick Tunnel 语义与"过期重新生地址"天然匹配**；有域名则升级 named tunnel。
5. 复用现有引擎（隔离、pi、发布、真相源校验），**只加控制面，不动铁律**。

## 参考锚点

- pi：`docs/rpc.md`、`docs/rpc-commands.md`、`docs/rpc-extension-ui.md`、`docs/json.md`、`docs/sdk.md`、`docs/extensions.md`（本机 pi 安装目录）
- HAPI：`tiann/hapi` README + `docs/guide/how-it-works.md` + `docs/guide/installation.md` + `docs/api/client-contract/index.md`
- 本项目：`ARCHITECTURE.md`、`.trellis/spec/engine/*`、`src/config.ts`、`src/pi.ts`、`src/state.ts`
