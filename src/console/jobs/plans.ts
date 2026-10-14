/**
 * Plans: DB is the console's source of truth; the engine's on-disk
 * `data/<alias>/plans/<week>.json` is a *derived* materialisation.
 *
 * Why both: the scheduler and UI need a queryable store, while the engine
 * (`runPublish` → `findEntryForDate`) reads plan files. So we keep the DB
 * authoritative for console edits and (re)materialise files:
 *   - `PUT /plans`        → DB upsert + `materializePlans`
 *   - before a publish     → `materializePlans` (defensive)
 *   - after an AI `plan`   → `importPlansFromFiles` (files the agent wrote → DB)
 *
 * This keeps the engine untouched (H1) while avoiding file/DB drift.
 */
import fs from "node:fs";
import path from "node:path";
import type { Database } from "bun:sqlite";
import type { AppConfig } from "../../config.ts";
import { planPath } from "../../planner.ts";
import { isoWeek, weekdayCn } from "../../date.ts";
import { asObject, isPlainObject } from "../types.ts";
import { parseItems, type PlanDay, type PlanItems, type PlanRow } from "./types.ts";

const WEEK_RE = /^(\d{4})-W(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type PeriodType = "week" | "month";

export interface PlanValidation {
  ok: boolean;
  error?: string;
  items?: PlanItems;
}

/**
 * Validate + normalise user-supplied plan items.
 * - week: 1..7 days, each `date` must fall inside `periodKey`'s ISO week;
 * - month: `periodKey` = `YYYY-MM`, days are overview entries (no week bound);
 * - every day needs a `topic`; `weekday` is filled from `date` when absent.
 */
export function validatePlanInput(periodType: string, periodKey: string, raw: unknown): PlanValidation {
  if (periodType !== "week" && periodType !== "month") {
    return { ok: false, error: "period_type 只能是 week 或 month" };
  }
  if (periodType === "week" && !WEEK_RE.test(periodKey)) {
    return { ok: false, error: `周计划 period_key 需形如 2026-W42（收到 ${periodKey}）` };
  }
  if (periodType === "month" && !MONTH_RE.test(periodKey)) {
    return { ok: false, error: `月计划 period_key 需形如 2026-10（收到 ${periodKey}）` };
  }
  if (!isPlainObject(raw)) return { ok: false, error: "items 必须是对象（含 days 数组）" };

  const daysRaw = (raw as Record<string, unknown>).days;
  if (!Array.isArray(daysRaw)) return { ok: false, error: "items.days 必须是数组" };
  if (periodType === "week" && daysRaw.length > 7) {
    return { ok: false, error: `周计划条目不能超过 7 天（收到 ${daysRaw.length}）` };
  }
  if (daysRaw.length === 0) return { ok: false, error: "items.days 不能为空" };

  const days: PlanDay[] = [];
  for (let i = 0; i < daysRaw.length; i++) {
    const d = asObject(daysRaw[i]);
    const date = typeof d.date === "string" ? d.date : "";
    if (!DATE_RE.test(date)) return { ok: false, error: `第 ${i + 1} 条 date 非法：${date || "(空)"}` };
    const iso = isoWeek(date);
    if (periodType === "week" && iso !== periodKey) {
      return { ok: false, error: `${date} 属于 ${iso}，不在 ${periodKey} 内` };
    }
    if (periodType === "month" && !date.startsWith(`${periodKey}-`)) {
      return { ok: false, error: `${date} 不在 ${periodKey} 内` };
    }
    const topic = typeof d.topic === "string" ? d.topic.trim() : "";
    if (!topic) return { ok: false, error: `${date} 缺少 topic` };
    days.push({ ...d, date, topic, weekday: typeof d.weekday === "string" && d.weekday ? d.weekday : weekdayCn(date) });
  }
  // Stable chronological order so the engine/materialised file is deterministic.
  days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const keyField = periodType === "week" ? "week" : "month";
  const items: PlanItems = { ...(raw as Record<string, unknown>), [keyField]: periodKey, days };
  return { ok: true, items };
}

// ── DB access ───────────────────────────────────────────────────────────────

const PLAN_COLUMNS = `id, account_id, period_type, period_key, items_json, status, created_by, created_at, updated_at`;

export interface PlanFilter {
  periodType?: string;
  periodKey?: string;
}

export function listPlans(db: Database, accountId: number, filter: PlanFilter = {}): PlanRow[] {
  const where: string[] = ["account_id = ?"];
  const args: (number | string)[] = [accountId];
  if (filter.periodType) {
    where.push("period_type = ?");
    args.push(filter.periodType);
  }
  if (filter.periodKey) {
    where.push("period_key = ?");
    args.push(filter.periodKey);
  }
  return db
    .query<PlanRow>(`SELECT ${PLAN_COLUMNS} FROM plans WHERE ${where.join(" AND ")} ORDER BY period_key DESC`)
    .all(...args);
}

export function getPlan(db: Database, accountId: number, periodType: string, periodKey: string): PlanRow | undefined {
  return (
    db
      .query<PlanRow>(`SELECT ${PLAN_COLUMNS} FROM plans WHERE account_id = ? AND period_type = ? AND period_key = ?`)
      .get(accountId, periodType, periodKey) ?? undefined
  );
}

/** Insert or overwrite a plan; returns the row id. */
export function upsertPlan(
  db: Database,
  accountId: number,
  periodType: PeriodType,
  periodKey: string,
  items: PlanItems,
  createdBy: number | null,
): number {
  const itemsJson = JSON.stringify(items);
  const existing = getPlan(db, accountId, periodType, periodKey);
  if (existing) {
    db.run(
      `UPDATE plans SET items_json = ?, status = 'active', updated_at = datetime('now') WHERE id = ?`,
      itemsJson,
      existing.id,
    );
    return existing.id;
  }
  const info = db.run(
    `INSERT INTO plans(account_id, period_type, period_key, items_json, status, created_by)
     VALUES (?, ?, ?, ?, 'active', ?)`,
    accountId,
    periodType,
    periodKey,
    itemsJson,
    createdBy,
  );
  return Number(info.lastInsertRowid);
}

/** Find the plan day (and its plan) matching a date for one account. */
export function findPlanDay(db: Database, accountId: number, date: string): { plan: PlanRow; day: PlanDay } | undefined {
  const rows = db
    .query<PlanRow>(`SELECT ${PLAN_COLUMNS} FROM plans WHERE account_id = ? AND period_type = 'week'`)
    .all(accountId);
  for (const row of rows) {
    const day = parseItems(row).days.find((d) => d.date === date);
    if (day) return { plan: row, day };
  }
  return undefined;
}

// ── engine file materialisation ─────────────────────────────────────────────

function atomicWriteFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
}

