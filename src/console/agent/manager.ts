/**
 * Chat session manager (C4, I4-5 / design.md D1, D3, D4, D6, D8, D9, D13).
 *
 * Owns the 1:1 mapping between a `chat_sessions` row and a long-lived
 * `pi --mode rpc` subprocess:
 *   - lazy spawn on first prompt/stream;
 *   - global concurrency cap (`CONSOLE_CHAT_MAX`) and idle TTL
 *     (`CONSOLE_CHAT_TTL_MS`) with an ordered shutdown (stdin end → SIGKILL);
 *   - strict event/command correlation (rpc.ts) and human-in-the-loop decision
 *     cards bridged to `extension_ui_request` / `extension_ui_response`;
 *   - unexpected exit ⇒ the session and its pending decisions go `lost` in ONE
 *     transaction (I21/I23) and subscribers receive `chat.lost`.
 *
 * Pure-additive: the engine (`src/pi.ts`, `src/wechat.ts`, `runPublish`) is
 * untouched; this is a second, independent pi integration for the console.
 */
import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { APP_DIR, resolveConfig, type AppConfig } from "../../config.ts";
import { buildRawConfig } from "../config/resolve.ts";
import { getAccountById, type AccountRow } from "../db/dao/accounts.ts";
import { recordAudit } from "../db/dao/audit.ts";
import * as chats from "../db/dao/chats.ts";
import { HttpError } from "../http/respond.ts";
import { ChatBus, type ChatEvent } from "./events.ts";
import { spawnRpc, type RpcExitInfo, type RpcHandle, type RpcRecord } from "./rpc.ts";

export interface ChatActor {
  userId?: number | null;
  username?: string | null;
  ip?: string | null;
  ua?: string | null;
}

export interface ChatManagerDeps {
  db: Database;
  bus?: ChatBus;
  /** Repo root used as pi cwd. Defaults to APP_DIR. */
  repoRoot?: string;
  /** Overrides `CONSOLE_PI_BIN` / config `piBin`. */
  piBinOverride?: string;
  maxSessions?: number;
  ttlMs?: number;
  defaultTimeoutMs?: number;
  idleSweepMs?: number;
  log?: (message: string) => void;
}

export interface SessionView {
  id: number;
  accountId: number;
  title: string | null;
  status: string;
  live: boolean;
  busy: boolean;
  piSessionId: string | null;
  sessionFile: string | null;
  jobId: number | null;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
  pendingDecisions: number;
}

export interface MessageView {
  id: number;
  chatSessionId: number;
  role: string;
  content: string;
  meta: unknown;
  createdAt: string;
}

export interface DecisionView {
  id: number;
  chatSessionId: number;
  requestId: string;
  method: string;
  title: string | null;
  message: string | null;
  options: unknown[];
  timeoutMs: number | null;
  status: string;
  response: unknown;
  createdAt: string;
  answeredAt: string | null;
}

export interface ChatDetail {
  session: SessionView;
  messages: MessageView[];
  decisions: DecisionView[];
  live: boolean;
  busy: boolean;
}

interface LiveSession {
  chatId: number;
  accountId: number;
  handle: RpcHandle;
  busy: boolean;
  lastActivity: number;
  spawning: Promise<void> | null;
  stderr: string[];
  /** Status to persist when the process exits on purpose (idle vs closed). */
  expectStatus: chats.ChatStatus;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function parseJson(v: string | null): unknown {
  if (!v) return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("");
}

function messageView(row: chats.ChatMessageRow): MessageView {
  return {
    id: row.id,
    chatSessionId: row.chat_session_id,
    role: row.role,
    content: row.content,
    meta: parseJson(row.meta_json),
    createdAt: row.created_at,
  };
}

function decisionView(row: chats.DecisionRow): DecisionView {
  const options = parseJson(row.options_json);
  return {
    id: row.id,
    chatSessionId: row.chat_session_id,
    requestId: row.request_id,
    method: row.method,
    title: row.title,
    message: row.message,
    options: Array.isArray(options) ? options : [],
    timeoutMs: row.timeout_ms,
    status: row.status,
    response: parseJson(row.response_json),
    createdAt: row.created_at,
    answeredAt: row.answered_at,
  };
}

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

export class ChatManager {
  readonly bus: ChatBus;
  private readonly db: Database;
  private readonly repoRoot: string;
  private readonly piBinOverride?: string;
  private readonly maxSessions: number;
  private readonly ttlMs: number;
  private readonly defaultTimeoutMs: number;
  private readonly log: (message: string) => void;
  private readonly live = new Map<number, LiveSession>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly sweep: ReturnType<typeof setInterval>;

