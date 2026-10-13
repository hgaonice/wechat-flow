# Data Model（SQLite / `bun:sqlite`）

> 状态：**v1（已随 C1 校准）**。C1 落地后本文以 `src/console/db/schema.ts` 为唯一 DDL 真相源，
> 本文只描述**语义契约 + 与设计稿的差异**，不再复制整段 DDL（避免双写漂移）。
> 存储：`console/console.db`（`CONSOLE_DB` 可覆盖，不入 git）；
> 连接期固定 `PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout`（见 `db/migrate.ts#openDb`）。

---

## 1. 配置真相源与派生关系（AC-3 的关键）

```
内置默认(defaults) ⊕ settings(key='global') ⊕ account.overrides  → RawConfig → AppConfig
```

- **真相源 = DB**（`settings(key='global').value_json` = 原始 `config.json` 去掉 `accounts`；
  `accounts.overrides_json` = **该账号在 `config.json` 里的原始条目逐字节保留**）；`config.json` 是**派生产物**。
- **存储即 verbatim，绝不深合并**（D1）。`buildRawConfig()` 把条目原样放回
  `accounts[alias]`，让引擎自己决定回退，从而保证 **DB 派生 == 文件派生**（AC-3）。
- **引擎回退语义（务必按引擎真实行为理解，不要简化成“浅合并”）**：
  - 字符串/对象类键（`cover`、`math` 等）：`acct[k] ?? raw[k]` —— **整个对象**回退；
  - `model`：**按嵌套 kind 回退**，`acct.model?.[kind] ?? raw.model?.[kind]`；
  - `null` 与缺失**等价**（都走 `??`，即**继承**，不是清空 —— 与 v0 稿的“null 显式清空”相反，D2）；
  - 数组（如 `emailTo`）：整体替换（`??` 天然如此）。
- 字段来源判定（`keySource`）：键出现在账号条目中（且非 `undefined`/`null`）→ `overridden`，否则 `inherited`。
  - **“恢复继承” = 按顶层键整键删除**（`reset-override { key }`），粒度为**顶层键**，不做子路径删除。
- 回渲染：`db/render-config.ts#renderConfig` 从 DB 重建 `config.json`：先备份 `config.json.bak`（**仅当 `.bak` 不存在时**，保住真原始），
  再 `config.json.tmp` → `fsync` → `rename` 原子替换。此步骤失败**会向调用方抛错**（不再静默吞掉，H5）；
  服务启动时若已有账号会再渲染一次自愈。
- 兼容：`src/config.ts` 只**新增导出** `resolveConfig(raw, alias)`，`loadConfig(alias)` 改为「读 json → `resolveConfig`」，**签名与既有行为不变**。

> AC-3 验收（`main.ts --verify-ac3`）：以 `config.json` 初始化后，DB 解析出的 `AppConfig` 与文件 `loadConfig()` **逐字段一致**
> （含 `paths.*`、`browser`、`model`、`notify`、`cover`），且回渲染无意外 diff。已验证通过（见 `check-report.md`）。

---

## 2. DDL（v1，唯一真相 = `src/console/db/schema.ts`）

- 迁移：`MIGRATIONS[]` 顺序前滚，`PRAGMA user_version` 记录版本（当前 = 1）；DDL 幂等（`IF NOT EXISTS`）。
- 表清单（18 张，另有索引与 `sqlite_sequence`）：
  - 身份鉴权：`users`、`login_sessions`、`login_attempts`、`account_grants`
  - 配置：`settings`、`accounts`、`account_email`
  - 凭据：`secrets`
  - 计划任务：`plans`、`jobs`、`job_logs`
  - 内容草稿：`articles`、`drafts`
  - 会话人在环：`chat_sessions`、`chat_messages`、`decisions`
  - 运维：`tunnels`、`audit`
- **与 v0 设计稿的差异（v1 实际已实现，以 schema.ts 为准）**：
  - **新增 `login_attempts(username, ip, ok, ts)`**（D4）：登录限流/锁定的事实来源（`sessions.ts#lockState/recordAttempt`）。
  - **`audit` 增列 `actor TEXT` 与 `ok INTEGER NOT NULL DEFAULT 1`**（D4）：失败登录（用户可能不存在）也有可读的 `actor`，且可区分成败。
  - `users.username` 为 `UNIQUE COLLATE NOCASE`（用户名不区分大小写）。
  - `accounts.cdp_port` / `enabled` 为**可空**，`UNIQUE(cdp_port)` 仅约束非空值（SQLite 语义）。
  - `login_sessions` 只存 `token_hash`（存 `sha256(token)`，**不存明文令牌**）。
- 索引（实际）：`idx_sessions_user`、`idx_sessions_exp`、`idx_attempts_user`、`idx_jobs_status`、
  `idx_job_logs_job`、`idx_articles_acc`、`idx_chat_messages_s`、`idx_decisions_status`、`idx_audit_ts`。

> `period_key` 形态：周 `2026-W42`（ISO 周）/ 月 `2026-10`；周条目 `items_json` **≤ 7 天**（C2 约束）。
> `jobs.kind`：`plan` | `generate` | `publish` | `regenerate`（见 `api.md` §2.3）。

---

## 3. 不变量（硬）

| # | 不变量 | 保障 |
|---|---|---|
| I1 | `accounts.alias` 唯一、`accounts.cdp_port` 唯一（非空时） | `UNIQUE` 约束 + API 409（含可用端口提示） |
| I2 | 每账号 `data_dir` 独立，形如 `data/<alias>/` | 新建时派生，不手填；删账号**只注销**，不删目录 |
| I3 | `jobs` 状态机单向：`queued→running→{succeeded,failed,canceled}` | `queue.ts` 认领/心跳/超时回收；非法迁移拒绝 |
| I4 | **每账号同时最多 1 个 `running` job**（`cdpPort`/profile 独占） | `worker.ts` 认领前按 `account_id` 加锁；全局并发上限另计 |
| I5 | 幂等：同账号 + 同日期已有 `succeeded` job 则跳过 | 双重去重（engine `state/published.json` + `jobs` 表） |
| I6 | `decisions` 状态机：`pending→{answered,cancelled,expired,lost}` | 应答/超时/进程失联各自落终态，**不留悬挂** |
| I7 | `secrets` 只存 `ciphertext`+`nonce`+`key_version`，**无明文列** | `crypto/secrets.ts`；读接口不回显 |
| I8 | `tunnels` 变更留链：新行 `replaced_by` 指旧行，旧行 `expired` | `tunnel/cloudflared.ts` |
| I9 | 账号热列（`cdp_port`/`enabled`/`display_name`…）由单一写路径从 entry **镜像**，仅用于约束/查询 | `db/dao/accounts.ts#mirror`；写入侧 `assertEntryTypes` 校验类型 |
| I10 | 非管理员不可见全局机密（`notify`/`proxy`/`piBin`/`bunBin`/`skillDir`） | `server.ts#accountDetail` 按 `asAdmin` 剔除 |

---

## 4. 迁移与回滚

- 版本号：`PRAGMA user_version`；`db/migrate.ts` 顺序脚本，启动时**前滚**，每步事务化。
- 失败处理：迁移失败 → **中止启动**并显式报错（不半应用）。
- 首次导入：`db/import-config.ts` 读现有 `config.json` → `settings`(global) + `accounts`（条目 verbatim），
  并写 `config.json.bak`（一次）。legacy 顶层 `account` 字段用于推断既有默认账号（默认 `"second"`，与引擎一致）。
- 回滚：恢复 `config.json.bak` + DB 快照（`VACUUM INTO`）；见 `implement.md` §3。
