/**
 * Chat sessions / messages / decisions DAO (C4, I4-3 / design.md D10, D6).
 *
 * Invariants (spec/console/data-model.md I19–I23):
 *   I19 `decisions.request_id` is globally unique → re-delivery is idempotent
 *       (`INSERT OR IGNORE`, never a second pending row for the same request).
 *   I20 terminal states (`answered`/`cancelled`/`expired`/`lost`) are immutable.
 *   I21 no `pending` decision may outlive its process → `markChatLost` /
 *       `reapStaleChats` move both the session and its pending decisions in a
 *       single transaction.
 *   I22 `chat_messages` is written on authoritative `message_end` (assistant) or
 *       on prompt acceptance (user) — never from `text_delta` deltas.
 *   I23 `status='lost'` on a session always implies its pending decisions are
 *       terminal in the same transaction.
 */
import type { Database } from "bun:sqlite";

export const CHAT_STATUSES = ["active", "idle", "lost", "closed"] as const;
export type ChatStatus = (typeof CHAT_STATUSES)[number];

export const DECISION_METHODS = ["select", "confirm", "input", "editor"] as const;
export type DecisionMethod = (typeof DECISION_METHODS)[number];

export type DecisionStatus = "pending" | "answered" | "cancelled" | "expired" | "lost";

