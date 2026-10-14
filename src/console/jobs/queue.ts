/**
 * Job queue: enqueue, atomic claim, progress, and terminal transitions.
 *
 * Invariants (spec/console/data-model.md I3/I4/I11):
 *   - status is one-way: queued → running → {succeeded,failed,canceled};
 *   - at most ONE `running` job per account (SQL `NOT EXISTS` guard);
 *   - a restart reaps leftover `running` rows to `failed`.
 * Every transition is a conditional UPDATE — never a blind write.
 */
import type { Database } from "bun:sqlite";
import { recordAudit } from "../db/dao/audit.ts";
import type { Json, JsonObject } from "../types.ts";
import { parseJobPayload, type JobKind, type JobLogRow, type JobRow, type JobStatus, type JobPayload } from "./types.ts";

const JOB_COLUMNS = `id, account_id, kind, payload_json, status, progress, message, error, attempts,
  created_by, queued_at, started_at, ended_at, pid`;

export interface EnqueueOptions {
  createdBy?: number | null;
  actor?: string | null;
  /** Merge extra fields into the audit detail (e.g. source: "scheduler"). */
  auditDetail?: JsonObject;
}

/** Insert a `queued` job and record the audit trail (I12). Returns the new id. */
export function enqueue(
  db: Database,
  accountId: number,
  kind: JobKind,
  payload: JobPayload = {},
  opts: EnqueueOptions = {},
): number {
  const info = db.run(
    `INSERT INTO jobs(account_id, kind, payload_json, status, created_by) VALUES (?, ?, ?, 'queued', ?)`,
    accountId,
    kind,
    JSON.stringify(payload),
    opts.createdBy ?? null,
  );
  const id = Number(info.lastInsertRowid);
  recordAudit(db, {
    userId: opts.createdBy ?? null,
    actor: opts.actor ?? null,
    action: "job_enqueue",
    target: `job:${id}`,
    detail: { accountId, kind, payload: payload as unknown as Json, ...(opts.auditDetail ?? {}) },
    ok: true,
  });
  return id;
}