  constructor(deps: ChatManagerDeps) {
    this.db = deps.db;
    this.bus = deps.bus ?? new ChatBus();
    this.repoRoot = deps.repoRoot ?? APP_DIR;
    this.piBinOverride = deps.piBinOverride;
    this.maxSessions = Math.max(1, deps.maxSessions ?? envInt("CONSOLE_CHAT_MAX", 3));
    this.ttlMs = Math.max(0, deps.ttlMs ?? envInt("CONSOLE_CHAT_TTL_MS", 30 * 60_000));
    this.defaultTimeoutMs = deps.defaultTimeoutMs ?? 15_000;
    this.log = deps.log ?? ((message) => console.error(message));
    const sweepMs = deps.idleSweepMs ?? Math.min(60_000, Math.max(5_000, Math.floor(this.ttlMs / 4) || 60_000));
    this.sweep = setInterval(() => this.sweepIdle(), sweepMs);
    this.sweep.unref?.();
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /** Startup reaper: sessions with no live subprocess are stale (I21/I23). */
  reapStale(): number {
    const counts = chats.reapStaleChats(this.db, this.live.keys());
    if (counts.sessions > 0 || counts.decisions > 0) {
      this.log(`[chat] reaped ${counts.sessions} stale session(s), ${counts.decisions} pending decision(s)`);
    }
    return counts.sessions;
  }

  async shutdown(): Promise<void> {
    clearInterval(this.sweep);
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const live of [...this.live.values()]) {
      live.expectStatus = "closed";
      await live.handle.close(2_000).catch(() => {});
      this.bus.close(live.chatId);
    }
    this.live.clear();
  }

  hasLive(chatId: number): boolean {
    const live = this.live.get(chatId);
    return !!live && live.handle.alive;
  }

  private sweepIdle(): void {
    if (this.ttlMs <= 0) return;
    const now = Date.now();
    for (const live of [...this.live.values()]) {
      if (live.busy || live.spawning) continue;
      if (now - live.lastActivity < this.ttlMs) continue;
      live.expectStatus = "idle";
      this.log(`[chat ${live.chatId}] idle for ${Math.round((now - live.lastActivity) / 1000)}s, closing subprocess`);
      void live.handle.close(2_000).catch(() => {});
    }
  }

  // ── views ────────────────────────────────────────────────────────────────

  private sessionView(row: chats.ChatSessionRow): SessionView {
    const live = this.live.get(row.id);
    return {
      id: row.id,
      accountId: row.account_id,
      title: row.title,
      status: row.status,
      live: !!live && live.handle.alive,
      busy: live?.busy ?? false,
      piSessionId: row.pi_session_id,
      sessionFile: row.session_file,
      jobId: row.job_id,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      pendingDecisions: chats.countPendingDecisions(this.db, row.id),
    };
  }

  getSession(chatId: number): chats.ChatSessionRow | undefined {
    return chats.getChatSession(this.db, chatId);
  }

  requireSession(chatId: number): chats.ChatSessionRow {
    const row = chats.getChatSession(this.db, chatId);
    if (!row) throw new HttpError(404, "chat_not_found", "会话不存在");
    return row;
  }

