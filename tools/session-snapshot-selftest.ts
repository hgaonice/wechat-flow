#!/usr/bin/env bun
/**
 * session-snapshot-selftest.ts — cookie 快照 / 校验 / 回滚 自测（零依赖，bun 直跑）。
 *
 *   bun tools/session-snapshot-selftest.ts
 *
 * 覆盖 C1（design §C-3，implement.md Step 4）：
 *   1) snapshot：Cookies + Local State 原子落盘，manifest sha256/size 正确，0700/0600
 *   2) 幂等：同一分钟 + 同一 reason 只留一份；不同 reason 各自留一份
 *   3) list：时间倒序；prune：保留最近 N 份；keep<1 显形失败
 *   4) restore 正常路径：破坏现网 Cookies → 回滚 → sha256/integrity_check 复原
 *   5) restore 拒绝损坏快照：sha256 不符 → ok:false 且现网文件一个字节都没动
 *   6) restore 半替换防护：替换途中失败 → 自动回滚到 *.pre-restore，绝不半替换
 *   7) systemd 容错：unit 不存在 → 跳过（不报错）；stop 失败 → 拒绝替换
 * 全程只碰临时目录（mv 出 os.tmpdir），不触碰真 profile / 不做任何 250 写操作。
 * 失败退出码 1。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { cookiesDbPath } from "../src/session-state.ts";
import {
  DEFAULT_KEEP,
  listSnapshots,
  pruneSnapshots,
  restore,
  sha256File,
  snapshot,
  snapshotIdOf,
  snapshotsDir,
  verifyCookiesDb,
  type SystemctlResult,
} from "../src/session-snapshot.ts";

let failures = 0;
function check(name: string, cond: boolean, extra?: string): void {
  if (cond) {
    console.log(`PASS ${name}`);
  } else {
    failures++;
    console.log(`FAIL ${name}${extra ? " — " + extra : ""}`);
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "session-snapshot-selftest-"));
const CHROME_EPOCH_OFFSET_SEC = 11_644_473_600;
const chromeTime = (unixSec: number) => Math.round((unixSec + CHROME_EPOCH_OFFSET_SEC) * 1e6);
const unixNow = Math.floor(Date.now() / 1000);

/** Chrome-like profile: `Default/Cookies` (real SQLite) + `Local State`. */
function makeProfile(name: string, opts: { localState?: boolean; cookies?: boolean } = {}): string {
  const dir = path.join(tmpRoot, name);
  const file = cookiesDbPath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (opts.cookies !== false) {
    const db = new Database(file);
    try {
      db.exec(
        `CREATE TABLE cookies(creation_utc INTEGER PRIMARY KEY, host_key TEXT, name TEXT,
           value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER)`,
      );
      db.run(
        "INSERT INTO cookies(creation_utc, host_key, name, expires_utc) VALUES(1,'.weixin.qq.com','slave_sid',?)",
        chromeTime(unixNow + 96 * 3600),
      );
    } finally {
      db.close();
    }
  }
  if (opts.localState !== false) {
    fs.writeFileSync(path.join(dir, "Local State"), JSON.stringify({ os_crypt: { encrypted_key: "test-key" } }));
  }
  return dir;
}

const dataDir = path.join(tmpRoot, "data", "acct");
const profile = makeProfile("acct/profile");

