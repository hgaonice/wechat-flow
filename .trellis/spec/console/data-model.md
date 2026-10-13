# Data Model（SQLite / `bun:sqlite`）

> 状态：**v0 契约（先行）**，源 `design.md` §3/§4/§6。C1 落地后以实际 `db/schema.ts` 校准为 v1。
> 存储：`console/console.db`（不入 git）；`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;`

---

## 1. 配置真相源与派生关系（AC-3 的关键）

```
内置默认(defaults) ⊕ settings(key='global') ⊕ account.overrides  → RawConfig → AppConfig
```

- **真相源 = DB**（`settings` + `accounts.overrides_json`）；`config.json` 是**派生产物**。
- 深合并规则（必须单元可测）：
  - 对象：递归深合并；
  - 数组：**整体替换**（不逐项 merge）；
  - `undefined`：跳过（保留下层值）；
  - `null`：**显式清空**该键。
- 回渲染：`db/render-config.ts` 把解析结果**原子写**回 `config.json`（先备份 `config.json.bak`）。
- 兼容：`src/config.ts` 只**新增导出** `resolveConfig(raw, alias)`，`loadConfig()` 改为「读 json → `resolveConfig`」，**签名与既有行为不变**。
- 字段来源判定：路径存在于 `accounts.overrides_json` → `overridden`，否则 `inherited`；「恢复继承」= 删除该路径。

> AC-3 验收：用现有 `config.json` 初始化后，DB 解析出的 `AppConfig` 与原 `loadConfig()` **逐字段一致**（含 `paths.*`、`browser`、`model`、`notify`、`cover`）；回渲染后 diff 无非预期变化。

---

## 2. DDL（v0 契约）

```sql
PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;

-- 身份与鉴权
users(id PK, username UNIQUE, pass_hash, role TEXT CHECK(role IN ('admin','owner')),
      disabled INT DEFAULT 0, created_at, updated_at)
login_sessions(id PK, user_id FK, token_hash UNIQUE, csrf_token,
               created_at, expires_at, last_seen_at, ip, ua)
account_grants(id PK, user_id FK, account_id FK, UNIQUE(user_id,account_id))

-- 配置（控制面真相源）
settings(key PK, value_json, updated_at)
accounts(id PK, alias UNIQUE, display_name, author, theme, color, cdp_port INT UNIQUE,
         enabled INT, publish_method, data_dir, content_dir, prompts_dir,
         overrides_json, created_at, updated_at)
account_email(id PK, account_id FK UNIQUE, to_json, cc_json, subject_prefix)

-- 凭据（加密；永不存明文）
secrets(id PK, account_id FK NULL, kind TEXT,
        ciphertext BLOB, nonce BLOB, key_version INT, created_at, updated_at,
        UNIQUE(account_id, kind))

-- 计划与任务
plans(id PK, account_id FK, period_type CHECK(period_type IN ('week','month')),
      period_key TEXT, items_json, status TEXT, created_by FK, created_at, updated_at,
      UNIQUE(account_id,period_type,period_key))
jobs(id PK, account_id FK, kind TEXT, payload_json,
     status TEXT CHECK(status IN ('queued','running','succeeded','failed','canceled')),
     progress INT, message, error, attempts INT, created_by FK,
     queued_at, started_at, ended_at, pid)
job_logs(id PK, job_id FK, ts, level, message)

-- 内容与草稿
articles(id PK, account_id FK, plan_id FK NULL, date, title, slug, file_path,
         status TEXT, version INT, parent_id FK NULL, feedback TEXT, created_at)
drafts(id PK, account_id FK, article_id FK, wechat_title, push_at, verified INT,
       verify_detail, created_at)

-- 会话与人在环
chat_sessions(id PK, account_id FK, job_id FK NULL, pi_session_id, title, status,
              created_by FK, created_at, updated_at)
chat_messages(id PK, chat_session_id FK, role, content, meta_json, created_at)
decisions(id PK, chat_session_id FK, request_id UNIQUE,
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

> `period_key` 形态：周 `2026-W42`（ISO 周）/ 月 `2026-10`；周条目 `items_json` **≤ 7 天**。
> `kind`：`plan` | `generate` | `publish` | `regenerate`（见 `api.md` §2.3）。

---

## 3. 不变量（硬）

| # | 不变量 | 保障 |
|---|---|---|
| I1 | `accounts.alias` 唯一、`accounts.cdp_port` 唯一 | `UNIQUE` 约束 + API 409（含可用端口提示） |
| I2 | 每账号 `data_dir` 独立，形如 `data/<alias>/` | 新建时派生，不手填；不删账号目录 |
| I3 | `jobs` 状态机单向：`queued→running→{succeeded,failed,canceled}` | `queue.ts` 认领/心跳/超时回收；非法迁移拒绝 |
| I4 | **每账号同时最多 1 个 `running` job**（`cdpPort`/profile 独占） | `worker.ts` 认领前按 `account_id` 加锁；全局并发上限另计 |
| I5 | 幂等：同账号 + 同日期已有 `succeeded` job 则跳过 | 双重去重（engine `state/published.json` + `jobs` 表） |
| I6 | `decisions` 状态机：`pending→{answered,cancelled,expired,lost}` | 应答/超时/进程失联各自落终态，**不留悬挂** |
| I7 | `secrets` 只存 `ciphertext`+`nonce`+`key_version`，**无明文列** | `crypto/secrets.ts`；读接口不回显 |
| I8 | `tunnels` 变更留链：新行 `replaced_by` 指旧行，旧行 `expired` | `tunnel/cloudflared.ts` |

---

## 4. 迁移

- 版本号：`PRAGMA user_version`；`db/migrate.ts` 顺序脚本，启动时**前滚**。
- 失败处理：迁移失败 → **中止启动**并显式报错（不半应用）；`migrate.ts` 逐步事务化。
- 首次导入：`db/import-config.ts` 读现有 `config.json` → `settings` + `accounts`（一次性，含 `.bak`）。
- 回滚：恢复 `config.json.bak` + DB 快照（`VACUUM INTO`）；见 `implement.md` §3。