  listSessions(accountId: number): SessionView[] {
    return chats.listChatSessions(this.db, accountId).map((row) => this.sessionView(row));
  }

  detail(chatId: number): ChatDetail {
    const row = this.requireSession(chatId);
    return {
      session: this.sessionView(row),
      messages: chats.listChatMessages(this.db, chatId).map(messageView),
      decisions: chats.listDecisions(this.db, { chatId, limit: 200 }).map(decisionView),
      live: this.hasLive(chatId),
      busy: this.live.get(chatId)?.busy ?? false,
    };
  }

  createSession(accountId: number, opts: { title?: string; jobId?: number; actor?: ChatActor } = {}): SessionView {
    const row = chats.createChatSession(this.db, {
      accountId,
      title: opts.title ?? null,
      jobId: opts.jobId ?? null,
      createdBy: opts.actor?.userId ?? null,
    });
    this.audit(opts.actor, "chat.create", `chat:${row.id}`, { accountId });
    return this.sessionView(row);
  }

  async deleteSession(chatId: number, actor?: ChatActor): Promise<void> {
    const row = chats.getChatSession(this.db, chatId);
    if (!row) throw new HttpError(404, "chat_not_found", "会话不存在");
    const live = this.live.get(chatId);
    if (live) {
      live.expectStatus = "closed";
      await live.handle.close(2_000).catch(() => {});
    }
    chats.deleteChatSession(this.db, chatId);
    this.bus.close(chatId);
    this.audit(actor, "chat.close", `chat:${chatId}`, { accountId: row.account_id });
  }

  listDecisions(opts: { chatId?: number; status?: chats.DecisionStatus; accountIds?: number[]; limit?: number } = {}): DecisionView[] {
    return chats.listDecisions(this.db, opts).map(decisionView);
  }

  getDecision(decisionId: number): chats.DecisionRow | undefined {
    return chats.getDecision(this.db, decisionId);
  }

  // ── spawn ────────────────────────────────────────────────────────────────

