/** Users: CRUD + argon2id password hashing (Bun.password). */
import type { Database } from "bun:sqlite";
import { badRequest } from "../http/respond.ts";

export type Role = "admin" | "owner";
export const ROLES: Role[] = ["admin", "owner"];
export const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
export const MIN_PASSWORD_LEN = 8;

export interface UserRow {
  id: number;
  username: string;
  pass_hash: string;
  role: Role;
  disabled: number;
  created_at: string;
  updated_at: string;
}

export interface PublicUser {
  id: number;
  username: string;
  role: Role;
  disabled: boolean;
  createdAt: string;
}

export function toPublic(u: UserRow): PublicUser {
  return { id: u.id, username: u.username, role: u.role, disabled: u.disabled !== 0, createdAt: u.created_at };
}

export function listUsers(db: Database): UserRow[] {
  return db.query<UserRow>("SELECT * FROM users ORDER BY id").all();
}

export function countUsers(db: Database): number {
  return db.query<{ n: number }>("SELECT COUNT(*) AS n FROM users").get()?.n ?? 0;
}

export function countAdmins(db: Database): number {
  return db.query<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get()?.n ?? 0;
}

export function getUserById(db: Database, id: number): UserRow | undefined {
  return db.query<UserRow>("SELECT * FROM users WHERE id = ?").get(id);
}

export function getUserByUsername(db: Database, username: string): UserRow | undefined {
  return db.query<UserRow>("SELECT * FROM users WHERE username = ?").get(username);
}

export function validateUsername(username: unknown): asserts username is string {
  if (typeof username !== "string" || !USERNAME_RE.test(username)) {
    throw badRequest("用户名需为 3–32 位字母、数字、下划线、点或连字符");
  }
}

export function validatePassword(password: unknown): asserts password is string {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LEN) {
    throw badRequest(`密码至少 ${MIN_PASSWORD_LEN} 位`);
  }
}

export function validateRole(role: unknown): asserts role is Role {
  if (role !== "admin" && role !== "owner") throw badRequest("role 必须是 admin 或 owner");
}

export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

export async function createUser(db: Database, username: string, password: string, role: Role): Promise<number> {
  validateUsername(username);
  validatePassword(password);
  validateRole(role);
  if (getUserByUsername(db, username)) throw badRequest(`用户名已存在：${username}`);
  const hash = await hashPassword(password);
  const info = db.run("INSERT INTO users(username, pass_hash, role) VALUES (?, ?, ?)", username, hash, role);
  return Number(info.lastInsertRowid);
}

export async function setPassword(db: Database, id: number, password: string): Promise<void> {
  validatePassword(password);
  db.run("UPDATE users SET pass_hash = ?, updated_at = datetime('now') WHERE id = ?", await hashPassword(password), id);
}

/** Verify a password against the stored hash; never throws on a bad hash. */
export async function verifyPassword(user: UserRow, password: string): Promise<boolean> {
  if (typeof password !== "string" || password.length === 0) return false;
  try {
    return await Bun.password.verify(password, user.pass_hash);
  } catch {
    return false;
  }
}

export function setRole(db: Database, id: number, role: Role): void {
  validateRole(role);
  db.run("UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?", role, id);
}

export function setDisabled(db: Database, id: number, disabled: boolean): void {
  db.run("UPDATE users SET disabled = ?, updated_at = datetime('now') WHERE id = ?", disabled ? 1 : 0, id);
}
