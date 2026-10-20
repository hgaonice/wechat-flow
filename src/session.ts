import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cdpVersion, ensureBrowser, resolveProfileDir, type BrowserConfig } from "./browser.ts";
import { APP_DIR } from "./config.ts";
import { log } from "./log.ts";
import {
  classifyAuthResponse,
  detectPageTimeoutShell,
  evidenceSummary,
  planLoginAction,
  probeSession,
  resetFailureCount,
  type DomEvidence,
  type HttpEvidence,
  type PageEvidence,
  type ProbeResult,
  type RawAuthResponse,
  type SessionVerdict,
} from "./session-probe.ts";

/**
 * WeChat MP login-session helpers (browser/CDP method).
 *
 * The MP session lives in the Chrome profile. It expires after a while, which
 * would otherwise silently break the unattended daily job — so before every
 * browser publish we check the session and, if logged out, capture a fresh
 * login QR, email it, and wait for the user to scan (self-healing).
 */

const WECHAT_URL = "https://mp.weixin.qq.com/";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface EmailCfg {
  enabled?: boolean;
  subjectPrefix?: string;
  to?: string[];
  skill?: { dir: string; python?: string };
}

type Cdp = any;

interface Ctx {
  cdp: Cdp;
  sess: { sessionId: string };
}

async function connect(browser: BrowserConfig, skillDir: string): Promise<Cdp> {
  const mod: any = await import(path.join(skillDir, "scripts", "cdp.ts"));
  const wsUrl = await mod.waitForChromeDebugPort(browser.cdpPort, 20_000);
  return mod.CdpConnection.connect(wsUrl, 20_000);
}

async function evalValue(cdp: Cdp, sess: { sessionId: string }, expression: string, awaitPromise = false): Promise<unknown> {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise }, sess);
  return r?.result?.value;
}

async function openWechatTab(cdp: Cdp, create: boolean): Promise<{ sessionId: string; targetId: string } | null> {
  const pick = (targets: any) => {
    const pages = targets.targetInfos.filter((t: any) => t.type === "page" && t.url.includes("mp.weixin.qq.com"));
    // Prefer the home tab: it carries the login session. An appmsg editor tab
    // left over from a previous run is often a dead "登录超时" page and would
    // make every later DOM probe/click fail.
    return pages.find((t: any) => t.url.includes("/cgi-bin/home")) ?? pages[0];
  };
  const targets = await cdp.send("Target.getTargets");
  let tab = pick(targets);
  if (!tab && create) {
    const created = await cdp.send("Target.createTarget", { url: WECHAT_URL });
    await sleep(2500);
    const t2 = await cdp.send("Target.getTargets");
    tab = t2.targetInfos.find((t: any) => t.targetId === created.targetId) ?? pick(t2);
  }
  if (!tab) return null;
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: tab.targetId, flatten: true });
  return { sessionId, targetId: tab.targetId };
}

function isLoggedInUrl(url: string): boolean {
  return /token=\d+/.test(url) || url.includes("/cgi-bin/home");
}

/**
 * Real login state, read from the DOM (H5 / verification.md): the URL is NOT a
 * truth source. When an MP session dies, `cgi-bin/home?…token=…` still renders
 * a cached `page_timeout` shell ("登录超时，请重新登录") while the token in the
 * query string stays valid-looking — that false positive skipped the QR
 * self-heal and the run later died with `Editor did not load (#title not found)`.
 */
export interface LoginProbe {
  loggedIn: boolean;
  timedOut: boolean;
  menu: boolean;
  url: string;
}

const LOGIN_PROBE_EXPR = `(function(){
  var b = document.body;
  var cls = b ? String(b.className || '') : '';
  var txt = b ? String(b.innerText || '').slice(0, 300) : '';
  return JSON.stringify({
    url: location.href,
    className: cls,
    text: txt,
    menu: !!document.querySelector('.new-creation__menu')
  });
})()`;

