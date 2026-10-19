/**
 * Scheduler: scan due plans on a timer and enqueue jobs (idempotently).
 *
 * Strategy (`schedule` subtree of the global settings, all optional):
 *   publish — if today has a plan day, now ≥ publishHour, nothing published
 *             yet (engine state) and no live publish job → enqueue;
 *   plan    — if it is planWeekday and this ISO week has no plan → enqueue.
 *
 * The engine timezone (`Asia/Shanghai`) is the single clock, matching
 * `date.ts`. `tickSec` is read once at start (change it → restart).
 */
import type { Database } from "bun:sqlite";
import { loadConfig, type AppConfig } from "../../config.ts";
import { isoWeek, todayInTz } from "../../date.ts";
import { isPublished } from "../../state.ts";
import { listAccountRows } from "../db/dao/accounts.ts";
import { getGlobalRaw } from "../db/dao/settings.ts";
import { asObject } from "../types.ts";
import * as queue from "./queue.ts";
import { fillMissingPlansFromFiles, findPlanDay, getPlan } from "./plans.ts";

export const TZ = "Asia/Shanghai";

export interface ScheduleConfig {
  enabled: boolean;
  publishHour: number;
  /** Stop *retrying* a failed publish after this hour (0 = no deadline). */
  publishDeadlineHour: number;
  planWeekday: number;
  tickSec: number;
}

function clampInt(v: unknown, def: number, lo: number, hi: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : def;
  return Math.max(lo, Math.min(hi, n));
}

// ── failure backoff (C6, I32 / design.md D31) ──────────────────────────────

const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_RETRY_COOLDOWN_MIN = 15;
const DEFAULT_RETRY_COOLDOWN_MAX_MIN = 60;
const DEFAULT_PUBLISH_DEADLINE_HOUR = 12;

/** Read an integer env var and clamp it; non-numeric values fall back to `def`. */
function envIntClamped(name: string, def: number, lo: number, hi: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return def;
  return Math.max(lo, Math.min(hi, Math.trunc(raw)));
}

/**
 * Normalize a SQLite timestamp to epoch ms. `datetime('now')` yields
 * `YYYY-MM-DD HH:MM:SS` (UTC) which `Date.parse` treats as local time, so we
 * insert the `T`/`Z`. Already-ISO strings are parsed as-is.
 */
function parseDbTime(value: string): number | null {
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const t = Date.parse(normalized);
  return Number.isFinite(t) ? t : null;
}

export function readSchedule(db: Database): ScheduleConfig {
  const s = asObject(getGlobalRaw(db).schedule);
  // Strictly boolean-ish: 0 / "0" / "false" also disable.
  const disabled = s.enabled === false || s.enabled === 0 || s.enabled === "0" || s.enabled === "false";
  return {
    enabled: !disabled,
    publishHour: clampInt(s.publishHour, 7, 0, 23),
    publishDeadlineHour: clampInt(s.publishDeadlineHour, DEFAULT_PUBLISH_DEADLINE_HOUR, 0, 23),
    planWeekday: clampInt(s.planWeekday, 0, 0, 6),
    tickSec: clampInt(s.tickSec, 60, 5, 3600),
  };
}

function hourInTz(tz: string, d: Date): number {
  const s = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(d);
  return Number(s) % 24;
}

/** 0 = Sunday … 6 = Saturday, in `tz`. */
function weekdayInTz(tz: string, d: Date): number {
  const s = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(d);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(s);
}

export interface ScheduleAction {
  accountId: number;
  alias: string;
  kind: "plan" | "publish";
  jobId: number;
  reason: string;
}

/**
 * One scheduling pass. Pure with respect to wall-clock (takes `now`), returns
 * the jobs it enqueued. Repeated calls with the same `now` enqueue nothing.
 */
