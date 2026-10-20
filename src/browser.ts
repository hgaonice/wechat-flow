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

// ---------------------------------------------------------------------------
// Ownership: who starts Chrome (C1 / R3-R4, design.md §C-2)
// ---------------------------------------------------------------------------

/**
 * `external` — a systemd unit (`wechat-browser@<alias>.service`) owns Chrome.
 *   `ensureBrowser` only starts that unit and waits for CDP; it never spawns a
 *   process. Restarting/redeploying the console therefore cannot touch the
 *   browser, and the renderers no longer live in an SSH session scope (E4).
 *
 * `inline` — legacy behaviour: the caller spawns Chrome `detached`. Kept as the
 *   one-flag rollback (`WFC_BROWSER_MODE=inline`) and as the default on a host
 *   that has no browser unit (developer machines).
 */
export type BrowserMode = "external" | "inline";

/** systemd instance name. One unit per alias = the hard "single instance" rule. */
export function browserUnit(alias: string): string {
  return `wechat-browser@${alias}.service`;
}

export interface SystemctlOutcome {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

function systemctl(args: string[], timeoutMs = 20_000): SystemctlOutcome {
  const r = spawnSync("systemctl", args, { encoding: "utf8", timeout: timeoutMs });
  return {
    status: r.status,
    stdout: (r.stdout ?? "").trim(),
    stderr: (r.stderr ?? "").trim(),
    ...(r.error ? { error: r.error.message } : {}),
  };
}

/** Does the unit exist on this host? (`cat` also resolves template instances.) */
export function unitInstalled(unit: string): boolean {
  return systemctl(["cat", unit, "--no-pager"], 5_000).status === 0;
}

/** Is the unit active right now? A missing unit / no systemd = false, never throws. */
export function unitActive(unit: string): boolean {
  return systemctl(["is-active", "--quiet", unit], 5_000).status === 0;
}

function summarize(r: SystemctlOutcome): string {
  const text = (r.stderr || r.stdout || r.error || "(no output)").split("\n").slice(0, 4).join(" / ");
  return `exit ${r.status ?? "?"} · ${text}`;
}

export interface BrowserModeInfo {
  mode: BrowserMode;
  /** `env` = explicit `WFC_BROWSER_MODE`; `auto` = decided by unit presence. */
  source: "env" | "auto";
  /** True when `WFC_BROWSER_MODE` held something that is neither external nor inline. */
  invalid?: boolean;
  /** Whether `wechat-browser@<alias>.service` exists on this host (undefined for inline). */
  unitPresent?: boolean;
  /** One line for `doctor` / logs. */
  detail: string;
}

/**
 * Decide who owns Chrome.
 *
 * `WFC_BROWSER_MODE=external|inline` always wins (explicit opt-in/rollback).
 * Otherwise auto-detect: unit present → external, else inline. That keeps 250 on
 * the managed browser without a second config file, and developer machines on
 * the legacy spawn without installing units.
 *
 * `probe` is injectable so the decision is unit-testable without systemd.
 */
export function describeBrowserMode(
  alias: string,
  env: NodeJS.ProcessEnv = process.env,
  probe: (unit: string) => boolean = unitInstalled,
): BrowserModeInfo {
  const unit = browserUnit(alias);
  const raw = String(env.WFC_BROWSER_MODE ?? "").trim().toLowerCase();
  if (raw === "external") {
    // Explicit external still has to exist on this host; `ensureBrowser` would
    // refuse to run, so surface it in `doctor` instead of at publish time.
    const present = probe(unit);
    return {
      mode: raw,
      source: "env",
      unitPresent: present,
      detail: `external（WFC_BROWSER_MODE）· unit ${unit} ${present ? "存在" : "不存在（ensureBrowser 会直接报错，先 bash deploy/systemd/install-browser-units.sh）"}`,
    };
  }
  if (raw === "inline") {
    return { mode: raw, source: "env", detail: `${raw}（WFC_BROWSER_MODE）· unit ${unit}（不使用）` };
  }
  if (raw) {
    // Fail visible: a typo must not silently pick one of the two behaviours.
    return {
      mode: "inline",
      source: "env",
      invalid: true,
      detail: `WFC_BROWSER_MODE="${env.WFC_BROWSER_MODE}" 非法（只接受 external|inline）→ 本次按 inline 运行`,
    };
  }
  const installed = probe(unit);
  return {
    mode: installed ? "external" : "inline",
    source: "auto",
    unitPresent: installed,
    detail: installed
      ? `external（自动：检测到 ${unit}）· unit ${unit}`
      : `inline（自动：本机没有 ${unit}）`,
  };
}

/** Strict variant used by `ensureBrowser`: a bogus env value is an error, not a guess. */
export function resolveBrowserMode(alias: string, env: NodeJS.ProcessEnv = process.env): BrowserMode {
  const info = describeBrowserMode(alias, env);
  if (info.invalid) {
    throw new Error(
      `WFC_BROWSER_MODE="${env.WFC_BROWSER_MODE}" 非法（只接受 external|inline）—— ` +
        `external = systemd 托管 Chrome，inline = console 自己 spawn`,
    );
  }
  return info.mode;
}

/**
 * The ONE place Chrome flags live (design §C-2).
 *
 * `wechat-browser@.service` calls `src/browser-agent.ts`, which calls this — the
 * unit file must never duplicate these flags: any drift changes the UA/platform
 * fingerprint Chrome presents to WeChat MP, and MP treats a changed fingerprint
 * as a suspicious login (QR rescan / kick-out).
 *
 * Byte-for-byte identical to the pre-C1 inline spawn (2026-10-20), only the
 * profile variable moved out of `ensureChrome`.
 */
export function buildChromeArgs(cfg: BrowserConfig, alias: string, profileDir: string): string[] {
  // `alias` is only the fallback identity when a caller hands us an empty dir
  // (profiles are per alias — see directory-structure.md).
  const profile = profileDir || resolveProfileDir(cfg, alias);
  return [
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
  ];
}

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
  // Remove stale singleton locks left by an uncleanly-killed Chrome. Inline only:
  // under systemd the unit is the sole owner, so deleting a *live* lock would let
  // a second instance grab the same profile (WeChat kicks us out for that).
  for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    try {
      fs.rmSync(path.join(profile, f), { force: true, recursive: true });
    } catch {
      /* ignore */
    }
  }
  log.info(`browser: launching Chrome (port ${cfg.cdpPort}, profile ${profile})`);
  const child = spawn(cfg.chromePath, buildChromeArgs(cfg, account, profile), {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, DISPLAY: cfg.display },
  });
  child.unref();
  for (let i = 0; i < 60; i++) {
    if (await cdpVersion(cfg.cdpPort)) return;
    await sleep(500);
  }
  throw new Error(`Chrome CDP on port ${cfg.cdpPort} did not start`);
}

