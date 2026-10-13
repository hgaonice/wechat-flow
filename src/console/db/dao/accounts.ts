/**
 * Accounts DAO + owner grants.
 *
 * `overrides_json` is the *source of truth*: the account's explicit entry from
 * `config.json`, stored verbatim so DB-derived configs equal file-derived ones
 * (AC-3). The hot columns (`display_name`, `cdp_port`, …) are mirrors used only
 * for `UNIQUE` constraints and list queries; `saveAccount` is the single entry
 * point that keeps both in sync inside one transaction.
 */
import type { Database } from "bun:sqlite";
import { asObject, type JsonObject } from "../../types.ts";

export interface AccountRow {
  id: number;
  alias: string;
  display_name: string | null;
  author: string | null;
  theme: string | null;
  color: string | null;
  cdp_port: number | null;
  enabled: number | null;
  publish_method: string | null;
  data_dir: string | null;
  content_dir: string | null;
  prompts_dir: string | null;
  overrides_json: string;
  created_at: string;
  updated_at: string;
}

const COLUMNS = `id, alias, display_name, author, theme, color, cdp_port, enabled,
  publish_method, data_dir, content_dir, prompts_dir, overrides_json, created_at, updated_at`;

export function listAccountRows(db: Database): AccountRow[] {
  return db.query<AccountRow>(`SELECT ${COLUMNS} FROM accounts ORDER BY id`).all();
}

export function getAccountById(db: Database, id: number): AccountRow | undefined {
  return db.query<AccountRow>(`SELECT ${COLUMNS} FROM accounts WHERE id = ?`).get(id);
}

export function getAccountByAlias(db: Database, alias: string): AccountRow | undefined {
  return db.query<AccountRow>(`SELECT ${COLUMNS} FROM accounts WHERE alias = ?`).get(alias);
}

export function getAccountByCdpPort(db: Database, port: number): AccountRow | undefined {
  return db.query<AccountRow>(`SELECT ${COLUMNS} FROM accounts WHERE cdp_port = ?`).get(port);
}

/** Parse the explicit entry; defensive against hand-edited rows. */
export function parseOverrides(row: AccountRow): JsonObject {
  try {
    return asObject(JSON.parse(row.overrides_json));
  } catch {
    return {};
  }
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function numOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  // Legacy configs may carry numeric strings; mirror them so UNIQUE(cdp_port) still catches dupes.
  // (overrides_json stays verbatim, so AC-3 equivalence is unaffected.)
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}
function boolOrNull(v: unknown): number | null {
  return typeof v === "boolean" ? (v ? 1 : 0) : null;
}

/** Mirror the explicit entry into the constraint/query columns. */
function mirror(overrides: JsonObject) {
  return {
    display_name: strOrNull(overrides.displayName),
    author: strOrNull(overrides.author),
    theme: strOrNull(overrides.theme),
    color: strOrNull(overrides.color),
    cdp_port: numOrNull(overrides.cdpPort),
    enabled: boolOrNull(overrides.enabled),
    publish_method: strOrNull(overrides.publishMethod),
    data_dir: strOrNull(overrides.dataDir),
    content_dir: strOrNull(overrides.contentDir),
    prompts_dir: strOrNull(overrides.promptsDir),
  };
}

export function insertAccount(db: Database, alias: string, overrides: JsonObject): number {
  const m = mirror(overrides);
  const info = db.run(
    `INSERT INTO accounts(alias, display_name, author, theme, color, cdp_port, enabled,
       publish_method, data_dir, content_dir, prompts_dir, overrides_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    alias,
    m.display_name,
    m.author,
    m.theme,
    m.color,
    m.cdp_port,
    m.enabled,
    m.publish_method,
    m.data_dir,
    m.content_dir,
    m.prompts_dir,
    JSON.stringify(overrides),
  );
  return Number(info.lastInsertRowid);
}

/** Update alias + overrides; hot columns are re-derived. Single write path. */
export function updateAccount(db: Database, id: number, alias: string, overrides: JsonObject): void {
  const m = mirror(overrides);
  db.run(
    `UPDATE accounts SET alias = ?, display_name = ?, author = ?, theme = ?, color = ?,
       cdp_port = ?, enabled = ?, publish_method = ?, data_dir = ?, content_dir = ?,
       prompts_dir = ?, overrides_json = ?, updated_at = datetime('now')
     WHERE id = ?`,
    alias,
    m.display_name,
    m.author,
    m.theme,
    m.color,
    m.cdp_port,
    m.enabled,
    m.publish_method,
    m.data_dir,
    m.content_dir,
    m.prompts_dir,
    JSON.stringify(overrides),
    id,
  );
}

/** Remove the account row (data dir on disk is deliberately left alone). */
export function deleteAccount(db: Database, id: number): void {
  db.run("DELETE FROM accounts WHERE id = ?", id);
}

/** CDP ports already taken, for conflict hints. */
export function usedCdpPorts(db: Database, excludeId?: number): number[] {
  const rows = db
    .query<{ cdp_port: number }>("SELECT cdp_port FROM accounts WHERE cdp_port IS NOT NULL AND id != ?")
    .all(excludeId ?? -1);
  return rows.map((r) => r.cdp_port);
}

/** First N free CDP ports from `base`, skipping the ones already registered. */
export function suggestCdpPorts(db: Database, base = 9222, count = 5): number[] {
  const used = new Set(usedCdpPorts(db));
  const out: number[] = [];
  for (let p = base; out.length < count && p < base + 500; p++) {
    if (!used.has(p)) out.push(p);
  }
  return out;
}

// ── owner grants ────────────────────────────────────────────────────────────

export function accountIdsForUser(db: Database, userId: number): number[] {
  const rows = db.query<{ account_id: number }>("SELECT account_id FROM account_grants WHERE user_id = ?").all(userId);
  return rows.map((r) => r.account_id);
}

export function grantAccount(db: Database, userId: number, accountId: number): void {
  db.run(
    "INSERT OR IGNORE INTO account_grants(user_id, account_id) VALUES (?, ?)",
    userId,
    accountId,
  );
}

export function revokeGrant(db: Database, userId: number, accountId: number): void {
  db.run("DELETE FROM account_grants WHERE user_id = ? AND account_id = ?", userId, accountId);
}

export function setGrants(db: Database, userId: number, accountIds: number[]): void {
  const run = db.transaction(() => {
    db.run("DELETE FROM account_grants WHERE user_id = ?", userId);
    for (const id of accountIds) grantAccount(db, userId, id);
  });
  run();
}

export function grantRowsForUser(db: Database, userId: number): { account_id: number; alias: string }[] {
  return db
    .query<{ account_id: number; alias: string }>(
      `SELECT g.account_id, a.alias FROM account_grants g JOIN accounts a ON a.id = g.account_id
       WHERE g.user_id = ? ORDER BY a.alias`,
    )
    .all(userId);
}