  private buildSpawnArgs(row: chats.ChatSessionRow): {
    bin: string;
    args: string[];
    cwd: string;
    contextFile: string;
  } {
    const account = getAccountById(this.db, row.account_id);
    let cfg: AppConfig | undefined;
    try {
      cfg = resolveConfig(buildRawConfig(this.db), account?.alias ?? "");
    } catch (err) {
      this.log(`[chat ${row.id}] resolveConfig failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const dataDir = cfg?.paths.data ?? path.join(this.repoRoot, "data", account?.alias ?? "default");
    const consoleDir = path.join(dataDir, "console");
    mkdirSync(consoleDir, { recursive: true });
    const contextFile = path.join(consoleDir, `agent-context-${row.account_id}.txt`);
    writeFileSync(contextFile, this.buildContextText(cfg, account, row), "utf8");

    const sessionDir = path.join(dataDir, "sessions", "console");
    mkdirSync(sessionDir, { recursive: true });

    const bin =
      process.env.CONSOLE_PI_BIN && process.env.CONSOLE_PI_BIN.length > 0
        ? process.env.CONSOLE_PI_BIN
        : (this.piBinOverride ?? cfg?.piBin ?? "pi");

    const args = [
      "--mode",
      "rpc",
      // Layer 1 of D7: declare ONLY read-only tools (+ the ask channel).
      "--tools",
      "read,grep,find,ls,console_ask",
      // Layer 2 of D7: fail-safe interception of anything else.
      "--extension",
      path.join(this.repoRoot, "src/console/agent/extensions/console-decision.ts"),
      "--append-system-prompt",
      contextFile,
      "--session-dir",
      sessionDir,
    ];

    // Resume the persisted session when we have a file (D9 / migration v2), so a
    // respawn after idle TTL keeps conversational continuity.
    if (row.session_file) args.push("--session", row.session_file);

    const model = cfg?.model.article.model;
    if (model) args.push("--model", model);
    const thinking = cfg?.model.article.thinking;
    if (thinking) args.push("--thinking", thinking);

    return { bin, args, cwd: this.repoRoot, contextFile };
  }

  private buildContextText(cfg: AppConfig | undefined, account: AccountRow | undefined, row: chats.ChatSessionRow): string {
    const lines = [
      "# 控制台会话上下文",
      "",
      "你正在 wechat-flow 公众号自动化引擎的「控制台会话窗口」中运行。",
      `- 账号 alias：${account?.alias ?? "(未知)"}`,
      `- 公众号名称：${cfg?.accountName ?? account?.display_name ?? "(未知)"}`,
      `- 控制台会话 ID：${row.id}`,
      `- 仓库根目录：${this.repoRoot}`,
      cfg ? `- 内容目录：${cfg.paths.content}` : "",
      cfg ? `- 计划目录：${cfg.paths.plans}` : "",
      cfg ? `- 素材目录：${cfg.paths.articles}` : "",
      "",
      "## 权限约束（重要）",
      "- 当前会话**只读**：仅可使用 read/grep/find/ls 等读取类工具。",
      "- 任何写文件、执行命令、发布、发邮件、备份类工具都被禁止，或在人工逐次确认后才可能放行。",
      "- 需要人工决策时，**必须**调用 `console_ask` 工具向操作者提问，不要自行假设答案。",
      "- 不要尝试读取或输出任何微信/邮箱/密钥凭据。",
      "",
      "## 目标",
      "帮助操作者查阅、梳理与规划该账号的内容；生成与发布仍由引擎的确定性流程负责。",
      "",
    ];
    return lines.filter((line) => line !== "").join("\n") + "\n";
  }

  /** Spawn (or reuse) the subprocess for a session. Lazily called by routes. */
  async ensureSpawn(row: chats.ChatSessionRow): Promise<LiveSession> {
    const existing = this.live.get(row.id);
    if (existing) {
      if (existing.spawning) {
        await existing.spawning;
        return this.live.get(row.id) ?? existing;
      }
      if (existing.handle.alive) return existing;
      this.live.delete(row.id);
    }
    if (this.live.size >= this.maxSessions) {
      throw new HttpError(
        409,
        "chat_limit",
        `同时运行的会话数已达上限（${this.maxSessions}）。请先关闭其他会话再继续。`,
      );
    }

    const { bin, args, cwd } = this.buildSpawnArgs(row);
    const live: LiveSession = {
      chatId: row.id,
      accountId: row.account_id,
      handle: undefined as unknown as RpcHandle,
      busy: false,
      lastActivity: Date.now(),
      spawning: null,
      stderr: [],
      expectStatus: "closed",
    };
    const handle = spawnRpc({
      bin,
      args,
      cwd,
      defaultTimeoutMs: this.defaultTimeoutMs,
      onRecord: (record) => this.handleRecord(live, record),
      onStderr: (line) => {
        live.stderr.push(line);
        if (live.stderr.length > 200) live.stderr.splice(0, live.stderr.length - 200);
        this.log(`[chat ${live.chatId}] ${line}`);
      },
      onExit: (info) => this.handleExit(live, info),
    });
    live.handle = handle;
    this.live.set(row.id, live);
    live.spawning = this.afterSpawn(live, row);
    await live.spawning;
    return live;
  }

  private async afterSpawn(live: LiveSession, row: chats.ChatSessionRow): Promise<void> {
    try {
      chats.setChatStatus(this.db, live.chatId, "active");
      const res = await live.handle.send({ type: "get_state" }, { timeoutMs: 10_000 });
      const data = (res.data ?? {}) as Record<string, unknown>;
      const sessionId = asString(data.sessionId);
      const sessionFile = asString(data.sessionFile);
      chats.setChatPiRefs(this.db, live.chatId, { piSessionId: sessionId, sessionFile });
      this.log(`[chat ${live.chatId}] spawned pid=${live.handle.pid ?? "?"} session=${sessionId ?? "?"}`);
    } catch (err) {
      this.log(`[chat ${live.chatId}] get_state failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      live.spawning = null;
    }
  }

  private touch(live: LiveSession): void {
    live.lastActivity = Date.now();
    chats.touchChatSession(this.db, live.chatId);
  }

  // ── event handling ─────────────────────────────────────────────────────────

  private handleRecord(live: LiveSession, rec: RpcRecord): void {
    const type = asString(rec.type) ?? "";
    switch (type) {
      case "message_start":
      case "turn_start": {
        // A user `message_start` echoes the prompt we already persisted.
        break;
      }
      case "message_update": {
        const ev = rec.assistantMessageEvent as Record<string, unknown> | undefined;
        const evType = asString(ev?.type) ?? "";
        if (!ev) break;
        const contentIndex = typeof ev.contentIndex === "number" ? ev.contentIndex : 0;
        if (evType === "text_delta") {
          this.bus.emit(live.chatId, "chat.delta", { contentIndex, delta: typeof ev.delta === "string" ? ev.delta : "" });
        } else if (evType === "thinking_delta") {
          this.bus.emit(live.chatId, "chat.thinking", { contentIndex, delta: typeof ev.delta === "string" ? ev.delta : "" });
        } else if (evType === "text_end") {
          this.bus.emit(live.chatId, "chat.block_end", { contentIndex, block: "text", content: asString(ev.content) ?? "" });
        } else if (evType === "thinking_end") {
          this.bus.emit(live.chatId, "chat.block_end", { contentIndex, block: "thinking", content: asString(ev.content) ?? "" });
        } else if (evType === "toolcall_start") {
          this.bus.emit(live.chatId, "chat.tool_call", { contentIndex, phase: "start", toolCallId: asString(ev.id), toolName: asString(ev.toolName) });
        }
        break;
      }
      case "message_end": {
        const message = rec.message as Record<string, unknown> | undefined;
        const role = asString(message?.role) ?? "";
        if (!message) break;
        // I22: only assistant messages are authoritative here; the human turn was
        // persisted on prompt acceptance, so a user echo must not duplicate.
        if (role !== "assistant") break;
        const content = contentText(message.content);
        const meta: Record<string, unknown> = {};
        if (message.stopReason !== undefined) meta.stopReason = message.stopReason;
        if (message.usage !== undefined) meta.usage = message.usage;
        // H5 失败显形：模型请求失败时 pi 把原因放在 errorMessage（content 为空）。
        // 丢弃它会让 UI 只剩空气泡（2026-10-15 验收：4 个空「agent」气泡，真因是网关 503 无可用渠道）。
        const errorMessage = asString(message.errorMessage);
        if (errorMessage) meta.errorMessage = errorMessage;
        if (message.api !== undefined) meta.api = message.api;
        if (message.model !== undefined) meta.model = message.model;
        const stored = chats.insertChatMessage(this.db, {
          chatSessionId: live.chatId,
          role,
          content,
          meta: Object.keys(meta).length ? meta : undefined,
        });
        this.touch(live);
        this.bus.emit(live.chatId, "chat.message", messageView(stored));
        break;
      }
      case "tool_execution_start": {
        const toolName = asString(rec.toolName) ?? "unknown";
        const toolCallId = asString(rec.toolCallId);
        this.bus.emit(live.chatId, "chat.tool", { phase: "start", toolCallId, toolName, args: rec.args ?? null });
        this.audit(null, "agent.tool", `chat:${live.chatId}`, { phase: "start", toolName, toolCallId });
        break;
      }
      case "tool_execution_end": {
        const toolName = asString(rec.toolName) ?? "unknown";
        const toolCallId = asString(rec.toolCallId);
        const isError = rec.isError === true;
        this.bus.emit(live.chatId, "chat.tool", { phase: "end", toolCallId, toolName, isError });
        this.audit(null, "agent.tool", `chat:${live.chatId}`, { phase: "end", toolName, toolCallId, isError });
        break;
      }
      case "agent_start": {
        live.busy = true;
        this.bus.emit(live.chatId, "chat.busy", { busy: true });
        break;
      }
      case "agent_settled": {
        live.busy = false;
        this.touch(live);
        this.bus.emit(live.chatId, "chat.settled", { busy: false });
        break;
      }
      case "extension_ui_request": {
        this.handleUiRequest(live, rec);
        break;
      }
      case "extension_ui_response":
      case "_parse_error":
        break;
      default:
        break;
    }
  }

  private handleUiRequest(live: LiveSession, rec: RpcRecord): void {
    const method = asString(rec.method) ?? "";
    if (method === "notify") {
      this.bus.emit(live.chatId, "chat.notify", {
        message: asString(rec.message) ?? "",
        notifyType: asString(rec.notifyType) ?? "info",
      });
      return;
    }
    if (method === "setStatus") {
      this.bus.emit(live.chatId, "chat.status", { key: asString(rec.statusKey), text: asString(rec.statusText) });
      return;
    }
    if (method === "setTitle") {
      const title = asString(rec.title);
      if (title) chats.setChatPiRefs(this.db, live.chatId, { title });
      this.bus.emit(live.chatId, "chat.title", { title });
      return;
    }
    if (method === "setWidget" || method === "set_editor_text") return;
    if (!DIALOG_METHODS.has(method)) return;

    const requestId = asString(rec.id);
    if (!requestId) return;
    const timeoutMs = typeof rec.timeout === "number" && rec.timeout > 0 ? rec.timeout : null;
    const { row, created } = chats.insertDecision(this.db, {
      chatSessionId: live.chatId,
      requestId,
      method,
      title: asString(rec.title),
      message: asString(rec.message),
      options: rec.options,
      timeoutMs,
    });
    if (!created) return; // I19: duplicate delivery, already surfaced

    this.touch(live);
    this.audit(null, "agent.decision.pending", `chat:${live.chatId}`, { decisionId: row.id, method, requestId });
    this.bus.emit(live.chatId, "decision.pending", decisionView(row));

    if (timeoutMs !== null) {
      // Display-side only: pi owns the authoritative timeout and auto-resolves.
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        const expired = chats.expireDecision(this.db, row.id);
        if (expired) {
          this.audit(null, "agent.decision.expired", `decision:${row.id}`, { chatId: live.chatId, method });
          this.bus.emit(live.chatId, "decision.expired", decisionView(expired));
        }
      }, timeoutMs);
      timer.unref?.();
      this.timers.add(timer);
    }
  }

