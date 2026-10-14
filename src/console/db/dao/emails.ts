/**
 * `account_email` DAO — per-account recipients for control-plane mail (C5).
 *
 * One row per account (`UNIQUE(account_id)`), so writes are an upsert. The
 * lists are stored as JSON text to keep the baseline schema untouched (C5 is
 * pure-additive and ships no new table). `subject_prefix` is optional and
 * overrides the global `notify.email.subjectPrefix` for this account only.
 */
import type { Database } from "bun:sqlite";

export interface EmailRow {
  id: number;
  account_id: number;
  to_json: string | null;
  cc_json: string | null;
  subject_prefix: string | null;
}

export interface EmailInput {
  to: string[];
  cc: string[];
  subjectPrefix?: string | null;
}

const COLUMNS = "id, account_id, to_json, cc_json, subject_prefix";

/** Parse a stored JSON address list defensively (never throws). */
export function parseEmailList(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const value = JSON.parse(json) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  } catch {
    return [];
  }
}

export function getEmail(db: Database, accountId: number): EmailRow | null {
  const row = db
    .query<EmailRow>(`SELECT ${COLUMNS} FROM account_email WHERE account_id = ?`)
    .get(accountId);
  return row ?? null;
}

export function upsertEmail(db: Database, accountId: number, input: EmailInput): EmailRow {
  db.run(
    `INSERT INTO account_email(account_id, to_json, cc_json, subject_prefix)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET
       to_json        = excluded.to_json,
       cc_json        = excluded.cc_json,
       subject_prefix = excluded.subject_prefix`,
    accountId,
    JSON.stringify(input.to),
    JSON.stringify(input.cc),
    input.subjectPrefix ?? null,
  );
  return getEmail(db, accountId)!;
}

/** @returns number of deleted rows (0 when the account had no email row). */
export function deleteEmail(db: Database, accountId: number): number {
  return db.run("DELETE FROM account_email WHERE account_id = ?", accountId).changes;
}
