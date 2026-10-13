/**
 * Cookie sessions + login throttling.
 *
 * The raw token is only ever in the cookie; the DB stores its SHA-256 so a DB
 * leak does not yield usable sessions. CSRF is a per-session token compared in
 * constant time on every mutating request.
 */
import type { Database } from "bun:sqlite";
import { randomToken, safeEqual, sha256Hex } from "../crypto/secrets.ts";
import { getUserById, type UserRow } from "./users.ts";
import { accountIdsForUser } from "../db/dao/accounts.ts";

export const SESSION_COOKIE = "wfc_sid";
export const DEFAULT_TTL_HOURS = 12;
export const MAX_LOGIN_ATTEMPTS = 5;
export const ATTEMPT_WINDOW_MIN = 15;

interface SessionRow {
  id: number;
  user_id: number;
  token_hash: string;
  csrf_token: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
  ip: string | null;
  ua: string | null;
}

export interface SessionContext {
  user: UserRow;
  sessionId: number;
  csrfToken: string;
  /** `"all"` for admins, otherwise the explicit account ids this owner may touch. */
  grantedAccounts: number[] | "all";
}

export function ttlHours(): number {
  const raw = Number(process.env.CONSOLE_SESSION_TTL_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_HOURS;
}

export function createSession(
  db: Database,
  userId: number,
  ip?: string | null,
  ua?: string | null,
): { token: string; csrfToken: string; expiresAt: string } {
  const token = randomToken();
  const csrfToken = randomToken(24);
  const modifier = `+${ttlHours()} hours`;
  db.run(
    `INSERT INTO login_sessions(user_id, token_hash, csrf_token, ip, ua, expires_at)
     VALUES (?, ?, ?, ?, ?, datetime('now', ?))`,
    userId,
    sha256Hex(token),
    csrfToken,
    ip ?? null,
    ua ?? null,
    modifier,
  );
  const row = db
    .query<{ expires_at: string }>("SELECT expires_at FROM login_sessions WHERE token_hash = ?")
    .get(sha256Hex(token));
  return { token, csrfToken, expiresAt: row?.expires_at ?? "" };
}

export function lookupSession(db: Database, token: string | null | undefined): SessionContext | null {
  if (!token) return null;
  const row = db
    .query<SessionRow>(
      "SELECT * FROM login_sessions WHERE token_hash = ? AND expires_at > datetime('now')",
    )
    .get(sha256Hex(token));
  if (!row) return null;
  const user = getUserById(db, row.user_id);
  if (!user || user.disabled !== 0) return null;
  return {
    user,
    sessionId: row.id,
    csrfToken: row.csrf_token,
    grantedAccounts: user.role === "admin" ? "all" : accountIdsForUser(db, user.id),
  };
}

export function touchSession(db: Database, sessionId: number): void {
  db.run("UPDATE login_sessions SET last_seen_at = datetime('now') WHERE id = ?", sessionId);
}

export function destroySession(db: Database, token: string): void {
  db.run("DELETE FROM login_sessions WHERE token_hash = ?", sha256Hex(token));
}

/** Revoke a user's sessions (password change / disable); keeps `exceptId` if given. */
export function destroyUserSessions(db: Database, userId: number, exceptId?: number): void {
  db.run("DELETE FROM login_sessions WHERE user_id = ? AND id != ?", userId, exceptId ?? -1);
}

export function purgeExpiredSessions(db: Database): number {
  const info = db.run("DELETE FROM login_sessions WHERE expires_at <= datetime('now')");
  return info.changes;
}

// ── login throttling ────────────────────────────────────────────────────────

export function recordAttempt(db: Database, username: string, ip: string | null, ok: boolean): void {
  db.run("INSERT INTO login_attempts(username, ip, ok) VALUES (?, ?, ?)", username, ip, ok ? 1 : 0);
}

export function failedAttempts(db: Database, username: string): number {
  return (
    db
      .query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM login_attempts
         WHERE username = ? AND ok = 0 AND ts > datetime('now', ?)`,
      )
      .get(username, `-${ATTEMPT_WINDOW_MIN} minutes`)?.n ?? 0
  );
}

export interface LockState {
  locked: boolean;
  retryAfterSec: number;
}

export function lockState(db: Database, username: string): LockState {
  const n = failedAttempts(db, username);
  if (n < MAX_LOGIN_ATTEMPTS) return { locked: false, retryAfterSec: 0 };
  const oldest = db
    .query<{ ts: string }>(
      `SELECT ts FROM login_attempts WHERE username = ? AND ok = 0 ORDER BY ts DESC LIMIT 1`,
    )
    .get(username);
  let retryAfterSec = ATTEMPT_WINDOW_MIN * 60;
  if (oldest?.ts) {
    const unlockAt = new Date(oldest.ts.replace(" ", "T") + "Z").getTime() + ATTEMPT_WINDOW_MIN * 60_000;
    retryAfterSec = Math.max(0, Math.ceil((unlockAt - Date.now()) / 1000));
  }
  return { locked: true, retryAfterSec };
}

/** On successful login, forget this user's failures. */
export function clearAttempts(db: Database, username: string): void {
  db.run("DELETE FROM login_attempts WHERE username = ? AND ok = 0", username);
}

// ── cookies ─────────────────────────────────────────────────────────────────

export function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return part.slice(eq + 1).trim(); // malformed percent-encoding → ignore, never throw
      }
    }
  }
  return null;
}

export function sessionCookie(token: string, maxAgeSec: number, secure: boolean): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function clearSessionCookie(secure: boolean): string {
  return [`${SESSION_COOKIE}=`, "HttpOnly", "Path=/", "SameSite=Lax", "Max-Age=0", secure ? "Secure" : ""]
    .filter(Boolean)
    .join("; ");
}

export function csrfEqual(expected: string, provided: string | null): boolean {
  if (!provided) return false;
  return safeEqual(expected, provided);
}
