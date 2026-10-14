/**
 * Console HTTP app: routing, session middleware, CSRF, RBAC, and the C1 API.
 *
 * Layers:
 *   route()  — dispatch + auth/CSRF gate, throws `HttpError`
 *   handle() — wraps route() into a Response with security headers
 */
import type { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { Router } from "./http/router.ts";
import {
  HttpError,
  badRequest,
  conflict,
  fail,
  forbidden,
  notFound,
  ok,
  tooMany,
  unauthorized,
} from "./http/respond.ts";
import { asObject, isPlainObject, type Json, type JsonObject } from "./types.ts";
import { getGlobalRaw, setGlobalRaw } from "./db/dao/settings.ts";
import {
  accountIdsForUser,
  deleteAccount,
  getAccountById,
  getAccountByAlias,
  getAccountByCdpPort,
  grantRowsForUser,
  insertAccount,
  listAccountRows,
  parseOverrides,
  setGrants,
  suggestCdpPorts,
  updateAccount,
  type AccountRow,
} from "./db/dao/accounts.ts";
import { recentAudit, recordAudit } from "./db/dao/audit.ts";
import { effectiveAccount, keySource, overrideKeys, removeOverride } from "./config/resolve.ts";
import { renderConfig } from "./db/render-config.ts";
import { loadConfig } from "../config.ts";
import * as plans from "./jobs/plans.ts";
import * as queue from "./jobs/queue.ts";
import { EXECUTABLE_KINDS, isJobKind, parseItems, parseJobPayload, type JobRow, type PlanRow } from "./jobs/types.ts";
import { serveUi } from "./http/static.ts";
import { streamJobEvents } from "./http/sse.ts";
import { streamChatEvents } from "./http/chat-sse.ts";
import type { ChatActor, ChatManager } from "./agent/manager.ts";
import type { ChatSessionRow } from "./db/dao/chats.ts";
import * as articles from "./db/dao/articles.ts";
import * as users from "./auth/users.ts";
import * as sess from "./auth/sessions.ts";
import { assertAccountAccess, assertAdmin, authContextOf, isAdmin, visibleAccountIds, type AuthContext } from "./auth/rbac.ts";

const ALIAS_RE = /^[A-Za-z0-9_-]{2,32}$/;

export interface AppState {
  db: Database;
  version: string;
  startedAt: number;
  secureCookies: boolean;
  masterKey: Buffer;
}

export interface Ctx {
  req: Request;
  url: URL;
  params: Record<string, string>;
  state: AppState;
  session: sess.SessionContext | null;
  auth: AuthContext | null;
}

export interface App {
  router: Router<Ctx>;
  handle(req: Request): Promise<Response>;
}

// ── helpers ─────────────────────────────────────────────────────────────────

async function readJson(req: Request): Promise<JsonObject> {
  try {
    return asObject(await req.json());
  } catch {
    throw badRequest("请求体必须是合法 JSON 对象");
  }
}

function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "local";
}

function intParam(ctx: Ctx, name = "id"): number {
  const n = Number(ctx.params[name]);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`参数 ${name} 非法`);
  return n;
}

const CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

function securityHeaders(res: Response, secure: boolean): Response {
  try {
    res.headers.set("x-content-type-options", "nosniff");
    res.headers.set("referrer-policy", "no-referrer");
    res.headers.set("x-frame-options", "DENY");
    res.headers.set("content-security-policy", CSP);
    if (secure) res.headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
    if (!res.headers.has("cache-control")) res.headers.set("cache-control", "no-store");
  } catch {
    /* immutable headers — ignore */
  }
  return res;
}