// ------------------------------------------------------------ 1) 正常快照
const s1 = snapshot("acct", profile, { dataDir, reason: "manual", now: Date.parse("2026-10-20T01:00:00Z") });
check("1-snapshot-ok", s1.ok === true && Boolean(s1.id) && fs.existsSync(s1.dir ?? ""), s1.reason);
{
  const dir = s1.dir ?? "";
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const cookies = path.join(dir, "Cookies");
  const localState = path.join(dir, "Local State");
  check(
    "1b-manifest-integrity",
    manifest.files.Cookies.sha256 === sha256File(cookies) &&
      manifest.files.Cookies.size === fs.statSync(cookies).size &&
      manifest.files.localState.sha256 === sha256File(localState),
    JSON.stringify(manifest.files),
  );
  check("1c-manifest-slave-sid", typeof manifest.slaveSidExpiresAt === "number", String(manifest.slaveSidExpiresAt));
  check(
    "1d-permissions",
    (fs.statSync(dir).mode & 0o777) === 0o700 &&
      (fs.statSync(cookies).mode & 0o777) === 0o600 &&
      (fs.statSync(localState).mode & 0o777) === 0o600 &&
      (fs.statSync(snapshotsDir(dataDir)).mode & 0o777) === 0o700,
    `dir=${(fs.statSync(dir).mode & 0o777).toString(8)} cookies=${(fs.statSync(cookies).mode & 0o777).toString(8)}`,
  );
  check("1e-no-tmp-leftovers", fs.readdirSync(dir).every((f) => !f.includes(".tmp-")), fs.readdirSync(dir).join(","));
  check("1f-snapshot-copy-is-valid-sqlite", verifyCookiesDb(cookies).ok === true);
}

// ------------------------------------------------------------ 2) 幂等（分钟 + reason）
const same = snapshot("acct", profile, { dataDir, reason: "manual", now: Date.parse("2026-10-20T01:00:30Z") });
check(
  "2-same-minute-same-reason-skipped",
  same.ok === true && same.skipped === true && same.id === s1.id,
  `id=${same.id} skipped=${same.skipped}`,
);
const otherReason = snapshot("acct", profile, { dataDir, reason: "keepalive", now: Date.parse("2026-10-20T01:00:40Z") });
check("2b-same-minute-other-reason-kept", otherReason.ok === true && otherReason.skipped !== true && otherReason.id !== s1.id);

// ------------------------------------------------------------ 3) 相邻分钟 / list / prune
const s3 = snapshot("acct", profile, { dataDir, reason: "manual", now: Date.parse("2026-10-20T02:00:00Z") });
check("3-next-minute-new-snapshot", s3.ok === true && s3.skipped !== true);
{
  const rows = listSnapshots("acct", { dataDir });
  check(
    "3b-list-newest-first",
    rows.length === 3 && rows[0]?.id === s3.id && rows[1]?.id === (otherReason.id ?? ""),
    rows.map((r) => r.id).join(" | "),
  );
  check("3c-list-size-positive", rows.every((r) => r.sizeBytes > 0));
  const pruned = pruneSnapshots("acct", { dataDir, keep: 2 });
  check("3d-prune-keeps-newest", pruned.ok === true && pruned.kept === 2 && pruned.removed.length === 1, JSON.stringify(pruned));
  const left = listSnapshots("acct", { dataDir });
  check("3e-prune-left-newest", left.length === 2 && left[0]?.id === s3.id && !left.some((r) => r.id === s1.id));
  check("3f-prune-invalid-keep", pruneSnapshots("acct", { dataDir, keep: 0 }).ok === false);
  check("3g-default-keep", DEFAULT_KEEP === 10);
  // 歧义前缀必须显形报错，而不是随手挑一个
  const amb = restore("acct", "2026-10-20T0", { dataDir, profileDir: profile, browserUnit: null });
  check("3h-ambiguous-prefix-reports", amb.ok === false && /命中 2 份/.test(amb.reason ?? ""), amb.reason);
}

