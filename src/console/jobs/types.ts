/**
 * Job / plan type model for the console queue (C2).
 *
 * Mirrors the `plans` / `jobs` / `job_logs` tables (see `db/schema.ts` and
 * `.trellis/spec/console/data-model.md`). Rows are kept as flat DB shapes; the
 * JSON payloads are parsed through the small helpers below so a hand-edited
 * row can never crash the worker.
 */
import { asObject } from "../types.ts";

/** Kinds the queue understands. C2 executes only `plan` + `publish`. */
export type JobKind = "plan" | "publish" | "generate" | "regenerate";

export const ALL_KINDS: JobKind[] = ["plan", "publish", "generate", "regenerate"];
/** Kinds the worker can actually run today (others → 400 on enqueue). */
export const EXECUTABLE_KINDS: JobKind[] = ["plan", "publish"];

export function isJobKind(v: unknown): v is JobKind {
  return typeof v === "string" && (ALL_KINDS as string[]).includes(v);
}

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";

export interface JobRow {
  id: number;
  account_id: number;
  kind: string;
  payload_json: string;
  status: string;
  progress: number;
  message: string | null;
  error: string | null;
  attempts: number;
  created_by: number | null;
  queued_at: string;
  started_at: string | null;
  ended_at: string | null;
  pid: number | null;
}

export interface JobLogRow {
  id: number;
  job_id: number;
  ts: string;
  level: string;
  message: string;
}

export interface PlanRow {
  id: number;
  account_id: number;
  period_type: string;
  period_key: string;
  items_json: string;
  status: string;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

/** A single plan day; engine `PlanDay` fields plus free-form extras. */
export interface PlanDay {
  date: string;
  weekday?: string;
  module?: string;
  topic: string;
  [key: string]: unknown;
}

/** Normalised `items_json` shape (week or month). */
export interface PlanItems {
  week?: string;
  month?: string;
  generatedAt?: string;
  account?: string;
  days: PlanDay[];
  [key: string]: unknown;
}

export interface JobPayload {
  date?: string;
  dryRun?: boolean;
  reuse?: boolean;
  force?: boolean;
  [key: string]: unknown;
}

/** Defensive payload parse (bad JSON → `{}`). */
export function parseJobPayload(row: JobRow): JobPayload {
  try {
    return asObject(JSON.parse(row.payload_json)) as JobPayload;
  } catch {
    return {};
  }
}

export function parseItems(row: PlanRow): PlanItems {
  try {
    const o = asObject(JSON.parse(row.items_json));
    const days = Array.isArray(o.days) ? (o.days as PlanDay[]) : [];
    return { ...o, days } as PlanItems;
  } catch {
    return { days: [] };
  }
}
