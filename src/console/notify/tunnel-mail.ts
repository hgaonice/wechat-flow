/**
 * C5 tunnel-change mail (design §5).
 *
 * On every *new* tunnel URL (`tunnels.id`) the supervisor calls
 * `notifyTunnelChange`, which sends **one mail per enabled account** whose
 * `account_email` row carries recipients, plus optional admin copies:
 *
 *   recipients(account) = account_email.to ∪ account_email.cc
 *                         ∪ (adminCopy ? global notify.email.to : ∅)
 *
 * The body carries the server coordinates, the tunnel URL and *that account's*
 * decrypted `wechat_login` credential so the operator can log in. The engine's
 * `sendMail` is reused unchanged (D-C5-2); only the `EmailConfig.to` is
 * overridden per account.
 *
 * Retry bookkeeping (I26): a success stamps `tunnels.notified_at` and every
 * later call for the same row is skipped; failures bump `notify_attempts` and,
 * once the cap is reached, surface as `status='error'` on the row instead of
 * looping forever.
 *
 * `send` is injectable so tests never touch SMTP.
 */
import os from "node:os";
import type { Database } from "bun:sqlite";
import { decryptSecret } from "../crypto/secrets.ts";
import { listAccountRows, type AccountRow } from "../db/dao/accounts.ts";
import { getEmail, parseEmailList } from "../db/dao/emails.ts";
import { getSecretCipher } from "../db/dao/secrets.ts";
import { getGlobalRaw } from "../db/dao/settings.ts";
import {
  bumpNotifyAttempts,
  getTunnel,
  markNotified,
  setTunnelStatus,
  type TunnelRow,
} from "../db/dao/tunnels.ts";
import { recordAudit } from "../db/dao/audit.ts";
import { sendMail, type EmailConfig } from "../../mailer.ts";
import { asObject, isPlainObject } from "../types.ts";

/** Injecting a fake `sendMail` is the only seam tests need. */
export type SendFn = typeof sendMail;

export interface NotifyOpts {
  send?: SendFn;
  maxAttempts?: number;
  adminCopy?: boolean;
  log?: (msg: string) => void;
}

export interface NotifyResult {
  sent: boolean;
  /** `already-notified` | `no-recipients` when nothing was attempted. */
  skipped?: string;
  attempts: number;
  error?: string;
  recipients?: number;
}

const DEFAULT_SKILL_DIR = "/root/.claude/skills/email-sender";
const DEFAULT_PYTHON = "python3";

/** First non-internal IPv4 address, for the "内网 IP" line (never the CDP port). */
export function internalIpv4(): string {
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === "IPv4" && !info.internal) return info.address;
    }
  }
  return "127.0.0.1";
}

/** Console HTTP port (`CONSOLE_PORT`, default 8787) — the tunnel target. */
export function consolePort(): number {
  const raw = Number(process.env.CONSOLE_PORT ?? 8787);
  return Number.isFinite(raw) ? raw : 8787;
}

function uniq(list: string[]): string[] {
  const out: string[] = [];
  for (const item of list) if (!out.includes(item)) out.push(item);
  return out;
}

function globalEmailRaw(db: Database): ReturnType<typeof asObject> {
  return asObject(asObject(getGlobalRaw(db).notify).email);
}

/**
 * Build the engine `EmailConfig` from the global `settings` blob, overriding
 * `to` (and optionally `subjectPrefix`) per call. Missing global config falls
 * back to the same defaults as `src/config.ts`, so an operator who configured
 * SMTP only in the skill still gets mail.
 */
function emailConfigFor(db: Database, to: string[], subjectPrefix: string): EmailConfig {
  const email = globalEmailRaw(db);
  const skill = asObject(email.skill);
  return {
    enabled: true,
    on: email.on === "all" ? "all" : "publish",
    to,
    subjectPrefix,
    attachArticle: false,
    skill: {
      dir: typeof skill.dir === "string" && skill.dir ? skill.dir : DEFAULT_SKILL_DIR,
      python: typeof skill.python === "string" && skill.python ? skill.python : DEFAULT_PYTHON,
    },
  };
}

