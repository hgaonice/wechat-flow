/** Static UI serving from `src/console/ui` (no bundler, no dependencies). */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ui");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

/** Friendly routes → files. */
const ROUTES: Record<string, string> = {
  "/": "login.html",
  "/login": "login.html",
  "/index.html": "login.html",
  "/app": "index.html",
  "/account": "account.html",
  "/settings": "settings.html",
  "/workbench": "workbench.html",
};

export function serveUi(pathname: string): Response {
  const rel = ROUTES[pathname] ?? pathname.replace(/^\/+/, "");
  if (!rel || rel.includes("..") || rel.startsWith("/")) return notFoundResponse();

  const file = path.join(UI_DIR, rel);
  if (!file.startsWith(UI_DIR)) return notFoundResponse(); // defense in depth
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return notFoundResponse();

  const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  return new Response(fs.readFileSync(file), { headers: { "content-type": type } });
}

function notFoundResponse(): Response {
  return new Response("Not Found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
}
