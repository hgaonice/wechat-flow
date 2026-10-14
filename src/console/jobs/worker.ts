/**
 * Worker: drain the job queue and call the engine.
 *
 * The worker is the ONLY place that reaches into the engine for a job:
 *   kind=plan    → `runPlan(cfg, {date?, dryRun?})`   (+ import result → DB)
 *   kind=publish → `runPublish(cfg, {date, reuse, force, dryRun})`
 *
 * It never re-implements publishing (H1). Failures are surfaced, never
 * swallowed into success (H5 / AC-11). One running job per account (I4).
 */
import type { Database } from "bun:sqlite";
import type { AppConfig } from "../../config.ts";
import { loadConfig } from "../../config.ts";
import { runPlan } from "../../planner.ts";
import { runPublish } from "../../publisher.ts";
import { isPublished } from "../../state.ts";
import { todayInTz } from "../../date.ts";
import { getAccountById } from "../db/dao/accounts.ts";
import * as queue from "./queue.ts";
import { importPlansFromFiles, materializePlans } from "./plans.ts";
import { parseJobPayload, type JobRow } from "./types.ts";

export interface WorkerHandle {
  stop(): Promise<void>;
  runningCount(): number;
}

export interface WorkerOptions {
  pollMs?: number;
  maxConcurrency?: number;
  onError?: (err: unknown) => void;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Execute one already-claimed (`running`) job to a terminal state.
 * Exported for tests and for a future `--once` mode.
 */
export async function executeJob(db: Database, job: JobRow): Promise<void> {
  const row = getAccountById(db, job.account_id);
  const log = (level: string, msg: string): void => {
    queue.appendLog(db, job.id, level, msg);
    console.log(`[job ${job.id}] ${msg}`);
  };
  const payload = parseJobPayload(job);

  if (!row) {
    log("error", `account ${job.account_id} no longer registered`);
    queue.finish(db, job.id, "failed", { message: "account removed", error: "account no longer registered" });
    return;
  }

  log("info", `start kind=${job.kind} account=${row.alias}`);
  queue.setProgress(db, job.id, 5, `开始执行 ${job.kind}`);

  let cfg: AppConfig;
  try {
    cfg = loadConfig(row.alias);
  } catch (err) {
    const m = `加载配置失败: ${errMsg(err)}`;
    log("error", m);
    queue.finish(db, job.id, "failed", { error: m });
    return;
  }

  try {
    if (job.kind === "plan") {
      queue.setProgress(db, job.id, 15, "调用 planner agent");
      const plan = await runPlan(cfg, { date: payload.date, dryRun: payload.dryRun === true });
      const imported = importPlansFromFiles(db, cfg, job.account_id);
      const dry = payload.dryRun === true;
      log("info", `plan ok: ${plan.days.length} 天，回写 DB ${imported} 条${dry ? "（dry-run）" : ""}`);
      queue.finish(db, job.id, "succeeded", {
        message: `${dry ? "dry-run " : ""}周计划已生成（${plan.days.length} 天）`,
        progress: 100,
      });
      return;
    }

    if (job.kind === "publish") {
      const date = typeof payload.date === "string" && payload.date ? payload.date : todayInTz();
      const force = payload.force === true;
      const reuse = payload.reuse === true;

      // Idempotency (I5′): engine state/published.json is the truth source.
      if (!force && !reuse) {
        const rec = isPublished(cfg.paths.state, date);
        if (rec?.ok === true) {
          log("info", `already published ${date}（跳过）`);
          queue.finish(db, job.id, "succeeded", { message: `already published ${date}`, progress: 100 });
          return;
        }
      }

      queue.setProgress(db, job.id, 15, "同步计划文件");
      const written = materializePlans(db, cfg, job.account_id);
      log("info", `materialized ${written.length} plan file(s)`);

      queue.setProgress(db, job.id, 25, `执行发布 ${date}`);
      const res = await runPublish(cfg, { date, dryRun: payload.dryRun === true, reuse, force });

      if (res.ok) {
        const note = res.skipped ? `skipped: ${res.reason ?? "already published"}` : `已推送到草稿箱 ${date}`;
        log("info", note);
        queue.finish(db, job.id, "succeeded", { message: note, progress: 100 });
      } else {
        const err = res.error ?? res.reason ?? "publish failed";
        log("error", err);
        queue.finish(db, job.id, "failed", {
          message: res.skipped ? `skipped: ${res.reason ?? ""}` : null,
          error: err,
        });
      }
      return;
    }

    // generate / regenerate are reserved for C3.
    log("error", `kind ${job.kind} 尚未实现`);
    queue.finish(db, job.id, "failed", { error: `kind ${job.kind} 尚未实现（C3）` });
  } catch (err) {
    const m = errMsg(err);
    log("error", m);
    queue.finish(db, job.id, "failed", { error: m });
  }
}

/** Start the pump loop. Reaps interrupted jobs first (I11). */
export function startWorker(db: Database, opts: WorkerOptions = {}): WorkerHandle {
  const pollMs = Math.max(100, (opts.pollMs ?? Number(process.env.CONSOLE_WORKER_POLL_MS ?? 2000)) || 2000);
  const maxConcurrency = Math.max(1, (opts.maxConcurrency ?? Number(process.env.CONSOLE_MAX_CONCURRENCY ?? 2)) || 2);
  const onError = opts.onError ?? ((err: unknown) => console.error("[console.worker]", err));

  const runningAccounts = new Set<number>();
  const tasks = new Set<Promise<void>>();
  let stopped = false;
  let pumping = false;

  const reaped = queue.reapStartup(db);
  if (reaped > 0) console.warn(`[console.worker] reaped ${reaped} interrupted job(s) → failed`);

  async function pump(): Promise<void> {
    if (stopped || pumping) return;
    pumping = true;
    try {
      while (!stopped && tasks.size < maxConcurrency) {
        const job = queue.claimNext(db, process.pid);
        if (!job) break;
        if (runningAccounts.has(job.account_id)) {
          // Defensive: the SQL guard should make this unreachable.
          queue.finish(db, job.id, "failed", { error: "account busy (in-process guard)" });
          continue;
        }
        runningAccounts.add(job.account_id);
        const task: Promise<void> = executeJob(db, job)
          .catch((err) => onError(err))
          .finally(() => {
            runningAccounts.delete(job.account_id);
            tasks.delete(task);
          });
        tasks.add(task);
      }
    } catch (err) {
      onError(err);
    } finally {
      pumping = false;
    }
  }

  const timer = setInterval(() => void pump(), pollMs);
  void pump();

  return {
    runningCount: () => tasks.size,
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      // Bounded drain: in-flight jobs finish if they can, but a hung engine
      // call must never block shutdown (SIGTERM) forever.
      const drainMs = Math.max(0, Number(process.env.CONSOLE_WORKER_DRAIN_MS ?? 30_000) || 30_000);
      const drained = Promise.allSettled([...tasks]).then(() => undefined);
      if (drainMs === 0 || tasks.size === 0) return drained;
      await Promise.race([
        drained,
        new Promise<void>((resolve) =>
          setTimeout(() => {
            console.warn(`[console.worker] drain timeout (${drainMs}ms): ${tasks.size} job(s) still running`);
            resolve();
          }, drainMs).unref?.(),
        ),
      ]);
    },
  };
}