  private handleExit(live: LiveSession, info: RpcExitInfo): void {
    this.live.delete(live.chatId);
    if (info.expected) {
      const status: chats.ChatStatus = live.expectStatus === "idle" ? "idle" : "closed";
      // I21/I23: a dead subprocess must not leave `pending` decisions behind.
      // Collect first so we can surface each one going terminal to live SSE clients.
      const pending = chats.listDecisions(this.db, { chatId: live.chatId, status: "pending" });
      const settled = chats.closeChatSession(this.db, live.chatId, status);
      if (settled.decisions > 0) {
        this.log(`[chat ${live.chatId}] ${live.expectStatus} close terminated ${settled.decisions} pending decision(s)`);
      }
      this.bus.emit(live.chatId, "chat.closed", { reason: live.expectStatus, lostDecisions: settled.decisions });
      for (const p of pending) {
        const after = chats.getDecision(this.db, p.id);
        if (after) this.bus.emit(live.chatId, "decision.expired", decisionView(after));
      }
      return;
    }
    const counts = chats.markChatLost(this.db, live.chatId);
    const stderr = live.stderr.slice(-20);
    this.audit(null, "chat.lost", `chat:${live.chatId}`, { code: info.code, signal: info.signal, stderr }, false);
    this.log(`[chat ${live.chatId}] unexpected exit code=${info.code} signal=${info.signal}`);
    this.bus.emit(live.chatId, "chat.lost", {
      reason: "process_exit",
      code: info.code,
      signal: info.signal,
      stderr,
      lostDecisions: counts.decisions,
    });
  }

