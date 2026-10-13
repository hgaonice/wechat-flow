# design.md · 技术设计（wechat-flow-console）

> 配套：需求见 `prd.md`，调研见 `research.md`，排期见 `implement.md`。
> 定位：**在既有 engine 之上加一个控制面（control plane）**，不修改发布链路的铁律与唯一真相源。

---

## 1. 总体架构

```text
                    ┌───────────────────────────────┐
   浏览器/手机 ─────►│  Cloudflare Tunnel (cloudflared)│──► 127.0.0.1:8787
                    └───────────────────────────────┘
                                    │
        ┌───────────────────────────▼────────────────────────────┐
        │  wechat-console (Bun.serve)  —— 控制面                   │
        │  ┌──────────┬───────────┬───────────┬────────────────┐  │
        │  │ HTTP/API │ SSE/WS    │ 静态 UI   │ Auth/RBAC/CSRF │  │
        │  └────┬─────┴─────┬─────┴─────┬─────┴───────┬────────┘  │
        │       │           │           │             │            │
        │  ┌────▼────┐ ┌────▼─────┐ ┌───▼─────┐ ┌─────▼──────┐    │
        │  │ dao/    │ │ scheduler│ │ agent/  │ │ tunnel/    │    │
        │  │ bun:sqlite│ │ jobs     │ │ pi RPC  │ │ cloudflared│    │
        │  └────┬────┘ └────┬─────┘ └───┬─────┘ └─────┬──────┘    │
        └───────┼───────────┼───────────┼─────────────┼──────────┘
                │           │           │             │
        console.db (WAL)    │      pi --mode rpc   cloudflared 子进程
                            │           │
                            ▼           ▼
        ┌────────────────────────────────────────────────────────────┐
        │  既有 engine（复用，不改铁律）                                │
        │  config.ts  planner.ts  publisher.ts  wechat.ts  state.ts   │
        │  verifyDraftBody()  mailer.ts  media.ts  cover.ts  pi.ts    │
        └────────────────────────────────────────────────────────────┘
                            │
                   data/<alias>/{plans,articles,imgs,state,logs,sessions}
```

**边界原则**：控制面只负责"配置 / 调度 / 会话 / 审批 / 观测"；**内容生成与发布仍然走 engine**，
控制面通过**进程内调用 engine 导出函数**（新会话在 `cwd=APP_DIR`）或**子进程 `bun src/cli.ts ...`** 两种方式触发，
优先前者以复用返回结构，失败时降级为子进程。

---

## 2. 代码结构（新增层 `console`）

```text
src/console/
  main.ts               # 入口：加载配置 → 迁移/自检 → Bun.serve → 启动调度器 & 隧道监督
  server.ts             # 路由表、静态资源、SSE/WS 升级、错误中间件
  http/
    router.ts           # 无依赖路由器（method+path 模式匹配）
    respond.ts          # JSON/HTML/SSE 响应助手、统一错误包 {status,code,message}
    sse.ts              # 事件总线 → SSE（含 last-event-id 续传）
  auth/
    users.ts            # 用户 CRUD、Bun.password、角色
    sessions.ts         # 登录会话、Cookie、CSRF
    rbac.ts             # 账号级授权、越权检查
  crypto/
    secrets.ts          # AES-256-GCM 加解密、master key 装载
  db/
    schema.ts           # DDL（见 §4）
    migrate.ts          # 版本化迁移（user_version）
    import-config.ts    # config.json → DB 一次性导入（§6）
    render-config.ts    # DB → config.json 回渲染（§6）
    dao/*.ts            # accounts/users/sessions/plans/jobs/articles/chat/decisions/tunnels/audit/settings
  config/
    resolve.ts          # 全局默认 ⊕ 账号覆盖（深合并）→ AppConfig
  jobs/
    queue.ts            # 入队/认领/心跳/超时回收
    worker.ts           # 每账号互斥执行 engine 调用
    scheduler.ts        # 计划到期扫描 → 入队
  agent/
    rpc.ts              # pi --mode rpc 子进程：JSONL 帧、id 关联、事件分发
    session.ts          # chat_session ↔ pi 进程生命周期、续接、fork
    extensions/
      console-decision.ts  # 项目内 pi 扩展：注册 ask_user 决策工具、tool_call 最小权限拦截
  tunnel/
    cloudflared.ts      # 子进程监督、URL 解析、健康检查、变更检测
  notify/
    tunnel-mail.ts      # R2 邮件组装与发送（复用 engine mailer.ts）
  ui/                   # 静态资源（无构建）：index.html / app.js / app.css / login.html
```

**依赖方向**：`console/* → ../*.ts(engine)`，**engine 不得反向依赖 console**。
新增 spec 层 `.trellis/spec/console/`（index + api / data-model / security / agent-session）。