/**
 * Write every DB week plan for this account to `data/<alias>/plans/<week>.json`
 * so the engine's `findEntryForDate` can see console-authored plans.
 * Returns the paths written.
 */
export function materializePlans(db: Database, cfg: AppConfig, accountId: number): string[] {
  const written: string[] = [];
  for (const row of listPlans(db, accountId, { periodType: "week" })) {
    const items = parseItems(row);
    const plan = {
      week: row.period_key,
      generatedAt: items.generatedAt ?? row.updated_at,
      account: cfg.account,
      days: items.days,
    };
    const file = planPath(cfg, row.period_key);
    atomicWriteFile(file, JSON.stringify(plan, null, 2) + "\n");
    written.push(file);
  }
  return written;
}

/**
 * Import plan files the AI planner wrote (`runPlan`) back into the DB so the
 * DB stays the source of truth. Only `week` + `days` shaped files are imported;
 * `.dryrun.json` sidecars are ignored.
 */
/**
 * Migration bridge from the systemd-timer era: adopt week plans that only exist
 * as engine files (`data/<alias>/plans/*.json`). **The DB always wins** — a week
 * that already has a console plan is left untouched, so UI edits are never
 * clobbered. Returns how many weeks were adopted.
 */
export function fillMissingPlansFromFiles(db: Database, cfg: AppConfig, accountId: number): number {
  const dir = cfg.paths.plans;
  if (!fs.existsSync(dir)) return 0;
  let imported = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json") || f.endsWith(".dryrun.json")) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Record<string, unknown>;
      const week = typeof parsed.week === "string" ? parsed.week : "";
      if (!WEEK_RE.test(week) || !Array.isArray(parsed.days)) continue;
      if (getPlan(db, accountId, "week", week)) continue; // DB 优先
      const result = validatePlanInput("week", week, { ...parsed, days: parsed.days });
      if (!result.ok || !result.items) continue;
      upsertPlan(db, accountId, "week", week, result.items, null);
      imported++;
    } catch {
      /* skip malformed file */
    }
  }
  return imported;
}

export function importPlansFromFiles(db: Database, cfg: AppConfig, accountId: number): number {
  const dir = cfg.paths.plans;
  if (!fs.existsSync(dir)) return 0;
  let imported = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json") || f.endsWith(".dryrun.json")) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Record<string, unknown>;
      const week = typeof parsed.week === "string" ? parsed.week : "";
      if (!WEEK_RE.test(week) || !Array.isArray(parsed.days)) continue;
      const result = validatePlanInput("week", week, { ...parsed, days: parsed.days });
      if (!result.ok || !result.items) continue;
      upsertPlan(db, accountId, "week", week, result.items, null);
      imported++;
    } catch {
      /* skip malformed file */
    }
  }
  return imported;
}
