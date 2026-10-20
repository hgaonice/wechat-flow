#!/usr/bin/env bun
/**
 * session-selftest.ts — 会话三态判定 / 抗抖动状态机 / 本地 cookie 证据 自测（零依赖，bun 直跑）。
 *
 *   bun tools/session-selftest.ts
 *
 * 覆盖 C1（design §C-1）：
 *   1) readCookieFacts 四种输入（正常 / 缺文件 / 表缺失 / 被 Chrome 锁住 BUSY）
 *   2) decideVerdict 判定表全部 5 条（含「壳页 ≠ 退登」对抗用例）
 *   3) classifyAuthResponse：只有服务端明确说「登录」才算强证据
 *   4) 连续失败计数 / ≥60s 间隔 / 阈值触发扫码 / valid 归零
 *   5) unknown 不触发扫码（AC2），WFC_SESSION_FAIL_THRESHOLD=1 可回滚旧行为
 * 全程不碰浏览器（collectPage 依赖注入），失败退出码 1。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import {
  chromeTimeToUnix,
  cookiesDbPath,
  readCookieFacts,
} from "../src/session-state.ts";
import {
  classifyAuthResponse,
  decideVerdict,
  detectPageTimeoutShell,
  evidenceLine,
  hoursSince,
  nextProbeState,
  planLoginAction,
  probeSession,
  readProbeState,
  resolveProbeSettings,
  shouldRequestScan,
  writeProbeState,
  EMPTY_PROBE_STATE,
  type PageEvidence,
  type ProbeState,
  type SessionFacts,
} from "../src/session-probe.ts";

let failures = 0;
function check(name: string, cond: boolean, extra?: string): void {
  if (cond) {
    console.log(`PASS ${name}`);
  } else {
    failures++;
    console.log(`FAIL ${name}${extra ? " — " + extra : ""}`);
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "session-selftest-"));
const CHROME_EPOCH_OFFSET_SEC = 11_644_473_600;
const nowMs = Date.now();
const chromeTime = (unixSec: number) => Math.round((unixSec + CHROME_EPOCH_OFFSET_SEC) * 1e6);

/** Build a Chrome-like Cookies SQLite file and return its profile dir. */
function makeProfile(
  name: string,
  rows: { name: string; expiresUtc: number; host?: string }[],
  opts: { skipTable?: boolean } = {},
): string {
  const dir = path.join(tmpRoot, name);
  const file = cookiesDbPath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  try {
    if (!opts.skipTable) {
      db.exec(
        `CREATE TABLE cookies(creation_utc INTEGER PRIMARY KEY, host_key TEXT, name TEXT,
           value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER)`,
      );
      let i = 1;
      for (const r of rows) {
        db.run(
          "INSERT INTO cookies(creation_utc, host_key, name, expires_utc) VALUES(?,?,?,?)",
          i++,
          r.host ?? ".weixin.qq.com",
          r.name,
          r.expiresUtc,
        );
      }
    } else {
      db.exec("CREATE TABLE unrelated(x INTEGER)");
    }
  } finally {
    db.close();
  }
  return dir;
}

// ---------------------------------------------------------------- 1) cookie 正常
const unixNow = Math.floor(nowMs / 1000);
const goodProfile = makeProfile("good", [
  { name: "slave_sid", expiresUtc: chromeTime(unixNow + 96 * 3600) },
  { name: "data_ticket", expiresUtc: chromeTime(unixNow + 96 * 3600) },
]);
const good = readCookieFacts(goodProfile);
check(
  "1-cookie-normal",
  good.ok === true &&
    good.slaveSidPresent === true &&
    typeof good.slaveSidExpiresAt === "number" &&
    Math.abs((good.slaveSidExpiresAt ?? 0) - (unixNow + 96 * 3600)) <= 2 &&
    good.dataTicketExpiresAt !== undefined,
  JSON.stringify(good),
);
check(
  "1b-cookie-chrome-time",
  chromeTimeToUnix(chromeTime(1_700_000_000)) === 1_700_000_000 &&
    chromeTimeToUnix(0) === undefined &&
    chromeTimeToUnix(null) === undefined,
);

// ---------------------------------------------------------------- 2) 文件不存在
const missing = readCookieFacts(path.join(tmpRoot, "no-such-profile"));
check(
  "2-cookie-missing-file",
  missing.ok === false && /not found/.test(missing.reason ?? ""),
  missing.reason,
);

// ---------------------------------------------------------------- 3) 表结构异常
const badSchema = readCookieFacts(makeProfile("bad-schema", [], { skipTable: true }));
check(
  "3-cookie-schema-error",
  badSchema.ok === false && /unreadable/.test(badSchema.reason ?? ""),
  badSchema.reason,
);