export interface ChatSessionRow {
  id: number;
  account_id: number;
  job_id: number | null;
  pi_session_id: string | null;
  session_file: string | null;
  title: string | null;
  status: string;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export interface ChatMessageRow {
  id: number;
  chat_session_id: number;
  role: string;
  content: string;
  meta_json: string | null;
  created_at: string;
}

export interface DecisionRow {
  id: number;
  chat_session_id: number;
  request_id: string;
  method: string;
  title: string | null;
  message: string | null;
  options_json: string | null;
  timeout_ms: number | null;
  status: string;
  response_json: string | null;
  created_at: string;
  answered_at: string | null;
  answered_by: number | null;
}

const SESSION_COLUMNS = `id, account_id, job_id, pi_session_id, session_file, title, status,
  created_by, created_at, updated_at`;
const MESSAGE_COLUMNS = `id, chat_session_id, role, content, meta_json, created_at`;
const DECISION_COLUMNS = `id, chat_session_id, request_id, method, title, message, options_json,
  timeout_ms, status, response_json, created_at, answered_at, answered_by`;

export interface CreateChatSessionInput {
  accountId: number;
  title?: string | null;
  jobId?: number | null;
  createdBy?: number | null;
}

export function createChatSession(db: Database, input: CreateChatSessionInput): ChatSessionRow {
  const info = db.run(
    `INSERT INTO chat_sessions(account_id, job_id, title, created_by) VALUES (?, ?, ?, ?)`,
    input.accountId,
    input.jobId ?? null,
    input.title ?? null,
    input.createdBy ?? null,
  );
  return getChatSession(db, Number(info.lastInsertRowid))!;
}

export function getChatSession(db: Database, id: number): ChatSessionRow | undefined {
  return db.query<ChatSessionRow>(`SELECT ${SESSION_COLUMNS} FROM chat_sessions WHERE id = ?`).get(id) ?? undefined;
}

/** Newest first for the sidebar. */
export function listChatSessions(db: Database, accountId: number, limit = 100): ChatSessionRow[] {
  return db
    .query<ChatSessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM chat_sessions WHERE account_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(accountId, Math.max(1, Math.min(500, limit)));
}

/** Sessions still holding (or expected to hold) a live subprocess. */
export function listLiveChatSessions(db: Database): ChatSessionRow[] {
  return db
    .query<ChatSessionRow>(`SELECT ${SESSION_COLUMNS} FROM chat_sessions WHERE status IN ('active','idle')`)
    .all();
}

export function setChatStatus(db: Database, id: number, status: ChatStatus): void {
  db.run(`UPDATE chat_sessions SET status = ?, updated_at = datetime('now') WHERE id = ?`, status, id);
}

export function touchChatSession(db: Database, id: number): void {
  db.run(`UPDATE chat_sessions SET updated_at = datetime('now') WHERE id = ?`, id);
}

export function setChatPiRefs(
  db: Database,
  id: number,
  refs: { piSessionId?: string | null; sessionFile?: string | null; title?: string | null },
): void {
  const sets: string[] = [];
  const params: (string | null | number)[] = [];
  if (refs.piSessionId !== undefined) {
    sets.push("pi_session_id = ?");
    params.push(refs.piSessionId);
  }
  if (refs.sessionFile !== undefined) {
    sets.push("session_file = ?");
    params.push(refs.sessionFile);
  }
  if (refs.title !== undefined && refs.title !== null && refs.title.length > 0) {
    sets.push("title = ?");
    params.push(refs.title);
  }
  if (!sets.length) return;
  sets.push("updated_at = datetime('now')");
  params.push(id);
  db.run(`UPDATE chat_sessions SET ${sets.join(", ")} WHERE id = ?`, ...params);
}

export function deleteChatSession(db: Database, id: number): void {
  db.run(`DELETE FROM chat_sessions WHERE id = ?`, id);
}

export interface ChatMessageInput {
  chatSessionId: number;
  role: string;
  content: string;
  /** Optional structured payload (e.g. `{ stopReason, usage }`). */
  meta?: unknown;
}

export function insertChatMessage(db: Database, input: ChatMessageInput): ChatMessageRow {
  const info = db.run(
    `INSERT INTO chat_messages(chat_session_id, role, content, meta_json) VALUES (?, ?, ?, ?)`,
    input.chatSessionId,
    input.role,
    input.content,
    input.meta === undefined ? null : JSON.stringify(input.meta),
  );
  return db
    .query<ChatMessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM chat_messages WHERE id = ?`)
    .get(Number(info.lastInsertRowid))!;
}

export function listChatMessages(db: Database, chatId: number, limit = 500): ChatMessageRow[] {
  const rows = db
    .query<ChatMessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM chat_messages WHERE chat_session_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(chatId, Math.max(1, Math.min(2000, limit)));
  return rows.reverse();
}

// ── decisions ───────────────────────────────────────────────────────────────

export interface DecisionInput {
  chatSessionId: number;
  requestId: string;
  method: string;
  title?: string | null;
  message?: string | null;
  options?: unknown;
  timeoutMs?: number | null;
}

export interface InsertDecisionResult {
  row: DecisionRow;
  /** False when `request_id` already existed (duplicate delivery, I19). */
  created: boolean;
}

export function insertDecision(db: Database, input: DecisionInput): InsertDecisionResult {
  const existing = getDecisionByRequest(db, input.requestId);
  if (existing) return { row: existing, created: false };
  const info = db.run(
    `INSERT OR IGNORE INTO decisions(chat_session_id, request_id, method, title, message, options_json, timeout_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    input.chatSessionId,
    input.requestId,
    input.method,
    input.title ?? null,
    input.message ?? null,
    input.options === undefined ? null : JSON.stringify(input.options),
    input.timeoutMs ?? null,
  );
  if (Number(info.changes) === 0) {
    return { row: getDecisionByRequest(db, input.requestId)!, created: false };
  }
  const row = db
    .query<DecisionRow>(`SELECT ${DECISION_COLUMNS} FROM decisions WHERE id = ?`)
    .get(Number(info.lastInsertRowid))!;
  return { row, created: true };
}

export function getDecision(db: Database, id: number): DecisionRow | undefined {
  return db.query<DecisionRow>(`SELECT ${DECISION_COLUMNS} FROM decisions WHERE id = ?`).get(id) ?? undefined;
}

export function getDecisionByRequest(db: Database, requestId: string): DecisionRow | undefined {
  return (
    db.query<DecisionRow>(`SELECT ${DECISION_COLUMNS} FROM decisions WHERE request_id = ?`).get(requestId) ?? undefined
  );
}

export interface ListDecisionsOptions {
  chatId?: number;
  status?: DecisionStatus;
  /** `undefined` = unscoped (admin); `[]` = nothing visible. */
  accountIds?: number[];
  limit?: number;
}

export function listDecisions(db: Database, opts: ListDecisionsOptions = {}): DecisionRow[] {
  const where: string[] = [];
  const params: (number | string)[] = [];
  if (opts.chatId !== undefined) {
    where.push("chat_session_id = ?");
    params.push(opts.chatId);
  }
  if (opts.status !== undefined) {
    where.push("status = ?");
    params.push(opts.status);
  }
  if (opts.accountIds !== undefined) {
    if (opts.accountIds.length === 0) return [];
    where.push(
      `chat_session_id IN (SELECT id FROM chat_sessions WHERE account_id IN (${opts.accountIds.map(() => "?").join(",")}))`,
    );
    params.push(...opts.accountIds);
  }
  const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
  params.push(limit);
  const sql = `SELECT ${DECISION_COLUMNS} FROM decisions${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`;
  return db.query<DecisionRow>(sql).all(...params);
}

export interface AnswerDecisionInput {
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
  answeredBy?: number | null;
}

/** Move a pending decision to a terminal state. Returns undefined if not pending (I20). */
export function answerDecision(db: Database, id: number, input: AnswerDecisionInput): DecisionRow | undefined {
  const row = getDecision(db, id);
  if (!row || row.status !== "pending") return undefined;
  const cancelled = input.cancelled === true;
  const response = cancelled
    ? { cancelled: true }
    : row.method === "confirm"
      ? { confirmed: input.confirmed === true }
      : { value: input.value ?? "" };
  const status: DecisionStatus = cancelled ? "cancelled" : "answered";
  db.run(
    `UPDATE decisions SET status = ?, response_json = ?, answered_at = datetime('now'), answered_by = ? WHERE id = ? AND status = 'pending'`,
    status,
    JSON.stringify(response),
    input.answeredBy ?? null,
    id,
  );
  return getDecision(db, id);
}

/** Display-side timeout only: pi owns the authoritative timeout (design.md D6). */
export function expireDecision(db: Database, id: number): DecisionRow | undefined {
  const row = getDecision(db, id);
  if (!row || row.status !== "pending") return undefined;
  db.run(`UPDATE decisions SET status = 'expired', answered_at = datetime('now') WHERE id = ? AND status = 'pending'`, id);
  return getDecision(db, id);
}

function losePending(db: Database, chatId: number): number {
  const info = db.run(
    `UPDATE decisions SET status = 'lost', answered_at = datetime('now') WHERE chat_session_id = ? AND status = 'pending'`,
    chatId,
  );
  return Number(info.changes);
}

export function loseDecisionsForSession(db: Database, chatId: number): number {
  return losePending(db, chatId);
}

export interface ChatLostCounts {
  sessions: number;
  decisions: number;
}

/** Mark a session `lost` and terminate its pending decisions atomically (I23). */
export function markChatLost(db: Database, chatId: number): ChatLostCounts {
  const run = db.transaction((): ChatLostCounts => {
    const decisions = losePending(db, chatId);
    const info = db.run(
      `UPDATE chat_sessions SET status = 'lost', updated_at = datetime('now') WHERE id = ? AND status IN ('active','idle')`,
      chatId,
    );
    return { sessions: Number(info.changes), decisions };
  });
  return run();
}

/**
 * Expected close (idle TTL / explicit delete / shutdown): set the session status
 * and terminate any pending decisions in ONE transaction (I21 + I23). Unlike
 * `markChatLost`, the caller picks the status (`idle` for a TTL reap, `closed`
 * for an explicit close) so the UI can tell them apart — but pending decisions
 * must never outlive the subprocess either way.
 */
export function closeChatSession(db: Database, chatId: number, status: ChatStatus): ChatLostCounts {
  const run = db.transaction((): ChatLostCounts => {
    const decisions = losePending(db, chatId);
    const info = db.run(
      `UPDATE chat_sessions SET status = ?, updated_at = datetime('now') WHERE id = ?`,
      status,
      chatId,
    );
    return { sessions: Number(info.changes), decisions };
  });
  return run();
}

export function countPendingDecisions(db: Database, chatId: number): number {
  const row = db
    .query<{ n: number }>(`SELECT COUNT(*) AS n FROM decisions WHERE chat_session_id = ? AND status = 'pending'`)
    .get(chatId);
  return row?.n ?? 0;
}

/** Pending decision counts for every session of one account (sidebar badges). */
export function pendingCountsForAccount(db: Database, accountId: number): Map<number, number> {
  const rows = db
    .query<{ chat_session_id: number; n: number }>(
      `SELECT d.chat_session_id AS chat_session_id, COUNT(*) AS n
         FROM decisions d JOIN chat_sessions s ON s.id = d.chat_session_id
        WHERE s.account_id = ? AND d.status = 'pending'
        GROUP BY d.chat_session_id`,
    )
    .all(accountId);
  return new Map(rows.map((r) => [r.chat_session_id, r.n]));
}

/**
 * Startup reaper: any session that is not backed by a live subprocess in *this*
 * process is stale (the previous process died) → `lost` + pending decisions lost,
 * in one transaction.
 */
export function reapStaleChats(db: Database, liveIds: Iterable<number>): ChatLostCounts {
  const ids = [...liveIds].filter((n) => Number.isInteger(n));
  const placeholders = ids.length ? ids.map(() => "?").join(",") : "-1";
  const run = db.transaction((): ChatLostCounts => {
    const decisions = db.run(
      `UPDATE decisions SET status = 'lost', answered_at = datetime('now')
        WHERE status = 'pending' AND chat_session_id NOT IN (${placeholders})`,
      ...ids,
    );
    const sessions = db.run(
      `UPDATE chat_sessions SET status = 'lost', updated_at = datetime('now')
        WHERE status IN ('active','idle') AND id NOT IN (${placeholders})`,
      ...ids,
    );
    return { sessions: Number(sessions.changes), decisions: Number(decisions.changes) };
  });
  return run();
}
