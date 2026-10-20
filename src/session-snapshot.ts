import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";
import { log } from "./log.ts";
import { atomicWriteJson } from "./state.ts";
import { cookiesDbPath, readCookieFacts } from "./session-state.ts";

/**
 * Cookie snapshot / restore (C1, design §C-3).
 *
 * Why: the MP login tickets live *only* in `<profile>/Default/Cookies`, and the
 * key that decrypts that SQLite lives in `<profile>/Local State`. So the whole
 * session is two files — and a two-file backup is the cheapest insurance
 * against "one bad restart / one cleared cookie jar ⇒ rescan the QR".
 *
 * Hard rules:
 *   - every write is atomic (tmp → fsync → rename); a half-copied Cookies file
 *     is worse than no snapshot at all;
 *   - a snapshot is worthless unless `Local State` is captured with it (without
 *     the key the cookies cannot be decrypted) → fail loudly, never silently
 *     save half of the pair;
 *   - `restore` verifies BEFORE touching anything (sha256 + `PRAGMA
 *     integrity_check`), stops the browser unit first (its SQLite handle would
 *     otherwise overwrite our copy), and on any later failure puts the original
 *     files back — no half-restored profile;
 *   - snapshot data is login material: directory 0700, files 0600, never in git
 *     and never deployed (`data/` is excluded by both `.gitignore` and
 *     `deploy/deploy.sh`).
 */

export const SNAPSHOT_DIR_NAME = "session-snapshots";
export const DEFAULT_KEEP = 10;

const COOKIES_FILE = "Cookies";
const LOCAL_STATE_FILE = "Local State";
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
/** SQLite write-ahead / rollback sidecars that must never survive a replacement. */
const SQLITE_SIDECARS = ["-journal", "-wal", "-shm"];

export interface SnapshotFileFact {
  sha256: string;
  size: number;
}

export interface SnapshotManifest {
  alias: string;
  createdAt: string;
  /** `keepalive` / `manual` / `publish` — also used for same-minute idempotency. */
  reason: string;
  files: { Cookies: SnapshotFileFact; localState: SnapshotFileFact };
  /** Best-effort: nulled out when the live DB was unreadable (never fatal). */
  slaveSidExpiresAt?: number;
  profileDir: string;
}

export function snapshotsDir(dataDir: string): string {
  return path.join(dataDir, SNAPSHOT_DIR_NAME);
}

/** ISO-8601 → filesystem-safe id (colons are legal on Linux but hostile in shells). */
export function snapshotIdOf(iso: string): string {
  return iso.replace(/[:.]/g, "-");
}

export function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Synchronous sleep; the whole module is sync so callers can't half-fail mid-await. */
function syncSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try {
    fs.chmodSync(dir, DIR_MODE);
  } catch {
    /* best effort: a chmod failure must not abort the snapshot */
  }
}

function fsyncDir(dir: string): void {
  try {
    const fd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* directory fsync is not supported everywhere — durability best effort only */
  }
}

/** tmp → fsync → chmod → rename. Never write the destination in place. */
function writeAtomic(dest: string, data: Buffer, mode = FILE_MODE): void {
  const tmp = `${dest}.tmp-${process.pid}`;
  try {
    const fd = fs.openSync(tmp, "w", mode);
    try {
      fs.writeSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.chmodSync(tmp, mode);
    } catch {
      /* umask already limited the bits; ignore */
    }
    fs.renameSync(tmp, dest);
  } catch (err) {
    // A failed atomic write must not leave a `*.tmp-<pid>` landmine behind.
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }
  fsyncDir(path.dirname(dest));
}

function copyAtomicFile(src: string, dest: string, mode = FILE_MODE): void {
  writeAtomic(dest, fs.readFileSync(src), mode);
}

/**
 * `PRAGMA integrity_check` on a Cookies copy.
 *
 * A snapshot taken while Chrome was mid-write is silently corrupt, so this runs
 * both at snapshot time (retry once) and before a restore is allowed to touch
 * the live profile.
 */
