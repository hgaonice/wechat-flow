import fs from "node:fs";
import { log } from "./log.ts";
import { atomicWriteJson } from "./state.ts";
import { describeCookieFacts, readCookieFacts, type CookieFacts } from "./session-state.ts";

/**
 * Three-state MP session verdict + anti-flapping state machine (C1, design §C-1).
 *
 * Background: the old `ensureLoggedIn` was binary and backed by a single piece of
 * evidence (DOM). On 2026-10-20 07:02 that produced a *false* "session expired",
 * which fired three QR emails, a failure email and a 15-minute stall — the same
 * account was judged "session valid" 15 minutes later without anyone scanning.
 *
 * So the verdict becomes three-valued and only strong evidence may be `invalid`:
 *
 *   | cookie                      | http                  | dom            | verdict |
 *   |-----------------------------|-----------------------|----------------|---------|
 *   | expired / missing           | —                     | —              | invalid |
 *   | any                         | redirectedToLogin     | —              | invalid |
 *   | not expired (or unreadable) | ok                    | loggedIn       | valid   |
 *   | not expired                 | ok / unknown          | timeout shell  | unknown |
 *   | unreadable                  | unknown               | unreadable     | unknown |
 *
 * `unknown` NEVER triggers the QR flow on its own: it only increments a persisted
 * consecutive-failure counter, and the QR flow needs either `invalid` or
 * `WFC_SESSION_FAIL_THRESHOLD` consecutive failures (default 3, ≥60s apart).
 */

export type SessionVerdict = "valid" | "invalid" | "unknown";

export interface HttpEvidence {
  /** An authenticated in-page request succeeded (JSON backend reply). */
  ok: boolean;
  status?: number;
  /** The backend explicitly answered "not logged in" (strong evidence). */
  redirectedToLogin?: boolean;
  /** We deliberately made no request (no token on the page / probe-only mode). */
  skipped?: boolean;
  reason?: string;
}

export interface DomEvidence {
  /** The DOM could be read at all (CDP + page reachable). */
  ok: boolean;
  loggedIn?: boolean;
  /** MP's "登录超时，请重新登录" shell page — NOT proof of a dead session. */
  pageTimeoutShell?: boolean;
  url?: string;
  reason?: string;
}

export interface PageEvidence {
  http: HttpEvidence;
  dom: DomEvidence;
}

export interface SessionFacts {
  cookie: CookieFacts;
  http: HttpEvidence;
  dom: DomEvidence;
}

/** MP shell page markers ("登录超时，请重新登录"). Distinct from a real logout. */
export function detectPageTimeoutShell(input: { className?: string; text?: string }): boolean {
  const cls = String(input.className ?? "");
  const txt = String(input.text ?? "");
  return /page_timeout|page_error/.test(cls) || /登录超时|重新登录/.test(txt);
}

/**
 * Pure decision function (unit-tested in tools/session-selftest.ts).
 *
 * Order matters: cookie evidence first (local, strong), then the server's own
 * "log in again" answer, then the positive combination. Everything else is
 * `unknown` — a timeout shell or an unreadable DOM must never be `invalid`.
 */
export function decideVerdict(facts: SessionFacts, nowMs = Date.now()): SessionVerdict {
  const cookie = facts.cookie ?? { ok: false, reason: "no cookie evidence" };
  const http = facts.http ?? { ok: false, reason: "no http evidence" };
  const dom = facts.dom ?? { ok: false, reason: "no dom evidence" };
  const nowSec = nowMs / 1000;

  if (cookie.ok === true && cookie.slaveSidPresent === false) return "invalid";
  if (
    cookie.ok === true &&
    cookie.slaveSidExpiresAt !== undefined &&
    cookie.slaveSidExpiresAt <= nowSec
  ) {
    return "invalid";
  }
  if (http.redirectedToLogin === true) return "invalid";
  if (dom.loggedIn === true && http.ok === true) return "valid";
  return "unknown";
}

export interface ResourceThresholds {
  /** Consecutive non-valid probes required before asking a human to scan. */
  threshold: number;
  /** Minimum spacing between two counted failures. */
  minIntervalSec: number;
}

/** `WFC_SESSION_FAIL_THRESHOLD=1` restores the old "one failure ⇒ QR" behaviour. */
export function resolveProbeSettings(env: Record<string, string | undefined> = process.env): ResourceThresholds {
  // `Number("") === 0`, so an empty/unset env var must be treated as absent —
  // otherwise the 60s spacing default silently collapses to 0.
  const rawThreshold = env.WFC_SESSION_FAIL_THRESHOLD?.trim();
  const rawGap = env.WFC_SESSION_FAIL_MIN_INTERVAL_SEC?.trim();
  const threshold = rawThreshold ? Number(rawThreshold) : NaN;
  const gap = rawGap ? Number(rawGap) : NaN;
  return {
    threshold: Number.isFinite(threshold) && threshold >= 1 ? Math.floor(threshold) : 3,
    minIntervalSec: Number.isFinite(gap) && gap >= 0 ? gap : 60,
  };
}

