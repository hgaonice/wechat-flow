/**
 * v1 schema baseline for the console DB.
 *
 * Source of truth: `.trellis/spec/console/data-model.md` §2. C1 ships the
 * complete baseline so later milestones (C2–C5) only add migrations, never
 * re-create the world. All DDL is idempotent (`IF NOT EXISTS`) and applied
 * through `migrate.ts` inside a transaction, gated by `PRAGMA user_version`.
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const V1 = `
-- ── 身份与鉴权 ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash  TEXT    NOT NULL,
  role       TEXT    NOT NULL DEFAULT 'owner' CHECK (role IN ('admin','owner')),
  disabled   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS login_sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT    NOT NULL UNIQUE,
  csrf_token   TEXT    NOT NULL,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT    NOT NULL,
  last_seen_at TEXT    NOT NULL DEFAULT (datetime('now')),
  ip           TEXT,
  ua           TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON login_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON login_sessions(expires_at);

-- 登录限流：连续失败锁定（见 sessions.ts / rate-limit）
CREATE TABLE IF NOT EXISTS login_attempts (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT    NOT NULL,
  ip       TEXT,
  ok       INTEGER NOT NULL,
  ts       TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attempts_user ON login_attempts(username, ts);

-- ── 配置（控制面真相源） ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS accounts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  alias          TEXT    NOT NULL UNIQUE,
  display_name   TEXT,
  author         TEXT,
  theme          TEXT,
  color          TEXT,
  cdp_port       INTEGER UNIQUE,
  enabled        INTEGER,
  publish_method TEXT,
  data_dir       TEXT,
  content_dir    TEXT,
  prompts_dir    TEXT,
  overrides_json TEXT    NOT NULL DEFAULT '{}',
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS account_grants (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, account_id)
);

CREATE TABLE IF NOT EXISTS account_email (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id     INTEGER NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  to_json        TEXT,
  cc_json        TEXT,
  subject_prefix TEXT
);

-- ── 凭据（加密；永不存明文） ──────────────────────────────────
CREATE TABLE IF NOT EXISTS secrets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  kind        TEXT    NOT NULL,
  ciphertext  BLOB    NOT NULL,
  nonce       BLOB    NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (account_id, kind)
);

-- ── 计划与任务 ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS plans (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  period_type TEXT    NOT NULL CHECK (period_type IN ('week','month')),
  period_key  TEXT    NOT NULL,
  items_json  TEXT    NOT NULL DEFAULT '[]',
  status      TEXT    NOT NULL DEFAULT 'draft',
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (account_id, period_type, period_key)
);

CREATE TABLE IF NOT EXISTS jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind         TEXT    NOT NULL,
  payload_json TEXT    NOT NULL DEFAULT '{}',
  status       TEXT    NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued','running','succeeded','failed','canceled')),
  progress     INTEGER NOT NULL DEFAULT 0,
  message      TEXT,
  error        TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  queued_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  started_at   TEXT,
  ended_at     TEXT,
  pid          INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, queued_at);

CREATE TABLE IF NOT EXISTS job_logs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id  INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  ts      TEXT    NOT NULL DEFAULT (datetime('now')),
  level   TEXT    NOT NULL DEFAULT 'info',
  message TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_job_logs_job ON job_logs(job_id, ts);

-- ── 内容与草稿 ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS articles (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  plan_id    INTEGER REFERENCES plans(id) ON DELETE SET NULL,
  date       TEXT    NOT NULL,
  title      TEXT,
  slug       TEXT,
  file_path  TEXT,
  status     TEXT    NOT NULL DEFAULT 'draft',
  version    INTEGER NOT NULL DEFAULT 1,
  parent_id  INTEGER REFERENCES articles(id) ON DELETE SET NULL,
  feedback   TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_articles_acc ON articles(account_id, date, version);

CREATE TABLE IF NOT EXISTS drafts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  article_id    INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  wechat_title  TEXT,
  push_at       TEXT,
  verified      INTEGER NOT NULL DEFAULT 0,
  verify_detail TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ── 会话与人在环 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  job_id        INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  pi_session_id TEXT,
  title         TEXT,
  status        TEXT    NOT NULL DEFAULT 'active',
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role            TEXT    NOT NULL,
  content         TEXT    NOT NULL,
  meta_json       TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_s ON chat_messages(chat_session_id, id);

CREATE TABLE IF NOT EXISTS decisions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  request_id      TEXT    NOT NULL UNIQUE,
  method          TEXT    NOT NULL CHECK (method IN ('select','confirm','input','editor')),
  title           TEXT,
  message         TEXT,
  options_json    TEXT,
  timeout_ms      INTEGER,
  status          TEXT    NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','answered','cancelled','expired','lost')),
  response_json   TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  answered_at     TEXT,
  answered_by     INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_status ON decisions(status, created_at);

-- ── 运维 ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tunnels (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT    NOT NULL CHECK (kind IN ('quick','named')),
  url             TEXT,
  hostname        TEXT,
  pid             INTEGER,
  status          TEXT    NOT NULL DEFAULT 'up' CHECK (status IN ('up','down','expired','error')),
  detail          TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at      TEXT,
  last_checked_at TEXT,
  replaced_by     INTEGER REFERENCES tunnels(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor       TEXT,
  action      TEXT    NOT NULL,
  target      TEXT,
  detail_json TEXT,
  ip          TEXT,
  ua          TEXT,
  ts          TEXT    NOT NULL DEFAULT (datetime('now')),
  ok          INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts);
`;

export const MIGRATIONS: Migration[] = [{ version: 1, name: "baseline", sql: V1 }];