  // ── commands ───────────────────────────────────────────────────────────────

  async prompt(row: chats.ChatSessionRow, message: string, actor?: ChatActor): Promise<{ disposition: string; busy: boolean }> {
    const live = await this.ensureSpawn(row);
    this.touch(live);
    const wasBusy = live.busy;
    live.busy = true;
    this.persistUserMessage(live, message, "prompt");
    const payload: RpcRecord = { type: "prompt", message };
    if (wasBusy) payload.streamingBehavior = "steer";
    try {
      const res = await live.handle.send(payload, { timeoutMs: 15_000 });
      const data = (res.data ?? {}) as Record<string, unknown>;
      const disposition = asString(data.disposition) ?? "started";
      this.audit(actor, "chat.prompt", `chat:${live.chatId}`, { length: message.length, disposition });
      return { disposition, busy: live.busy };
    } catch (err) {
      live.busy = false;
      throw err;
    }
  }

  async steer(row: chats.ChatSessionRow, message: string, actor?: ChatActor): Promise<{ disposition: string }> {
    const live = await this.ensureSpawn(row);
    this.touch(live);
    this.persistUserMessage(live, message, "steer");
    const res = await live.handle.send({ type: "steer", message }, { timeoutMs: 15_000 });
    const data = (res.data ?? {}) as Record<string, unknown>;
    const disposition = asString(data.disposition) ?? "queued";
    this.audit(actor, "chat.prompt", `chat:${live.chatId}`, { kind: "steer", length: message.length, disposition });
    return { disposition };
  }