export function schedulerTick(db: Database, now: Date = new Date()): ScheduleAction[] {
  const cfg = readSchedule(db);
  if (!cfg.enabled) return [];

  const today = todayInTz(TZ, now);
  const hour = hourInTz(TZ, now);
  const weekday = weekdayInTz(TZ, now);
  const week = isoWeek(today);
  const actions: ScheduleAction[] = [];

  // C6 backoff budget/cooldown (env-driven; 0 disables each dimension).
  // The cooldown grows with consecutive failures (15 → 30 → 60 … capped), so an
  // all-morning upstream outage is retried across the whole morning instead of
  // giving up after three tries inside 40 minutes.
  const maxAttempts = envIntClamped("CONSOLE_JOB_MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS, 0, 100);
  const cooldownBaseMin = envIntClamped("CONSOLE_JOB_RETRY_COOLDOWN_MIN", DEFAULT_RETRY_COOLDOWN_MIN, 0, 1440);
  const cooldownMaxMin = envIntClamped("CONSOLE_JOB_RETRY_COOLDOWN_MAX_MIN", DEFAULT_RETRY_COOLDOWN_MAX_MIN, 0, 1440);
  const nowMs = now.getTime();

  /** Reason string when this account/kind/key is still backing off, else null. */
  const backoffReason = (accountId: number, kind: "plan" | "publish", key: string): string | null => {
    const failures = queue.countFailed(db, accountId, kind, key);
    if (maxAttempts > 0 && failures >= maxAttempts) {
      return "attempts-exhausted";
    }
    if (cooldownBaseMin > 0 && failures > 0) {
      const last = queue.lastFailureAt(db, accountId, kind, key);
      if (last) {
        const t = parseDbTime(last);
        const cooldownMs = Math.min(cooldownBaseMin * 2 ** (failures - 1), cooldownMaxMin) * 60_000;
        if (t !== null && nowMs - t < cooldownMs) return "backoff";
      }
    }
    return null;
  };

  for (const row of listAccountRows(db)) {
    if (row.enabled === 0) continue;

    let acfg: AppConfig | null = null;
    try {
      acfg = loadConfig(row.alias);
    } catch {
      acfg = null; // un-renderable account: still enqueue so the worker surfaces it
    }

    // Migration bridge: adopt plans that only exist as engine files (DB wins).
    if (acfg) {
      try {
        fillMissingPlansFromFiles(db, acfg, row.id);
      } catch {
        /* worker will report the real error */
      }
    }

    // publish: today is in the plan and we've passed publishHour
    const found = findPlanDay(db, row.id, today);
    if (found && hour >= cfg.publishHour) {
      let published = false;
      if (acfg) {
        try {
          published = isPublished(acfg.paths.state, today)?.ok === true;
        } catch {
          published = false;
        }
      }
      if (!published && !queue.hasPublishJobForDate(db, row.id, today)) {
        // Deadline only stops *retries* — a first attempt is still allowed at
        // any hour (the user may have fixed the plan/config mid-day).
        const pastDeadline =
          cfg.publishDeadlineHour > 0 &&
          hour >= cfg.publishDeadlineHour &&
          queue.countFailed(db, row.id, "publish", today) > 0;
        const skip = pastDeadline ? "deadline" : backoffReason(row.id, "publish", today);
        if (skip) {
          console.log(`[scheduler] skip publish for ${row.alias} (${skip})`);
        } else {
          const id = queue.enqueue(db, row.id, "publish", { date: today }, {
            actor: "scheduler",
            auditDetail: { source: "scheduler", reason: "due" },
          });
          actions.push({ accountId: row.id, alias: row.alias, kind: "publish", jobId: id, reason: `due ${today}` });
        }
      }
    }

    // plan: weekly slot with no plan yet
    if (weekday === cfg.planWeekday && !getPlan(db, row.id, "week", week) && !queue.hasActivePlanJob(db, row.id)) {
      const skip = backoffReason(row.id, "plan", week);
      if (skip) {
        console.log(`[scheduler] skip plan for ${row.alias} (${skip})`);
      } else {
        const id = queue.enqueue(db, row.id, "plan", { periodKey: week }, {
          actor: "scheduler",
          auditDetail: { source: "scheduler", reason: `week ${week}` },
        });
        actions.push({ accountId: row.id, alias: row.alias, kind: "plan", jobId: id, reason: `week ${week}` });
      }
    }
  }
  return actions;
}

export interface SchedulerHandle {
  stop(): void;
  /** Run a pass immediately (used by tests/`--once`). */
  tick(now?: Date): ScheduleAction[];
}

export interface SchedulerOptions {
  onActions?: (actions: ScheduleAction[]) => void;
  onError?: (err: unknown) => void;
}

/** Start the interval; a `ticking` flag prevents overlapping passes. */
export function startScheduler(db: Database, opts: SchedulerOptions = {}): SchedulerHandle {
  const onError = opts.onError ?? ((err: unknown) => console.error("[console.scheduler]", err));
  const cfg = readSchedule(db);
  let ticking = false;

  const run = (): void => {
    if (ticking) return;
    ticking = true;
    try {
      const actions = schedulerTick(db);
      if (actions.length && opts.onActions) opts.onActions(actions);
    } catch (err) {
      onError(err);
    } finally {
      ticking = false;
    }
  };

  const timer = setInterval(run, cfg.tickSec * 1000);
  run(); // don't wait a whole interval after start
  return { stop: () => clearInterval(timer), tick: (now?: Date) => schedulerTick(db, now) };
}