export interface ProbeState {
  lastVerdict: SessionVerdict | null;
  lastEvidence: string;
  consecutiveFailures: number;
  /** ISO timestamp of the last probe. */
  lastProbeAt: string;
  /** ISO timestamp of the last successful `keepalive` (written by the CLI only). */
  lastKeepaliveAt?: string;
}

export const EMPTY_PROBE_STATE: ProbeState = {
  lastVerdict: null,
  lastEvidence: "",
  consecutiveFailures: 0,
  lastProbeAt: "",
};

export function readProbeState(file: string): ProbeState {
  try {
    if (!fs.existsSync(file)) return { ...EMPTY_PROBE_STATE };
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ProbeState>;
    const verdict = raw.lastVerdict;
    return {
      lastVerdict: verdict === "valid" || verdict === "invalid" || verdict === "unknown" ? verdict : null,
      lastEvidence: typeof raw.lastEvidence === "string" ? raw.lastEvidence : "",
      consecutiveFailures:
        typeof raw.consecutiveFailures === "number" && Number.isFinite(raw.consecutiveFailures)
          ? Math.max(0, Math.floor(raw.consecutiveFailures))
          : 0,
      lastProbeAt: typeof raw.lastProbeAt === "string" ? raw.lastProbeAt : "",
      ...(typeof raw.lastKeepaliveAt === "string" ? { lastKeepaliveAt: raw.lastKeepaliveAt } : {}),
    };
  } catch {
    // A corrupt counter must never block the probe; treat it as "no history".
    return { ...EMPTY_PROBE_STATE };
  }
}

