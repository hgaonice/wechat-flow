/**
 * C5 cloudflared quick-tunnel supervisor (design §4).
 *
 * Owns exactly one `cloudflared tunnel --url <loopback> --no-autoupdate`
 * child, parses the public `*.trycloudflare.com` URL out of its stderr, and
 * persists every address to the `tunnels` ledger via `openTunnel` (I24: one
 * `up` row). Responsibilities:
 *
 *   - **adoption**  — first URL / address change → new `up` row + audit;
 *   - **health**    — poll local `/health` + remote `HEAD <url>`; failures
 *                     flip the row to `down`, recovery back to `up` (I28);
 *   - **fail-surfacing** — unexpected exit → `down`/`error` + exit code,
 *                     signal and a trailing stderr snippet; then backoff
 *                     restart (`min(pollMs·2ⁿ, 60s)`, n ≤ 5);
 *   - **notify**    — debounce address churn, then one mail per new row via
 *                     `notifyTunnelChange` (I26), retrying with backoff under
 *                     the attempt cap.
 *
 * Stderr is split on `\n` only (agent/frames.ts), never `readline`.
 * `probe` / `autoRestart` / `send` are test seams; production uses the
 * defaults.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { Database } from "bun:sqlite";
import { APP_DIR } from "../../config.ts";
import { createFrameDecoder } from "../agent/frames.ts";
import { recordAudit } from "../db/dao/audit.ts";
import * as tunnels from "../db/dao/tunnels.ts";
import type { TunnelKind, TunnelRow } from "../db/dao/tunnels.ts";
import { notifyTunnelChange, type NotifyResult, type SendFn } from "../notify/tunnel-mail.ts";

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const STDERR_TAIL_BYTES = 2048;
const MAX_BACKOFF_MS = 60_000;
const MAX_BACKOFF_SHIFT = 5;

export interface TunnelStatusView {
  running: boolean;
  pid: number | null;
  url: string | null;
  since: string | null;
  detail: string | null;
  attempts: number;
  notifiedAt: string | null;
}

export interface TunnelDeps {
  db: Database;
  masterKey: Buffer;
  bin?: string;
  mode?: TunnelKind;
  targetUrl?: string;
  /** Console listening port the tunnel is allowed to expose (default `CONSOLE_PORT` ?? 8787). Test seam (I27). */
  consolePort?: number;
  pollMs?: number;
  debounceMs?: number;
  gracefulMs?: number;
  maxNotifyAttempts?: number;
  adminCopy?: boolean;
  send?: SendFn;
  /** Test seam: override the health check (default: local `/health` + remote HEAD). */
  probe?: (url: string) => Promise<boolean>;
  /** Test seam: disable automatic restart after an unexpected exit. */
  autoRestart?: boolean;
  log?: (msg: string) => void;
}

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) ? raw : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw !== "0" && raw.toLowerCase() !== "false";
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

