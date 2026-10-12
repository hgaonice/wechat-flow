import fs from "node:fs";
import path from "node:path";

export interface PublishedRecord {
  date: string;
  week?: string;
  topic: string;
  title: string;
  file: string;
  mediaId?: string;
  account: string;
  publishedAt: string;
  ok: boolean;
  error?: string;
}

export interface StateFile {
  published: Record<string, PublishedRecord>; // key = date (YYYY-MM-DD)
}

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function atomicWriteJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

export function loadState(stateDir: string): StateFile {
  const file = path.join(stateDir, "published.json");
  const s = readJson<StateFile>(file, { published: {} });
  if (!s.published) s.published = {};
  return s;
}

export function saveState(stateDir: string, state: StateFile): void {
  atomicWriteJson(path.join(stateDir, "published.json"), state);
}

export function isPublished(stateDir: string, date: string): PublishedRecord | undefined {
  return loadState(stateDir).published[date];
}

export function recordPublished(stateDir: string, rec: PublishedRecord): void {
  const s = loadState(stateDir);
  s.published[rec.date] = rec;
  saveState(stateDir, s);
}
