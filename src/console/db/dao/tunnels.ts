/**
 * `tunnels` DAO — the control-plane tunnel ledger (C5).
 *
 * Invariant I24: **at most one row may be `status='up'` at any moment.**
 * `openTunnel` enforces it inside a single immediate transaction: it inserts
 * the new `up` row and retires the previous live row(s) in the same commit, so
 * a crash can never leave two `up` rows or a new row without its predecessor
 * linked.
 *
 * `notified_at` / `notify_attempts` (added by migration v3) carry the C5
 * notify bookkeeping: dedupe per row (I26) and a capped retry counter (I26).
 */
import type { Database } from "bun:sqlite";

export type TunnelStatus = "up" | "down" | "expired" | "error";
export type TunnelKind = "quick" | "named";

export interface TunnelRow {
  id: number;
  kind: string;
  url: string | null;
  hostname: string | null;
  pid: number | null;
  status: TunnelStatus;
  detail: string | null;
  created_at: string;
  expires_at: string | null;
  last_checked_at: string | null;
  replaced_by: number | null;
  notified_at: string | null;
  notify_attempts: number;
}

const COLUMNS =
  "id, kind, url, hostname, pid, status, detail, created_at, expires_at, " +
  "last_checked_at, replaced_by, notified_at, notify_attempts";

export function getTunnel(db: Database, id: number): TunnelRow | null {
  const row = db.query<TunnelRow>(`SELECT ${COLUMNS} FROM tunnels WHERE id = ?`).get(id);
  return row ?? null;
}

/** The single live row, or `null` when the tunnel is down/not started. */
export function getCurrentTunnel(db: Database): TunnelRow | null {
  const row = db
    .query<TunnelRow>(`SELECT ${COLUMNS} FROM tunnels WHERE status = 'up' ORDER BY id DESC LIMIT 1`)
    .get();
  return row ?? null;
}

export function listTunnels(db: Database, limit = 20): TunnelRow[] {
  return db.query<TunnelRow>(`SELECT ${COLUMNS} FROM tunnels ORDER BY id DESC LIMIT ?`).all(limit);
}

export interface OpenTunnelInput {
  kind: TunnelKind;
  url: string;
  hostname: string;
  pid: number | null;
}

/**
 * Insert a new `up` row and retire the previous live row(s) atomically (I24).
 * Any prior `up`/`down` row (e.g. the one `stop()` just marked down during a
 * restart) becomes `expired` with `replaced_by` pointing at the new row, so the
 * address-change chain stays walkable.
 */
export function openTunnel(db: Database, input: OpenTunnelInput): TunnelRow {
  let newId = 0;
  const tx = db.transaction(() => {
    const inserted = db.run(
      `INSERT INTO tunnels(kind, url, hostname, pid, status, last_checked_at)
       VALUES (?, ?, ?, ?, 'up', datetime('now'))`,
      input.kind,
      input.url,
      input.hostname,
      input.pid,
    );
    newId = Number(inserted.lastInsertRowid);
    db.run(
      `UPDATE tunnels
          SET status = 'expired', replaced_by = ?, expires_at = datetime('now')
        WHERE id <> ? AND status IN ('up', 'down')`,
      newId,
      newId,
    );
  });
  tx();
  return getTunnel(db, newId)!;
}

export function setTunnelStatus(
  db: Database,
  id: number,
  status: TunnelStatus,
  detail: string | null = null,
): void {
  db.run(
    `UPDATE tunnels
        SET status = ?, detail = ?, last_checked_at = datetime('now')
      WHERE id = ?`,
    status,
    detail,
    id,
  );
}

export interface HeardPatch {
  url?: string;
  pid?: number | null;
  status?: TunnelStatus;
  detail?: string | null;
}

/** Touch `last_checked_at` (health tick / same-URL re-adoption), optionally patching fields. */
export function markHeard(db: Database, id: number, patch: HeardPatch = {}): void {
  const sets: string[] = ["last_checked_at = datetime('now')"];
  const params: (string | number | null)[] = [];
  if (patch.url !== undefined) {
    sets.push("url = ?");
    params.push(patch.url);
  }
  if (patch.pid !== undefined) {
    sets.push("pid = ?");
    params.push(patch.pid);
  }
  if (patch.status !== undefined) {
    sets.push("status = ?");
    params.push(patch.status);
  }
  if (patch.detail !== undefined) {
    sets.push("detail = ?");
    params.push(patch.detail);
  }
  params.push(id);
  db.run(`UPDATE tunnels SET ${sets.join(", ")} WHERE id = ?`, ...params);
}

/** Success receipt for the per-row mail dedupe key (I26). */
export function markNotified(db: Database, id: number): void {
  db.run("UPDATE tunnels SET notified_at = datetime('now') WHERE id = ?", id);
}

/** Clear the dedupe key so an explicit admin re-notify can run. */
export function clearNotified(db: Database, id: number): void {
  db.run("UPDATE tunnels SET notified_at = NULL WHERE id = ?", id);
}

/** @returns the new `notify_attempts` value after the bump. */
export function bumpNotifyAttempts(db: Database, id: number): number {
  db.run("UPDATE tunnels SET notify_attempts = notify_attempts + 1 WHERE id = ?", id);
  const row = db.query<{ n: number }>("SELECT notify_attempts AS n FROM tunnels WHERE id = ?").get(id);
  return row?.n ?? 0;
}
