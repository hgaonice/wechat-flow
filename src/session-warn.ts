import fs from "node:fs";
import path from "node:path";
import { log } from "./log.ts";
import { atomicWriteJson } from "./state.ts";
import { sendMail, type EmailConfig } from "./mailer.ts";

/**
 * Advisory "ticket is about to expire" warning (C1, design §C-4 / R6).
 *
 * The MP ticket has a hard 96h expiry that MP only slides on authenticated
 * activity. `wechat-keepalive` therefore slides it every few hours — so an
 * expiry warning is NOT an alarm, it is a "something stopped sliding the ticket"
 * hint that gives the operator a day to look before a publish fails.
 *
 * Hard rules (R2/R6):
 *   - never blocks and never fails the caller (returns `{sent:false, reason}`);
 *   - at most ONE email per `WFC_SESSION_WARN_INTERVAL_HOURS` (default 24h) per
 *     account, persisted in `data/<alias>/state/session-warn.json`;
 *   - wording is clearly different from the "session invalid / scan the QR"
 *     failure mail: a warning must never look like an outage.
 */

export const WARN_THRESHOLD_HOURS = 24;
export const WARN_INTERVAL_HOURS = 24;

export interface WarnState {
  lastWarnAt?: string;
  /** Ticket expiry that the last warning was about (kept for post-mortems). */
  lastWarnExpiresAt?: number;
  hoursLeft?: number;
}

export function warnStateFile(dataDir: string): string {
  return path.join(dataDir, "state", "session-warn.json");
}

export function readWarnState(file: string): WarnState {
  try {
    if (!fs.existsSync(file)) return {};
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<WarnState>;
    return {
      ...(typeof raw.lastWarnAt === "string" ? { lastWarnAt: raw.lastWarnAt } : {}),
      ...(typeof raw.lastWarnExpiresAt === "number" ? { lastWarnExpiresAt: raw.lastWarnExpiresAt } : {}),
      ...(typeof raw.hoursLeft === "number" ? { hoursLeft: raw.hoursLeft } : {}),
    };
  } catch {
    // A corrupt warn file must only cost us one extra email, never an exception.
    return {};
  }
}

export interface WarnOptions {
  /** `data/<alias>` — the warn state lives in `<dataDir>/state/session-warn.json`. */
  dataDir: string;
  alias: string;
  accountName?: string;
  /** `slave_sid` expiry (Unix seconds) from `readCookieFacts`. */
  slaveSidExpiresAt?: number;
  email?: EmailConfig;
  now?: number;
  /** Warn when less than this many hours remain (default 24). */
  thresholdHours?: number;
  /** Minimum gap between two warnings (default 24h). */
  minIntervalHours?: number;
  /** Decide + log, but never send (used by tests / `--dry-run`). */
  dryRun?: boolean;
}

export interface WarnOutcome {
  sent: boolean;
  /** Always a human-readable reason (why sent OR why not). */
  reason: string;
  hoursLeft?: number;
  lastWarnAt?: string;
  emailOk?: boolean;
}

/**
 * Send at most one "ticket expires soon" email per interval.
 *
 * Every non-send path is reported through `reason` so `doctor`/logs can tell
 * "not due yet" from "email misconfigured" without guessing.
 */
export async function maybeWarnExpiringSession(opts: WarnOptions): Promise<WarnOutcome> {
  const nowMs = opts.now ?? Date.now();
  const threshold = opts.thresholdHours ?? WARN_THRESHOLD_HOURS;
  const interval = opts.minIntervalHours ?? WARN_INTERVAL_HOURS;
  const file = warnStateFile(opts.dataDir);
  const prev = readWarnState(file);

  if (opts.slaveSidExpiresAt === undefined) {
    return { sent: false, reason: "cookie 到期时间未知（读不到 / 会话 cookie），无法预警", lastWarnAt: prev.lastWarnAt };
  }
  const hoursLeft = (opts.slaveSidExpiresAt * 1000 - nowMs) / 3_600_000;
  const base = { hoursLeft, lastWarnAt: prev.lastWarnAt };

  if (hoursLeft > threshold) {
    return { sent: false, ...base, reason: `剩余 ${hoursLeft.toFixed(1)}h > ${threshold}h，无需预警` };
  }
  const lastMs = prev.lastWarnAt ? Date.parse(prev.lastWarnAt) : NaN;
  if (Number.isFinite(lastMs) && nowMs - lastMs < interval * 3_600_000) {
    return { sent: false, ...base, reason: `${((nowMs - lastMs) / 3_600_000).toFixed(1)}h 前已预警（间隔 ${interval}h）` };
  }
  if (!opts.email || opts.email.enabled === false) {
    return { sent: false, ...base, reason: "email 未配置或未启用（notify.email.enabled）" };
  }

  const expiresIso = new Date(opts.slaveSidExpiresAt * 1000).toISOString();
  const subject = `${opts.email.subjectPrefix ?? ""}⏳ 公众号会话票据将在 ${hoursLeft.toFixed(1)}h 后到期（提前预警，非失败）`;
  const body = [
    `账号：${opts.accountName ?? opts.alias}（${opts.alias}）`,
    `slave_sid 到期：${expiresIso}（剩余 ${hoursLeft.toFixed(1)}h）`,
    "",
    "这只是一封提前预警，不是发布失败，也不会阻塞任何任务。",
    "",
    "正常情况下 wechat-keepalive 每 5h 会做一次鉴权请求，票据会自动顺延 96h；",
    "如果你看到这封邮件，说明最近一次保活可能没成功，请检查：",
    "  1) systemctl list-timers 'wechat-*' --no-pager   # 下一次保活是否已排定",
    "  2) bun src/cli.ts keepalive --all               # 手动触发一次，看是否成功",
    "  3) bun src/cli.ts doctor --all                  # mp-session 行会给出 cookie/HTTP/DOM 证据",
    "",
    "同一条预警每 24h 最多一封。若票据真的过期，保活会发另一封「扫码」邮件——两者文案不同，请勿混淆。",
  ].join("\n");

  if (opts.dryRun === true) {
    return { sent: false, ...base, emailOk: false, reason: `dry-run：本应发送预警（剩余 ${hoursLeft.toFixed(1)}h）` };
  }

  const emailOk = await sendMail(opts.email, { subject, body });
  if (!emailOk) {
    // Do NOT advance lastWarnAt: the next attempt (≥5h later, or a manual run)
    // should retry instead of staying silent for a day.
    return { sent: false, ...base, emailOk: false, reason: "预警邮件发送失败（见日志）—— 不记录 lastWarnAt，下次重试" };
  }
  const state: WarnState = {
    lastWarnAt: new Date(nowMs).toISOString(),
    lastWarnExpiresAt: opts.slaveSidExpiresAt,
    hoursLeft,
  };
  try {
    atomicWriteJson(file, state);
  } catch (err) {
    log.warn(`[session] 预警已发送但状态未落盘（会重复发一封）：${err instanceof Error ? err.message : String(err)}`);
  }
  log.warn(`[session] 已发送到期预警：${opts.alias} 剩余 ${hoursLeft.toFixed(1)}h（${expiresIso}）`);
  return { sent: true, ...base, emailOk: true, reason: `已发送预警（剩余 ${hoursLeft.toFixed(1)}h）` };
}
