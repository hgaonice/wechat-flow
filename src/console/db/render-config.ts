/**
 * Render the DB back to `config.json` (the engine still reads the file).
 * Atomic write (tmp + fsync + rename); the pre-console original is preserved
 * as `config.json.bak` and never clobbered.
 */
import fs from "node:fs";
import type { Database } from "bun:sqlite";
import { CONFIG_PATH } from "../../config.ts";
import { renderConfigObject } from "../config/resolve.ts";

export interface RenderResult {
  configPath: string;
  backupPath: string | null;
  bytes: number;
}

export function renderConfig(db: Database, configPath = CONFIG_PATH): RenderResult {
  const text = JSON.stringify(renderConfigObject(db), null, 2) + "\n";

  const backupPath = configPath + ".bak";
  let backedUp: string | null = null;
  if (fs.existsSync(configPath) && !fs.existsSync(backupPath)) {
    fs.copyFileSync(configPath, backupPath);
    backedUp = backupPath;
  }

  const tmp = `${configPath}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, configPath);

  return { configPath, backupPath: backedUp, bytes: Buffer.byteLength(text) };
}
