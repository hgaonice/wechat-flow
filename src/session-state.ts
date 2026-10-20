import fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";

/**
 * Local, zero-request session evidence: read the MP login cookies straight out
 * of the Chrome profile.
 *
 * Why this exists (C1 / design §C-1): a DOM-only probe mis-reported a dead
 * session (2026-10-20 07:02) and the QR/失败邮件 chain fired for nothing. The
 * cookie database is an *independent* piece of evidence — the MP tickets
 * (`slave_sid` / `data_ticket`) carry a hard 96h expiry that WeChat only slides
 * on authenticated activity, so its expiry time is the cheapest truth we have.
 *
 * Hard rules:
 *   - open the SQLite file READ-ONLY (Chrome owns it and may be writing);
 *   - any failure (missing file / locked / unknown schema) returns
 *     `{ok:false, reason}` and NEVER throws — a failed read must degrade the
 *     verdict to `unknown`, never to `invalid` (that would send a QR again);
 *   - `expires_utc === 0` means a session cookie → expiry "unknown", not expired.
 */

/** Chrome's time base is microseconds since 1601-01-01, not the Unix epoch. */
const CHROME_EPOCH_OFFSET_SEC = 11_644_473_600;

/** MP login cookie names we care about (host is `*.weixin.qq.com`). */
export const SESSION_COOKIE_NAMES = ["slave_sid", "data_ticket", "bizuin", "wxuin"] as const;

/** Chrome `expires_utc` → Unix seconds. `undefined` = unknown (session cookie). */
export function chromeTimeToUnix(expiresUtc: number | null | undefined): number | undefined {
  if (typeof expiresUtc !== "number" || !Number.isFinite(expiresUtc) || expiresUtc <= 0) return undefined;
  return Math.round(expiresUtc / 1_000_000 - CHROME_EPOCH_OFFSET_SEC);
}

export interface CookieFacts {
  /** The database was readable. `false` ⇒ no cookie evidence (verdict must stay unknown). */
  ok: boolean;
  /** Unix seconds; `undefined` = unknown (session cookie, or read failure). */
  slaveSidExpiresAt?: number;
  dataTicketExpiresAt?: number;
  /** `slave_sid` row exists. `false` while `ok === true` = the login cookies are gone. */
  slaveSidPresent?: boolean;
  dataTicketPresent?: boolean;
  /** Why the read failed (never contains cookie values — only the reason). */
  reason?: string;
  /** Absolute path of the Cookies file that was inspected. */
  cookiesFile?: string;
}

export function cookiesDbPath(profileDir: string): string {
  return path.join(profileDir, "Default", "Cookies");
}

interface CookieRow {
  name: string;
  expires_utc: number | null;
}

/**
 * Read the MP ticket expiry times from `<profileDir>/Default/Cookies`.
 *
 * Uses `busy_timeout=200` so a Chrome write lock degrades quickly instead of
 * hanging a publish job, and never creates the file (`readonly: true`).
 */
export function readCookieFacts(
  profileDir: string,
  opts: { busyTimeoutMs?: number } = {},
): CookieFacts {
  const cookiesFile = cookiesDbPath(profileDir);
  if (!fs.existsSync(cookiesFile)) {
    return { ok: false, reason: `cookies file not found: ${cookiesFile}`, cookiesFile };
  }
  let db: Database | undefined;
  try {
    db = new Database(cookiesFile, { readonly: true });
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(opts.busyTimeoutMs ?? 200))}`);
    const rows = db
      .query(
        `SELECT name, expires_utc FROM cookies
          WHERE host_key LIKE '%weixin%' AND name IN ('slave_sid','data_ticket','bizuin','wxuin')`,
      )
      .all() as CookieRow[];
    // The same cookie name can exist for several weixin hosts; the latest
    // expiry is the one the browser will actually present.
    const latest = new Map<string, number | undefined>();
    for (const row of rows) {
      if (!row?.name) continue;
      const unix = chromeTimeToUnix(row.expires_utc);
      if (!latest.has(row.name)) {
        latest.set(row.name, unix);
        continue;
      }
      const prev = latest.get(row.name);
      if (unix !== undefined && (prev === undefined || unix > prev)) latest.set(row.name, unix);
    }
    const facts: CookieFacts = {
      ok: true,
      cookiesFile,
      slaveSidPresent: latest.has("slave_sid"),
      dataTicketPresent: latest.has("data_ticket"),
    };
    const sid = latest.get("slave_sid");
    if (sid !== undefined) facts.slaveSidExpiresAt = sid;
    const ticket = latest.get("data_ticket");
    if (ticket !== undefined) facts.dataTicketExpiresAt = ticket;
    return facts;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `cookies unreadable: ${msg}`, cookiesFile };
  } finally {
    try {
      db?.close();
    } catch {
      /* closing a read-only handle must never mask the result */
    }
  }
}

/** Human/one-line rendering used in logs (`cookie:ok(in 62.4h)`). */
export function describeCookieFacts(facts: CookieFacts, nowMs = Date.now()): string {
  if (!facts.ok) return `unreadable(${facts.reason ?? "unknown"})`;
  if (facts.slaveSidPresent === false) return "missing";
  if (facts.slaveSidExpiresAt === undefined) return "session-cookie";
  const hours = (facts.slaveSidExpiresAt - nowMs / 1000) / 3600;
  if (hours <= 0) return `expired(${Math.abs(hours).toFixed(1)}h ago)`;
  return `ok(in ${hours.toFixed(1)}h)`;
}
