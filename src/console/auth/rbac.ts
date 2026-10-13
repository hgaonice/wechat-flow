/** Central RBAC decision point. Handlers must not re-implement these rules. */
import type { UserRow } from "./users.ts";
import { forbidden, unauthorized } from "../http/respond.ts";
import type { SessionContext } from "./sessions.ts";
import { getAccountById } from "../db/dao/accounts.ts";
import type { Database } from "bun:sqlite";

export interface AuthContext {
  user: UserRow;
  grantedAccounts: number[] | "all";
}

export function authContextOf(session: SessionContext): AuthContext {
  return { user: session.user, grantedAccounts: session.grantedAccounts };
}

export function isAdmin(ctx: AuthContext): boolean {
  return ctx.user.role === "admin";
}

export function assertAdmin(ctx: AuthContext | null): asserts ctx is AuthContext {
  if (!ctx) throw unauthorized();
  if (ctx.user.role !== "admin") throw forbidden("需要管理员权限");
}

export function canAccessAccount(ctx: AuthContext, accountId: number): boolean {
  if (ctx.grantedAccounts === "all") return true;
  return ctx.grantedAccounts.includes(accountId);
}

/** Throws 403 when the owner has no grant for this account. */
export function assertAccountAccess(ctx: AuthContext | null, accountId: number): asserts ctx is AuthContext {
  if (!ctx) throw unauthorized();
  if (!canAccessAccount(ctx, accountId)) throw forbidden("无权访问该账号");
}

/** Convenience: resolve `:id` and enforce access in one call. */
export function assertAccountAccessById(db: Database, ctx: AuthContext | null, accountId: number): void {
  if (!getAccountById(db, accountId)) throw forbidden("账号不存在或无权访问");
  assertAccountAccess(ctx, accountId);
}

/** Account ids the context may see (admins get everything). */
export function visibleAccountIds(db: Database, ctx: AuthContext): number[] | "all" {
  if (ctx.grantedAccounts === "all") return "all";
  return ctx.grantedAccounts;
}
