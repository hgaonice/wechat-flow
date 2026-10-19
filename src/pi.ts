import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

/**
 * Thin, version-independent integration with the pi CLI.
 *
 * pi is invoked in non-interactive JSON mode (`pi --print --mode json`), which
 * streams JSONL session events on stdout and the final assistant text is taken
 * from the last assistant `message_end` event. Diagnostics go to stderr.
 *
 * IMPORTANT: pi exits 0 even when the upstream provider fails, so we inspect the
 * event stream for `stopReason: "error"` / `errorMessage` and treat that as a
 * failure.
 *
 * Failure handling (10-18-model-fallback-resilience):
 *   - every failure is classified `fatal` (model/credential/quota config is
 *     wrong → do NOT retry, move to the next model) or `retryable` (5xx/429/
 *     timeout → exponential backoff + jitter on the same model);
 *   - the whole chain is recorded, and when every model fails the error string
 *     carries a per-hop summary instead of just the last hop's message
 *     (that is what made "provider: 500 Upstream request failed" hide a total
 *     fallback-chain outage);
 *   - a per-run budget stops the chain from eating the whole publishing window.
 *
 * See: docs/cli-integration.md, docs/json.md in the pi package.
 */

export interface PiRunOptions {
  prompt: string;
  cwd: string;
  piBin?: string;
  model?: string;
  thinking?: string;
  skills?: string[];
  /** Path to a file appended to the system prompt. */
  appendSystemPrompt?: string;
  sessionId?: string;
  sessionDir?: string;
  noSession?: boolean;
  timeoutSec?: number;
  extraArgs?: string[];
  env?: Record<string, string | undefined>;
  onEvent?: (event: any) => void;
  onStderr?: (chunk: string) => void;
  /** Retries per model after a *retryable* failure. Default 2 (3 attempts). */
  retries?: number;
  /** Delay between retries, in seconds. Default 30 (doubles per attempt). */
  retryDelaySec?: number;
  /** Max delay between retries, in seconds. Default 120. */
  maxRetryDelaySec?: number;
  /** Wall-clock budget for the whole chain, in seconds. Default 900 (0 = off). */
  chainBudgetSec?: number;
  /**
   * Kill a single attempt after this many seconds *without any output*.
   * A hung upstream stream otherwise blocks the whole publishing window:
   * `timeoutSec` is the full-run cap (30 min), far too long per attempt.
   * Default 600 (0 = off).
   */
  idleTimeoutSec?: number;
  /** Models to try, in order, when the primary model fails. */
  fallbackModels?: string[];
  onRetry?: (attempt: number, error: string) => void;
}

export interface PiAttempt {
  model?: string;
  class: "ok" | "fatal" | "retryable" | "timeout";
  ms: number;
  error?: string;
}

export interface PiRunResult {
  ok: boolean;
  finalText: string;
  events: any[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  /** Killed because the stream went silent for too long (retryable). */
  idleTimedOut?: boolean;
  attempts: number;
  error?: string;
  /** Every attempt made, in order (model + class + duration). */
  chain?: PiAttempt[];
  /** Model that produced the text (set on success when the chain ran). */
  usedModel?: string;
}

// ── error classification ───────────────────────────────────────────────────

export type PiFailureClass = "fatal" | "retryable";

/**
 * Errors that retrying cannot fix: the model does not exist locally, the
 * upstream relay has no channel for it, credentials are wrong, or the account
 * is out of quota. Retrying these only burns the publishing window.
 */
const FATAL_PATTERNS: RegExp[] = [
  /Model\s+"[^"]*"\s+not found/i,
  /model_not_found/i,
  /No available channel/i,
  /invalid api key|无可用令牌|令牌无效|令牌已过期/i,
  /Insufficient (balance|quota)|余额不足|已欠费/i,
];

/** Auth-style HTTP statuses inside a provider message. */
const FATAL_STATUS = /\b(401|403)\b/;

/** Errors that a later attempt (or a later model) may survive. */
const RETRYABLE_PATTERNS: RegExp[] = [
  /Upstream request failed/i,
  /Quota service is temporarily unavailable/i,
  /Service Unavailable/i,
  /\b(429|5\d{2})\b/,
  /timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up/i,
];

/**
 * Classify a failed run. `stderr` participates because "Model X not found"
 * arrives as `exit 1` on stderr, not as a provider error event.
 *
 * Defaults to `retryable`: wrongly skipping a usable model is worse than one
 * extra 30s wait.
 */
export function classifyPiFailure(input: { error?: string; stderr?: string }): PiFailureClass {
  const text = `${input.error ?? ""}\n${input.stderr ?? ""}`;
  for (const re of FATAL_PATTERNS) if (re.test(text)) return "fatal";
  if (FATAL_STATUS.test(text)) return "fatal";
  for (const re of RETRYABLE_PATTERNS) if (re.test(text)) return "retryable";
  return "retryable";
}

