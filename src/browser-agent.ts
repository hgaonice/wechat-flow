#!/usr/bin/env bun
/**
 * Chrome front-end for `wechat-browser@<alias>.service` (C1 / design.md §C-2).
 *
 * Why a launcher instead of `ExecStart=/usr/bin/google-chrome …` in the unit:
 * Chrome's flags must live in exactly ONE place (`src/browser.ts#buildChromeArgs`).
 * Duplicating them in a unit file means two sources that silently drift, and a
 * drifted flag (`--user-data-dir`, window size, automation flag, …) changes the
 * fingerprint/chrome://version surface WeChat MP sees — which is how the account
 * ends up kicked out and demanding a QR rescan.
 *
 * The process is replaced by Chrome (`execve`) so that systemd's MainPID *is*
 * Chrome: `KillMode=mixed` then SIGTERMs Chrome itself first, giving it time to
 * flush its Cookies SQLite (a cgroup-wide SIGKILL would not).
 *
 * Usage: bun src/browser-agent.ts --account <alias>
 */

import { loadConfig } from "./config.ts";
import { buildChromeArgs, cdpVersion, resolveProfileDir } from "./browser.ts";

const USAGE = "usage: bun src/browser-agent.ts --account <alias>";

interface ExecveCapable {
  execve?: (file: string, args: string[], env: Record<string, string | undefined>) => never;
}

function fail(msg: string): never {
  console.error(`[browser-agent] ${msg}`);
  process.exit(1);
}

/** Quote for the log line only (never used to build argv). */
function shellish(args: string[]): string {
  return args.map((a) => (/[^\w@%+=:,./-]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a)).join(" ");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let alias = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--account" || a === "-a") {
      alias = argv[++i] ?? "";
    } else if (a.startsWith("--account=")) {
      alias = a.slice("--account=".length);
    } else if (a === "-h" || a === "--help") {
      console.log(USAGE);
      return;
    } else {
      fail(`未知参数 ${a} —— ${USAGE}`);
    }
  }
  if (!alias) fail(`缺少 --account <alias> —— ${USAGE}`);

  let cfg;
  try {
    cfg = loadConfig(alias);
  } catch (err) {
    fail(`读取账号配置失败（alias=${alias}）：${err instanceof Error ? err.message : String(err)}`);
  }
  if (cfg.publishMethod !== "browser") {
    // An api-method account has no browser session; starting Chrome for it would
    // create a second logged-in browser nobody asked for.
    fail(`账号 ${cfg.account} 的 publishMethod=${cfg.publishMethod}（非 browser）—— 该 alias 不需要浏览器，不要 enable 本 unit`);
  }

  const port = cfg.browser.cdpPort;
  const profileDir = resolveProfileDir(cfg.browser, cfg.account);

  // Port guard: never become the second instance on one profile. WeChat treats
  // two simultaneous logins as an abnormal login and kicks the session.
  if (await cdpVersion(port, 2000)) {
    console.warn(
      `[browser-agent] CDP :${port} 已在监听 —— 已有一个 Chrome 在此端口，拒绝启动第二个实例。\n` +
        `[browser-agent] 若那是迁移前的裸 Chrome（不在本 unit 内），先 systemctl stop 它/结束该进程，` +
        `再 systemctl restart wechat-browser@${cfg.account}；否则 console 会把它当成受管浏览器。`,
    );
    // Clean exit + `RestartPreventExitStatus=0` in the unit = no restart loop.
    process.exit(0);
  }

  const args = buildChromeArgs(cfg.browser, cfg.account, profileDir);
  const env: Record<string, string | undefined> = {
    ...process.env,
    // The unit sets this; fall back to config so a manual run behaves the same.
    DISPLAY: process.env.DISPLAY || cfg.browser.display,
  };

  console.log(
    `[browser-agent] account=${cfg.account} cdp=:${port} profile=${profileDir}\n` +
      `[browser-agent] exec ${shellish([cfg.browser.chromePath, ...args])}`,
  );

  const ex = (process as unknown as ExecveCapable).execve;
  if (typeof ex === "function") {
    // Replaces this process: systemd's MainPID becomes Chrome (see header).
    ex(cfg.browser.chromePath, [cfg.browser.chromePath, ...args], env);
    fail(`execve ${cfg.browser.chromePath} 返回了（应当永不返回）`);
  }

  // bun < 1.1 has no process.execve(). Fall back to a foreground proxy that
  // forwards signals, so `systemctl stop` still reaches Chrome as SIGTERM.
  console.warn("[browser-agent] 本机 bun 不支持 process.execve() → 用前台代理模式（信号转发）");
  const { spawn } = await import("node:child_process");
  const child = spawn(cfg.browser.chromePath, args, { stdio: "inherit", env });
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(sig, () => child.kill(sig));
  }
  child.on("error", (err) => fail(`启动 Chrome 失败：${err.message}`));
  child.on("exit", (code, signal) => {
    if (signal) console.error(`[browser-agent] Chrome 被信号 ${signal} 终止`);
    process.exit(code ?? (signal ? 143 : 1));
  });
}

await main();
