/** DB connection + forward-only migration runner (see spec/console/data-model.md §4). */
import { Database } from "bun:sqlite";
import { MIGRATIONS } from "./schema.ts";

/** Open (creating if needed) the console DB with the pragmas the spec requires. */
export function openDb(filename: string): Database {
  const db = new Database(filename, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}

/** Current schema version recorded in the DB. */
export function schemaVersion(db: Database): number {
  const row = db.query<{ user_version: number }>("PRAGMA user_version").get();
  return row?.user_version ?? 0;
}

/**
 * Apply every pending migration in order. Each migration runs in its own
 * transaction so a failure leaves the previous version intact and the process
 * aborts loudly instead of half-applying (spec §4).
 */
export function migrate(db: Database): number {
  let current = schemaVersion(db);
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    const apply = db.transaction(() => {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
    });
    try {
      apply();
    } catch (err) {
      throw new Error(`migration v${m.version} (${m.name}) failed: ${(err as Error).message}`);
    }
    current = m.version;
  }
  return current;
}