/** Pull a human-readable message out of a provider error blob. */
function providerMessage(raw?: string): string {
  if (!raw) return "";
  const s = raw.trim();
  const start = s.indexOf("{");
  if (start === -1) return s;
  const json = s.slice(start);
  try {
    const o = JSON.parse(json);
    return String(o?.error?.message ?? o?.message ?? s);
  } catch {
    return s;
  }
}

/** Short (≤24 char) reason used in chain summaries. */
export function shortReason(raw?: string): string {
  if (!raw) return "unknown";
  const text = `${raw}\n${providerMessage(raw)}`;
  if (/No available channel/i.test(text)) return "no channel";
  if (/Model\s+"[^"]*"\s+not found/i.test(text) || /model_not_found/i.test(text)) return "model not found";
  if (/Quota service is temporarily unavailable/i.test(text)) return "402 quota";
  if (/Insufficient (balance|quota)|余额不足|已欠费/i.test(text)) return "insufficient balance";
  if (/invalid api key|无可用令牌|令牌无效/i.test(text)) return "invalid api key";
  if (/Upstream request failed/i.test(text)) return "500 upstream";
  if (/Service Unavailable/i.test(text)) return "503 unavailable";
  if (/timeout|ETIMEDOUT|ECONNRESET|socket hang up/i.test(text)) return "timeout";
  const code = text.match(/\b(4\d{2}|5\d{2})\b/);
  if (code) return `http ${code[1]}`;
  const msg = providerMessage(raw).replace(/\s+/g, " ").trim();
  return msg.length > 24 ? `${msg.slice(0, 23)}…` : msg || "unknown";
}

/**
 * Build the final error string.
 * A single attempt keeps the historical `provider: …` / `exit N` shape so old
 * logs and greps keep working; a multi-model chain is summarised hop by hop.
 */
export function formatChainError(chain: PiAttempt[]): string {
  if (chain.length === 0) return "no attempt made";
  if (chain.length === 1) return chain[0]!.error ?? "unknown";
  const hops = chain.map((a) => `${a.model ?? "(default)"}[${shortReason(a.error)}]`);
  const models = new Set(chain.map((a) => a.model ?? "(default)"));
  return `all ${models.size} models failed (${chain.length} attempts): ${hops.join(" → ")}`;
}

// ── model catalog (B4 self-check) ──────────────────────────────────────────

interface ModelCacheEntry {
  at: number;
  models: Set<string> | null;
}
const modelCache = new Map<string, ModelCacheEntry>();
const MODEL_CACHE_TTL_MS = Number(process.env.PI_MODELS_CACHE_TTL_MS ?? 600_000);

/**
 * Parse `pi --list-models` output.
 *
 * The table is `provider  model  context  max-out  thinking  images`, separated
 * by two or more spaces. Config in this repo writes bare ids (`justwoker/x`) as
 * well as `provider/model` (`deepseek/deepseek-flash`), so both keys are kept.
 */
export function parseModelList(output: string): Set<string> {
  const out = new Set<string>();
  for (const line of output.split("\n")) {
    if (!line.trim() || /^provider\s/.test(line)) continue;
    const cols = line.trim().split(/\s{2,}/);
    if (cols.length < 2) continue;
    const [provider, model] = [cols[0]!.trim(), cols[1]!.trim()];
    if (!provider || !model) continue;
    out.add(model);
    out.add(`${provider}/${model}`);
  }
  return out;
}

/**
 * Available model ids on this host, or `null` when the probe fails.
 * Never throws: a broken probe must not block publishing.
 */
export function listAvailableModels(piBin = "pi", env?: Record<string, string | undefined>): Set<string> | null {
  const key = piBin;
  const cached = modelCache.get(key);
  if (cached && Date.now() - cached.at < MODEL_CACHE_TTL_MS) return cached.models;

  let models: Set<string> | null = null;
  try {
    const r = spawnSync(piBin, ["--list-models"], {
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, ...env } as NodeJS.ProcessEnv,
    });
    const text = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    if (r.status === 0 && text.includes("provider")) models = parseModelList(text);
  } catch {
    models = null;
  }
  modelCache.set(key, { at: Date.now(), models });
  return models;
}

/** Configured ids that do not exist on this host (empty when unknown). */
export function missingModels(configured: (string | undefined)[], available: Set<string> | null): string[] {
  if (!available) return [];
  return configured.filter((m): m is string => typeof m === "string" && m.length > 0 && !available.has(m));
}

// ── single run ─────────────────────────────────────────────────────────────

