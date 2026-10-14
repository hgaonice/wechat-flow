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
  planWeekday: number;
  tickSec: number;
}

function clampInt(v: unknown, def: number, lo: number, hi: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : def;
  return Math.max(lo, Math.min(hi, n));
}

export function readSchedule(db: Database): ScheduleConfig {
  const s = asObject(getGlobalRaw(db).schedule);
  // Strictly boolean-ish: 0 / "0" / "false" also disable.
  const disabled = s.enabled === false || s.enabled === 0 || s.enabled === "0" || s.enabled === "false";
  return {
    enabled: !disabled,
    publishHour: clampInt(s.publishHour, 7, 0, 23),
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
        const id = queue.enqueue(db, row.id, "publish", { date: today }, {
          actor: "scheduler",
          auditDetail: { source: "scheduler", reason: "due" },
        });
        actions.push({ accountId: row.id, alias: row.alias, kind: "publish", jobId: id, reason: `due ${today}` });
      }
    }

    // plan: weekly slot with no plan yet
    if (weekday === cfg.planWeekday && !getPlan(db, row.id, "week", week) && !queue.hasActivePlanJob(db, row.id)) {
      const id = queue.enqueue(db, row.id, "plan", { periodKey: week }, {
        actor: "scheduler",
        auditDetail: { source: "scheduler", reason: `week ${week}` },
      });
      actions.push({ accountId: row.id, alias: row.alias, kind: "plan", jobId: id, reason: `week ${week}` });
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
