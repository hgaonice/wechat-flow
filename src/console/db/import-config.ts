/**
 * One-time import: existing `config.json` → DB (`settings` + `accounts`).
 *
 * Keeps the pre-console file as `config.json.bak` (only if not already present)
 * so AC-3 can always be re-verified against the true original.
 */
import fs from "node:fs";
import type { Database } from "bun:sqlite";
import { CONFIG_PATH } from "../../config.ts";
import { asObject, isPlainObject, type Json, type JsonObject } from "../types.ts";
import { setGlobalRaw } from "./dao/settings.ts";
import { getAccountByAlias, insertAccount, updateAccount } from "./dao/accounts.ts";

export interface ImportResult {
  configPath: string;
  backupPath: string | null;
  defaultAccount: string;
  accounts: { alias: string; created: boolean }[];
}

interface Entry {
  alias: string;
  entry: JsonObject;
}

/** Accept map form, list form, or a legacy single-account layout. */
function entriesFromRaw(raw: JsonObject): Entry[] {
  const accountsRaw = raw.accounts;
  const out: Entry[] = [];

  if (isPlainObject(accountsRaw)) {
    for (const [alias, v] of Object.entries(accountsRaw)) {
      if (!alias) continue;
      const entry = asObject(v);
      delete entry.alias; // engine re-adds the map key
      out.push({ alias, entry });
    }
  } else if (Array.isArray(accountsRaw)) {
    for (const item of accountsRaw as Json[]) {
      const entry = asObject(item);
      const alias = typeof entry.alias === "string" ? entry.alias : "";
      if (!alias) continue;
      delete entry.alias;
      out.push({ alias, entry });
    }
  }

  if (out.length === 0) {
    const alias = typeof raw.account === "string" && raw.account.length > 0 ? raw.account : "second";
    const entry: JsonObject = {};
    if (raw.accountName !== undefined) entry.displayName = raw.accountName;
    if (raw.author !== undefined) entry.author = raw.author;
    if (raw.theme !== undefined) entry.theme = raw.theme;
    if (raw.color !== undefined) entry.color = raw.color;
    out.push({ alias, entry });
  }
  return out;
}

export function importConfig(db: Database, configPath = CONFIG_PATH): ImportResult {
  if (!fs.existsSync(configPath)) {
    throw new Error(`config.json not found: ${configPath} (nothing to import)`);
  }
  let raw: JsonObject;
  try {
    raw = asObject(JSON.parse(fs.readFileSync(configPath, "utf8")));
  } catch (err) {
    throw new Error(`${configPath} is not valid JSON: ${(err as Error).message}`);
  }

  const entries = entriesFromRaw(raw);
  const defaultAccount =
    (typeof raw.defaultAccount === "string" && raw.defaultAccount.length > 0 && raw.defaultAccount) ||
    (typeof raw.account === "string" && raw.account.length > 0 && raw.account) ||
    entries[0]!.alias;

  // global = everything except the accounts block, plus a normalized defaultAccount
  const global: JsonObject = { ...raw };
  delete global.accounts;
  global.defaultAccount = defaultAccount;

  // Preserve the true original exactly once.
  const backupPath = configPath + ".bak";
  let backedUp: string | null = null;
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(configPath, backupPath);
    backedUp = backupPath;
  }

  const results: { alias: string; created: boolean }[] = [];
  const tx = db.transaction(() => {
    setGlobalRaw(db, global);
    for (const { alias, entry } of entries) {
      const existing = getAccountByAlias(db, alias);
      if (existing) {
        updateAccount(db, existing.id, alias, entry);
        results.push({ alias, created: false });
      } else {
        insertAccount(db, alias, entry);
        results.push({ alias, created: true });
      }
    }
  });
  tx();

  return { configPath, backupPath: backedUp, defaultAccount, accounts: results };
}