---

## 3. 配置继承与覆盖模型（R1.3 / R1.4）

**真相源**：DB（`settings` 全局默认 + `accounts.overrides`），`config.json` 变为**派生产物**。

解析顺序（后者覆盖前者，深合并；数组整体替换，`null` 表示"显式清空"）：

```text
内置默认(defaults)  ⊕  settings(key=global)  ⊕  account.overrides  →  RawConfig → AppConfig
```

- 复用 `config.ts`：新增导出 `resolveConfig(raw: RawConfig, alias)`，`loadConfig()` 内部改为读取
  `config.json` 后调用它，**保持既有签名与行为不变**（向后兼容）。
- 深合并规则显式定义（对象递归、数组替换、`undefined` 跳过、`null` 清空），并单元可测。
- UI 用"字段来源"标记：`继承` / `覆盖`（`accounts.overrides` 中存在的路径即为覆盖），支持"恢复继承"（删除该路径）。

---

## 4. 数据模型（SQLite / `bun:sqlite`，WAL）

```sql
PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;

-- 身份与鉴权
users(id PK, username UNIQUE, pass_hash, role TEXT CHECK(role IN ('admin','owner')),
      disabled INT DEFAULT 0, created_at, updated_at)
login_sessions(id PK, user_id FK, token_hash UNIQUE, csrf_token,
               created_at, expires_at, last_seen_at, ip, ua)
account_grants(id PK, user_id FK, account_id FK, UNIQUE(user_id,account_id))   -- owner 授权

-- 配置（控制面真相源）
settings(key PK, value_json, updated_at)                     -- 全局默认（可含 model/notify/cover/math/manim/…）
accounts(id PK, alias UNIQUE, display_name, author, theme, color, cdp_port INT UNIQUE,
         enabled INT, publish_method, data_dir, content_dir, prompts_dir,
         overrides_json,          -- 单账号覆盖（深合并到 settings 之上）
         created_at, updated_at)
account_email(id PK, account_id FK UNIQUE, to_json, cc_json, subject_prefix)

-- 凭据（加密）
secrets(id PK, account_id FK NULL, kind TEXT,   -- 'wechat_login'|'smtp'|'cf_token'
        ciphertext BLOB, nonce BLOB, key_version INT, created_at, updated_at,
        UNIQUE(account_id, kind))

-- 计划与任务
plans(id PK, account_id FK, period_type CHECK(period_type IN ('week','month')),
      period_key TEXT,             -- '2026-W42' | '2026-10'
      items_json,                  -- 计划条目（日期/选题/摘要/目标字数/备注）
      status TEXT, created_by FK, created_at, updated_at, UNIQUE(account_id,period_type,period_key))
jobs(id PK, account_id FK, kind TEXT,   -- 'plan'|'generate'|'publish'|'regenerate'
     payload_json, status TEXT CHECK(status IN ('queued','running','succeeded','failed','canceled')),
     progress INT, message, error, attempts INT, created_by FK,
     queued_at, started_at, ended_at, pid)
job_logs(id PK, job_id FK, ts, level, message)

-- 内容与草稿
articles(id PK, account_id FK, plan_id FK NULL, date, title, slug, file_path,
         status TEXT,          -- 'generated'|'pushed'|'verified'|'failed'
         version INT, parent_id FK NULL, feedback TEXT, created_at)
drafts(id PK, account_id FK, article_id FK, wechat_title, push_at, verified INT,
       verify_detail, created_at)

-- 会话与人在环
chat_sessions(id PK, account_id FK, job_id FK NULL, pi_session_id, title, status,
              created_by FK, created_at, updated_at)
chat_messages(id PK, chat_session_id FK, role, content, meta_json, created_at)
decisions(id PK, chat_session_id FK, request_id UNIQUE,   -- pi extension_ui_request.id
          method CHECK(method IN ('select','confirm','input','editor')),
          title, message, options_json, timeout_ms,
          status TEXT CHECK(status IN ('pending','answered','cancelled','expired','lost')),
          response_json, created_at, answered_at, answered_by FK)

-- 运维
tunnels(id PK, kind CHECK(kind IN ('quick','named')), url, hostname, pid,
        status CHECK(status IN ('up','down','expired','error')), detail,
        created_at, expires_at, last_checked_at, replaced_by FK NULL)
audit(id PK, user_id FK NULL, action, target, detail_json, ip, ua, ts)

CREATE INDEX idx_jobs_status ON jobs(status, queued_at);
CREATE INDEX idx_articles_acc ON articles(account_id, date, version);
CREATE INDEX idx_decisions_status ON decisions(status, created_at);
```

**迁移**：`PRAGMA user_version` 版本号 + `migrate.ts` 顺序脚本；启动时自动前滚，失败中止启动并显式报错。