async function fetchOk(url: string, method: "GET" | "HEAD", timeoutMs: number): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, signal: ac.signal, redirect: "manual" });
    if (method === "HEAD") return res.status >= 200 && res.status < 400;
    return res.status === 200;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export class TunnelSupervisor {
  private readonly db: Database;
  private readonly masterKey: Buffer;
  private readonly bin: string;
  private readonly mode: TunnelKind;
  private readonly targetUrl: string;
  private readonly consolePort: number;
  private readonly pollMs: number;
  private readonly debounceMs: number;
  private readonly gracefulMs: number;
  private readonly maxNotifyAttempts: number;
  private readonly adminCopy: boolean;
  private readonly send: SendFn | undefined;
  private readonly probe: ((url: string) => Promise<boolean>) | undefined;
  private readonly autoRestart: boolean;
  private readonly log: (msg: string) => void;

  private child: ChildProcess | null = null;
  private decoder = createFrameDecoder();
  private stderrTail = "";
  private stopped = true;
  private byStop = false;
  private url: string | null = null;
  private since: string | null = null;
  private detail: string | null = null;
  private currentId: number | null = null;
  private pid: number | null = null;
  private restartAttempt = 0;
  private restarting = false;
  private autoRestartSuspended = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingNotifyId: number | null = null;
  private healthFails = 0;

  constructor(deps: TunnelDeps) {
    this.db = deps.db;
    this.masterKey = deps.masterKey;
    this.bin = deps.bin ?? process.env.CONSOLE_TUNNEL_BIN ?? "cloudflared";
    this.mode = deps.mode ?? (process.env.CONSOLE_TUNNEL_MODE === "named" ? "named" : "quick");
    const derived = `http://127.0.0.1:${process.env.CONSOLE_PORT ?? 8787}`;
    this.targetUrl = deps.targetUrl ?? process.env.CONSOLE_TUNNEL_URL ?? derived;
    this.consolePort = Math.trunc(deps.consolePort ?? envInt("CONSOLE_PORT", 8787));
    this.pollMs = Math.max(1000, deps.pollMs ?? envInt("CONSOLE_TUNNEL_POLL_MS", 5000));
    this.debounceMs = Math.max(0, deps.debounceMs ?? envInt("CONSOLE_TUNNEL_DEBOUNCE_MS", 30_000));
    this.gracefulMs = Math.max(0, deps.gracefulMs ?? envInt("CONSOLE_TUNNEL_GRACEFUL_MS", 3000));
    this.maxNotifyAttempts = Math.max(
      1,
      deps.maxNotifyAttempts ?? envInt("CONSOLE_TUNNEL_MAIL_MAX_ATTEMPTS", 3),
    );
    this.adminCopy = deps.adminCopy ?? envBool("CONSOLE_TUNNEL_MAIL_ADMIN", true);
    this.send = deps.send;
    this.probe = deps.probe;
    this.autoRestart = deps.autoRestart ?? true;
    this.log = deps.log ?? ((msg: string): void => console.log(msg));

    // I27: the tunnel may only expose the loopback console, never a CDP port.
    let parsed: URL;
    try {
      parsed = new URL(this.targetUrl);
    } catch {
      throw new Error(`CONSOLE_TUNNEL_URL 非法: ${this.targetUrl}`);
    }
    if (!isLoopback(parsed.hostname)) {
      throw new Error(`CONSOLE_TUNNEL_URL 必须指向回环地址（I27），得到 ${parsed.hostname}`);
    }
    // I27: 除回环主机外，端口必须等于控制台端口，且绝不得为任何账号的 CDP 端口
    // （否则误把 Chrome CDP 暴露到公网 → 远程接管 Chrome，H8/T1）。fail-fast，不静默降级。
    const targetPort = parsed.port
      ? Number(parsed.port)
      : parsed.protocol === "https:"
        ? 443
        : 80;
    if (!Number.isInteger(targetPort) || targetPort !== this.consolePort) {
      throw new Error(
        `CONSOLE_TUNNEL_URL 端口必须等于控制台端口 ${this.consolePort}（I27），得到 ${parsed.port || "(默认)"}`,
      );
    }
    const cdpPorts = this.db
      .query("SELECT DISTINCT cdp_port AS p FROM accounts WHERE cdp_port IS NOT NULL")
      .all() as Array<{ p: number | null }>;
    if (cdpPorts.some((r) => r.p === targetPort)) {
      throw new Error(`CONSOLE_TUNNEL_URL 端口 ${targetPort} 是账号 CDP 端口，禁止入隧道（I27/H8）`);
    }
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.byStop = false;
    this.autoRestartSuspended = false;
    this.spawnChild();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.byStop = true;
    this.clearTimers();
    const child = this.child;
    if (child) {
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = (): void => {
          if (done) return;
          done = true;
          resolve();
        };
        child.once("close", finish);
        try {
          child.kill("SIGTERM");
        } catch {
          finish();
        }
        const timer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already gone */
          }
          finish();
        }, this.gracefulMs);
        timer.unref?.();
      });
    }
    if (this.currentId !== null) {
      tunnels.setTunnelStatus(this.db, this.currentId, "down", "stopped");
    }
    this.child = null;
    this.pid = null;
    this.url = null;
    this.currentId = null;
    this.detail = "stopped";
  }

  async restart(): Promise<TunnelStatusView> {
    this.log("[tunnel] manual restart");
    this.autoRestartSuspended = true;
    this.byStop = true;
    this.stopped = true;
    await this.stop();
    this.byStop = false;
    this.stopped = false;
    this.autoRestartSuspended = false;
    this.restartAttempt = 0;
    this.spawnChild();
    return this.status();
  }

  status(): TunnelStatusView {
    const id = this.currentId ?? tunnels.getCurrentTunnel(this.db)?.id ?? null;
    const row = id !== null ? tunnels.getTunnel(this.db, id) : null;
    return {
      running: this.child !== null && !this.stopped,
      pid: this.pid,
      url: this.url ?? row?.url ?? null,
      since: this.since,
      detail: this.detail,
      attempts: row?.notify_attempts ?? 0,
      notifiedAt: row?.notified_at ?? null,
    };
  }

  /** Admin "re-send now": clears the dedupe key, then notifies. */
  async notifyNow(id: number): Promise<NotifyResult> {
    const row = tunnels.getTunnel(this.db, id);
    if (!row) return { sent: false, skipped: "not-found", attempts: 0 };
    tunnels.clearNotified(this.db, id);
    const fresh = tunnels.getTunnel(this.db, id)!;
    return notifyTunnelChange(this.db, this.masterKey, fresh, {
      send: this.send,
      maxAttempts: this.maxNotifyAttempts,
      adminCopy: this.adminCopy,
      log: this.log,
    });
  }

  // ── process lifecycle ────────────────────────────────────────────────────
  private spawnChild(): void {
    if (this.stopped) return;
    const args = ["tunnel", "--url", this.targetUrl, "--no-autoupdate"];
    this.decoder = createFrameDecoder();
    this.stderrTail = "";
    this.log(`[tunnel] spawn: ${this.bin} ${args.join(" ")}`);
    let child: ChildProcess;
    try {
      child = spawn(this.bin, args, {
        cwd: APP_DIR,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      this.handleUnexpectedExit(null, null, `spawn failed: ${(err as Error).message}`);
      return;
    }
    this.child = child;
    this.pid = child.pid ?? null;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.consume(chunk));
    child.stderr?.on("data", (chunk: string) => this.consume(chunk));
    child.on("error", (err) => this.log(`[tunnel] process error: ${err.message}`));
    child.on("close", (code, signal) => {
      if (this.child === child) this.child = null;
      this.pid = null;
      if (this.byStop || this.stopped) {
        this.log(`[tunnel] exited (code=${code} signal=${signal})`);
        return;
      }
      this.handleUnexpectedExit(code, signal, this.stderrTail);
    });
  }

  private consume(chunk: string): void {
    for (const line of this.decoder.push(chunk)) this.onLine(line);
  }

  private onLine(line: string): void {
    this.stderrTail = `${this.stderrTail}${line}\n`.slice(-STDERR_TAIL_BYTES);
    const match = line.match(URL_RE);
    if (!match) return;
    const url = match[0];
    if (url === this.url) return;
    this.adoptUrl(url);
  }

  private adoptUrl(url: string): void {
    this.url = url;
    this.since = new Date().toISOString();
    this.detail = null;
    this.healthFails = 0;
    this.restartAttempt = 0;
    const row = this.persistUrl(url);
    this.currentId = row.id;
    this.startPolling();
    this.scheduleNotify(row);
  }

  private persistUrl(url: string): TunnelRow {
    const current = tunnels.getCurrentTunnel(this.db);
    if (current && current.url === url) {
      tunnels.markHeard(this.db, current.id, { pid: this.pid, url });
      return tunnels.getTunnel(this.db, current.id)!;
    }
    let hostname = "";
    try {
      hostname = new URL(url).hostname;
    } catch {
      /* leave empty */
    }
    const row = tunnels.openTunnel(this.db, { kind: this.mode, url, hostname, pid: this.pid });
    recordAudit(this.db, {
      actor: "system",
      action: "tunnel.change",
      target: `tunnel:${row.id}`,
      detail: { url, previousId: current?.id ?? null },
      ok: true,
    });
    this.log(`[tunnel] up: ${url} (id=${row.id})`);
    return row;
  }

  // ── health ───────────────────────────────────────────────────────────────
  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.healthTick(), this.pollMs);
    this.pollTimer.unref?.();
  }

  private async defaultProbe(url: string): Promise<boolean> {
    let local: string;
    try {
      local = new URL("/health", this.targetUrl).toString();
    } catch {
      return false;
    }
    if (!(await fetchOk(local, "GET", 4000))) return false;
    return fetchOk(url, "HEAD", 6000);
  }

  private async healthTick(): Promise<void> {
    if (!this.url || !this.child || this.stopped || this.currentId === null) return;
    const ok = this.probe ? await this.probe(this.url) : await this.defaultProbe(this.url);
    if (this.currentId === null) return;
    if (ok) {
      this.healthFails = 0;
      const row = tunnels.getTunnel(this.db, this.currentId);
      if (row && row.status !== "up") {
        tunnels.setTunnelStatus(this.db, this.currentId, "up", null);
      } else {
        tunnels.markHeard(this.db, this.currentId, {});
      }
      return;
    }
    this.healthFails += 1;
    const detail = `health check failed x${this.healthFails}`;
    this.detail = detail;
    tunnels.setTunnelStatus(this.db, this.currentId, "down", detail);
  }

  // ── crash surfacing (I28) ────────────────────────────────────────────────
  private handleUnexpectedExit(
    code: number | null,
    signal: NodeJS.Signals | null,
    stderrTail: string,
  ): void {
    const tail = (stderrTail ?? "").slice(-STDERR_TAIL_BYTES);
    const detail = `exit=${code ?? "null"} signal=${signal ?? "null"} stderr=${tail}`;
    this.detail = detail;
    if (this.currentId !== null) {
      tunnels.setTunnelStatus(this.db, this.currentId, code === 0 ? "down" : "error", detail);
    }
    recordAudit(this.db, {
      actor: "system",
      action: "tunnel.exit",
      target: this.currentId !== null ? `tunnel:${this.currentId}` : "tunnel",
      detail: { code, signal, stderr: tail.slice(-500) },
      ok: false,
    });
    this.log(`[tunnel] unexpected exit code=${code} signal=${signal}`);
    this.url = null;
    this.currentId = null;
    if (this.autoRestart && !this.autoRestartSuspended) this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.stopped || this.byStop || this.restarting) return;
    this.restarting = true;
    const shift = Math.min(this.restartAttempt, MAX_BACKOFF_SHIFT);
    const delay = Math.min(this.pollMs * 2 ** shift, MAX_BACKOFF_MS);
    this.restartAttempt += 1;
    this.log(`[tunnel] restart in ${delay}ms (attempt ${this.restartAttempt})`);
    const timer = setTimeout(() => {
      this.restarting = false;
      if (this.stopped || this.byStop) return;
      this.spawnChild();
    }, delay);
    timer.unref?.();
  }

  // ── notify ───────────────────────────────────────────────────────────────
  private scheduleNotify(row: TunnelRow): void {
    this.pendingNotifyId = row.id;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.flushNotify(), this.debounceMs);
    this.debounceTimer.unref?.();
  }

  private async flushNotify(): Promise<void> {
    const id = this.pendingNotifyId;
    this.pendingNotifyId = null;
    if (id === null) return;
    const row = tunnels.getTunnel(this.db, id);
    if (!row || !row.url) return;
    const res = await notifyTunnelChange(this.db, this.masterKey, row, {
      send: this.send,
      maxAttempts: this.maxNotifyAttempts,
      adminCopy: this.adminCopy,
      log: this.log,
    });
    if (!res.sent && !res.skipped && res.error && res.attempts < this.maxNotifyAttempts) {
      const delay = Math.min(this.pollMs * 2 ** Math.min(res.attempts, MAX_BACKOFF_SHIFT), MAX_BACKOFF_MS);
      this.pendingNotifyId = id;
      this.retryTimer = setTimeout(() => void this.flushNotify(), delay);
      this.retryTimer.unref?.();
    }
  }

  private clearTimers(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.pendingNotifyId = null;
  }
}