export interface EnsureBrowserOptions {
  /** Force a mode (tests). Defaults to `resolveBrowserMode(account)`. */
  mode?: BrowserMode;
  env?: NodeJS.ProcessEnv;
  /** external: how long to wait for CDP after `systemctl start` (default 30s). */
  readyTimeoutSec?: number;
  /** external: injected in tests (defaults to `spawnSync systemctl`). */
  exec?: (cmd: string, args: string[], timeoutMs?: number) => SystemctlOutcome;
}

/**
 * external: the unit owns Chrome — start it and wait for CDP, never spawn.
 *
 * Failing loudly is deliberate: silently falling back to `spawn` would start a
 * SECOND Chrome on the same profile while the unit's Chrome is alive, and WeChat
 * treats that as an abnormal login (kick-out + forced QR).
 */
async function ensureBrowserExternal(cfg: BrowserConfig, account: string, opts: EnsureBrowserOptions): Promise<void> {
  if (await cdpVersion(cfg.cdpPort)) return;
  const unit = browserUnit(account);
  const readySec = opts.readyTimeoutSec ?? 30;
  const run = opts.exec ?? ((cmd, args, timeoutMs) => {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs ?? 20_000 });
    return {
      status: r.status,
      stdout: (r.stdout ?? "").trim(),
      stderr: (r.stderr ?? "").trim(),
      ...(r.error ? { error: r.error.message } : {}),
    };
  });

  const installed = run("systemctl", ["cat", unit, "--no-pager"], 5_000);
  if (installed.status !== 0) {
    throw new Error(
      `WFC_BROWSER_MODE=external 但本机没有 ${unit}（${summarize(installed)}）—— ` +
        `先安装 unit（bash deploy/systemd/install-browser-units.sh）并 systemctl enable --now ${unit}；` +
        `或临时回滚：WFC_BROWSER_MODE=inline`,
    );
  }

  log.info(`browser: systemctl start ${unit} (CDP :${cfg.cdpPort})`);
  const started = run("systemctl", ["start", unit], 60_000);
  if (started.status !== 0) {
    throw new Error(
      `systemctl start ${unit} 失败（${summarize(started)}）—— 不自动回退 spawn（会造成双实例）；` +
        `排查：systemctl status ${unit} / journalctl -u ${unit} -n 50`,
    );
  }

  const deadline = Date.now() + readySec * 1000;
  while (Date.now() < deadline) {
    if (await cdpVersion(cfg.cdpPort)) {
      log.info(`browser: CDP :${cfg.cdpPort} ready (${unit})`);
      return;
    }
    await sleep(500);
  }
  const status = run("systemctl", ["status", unit, "--no-pager", "--lines=5"], 10_000);
  throw new Error(
    `systemctl start ${unit} 成功但 CDP :${cfg.cdpPort} 在 ${readySec}s 内未就绪 —— ${summarize(status)}`,
  );
}

/** inline: legacy spawn, but refuse to run next to the managed unit. */
async function ensureBrowserInline(cfg: BrowserConfig, account: string, opts: EnsureBrowserOptions): Promise<void> {
  const unit = browserUnit(account);
  const run = opts.exec;
  const active = run ? run("systemctl", ["is-active", "--quiet", unit], 5_000).status === 0 : unitActive(unit);
  if (active) {
    throw new Error(
      `拒绝 inline 方式 spawn Chrome：${unit} 正在运行（每 alias 只允许一个浏览器实例，` +
        `同 profile 双开会把公众号踢下线）—— 改用 WFC_BROWSER_MODE=external，或先 systemctl stop ${unit}`,
    );
  }
  await ensureDisplay(cfg);
  await ensureChrome(cfg, account);
}

/**
 * Make sure a CDP-reachable Chrome exists for `account`. Returns the mode used.
 *
 * E1/E2 established that restarting the console never killed Chrome; the real
 * structural risk was that Chrome's renderers lived in an SSH login scope (E4)
 * and that nothing prevented a second instance. `external` fixes both.
 */
export async function ensureBrowser(
  cfg: BrowserConfig,
  account: string,
  opts: EnsureBrowserOptions = {},
): Promise<BrowserMode> {
  const mode = opts.mode ?? resolveBrowserMode(account, opts.env);
  if (mode === "external") {
    await ensureBrowserExternal(cfg, account, opts);
    return mode;
  }
  await ensureBrowserInline(cfg, account, opts);
  return mode;
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
