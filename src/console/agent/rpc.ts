/**
 * Long-lived `pi --mode rpc` client (C4, I4-2 / design.md D2, D3).
 *
 * This is deliberately separate from `src/pi.ts` (one-shot `--print --mode json`)
 * and never modifies it. Responsibilities:
 *   - frame stdout strictly through `createFrameDecoder` (see frames.ts);
 *   - correlate command *responses* by `id` (never by arrival order);
 *   - keep the process's stderr in a bounded diagnostic ring (never parsed);
 *   - distinguish an expected close (we asked) from an unexpected exit.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createFrameDecoder } from "./frames.ts";

export type RpcRecord = { type?: string; id?: string; [key: string]: unknown };

export interface RpcExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** True when `close()` was called first (a clean shutdown, not a crash). */
  expected: boolean;
}

export interface SpawnRpcOptions {
  bin: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  /** Session events and extension-UI requests (never `response` records). */
  onRecord?: (record: RpcRecord) => void;
  /** Complete stderr lines (diagnostics only). */
  onStderr?: (line: string) => void;
  onExit?: (info: RpcExitInfo) => void;
  /** Per-command response timeout. Default 15s (design.md D3). */
  defaultTimeoutMs?: number;
  /** stderr diagnostic ring size. Default 200 lines. */
  stderrRing?: number;
}

export interface SendOptions {
  timeoutMs?: number;
}

export interface RpcHandle {
  readonly pid: number | undefined;
  readonly alive: boolean;
  /** Send a command and await its matching response record (correlated by id). */
  send(command: RpcRecord, opts?: SendOptions): Promise<RpcRecord>;
  /** Write a record with no awaited response (`extension_ui_response`, etc.). */
  sendRaw(record: RpcRecord): void;
  stderrTail(): string[];
  /** Ordered shutdown: close stdin, wait `gracefulMs`, then SIGKILL. */
  close(gracefulMs?: number): Promise<void>;
  kill(signal?: NodeJS.Signals): void;
}

interface Pending {
  resolve: (record: RpcRecord) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  type: string;
}

export function spawnRpc(options: SpawnRpcOptions): RpcHandle {
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 15_000;
  const ringSize = options.stderrRing ?? 200;
  const child: ChildProcessWithoutNullStreams = spawn(options.bin, options.args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env } as NodeJS.ProcessEnv,
  });

  const decoder = createFrameDecoder();
  const pending = new Map<string, Pending>();
  const stderrRing: string[] = [];
  let seq = 0;
  let exited = false;
  let expectedExit = false;
  let resolveExit!: () => void;
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  let writeChain: Promise<void> = Promise.resolve();
  function writeLine(line: string): Promise<void> {
    writeChain = writeChain
      .then(
        () =>
          new Promise<void>((resolve) => {
            if (exited || !child.stdin.writable) {
              resolve();
              return;
            }
            const ok = child.stdin.write(line + "\n");
            if (ok) resolve();
            else child.stdin.once("drain", () => resolve());
          }),
      )
      .catch(() => {
        /* write errors surface via pending rejection / exit handler */
      });
    return writeChain;
  }

  function emitRecord(record: RpcRecord): void {
    try {
      options.onRecord?.(record);
    } catch {
      /* listener errors are not protocol errors */
    }
  }

  function handleLine(line: string): void {
    let record: RpcRecord;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      record = parsed as RpcRecord;
    } catch {
      emitRecord({ type: "_parse_error", raw: line });
      return;
    }

    if (record.type === "response" && typeof record.id === "string") {
      const slot = pending.get(record.id);
      if (slot) {
        pending.delete(record.id);
        clearTimeout(slot.timer);
        if (record.success === false) {
          const detail = record.error ?? record.data;
          slot.reject(new Error(`rpc ${slot.type} failed: ${stringifyError(detail)}`));
        } else {
          slot.resolve(record);
        }
        return;
      }
    }
    emitRecord(record);
  }

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    for (const line of decoder.push(chunk)) handleLine(line);
  });
  child.stdout.on("end", () => {
    for (const line of decoder.flush()) handleLine(line);
  });

  child.stderr.setEncoding("utf8");
  let stderrPartial = "";
  child.stderr.on("data", (chunk: string) => {
    stderrPartial += chunk;
    let nl: number;
    while ((nl = stderrPartial.indexOf("\n")) !== -1) {
      const line = stderrPartial.slice(0, nl).replace(/\r$/, "");
      stderrPartial = stderrPartial.slice(nl + 1);
      if (line.length === 0) continue;
      pushStderr(line);
    }
  });
  child.stderr.on("end", () => {
    if (stderrPartial.trim()) pushStderr(stderrPartial.trim());
    stderrPartial = "";
  });

  function pushStderr(line: string): void {
    stderrRing.push(line);
    if (stderrRing.length > ringSize) stderrRing.splice(0, stderrRing.length - ringSize);
    try {
      options.onStderr?.(line);
    } catch {
      /* ignore */
    }
  }

  function failPending(reason: string): void {
    for (const [id, slot] of pending) {
      clearTimeout(slot.timer);
      pending.delete(id);
      slot.reject(new Error(reason));
    }
  }

  function finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (exited) return;
    exited = true;
    failPending("rpc process exited");
    resolveExit();
    try {
      options.onExit?.({ code, signal, expected: expectedExit });
    } catch {
      /* ignore */
    }
  }

  child.on("exit", (code, signal) => finish(code, signal));
  child.on("error", (err) => {
    pushStderr(`[rpc spawn error] ${err.message}`);
    finish(null, null);
  });

  function send(command: RpcRecord, opts?: SendOptions): Promise<RpcRecord> {
    if (exited) return Promise.reject(new Error("rpc process is not running"));
    const id = typeof command.id === "string" && command.id.length > 0 ? command.id : `c${++seq}`;
    const payload: RpcRecord = { ...command, id };
    const type = typeof payload.type === "string" ? payload.type : "unknown";
    return new Promise<RpcRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`rpc ${type} timed out after ${opts?.timeoutMs ?? defaultTimeoutMs}ms`));
      }, opts?.timeoutMs ?? defaultTimeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer, type });
      void writeLine(JSON.stringify(payload)).catch((err: unknown) => {
        const slot = pending.get(id);
        if (slot) {
          pending.delete(id);
          clearTimeout(slot.timer);
          slot.reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  function sendRaw(record: RpcRecord): void {
    if (exited) return;
    void writeLine(JSON.stringify(record));
  }

  async function close(gracefulMs = 3000): Promise<void> {
    if (exited) return;
    expectedExit = true;
    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }
    const timer = setTimeout(() => {
      if (!exited) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }, gracefulMs);
    timer.unref?.();
    await exitPromise;
    clearTimeout(timer);
  }

  function kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (exited) return;
    try {
      child.kill(signal);
    } catch {
      /* ignore */
    }
  }

  return {
    get pid() {
      return child.pid;
    },
    get alive() {
      return !exited;
    },
    send,
    sendRaw,
    stderrTail: () => [...stderrRing],
    close,
    kill,
  };
}

function stringifyError(value: unknown): string {
  if (value === undefined || value === null) return "unknown error";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
