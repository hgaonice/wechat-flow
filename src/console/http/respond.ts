/** Uniform HTTP responses + the single error type handlers throw (spec/console/api.md §1). */

export interface ErrorBody {
  ok: false;
  code: string;
  message: string;
  detail?: unknown;
}

/** Thrown by handlers; `server.ts` turns it into the error envelope. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail?: unknown;

  constructor(status: number, code: string, message: string, detail?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export const badRequest = (message: string, detail?: unknown) => new HttpError(400, "bad_request", message, detail);
export const unauthorized = (message = "未登录") => new HttpError(401, "unauthorized", message);
export const forbidden = (message = "无权访问该资源", detail?: unknown) => new HttpError(403, "forbidden", message, detail);
export const notFound = (message = "资源不存在") => new HttpError(404, "not_found", message);
export const conflict = (message: string, detail?: unknown) => new HttpError(409, "conflict", message, detail);
export const tooMany = (message = "请求过于频繁", detail?: unknown) => new HttpError(429, "rate_limited", message, detail);

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

/** Success envelope: `{ ok: true, data }`. */
export function ok(data: unknown = null, status = 200, headers: Record<string, string> = {}): Response {
  return json({ ok: true, data }, status, headers);
}

/** Error envelope: `{ ok: false, code, message, detail? }`. */
export function fail(status: number, code: string, message: string, detail?: unknown): Response {
  const body: ErrorBody = { ok: false, code, message, ...(detail !== undefined ? { detail } : {}) };
  return json(body, status);
}

export function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

export function text(body: string, status = 200, contentType = "text/plain; charset=utf-8"): Response {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

export function redirect(location: string, status = 303): Response {
  return new Response(null, { status, headers: { location } });
}