// ---------------------------------------------------------------- 4) BUSY（Chrome 持有写锁）
{
  const busyProfile = makeProfile("busy", [
    { name: "slave_sid", expiresUtc: chromeTime(unixNow + 96 * 3600) },
  ]);
  const locker = new Database(cookiesDbPath(busyProfile));
  locker.exec("BEGIN EXCLUSIVE");
  const t0 = Date.now();
  const busy = readCookieFacts(busyProfile, { busyTimeoutMs: 200 });
  const elapsed = Date.now() - t0;
  locker.exec("ROLLBACK");
  locker.close();
  check(
    "4-cookie-busy-degrades",
    busy.ok === false && /lock|busy/i.test(busy.reason ?? "") && elapsed < 3000,
    `${busy.reason} (${elapsed}ms)`,
  );
  // BUSY must degrade to `unknown`, never `invalid` (PRD R1).
  check(
    "4b-busy-is-not-invalid",
    decideVerdict(
      { cookie: busy, http: { ok: false }, dom: { ok: false } },
      nowMs,
    ) === "unknown",
  );
}

// ---------------------------------------------------------------- 5) 会话 cookie（expires_utc=0）
{
  const sessionCookieProfile = makeProfile("session-cookie", [
    { name: "slave_sid", expiresUtc: 0 },
  ]);
  const sc = readCookieFacts(sessionCookieProfile);
  check(
    "5-session-cookie-not-expired",
    sc.ok === true && sc.slaveSidPresent === true && sc.slaveSidExpiresAt === undefined,
    JSON.stringify(sc),
  );
}

// ---------------------------------------------------------------- 6) decideVerdict 判定表
const cookieFresh = {
  ok: true,
  slaveSidPresent: true,
  slaveSidExpiresAt: unixNow + 96 * 3600,
};
const cookieExpired = {
  ok: true,
  slaveSidPresent: true,
  slaveSidExpiresAt: unixNow - 60,
};
const cookieMissing = { ok: true, slaveSidPresent: false, reason: "cleared" };
const cookieUnreadable = { ok: false, reason: "database is locked" };
const httpOk = { ok: true, status: 200, reason: "ret=0" };
const httpUnknown = { ok: false, skipped: true, reason: "no token on page url" };
const httpLogin = { ok: false, status: 200, redirectedToLogin: true, reason: "ret=200003" };
const domIn = { ok: true, loggedIn: true, url: "https://mp.weixin.qq.com/cgi-bin/home?token=1" };
const domShell = { ok: true, loggedIn: false, pageTimeoutShell: true, url: "https://mp.weixin.qq.com/" };
const domDead = { ok: false, reason: "DOM unreachable" };

const facts = (over: Partial<SessionFacts>): SessionFacts => ({
  cookie: cookieFresh,
  http: httpUnknown,
  dom: domDead,
  ...over,
});
check("6a-cookie-expired-invalid", decideVerdict(facts({ cookie: cookieExpired, http: httpOk, dom: domIn }), nowMs) === "invalid");
check("6b-cookie-missing-invalid", decideVerdict(facts({ cookie: cookieMissing }), nowMs) === "invalid");
check("6c-http-login-redirect-invalid", decideVerdict(facts({ http: httpLogin }), nowMs) === "invalid");
check("6d-all-green-valid", decideVerdict(facts({ http: httpOk, dom: domIn }), nowMs) === "valid");
check("6e-shell-page-unknown", decideVerdict(facts({ http: httpOk, dom: domShell }), nowMs) === "unknown");
check(
  "6f-unreadable-everything-unknown",
  decideVerdict(facts({ cookie: cookieUnreadable, http: httpUnknown, dom: domDead }), nowMs) === "unknown",
);
check(
  "6g-cookie-unreadable-falls-back-to-http+dom",
  decideVerdict(facts({ cookie: cookieUnreadable, http: httpOk, dom: domIn }), nowMs) === "valid",
);
check(
  "6h-dom-loggedin-without-auth-request-unknown",
  decideVerdict(facts({ http: httpUnknown, dom: domIn }), nowMs) === "unknown",
);
check(
  "6i-shell-text-detector",
  detectPageTimeoutShell({ text: "登录超时，请重新登录" }) === true &&
    detectPageTimeoutShell({ text: "请扫码登录" }) === false &&
    detectPageTimeoutShell({ className: "page_timeout" }) === true,
);

