import { spawn } from "node:child_process";
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
 * failure. Transient provider errors (e.g. HTTP 503 "all nodes exhausted") are
 * retried with a backoff.
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
  /** Retries per model after a provider/transport failure. Default 1 (2 attempts). */
  retries?: number;
  /** Delay between retries, in seconds. Default 30. */
  retryDelaySec?: number;
  /** Models to try, in order, when the primary model fails. */
  fallbackModels?: string[];
  onRetry?: (attempt: number, error: string) => void;
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
  attempts: number;
  error?: string;
}

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

  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
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

  let error: string | undefined;
  if (timedOut) error = "timeout";
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
    attempts: 1,
    error,
  };
}

/** Run pi with automatic retries and model fallbacks. */
export async function runPi(opts: PiRunOptions): Promise<PiRunResult> {
  const models: (string | undefined)[] = [opts.model, ...(opts.fallbackModels ?? [])];
  const retries = opts.retries ?? 1;
  const delay = (opts.retryDelaySec ?? 30) * 1000;
  let last: PiRunResult | undefined;
  let totalAttempts = 0;

  for (let mi = 0; mi < models.length; mi++) {
    const model = models[mi];
    for (let attempt = 0; attempt <= retries; attempt++) {
      last = await runPiOnce({ ...opts, model });
      totalAttempts += 1;
      last.attempts = totalAttempts;
      if (last.ok || last.timedOut) return last;
      if (attempt < retries) {
        opts.onRetry?.(totalAttempts, last.error ?? "unknown");
        opts.onStderr?.(`\n[pi] attempt ${totalAttempts} failed (${last.error}); retrying in ${delay / 1000}s\n`);
        await sleep(delay);
      }
    }
    if (mi < models.length - 1) {
      opts.onStderr?.(`\n[pi] model ${model ?? "(default)"} unavailable (${last?.error}); trying fallback ${models[mi + 1]}\n`);
    }
  }
  if (last) last.attempts = totalAttempts;
  return last!;
}

export function resolvePiBin(configured: string, home = process.env.HOME ?? "/root"): string {
  if (path.isAbsolute(configured)) return configured;
  // Prefer the nvm-managed global install when present.
  const candidates = [path.join(home, ".nvm/versions/node")];
  void candidates;
  return configured;
}
