import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { log } from "./log.ts";

/**
 * Browser (Chrome CDP) publishing support.
 *
 * WeChat's API method is blocked by the account's IP whitelist, so the "browser"
 * method drives the WeChat MP editor in a real Chrome over the DevTools Protocol.
 * On a headless server this needs:
 *   - Xvfb  : a virtual X display (Chrome runs headed; the skill uses xdotool
 *             to send Ctrl+C / Ctrl+V against the system clipboard)
 *   - xclip : writing HTML/images to the X clipboard
 *   - xdotool: the real (non-synthetic) paste keystrokes
 *
 * Chrome is launched by us (not by the skill) so we can add `--no-sandbox`
 * (required when running as root) and pin a stable debugging port. The skill
 * then attaches with `--cdp-port`.
 */

export interface BrowserConfig {
  display: string;
  cdpPort: number;
  chromePath: string;
  /** Chrome user-data-dir; defaults to /root/.local/share/baoyu-skills/wechat-<account>. */
  profileDir?: string;
  width: number;
  height: number;
  /** Seconds to wait for the user to scan a login QR (self-heal). Default 900. */
  loginWaitSec?: number;
}

export function defaultBrowserConfig(): BrowserConfig {
  return {
    display: ":99",
    cdpPort: 9222,
    chromePath: "/usr/bin/google-chrome",
    width: 1920,
    height: 1080,
    loginWaitSec: 900,
  };
}

export function resolveProfileDir(cfg: BrowserConfig, account: string): string {
  if (cfg.profileDir) return cfg.profileDir;
  return `/root/.local/share/baoyu-skills/wechat-${account}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function xSocket(display: string): string {
  return `/tmp/.X11-unix/X${display.replace(/^:/, "")}`;
}

export function displayUp(display: string): boolean {
  // Prefer asking the X server directly (a stale socket after SIGKILL would
  // otherwise fool us into skipping Xvfb startup).
  const r = spawnSync("xdpyinfo", ["-display", display], { stdio: "ignore" });
  if (r.status === 0) return true;
  if (r.error) {
    // xdpyinfo not available: fall back to socket existence.
    return fs.existsSync(xSocket(display));
  }
  // Stale socket: clean it up so Xvfb can bind again.
  try {
    fs.rmSync(xSocket(display), { force: true });
    fs.rmSync(`/tmp/.X${display.replace(/^:/, "")}-lock`, { force: true });
  } catch {
    /* ignore */
  }
  return false;
}

export function cdpVersion(port: number, timeoutMs = 1500): Promise<string | null> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/json/version", timeout: timeoutMs },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(data.trim() || null));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
  });
}

export async function ensureDisplay(cfg: BrowserConfig): Promise<void> {
  if (displayUp(cfg.display)) return;
  log.info(`browser: starting Xvfb ${cfg.display} (${cfg.width}x${cfg.height})`);
  const child = spawn(
    "Xvfb",
    [cfg.display, "-screen", "0", `${cfg.width}x${cfg.height}x24`, "-nolisten", "tcp"],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  for (let i = 0; i < 40; i++) {
    if (displayUp(cfg.display)) return;
    await sleep(250);
  }
  throw new Error(`Xvfb ${cfg.display} did not start`);
}

export async function ensureChrome(cfg: BrowserConfig, account: string): Promise<void> {
  if (await cdpVersion(cfg.cdpPort)) return;
  const profile = resolveProfileDir(cfg, account);
  fs.mkdirSync(profile, { recursive: true });
  // Remove stale singleton locks left by an uncleanly-killed Chrome.
  for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    try {
      fs.rmSync(path.join(profile, f), { force: true, recursive: true });
    } catch {
      /* ignore */
    }
  }
  log.info(`browser: launching Chrome (port ${cfg.cdpPort}, profile ${profile})`);
  const child = spawn(
    cfg.chromePath,
    [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-session-crashed-bubble",
      "--hide-crash-restore-bubble",
      "--disable-infobars",
      `--remote-debugging-port=${cfg.cdpPort}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled",
      "--start-maximized",
      `--window-size=${cfg.width},${cfg.height}`,
      "about:blank",
    ],
    { detached: true, stdio: "ignore", env: { ...process.env, DISPLAY: cfg.display } },
  );
  child.unref();
  for (let i = 0; i < 60; i++) {
    if (await cdpVersion(cfg.cdpPort)) return;
    await sleep(500);
  }
  throw new Error(`Chrome CDP on port ${cfg.cdpPort} did not start`);
}

export async function ensureBrowser(cfg: BrowserConfig, account: string): Promise<void> {
  await ensureDisplay(cfg);
  await ensureChrome(cfg, account);
}

/** Doctor-style check for the browser publishing prerequisites. */
export function checkBrowser(cfg: BrowserConfig): { ok: boolean; detail: string } {
  const bins = ["Xvfb", "xclip", "xdotool"];
  const missing = bins.filter((b) => {
    const r = spawnSync("which", [b], { stdio: "pipe" });
    return r.status !== 0;
  });
  if (!fs.existsSync(cfg.chromePath)) {
    return { ok: false, detail: `chrome not found: ${cfg.chromePath}` };
  }
  if (missing.length) return { ok: false, detail: `missing tools: ${missing.join(", ")}` };
  return { ok: true, detail: `display ${cfg.display} · cdp :${cfg.cdpPort} · ${cfg.chromePath}` };
}
