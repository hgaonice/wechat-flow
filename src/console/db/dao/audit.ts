/** Append-only audit trail (logins, account/config changes, denied access). */
import type { Database } from "bun:sqlite";
import type { Json } from "../../types.ts";

export interface AuditEntry {
  userId?: number | null;
  /** Username at the time of the action (works even for non-existent logins). */
  actor?: string | null;
  action: string;
  target?: string | null;
  detail?: Json;
  ip?: string | null;
  ua?: string | null;
  ok?: boolean;
}

export function recordAudit(db: Database, e: AuditEntry): void {
  db.run(
    `INSERT INTO audit(user_id, actor, action, target, detail_json, ip, ua, ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    e.userId ?? null,
    e.actor ?? null,
    e.action,
    e.target ?? null,
    e.detail === undefined ? null : JSON.stringify(e.detail),
    e.ip ?? null,
    e.ua ?? null,
    e.ok === false ? 0 : 1,
  );
}

export interface AuditRow {
  id: number;
  user_id: number | null;
  actor: string | null;
  action: string;
  target: string | null;
  detail_json: string | null;
  ip: string | null;
  ua: string | null;
  ts: string;
  ok: number;
}

export function recentAudit(db: Database, limit = 50): AuditRow[] {
  return db
    .query<AuditRow>(`SELECT * FROM audit ORDER BY id DESC LIMIT ?`)
    .all(Math.max(1, Math.min(500, limit)));
}
