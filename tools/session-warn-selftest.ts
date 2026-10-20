#!/usr/bin/env bun
/**
 * session-warn-selftest.ts — 到期预警邮件的闸门与状态机（零依赖，bun 直跑）。
 *
 *   bun tools/session-warn-selftest.ts
 *
 * 覆盖 C1 Step 3.3 / design §C-4（R2/R6）：
 *   1) 剩余 > 24h → 不发
 *   2) 到期时间未知（读不到 cookie / session cookie）→ 不发且说明原因
 *   3) email 未启用 → 不发且说明原因
 *   4) 剩余 < 24h + 24h 内没发过 → 闸门打开（dry-run 只判定不发送）
 *   5) 24h 内已发过 → 抑制（最多一封/24h）
 *   6) 状态文件读坏 → 退化为“多发一封”，绝不抛异常
 *   7) 预警文案与失败/扫码邮件**用词不同**（标题含 ⏳ + “非失败”）
 * 全程 dry-run / 预置状态文件，**不发任何邮件、不触碰真 data 目录**。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWriteJson } from "../src/state.ts";
import type { EmailConfig } from "../src/mailer.ts";
import {
  WARN_INTERVAL_HOURS,
  WARN_THRESHOLD_HOURS,
  maybeWarnExpiringSession,
  readWarnState,
  warnStateFile,
} from "../src/session-warn.ts";

let failures = 0;
function check(name: string, cond: boolean, extra?: string): void {
  if (cond) console.log(`PASS ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}${extra ? " — " + extra : ""}`);
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-warn-selftest-"));
const dataDir = path.join(root, "data", "acct");
const nowMs = Date.parse("2026-10-20T08:00:00Z");
const hoursFromNow = (h: number) => Math.floor(nowMs / 1000 + h * 3600);
const emailOn: EmailConfig = { enabled: true, to: ["ops@example.com"] , skill: { dir: "/nonexistent" } };
const base = { dataDir, alias: "acct", accountName: "测试号", now: nowMs, dryRun: true };

// 1) 剩余充足
{
  const r = await maybeWarnExpiringSession({ ...base, slaveSidExpiresAt: hoursFromNow(96), email: emailOn });
  check("1-not-due", r.sent === false && /> 24h/.test(r.reason), r.reason);
  check("1b-hours-left", Math.round(r.hoursLeft ?? 0) === 96, String(r.hoursLeft));
}

// 2) 到期未知
{
  const r = await maybeWarnExpiringSession({ ...base, email: emailOn });
  check("2-unknown-expiry", r.sent === false && /未知/.test(r.reason), r.reason);
}

// 3) email 未启用
{
  const r = await maybeWarnExpiringSession({
    ...base,
    slaveSidExpiresAt: hoursFromNow(5),
    email: { enabled: false, skill: { dir: "/nonexistent" } },
  });
  check("3-email-disabled", r.sent === false && /email/.test(r.reason), r.reason);
  const r2 = await maybeWarnExpiringSession({ ...base, slaveSidExpiresAt: hoursFromNow(5) });
  check("3b-email-missing", r2.sent === false && /email/.test(r2.reason), r2.reason);
}

// 4) 闸门打开（dry-run 不真发）
{
  const r = await maybeWarnExpiringSession({ ...base, slaveSidExpiresAt: hoursFromNow(5), email: emailOn });
  check("4-would-warn", r.sent === false && /dry-run：本应发送预警/.test(r.reason), r.reason);
  check("4b-hours-left", (r.hoursLeft ?? 0).toFixed(1) === "5.0", String(r.hoursLeft));
  check("4c-threshold-const", WARN_THRESHOLD_HOURS === 24);
}

// 5) 24h 内已发过 → 抑制
{
  const file = warnStateFile(dataDir);
  atomicWriteJson(file, { lastWarnAt: new Date(nowMs - 3600_000).toISOString(), hoursLeft: 5 });
  const r = await maybeWarnExpiringSession({ ...base, slaveSidExpiresAt: hoursFromNow(5), email: emailOn });
  check("5-throttled", r.sent === false && /已预警/.test(r.reason), r.reason);
  check("5b-throttle-hours", WARN_INTERVAL_HOURS === 24 && Math.round(Number(/^([\d.]+)h 前/.exec(r.reason)?.[1])) === 1, r.reason);

  // 刚好超过 24h → 闸门重新打开
  atomicWriteJson(file, { lastWarnAt: new Date(nowMs - 25 * 3600_000).toISOString(), hoursLeft: 5 });
  const r2 = await maybeWarnExpiringSession({ ...base, slaveSidExpiresAt: hoursFromNow(5), email: emailOn });
  check("5c-reopened", /dry-run：本应发送预警/.test(r2.reason), r2.reason);
}

// 6) 状态文件读坏 → 退化为多发一封，不抛
{
  const file = warnStateFile(dataDir);
  fs.writeFileSync(file, "{not json");
  check("6-corrupt-state-degrades", JSON.stringify(readWarnState(file)) === "{}");
  const r = await maybeWarnExpiringSession({ ...base, slaveSidExpiresAt: hoursFromNow(3), email: emailOn });
  check("6b-corrupt-state-still-warns", /dry-run：本应发送预警/.test(r.reason), r.reason);
  check("6c-missing-state", JSON.stringify(readWarnState(path.join(root, "nope.json"))) === "{}");
}

// 7) 文案与失败邮件不同（截取 subject/body 的构造，dry-run 下不发送）
{
  const file = warnStateFile(dataDir);
  fs.rmSync(file, { force: true });
  const src = fs.readFileSync(new URL("../src/session-warn.ts", import.meta.url), "utf8");
  check("7-subject-marked-advisory", src.includes("⏳ 公众号会话票据将在") && src.includes("（提前预警，非失败）"));
  check("7b-subject-has-no-failure-wording", !src.includes("会话失效") && !src.includes("需要重新扫码"));
  check("7c-body-explicit-not-failure", src.includes("这只是一封提前预警，不是发布失败"));
  check("7d-warn-state-path", warnStateFile("/x/y") === "/x/y/state/session-warn.json");
}

fs.rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