// ---------------------------------------------------------------- 7) classifyAuthResponse
check(
  "7a-auth-ok",
  classifyAuthResponse({ kind: "http", status: 200, body: '{"base_resp":{"ret":0}}' }).ok === true,
);
check(
  "7b-auth-invalid-session-ret200003",
  classifyAuthResponse({
    kind: "http",
    status: 200,
    body: '{"base_resp":{"ret":200003,"err_msg":"invalid session"}}',
  }).redirectedToLogin === true,
);
check(
  "7c-auth-login-page-html",
  classifyAuthResponse({
    kind: "http",
    status: 200,
    finalUrl: "https://mp.weixin.qq.com/cgi-bin/loginpage?t=wxm2-login",
    body: "<html>login</html>",
  }).redirectedToLogin === true,
);
check(
  "7d-auth-network-error-not-strong",
  classifyAuthResponse({ kind: "error", error: "boom" }).redirectedToLogin === undefined,
);
check(
  "7e-auth-no-token-skipped",
  classifyAuthResponse({ kind: "no-token" }).skipped === true,
);
check(
  "7f-auth-http5xx-not-invalid",
  classifyAuthResponse({ kind: "http", status: 502, body: "bad gateway" }).redirectedToLogin === undefined,
);

// ---------------------------------------------------------------- 8) evidence 行格式
{
  const line = evidenceLine(facts({ http: httpOk, dom: domIn }), nowMs);
  check(
    "8-evidence-line-shape",
    /^cookie:.+,http:.+,dom:.+$/.test(line) && line.includes("dom:loggedin"),
    line,
  );
}

// ---------------------------------------------------------------- 9) 连续失败 / 间隔 / 阈值
const probeStateDir = path.join(tmpRoot, "state");
fs.mkdirSync(probeStateDir, { recursive: true });
const stateFile = path.join(probeStateDir, "session-probe.json");
const validProfile = makeProfile("valid-cookie", [
  { name: "slave_sid", expiresUtc: chromeTime(unixNow + 96 * 3600) },
]);
const shellPage: PageEvidence = { http: httpOk, dom: domShell };
const goodPage: PageEvidence = { http: httpOk, dom: domIn };

const runProbe = (page: PageEvidence, now: number, env: Record<string, string | undefined> = {}) =>
  probeSession({
    account: "selftest",
    profileDir: validProfile,
    stateFile,
    collectPage: async () => page,
    env,
    now: () => now,
    quiet: true,
  });

// first unknown → counted, but NOT a scan trigger (AC2)
const p1 = await runProbe(shellPage, nowMs);
check(
  "9a-first-unknown-no-scan",
  p1.verdict === "unknown" && p1.consecutiveFailures === 1 && p1.needsScan === false,
  `verdict=${p1.verdict} consecutive=${p1.consecutiveFailures} needsScan=${p1.needsScan}`,
);
check("9b-state-persisted", fs.existsSync(stateFile) && readProbeState(stateFile).consecutiveFailures === 1);

// second probe 5s later: inside the 60s window → counter must not advance
const p2 = await runProbe(shellPage, nowMs + 5_000);
check(
  "9c-rapid-repeat-not-counted",
  p2.consecutiveFailures === 1 && p2.needsScan === false,
  `consecutive=${p2.consecutiveFailures}`,
);

// spaced probes eventually cross the threshold and ask for a scan
const p3 = await runProbe(shellPage, nowMs + 70_000);
const p4 = await runProbe(shellPage, nowMs + 140_000);
check(
  "9d-threshold-triggers-scan",
  p3.consecutiveFailures === 2 && p3.needsScan === false && p4.consecutiveFailures === 3 && p4.needsScan === true,
  `p3=${p3.consecutiveFailures}/${p3.needsScan} p4=${p4.consecutiveFailures}/${p4.needsScan}`,
);

// a valid probe resets the counter
const p5 = await runProbe(goodPage, nowMs + 210_000);
check("9e-valid-resets", p5.verdict === "valid" && p5.consecutiveFailures === 0 && p5.needsScan === false);

// WFC_SESSION_FAIL_THRESHOLD=1 → rollback to the old "one failure ⇒ QR" behaviour
const env1 = { WFC_SESSION_FAIL_THRESHOLD: "1" };
check(
  "9f-threshold-env-rollback",
  resolveProbeSettings(env1).threshold === 1 &&
    shouldRequestScan("unknown", 1, resolveProbeSettings(env1).threshold) === true,
);
check(
  "9g-settings-defaults",
  resolveProbeSettings({}).threshold === 3 && resolveProbeSettings({}).minIntervalSec === 60,
);