export function getJob(db: Database, id: number): JobRow | undefined {
  return db.query<JobRow>(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`).get(id) ?? undefined;
}

export interface ListJobsOptions {
  status?: string;
  limit?: number;
}

export function listJobsForAccount(db: Database, accountId: number, opts: ListJobsOptions = {}): JobRow[] {
  const limit = Math.max(1, Math.min(500, opts.limit ?? 50));
  if (opts.status) {
    return db
      .query<JobRow>(`SELECT ${JOB_COLUMNS} FROM jobs WHERE account_id = ? AND status = ? ORDER BY id DESC LIMIT ?`)
      .all(accountId, opts.status, limit);
  }
  return db
    .query<JobRow>(`SELECT ${JOB_COLUMNS} FROM jobs WHERE account_id = ? ORDER BY id DESC LIMIT ?`)
    .all(accountId, limit);
}

export function listJobLogs(db: Database, jobId: number, limit = 100): JobLogRow[] {
  return db
    .query<JobLogRow>(`SELECT * FROM job_logs WHERE job_id = ? ORDER BY id DESC LIMIT ?`)
    .all(jobId, Math.max(1, Math.min(500, limit)));
}

export function appendLog(db: Database, jobId: number, level: string, message: string): void {
  db.run(`INSERT INTO job_logs(job_id, level, message) VALUES (?, ?, ?)`, jobId, level, message);
}

/** Best-effort progress/heartbeat update while a job is running. */
export function setProgress(db: Database, jobId: number, progress: number, message?: string): void {
  const p = Math.max(0, Math.min(100, Math.round(progress)));
  if (message !== undefined) {
    db.run(`UPDATE jobs SET progress = ?, message = ? WHERE id = ? AND status = 'running'`, p, message, jobId);
  } else {
    db.run(`UPDATE jobs SET progress = ? WHERE id = ? AND status = 'running'`, p, jobId);
  }
}

/**
 * Atomically claim the oldest queued job whose account has no running job.
 * Under concurrency only one caller can win a given row; returns it, else undefined.
 */
export function claimNext(db: Database, pid: number | null = process.pid): JobRow | undefined {
  return db
    .query<JobRow>(
      `UPDATE jobs
          SET status = 'running', started_at = datetime('now'), attempts = attempts + 1, pid = ?
        WHERE id = (
          SELECT j.id FROM jobs j
           WHERE j.status = 'queued'
             AND NOT EXISTS (SELECT 1 FROM jobs r WHERE r.account_id = j.account_id AND r.status = 'running')
           ORDER BY j.id
           LIMIT 1
        )
        RETURNING ${JOB_COLUMNS}`,
    )
    .get(pid) ?? undefined;
}

/** Move a running job to a terminal state. Returns false if it was not `running`. */
export function finish(
  db: Database,
  jobId: number,
  status: Extract<JobStatus, "succeeded" | "failed">,
  opts: { message?: string | null; error?: string | null; progress?: number } = {},
): boolean {
  const info = db.run(
    `UPDATE jobs SET status = ?, message = ?, error = ?, progress = COALESCE(?, progress), ended_at = datetime('now')
      WHERE id = ? AND status = 'running'`,
    status,
    opts.message ?? null,
    opts.error ?? null,
    opts.progress ?? (status === "succeeded" ? 100 : null), // failure keeps last progress
    jobId,
  );
  return info.changes > 0;
}

/** Cancel a queued job (running jobs are left to the worker). Returns true on success. */
export function cancel(db: Database, jobId: number): boolean {
  const info = db.run(
    `UPDATE jobs SET status = 'canceled', message = 'canceled by user', ended_at = datetime('now')
      WHERE id = ? AND status = 'queued'`,
    jobId,
  );
  return info.changes > 0;
}

/** Startup reaper (I11): leftover `running` rows from a previous process → `failed`. */
export function reapStartup(db: Database): number {
  const info = db.run(
    `UPDATE jobs SET status = 'failed', error = 'interrupted by restart', progress = 0, ended_at = datetime('now')
      WHERE status = 'running'`,
  );
  return info.changes;
}

// ── dedup queries (used by the scheduler / idempotency pre-check) ────────────

function countJobs(db: Database, accountId: number, kind: string, date: string | null, statuses: JobStatus[]): number {
  const placeholders = statuses.map(() => "?").join(", ");
  const dateClause = date === null ? "" : ` AND json_extract(payload_json, '$.date') = ?`;
  const args: (number | string)[] = [accountId, kind, ...(date === null ? [] : [date]), ...statuses];
  const row = db
    .query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM jobs
        WHERE account_id = ? AND kind = ?${dateClause} AND status IN (${placeholders})`,
    )
    .get(...args);
  return row?.n ?? 0;
}

/** True when this account already has a publish job for `date` in a live/relevant state. */
export function hasPublishJobForDate(db: Database, accountId: number, date: string): boolean {
  return countJobs(db, accountId, "publish", date, ["queued", "running", "succeeded"]) > 0;
}

/** True when a plan job is queued/running (scheduler must not pile up more). */
export function hasActivePlanJob(db: Database, accountId: number): boolean {
  return countJobs(db, accountId, "plan", null, ["queued", "running"]) > 0;
}

// ── failure backoff (C6, I32 / design.md D31) ──────────────────────────────

/**
 * Count `failed` jobs for an account+kind matching the scheduling key. The key
 * matches the job's `payload.date` (publish) or `payload.periodKey` (plan) so
 * the same helper serves both schedulers.
 */
export function countFailed(db: Database, accountId: number, kind: JobKind, key: string): number {
  const row = db
    .query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM jobs
        WHERE account_id = ? AND kind = ? AND status = 'failed'
          AND (json_extract(payload_json, '$.date') = ? OR json_extract(payload_json, '$.periodKey') = ?)`,
    )
    .get(accountId, kind, key, key);
  return row?.n ?? 0;
}

/**
 * Most recent failure time for an account+kind+key as a SQLite UTC string
 * (`ended_at ?? queued_at`), or `null` when there has never been a failure.
 */
export function lastFailureAt(db: Database, accountId: number, kind: JobKind, key: string): string | null {
  const row = db
    .query<{ t: string | null }>(
      `SELECT COALESCE(ended_at, queued_at) AS t FROM jobs
        WHERE account_id = ? AND kind = ? AND status = 'failed'
          AND (json_extract(payload_json, '$.date') = ? OR json_extract(payload_json, '$.periodKey') = ?)
        ORDER BY id DESC LIMIT 1`,
    )
    .get(accountId, kind, key, key);
  return row?.t ?? null;
}

export { parseJobPayload };