---

## 5. 关键流程

### 5.1 鉴权与授权

1. `POST /api/login`：`Bun.password.verify` → 建 `login_sessions` → `Set-Cookie: wfc_sid=<opaque>; HttpOnly; Secure; SameSite=Lax`。
2. 每次请求：哈希 cookie 查表 → 校验有效期 → 装载 `{user, role, grantedAccounts}`。
3. **授权判定**：`admin` 全通；`owner` 仅 `account_grants` 内账号；越权 → 403 + `audit` 落库。
4. 状态变更请求（POST/PUT/DELETE）校验 `X-CSRF-Token`（与 `login_sessions.csrf_token` 比对）。
5. 加固：连续失败锁定（内存 + `audit`）、API 全局限流。

### 5.2 凭据加密（R2.3 / R4）

- 算法：**AES-256-GCM**（WebCrypto / `crypto.subtle`），每密文独立随机 nonce，存 `key_version` 便于轮换。
- master key：优先 `CONSOLE_MASTER_KEY`（base64，32B）；缺省读取 `~/.wechat-console/master.key`（0600，不存在则首启生成）。
- **API 永不回显明文**：读接口返回 `{kind, configured:true, updated_at}`；写接口只收不发。
- 无 key → 拒绝启动（fail fast），不静默降级为明文。

### 5.3 调度与任务（R3.1–R3.3）

- 计划真相源在 `plans` 表；`scheduler.ts` 定时（默认 60s）扫描到期计划 → 生成 `jobs`（`kind=plan`）。
- `worker.ts` 认领队列：**每账号同时最多 1 个运行中任务**（因 `cdpPort`/Chrome profile 独占），
  跨账号可并发（但受全局并发上限约束）。
- 执行方式：调用 engine（`runPlan` / `runPublish`），事件写入 `job_logs`，同时经 SSE 推送 `job.progress`。
- **与 systemd timer 的关系（K4/D7 修订）**：迁移期 systemd timer **停用**，改由控制台调度；
  `deploy/` 保留可选"无控制台回退"timer。避免双触发导致重复发布。
- 幂等：沿用 engine `state/published.json`；`jobs` 表额外记录，双重去重（同账号+同日期已有 succeeded job 则跳过）。

### 5.4 内容生成 → 草稿箱 → 重生成（R3.6）

```
plans 行 ──(scheduler/手动)──► jobs(kind=publish) ──► engine.runPublish()
   │                                                        │
   │                                          articles/<date>-<slug>.md
   │                                                        │
   │                              media → cover → CDP → verifyDraftBody()
   │                                                        │
   └────────────── drafts 行（verified=true） ◄──────────────┘
                            │
         用户"不满意" ──► jobs(kind=regenerate, feedback=…) ──► 新 article.version+1,
                          parent_id=旧版本；旧版本保留可查
```

- 重生成把用户反馈拼进 `prompts/article.md` 的补充段（**不改引擎，只传参**），并在 UI 展示 diff 与两版正文。
- 推送结果**以 `verifyDraftBody()` 为准**（AC-5），UI 显示 `✅ 正文校验` / 失败详情。

### 5.5 Agent 会话窗口与人在环（R3.4 / R3.5）—— HAPI 精简版

**协议映射（无需自造协议）**：

| 方向 | pi RPC 记录 | 控制台行为 |
|---|---|---|
| 前端→hub | `POST /api/chat/:id/message` | 写 `{"type":"prompt","message":…}` 到 pi stdin（流式中则 `streamingBehavior:"steer"`） |
| pi→hub | `message_update.text_delta` | SSE `chat.delta` → 前端流式渲染 |
| pi→hub | `message_end` | 落 `chat_messages`（权威完整消息） |
| pi→hub | `agent_settled` | SSE `chat.settled`（该轮真正结束） |
| pi→hub | `extension_ui_request{method:select/confirm/input/editor}` | 落 `decisions(status=pending)` + SSE `decision.pending` |
| 前端→hub | `POST /api/decisions/:id` | 落 `response_json` + 把 `extension_ui_response` 写回 pi stdin → agent 继续 |
| pi→hub | `notify` / `setStatus` | SSE 即时提示/状态条（fire-and-forget） |
| 前端→hub | `POST /api/chat/:id/abort` | `{"type":"abort"}` |

**会话生命周期**：`chat_sessions` 1:1 一个 pi RPC 子进程；进程异常退出 → 标记 `lost`，把 pending 决策置
`lost` 并在 UI 提示（**失败显形**）；`session.fork/clone` 复用 pi 能力实现"分支重来"。

**最小权限（R3.5）**：pi 会话以受限工具集启动（`--no-tools` 或白名单只读 + 仅内容目录写入），
危险工具经 `console-decision.ts` 扩展的 `pi.on("tool_call")` 拦截并转成决策卡片；
**控制台不提供"完全放开"的开关**。