  async followUp(row: chats.ChatSessionRow, message: string, actor?: ChatActor): Promise<{ disposition: string }> {
    const live = await this.ensureSpawn(row);
    this.touch(live);
    this.persistUserMessage(live, message, "follow_up");
    const res = await live.handle.send({ type: "follow_up", message }, { timeoutMs: 15_000 });
    const data = (res.data ?? {}) as Record<string, unknown>;
    const disposition = asString(data.disposition) ?? "queued";
    this.audit(actor, "chat.prompt", `chat:${live.chatId}`, { kind: "follow_up", length: message.length, disposition });
    return { disposition };
  }

  async abort(row: chats.ChatSessionRow, actor?: ChatActor): Promise<void> {
    const live = await this.ensureSpawn(row);
    this.touch(live);
    await live.handle.send({ type: "abort" }, { timeoutMs: 10_000 });
    live.busy = false;
    this.audit(actor, "chat.abort", `chat:${live.chatId}`, {});
    this.bus.emit(live.chatId, "chat.aborted", {});
  }

  async setModel(row: chats.ChatSessionRow, provider: string, modelId: string, actor?: ChatActor): Promise<unknown> {
    const live = await this.ensureSpawn(row);
    this.touch(live);
    const res = await live.handle.send({ type: "set_model", provider, modelId }, { timeoutMs: 15_000 });
    this.audit(actor, "chat.model.set", `chat:${live.chatId}`, { provider, modelId });
    return res.data ?? null;
  }

  async fork(row: chats.ChatSessionRow, entryId: string, actor?: ChatActor): Promise<{ text: string | null; cancelled: boolean }> {
    const live = await this.ensureSpawn(row);
    this.touch(live);
    const res = await live.handle.send({ type: "fork", entryId }, { timeoutMs: 15_000 });
    const data = (res.data ?? {}) as Record<string, unknown>;
    const cancelled = data.cancelled === true;
    if (!cancelled) await this.refreshState(live);
    const text = asString(data.text);
    this.persistSystemMessage(live, `已从历史消息 fork 出新分支${text ? `：${text}` : ""}`);
    this.audit(actor, "chat.fork", `chat:${live.chatId}`, { entryId, cancelled });
    this.bus.emit(live.chatId, "chat.forked", { entryId, cancelled });
    return { text, cancelled };
  }

