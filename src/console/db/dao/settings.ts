/**
 * Global config (`settings` key = 'global') storage.
 *
 * Holds the original `config.json` *minus* `accounts`, i.e. every top-level
 * default plus `defaultAccount`. Accounts live in their own table.
 */
import type { Database } from "bun:sqlite";
import { asObject, type Json, type JsonObject } from "../../types.ts";

export const GLOBAL_KEY = "global";

export function getSetting(db: Database, key: string): Json | undefined {
  const row = db.query<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?").get(key);
  if (!row) return undefined;
  try {
    return JSON.parse(row.value_json) as Json;
  } catch {
    return undefined;
  }
}

export function setSetting(db: Database, key: string, value: Json): void {
  db.run(
    `INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = datetime('now')`,
    key,
    JSON.stringify(value),
  );
}

export function delSetting(db: Database, key: string): void {
  db.run("DELETE FROM settings WHERE key = ?", key);
}

/** Global defaults as a plain object (empty when unset). */
export function getGlobalRaw(db: Database): JsonObject {
  return asObject(getSetting(db, GLOBAL_KEY));
}

export function setGlobalRaw(db: Database, value: JsonObject): void {
  setSetting(db, GLOBAL_KEY, value);
}