// ------------------------------------------------------------ 4) restore 正常路径（真·回滚）
{
  const restoreData = path.join(tmpRoot, "data", "restore-acct");
  const restoreProfile = makeProfile("restore-acct/profile");
  const snap = snapshot("restore-acct", restoreProfile, { dataDir: restoreData, reason: "manual" });
  const goodSha = sha256File(cookiesDbPath(restoreProfile));

  // 破坏现网 Cookie 文件（模拟「一次糟糕的重启把 cookie jar 清了」）
  fs.rmSync(cookiesDbPath(restoreProfile), { force: true });
  fs.writeFileSync(cookiesDbPath(restoreProfile), "not-a-sqlite-any-more");
  const brokenSha = sha256File(cookiesDbPath(restoreProfile));
  check("4-live-cookie-broken", brokenSha !== goodSha && verifyCookiesDb(cookiesDbPath(restoreProfile)).ok === false);

  // 注入 systemd：unit 不存在 → 应跳过而不是报错
  const calls: string[] = [];
  const noUnit = (cmd: string, args: string[]): SystemctlResult => {
    calls.push(`${cmd} ${args.join(" ")}`);
    return { status: 1, stdout: "", stderr: "Unit wechat-browser@restore-acct.service could not be found." };
  };
  const r = restore("restore-acct", snap.id ?? "", { dataDir: restoreData, profileDir: restoreProfile, run: noUnit });
  check("4b-restore-ok", r.ok === true && r.needsReverify === true, r.reason);
  check("4c-restored-sha256", sha256File(cookiesDbPath(restoreProfile)) === goodSha);
  check("4d-restored-integrity", verifyCookiesDb(cookiesDbPath(restoreProfile)).ok === true);
  check("4e-pre-restore-backup-kept", fs.existsSync(`${cookiesDbPath(restoreProfile)}.pre-restore`), r.backups.join(","));
  check(
    "4f-missing-unit-tolerated",
    r.steps.some((s) => s.includes("systemctl cat")) && r.warnings.some((w) => w.includes("未托管")),
    JSON.stringify(r.warnings),
  );
  check("4g-only-cat-called-when-unit-missing", calls.length === 1, calls.join(" | "));
  check("4h-local-state-restored", fs.readFileSync(path.join(restoreProfile, "Local State"), "utf8").includes("encrypted_key"));
  check("4i-no-tmp-leftovers", fs.readdirSync(path.dirname(cookiesDbPath(restoreProfile))).every((f) => !f.includes(".tmp-")));

  // 前缀 id + 真实 unit 的 stop/start 顺序
  const ordered: string[] = [];
  const withUnit = (cmd: string, args: string[]): SystemctlResult => {
    ordered.push(args.join(" "));
    if (args[0] === "cat") return { status: 0, stdout: "unit" };
    return { status: 0, stdout: "", stderr: "" };
  };
  fs.rmSync(cookiesDbPath(restoreProfile), { force: true });
  fs.writeFileSync(cookiesDbPath(restoreProfile), "broken-again");
  const r2 = restore("restore-acct", (snap.id ?? "").slice(0, 12), {
    dataDir: restoreData,
    profileDir: restoreProfile,
    run: withUnit,
  });
  check("4j-prefix-id-restore", r2.ok === true && r2.id === snap.id, r2.reason);
  check(
    "4k-stop-before-swap-start-after",
    ordered.join(" | ") === `cat wechat-browser@restore-acct.service --no-pager | stop wechat-browser@restore-acct.service | start wechat-browser@restore-acct.service`,
    ordered.join(" | "),
  );
  check("4l-restored-again", sha256File(cookiesDbPath(restoreProfile)) === goodSha);

  // browserUnit:null → 完全跳过 systemd
  const r3 = restore("restore-acct", snap.id ?? "", { dataDir: restoreData, profileDir: restoreProfile, browserUnit: null });
  check("4m-systemd-disabled", r3.ok === true && r3.steps.some((s) => s.includes("systemd 跳过")), r3.steps.join(" | "));
}

