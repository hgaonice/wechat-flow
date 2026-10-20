#!/usr/bin/env bun
/**
 * browser-selftest.ts — 浏览器归属（external/inline）与 Chrome 参数自测（零依赖，bun 直跑）。
 *
 *   bun tools/browser-selftest.ts
 *
 * 覆盖 C1 Step 5（design §C-2）：
 *   1) buildChromeArgs：逐字锁定 Chrome 参数表（指纹不能漂移 —— 任何增删改都要在
 *      这里显式改期望值，否则微信会当成异常登录）
 *   2) describeBrowserMode：env 优先 / 非法值 / 未设置时按 unit 存在性自动判定
 *   3) resolveBrowserMode：非法 env 必须抛错，不能猜
 *   4) ensureBrowser(external)：CDP 已通 → 不碰 systemctl；unit 缺失 / start 失败 →
 *      抛明确错误且**绝不**回退 spawn
 *   5) ensureBrowser(inline)：unit active 时拒绝 spawn（防同 profile 双开被踢线）
 *
 * 全程不启动浏览器（systemctl 调用注入），失败退出码 1。
 */
import http from "node:http";
import {
  buildChromeArgs,
  browserUnit,
  describeBrowserMode,
  ensureBrowser,
  resolveBrowserMode,
  type BrowserConfig,
  type SystemctlOutcome,
} from "../src/browser.ts";

let failures = 0;
function check(name: string, cond: boolean, extra?: string): void {
  if (cond) {
    console.log(`PASS ${name}`);
  } else {
    failures++;
    console.log(`FAIL ${name}${extra ? " — " + extra : ""}`);
  }
}

const cfg: BrowserConfig = {
  display: ":99",
  cdpPort: 19222, // unused on purpose: nothing must be listening here
  chromePath: "/usr/bin/google-chrome",
  width: 1920,
  height: 1080,
  loginWaitSec: 900,
};

// ------------------------------------------------- 1) Chrome 参数逐字锁定
{
  const expected = [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    "--disable-infobars",
    "--remote-debugging-port=19222",
    "--remote-debugging-address=127.0.0.1",
    "--user-data-dir=/tmp/wfc-profile-second",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
    "--start-maximized",
    "--window-size=1920,1080",
    "about:blank",
  ];
  const got = buildChromeArgs(cfg, "second", "/tmp/wfc-profile-second");
  check("1a-chrome-args-verbatim", JSON.stringify(got) === JSON.stringify(expected), JSON.stringify(got));
  check("1b-chrome-args-count", got.length === expected.length, `${got.length} vs ${expected.length}`);
  // empty profileDir falls back to the per-alias canonical profile (never a shared one)
  check(
    "1c-chrome-args-profile-fallback",
    buildChromeArgs(cfg, "gaoh", "").includes("--user-data-dir=/root/.local/share/baoyu-skills/wechat-gaoh"),
  );
}

// ------------------------------------------------- 2) 模式判定
{
  const unit = browserUnit("second");
  check("2a-unit-name", unit === "wechat-browser@second.service", unit);

  const ext = describeBrowserMode("second", { WFC_BROWSER_MODE: "external" }, () => false);
  check("2b-env-external-wins", ext.mode === "external" && ext.source === "env", JSON.stringify(ext));

  const inl = describeBrowserMode("second", { WFC_BROWSER_MODE: "INLINE" }, () => true);
  check("2c-env-inline-wins-over-unit", inl.mode === "inline" && inl.source === "env", JSON.stringify(inl));

  const bad = describeBrowserMode("second", { WFC_BROWSER_MODE: "externl" }, () => true);
  check("2d-invalid-env-flagged", bad.invalid === true && bad.mode === "inline", JSON.stringify(bad));

  const autoExt = describeBrowserMode("second", {}, () => true);
  check("2e-auto-external-when-unit-present", autoExt.mode === "external" && autoExt.source === "auto", JSON.stringify(autoExt));

  const autoInl = describeBrowserMode("second", {}, () => false);
  check("2f-auto-inline-when-no-unit", autoInl.mode === "inline" && autoInl.source === "auto", JSON.stringify(autoInl));
}

