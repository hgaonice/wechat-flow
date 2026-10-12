import fs from "node:fs";
import path from "node:path";

let logStream: fs.WriteStream | undefined;
let logFile: string | undefined;

function nowIso(): string {
  return new Date().toISOString();
}

export function initLog(dir: string, name: string): void {
  fs.mkdirSync(dir, { recursive: true });
  logFile = path.join(dir, `${name}.log`);
  logStream = fs.createWriteStream(logFile, { flags: "a" });
}

function emit(level: string, msg: string, extra?: unknown): void {
  const line = `[${nowIso()}] [${level}] ${msg}${extra === undefined ? "" : " " + safe(extra)}`;
  if (level === "ERROR") console.error(line);
  else console.log(line);
  logStream?.write(line + "\n");
}

function safe(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const log = {
  info: (m: string, e?: unknown) => emit("INFO", m, e),
  warn: (m: string, e?: unknown) => emit("WARN", m, e),
  error: (m: string, e?: unknown) => emit("ERROR", m, e),
  step: (m: string, e?: unknown) => emit("STEP", m, e),
  get file(): string | undefined {
    return logFile;
  },
  close(): void {
    logStream?.end();
    logStream = undefined;
  },
};
