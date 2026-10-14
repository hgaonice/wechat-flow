/**
 * Zero-dependency Server-Sent Events for job progress (C3, spec/console/api.md §3).
 *
 * The worker and the HTTP server share a process but no event bus, so we poll
 * the `jobs` row + `job_logs` table every ~700ms. That keeps the stream
 * dependency-free and crash-correct (a reconnect resumes from `Last-Event-ID`
 * = the last `job_logs.id` the client saw).
 *
 * Events:
 *   job.progress {jobId,status,progress,message}
 *   job.log      {jobId,ts,level,message}   (id: = job_logs.id)
 *   job.done     {jobId,status,error}
 * Heartbeat: a `: ping` comment every 15s so proxies/tunnels don't cut it.
 */
import type { Database } from "bun:sqlite";

const TERMINAL = new Set(["succeeded", "failed", "canceled"]);
const encoder = new TextEncoder();

interface JobStateRow {
  id: number;
  status: string;
  progress: number;
  message: string | null;
  error: string | null;
}

interface JobLogRecord {
  id: number;
  ts: string;
  level: string;
  message: string;
}

function frame(event: string | null, data: unknown, id?: number): Uint8Array {
  let out = "";
  if (id !== undefined) out += `id: ${id}\n`;
  if (event) out += `event: ${event}\n`;
  out += `data: ${JSON.stringify(data)}\n\n`;
  return encoder.encode(out);
}

export interface StreamOptions {
  /** Poll interval in ms (default 700). */
  pollMs?: number;
  /** Heartbeat interval in ms (default 15000). */
  pingMs?: number;
  /** Max log rows emitted per tick (default 200). */
  logBatch?: number;
}

/**
 * Build the SSE body for one job. `lastEventId` is the resume cursor (the last
 * `job_logs.id` already delivered); logs at or below it are not resent.
 */
export function streamJobEvents(
  db: Database,
  jobId: number,
  lastEventId = 0,
  opts: StreamOptions = {},
): ReadableStream<Uint8Array> {
  const pollMs = Math.max(50, opts.pollMs ?? 700);
  const pingMs = Math.max(1000, opts.pingMs ?? 15_000);
  const logBatch = Math.max(1, Math.min(1000, opts.logBatch ?? 200));

  let closed = false;
  let cursor = Number.isFinite(lastEventId) && lastEventId > 0 ? Math.floor(lastEventId) : 0;
  let lastStateKey = "";
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: Uint8Array): void => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          closed = true;
        }
      };
      const close = (): void => {
        if (closed) return;
        closed = true;
        if (pollTimer) clearInterval(pollTimer);
        if (pingTimer) clearInterval(pingTimer);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const tick = (): void => {
        if (closed) return;
        try {
          const job = db
            .query<JobStateRow>(`SELECT id, status, progress, message, error FROM jobs WHERE id = ?`)
            .get(jobId);
          if (!job) {
            send(frame("job.done", { jobId, status: "failed", error: "job not found" }));
            close();
            return;
          }

          const key = `${job.status}|${job.progress}|${job.message ?? ""}`;
          if (key !== lastStateKey) {
            lastStateKey = key;
            send(
              frame("job.progress", {
                jobId,
                status: job.status,
                progress: job.progress,
                message: job.message,
              }),
            );
          }

          const logs = db
            .query<JobLogRecord>(
              `SELECT id, ts, level, message FROM job_logs WHERE job_id = ? AND id > ? ORDER BY id ASC LIMIT ?`,
            )
            .all(jobId, cursor, logBatch);
          for (const l of logs) {
            cursor = l.id;
            send(frame("job.log", { jobId, ts: l.ts, level: l.level, message: l.message }, l.id));
          }

          if (TERMINAL.has(job.status)) {
            send(frame("job.done", { jobId, status: job.status, error: job.error }));
            close();
          }
        } catch {
          close();
        }
      };

      pollTimer = setInterval(tick, pollMs);
      pingTimer = setInterval(() => send(encoder.encode(": ping\n\n")), pingMs);
      tick();
    },
    cancel() {
      closed = true;
      if (pollTimer) clearInterval(pollTimer);
      if (pingTimer) clearInterval(pingTimer);
    },
  });
}