// ------------------------------------------------- 3) 严格解析
{
  check("3a-resolve-external", resolveBrowserMode("second", { WFC_BROWSER_MODE: "external" }) === "external");
  let threw = "";
  try {
    resolveBrowserMode("second", { WFC_BROWSER_MODE: "systemd" });
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  check("3b-resolve-invalid-throws", threw.includes("非法"), threw);
}

// ------------------------------------------------- 4) ensureBrowser(external)
{
  // 4a: CDP already reachable → no systemctl call at all.
  const calls: string[][] = [];
  const exec = (_cmd: string, args: string[]): SystemctlOutcome => {
    calls.push(args);
    return { status: 0, stdout: "", stderr: "" };
  };
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ Browser: "Chrome/mock" }));
  });
  await new Promise<void>((r) => server.listen(19222, "127.0.0.1", r));
  const mode = await ensureBrowser(
    { ...cfg, chromePath: "/bin/false" },
    "second",
    { mode: "external", exec, readyTimeoutSec: 1 },
  );
  server.close();
  check("4a-external-cdp-up-returns-mode", mode === "external", mode);
  check("4a-external-cdp-up-no-systemctl", calls.length === 0, JSON.stringify(calls));

  // 4b: unit not installed → explicit error, no start, no spawn.
  const calls2: string[][] = [];
  let err2 = "";
  try {
    await ensureBrowser(cfg, "second", {
      mode: "external",
      readyTimeoutSec: 1,
      exec: (_cmd, args) => {
        calls2.push(args);
        return { status: 1, stdout: "", stderr: `No files found for ${browserUnit("second")}.` };
      },
    });
  } catch (err) {
    err2 = err instanceof Error ? err.message : String(err);
  }
  check("4b-external-no-unit-throws", err2.includes("没有") && err2.includes("WFC_BROWSER_MODE=inline"), err2);
  check("4b-external-no-unit-never-starts", !calls2.some((a) => a[0] === "start"), JSON.stringify(calls2));

  // 4c: systemctl start fails → explicit error mentioning "不自动回退 spawn".
  let err3 = "";
  try {
    await ensureBrowser(cfg, "second", {
      mode: "external",
      readyTimeoutSec: 1,
      exec: (_cmd, args) => {
        if (args[0] === "cat") return { status: 0, stdout: "[Unit] …", stderr: "" };
        return { status: 1, stdout: "", stderr: "Job failed: Failed to start" };
      },
    });
  } catch (err) {
    err3 = err instanceof Error ? err.message : String(err);
  }
  check("4c-external-start-failure-throws", err3.includes("不自动回退 spawn"), err3);

  // 4d: start "succeeds" but CDP never comes up → timeout error with systemctl status.
  let err4 = "";
  try {
    await ensureBrowser(cfg, "second", {
      mode: "external",
      readyTimeoutSec: 1,
      exec: (_cmd, args) => {
        if (args[0] === "status") return { status: 3, stdout: "Active: activating", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });
  } catch (err) {
    err4 = err instanceof Error ? err.message : String(err);
  }
  check("4d-external-cdp-timeout-throws", err4.includes("未就绪"), err4);
}

// ------------------------------------------------- 5) ensureBrowser(inline) 守卫
{
  let err = "";
  try {
    // display/chromePath are deliberately unusable: the guard must fire BEFORE any
    // Xvfb/Chrome work (an error mentioning Xvfb or CDP would mean it did not).
    await ensureBrowser({ ...cfg, chromePath: "/bin/false", display: ":does-not-exist" }, "second", {
      mode: "inline",
      exec: (_cmd, args) => {
        // `systemctl is-active --quiet <unit>` → active
        return args[0] === "is-active" ? { status: 0, stdout: "", stderr: "" } : { status: 1, stdout: "", stderr: "" };
      },
    });
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }
  check("5a-inline-refuses-when-unit-active", err.includes("拒绝 inline"), err);
  check("5b-inline-guard-runs-before-xvfb", !err.includes("Xvfb") && !err.includes("Chrome CDP"), err);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