// ------------------------------------------------------------ 5) 拒绝损坏快照（不动现网）
{
  const restoreData = path.join(tmpRoot, "data", "corrupt-acct");
  const restoreProfile = makeProfile("corrupt-acct/profile");
  const snap = snapshot("corrupt-acct", restoreProfile, { dataDir: restoreData, reason: "manual" });
  // 篡改快照里的 Cookies 一个字节 → sha256 必须失配
  const snapCookies = path.join(snap.dir ?? "", "Cookies");
  const buf = fs.readFileSync(snapCookies);
  buf[buf.length - 1] = (buf[buf.length - 1]! + 1) % 256;
  fs.writeFileSync(snapCookies, buf);
  const liveBefore = sha256File(cookiesDbPath(restoreProfile));

  const r = restore("corrupt-acct", snap.id ?? "", {
    dataDir: restoreData,
    profileDir: restoreProfile,
    run: () => ({ status: 0, stdout: "unit" }),
  });
  check("5a-corrupt-snapshot-refused", r.ok === false && /sha256/i.test(r.reason ?? ""), r.reason);
  check("5b-live-untouched", sha256File(cookiesDbPath(restoreProfile)) === liveBefore);
  check("5c-no-backup-created", !fs.existsSync(`${cookiesDbPath(restoreProfile)}.pre-restore`));
  check("5d-systemd-not-called-before-verify", r.steps.every((s) => !s.includes("systemctl stop")), r.steps.join(" | "));

  // 快照里的 Cookies 是合法文件但不是合法 SQLite → integrity_check 失败也要挡住
  const db = new Database(snapCookies);
  db.close();
  fs.writeFileSync(snapCookies, "definitely not sqlite");
  const manifestFile = path.join(snap.dir ?? "", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  manifest.files.Cookies = { sha256: sha256File(snapCookies), size: fs.statSync(snapCookies).size };
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  const r2 = restore("corrupt-acct", snap.id ?? "", { dataDir: restoreData, profileDir: restoreProfile, browserUnit: null });
  check("5e-integrity-rejected", r2.ok === false && /完整性校验失败/.test(r2.reason ?? ""), r2.reason);
  check("5f-live-still-untouched", sha256File(cookiesDbPath(restoreProfile)) === liveBefore);
}

// ------------------------------------------------------------ 6) 半替换防护（回滚到 pre-restore）
{
  const restoreData = path.join(tmpRoot, "data", "half-acct");
  const restoreProfile = makeProfile("half-acct/profile");
  const snap = snapshot("half-acct", restoreProfile, { dataDir: restoreData, reason: "manual" });
  const goodSha = sha256File(cookiesDbPath(restoreProfile));
  // 现网「坏」状态：回滚必须回到这个状态，而不是快照状态
  fs.rmSync(cookiesDbPath(restoreProfile), { force: true });
  fs.writeFileSync(cookiesDbPath(restoreProfile), "broken-before-restore");
  const brokenSha = sha256File(cookiesDbPath(restoreProfile));
  // 让第二个文件（Local State）的原子写在 rename 前失败：预先占住 tmp 名字（同一进程 pid）
  const blocker = path.join(restoreProfile, `Local State.tmp-${process.pid}`);
  fs.mkdirSync(blocker, { recursive: true });

  const r = restore("half-acct", snap.id ?? "", { dataDir: restoreData, profileDir: restoreProfile, browserUnit: null });
  check("6a-half-replace-detected", r.ok === false && /替换失败/.test(r.reason ?? ""), r.reason);
  check("6b-rolled-back-to-pre-restore", sha256File(cookiesDbPath(restoreProfile)) === brokenSha, r.reason);
  check("6c-not-the-snapshot-state", sha256File(cookiesDbPath(restoreProfile)) !== goodSha);
  check("6d-reason-says-rolled-back", /已回滚到 restore 前状态/.test(r.reason ?? ""), r.reason);
  check("6e-pre-restore-file-exists", fs.existsSync(`${cookiesDbPath(restoreProfile)}.pre-restore`));
  fs.rmSync(blocker, { recursive: true, force: true });

  // stop 失败 → 必须拒绝在浏览器仍持有时替换
  fs.writeFileSync(cookiesDbPath(restoreProfile), "broken-stop-case");
  const stopBefore = sha256File(cookiesDbPath(restoreProfile));
  const stopFails = (cmd: string, args: string[]): SystemctlResult =>
    args[0] === "cat" ? { status: 0, stdout: "unit" } : { status: 1, stdout: "", stderr: "Access denied" };
  const r2 = restore("half-acct", snap.id ?? "", { dataDir: restoreData, profileDir: restoreProfile, run: stopFails });
  check("6f-stop-failure-blocks-replace", r2.ok === false && /拒绝在浏览器仍持有/.test(r2.reason ?? ""), r2.reason);
  check("6g-stop-failure-untouched", sha256File(cookiesDbPath(restoreProfile)) === stopBefore);

  // 复核 B2：备份现网文件失败时，**必须把刚停掉的 unit 拉回来**，否则“恢复工具”
  // 反而把账号打成离线（当天发布/保活都会因为没有浏览器而失败）。
  {
    fs.rmSync(`${cookiesDbPath(restoreProfile)}.pre-restore`, { force: true });
    fs.mkdirSync(`${cookiesDbPath(restoreProfile)}.pre-restore`, { recursive: true }); // 让备份 rename 失败
    const calls: string[] = [];
    const backupFails = (cmd: string, args: string[]): SystemctlResult => {
      calls.push(`${args[0]} ${args[1] ?? ""}`.trim());
      return { status: 0, stdout: args[0] === "cat" ? "unit" : "" };
    };
    const r3 = restore("half-acct", snap.id ?? "", {
      dataDir: restoreData,
      profileDir: restoreProfile,
      run: backupFails,
      browserUnit: `wechat-browser@half-acct.service`,
    });
    check("6h-backup-failure-reports", r3.ok === false && /备份现网文件失败/.test(r3.reason ?? ""), r3.reason);
    check(
      "6i-backup-failure-restarts-unit",
      calls.includes("start wechat-browser@half-acct.service"),
      `systemctl calls: ${calls.join(" | ")}`,
    );
    fs.rmSync(`${cookiesDbPath(restoreProfile)}.pre-restore`, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------ 7) 失败必须显形（不静默）
{
  const noCookies = makeProfile("no-cookies", { cookies: false });
  const r = snapshot("no-cookies", noCookies, { dataDir: path.join(tmpRoot, "data", "no-cookies") });
  check("7a-missing-cookies-reports", r.ok === false && /Cookies 不存在/.test(r.reason ?? ""), r.reason);

  const noLocalState = makeProfile("no-local-state", { localState: false });
  const r2 = snapshot("no-local-state", noLocalState, { dataDir: path.join(tmpRoot, "data", "no-local-state") });
  check("7b-missing-local-state-reports", r2.ok === false && /Local State 不存在/.test(r2.reason ?? ""), r2.reason);

  const garbageProfile = makeProfile("garbage", { cookies: false });
  fs.writeFileSync(cookiesDbPath(garbageProfile), "this is not a sqlite database");
  const garbageData = path.join(tmpRoot, "data", "garbage");
  const r3 = snapshot("garbage", garbageProfile, { dataDir: garbageData });
  check(
    "7c-corrupt-live-db-not-snapshotted",
    r3.ok === false && /复制校验失败/.test(r3.reason ?? "") && listSnapshots("garbage", { dataDir: garbageData }).length === 0,
    r3.reason,
  );

  const r4 = restore("acct", "no-such-snapshot", {
    dataDir,
    profileDir: profile,
    browserUnit: null,
  });
  check("7d-unknown-snapshot-reports", r4.ok === false && /快照不存在/.test(r4.reason ?? ""), r4.reason);

  check("7e-snapshot-id-shape", snapshotIdOf("2026-10-20T01:00:00.000Z") === "2026-10-20T01-00-00-000Z");
}

fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