### 5.6 Cloudflare 隧道与邮件下发（R2.2 / R2.3）

- `cloudflared.ts` 监督 `cloudflared tunnel --url http://127.0.0.1:8787 --no-autoupdate`。
- **已定（2026-10-13 / K3）：采用 CF Quick Tunnel**（无自有域名）。`kind='quick'`；named tunnel 仅保留为未来有域名时的升级项（`kind='named'`，字段与流程已预留）。
- 从 stderr 解析 `https://<host>.trycloudflare.com`；健康检查（本地 `/health` + 远端 HEAD）。
- URL **变更或被判定过期** → 新 `tunnels` 行（`replaced_by` 指向旧行、旧行 `expired`）→ 触发邮件。
- 邮件内容（模板复用 engine `mailer.ts`）：**当前服务器信息**（主机/内网 IP/端口/时间）+ **当前 CF 地址** +
  **该账号后台登录账号密码**（从 `secrets` 解密，仅发往该账号自己的 `account_email.to`；管理员可另发自身）。
- 管理员全局视图：跨账号配置总览 + 操作入口（受 `admin` 角色限制）。

---

## 6. 兼容性与迁移

| 项 | 策略 |
|---|---|
| `config.json` 真源地位 | 迁移为**派生产物**：`import-config.ts` 一次性导入 → DB；`render-config.ts` 在账号/全局变更后**原子回渲染** `config.json`（先备份 `.bak`） |
| 迁移无损验收 | AC-3：DB 解析结果与原 `loadConfig()` 逐字段比对；回渲染后 diff 无非预期变化 |
| CLI 兼容 | `src/cli.ts` 不变；引擎读到的是 DB 回渲染出的 `config.json` |
| systemd timer | 迁移期停用，控制台调度接管；保留回退脚本 |
| 数据目录 | `data/<alias>/` 结构不变；DB 文件放 `console/console.db`（不入 git） |
| 回滚 | 恢复 `config.json.bak` + 停用控制台服务 + 重新启用 systemd timer；DB 保留不删 |

---

## 7. 安全设计（K1 —— 本需求最高风险）

| 层 | 措施 |
|---|---|
| 传输 | 必须经 Cloudflare（HTTPS）；本地可选只监听 `127.0.0.1`（不监听 0.0.0.0） |
| 身份 | 强口令 + argon2id；**建议叠加 Cloudflare Access** 作为隧道前置身份门 |
| 会话 | HttpOnly/Secure/SameSite Cookie + CSRF + 过期与吊销 |
| 授权 | 角色 + 账号级授权；越权写审计 |
| 限流 | 登录失败锁定 + API 全局限流 |
| 凭据 | AES-256-GCM，master key 0600 文件/环境变量，永不回显 |
| 暴露面收敛 | 隧道**只**映射控制台端口；Chrome CDP 端口**绝不**经隧道暴露 |
| 审计 | 登录、账号变更、凭据变更、决策应答、任务触发全量落 `audit` |
| 风险提示 | 自动填账密登录公众号可能触发风控 → 保留二维码自愈兜底（K2） |

---

## 8. 关键权衡（Trade-offs）

| 决策 | 取舍 |
|---|---|
| pi **RPC 子进程** vs SDK 进程内 | 选 RPC：保持 engine 零依赖铁律、进程隔离；代价是多一层 JSONL 帧与进程管理 |
| **DB 为配置真源** + 回渲染 `config.json` | 不重构 `config.ts`、CLI 零改动；代价是"两个文件可能漂移"→ 用 AC-3 比对与原子回渲染约束 |
| **SQLite** vs 其他 DB | 单文件/零依赖/事务够用；放弃高并发与横向扩展（本项目不需要） |
| **静态 UI（无构建）** vs 前端框架 | 部署极简、符合 R5.1；放弃组件化与丰富交互（用 SSE + 原生 JS 弥补） |
| **每账号串行任务** | 保证不发错号（沿用 `cdpPort` 隔离）；代价是账号内任务排队 |
| **CF Quick Tunnel（已定 K3）** | 免域名、与"过期重生成"语义吻合；代价是地址会变（用邮件通知补偿） |

---

## 9. 运维与回滚

- 服务：`wechat-console.service`（systemd，`Restart=on-failure`）；`cloudflared` 单独 service。
- 备份：`console.db` + `data/` + `config.json`；WAL 下用 `VACUUM INTO` 做一致性快照。
- 观测：`/health`（免鉴权，返回版本/DB/隧道/队列摘要）、`job_logs`、SSE 进度、邮件告警。
- 回滚点：迁移前 `config.json.bak` + DB 快照；每个子任务独立可回滚（见 `implement.md`）。