async function probeLogin(cdp: Cdp, sess: { sessionId: string }): Promise<LoginProbe> {
  try {
    const raw = await evalValue(cdp, sess, LOGIN_PROBE_EXPR);
    const p = JSON.parse(String(raw ?? ""));
    const url = String(p.url ?? "");
    // `page_timeout` / "登录超时，请重新登录" is a SHELL page, not proof of a dead
    // session (verification.md) — it is classified as `unknown`, never `invalid`.
    const timedOut = detectPageTimeoutShell({ className: String(p.className ?? ""), text: String(p.text ?? "") });
    const menu = p.menu === true;
    return { loggedIn: menu && !timedOut, timedOut, menu, url };
  } catch {
    return { loggedIn: false, timedOut: false, menu: false, url: "" };
  }
}

async function goto(cdp: Cdp, sess: { sessionId: string }, url: string): Promise<void> {
  try {
    await cdp.send("Page.enable", {}, sess);
    await cdp.send("Page.navigate", { url }, sess);
  } catch {
    // Fall back to script navigation when Page.navigate is unavailable.
    await evalValue(cdp, sess, `window.location.href = ${JSON.stringify(url)}`).catch(() => undefined);
  }
}

/**
 * Force a cache-disabled re-render of the current page before trusting its DOM.
 * A reused tab can still paint the logged-in menu ("new-creation__menu") from a
 * cached response after the MP session has already died — the cache is what
 * made the first probe report a false "session valid".
 */
async function revalidatePage(cdp: Cdp, sess: { sessionId: string }): Promise<void> {
  try {
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true }, sess);
  } catch {
    /* Network domain is best-effort */
  }
  // Drop a marker into the current JS context. It only disappears when the page
  // really reloaded — probing too early reads the *old* DOM (still showing the
  // logged-in menu) and reports a false "session valid".
  const marker = `wfc-probe-${Date.now()}`;
  await evalValue(cdp, sess, `window.__wfcProbe = ${JSON.stringify(marker)}`).catch(() => undefined);

  const url = await href(cdp, sess);
  // A token-less home URL renders a timeout page even for a live session, so
  // only the token-bearing URL (or the root login page) may be reloaded.
  if (/token=\d+/.test(url)) {
    try {
      await cdp.send("Page.enable", {}, sess);
      await cdp.send("Page.reload", { ignoreCache: true }, sess);
    } catch {
      await goto(cdp, sess, url);
    }
  } else {
    await goto(cdp, sess, WECHAT_URL);
  }

  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const still = await evalValue(cdp, sess, "window.__wfcProbe || ''");
    const ready = await evalValue(cdp, sess, "document.readyState");
    if (still !== marker && ready === "complete") return;
    await sleep(700);
  }
}

async function href(cdp: Cdp, sess: { sessionId: string }): Promise<string> {
  return String((await evalValue(cdp, sess, "window.location.href")) ?? "");
}

/**
 * Authenticated in-page request (the second evidence layer).
 *
 * `action=list_ex` is a read: it never modifies the 草稿箱, but it *is* an
 * authenticated call, so MP answers it with `base_resp.ret=0` for a live session
 * and `ret=200003 / invalid session` (or a login page) for a dead one. This is
 * the same request `keepalive` makes to slide the 96h ticket.
 */
const AUTH_PROBE_EXPR = `(async function(){
  try {
    var m = String(location.href).match(/token=(\\d+)/);
    if (!m) return JSON.stringify({ kind: 'no-token', url: String(location.href) });
    var url = '/cgi-bin/appmsg?token=' + m[1] + '&lang=zh_CN&f=json&ajax=1&action=list_ex&begin=0&count=1&type=77&query=&fakeid=&sub=&search_field=null&sort=';
    var r = await fetch(url, { credentials: 'include' });
    var body = await r.text();
    return JSON.stringify({ kind: 'http', status: r.status, redirected: !!r.redirected, finalUrl: String(r.url || ''), body: body.slice(0, 800) });
  } catch (e) {
    return JSON.stringify({ kind: 'error', error: String((e && e.message) || e) });
  }
})()`;