function adminRecipients(db: Database): string[] {
  const to = globalEmailRaw(db).to;
  if (!Array.isArray(to)) return [];
  return to.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

export interface WechatLogin {
  username: string;
  password: string;
}

/**
 * Decrypt this account's `wechat_login`. The canonical plaintext is a JSON
 * object `{"username":"…","password":"…"}`; a bare string is treated as the
 * password so hand-entered secrets still work. `null` = not configured.
 */
export function decryptWechatLogin(
  db: Database,
  key: Buffer,
  accountId: number,
): WechatLogin | null {
  const row = getSecretCipher(db, accountId, "wechat_login");
  if (!row) return null;
  try {
    const plain = decryptSecret(row.ciphertext, row.nonce, key);
    try {
      const parsed = JSON.parse(plain) as unknown;
      if (isPlainObject(parsed)) {
        const username = typeof parsed.username === "string" ? parsed.username : "";
        const password = typeof parsed.password === "string" ? parsed.password : "";
        if (username || password) return { username, password };
      }
    } catch {
      /* not JSON — fall through to raw string */
    }
    return { username: "", password: plain };
  } catch {
    return null;
  }
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function two(n: number): string {
  return String(n).padStart(2, "0");
}

export function formatStamp(d: Date): string {
  return (
    `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ` +
    `${two(d.getHours())}:${two(d.getMinutes())}`
  );
}

export interface TunnelMailBody {
  subject: string;
  body: string;
}

/** Render the (HTML) mail body for one account. */
export function buildTunnelMail(
  tunnel: TunnelRow,
  login: WechatLogin | null,
  prefix: string,
  now: Date,
): TunnelMailBody {
  const url = tunnel.url ?? "";
  const hostname = os.hostname();
  const ip = internalIpv4();
  const port = consolePort();
  const subject = `${prefix}[wechat-flow] 控制台地址已更新 (${formatStamp(now)})`;
  const credLine = login
    ? `账号：${esc(login.username || "（未填）")}<br>密码：${esc(login.password)}`
    : "未配置（请管理员在控制台补录）";
  const body = [
    "<div style=\"font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6\">",
    "<p>wechat-flow 控制台地址已更新。</p>",
    "<p><b>【服务器信息】</b><br>",
    `主机名：${esc(hostname)}<br>`,
    `内网 IP：${esc(ip)}<br>`,
    `控制台端口：${port}<br>`,
    `更新时间：${esc(formatStamp(now))}</p>`,
    "<p><b>【当前地址】</b><br>",
    url ? `<a href="${esc(url)}">${esc(url)}</a>` : "（暂无）",
    "</p>",
    "<p><b>【本账号后台账密】</b><br>",
    credLine,
    "</p>",
    "<p style=\"color:#888\">该地址由 Cloudflare 临时隧道生成，随时可能变更，请勿转发给他人。</p>",
    "</div>",
  ].join("\n");
  return { subject, body };
}

/**
 * Notify every enabled account (plus admin copies) about `tunnel`. Deduped by
 * `tunnels.notified_at`; on partial/total failure bumps the capped retry
 * counter and only flips the row to `error` at the cap.
 */
export async function notifyTunnelChange(
  db: Database,
  key: Buffer,
  tunnel: TunnelRow,
  opts: NotifyOpts = {},
): Promise<NotifyResult> {
  const log = opts.log ?? ((): void => {});
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const adminCopy = opts.adminCopy ?? true;
  const send = opts.send ?? sendMail;

  const fresh = getTunnel(db, tunnel.id) ?? tunnel;
  if (fresh.notified_at) {
    return { sent: false, skipped: "already-notified", attempts: fresh.notify_attempts };
  }

  const accounts: AccountRow[] = listAccountRows(db).filter((a) => a.enabled !== 0);
  const adminTo = adminCopy ? adminRecipients(db) : [];
  const now = new Date();

  let attempted = 0;
  let failed = 0;
  let lastError = "";
  const seen = new Set<string>();
  let accountWithMail = 0;

  for (const account of accounts) {
    const emailRow = getEmail(db, account.id);
    const to = parseEmailList(emailRow?.to_json);
    const cc = parseEmailList(emailRow?.cc_json);
    const recipients = uniq([...to, ...cc, ...adminTo]);
    if (recipients.length === 0) continue;
    accountWithMail += 1;
    recipients.forEach((r) => seen.add(r));

    const cfg = emailConfigFor(db, recipients, emailRow?.subject_prefix ?? "");
    const login = decryptWechatLogin(db, key, account.id);
    const mail = buildTunnelMail(fresh, login, cfg.subjectPrefix ?? "", now);
    attempted += 1;
    try {
      const ok = await send(cfg, { subject: mail.subject, body: mail.body });
      if (!ok) {
        failed += 1;
        lastError = "sendMail 返回 false";
      }
    } catch (err) {
      failed += 1;
      lastError = (err as Error).message;
    }
  }

  // Guarantee an admin copy even when no account has recipients configured.
  if (accountWithMail === 0 && adminTo.length > 0) {
    adminTo.forEach((r) => seen.add(r));
    const cfg = emailConfigFor(db, adminTo, "");
    const mail = buildTunnelMail(fresh, null, "", now);
    attempted += 1;
    try {
      const ok = await send(cfg, { subject: mail.subject, body: mail.body });
      if (!ok) {
        failed += 1;
        lastError = "sendMail 返回 false";
      }
    } catch (err) {
      failed += 1;
      lastError = (err as Error).message;
    }
  }

  if (attempted === 0) {
    log(`[tunnel-mail] tunnel ${fresh.id}: no recipients configured, skipped`);
    return { sent: false, skipped: "no-recipients", attempts: fresh.notify_attempts, recipients: 0 };
  }

  if (failed === 0) {
    markNotified(db, fresh.id);
    recordAudit(db, {
      actor: "system",
      action: "tunnel.mail",
      target: `tunnel:${fresh.id}`,
      detail: { recipients: seen.size, accounts: attempted },
      ok: true,
    });
    log(`[tunnel-mail] tunnel ${fresh.id}: sent to ${seen.size} recipient(s)`);
    return { sent: true, attempts: fresh.notify_attempts, recipients: seen.size };
  }

  const attempts = bumpNotifyAttempts(db, fresh.id);
  const detail = `mail failed (${failed}/${attempted}): ${lastError}`;
  recordAudit(db, {
    actor: "system",
    action: "tunnel.mail",
    target: `tunnel:${fresh.id}`,
    detail: { recipients: seen.size, accounts: attempted, failed },
    ok: false,
  });
  if (attempts >= maxAttempts) {
    setTunnelStatus(db, fresh.id, "error", detail);
    log(`[tunnel-mail] tunnel ${fresh.id}: giving up after ${attempts} attempt(s)`);
  } else {
    log(`[tunnel-mail] tunnel ${fresh.id}: attempt ${attempts}/${maxAttempts} failed: ${lastError}`);
  }
  return { sent: false, attempts, error: detail, recipients: seen.size };
}