export function verifyCookiesDb(file: string): { ok: boolean; reason?: string } {
  let db: Database | undefined;
  try {
    db = new Database(file, { readonly: true });
    db.exec("PRAGMA busy_timeout = 200");
    const row = db.query("PRAGMA integrity_check").get() as Record<string, unknown> | null;
    const value = row ? String(Object.values(row)[0] ?? "") : "";
    if (value.toLowerCase() !== "ok") return { ok: false, reason: `integrity_check=${value || "?"}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `integrity_check failed: ${msgOf(err)}` };
  } finally {
    try {
      db?.close();
    } catch {
      /* closing a read-only handle must never mask the result */
    }
  }
}

function listIds(root: string): string[] {
  try {
    if (!fs.existsSync(root)) return [];
    return fs
      .readdirSync(root)
      .filter((name) => {
        try {
          return fs.statSync(path.join(root, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

function readManifest(dir: string): SnapshotManifest | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as Partial<SnapshotManifest>;
    if (!raw || typeof raw !== "object") return null;
    if (!raw.files || typeof raw.files !== "object") return null;
    const files = raw.files as Partial<SnapshotManifest["files"]>;
    if (!files.Cookies || !files.localState) return null;
    return {
      alias: typeof raw.alias === "string" ? raw.alias : "",
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
      reason: typeof raw.reason === "string" ? raw.reason : "",
      files: { Cookies: files.Cookies, localState: files.localState },
      ...(typeof raw.slaveSidExpiresAt === "number" ? { slaveSidExpiresAt: raw.slaveSidExpiresAt } : {}),
      profileDir: typeof raw.profileDir === "string" ? raw.profileDir : "",
    };
  } catch {
    return null;
  }
}

function findSameMinute(root: string, createdAtIso: string, reason: string): string | null {
  const minute = createdAtIso.slice(0, 16);
  for (const id of listIds(root)) {
    const m = readManifest(path.join(root, id));
    if (!m) continue;
    if (m.reason === reason && m.createdAt.slice(0, 16) === minute) return id;
  }
  return null;
}

export interface SnapshotOptions {
  /** `data/<alias>` — snapshots go to `<dataDir>/session-snapshots/<id>/`. */
  dataDir: string;
  reason?: string;
  now?: number;
  /** How many snapshots to keep after this one (default 10). */
  keep?: number;
}

export interface SnapshotResult {
  ok: boolean;
  id?: string;
  dir?: string;
  /** Another snapshot from the same minute + reason already existed. */
  skipped?: boolean;
  reason?: string;
  sizeBytes?: number;
  slaveSidExpiresAt?: number;
}

/**
 * Atomically copy `Default/Cookies` + `Local State` into a timestamped folder.
 *
 * Idempotent per (minute, reason): running `keepalive` and a manual snapshot in
 * the same minute must not produce two copies of the same session.
 */
export function snapshot(alias: string, profileDir: string, opts: SnapshotOptions): SnapshotResult {
  const cookiesFile = cookiesDbPath(profileDir);
  const localStateFile = path.join(profileDir, LOCAL_STATE_FILE);
  if (!fs.existsSync(cookiesFile)) {
    return { ok: false, reason: `Cookies 不存在：${cookiesFile}` };
  }
  if (!fs.existsSync(localStateFile)) {
    // Without the key file the cookies cannot be decrypted, so this pair is
    // inseparable: saving only Cookies would produce an unrestorable snapshot.
    return {
      ok: false,
      reason: `Local State 不存在：${localStateFile}（cookie 解密密钥，缺失则快照无法回滚）`,
    };
  }

  const createdAt = new Date(opts.now ?? Date.now()).toISOString();
  const reason = opts.reason ?? "manual";
  const root = snapshotsDir(opts.dataDir);
  ensurePrivateDir(root);

  const dup = findSameMinute(root, createdAt, reason);
  if (dup) {
    return { ok: true, id: dup, dir: path.join(root, dup), skipped: true, reason: `同一分钟内已有 ${reason} 快照，跳过` };
  }

  const id = snapshotIdOf(createdAt);
  const dir = path.join(root, id);
  let integrity = "";
  let copied = false;
  try {
    ensurePrivateDir(dir);
    // Chrome may be writing the DB right now; copy + verify, retry once.
    for (let attempt = 0; attempt < 2 && !copied; attempt++) {
      copyAtomicFile(cookiesFile, path.join(dir, COOKIES_FILE));
      copyAtomicFile(localStateFile, path.join(dir, LOCAL_STATE_FILE));
      const check = verifyCookiesDb(path.join(dir, COOKIES_FILE));
      if (check.ok) {
        copied = true;
        break;
      }
      integrity = check.reason ?? "integrity_check failed";
      if (attempt === 0) syncSleep(300);
    }
    if (!copied) {
      fs.rmSync(dir, { recursive: true, force: true });
      return { ok: false, reason: `快照复制校验失败（Chrome 可能正在写 Cookies）：${integrity}` };
    }

    // Best effort only: an unreadable live DB must not block the snapshot.
    const facts = readCookieFacts(profileDir);
    const manifest: SnapshotManifest = {
      alias,
      createdAt,
      reason,
      files: {
        Cookies: { sha256: sha256File(path.join(dir, COOKIES_FILE)), size: fs.statSync(path.join(dir, COOKIES_FILE)).size },
        localState: {
          sha256: sha256File(path.join(dir, LOCAL_STATE_FILE)),
          size: fs.statSync(path.join(dir, LOCAL_STATE_FILE)).size,
        },
      },
      ...(facts.ok && facts.slaveSidExpiresAt !== undefined ? { slaveSidExpiresAt: facts.slaveSidExpiresAt } : {}),
      profileDir,
    };
    atomicWriteJson(path.join(dir, "manifest.json"), manifest);
    try {
      fs.chmodSync(path.join(dir, "manifest.json"), FILE_MODE);
    } catch {
      /* ignore */
    }
    fsyncDir(dir);

    const pruned = pruneSnapshots(alias, { dataDir: opts.dataDir, keep: opts.keep });
    if (!pruned.ok) log.warn(`[session] 快照清理失败（不影响本次快照）：${pruned.reason}`);

    const sizeBytes = manifest.files.Cookies.size + manifest.files.localState.size;
    log.info(
      `[session] snapshot ${id} · reason=${reason} · ${(sizeBytes / 1024).toFixed(1)}KB${
        manifest.slaveSidExpiresAt ? ` · slave_sid ${new Date(manifest.slaveSidExpiresAt * 1000).toISOString()}` : ""
      }`,
    );
    return {
      ok: true,
      id,
      dir,
      sizeBytes,
      ...(manifest.slaveSidExpiresAt !== undefined ? { slaveSidExpiresAt: manifest.slaveSidExpiresAt } : {}),
    };
  } catch (err) {
    // A partially written folder must not linger as an "available" snapshot.
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return { ok: false, reason: `快照失败：${msgOf(err)}` };
  }
}

export interface SnapshotInfo {
  id: string;
  createdAt: string;
  reason: string;
  slaveSidExpiresAt?: number;
  sizeBytes: number;
  dir: string;
}

function dirSize(dir: string): number {
  let total = 0;
  for (const name of fs.readdirSync(dir)) {
    try {
      total += fs.statSync(path.join(dir, name)).size;
    } catch {
      /* skip unreadable entry */
    }
  }
  return total;
}

/** Snapshots newest-first. Corrupt folders are skipped (with a warning). */
export function listSnapshots(alias: string, opts: { dataDir: string }): SnapshotInfo[] {
  const root = snapshotsDir(opts.dataDir);
  const out: SnapshotInfo[] = [];
  for (const id of listIds(root)) {
    const dir = path.join(root, id);
    const m = readManifest(dir);
    if (!m) {
      log.warn(`[session] 跳过损坏的快照目录（无 manifest.json）：${dir}`);
      continue;
    }
    out.push({
      id,
      createdAt: m.createdAt,
      reason: m.reason,
      ...(m.slaveSidExpiresAt !== undefined ? { slaveSidExpiresAt: m.slaveSidExpiresAt } : {}),
      sizeBytes: dirSize(dir),
      dir,
    });
  }
  out.sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1));
  return out;
}

export interface PruneResult {
  ok: boolean;
  kept: number;
  removed: string[];
  reason?: string;
}

/** Keep the newest `keep` snapshots (default 10). */
export function pruneSnapshots(alias: string, opts: { dataDir: string; keep?: number }): PruneResult {
  const keep = opts.keep ?? DEFAULT_KEEP;
  if (!Number.isFinite(keep) || keep < 1) {
    return { ok: false, kept: 0, removed: [], reason: `keep 必须 ≥ 1（收到 ${String(opts.keep)}）` };
  }
  const all = listSnapshots(alias, { dataDir: opts.dataDir });
  const victims = all.slice(Math.floor(keep));
  const removed: string[] = [];
  const problems: string[] = [];
  for (const s of victims) {
    try {
      fs.rmSync(s.dir, { recursive: true, force: true });
      removed.push(s.id);
    } catch (err) {
      problems.push(`${s.id}: ${msgOf(err)}`);
    }
  }
  return {
    ok: problems.length === 0,
    kept: all.length - removed.length,
    removed,
    ...(problems.length ? { reason: `部分快照删除失败：${problems.join("; ")}` } : {}),
  };
}

export interface SystemctlResult {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export interface RestoreOptions {
  /** `data/<alias>`. */
  dataDir: string;
  /** Chrome user-data-dir (`resolveProfileDir`). */
  profileDir: string;
  /**
   * systemd instance to stop/start around the swap.
   * `wechat-browser@<alias>.service` by default; `null` disables systemd
   * entirely (tests / hosts without systemd).
   */
  browserUnit?: string | null;
  /** Injected for tests; defaults to `spawnSync`. */
  run?: (cmd: string, args: string[]) => SystemctlResult;
}

export interface RestoreResult {
  ok: boolean;
  id?: string;
  reason?: string;
  /** Ordered narrative — printed by the CLI and quoted in incident reports. */
  steps: string[];
  /** Non-fatal problems (browser restart failed, systemd unavailable, …). */
  warnings: string[];
  /** Always true: the caller must re-probe (files restored ≠ session alive). */
  needsReverify: boolean;
  /** `<file>.pre-restore` copies kept for manual rollback. */
  backups: string[];
  slaveSidExpiresAt?: number;
}

function defaultRun(cmd: string, args: string[]): SystemctlResult {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 20_000 });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    ...(r.error ? { error: r.error.message } : {}),
  };
}

interface UnitOutcome {
  steps: string[];
  warnings: string[];
  /** Set when we must NOT continue (the browser still owns the DB). */
  blocked?: string;
  ran: boolean;
}

/** Does the unit exist on this host (and is systemd usable at all)? Probed once. */
function unitExists(run: (cmd: string, args: string[]) => SystemctlResult, unit: string): { exists: boolean; detail: string } {
  const probe = run("systemctl", ["cat", unit, "--no-pager"]);
  if (probe.status === 0) return { exists: true, detail: "unit exists" };
  const text = `${probe.stderr ?? ""}${probe.stdout ?? ""}`.trim();
  return { exists: false, detail: probe.error ?? (text.split("\n")[0] || `exit ${probe.status}`) };
}

/**
 * `systemctl stop|start <unit>`, tolerating hosts without systemd.
 *
 * For `stop` a successful call is mandatory (replacing a Cookies file under a
 * live Chrome is data loss); a *missing* unit is only a warning, because the
 * inline (console-spawned) browser mode has none.
 */
function controlUnit(
  run: (cmd: string, args: string[]) => SystemctlResult,
  unit: string,
  action: "stop" | "start",
): UnitOutcome {
  const steps: string[] = [];
  const warnings: string[] = [];
  const r = run("systemctl", [action, unit]);
  steps.push(`systemctl ${action} ${unit} → exit ${r.status}`);
  if (r.status !== 0) {
    const detail = `${r.stderr ?? ""}${r.stdout ?? ""}`.trim().split("\n")[0] || r.error || "unknown";
    if (action === "stop") {
      return { steps, warnings, ran: true, blocked: `systemctl stop ${unit} 失败（${detail}）：拒绝在浏览器仍持有 Cookies 时替换文件` };
    }
    warnings.push(`systemctl start ${unit} 失败（${detail}）：会话文件已恢复，但浏览器未起来 —— 请手动 systemctl start ${unit}`);
  }
  return { steps, warnings, ran: true };
}

/** Exact id first, then a unique prefix. Ambiguity is an error, not a guess. */
function resolveSnapshotDir(root: string, rawId: string): { dir?: string; reason?: string } {
  const want = String(rawId ?? "").trim();
  if (!want) return { reason: "快照 id 为空" };
  const exact = path.join(root, want);
  if (fs.existsSync(path.join(exact, "manifest.json"))) return { dir: exact };
  const matches = listIds(root).filter((id) => id.startsWith(want) || snapshotIdOf(id) === want);
  if (matches.length === 1) return { dir: path.join(root, matches[0] as string) };
  if (matches.length > 1) {
    return {
      reason: `快照 id 前缀 "${want}" 命中 ${matches.length} 份（${matches.slice(0, 5).join(", ")}…），请写完整 id`,
    };
  }
  return { reason: `快照不存在：${want}（目录 ${root}）` };
}

function verifyManifestFiles(dir: string, manifest: SnapshotManifest): string | null {
  const pairs: [string, string, SnapshotFileFact | undefined][] = [
    ["Cookies", COOKIES_FILE, manifest.files.Cookies],
    ["localState", LOCAL_STATE_FILE, manifest.files.localState],
  ];
  for (const [key, filename, fact] of pairs) {
    if (!fact || typeof fact.sha256 !== "string" || typeof fact.size !== "number") {
      return `manifest 缺少 ${key} 的校验信息`;
    }
    const file = path.join(dir, filename);
    if (!fs.existsSync(file)) return `快照文件缺失：${file}`;
    const size = fs.statSync(file).size;
    if (size !== fact.size) return `快照文件 ${key} 大小不符（${size} ≠ ${fact.size}）`;
    const digest = sha256File(file);
    if (digest !== fact.sha256) {
      return `快照文件 ${key} sha256 不符（${digest.slice(0, 12)}… ≠ ${fact.sha256.slice(0, 12)}…）`;
    }
  }
  return null;
}

function sameContent(a: string, b: string): boolean {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    if (!sa.isFile() || !sb.isFile() || sa.size !== sb.size) return false;
    return sha256File(a) === sha256File(b);
  } catch {
    return false;
  }
}

/**
 * Put the pre-restore files back. Idempotent: a file that already matches its
 * backup is left alone (so a partially failed rollback can be retried).
 */
function revertFiles(entries: { dest: string; backup: string | null }[]): string | null {
  const problems: string[] = [];
  for (const e of entries) {
    for (const side of SQLITE_SIDECARS) {
      try {
        fs.rmSync(`${e.dest}${side}`, { force: true });
      } catch {
        /* ignore */
      }
    }
    try {
      if (e.backup) {
        if (fs.existsSync(e.dest) && sameContent(e.dest, e.backup)) continue;
        copyAtomicFile(e.backup, e.dest);
      } else if (fs.existsSync(e.dest)) {
        fs.rmSync(e.dest, { force: true });
      }
    } catch (err) {
      problems.push(`${e.dest}: ${msgOf(err)}`);
    }
  }
  return problems.length ? problems.join("; ") : null;
}

/**
 * Put a snapshot back into the Chrome profile.
 *
 * Strict order: verify (sha256 + integrity_check) → stop browser unit → backup
 * live files → swap → start unit → ask the caller to re-probe. Every failure
 * after the backup step reverts to `<file>.pre-restore`, so the profile is never
 * left half-restored.
 */
export function restore(alias: string, snapshotId: string, opts: RestoreOptions): RestoreResult {
  const steps: string[] = [];
  const warnings: string[] = [];
  const backups: string[] = [];
  const done = (extra: Partial<RestoreResult> & { ok: boolean; reason?: string }): RestoreResult => ({
    needsReverify: true,
    steps,
    warnings,
    backups,
    ...extra,
  });

  const root = snapshotsDir(opts.dataDir);
  const resolved = resolveSnapshotDir(root, snapshotId);
  if (!resolved.dir) return done({ ok: false, id: snapshotId, reason: resolved.reason ?? `快照不存在：${snapshotId}` });
  const dir = resolved.dir;
  const id = path.basename(dir);
  const manifest = readManifest(dir);
  if (!manifest) return done({ ok: false, id, reason: `manifest.json 缺失或损坏：${path.join(dir, "manifest.json")}` });
  steps.push(`快照 ${id} · reason=${manifest.reason} · ${manifest.createdAt}`);

  // ① Verify everything BEFORE touching the live profile.
  const bad = verifyManifestFiles(dir, manifest);
  if (bad) return done({ ok: false, id, reason: bad });
  steps.push("sha256 校验通过");
  const integrity = verifyCookiesDb(path.join(dir, COOKIES_FILE));
  if (!integrity.ok) return done({ ok: false, id, reason: `快照 Cookies 完整性校验失败：${integrity.reason}` });
  steps.push("快照 Cookies integrity_check=ok");

  const run = opts.run ?? defaultRun;
  const unit = opts.browserUnit === null ? null : (opts.browserUnit ?? `wechat-browser@${alias}.service`);

  // ② Stop the browser so its SQLite handle cannot overwrite our copy.
  let managed = false;
  if (unit) {
    const probe = unitExists(run, unit);
    managed = probe.exists;
    if (!managed) {
      steps.push(`systemctl cat ${unit} → 未找到/不可用（${probe.detail}），跳过 stop`);
      warnings.push(
        `未托管：${unit} 不存在或 systemd 不可用 —— 若 Chrome 正在运行请自行关闭（WFC_BROWSER_MODE=inline 时无 unit），否则它可能覆盖回滚后的 Cookies`,
      );
    }
  } else {
    steps.push("systemd 跳过（未指定 browser unit）");
  }

  // `restore` 是*故障恢复*动作：任何一条失败路径都必须把浏览器拉起来，
  // 否则“恢复工具”反而把账号打成离线（2026-10-20 复核 B2）。
  // `systemctl start` 是幂等的，即使 stop 未生效也不会多起实例。
  const restart = (): void => {
    if (!unit || !managed) return;
    const started = controlUnit(run, unit, "start");
    steps.push(...started.steps);
    warnings.push(...started.warnings);
  };

  if (unit && managed) {
    const stopped = controlUnit(run, unit, "stop");
    steps.push(...stopped.steps);
    warnings.push(...stopped.warnings);
    if (stopped.blocked) {
      restart();
      return done({ ok: false, id, reason: stopped.blocked });
    }
  }

  const cookiesDest = cookiesDbPath(opts.profileDir);
  const localStateDest = path.join(opts.profileDir, LOCAL_STATE_FILE);
  const targets: { label: string; src: string; dest: string }[] = [
    { label: "Cookies", src: path.join(dir, COOKIES_FILE), dest: cookiesDest },
    { label: LOCAL_STATE_FILE, src: path.join(dir, LOCAL_STATE_FILE), dest: localStateDest },
  ];

  // ③ Back up whatever is live right now.
  const previous: { dest: string; backup: string | null }[] = [];
  try {
    fs.mkdirSync(path.dirname(cookiesDest), { recursive: true, mode: DIR_MODE });
    for (const t of targets) {
      if (fs.existsSync(t.dest)) {
        const backup = `${t.dest}.pre-restore`;
        copyAtomicFile(t.dest, backup);
        backups.push(backup);
        previous.push({ dest: t.dest, backup });
      } else {
        previous.push({ dest: t.dest, backup: null });
      }
    }
    steps.push(`已备份现网文件 → ${backups.length ? backups.join(", ") : "(现网无同名文件)"}`);
  } catch (err) {
    restart();
    return done({ ok: false, id, reason: `备份现网文件失败（未改动任何文件）：${msgOf(err)}` });
  }

  // ④ Swap.
  try {
    for (const side of SQLITE_SIDECARS) fs.rmSync(`${cookiesDest}${side}`, { force: true });
    for (const t of targets) {
      copyAtomicFile(t.src, t.dest);
      steps.push(`${t.label} ← 快照`);
    }
    const live = verifyCookiesDb(cookiesDest);
    if (!live.ok) throw new Error(`替换后 integrity_check 失败：${live.reason}`);
    steps.push("现网 Cookies integrity_check=ok");
  } catch (err) {
    const problem = msgOf(err);
    const rollback = revertFiles(previous);
    restart();
    return done({
      ok: false,
      id,
      reason: rollback
        ? `替换失败（${problem}），且回滚也失败（${rollback}）—— 请手工用 ${backups.join(", ") || "(无备份)"} 恢复`
        : `替换失败（${problem}），已回滚到 restore 前状态`,
    });
  }

  // ⑤ Bring the browser back; the caller re-probes to prove the session.
  restart();
  log.info(`[session] restore ${id} ok${warnings.length ? ` (${warnings.length} warnings)` : ""}`);
  return done({
    ok: true,
    id,
    ...(manifest.slaveSidExpiresAt !== undefined ? { slaveSidExpiresAt: manifest.slaveSidExpiresAt } : {}),
  });
}