async function probeAuthRequest(cdp: Cdp, sess: { sessionId: string }, pageUrl: string): Promise<HttpEvidence> {
  const url = pageUrl || (await href(cdp, sess));
  if (!/token=\d+/.test(url)) {
    // No token on the page means there is nothing to authenticate against; that
    // is "no evidence", not "logged out".
    return { ok: false, skipped: true, reason: "no token on page url" };
  }
  try {
    const raw = await evalValue(cdp, sess, AUTH_PROBE_EXPR, true);
    return classifyAuthResponse(JSON.parse(String(raw ?? "{}")) as RawAuthResponse);
  } catch (err) {
    return { ok: false, reason: `auth request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export interface CollectPageOptions {
  browser: BrowserConfig;
  skillDir: string;
  /**
   * Force a cache-disabled reload before reading the DOM (default `true`).
   * `false` = strictly read-only diagnostic probe: no navigation at all.
   */
  revalidate?: boolean;
  /** Reuse an existing CDP connection (ensureLoggedIn already holds one). */
  cdp?: Cdp;
  sess?: { sessionId: string };
}

/**
 * Layer 2 + 3 of the session evidence chain: an authenticated request plus the
 * post-reload DOM.
 *
 * Never throws: any failure collapses into `{ok:false}` evidence so the caller
 * can still decide `unknown` (a broken probe must not page a human).
 */
export async function collectPageEvidence(opts: CollectPageOptions): Promise<PageEvidence> {
  let cdp = opts.cdp;
  let ownConnection = false;
  if (!cdp) {
    // Diagnostics must not spawn Chrome: if the port is down we simply have no
    // page evidence (→ unknown), we do NOT start a browser as a side effect.
    if (!(await cdpVersion(opts.browser.cdpPort))) {
      const reason = `Chrome CDP :${opts.browser.cdpPort} not reachable`;
      return { http: { ok: false, skipped: true, reason }, dom: { ok: false, reason } };
    }
    try {
      cdp = await connect(opts.browser, opts.skillDir);
      ownConnection = true;
    } catch (err) {
      const reason = `cdp connect failed: ${err instanceof Error ? err.message : String(err)}`;
      return { http: { ok: false, skipped: true, reason }, dom: { ok: false, reason } };
    }
  }
  try {
    const sess = opts.sess ?? (await openWechatTab(cdp, false));
    if (!sess) {
      const reason = "no mp.weixin.qq.com tab";
      return { http: { ok: false, skipped: true, reason }, dom: { ok: false, reason } };
    }
    const revalidate = opts.revalidate !== false;
    if (revalidate) await revalidatePage(cdp, sess);
    let probe = await probeLogin(cdp, sess);
    if (!probe.loggedIn && revalidate) {
      // Root URL is the fallback probe: an alive session redirects to home and
      // renders the menu; a dead one shows the login QR.
      await goto(cdp, sess, WECHAT_URL);
      await sleep(4000);
      probe = await probeLogin(cdp, sess);
      const graceMs = 16_000;
      const g0 = Date.now();
      while (!probe.loggedIn && !probe.timedOut && Date.now() - g0 < graceMs) {
        await sleep(1500);
        probe = await probeLogin(cdp, sess);
      }
    }
    const dom: DomEvidence = {
      ok: Boolean(probe.url),
      loggedIn: probe.loggedIn,
      pageTimeoutShell: probe.timedOut,
      url: probe.url,
      ...(probe.url ? {} : { reason: "DOM unreachable" }),
    };
    const http = dom.ok ? await probeAuthRequest(cdp, sess, probe.url) : { ok: false, reason: "DOM unreachable" };
    return { http, dom };
  } catch (err) {
    const reason = `page evidence failed: ${err instanceof Error ? err.message : String(err)}`;
    return { http: { ok: false, reason }, dom: { ok: false, reason } };
  } finally {
    if (ownConnection) {
      try {
        cdp?.close();
      } catch {
        /* ignore */
      }
    }
  }
}

export interface ProbeAccountOptions {
  browser: BrowserConfig;
  skillDir: string;
  account: string;
  /** `data/<alias>/state` — the probe counter lives here. */
  stateDir: string;
  env?: Record<string, string | undefined>;
  /** `false` = read-only diagnostic probe (no reload, no navigation). */
  revalidate?: boolean;
  /** `false` = do not touch `session-probe.json` (pure inspection). */
  persist?: boolean;
}

/** Full three-layer probe for one account (cookie + http + dom → verdict). */
export async function probeAccountSession(opts: ProbeAccountOptions): Promise<ProbeResult> {
  return probeSession({
    account: opts.account,
    profileDir: resolveProfileDir(opts.browser, opts.account),
    stateFile: path.join(opts.stateDir, "session-probe.json"),
    env: opts.env,
    persist: opts.persist,
    collectPage: () =>
      collectPageEvidence({
        browser: opts.browser,
        skillDir: opts.skillDir,
        revalidate: opts.revalidate,
      }),
  });
}

/** Screenshot just the login QR element (crisp + auto-cropped). */
async function captureQr(cdp: Cdp, sess: { sessionId: string }, outPath: string): Promise<boolean> {
  // The MP login QR shows up in two shapes: an in-page element carrying the
  // `login__type__container__scan__qrcode` class, or a cross-origin
  // open.weixin.qq.com qrconnect iframe (whose DOM we cannot read, but whose
  // bounding box is the QR widget). Both must be supported.
  const rectExpr = `(function(){
       var direct = [
         'img.login__type__container__scan__qrcode',
         '.login__type__container__scan__qrcode',
         'img.qrcode', '.qrcode', '#js_qrcode', '.js_qrcode'
       ];
       for (var d = 0; d < direct.length; d++) {
         var el = document.querySelector(direct[d]);
         if (!el) continue;
         var r = el.getBoundingClientRect();
         if (r.width >= 90 && r.height >= 90) return JSON.stringify({ x: r.x, y: r.y, width: r.width, height: r.height });
       }
       var nested = [
         '.login__type__container__scan__qrcode img',
         '.login__type__container__scan__qrcode canvas',
         '.login_frame img', '.login_box img'
       ];
       for (var s2 = 0; s2 < nested.length; s2++) {
         var e2 = document.querySelector(nested[s2]);
         if (!e2) continue;
         var r2 = e2.getBoundingClientRect();
         if (r2.width >= 90) return JSON.stringify({ x: r2.x, y: r2.y, width: r2.width, height: r2.height });
       }
       var all = Array.prototype.slice.call(document.querySelectorAll('img, canvas'));
       var best = null;
       for (var i = 0; i < all.length; i++) {
         var rc = all[i].getBoundingClientRect();
         if (rc.width >= 110 && rc.width <= 400 && Math.abs(rc.width - rc.height) < 30) {
           if (!best || rc.width > best.width) best = rc;
         }
       }
       if (best) return JSON.stringify({ x: best.x, y: best.y, width: best.width, height: best.height });
       var ifr = document.querySelector('iframe[src*="qrconnect"], iframe[src*="mpqrconnect"]');
       if (ifr) {
         var ri = ifr.getBoundingClientRect();
         if (ri.width >= 90) return JSON.stringify({ x: ri.x, y: ri.y, width: ri.width, height: ri.height });
       }
       return null;
     })()`;

  // The QR is injected a moment after the login page loads; retry instead of
  // settling for a full-page shot (a 1920x1080 screenshot is hard to scan).
  type Rect = { x: number; y: number; width: number; height: number };
  let rect: Rect | null = null;
  for (let attempt = 0; attempt < 14 && !rect; attempt++) {
    try {
      const raw = await evalValue(cdp, sess, rectExpr);
      if (raw) rect = JSON.parse(String(raw)) as Rect;
    } catch {
      /* page still loading */
    }
    if (!rect) await sleep(1500);
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  // Never replace an already-good QR with a full-page fallback shot: the
  // periodic re-capture would otherwise downgrade the image the user is
  // holding in their inbox.
  const writePath = !rect && fs.existsSync(outPath) ? `${outPath}.full.png` : outPath;
  let params: Record<string, unknown> = { format: "png" };
  if (rect) {
    const pad = 16;
    params = {
      format: "png",
      clip: {
        x: Math.max(0, rect.x - pad),
        y: Math.max(0, rect.y - pad),
        width: rect.width + pad * 2,
        height: rect.height + pad * 2,
        scale: 2,
      },
      captureBeyondViewport: true,
    };
  }
  try {
    const shot = await cdp.send("Page.captureScreenshot", params, sess);
    fs.writeFileSync(writePath, Buffer.from(shot.data, "base64"));
  } catch (err) {
    // A cold/animating page can make this RPC time out once; retry a couple of
    // times, then fall back to a full-page shot so the user still gets a QR.
    let saved = false;
    for (let attempt = 0; attempt < 2 && !saved; attempt++) {
      await sleep(1500);
      try {
        const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, sess);
        fs.writeFileSync(writePath, Buffer.from(shot.data, "base64"));
        saved = true;
      } catch {
        /* retry */
      }
    }
    if (!saved) log.warn(`QR screenshot failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return Boolean(rect);
}

/** Email the QR image via the email-sender skill's credentials. */
export function emailQrImage(opts: {
  qrPath: string;
  email?: EmailCfg;
  env?: Record<string, string | undefined>;
  body?: string;
}): boolean {
  if (!opts.email || opts.email.enabled === false) return false;
  const script = path.join(APP_DIR, "bin", "send-image.py");
  if (!fs.existsSync(script) || !fs.existsSync(opts.qrPath)) return false;
  const stamp = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  const subject = `${opts.email.subjectPrefix ?? ""}公众号登录二维码（请扫码）｜${stamp}`;
  const body =
    opts.body ??
    "请在 15 分钟内用微信扫码登录公众号后台。\n登录后无需其他操作，服务器会继续自动发布。";
  // Send to every configured recipient (the QR is the one message the user most
  // needs to see; falling back to the skill's single default recipient silently
  // dropped one of the two mailboxes).
  const recipients = opts.email.to?.length ? opts.email.to : [undefined];
  let allOk = true;
  for (const to of recipients) {
    const args = [script, "-i", opts.qrPath, "-s", subject, "-b", body];
    if (to) args.push("-t", to);
    const r = spawnSync("python3", args, { encoding: "utf8", env: { ...process.env, ...opts.env } });
    if (r.status === 0) {
      log.info(`QR emailed${to ? ` to ${to}` : ""}: ${(r.stdout || "").trim()}`);
    } else {
      allOk = false;
      log.error(`QR email${to ? ` to ${to}` : ""} failed: ${(r.stderr || r.stdout || "").slice(-300)}`);
    }
  }
  return allOk;
}

function qrFingerprint(file: string): string {
  try {
    return createHash("sha1").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return "";
  }
}

/**
 * Poll the DOM until the MP session is back, refreshing the (short-lived) login
 * QR every `refreshSec` and re-emailing it only when the QR content actually
 * changed — a stale QR silently fails to scan and the user can't tell why.
 */
async function waitForScan(opts: {
  cdp: Cdp;
  sess: { sessionId: string };
  waitSec: number;
  qrOutPath: string;
  email?: EmailCfg;
  env?: Record<string, string | undefined>;
  /** How often to reload the login page so the QR never goes stale. */
  refreshSec?: number;
  /** Minimum gap between two QR emails (avoids flooding the mailbox). */
  minEmailGapSec?: number;
  /** Hard cap on QR re-emails per wait (the first one is sent by the caller). */
  maxEmails?: number;
}): Promise<{ ok: boolean; detail: string }> {
  const refreshSec = opts.refreshSec ?? 75;
  const minEmailGapSec = opts.minEmailGapSec ?? 180;
  const maxEmails = opts.maxEmails ?? 4;
  const t0 = Date.now();
  let lastFp = qrFingerprint(opts.qrOutPath);
  let lastRefresh = Date.now();
  let lastEmail = Date.now();
  let emails = 0;

  while (Date.now() - t0 < opts.waitSec * 1000) {
    if ((await probeLogin(opts.cdp, opts.sess)).loggedIn) return { ok: true, detail: "logged in after QR scan" };
    if (Date.now() - lastRefresh >= refreshSec * 1000) {
      lastRefresh = Date.now();
      // Re-shoot the *current* QR instead of reloading the page: a forced
      // reload invalidates the QR the user may be about to scan, so we only
      // re-email when WeChat itself rotated it.
      const before = qrFingerprint(opts.qrOutPath);
      const cropped = await captureQr(opts.cdp, opts.sess, opts.qrOutPath);
      if (!cropped) {
        // Not sitting on the login page (e.g. the tab drifted) → go there once.
        await goto(opts.cdp, opts.sess, WECHAT_URL);
        await sleep(5000);
        await captureQr(opts.cdp, opts.sess, opts.qrOutPath);
      }
      const fp = qrFingerprint(opts.qrOutPath);
      const changed = Boolean(fp) && fp !== before;
      if (changed) lastFp = fp;
      if (changed && emails < maxEmails && Date.now() - lastEmail >= minEmailGapSec * 1000) {
        lastEmail = Date.now();
        emails++;
        log.info(`login QR rotated by WeChat — resending (${emails}/${maxEmails})`);
        emailQrImage({ qrPath: opts.qrOutPath, email: opts.email, env: opts.env });
      }
    }
    await sleep(3000);
  }
  return { ok: false, detail: `login timeout after ${opts.waitSec}s (QR not scanned)` };
}

/**
 * Bring the account's MP tab to the foreground.
 *
 * Chrome reports an occluded/backgrounded tab as
 * `document.visibilityState === "hidden"`, and WeChat's 「文章」 menu cannot open
 * the editor from there — Chrome blocks the popup, so the skill dies with
 * `New tab not found: mp.weixin.qq.com` (measured 2026-10-17: port 9222 was
 * `hidden` while 9223 was `visible`, and only 9222 failed to publish).
 *
 * Returns the resulting visibilityState, or null when the tab could not be reached.
 */
export async function focusMpTab(browser: BrowserConfig, skillDir: string): Promise<string | null> {
  let cdp: Cdp;
  try {
    cdp = await connect(browser, skillDir);
  } catch {
    return null;
  }
  try {
    const sess = await openWechatTab(cdp, false);
    if (!sess) return null;
    try {
      await cdp.send("Page.enable", {}, sess);
      await cdp.send("Page.bringToFront", {}, sess);
    } catch {
      return null;
    }
    await sleep(1200);
    const state = await evalValue(cdp, sess, "document.visibilityState");
    const value = state === undefined || state === null ? null : String(state);
    if (value !== "visible") log.warn(`MP tab still not visible (visibilityState=${value}); popup may be blocked`);
    return value;
  } catch {
    return null;
  } finally {
    try {
      cdp.close();
    } catch {
      /* ignore */
    }
  }
}

export interface EnsureLoginOptions {
  browser: BrowserConfig;
  skillDir: string;
  account: string;
  email?: EmailCfg;
  qrOutPath: string;
  /** Where `session-probe.json` lives (defaults to the dir of `qrOutPath`). */
  stateDir?: string;
  env?: Record<string, string | undefined>;
  waitSec?: number;
  /** Capture + email the QR when logged out (default true). */
  notifyQr?: boolean;
}

export interface EnsureLoginResult {
  ok: boolean;
  detail: string;
  /** Three-state verdict behind `ok` (never binary again — see session-probe.ts). */
  verdict: SessionVerdict;
  /** `cookie:…,http:…,dom:…` evidence that produced the verdict. */
  evidence?: string;
  consecutiveFailures: number;
  qrPath?: string;
  emailed?: boolean;
}

/**
 * Make sure we have a logged-in MP session in the app-managed Chrome.
 *
 * The verdict is three-valued (cookie + authenticated request + DOM). Only
 * `invalid` (strong evidence) or `WFC_SESSION_FAIL_THRESHOLD` consecutive failed
 * probes slide into the QR flow — a single flaky probe logs, counts, and lets the
 * run continue (2026-10-20 07:02 was exactly that flake: QR ×3 + failure mail
 * for a session that was alive 15 minutes later).
 */
export async function ensureLoggedIn(opts: EnsureLoginOptions): Promise<EnsureLoginResult> {
  await ensureBrowser(opts.browser, opts.account);
  const stateDir = opts.stateDir ?? path.dirname(opts.qrOutPath);
  const stateFile = path.join(stateDir, "session-probe.json");
  const cdp = await connect(opts.browser, opts.skillDir);
  try {
    const sess = await openWechatTab(cdp, true);
    if (!sess) {
      return { ok: false, verdict: "unknown", detail: "could not open mp.weixin.qq.com", consecutiveFailures: 0 };
    }

    const probe = await probeSession({
      account: opts.account,
      profileDir: resolveProfileDir(opts.browser, opts.account),
      stateFile,
      env: opts.env,
      collectPage: () =>
        collectPageEvidence({ browser: opts.browser, skillDir: opts.skillDir, cdp, sess, revalidate: true }),
    });

    const action = planLoginAction(probe);
    if (action === "ok") {
      return {
        ok: true,
        verdict: probe.verdict,
        detail: `session valid (${probe.evidence})`,
        evidence: probe.evidence,
        consecutiveFailures: 0,
      };
    }

    if (action === "continue") {
      // R2: 误判不得打扰。Keep the counter, report honestly, do NOT email.
      log.warn(
        `[session] verdict=${probe.verdict} consecutive=${probe.consecutiveFailures}/${probe.threshold} — below scan threshold, continuing without QR (evidence=${probe.evidence})`,
      );
      return {
        ok: true,
        verdict: probe.verdict,
        detail: `session unconfirmed (verdict=${probe.verdict}, consecutive=${probe.consecutiveFailures}/${probe.threshold}) — continuing; ${probe.detail}`,
        evidence: probe.evidence,
        consecutiveFailures: probe.consecutiveFailures,
      };
    }

    const summary = evidenceSummary(probe);
    log.warn(
      `WeChat session needs a new login (verdict=${probe.verdict}, consecutive=${probe.consecutiveFailures}/${probe.threshold}, evidence=${probe.evidence})`,
    );

    const waitSec = opts.waitSec ?? 900;
    const base = {
      verdict: probe.verdict,
      evidence: probe.evidence,
      consecutiveFailures: probe.consecutiveFailures,
    } as const;

    if (opts.notifyQr !== false) {
      // The timeout page carries no QR — go to the login page first.
      await goto(cdp, sess, WECHAT_URL);
      await sleep(6000);
      await captureQr(cdp, sess, opts.qrOutPath);
      const emailed = emailQrImage({
        qrPath: opts.qrOutPath,
        email: opts.email,
        env: opts.env,
        body: [
          "请在 15 分钟内用微信扫码登录公众号后台。",
          "登录后无需其他操作，服务器会继续自动发布。",
          "",
          "—— 探测证据（用于区分「误判」与「真实失效」）——",
          summary,
        ].join("\n"),
      });
      if (waitSec <= 0) {
        return {
          ...base,
          ok: false,
          detail: `QR captured (no wait requested) · ${summary}`,
          qrPath: opts.qrOutPath,
          emailed,
        };
      }
      const scanned = await waitForScan({
        cdp,
        sess,
        waitSec,
        qrOutPath: opts.qrOutPath,
        email: opts.email,
        env: opts.env,
      });
      if (scanned.ok) resetFailureCount(stateFile, "qr-scan-ok");
      return {
        ...base,
        ok: scanned.ok,
        detail: `${scanned.detail} · ${summary}`,
        qrPath: opts.qrOutPath,
        emailed: emailed || scanned.ok,
      };
    }

    const scanned = await waitForScan({
      cdp,
      sess,
      waitSec,
      qrOutPath: opts.qrOutPath,
      email: opts.email,
      env: opts.env,
    });
    if (scanned.ok) resetFailureCount(stateFile, "qr-scan-ok");
    return {
      ...base,
      ok: scanned.ok,
      detail: `${scanned.detail} · ${summary}`,
      qrPath: opts.qrOutPath,
    };
  } catch (err) {
    return {
      ok: false,
      verdict: "unknown",
      detail: `login check failed: ${err instanceof Error ? err.message : String(err)}`,
      consecutiveFailures: 0,
    };
  } finally {
    try {
      cdp.close();
    } catch {
      /* ignore */
    }
  }
}

export { captureQr, openWechatTab, connect, href, isLoggedInUrl, probeLogin };