// invalid → scan immediately, regardless of the counter
check("9h-invalid-immediate-scan", shouldRequestScan("invalid", 0, 3) === true);

// AC2 对抗用例：单次 unknown（壳页）必须走 "continue"，绝不能进入扫码/邮件分支
check(
  "9h2-single-unknown-never-scans",
  planLoginAction({ verdict: "unknown", needsScan: false }) === "continue" &&
    planLoginAction({ verdict: "invalid", needsScan: true }) === "scan" &&
    planLoginAction({ verdict: "valid", needsScan: false }) === "ok",
);

// nextProbeState pure-function invariants (no file, no clock)
{
  const prev: ProbeState = { ...EMPTY_PROBE_STATE, consecutiveFailures: 2, lastProbeAt: new Date(nowMs - 120_000).toISOString() };
  const next = nextProbeState(prev, "unknown", "e", nowMs, { minIntervalSec: 60 });
  check("9i-next-state-increments", next.consecutiveFailures === 3 && next.lastVerdict === "unknown");
  const reset = nextProbeState({ ...next }, "valid", "e", nowMs + 1000, { minIntervalSec: 60 });
  check("9j-next-state-valid-resets", reset.consecutiveFailures === 0);
  const tight = nextProbeState(prev, "unknown", "e", nowMs, { minIntervalSec: 300 });
  check("9k-next-state-respects-interval", tight.consecutiveFailures === 2);
}

// corrupt state file must not throw and must not block the probe
{
  const corruptDir = path.join(tmpRoot, "corrupt");
  fs.mkdirSync(corruptDir, { recursive: true });
  const corruptFile = path.join(corruptDir, "session-probe.json");
  fs.writeFileSync(corruptFile, "{not json");
  const st = readProbeState(corruptFile);
  check("9l-corrupt-state-tolerant", st.consecutiveFailures === 0 && st.lastVerdict === null);
  writeProbeState(corruptFile, { ...EMPTY_PROBE_STATE, consecutiveFailures: 2 });
  check("9m-state-roundtrip", readProbeState(corruptFile).consecutiveFailures === 2);
}

// ---------------------------------------------------------------- 10) 时间辅助
check("10-hours-since", Math.abs((hoursSince(new Date(nowMs - 3_600_000).toISOString(), nowMs) ?? 0) - 1) < 0.01);
check("10b-hours-since-unknown", hoursSince(undefined) === null);

// ---------------------------------------------------------------- 11) 应急闸门真的可用（复核 B1）
// 生产调用链传的 env 是 `proxyEnv(cfg)`（只有代理变量，通常为 `{}`）。若 probeSession
// 用它整体替代 process.env，文档承诺的 `WFC_SESSION_FAIL_THRESHOLD=1` 在线上就完全无效。
{
  const gateState = path.join(tmpRoot, "gate", "session-probe.json");
  process.env.WFC_SESSION_FAIL_THRESHOLD = "1";
  process.env.WFC_SESSION_FAIL_MIN_INTERVAL_SEC = "0";
  try {
    const gated = await probeSession({
      account: "gate",
      profileDir: validProfile,
      stateFile: gateState,
      collectPage: async () => shellPage,
      env: {}, // ← 生产上 proxyEnv(cfg) 在无代理账号时就是这个值
      now: () => nowMs,
      quiet: true,
    });
    check(
      "11a-threshold-env-survives-proxy-env",
      gated.threshold === 1 && gated.needsScan === true,
      `threshold=${gated.threshold} needsScan=${gated.needsScan}`,
    );
  } finally {
    delete process.env.WFC_SESSION_FAIL_THRESHOLD;
    delete process.env.WFC_SESSION_FAIL_MIN_INTERVAL_SEC;
  }
  const back = await probeSession({
    account: "gate",
    profileDir: validProfile,
    stateFile: path.join(tmpRoot, "gate2", "session-probe.json"),
    collectPage: async () => shellPage,
    env: {},
    now: () => nowMs,
    quiet: true,
  });
  check("11b-threshold-defaults-to-3", back.threshold === 3 && back.needsScan === false, `threshold=${back.threshold}`);
}

// ---------------------------------------------------------------- 12) 时钟回退不冻住计数（复核 N3）
{
  const st = nextProbeState(
    { ...EMPTY_PROBE_STATE, consecutiveFailures: 1, lastProbeAt: new Date(nowMs + 3_600_000).toISOString() },
    "unknown",
    "shell",
    nowMs,
    { minIntervalSec: 60 },
  );
  check("12a-clock-rollback-increments", st.consecutiveFailures === 2, `consecutive=${st.consecutiveFailures}`);
}

fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
