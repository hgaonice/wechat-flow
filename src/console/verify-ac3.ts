/**
 * AC-3 verifier: prove that a DB-derived `AppConfig` is field-for-field equal to
 * the original `loadConfig()` output, and that re-rendering produces no
 * unintended `config.json` diff.
 *
 * Compares against `config.json.bak` (the pre-import original) when present.
 */
import fs from "node:fs";
import type { Database } from "bun:sqlite";
import { CONFIG_PATH, resolveConfig } from "../config.ts";
import { buildRawConfig, renderConfigObject } from "./config/resolve.ts";
import { listAccountRows } from "./db/dao/accounts.ts";
import { asObject, type JsonObject } from "./types.ts";

export interface AccountDiff {
  alias: string;
  ok: boolean;
  diffs: string[];
}

export interface Ac3Report {
  source: string;
  ok: boolean;
  accounts: AccountDiff[];
  renderDiff: string[];
  /** Diffs expected from normalizing a legacy config (accounts/defaultAccount). */
  renderDiffIgnored: string[];
}

function deepDiff(a: unknown, b: unknown, p = ""): string[] {
  if (a === b) return [];
  if (typeof a !== typeof b) return [`${p || "<root>"}: type ${typeof a} != ${typeof b}`];
  if (a === null || b === null) return [`${p || "<root>"}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`];
  if (typeof a === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    if (Array.isArray(a) !== Array.isArray(b)) return [`${p || "<root>"}: array/object mismatch`];
    if (Array.isArray(a) && Array.isArray(b)) {
      const out: string[] = [];
      const n = Math.max(a.length, b.length);
      for (let i = 0; i < n; i++) out.push(...deepDiff(a[i], b[i], `${p}[${i}]`));
      return out;
    }
    const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
    const out: string[] = [];
    for (const k of keys) out.push(...deepDiff(ao[k], bo[k], p ? `${p}.${k}` : k));
    return out;
  }
  return [`${p || "<root>"}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`];
}

/** Clone an account entry without its `alias` (added synthetically by the engine). */
function stripEntryAliases(raw: JsonObject): JsonObject {
  const accounts = asObject(raw.accounts);
  const cleaned: JsonObject = {};
  for (const [alias, v] of Object.entries(accounts)) {
    const entry = { ...asObject(v) };
    delete entry.alias;
    cleaned[alias] = entry;
  }
  return { ...raw, accounts: cleaned };
}

export function verifyAc3(db: Database, configPath = CONFIG_PATH): Ac3Report {
  const backup = configPath + ".bak";
  const source = fs.existsSync(backup) ? backup : configPath;
  if (!fs.existsSync(source)) throw new Error(`no config to compare (looked for ${backup} and ${configPath})`);

  const origRaw = asObject(JSON.parse(fs.readFileSync(source, "utf8")));
  const dbRaw = buildRawConfig(db);

  const aliases = Array.from(
    new Set([...Object.keys(asObject(origRaw.accounts)), ...listAccountRows(db).map((r) => r.alias)]),
  );

  const accounts: AccountDiff[] = [];
  for (const alias of aliases) {
    let diffs: string[];
    try {
      diffs = deepDiff(resolveConfig(origRaw, alias), resolveConfig(dbRaw, alias));
    } catch (err) {
      diffs = [`resolve failed: ${(err as Error).message}`];
    }
    accounts.push({ alias, ok: diffs.length === 0, diffs });
  }

  const allRenderDiff = deepDiff(stripEntryAliases(origRaw), stripEntryAliases(renderConfigObject(db)));
  const renderDiffIgnored: string[] = allRenderDiff.filter((d) => d === "accounts" || d === "defaultAccount");
  const renderDiff = allRenderDiff.filter((d) => !renderDiffIgnored.includes(d));

  return {
    source,
    ok: accounts.length > 0 && accounts.every((a) => a.ok) && renderDiff.length === 0,
    accounts,
    renderDiff,
    renderDiffIgnored,
  };
}

/** Human-readable report for `main.ts --verify-ac3`. */
export function formatAc3(report: Ac3Report): string {
  const lines: string[] = [];
  lines.push(`AC-3 校验源: ${report.source}`);
  for (const a of report.accounts) {
    lines.push(`${a.ok ? "✅" : "❌"} account ${a.alias} — ${a.ok ? "AppConfig 逐字段一致" : a.diffs.length + " 处差异"}`);
    for (const d of a.diffs.slice(0, 40)) lines.push(`     - ${d}`);
  }
  if (report.renderDiffIgnored.length) {
    lines.push(`ℹ️  预期归一化差异（忽略）: ${report.renderDiffIgnored.join(", ")}`);
  }
  if (report.renderDiff.length) {
    lines.push(`❌ 回渲染 diff ${report.renderDiff.length} 处:`);
    for (const d of report.renderDiff.slice(0, 40)) lines.push(`     - ${d}`);
  } else {
    lines.push("✅ 回渲染无意外 diff");
  }
  lines.push(report.ok ? "== AC-3 PASS ==" : "== AC-3 FAIL ==");
  return lines.join("\n");
}