export function writeProbeState(file: string, state: ProbeState): void {
  try {
    atomicWriteJson(file, state);
  } catch (err) {
    log.warn(`[session] could not persist probe state (${file}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Roll the persisted counter forward.
 *
 * `valid` resets it. Any other verdict increments it, but only when the previous
 * probe is at least `minIntervalSec` old — two probes within the same minute
 * (e.g. probe + publish in one job) must not burn the whole threshold at once.
 */
export function nextProbeState(
  prev: ProbeState,
  verdict: SessionVerdict,
  evidence: string,
  nowMs: number,
  opts: { minIntervalSec: number },
): ProbeState {
  const sincePrev = nowMs - Date.parse(prev.lastProbeAt ?? "");
  const prevCount = Number.isFinite(sincePrev) && prev.lastProbeAt ? prev.consecutiveFailures : 0;
  // `sincePrev < 0` means the clock moved backwards (NTP step, restored snapshot).
  // Treat it as "spaced" so the counter can never freeze forever.
  const spaced =
    !Number.isFinite(sincePrev) || !prev.lastProbeAt || sincePrev < 0 || sincePrev >= opts.minIntervalSec * 1000;
  const consecutiveFailures =
    verdict === "valid" ? 0 : spaced ? (prev.consecutiveFailures ?? 0) + 1 : prevCount;
  return {
    ...prev,
    lastVerdict: verdict,
    lastEvidence: evidence,
    consecutiveFailures,
    lastProbeAt: new Date(nowMs).toISOString(),
  };
}

export function shouldRequestScan(
  verdict: SessionVerdict,
  consecutiveFailures: number,
  threshold: number,
): boolean {
  return verdict === "invalid" || consecutiveFailures >= Math.max(1, threshold);
}

function oneLine(s: string | undefined, max = 90): string {
  return String(s ?? "").replace(/[\s,]+/g, " ").trim().slice(0, max);
}

export function describeHttp(http: HttpEvidence): string {
  if (http.redirectedToLogin === true) return `login-redirect(${oneLine(http.reason, 40) || "server"})`;
  if (http.ok === true) return "ok";
  if (http.skipped === true) return `skipped(${oneLine(http.reason, 60) || "not requested"})`;
  return `fail(${oneLine(http.reason, 60) || "unknown"})`;
}

export function describeDom(dom: DomEvidence): string {
  if (dom.ok !== true) return `unreadable(${oneLine(dom.reason, 50) || "unknown"})`;
  if (dom.loggedIn === true) return "loggedin";
  if (dom.pageTimeoutShell === true) return "page_timeout";
  return "loggedout";
}

/** Raw shape the in-page authenticated fetch reports back (see session.ts). */
export interface RawAuthResponse {
  kind: "no-token" | "http" | "error";
  status?: number;
  redirected?: boolean;
  finalUrl?: string;
  body?: string;
  error?: string;
  url?: string;
}

/**
 * Turn one in-page authenticated request into http evidence.
 *
 * Only an explicit server-side "you are not logged in" may set
 * `redirectedToLogin`; a 5xx / network hiccup / malformed body is just `ok:false`
 * (→ unknown), because a flaky probe must not send a QR.
 */
export function classifyAuthResponse(raw: RawAuthResponse): HttpEvidence {
  if (raw.kind === "no-token") return { ok: false, skipped: true, reason: "no token on page url" };
  if (raw.kind === "error") return { ok: false, reason: raw.error ?? "auth request failed" };
  const status = Number(raw.status ?? 0);
  const body = String(raw.body ?? "");
  const finalUrl = String(raw.finalUrl ?? "");
  if (/loginpage|login_page|login_form|loginBox|\bqrconnect\b|用户登录/.test(`${finalUrl} ${body}`)) {
    return { ok: false, status, redirectedToLogin: true, reason: "auth request landed on the login page" };
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = null;
  }
  if (parsed && typeof parsed === "object") {
    const base = (parsed as { base_resp?: { ret?: unknown; err_msg?: unknown } }).base_resp;
    const ret = Number(base?.ret ?? NaN);
    const errMsg = String(base?.err_msg ?? "");
    if (ret === 200003 || /invalid session|登录超时|请重新登录|重新登录/i.test(errMsg)) {
      return { ok: false, status, redirectedToLogin: true, reason: `ret=${ret} ${errMsg}`.trim() };
    }
    // Any other JSON reply still proves the request was authenticated (e.g. a
    // rate-limit `ret`): the session is alive even if this query failed.
    return { ok: true, status, reason: `ret=${Number.isFinite(ret) ? ret : "?"}` };
  }
  if (status >= 200 && status < 300) {
    return { ok: false, status, reason: "non-json response (cannot prove authentication)" };
  }
  return { ok: false, status, reason: `http ${status || "?"}` };
}

/** `cookie:<…>,http:<…>,dom:<…>` — the single line every log/email quotes. */
export function evidenceLine(facts: SessionFacts, nowMs = Date.now()): string {
  const cookie = facts.cookie ? describeCookieFacts(facts.cookie, nowMs) : "unreadable(absent)";
  return `cookie:${oneLine(cookie, 70)},http:${describeHttp(facts.http ?? { ok: false })},dom:${describeDom(facts.dom ?? { ok: false })}`;
}

/** Why we believe the verdict — quoted in emails so "misjudged" ≠ "really expired". */
export function verdictReason(facts: SessionFacts, verdict: SessionVerdict, nowMs = Date.now()): string {
  const cookie = facts.cookie;
  if (verdict === "valid") return "cookie+http+dom 一致";
  if (verdict === "invalid") {
    if (facts.http?.redirectedToLogin === true) return "服务端鉴权请求明确跳登录（确认失效）";
    if (cookie?.ok === true && cookie.slaveSidPresent === false) return "本地 cookie 缺失（确认已退出登录）";
    if (cookie?.ok === true && cookie.slaveSidExpiresAt !== undefined && cookie.slaveSidExpiresAt <= nowMs / 1000) {
      return `本地 cookie 已过期（${new Date(cookie.slaveSidExpiresAt * 1000).toISOString()}，强证据）`;
    }
    return "强证据判失效";
  }
  if (facts.dom?.pageTimeoutShell === true) return "探测证据不足：页面是「登录超时」壳页，未确认失效";
  return "探测证据不足（cookie/http/dom 均未给出结论），未确认失效";
}

/** Multi-line summary for QR/failure emails (R2: 误判与真失效必须可区分). */
export function evidenceSummary(result: ProbeResult): string {
  const lines = [
    `探测判定：${result.verdict}`,
    `判定来源：${verdictReason(result.facts, result.verdict)}`,
    `证据：${result.evidence}`,
    `连续失败：${result.consecutiveFailures}/${result.threshold}`,
  ];
  return lines.join("\n");
}

export interface ProbeOptions {
  account: string;
  /** Chrome user-data-dir (`resolveProfileDir`) — where `Default/Cookies` lives. */
  profileDir: string;
  /** `data/<alias>/state/session-probe.json`. */
  stateFile: string;
  /**
   * Collect the http + dom evidence. Injected so tests (and the read-only CLI
   * probe) never touch a browser: `src/session.ts` supplies the CDP collector.
   */
  collectPage: () => Promise<PageEvidence>;
  env?: Record<string, string | undefined>;
  now?: () => number;
  threshold?: number;
  minIntervalSec?: number;
  /** `false` ⇒ do not touch the state file (pure inspection). */
  persist?: boolean;
  quiet?: boolean;
}

export interface ProbeResult {
  verdict: SessionVerdict;
  facts: SessionFacts;
  detail: string;
  evidence: string;
  consecutiveFailures: number;
  threshold: number;
  needsScan: boolean;
  state: ProbeState;
}

/** Local cookie evidence → page evidence (http + dom) → verdict → persisted counter. */
export async function probeSession(opts: ProbeOptions): Promise<ProbeResult> {
  const nowMs = (opts.now ?? Date.now)();
  // ⚠️ 必须合并 `process.env`：生产调用链传的是 `proxyEnv(cfg)`（只有
  // http_proxy/https_proxy/no_proxy，无代理时甚至是 `{}`）。若直接用它替代
  // process.env，`WFC_SESSION_FAIL_THRESHOLD` / `WFC_SESSION_FAIL_MIN_INTERVAL_SEC`
  // 这两个应急闸门在线上永远读不到（2026-10-20 复核 B1 实测：文档说 =1 可回旧行为，实际无效）。
  const env = { ...process.env, ...opts.env };
  const settings = resolveProbeSettings(env);
  const threshold = opts.threshold ?? settings.threshold;
  const minIntervalSec = opts.minIntervalSec ?? settings.minIntervalSec;

  const cookie = readCookieFacts(opts.profileDir);
  let page: PageEvidence;
  try {
    page = await opts.collectPage();
  } catch (err) {
    const reason = `page evidence failed: ${err instanceof Error ? err.message : String(err)}`;
    page = { http: { ok: false, reason }, dom: { ok: false, reason } };
  }
  const facts: SessionFacts = {
    cookie,
    http: page.http ?? { ok: false, reason: "no http evidence" },
    dom: page.dom ?? { ok: false, reason: "no dom evidence" },
  };
  const verdict = decideVerdict(facts, nowMs);
  const evidence = evidenceLine(facts, nowMs);

  const prev = readProbeState(opts.stateFile);
  const state = nextProbeState(prev, verdict, evidence, nowMs, { minIntervalSec });
  if (opts.persist !== false) writeProbeState(opts.stateFile, state);

  const needsScan = shouldRequestScan(verdict, state.consecutiveFailures, threshold);
  if (opts.quiet !== true) {
    // Fixed format (R7): verdict + counter + per-layer evidence on ONE line so a
    // post-mortem never has to guess which signal produced the decision.
    log.info(`[session] verdict=${verdict} consecutive=${state.consecutiveFailures}/${threshold} evidence=${evidence}`);
  }
  return {
    verdict,
    facts,
    detail: `${verdictReason(facts, verdict, nowMs)} · ${evidence}`,
    evidence,
    consecutiveFailures: state.consecutiveFailures,
    threshold,
    needsScan,
    state,
  };
}

/** What `ensureLoggedIn` is allowed to do with a probe result. */
export type LoginAction = "ok" | "continue" | "scan";

/**
 * Pure gate between probing and bothering a human (R2 / AC2).
 *
 * `continue` = log + count the failure and carry on: no QR capture, no email.
 * Only `invalid` (strong evidence) or a crossed failure threshold may `scan`.
 */
export function planLoginAction(result: Pick<ProbeResult, "verdict" | "needsScan">): LoginAction {
  if (result.verdict === "valid") return "ok";
  return result.needsScan ? "scan" : "continue";
}

/** Record a successful keepalive so `doctor` can show "last keepalive 2.1h ago". */
export function markKeepalive(stateFile: string, nowMs = Date.now()): ProbeState {
  const state = { ...readProbeState(stateFile), lastKeepaliveAt: new Date(nowMs).toISOString() };
  writeProbeState(stateFile, state);
  return state;
}

/**
 * Clear the consecutive-failure counter (a human just scanned the QR, or the
 * session proved itself alive). `lastVerdict` is kept — the counter, not the
 * last verdict, is what gates the next scan.
 */
export function resetFailureCount(stateFile: string, note = "session-confirmed"): ProbeState {
  const prev = readProbeState(stateFile);
  const state: ProbeState = {
    ...prev,
    consecutiveFailures: 0,
    lastEvidence: prev.lastEvidence ? `${prev.lastEvidence} + ${note}` : note,
  };
  writeProbeState(stateFile, state);
  return state;
}

/** `12.3` hours since `iso`, or null when unknown/unparsable. */
export function hoursSince(iso: string | undefined, nowMs = Date.now()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return (nowMs - t) / 3_600_000;
}