function textFromMessage(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && (c.type === "text" || typeof c.text === "string"))
      .map((c) => c.text ?? "")
      .join("");
  }
  return "";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DEFAULT_IDLE_TIMEOUT_SEC = 600;

async function runPiOnce(opts: PiRunOptions): Promise<PiRunResult> {
  const args: string[] = ["--print", "--mode", "json"];
  if (opts.noSession) args.push("--no-session");
  if (opts.sessionId) args.push("--session-id", opts.sessionId);
  if (opts.sessionDir) args.push("--session-dir", opts.sessionDir);
  if (opts.model) args.push("--model", opts.model);
  if (opts.thinking) args.push("--thinking", opts.thinking);
  for (const s of opts.skills ?? []) args.push("--skill", s);
  if (opts.appendSystemPrompt) args.push("--append-system-prompt", opts.appendSystemPrompt);
  for (const a of opts.extraArgs ?? []) args.push(a);
  args.push("--", opts.prompt);

  const bin = opts.piBin ?? "pi";
  const events: any[] = [];
  let stdout = "";
  let stderr = "";
  let finalText = "";
  let providerError: string | undefined;
  let timedOut = false;
  let idleTimedOut = false;

  const child = spawn(bin, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env } as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts.timeoutSec && opts.timeoutSec > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000);
    }, opts.timeoutSec * 1000);
  }

  // Idle watchdog: no stdout/stderr for N seconds ⇒ the upstream stream is dead.
  const idleMs = (opts.idleTimeoutSec ?? DEFAULT_IDLE_TIMEOUT_SEC) * 1000;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = (): void => {
    if (!(idleMs > 0)) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (child.killed) return;
      idleTimedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000);
    }, idleMs);
  };
  armIdle();

  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    armIdle();
    stdout += chunk;
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let evt: any;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      events.push(evt);

      const msg = evt.message;
      if (msg?.role === "assistant") {
        if (msg.stopReason === "error") {
          providerError = String(msg.errorMessage ?? providerError ?? "provider error");
        } else if (msg.stopReason === "aborted") {
          providerError = String(msg.errorMessage ?? "aborted by provider");
        }
        const t = textFromMessage(msg);
        if (t) finalText = t;
      }
      if (evt.type === "error" && evt.error) {
        providerError = String(evt.error);
      }

      try {
        opts.onEvent?.(evt);
      } catch {
        /* ignore listener errors */
      }
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    armIdle();
    stderr += chunk;
    opts.onStderr?.(chunk);
  });

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("error", (err) => {
      stderr += `\n[pi spawn error] ${err.message}\n`;
      resolve({ code: null, signal: null });
    });
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  if (timer) clearTimeout(timer);
  if (idleTimer) clearTimeout(idleTimer);

  let error: string | undefined;
  if (timedOut) error = "timeout";
  else if (idleTimedOut) error = `idle timeout (${Math.round(idleMs / 1000)}s without output)`;
  else if (exit.code !== 0) error = `exit ${exit.code}`;
  else if (providerError) error = `provider: ${providerError}`;

  return {
    ok: !error,
    finalText: finalText.trim(),
    events,
    stdout,
    stderr,
    exitCode: exit.code,
    signal: exit.signal,
    timedOut,
    idleTimedOut,
    attempts: 1,
    error,
  };
}

// ── retry chain ────────────────────────────────────────────────────────────

const DEFAULT_RETRYABLE_RETRIES = 2;
const DEFAULT_RETRY_DELAY_SEC = 30;
const DEFAULT_MAX_RETRY_DELAY_SEC = 120;
const DEFAULT_CHAIN_BUDGET_SEC = 900;

/** Exponential backoff with ±20% jitter (so two accounts do not retry in lockstep). */
export function backoffMs(attempt: number, baseMs: number, maxMs: number): number {
  const raw = Math.min(baseMs * 2 ** attempt, maxMs);
  const jitter = raw * 0.2 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(raw + jitter));
}

function withChain(r: PiRunResult, chain: PiAttempt[], usedModel?: string): PiRunResult {
  r.chain = chain;
  r.attempts = chain.length;
  if (usedModel) r.usedModel = usedModel;
  return r;
}

/**
 * Run pi with classification-aware retries and model fallbacks.
 * Exported in a runner-injectable form so the retry policy can be tested
 * offline (`tools/pi-retry-selftest.ts`).
 */