function accountView(row: AccountRow, withDetail = false): JsonObject {
  const entry = parseOverrides(row);
  const view: JsonObject = {
    id: row.id,
    alias: row.alias,
    displayName: row.display_name,
    author: row.author,
    cdpPort: row.cdp_port,
    publishMethod: row.publish_method,
    dataDir: row.data_dir,
    enabled: row.enabled === null ? null : row.enabled !== 0,
    overrideKeys: overrideKeys(entry),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (withDetail) view.overrides = entry;
  return view;
}

/** Operator-only top-level keys hidden from non-admin viewers. */
const SECRET_KEYS = ["notify", "proxy", "piBin", "bunBin", "skillDir"];

function accountDetail(db: Database, row: AccountRow, asAdmin: boolean): JsonObject {
  const global = getGlobalRaw(db);
  const entry = parseOverrides(row);
  const effective = effectiveAccount(global, entry) as JsonObject;
  const sources: JsonObject = {};
  for (const k of Object.keys(effective)) sources[k] = keySource(global, entry, k);
  const view = accountView(row, true);
  if (!asAdmin) {
    const overrides = view.overrides as JsonObject | undefined;
    for (const k of SECRET_KEYS) {
      delete effective[k];
      delete sources[k];
      if (overrides) delete overrides[k];
    }
  }
  return { ...view, effective, sources, ...(asAdmin ? { global } : {}) };
}

function visibleRows(db: Database, auth: AuthContext | null): AccountRow[] {
  const rows = listAccountRows(db);
  if (!auth) return [];
  if (auth.grantedAccounts === "all") return rows;
  const ids = new Set(auth.grantedAccounts);
  return rows.filter((r) => ids.has(r.id));
}

function ensureUniqueAlias(db: Database, alias: string, exceptId?: number): void {
  if (!ALIAS_RE.test(alias)) throw badRequest("alias 需为 2–32 位字母、数字、下划线或连字符");
  const existing = getAccountByAlias(db, alias);
  if (existing && existing.id !== exceptId) throw conflict(`alias 已存在：${alias}`);
}

function cdpPortConflict(db: Database, entry: JsonObject, exceptId?: number): void {
  const port = entry.cdpPort;
  if (typeof port !== "number") return;
  const taken = getAccountByCdpPort(db, port);
  if (taken && taken.id !== exceptId) {
    throw conflict(`cdpPort ${port} 已被账号「${taken.alias}」占用`, {
      suggestions: suggestCdpPorts(db, 9222, 5),
    });
  }
}

const STRING_ENTRY_KEYS = ["displayName", "author", "theme", "color", "dataDir", "contentDir", "promptsDir", "subjectPrefix"];
const OBJECT_ENTRY_KEYS = ["math", "manim", "cover", "model"];

/** Reject malformed account entries so hot mirror columns + UNIQUE(cdp_port) stay trustworthy. */
function assertEntryTypes(entry: JsonObject): void {
  for (const k of STRING_ENTRY_KEYS) {
    if (entry[k] !== undefined && entry[k] !== null && typeof entry[k] !== "string") throw badRequest(`${k} 必须是字符串`);
  }
  for (const k of ["enabled", "draftOnly"]) {
    if (entry[k] !== undefined && entry[k] !== null && typeof entry[k] !== "boolean") throw badRequest(`${k} 必须是布尔值`);
  }
  for (const k of OBJECT_ENTRY_KEYS) {
    if (entry[k] !== undefined && entry[k] !== null && !isPlainObject(entry[k])) throw badRequest(`${k} 必须是对象`);
  }
  if (entry.emailTo !== undefined && entry.emailTo !== null && !Array.isArray(entry.emailTo)) throw badRequest("emailTo 必须是数组");
  if (entry.publishMethod !== undefined && entry.publishMethod !== null && entry.publishMethod !== "api" && entry.publishMethod !== "browser") {
    throw badRequest("publishMethod 只能是 api 或 browser");
  }
  if (entry.cdpPort !== undefined && entry.cdpPort !== null) {
    const p = entry.cdpPort;
    if (typeof p !== "number" || !Number.isInteger(p) || p < 1 || p > 65535) throw badRequest("cdpPort 必须是 1–65535 的整数");
  }
}

/** Reject grants referencing account ids that do not exist (avoids FK 500 + orphan users). */
function assertAccountIds(db: Database, ids: unknown): void {
  if (ids === undefined) return;
  if (!Array.isArray(ids)) throw badRequest("accountIds 必须是整数数组");
  const valid = new Set(listAccountRows(db).map((r) => r.id));
  const bad = ids.filter((n) => !Number.isInteger(n) || !valid.has(n as number));
  if (bad.length) throw badRequest(`引用了不存在的账号 id：${bad.join(", ")}`);
}

/** Persist DB → config.json after any config-affecting mutation (errors surface to the caller). */
function syncConfigFile(db: Database): void {
  renderConfig(db);
}

/** Public shape of a job row (payload parsed, camelCase keys). */
function parseOptions(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

function jobView(row: JobRow): JsonObject {
  return {
    id: row.id,
    accountId: row.account_id,
    kind: row.kind,
    status: row.status,
    progress: row.progress,
    message: row.message,
    error: row.error,
    attempts: row.attempts,
    payload: parseJobPayload(row) as unknown as Json,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    pid: row.pid,
  };
}

/** Public shape of a plan row (items parsed). */
function planView(row: PlanRow): JsonObject {
  return {
    id: row.id,
    accountId: row.account_id,
    periodType: row.period_type,
    periodKey: row.period_key,
    status: row.status,
    items: parseItems(row) as unknown as Json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Public shape of an article version, `verified` mirrored from the latest draft. */
function articleView(row: articles.ArticleRow, latest?: articles.DraftRow): JsonObject {
  return {
    id: row.id,
    accountId: row.account_id,
    planId: row.plan_id,
    date: row.date,
    title: row.title,
    slug: row.slug,
    filePath: row.file_path,
    status: row.status,
    version: row.version,
    parentId: row.parent_id,
    feedback: row.feedback,
    createdAt: row.created_at,
    verified: latest ? latest.verified === 1 : null,
    verifyDetail: latest?.verify_detail ?? null,
  };
}

/** Public shape of a push attempt (verify verdict from the engine, I18). */
function draftView(row: articles.DraftRow): JsonObject {
  return {
    id: row.id,
    accountId: row.account_id,
    articleId: row.article_id,
    wechatTitle: row.wechat_title,
    pushAt: row.push_at,
    verified: row.verified === 1,
    verifyDetail: row.verify_detail,
    createdAt: row.created_at,
  };
}

// ── app ─────────────────────────────────────────────────────────────────────

export function createApp(state: AppState, chat?: ChatManager): App {
  const { db } = state;
  const router = new Router<Ctx>();

  // ---- auth ----------------------------------------------------------------

  router.add("POST", "/api/login", async (ctx) => {
    const body = await readJson(ctx.req);
    const username = typeof body.username === "string" ? body.username : "";
    const password = typeof body.password === "string" ? body.password : "";
    const ip = clientIp(ctx.req);
    const ua = ctx.req.headers.get("user-agent") ?? null;

    if (!username || !password) throw badRequest("用户名和密码必填");

    const lock = sess.lockState(db, username);
    if (lock.locked) {
      recordAudit(db, { actor: username, action: "login", target: username, ok: false, ip, detail: "locked" });
      throw tooMany(`尝试过于频繁，请 ${Math.ceil(lock.retryAfterSec / 60)} 分钟后再试`);
    }

    const user = users.getUserByUsername(db, username);
    const good = user && user.disabled === 0 ? await users.verifyPassword(user, password) : false;

    if (!user || !good) {
      sess.recordAttempt(db, username, ip, false);
      recordAudit(db, { actor: username, action: "login", target: username, ok: false, ip, detail: "bad credentials" });
      throw unauthorized("用户名或密码错误");
    }

    sess.clearAttempts(db, username);
    sess.recordAttempt(db, username, ip, true);
    sess.purgeExpiredSessions(db);

    const { token, csrfToken } = sess.createSession(db, user.id, ip, ua);
    recordAudit(db, { actor: username, action: "login", target: username, ok: true, ip });

    return ok({ user: users.toPublic(user), csrfToken }, 200, {
      "set-cookie": sess.sessionCookie(token, sess.ttlHours() * 3600, state.secureCookies),
    });
  });

  router.add("POST", "/api/logout", async (ctx) => {
    const token = sess.parseCookie(ctx.req.headers.get("cookie"), sess.SESSION_COOKIE);
    if (token) sess.destroySession(db, token);
    if (ctx.auth) recordAudit(db, { actor: ctx.auth.user.username, action: "logout", target: self(ctx), ok: true });
    return ok(null, 200, { "set-cookie": sess.clearSessionCookie(state.secureCookies) });
  });

  router.add("GET", "/api/me", (ctx) => {
    const auth = ctx.auth!;
    return ok({
      user: users.toPublic(auth.user),
      csrfToken: ctx.session!.csrfToken,
      grantedAccounts: auth.grantedAccounts,
      accounts: visibleRows(db, auth).map((r) => ({ id: r.id, alias: r.alias, displayName: r.display_name })),
      isAdmin: isAdmin(auth),
    });
  });

  router.add("POST", "/api/password", async (ctx) => {
    const auth = ctx.auth!;
    const body = await readJson(ctx.req);
    const current = typeof body.currentPassword === "string" ? body.currentPassword : "";
    const next = typeof body.newPassword === "string" ? body.newPassword : "";
    if (!(await users.verifyPassword(auth.user, current))) throw unauthorized("当前密码不正确");
    await users.setPassword(db, auth.user.id, next);
    sess.destroyUserSessions(db, auth.user.id, ctx.session!.sessionId);
    recordAudit(db, { actor: auth.user.username, action: "password.change", target: self(ctx), ok: true });
    return ok({ changed: true });
  });

  // ---- accounts ------------------------------------------------------------

  router.add("GET", "/api/accounts", (ctx) => {
    const rows = visibleRows(db, ctx.auth);
    return ok({ accounts: rows.map((r) => accountView(r)) });
  });

  router.add("POST", "/api/accounts", async (ctx) => {
    assertAdmin(ctx.auth);
    const body = await readJson(ctx.req);
    const alias = typeof body.alias === "string" ? body.alias.trim() : "";
    if (!alias) throw badRequest("alias 必填");
    ensureUniqueAlias(db, alias);
    const entry = isPlainObject(body.overrides)
      ? (body.overrides as JsonObject)
      : (() => {
          const rest = { ...body } as JsonObject;
          delete rest.alias;
          delete rest.overrides;
          return rest;
        })();
    assertEntryTypes(entry);
    cdpPortConflict(db, entry);

    const id = insertAccount(db, alias, entry);
    syncConfigFile(db);
    recordAudit(db, { actor: ctx.auth.user.username, action: "account.create", target: alias, ok: true });
    return ok(accountView(getAccountById(db, id)!), 201);
  });

  router.add("GET", "/api/accounts/:id", (ctx) => {
    const id = intParam(ctx);
    if (!getAccountById(db, id)) throw notFound("账号不存在");
    assertAccountAccess(ctx.auth, id);
    return ok(accountDetail(db, getAccountById(db, id)!, isAdmin(ctx.auth)));
  });

  router.add("PUT", "/api/accounts/:id", async (ctx) => {
    const id = intParam(ctx);
    const row = getAccountById(db, id);
    if (!row) throw notFound("账号不存在");
    assertAccountAccess(ctx.auth, id);

    const body = await readJson(ctx.req);
    if (typeof body.alias === "string" && body.alias !== row.alias) {
      throw badRequest("alias 暂不支持修改（会改变数据目录）");
    }
    const entry = isPlainObject(body.overrides) ? (body.overrides as JsonObject) : undefined;
    if (!entry) throw badRequest("缺少 overrides 对象");
    assertEntryTypes(entry);
    cdpPortConflict(db, entry, id);

    updateAccount(db, id, row.alias, entry);
    syncConfigFile(db);
    recordAudit(db, { actor: ctx.auth!.user.username, action: "account.update", target: row.alias, ok: true });
    return ok(accountDetail(db, getAccountById(db, id)!, isAdmin(ctx.auth)));
  });

  router.add("DELETE", "/api/accounts/:id", (ctx) => {
    assertAdmin(ctx.auth);
    const id = intParam(ctx);
    const row = getAccountById(db, id);
    if (!row) throw notFound("账号不存在");
    deleteAccount(db, id);
    syncConfigFile(db);
    recordAudit(db, { actor: ctx.auth.user.username, action: "account.delete", target: row.alias, ok: true });
    return ok({ deleted: true, alias: row.alias, note: `data/${row.alias}/ 未删除` });
  });

  router.add("POST", "/api/accounts/:id/reset-override", async (ctx) => {
    const id = intParam(ctx);
    const row = getAccountById(db, id);
    if (!row) throw notFound("账号不存在");
    assertAccountAccess(ctx.auth, id);

    const body = await readJson(ctx.req);
    const key = typeof body.key === "string" ? body.key : "";
    if (!key) throw badRequest("缺少 key");
    const entry = parseOverrides(row);
    if (!(key in entry)) throw badRequest(`账号未覆盖 ${key}`);

    updateAccount(db, id, row.alias, removeOverride(entry, key));
    syncConfigFile(db);
    recordAudit(db, {
      actor: ctx.auth!.user.username,
      action: "account.reset-override",
      target: `${row.alias}.${key}`,
      ok: true,
    });
    return ok(accountDetail(db, getAccountById(db, id)!, isAdmin(ctx.auth)));
  });

  // ---- plans + jobs (C2) ---------------------------------------------------

  const loadJob = (ctx: Ctx, id: number): JobRow => {
    const job = queue.getJob(db, id);
    if (!job) throw notFound("任务不存在");
    assertAccountAccess(ctx.auth, job.account_id);
    return job;
  };

  // ---- chat sessions (C4) --------------------------------------------------

  const requireChat = (): ChatManager => {
    if (!chat) throw new HttpError(503, "chat_unavailable", "会话功能未启用（服务未初始化 Agent 管理器）");
    return chat;
  };

  const chatActor = (ctx: Ctx): ChatActor => ({
    userId: ctx.auth?.user.id ?? null,
    username: ctx.auth?.user.username ?? null,
    ip: clientIp(ctx.req),
    ua: ctx.req.headers.get("user-agent"),
  });

  /** Load a chat row and enforce that the caller may access its account. */
  const loadChat = (manager: ChatManager, ctx: Ctx): ChatSessionRow => {
    const row = manager.requireSession(intParam(ctx));
    assertAccountAccess(ctx.auth, row.account_id);
    return row;
  };

  router.add("GET", "/api/accounts/:id/plans", (ctx) => {
    const id = intParam(ctx);
    if (!getAccountById(db, id)) throw notFound("账号不存在");
    assertAccountAccess(ctx.auth, id);
    const periodType = ctx.url.searchParams.get("period_type") ?? undefined;
    const periodKey = ctx.url.searchParams.get("period_key") ?? undefined;
    return ok({ plans: plans.listPlans(db, id, { periodType, periodKey }).map(planView) });
  });

  router.add("PUT", "/api/accounts/:id/plans", async (ctx) => {
    const id = intParam(ctx);
    const row = getAccountById(db, id);
    if (!row) throw notFound("账号不存在");
    assertAccountAccess(ctx.auth, id);

    const body = await readJson(ctx.req);
    const periodType = typeof body.period_type === "string" ? body.period_type : typeof body.periodType === "string" ? body.periodType : "";
    const periodKey = typeof body.period_key === "string" ? body.period_key : typeof body.periodKey === "string" ? body.periodKey : "";
    const checked = plans.validatePlanInput(periodType, periodKey, body.items);
    if (!checked.ok || !checked.items) throw badRequest(checked.error ?? "计划校验失败");

    const planId = plans.upsertPlan(db, id, periodType as plans.PeriodType, periodKey, checked.items, ctx.auth!.user.id);
    try {
      plans.materializePlans(db, loadConfig(row.alias), id);
    } catch (err) {
      throw new HttpError(500, "internal", `计划已入库但同步到 engine 失败：${(err as Error).message}`);
    }
    recordAudit(db, {
      userId: ctx.auth!.user.id,
      actor: ctx.auth!.user.username,
      action: "plan.upsert",
      target: `${row.alias}:${periodType}:${periodKey}`,
      detail: { days: checked.items.days.length },
      ok: true,
    });
    return ok({ id: planId, periodType, periodKey, items: checked.items as unknown as Json });
  });

  router.add("GET", "/api/accounts/:id/plans/find", (ctx) => {
    const id = intParam(ctx);
    if (!getAccountById(db, id)) throw notFound("账号不存在");
    assertAccountAccess(ctx.auth, id);
    const date = ctx.url.searchParams.get("date") ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest("date 需为 YYYY-MM-DD");
    const found = plans.findPlanDay(db, id, date);
    if (!found) return ok({ found: false, date });
    return ok({
      found: true,
      date,
      planId: found.plan.id,
      periodKey: found.plan.period_key,
      day: found.day as unknown as Json,
    });
  });

  router.add("POST", "/api/accounts/:id/jobs", async (ctx) => {
    const id = intParam(ctx);
    if (!getAccountById(db, id)) throw notFound("账号不存在");
    assertAccountAccess(ctx.auth, id);

    const body = await readJson(ctx.req);
    const kind = body.kind;
    if (!isJobKind(kind)) throw badRequest("kind 必须是 plan|publish|generate|regenerate");
    if (!EXECUTABLE_KINDS.includes(kind)) throw badRequest(`kind not supported yet: ${kind}`);
    const payload = isPlainObject(body.payload) ? (body.payload as JsonObject) : {};
    if (typeof payload.date === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(payload.date)) {
      throw badRequest("payload.date 需为 YYYY-MM-DD");
    }

    const jobId = queue.enqueue(db, id, kind, payload, {
      createdBy: ctx.auth!.user.id,
      actor: ctx.auth!.user.username,
    });
    return ok({ job: jobView(queue.getJob(db, jobId)!) }, 201);
  });

  router.add("GET", "/api/accounts/:id/jobs", (ctx) => {
    const id = intParam(ctx);
    if (!getAccountById(db, id)) throw notFound("账号不存在");
    assertAccountAccess(ctx.auth, id);
    const status = ctx.url.searchParams.get("status") ?? undefined;
    const limit = Number(ctx.url.searchParams.get("limit") ?? 50) || 50;
    return ok({ jobs: queue.listJobsForAccount(db, id, { status, limit }).map(jobView) });
  });

  router.add("GET", "/api/jobs/:id", (ctx) => {
    const job = loadJob(ctx, intParam(ctx));
    return ok({ job: jobView(job), logs: queue.listJobLogs(db, job.id, 100) });
  });

  router.add("POST", "/api/jobs/:id/cancel", (ctx) => {
    const job = loadJob(ctx, intParam(ctx));
    if (!queue.cancel(db, job.id)) throw conflict(`任务当前状态为 ${job.status}，仅 queued 可取消`);
    recordAudit(db, {
      userId: ctx.auth!.user.id,
      actor: ctx.auth!.user.username,
      action: "job_cancel",
      target: `job:${job.id}`,
      ok: true,
    });
    return ok({ job: jobView(queue.getJob(db, job.id)!) });
  });

  // ---- articles + content workbench (C3) -----------------------------------

  const loadArticle = (ctx: Ctx, id: number): articles.ArticleRow => {
    const row = articles.getArticle(db, id);
    if (!row) throw notFound("文章不存在");
    // Re-derive the account from the row itself (never trust the URL) — C2 loadJob pattern.
    assertAccountAccess(ctx.auth, row.account_id);
    return row;
  };

  /** Engine cover path for an article's account/date (config may be broken → null). */
  const coverPathFor = (accountId: number, date: string): string | null => {
    const acc = getAccountById(db, accountId);
    if (!acc) return null;
    try {
      return path.join(loadConfig(acc.alias).paths.imgs, date, "cover.png");
    } catch {
      return null;
    }
  };

  router.add("GET", "/api/accounts/:id/articles", (ctx) => {
    const id = intParam(ctx);
    if (!getAccountById(db, id)) throw notFound("账号不存在");
    assertAccountAccess(ctx.auth, id);
    const date = ctx.url.searchParams.get("date") ?? undefined;
    const limit = Number(ctx.url.searchParams.get("limit") ?? 100) || 100;
    const rows = articles.listArticles(db, id, { date, limit });
    return ok({ articles: rows.map((r) => articleView(r, articles.listDrafts(db, r.id)[0])) });
  });

  router.add("GET", "/api/articles/:id", (ctx) => {
    const row = loadArticle(ctx, intParam(ctx));
    const latest = articles.listDrafts(db, row.id)[0];
    const versions = articles.listVersions(db, row).map((v) => articleView(v, articles.listDrafts(db, v.id)[0]));
    const drafts = articles.listDrafts(db, row.id).map(draftView);

    let content: string | null = null;
    if (row.file_path && fs.existsSync(row.file_path)) {
      try {
        content = fs.readFileSync(row.file_path, "utf8");
      } catch {
        content = null;
      }
    }
    const cover = coverPathFor(row.account_id, row.date);
    return ok({
      article: articleView(row, latest),
      content,
      coverPath: cover,
      coverUrl: cover && fs.existsSync(cover) ? `/api/articles/${row.id}/cover` : null,
      versions,
      drafts,
    });
  });

  router.add("GET", "/api/articles/:id/cover", (ctx) => {
    const row = loadArticle(ctx, intParam(ctx));
    const cover = coverPathFor(row.account_id, row.date);
    if (!cover || !fs.existsSync(cover)) throw notFound("封面不存在");
    const bytes = fs.readFileSync(cover);
    return new Response(bytes, {
      headers: { "content-type": "image/png", "cache-control": "private, max-age=60" },
    });
  });

  router.add("POST", "/api/articles/:id/regenerate", async (ctx) => {
    const row = loadArticle(ctx, intParam(ctx));
    const body = await readJson(ctx.req);
    const feedback = typeof body.feedback === "string" ? body.feedback.trim().slice(0, 8000) : "";
    const jobId = queue.enqueue(
      db,
      row.account_id,
      "regenerate",
      { date: row.date, articleId: row.id, feedback },
      { createdBy: ctx.auth!.user.id, actor: ctx.auth!.user.username },
    );
    recordAudit(db, {
      userId: ctx.auth!.user.id,
      actor: ctx.auth!.user.username,
      action: "article.regenerate",
      target: `article:${row.id}`,
      detail: { date: row.date, version: row.version, feedbackChars: feedback.length },
      ok: true,
    });
    return ok({ job: jobView(queue.getJob(db, jobId)!) }, 201);
  });

  router.add("POST", "/api/accounts/:id/articles/generate", async (ctx) => {
    const id = intParam(ctx);
    if (!getAccountById(db, id)) throw notFound("账号不存在");
    assertAccountAccess(ctx.auth, id);
    const body = await readJson(ctx.req);
    const date = typeof body.date === "string" ? body.date : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest("date 需为 YYYY-MM-DD");
    const jobId = queue.enqueue(db, id, "generate", { date }, {
      createdBy: ctx.auth!.user.id,
      actor: ctx.auth!.user.username,
    });
    return ok({ job: jobView(queue.getJob(db, jobId)!) }, 201);
  });

  router.add("GET", "/api/jobs/:id/stream", (ctx) => {
    const job = loadJob(ctx, intParam(ctx));
    const qp = ctx.url.searchParams.get("last_event_id");
    const header = ctx.req.headers.get("last-event-id");
    const lastEventId = Number(qp ?? header ?? 0);
    const stream = streamJobEvents(db, job.id, Number.isFinite(lastEventId) ? lastEventId : 0);
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  });

  // ---- chat sessions (C4, human-in-the-loop) -------------------------------

  router.add("GET", "/api/accounts/:id/chats", (ctx) => {
    const manager = requireChat();
    const accountId = intParam(ctx);
    if (!getAccountById(db, accountId)) throw notFound("账号不存在");
    assertAccountAccess(ctx.auth, accountId);
    return ok({ chats: manager.listSessions(accountId) });
  });

  router.add("POST", "/api/accounts/:id/chats", async (ctx) => {
    const manager = requireChat();
    const accountId = intParam(ctx);
    if (!getAccountById(db, accountId)) throw notFound("账号不存在");
    assertAccountAccess(ctx.auth, accountId);
    const body = await readJson(ctx.req);
    const title = typeof body.title === "string" ? body.title.trim().slice(0, 120) : "";
    const created = manager.createSession(accountId, { title: title || undefined, actor: chatActor(ctx) });
    return ok({ chat: created }, 201);
  });

  router.add("GET", "/api/chats/:id", (ctx) => {
    const manager = requireChat();
    const row = loadChat(manager, ctx);
    return ok(manager.detail(row.id));
  });

  router.add("DELETE", "/api/chats/:id", async (ctx) => {
    const manager = requireChat();
    const row = loadChat(manager, ctx);
    await manager.deleteSession(row.id, chatActor(ctx));
    return ok({ deleted: true, id: row.id });
  });

  router.add("POST", "/api/chats/:id/messages", async (ctx) => {
    const manager = requireChat();
    const row = loadChat(manager, ctx);
    const body = await readJson(ctx.req);
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) throw badRequest("message 不能为空");
    if (message.length > 20_000) throw badRequest("message 过长（上限 20000 字符）");
    const result = await manager.prompt(row, message, chatActor(ctx));
    return ok({ disposition: result.disposition, busy: result.busy });
  });

  router.add("POST", "/api/chats/:id/steer", async (ctx) => {
    const manager = requireChat();
    const row = loadChat(manager, ctx);
    const body = await readJson(ctx.req);
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) throw badRequest("message 不能为空");
    const result = await manager.steer(row, message, chatActor(ctx));
    return ok({ disposition: result.disposition });
  });

  router.add("POST", "/api/chats/:id/follow-up", async (ctx) => {
    const manager = requireChat();
    const row = loadChat(manager, ctx);
    const body = await readJson(ctx.req);
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) throw badRequest("message 不能为空");
    const result = await manager.followUp(row, message, chatActor(ctx));
    return ok({ disposition: result.disposition });
  });

  router.add("POST", "/api/chats/:id/abort", async (ctx) => {
    const manager = requireChat();
    const row = loadChat(manager, ctx);
    await manager.abort(row, chatActor(ctx));
    return ok({ aborted: true });
  });

  router.add("POST", "/api/chats/:id/model", async (ctx) => {
    const manager = requireChat();
    const row = loadChat(manager, ctx);
    const body = await readJson(ctx.req);
    const provider = typeof body.provider === "string" ? body.provider.trim() : "";
    const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
    if (!provider || !modelId) throw badRequest("provider 与 modelId 必填");
    const model = await manager.setModel(row, provider, modelId, chatActor(ctx));
    return ok({ model });
  });

  router.add("POST", "/api/chats/:id/fork", async (ctx) => {
    const manager = requireChat();
    const row = loadChat(manager, ctx);
    const body = await readJson(ctx.req);
    const entryId = typeof body.entryId === "string" ? body.entryId.trim() : "";
    if (!entryId) throw badRequest("entryId 必填");
    const result = await manager.fork(row, entryId, chatActor(ctx));
    return ok(result);
  });

  router.add("POST", "/api/chats/:id/clone", async (ctx) => {
    const manager = requireChat();
    const row = loadChat(manager, ctx);
    const result = await manager.clone(row, chatActor(ctx));
    return ok(result);
  });

  router.add("GET", "/api/chats/:id/stream", (ctx) => {
    const manager = requireChat();
    const row = loadChat(manager, ctx);
    const qp = ctx.url.searchParams.get("last_event_id");
    const header = ctx.req.headers.get("last-event-id");
    const parsed = Number(qp ?? header ?? 0);
    const lastEventId = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    // Lazy spawn (D1) so events are ready before the first prompt; a spawn
    // failure (e.g. concurrency cap) must not fail the stream itself.
    void manager.ensureSpawn(row).catch(() => {});
    const stream = streamChatEvents(manager.bus, row.id, lastEventId, { signal: ctx.req.signal });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  });

  router.add("POST", "/api/decisions/:id", async (ctx) => {
    const manager = requireChat();
    const id = intParam(ctx);
    const decision = manager.getDecision(id);
    if (!decision) throw notFound("决策不存在");
    const chatRow = manager.getSession(decision.chat_session_id);
    if (!chatRow) throw notFound("会话不存在");
    assertAccountAccess(ctx.auth, chatRow.account_id);
    const body = await readJson(ctx.req);
    const input: { value?: string; confirmed?: boolean; cancelled?: boolean } = {};
    if (body.cancelled === true) {
      input.cancelled = true;
    } else if (decision.method === "confirm") {
      input.confirmed = body.confirmed === true;
    } else if (decision.method === "select") {
      if (typeof body.value !== "string" || !body.value) throw badRequest("value 必填");
      const options = parseOptions(decision.options_json);
      if (options.length > 0 && !options.includes(body.value)) throw badRequest("value 不在 options 中");
      input.value = body.value;
    } else {
      if (typeof body.value !== "string") throw badRequest("value 需为字符串");
      input.value = body.value.slice(0, 20_000);
    }
    const view = manager.answerDecision(id, input, chatActor(ctx));
    return ok({ decision: view });
  });

  router.add("GET", "/api/decisions", (ctx) => {
    const manager = requireChat();
    const status = ctx.url.searchParams.get("status") ?? undefined;
    const allowed = ["pending", "answered", "cancelled", "expired", "lost"] as const;
    if (status && !allowed.includes(status as (typeof allowed)[number])) throw badRequest("status 非法");
    const vis = visibleAccountIds(db, ctx.auth!);
    const decisions = manager.listDecisions({
      status: status as (typeof allowed)[number] | undefined,
      accountIds: vis === "all" ? undefined : vis,
      limit: 100,
    });
    return ok({ decisions });
  });

  // ---- global settings -----------------------------------------------------

  router.add("GET", "/api/settings", (ctx) => {
    assertAdmin(ctx.auth);
    const global = getGlobalRaw(db);
    return ok({ global, keys: Object.keys(global).sort(), cdpSuggestions: suggestCdpPorts(db, 9222, 5) });
  });

  router.add("PUT", "/api/settings", async (ctx) => {
    assertAdmin(ctx.auth);
    const body = await readJson(ctx.req);
    const incoming = isPlainObject(body.global) ? (body.global as JsonObject) : undefined;
    if (!incoming) throw badRequest("缺少 global 对象");
    if ("accounts" in incoming) throw badRequest("global 中不允许出现 accounts，请在账号页维护");
    const merged: JsonObject = { ...getGlobalRaw(db), ...incoming };
    setGlobalRaw(db, merged);
    syncConfigFile(db);
    recordAudit(db, { actor: ctx.auth.user.username, action: "settings.update", target: "global", ok: true });
    return ok({ global: getGlobalRaw(db) });
  });

  // ---- users (admin) -------------------------------------------------------

  router.add("GET", "/api/users", (ctx) => {
    assertAdmin(ctx.auth);
    return ok({
      users: users.listUsers(db).map((u) => ({ ...users.toPublic(u), accounts: accountIdsForUser(db, u.id) })),
    });
  });

  router.add("POST", "/api/users", async (ctx) => {
    assertAdmin(ctx.auth);
    const body = await readJson(ctx.req);
    const username = typeof body.username === "string" ? body.username : "";
    const password = typeof body.password === "string" ? body.password : "";
    const role = body.role === undefined ? "owner" : body.role;
    users.validateRole(role);
    assertAccountIds(db, body.accountIds);
    const id = await users.createUser(db, username, password, role);
    if (Array.isArray(body.accountIds)) {
      setGrants(db, id, body.accountIds.filter((n): n is number => Number.isInteger(n)));
    }
    recordAudit(db, { actor: ctx.auth.user.username, action: "user.create", target: username, ok: true, detail: role });
    return ok({ ...users.toPublic(users.getUserById(db, id)!), accounts: accountIdsForUser(db, id) }, 201);
  });

  router.add("PUT", "/api/users/:id", async (ctx) => {
    assertAdmin(ctx.auth);
    const id = intParam(ctx);
    const target = users.getUserById(db, id);
    if (!target) throw notFound("用户不存在");
    const body = await readJson(ctx.req);

    const wantsDemote = body.role !== undefined && body.role !== "admin";
    const wantsDisable = body.disabled === true;
    if (target.role === "admin" && (wantsDemote || wantsDisable) && users.countAdmins(db) <= 1) {
      throw conflict("不能停用或降级最后一个管理员");
    }

    if (body.role !== undefined) users.setRole(db, id, body.role as users.Role);
    if (body.disabled !== undefined) {
      users.setDisabled(db, id, body.disabled === true);
      if (body.disabled === true) sess.destroyUserSessions(db, id);
    }
    if (typeof body.password === "string" && body.password.length > 0) {
      await users.setPassword(db, id, body.password);
      sess.destroyUserSessions(db, id);
    }
    assertAccountIds(db, body.accountIds);
    if (Array.isArray(body.accountIds)) {
      setGrants(db, id, body.accountIds.filter((n): n is number => Number.isInteger(n)));
    }

    recordAudit(db, { actor: ctx.auth.user.username, action: "user.update", target: target.username, ok: true });
    const updated = users.getUserById(db, id)!;
    return ok({ ...users.toPublic(updated), accounts: accountIdsForUser(db, id), grants: grantRowsForUser(db, id) });
  });

  // ---- audit + meta --------------------------------------------------------

  router.add("GET", "/api/audit", (ctx) => {
    assertAdmin(ctx.auth);
    const limit = Math.min(Number(ctx.url.searchParams.get("limit") ?? 100) || 100, 500);
    return ok({ entries: recentAudit(db, limit) });
  });

  router.add("GET", "/api/meta", (ctx) => {
    return ok({
      version: state.version,
      startedAt: new Date(state.startedAt).toISOString(),
      uptimeSec: Math.floor((Date.now() - state.startedAt) / 1000),
      cdpSuggestions: suggestCdpPorts(db, 9222, 5),
      routes: router.list(),
    });
  });

  // ---- dispatch ------------------------------------------------------------

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const pathname = url.pathname;
    const method = req.method.toUpperCase();

    if (pathname === "/health") {
      return ok({ status: "ok", version: state.version, uptimeSec: Math.floor((Date.now() - state.startedAt) / 1000) });
    }

    if (!pathname.startsWith("/api/")) {
      if (method !== "GET" && method !== "HEAD") return fail(405, "method_not_allowed", "仅支持 GET");
      return serveUi(pathname);
    }

    const token = sess.parseCookie(req.headers.get("cookie"), sess.SESSION_COOKIE);
    const session = sess.lookupSession(db, token);
    try {
      const isLogin = pathname === "/api/login";

      if (!isLogin && !session) throw unauthorized("未登录");
      if (!isLogin && method !== "GET" && method !== "HEAD" && !sess.csrfEqual(session!.csrfToken, req.headers.get("x-csrf-token"))) {
        throw forbidden("CSRF 校验失败");
      }

      const ctx: Ctx = { req, url, params: {}, state, session, auth: session ? authContextOf(session) : null };
      const allowed: string[] = [];
      const m = router.match(method, pathname, allowed);
      if (!m) {
        if (allowed.length) throw new HttpError(405, "method_not_allowed", `仅支持 ${allowed.join(", ")}`);
        throw notFound("接口不存在");
      }
      ctx.params = m.params;
      return await m.handler(ctx);
    } catch (err) {
      // Attribute a 403 denial to *this* request's session (kept request-local so
      // concurrent requests can never cross-attribute the audit `actor`).
      if (err instanceof HttpError && err.status === 403) {
        recordAudit(db, {
          userId: session?.user.id,
          actor: session?.user.username ?? "unknown",
          action: "denied",
          target: `${method} ${pathname}`,
          ok: false,
          ip: clientIp(req),
          detail: err.message,
        });
      }
      throw err;
    }
  }

  async function handle(req: Request): Promise<Response> {
    try {
      return securityHeaders(await route(req), state.secureCookies);
    } catch (err) {
      if (err instanceof HttpError) {
        return securityHeaders(fail(err.status, err.code, err.message, err.detail), state.secureCookies);
      }
      console.error("[console]", err);
      return securityHeaders(fail(500, "internal", (err as Error).message), state.secureCookies);
    }
  }

  return { router, handle };
}

function self(ctx: Ctx): string {
  return ctx.auth?.user.username ?? "unknown";
}
