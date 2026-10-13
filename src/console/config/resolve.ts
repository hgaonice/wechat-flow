/**
 * Config resolution helpers: DB ↔ `config.json`.
 *
 * IMPORTANT — semantics mirror the engine exactly:
 * `src/config.ts#resolveConfig` reads each account field as `acct[k] ?? raw[k]`
 * (per *top-level* key, with `null` behaving like absent). Therefore:
 *   - `buildRawConfig` stores account entries **verbatim** and lets the engine
 *     do its own fallback → DB-derived and file-derived configs are identical (AC-3);
 *   - `effectiveAccount` reproduces that same shallow fallback for UI display.
 * A deep merge would be WRONG here: the engine treats a present `math` object as
 * the whole value and never falls back per nested leaf.
 */
import type { Database } from "bun:sqlite";
import { jsonEqual, type JsonObject } from "../types.ts";
import { getGlobalRaw } from "../db/dao/settings.ts";
import { getAccountByAlias, listAccountRows, parseOverrides } from "../db/dao/accounts.ts";

export type Source = "inherited" | "overridden" | "explicit";

/** Raw config object consumed by engine `resolveConfig()`. */
export function buildRawConfig(db: Database): JsonObject {
  const global = getGlobalRaw(db);
  const accounts: JsonObject = {};
  for (const row of listAccountRows(db)) accounts[row.alias] = { ...parseOverrides(row) };
  return { ...global, accounts };
}

/** The object written back to `config.json` (identical shape to buildRawConfig). */
export function renderConfigObject(db: Database): JsonObject {
  return buildRawConfig(db);
}

/** Explicit entry for one alias, or `{}` when unknown. */
export function accountEntry(db: Database, alias: string): JsonObject {
  const row = getAccountByAlias(db, alias);
  return row ? parseOverrides(row) : {};
}

/**
 * Effective per-account config for display: start from global defaults and let
 * non-null entry values win — the same precedence the engine uses.
 */
export function effectiveAccount(global: JsonObject, entry: JsonObject): JsonObject {
  const out: JsonObject = { ...global };
  for (const [k, v] of Object.entries(entry)) {
    if (v === null || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

/** Explicit (non-null) keys in an entry = the account's overrides. */
export function overrideKeys(entry: JsonObject): string[] {
  return Object.keys(entry).filter((k) => entry[k] !== null && entry[k] !== undefined).sort();
}

export function keySource(global: JsonObject, entry: JsonObject, key: string): Source {
  const e = entry[key];
  if (e === undefined || e === null) return "inherited";
  return jsonEqual(e, global[key]) ? "explicit" : "overridden";
}

/** Remove one top-level override so the key falls back to the global default. */
export function removeOverride(entry: JsonObject, key: string): JsonObject {
  const out: JsonObject = { ...entry };
  delete out[key];
  return out;
}