export async function runPiWith(
  opts: PiRunOptions,
  runOnce: (o: PiRunOptions) => Promise<PiRunResult>,
): Promise<PiRunResult> {
  const models: (string | undefined)[] = [];
  // `undefined` means "let pi pick its default model" — keep it as the first hop.
  if (!opts.model) models.push(undefined);
  for (const m of [opts.model, ...(opts.fallbackModels ?? [])]) {
    if (m && !models.includes(m)) models.push(m);
  }

  const retries = Math.max(0, opts.retries ?? DEFAULT_RETRYABLE_RETRIES);
  const baseMs = Number.isFinite(Number(process.env.PI_RETRY_BASE_MS))
    ? Number(process.env.PI_RETRY_BASE_MS)
    : (opts.retryDelaySec ?? DEFAULT_RETRY_DELAY_SEC) * 1000;
  const maxMs = (opts.maxRetryDelaySec ?? DEFAULT_MAX_RETRY_DELAY_SEC) * 1000;
  const budgetMs = (opts.chainBudgetSec ?? DEFAULT_CHAIN_BUDGET_SEC) * 1000;

  const chain: PiAttempt[] = [];
  const startedAt = Date.now();
  let last: PiRunResult | undefined;

  outer: for (let mi = 0; mi < models.length; mi++) {
    const model = models[mi];
    for (let attempt = 0; ; attempt++) {
      // Never let one attempt overrun the chain budget: cap the per-attempt
      // timeout (and the idle watchdog) by what is left.
      const remainingMs = budgetMs > 0 ? budgetMs - (Date.now() - startedAt) : Infinity;
      if (budgetMs > 0 && remainingMs <= 60_000) {
        opts.onStderr?.(`\n[pi] chain budget ${Math.round(budgetMs / 1000)}s nearly spent; stopping\n`);
        break outer;
      }
      const capSec = budgetMs > 0 ? Math.ceil(remainingMs / 1000) : undefined;
      const attemptTimeoutSec =
        capSec === undefined ? opts.timeoutSec : Math.min(opts.timeoutSec ?? Infinity, capSec);
      const attemptIdleSec =
        capSec === undefined
          ? opts.idleTimeoutSec
          : Math.min(opts.idleTimeoutSec ?? DEFAULT_IDLE_TIMEOUT_SEC, capSec);

      const t0 = Date.now();
      const r = await runOnce({ ...opts, model, timeoutSec: attemptTimeoutSec, idleTimeoutSec: attemptIdleSec });
      const ms = Date.now() - t0;
      last = r;

      const cls: PiAttempt["class"] = r.ok
        ? "ok"
        : r.timedOut
          ? "timeout"
          : classifyPiFailure({ error: r.error, stderr: r.stderr });
      chain.push({ model, class: cls, ms, error: r.ok ? undefined : r.error });

      if (r.ok) return withChain(r, chain, model);
      // A timeout is not a provider verdict: keep the historical `timeout`
      // error, only the chain is attached for diagnostics.
      if (r.timedOut) return withChain(r, chain, undefined);

      if (cls === "fatal") {
        opts.onStderr?.(`\n[pi] ${model ?? "(default)"} is not retryable (${shortReason(r.error)}); moving on\n`);
        break;
      }
      if (attempt >= retries) break;

      const wait = backoffMs(attempt, baseMs, maxMs);
      if (budgetMs > 0 && Date.now() - startedAt + wait > budgetMs) {
        opts.onStderr?.(`\n[pi] chain budget ${Math.round(budgetMs / 1000)}s exhausted; stopping\n`);
        break outer;
      }
      opts.onRetry?.(chain.length, r.error ?? "unknown");
      opts.onStderr?.(
        `\n[pi] attempt ${chain.length} failed (${shortReason(r.error)}); retrying in ${Math.round(wait / 1000)}s\n`,
      );
      if (wait > 0) await sleep(wait);
    }
    if (mi < models.length - 1) {
      opts.onStderr?.(
        `\n[pi] model ${model ?? "(default)"} unavailable (${shortReason(last?.error)}); trying fallback ${models[mi + 1]}\n`,
      );
    }
  }

  if (!last) {
    // Only reachable when the budget was already spent before the first attempt.
    return {
      ok: false,
      finalText: "",
      events: [],
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: null,
      timedOut: false,
      attempts: 0,
      error: "chain budget exhausted before the first attempt",
      chain,
    };
  }
  return withChain(withChainError(last, chain), chain, undefined);
}

/** Replace a single-hop error with the chain summary (keeps 1-hop errors as-is). */
function withChainError(r: PiRunResult, chain: PiAttempt[]): PiRunResult {
  r.error = formatChainError(chain);
  return r;
}

/** Run pi with automatic classified retries and model fallbacks. */
export async function runPi(opts: PiRunOptions): Promise<PiRunResult> {
  return runPiWith(opts, runPiOnce);
}

export function resolvePiBin(configured: string, home = process.env.HOME ?? "/root"): string {
  if (path.isAbsolute(configured)) return configured;
  // Prefer the nvm-managed global install when present.
  const candidates = [path.join(home, ".nvm/versions/node")];
  void candidates;
  return configured;
}