  async clone(row: chats.ChatSessionRow, actor?: ChatActor): Promise<{ cancelled: boolean }> {
    const live = await this.ensureSpawn(row);
    this.touch(live);
    const res = await live.handle.send({ type: "clone" }, { timeoutMs: 15_000 });
    const data = (res.data ?? {}) as Record<string, unknown>;
    const cancelled = data.cancelled === true;
    if (!cancelled) await this.refreshState(live);
    this.persistSystemMessage(live, "已 clone 当前分支到新会话");
    this.audit(actor, "chat.clone", `chat:${live.chatId}`, { cancelled });
    this.bus.emit(live.chatId, "chat.cloned", { cancelled });
    return { cancelled };
  }

  answerDecision(
    decisionId: number,
    input: { value?: string; confirmed?: boolean; cancelled?: boolean },
    actor?: ChatActor,
  ): DecisionView {
    const row = chats.getDecision(this.db, decisionId);
    if (!row) throw new HttpError(404, "decision_not_found", "决策不存在");
    const live = this.live.get(row.chat_session_id);
    const decided = chats.answerDecision(this.db, decisionId, {
      value: input.value,
      confirmed: input.confirmed,
      cancelled: input.cancelled,
      answeredBy: actor?.userId ?? null,
    });
    if (!decided) {
      throw new HttpError(409, "decision_not_pending", "该决策已结束（已回答/取消/超时/丢失），无法再次作答。");
    }
    if (live && live.handle.alive) {
      const payload: RpcRecord = { type: "extension_ui_response", id: row.request_id };
      if (decided.status === "cancelled") payload.cancelled = true;
      else if (row.method === "confirm") payload.confirmed = input.confirmed === true;
      else payload.value = input.value ?? "";
      live.handle.sendRaw(payload);
      live.lastActivity = Date.now();
    }
    const view = decisionView(decided);
    this.audit(
      actor,
      decided.status === "cancelled" ? "agent.decision.cancel" : "agent.decision.answer",
      `decision:${decisionId}`,
      { chatId: row.chat_session_id, method: row.method, response: view.response },
    );
    this.bus.emit(row.chat_session_id, "decision.answered", view);
    return view;
  }

  /** Re-read `get_state` to refresh pi session id / file after fork/clone. */
  private async refreshState(live: LiveSession): Promise<void> {
    try {
      const res = await live.handle.send({ type: "get_state" }, { timeoutMs: 10_000 });
      const data = (res.data ?? {}) as Record<string, unknown>;
      chats.setChatPiRefs(this.db, live.chatId, {
        piSessionId: asString(data.sessionId),
        sessionFile: asString(data.sessionFile),
      });
    } catch (err) {
      this.log(`[chat ${live.chatId}] refreshState failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private persistUserMessage(live: LiveSession, message: string, source: string): void {
    const stored = chats.insertChatMessage(this.db, {
      chatSessionId: live.chatId,
      role: "user",
      content: message,
      meta: { source },
    });
    this.bus.emit(live.chatId, "chat.message", messageView(stored));
  }

  private persistSystemMessage(live: LiveSession, message: string): void {
    const stored = chats.insertChatMessage(this.db, {
      chatSessionId: live.chatId,
      role: "system",
      content: message,
      meta: undefined,
    });
    this.bus.emit(live.chatId, "chat.message", messageView(stored));
  }

  private audit(actor: ChatActor | null | undefined, action: string, target: string, detail: unknown, ok = true): void {
    recordAudit(this.db, {
      userId: actor?.userId ?? null,
      actor: actor?.username ?? "system",
      action,
      target,
      detail: detail as never,
      ip: actor?.ip ?? null,
      ua: actor?.ua ?? null,
      ok,
    });
  }
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function chatEventName(event: ChatEvent): string {
  return event.type;
}
