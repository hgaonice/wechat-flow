import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ensureBrowser, type BrowserConfig } from "./browser.ts";
import { APP_DIR } from "./config.ts";
import { log } from "./log.ts";

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

async function openWechatTab(cdp: Cdp, create: boolean): Promise<{ sessionId: string } | null> {
  const targets = await cdp.send("Target.getTargets");
  let tab = targets.targetInfos.find((t: any) => t.type === "page" && t.url.includes("mp.weixin.qq.com"));
  if (!tab && create) {
    const created = await cdp.send("Target.createTarget", { url: WECHAT_URL });
    await sleep(2500);
    const t2 = await cdp.send("Target.getTargets");
    tab =
      t2.targetInfos.find((t: any) => t.targetId === created.targetId) ??
      t2.targetInfos.find((t: any) => t.url.includes("mp.weixin.qq.com"));
  }
  if (!tab) return null;
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: tab.targetId, flatten: true });
  return { sessionId };
}

function isLoggedInUrl(url: string): boolean {
  return /token=\d+/.test(url) || url.includes("/cgi-bin/home");
}

async function href(cdp: Cdp, sess: { sessionId: string }): Promise<string> {
  return String((await evalValue(cdp, sess, "window.location.href")) ?? "");
}

/** Screenshot just the login QR element (crisp + auto-cropped). */
async function captureQr(cdp: Cdp, sess: { sessionId: string }, outPath: string): Promise<void> {
  const raw = await evalValue(
    cdp,
    sess,
    `(function(){
       var els = Array.prototype.slice.call(document.querySelectorAll('img, canvas'));
       var best = null;
       for (var i = 0; i < els.length; i++) {
         var rc = els[i].getBoundingClientRect();
         if (rc.width >= 120 && rc.width <= 400 && Math.abs(rc.width - rc.height) < 24) {
           if (!best || rc.width > best.width) best = rc;
         }
       }
       if (!best) return null;
       return JSON.stringify({ x: best.x, y: best.y, width: best.width, height: best.height });
     })()`,
  );
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  let params: Record<string, unknown> = { format: "png" };
  if (raw) {
    const rect = JSON.parse(String(raw));
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
    fs.writeFileSync(outPath, Buffer.from(shot.data, "base64"));
  } catch (err) {
    log.warn(`QR screenshot failed: ${err instanceof Error ? err.message : String(err)}`);
  }
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
  const subject = `${opts.email.subjectPrefix ?? ""}公众号登录二维码（请扫码）`;
  const body =
    opts.body ??
    "请在 15 分钟内用微信扫码登录公众号后台。\n登录后无需其他操作，服务器会继续自动发布。";
  const args = [script, "-i", opts.qrPath, "-s", subject, "-b", body];
  const r = spawnSync("python3", args, { encoding: "utf8", env: { ...process.env, ...opts.env } });
  if (r.status === 0) {
    log.info(`QR emailed: ${(r.stdout || "").trim()}`);
    return true;
  }
  log.error(`QR email failed: ${(r.stderr || r.stdout || "").slice(-300)}`);
  return false;
}

export interface EnsureLoginOptions {
  browser: BrowserConfig;
  skillDir: string;
  account: string;
  email?: EmailCfg;
  qrOutPath: string;
  env?: Record<string, string | undefined>;
  waitSec?: number;
  /** Capture + email the QR when logged out (default true). */
  notifyQr?: boolean;
}

export interface EnsureLoginResult {
  ok: boolean;
  detail: string;
  qrPath?: string;
  emailed?: boolean;
}

/**
 * Make sure we have a logged-in MP session in the app-managed Chrome.
 * If not, screenshot the QR, email it, and poll until the user scans.
 */
export async function ensureLoggedIn(opts: EnsureLoginOptions): Promise<EnsureLoginResult> {
  await ensureBrowser(opts.browser, opts.account);
  const cdp = await connect(opts.browser, opts.skillDir);
  try {
    const sess = await openWechatTab(cdp, true);
    if (!sess) return { ok: false, detail: "could not open mp.weixin.qq.com" };

    const url0 = await href(cdp, sess);
    if (isLoggedInUrl(url0)) return { ok: true, detail: "session valid" };

    // A cold Chrome start needs a few seconds before the MP backend restores
    // its session; only treat the session as expired once this grace period
    // has elapsed without a token in the URL.
    let url = url0;
    const graceMs = 20_000;
    const g0 = Date.now();
    while (Date.now() - g0 < graceMs) {
      await sleep(1500);
      url = await href(cdp, sess);
      if (isLoggedInUrl(url)) return { ok: true, detail: "session valid" };
    }

    log.warn(`WeChat session expired (url: ${url.slice(0, 80)}) — requesting a new login`);

    const waitSec = opts.waitSec ?? 900;

    if (opts.notifyQr !== false) {
      await captureQr(cdp, sess, opts.qrOutPath);
      const emailed = emailQrImage({ qrPath: opts.qrOutPath, email: opts.email, env: opts.env });
      if (waitSec <= 0) {
        return { ok: false, detail: "QR captured (no wait requested)", qrPath: opts.qrOutPath, emailed };
      }
      const t0 = Date.now();
      while (Date.now() - t0 < waitSec * 1000) {
        if (isLoggedInUrl(await href(cdp, sess))) {
          return { ok: true, detail: "logged in after QR scan", qrPath: opts.qrOutPath, emailed };
        }
        await sleep(3000);
      }
      return { ok: false, detail: `login timeout after ${waitSec}s (QR not scanned)`, qrPath: opts.qrOutPath, emailed };
    }

    const t0 = Date.now();
    while (Date.now() - t0 < waitSec * 1000) {
      if (isLoggedInUrl(await href(cdp, sess))) return { ok: true, detail: "logged in after QR scan" };
      await sleep(3000);
    }
    return { ok: false, detail: `login timeout after ${waitSec}s (QR not scanned)` };
  } catch (err) {
    return { ok: false, detail: `login check failed: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    try {
      cdp.close();
    } catch {
      /* ignore */
    }
  }
}

export { captureQr, openWechatTab, connect, href, isLoggedInUrl };
