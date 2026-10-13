/**
 * Tiny dependency-free router. Patterns are literal segments plus `:name`
 * captures, e.g. `/api/accounts/:id/reset-override`.
 */

export type Handler<Ctx> = (ctx: Ctx) => Response | Promise<Response>;

export interface Match<Ctx> {
  handler: Handler<Ctx>;
  params: Record<string, string>;
}

interface Route<Ctx> {
  method: string;
  segments: string[];
  pattern: string;
  handler: Handler<Ctx>;
}

export class Router<Ctx> {
  private routes: Route<Ctx>[] = [];

  add(method: string, pattern: string, handler: Handler<Ctx>): this {
    this.routes.push({
      method: method.toUpperCase(),
      segments: pattern.split("/").filter((s) => s.length > 0),
      pattern,
      handler,
    });
    return this;
  }

  get(pattern: string, handler: Handler<Ctx>): this {
    return this.add("GET", pattern, handler);
  }
  post(pattern: string, handler: Handler<Ctx>): this {
    return this.add("POST", pattern, handler);
  }
  put(pattern: string, handler: Handler<Ctx>): this {
    return this.add("PUT", pattern, handler);
  }
  delete(pattern: string, handler: Handler<Ctx>): this {
    return this.add("DELETE", pattern, handler);
  }

  /**
   * Match `method` + `pathname`. Returns null on no match; `allowed` collects
   * methods of same-path routes so the caller can answer 405 instead of 404.
   */
  match(method: string, pathname: string, allowed: string[] = []): Match<Ctx> | null {
    const parts = pathname.split("/").filter((s) => s.length > 0);
    const upper = method.toUpperCase();
    for (const route of this.routes) {
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < route.segments.length; i++) {
        const seg = route.segments[i]!;
        const part = parts[i]!;
        if (seg.startsWith(":")) params[seg.slice(1)] = safeDecode(part);
        else if (seg !== part) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;
      if (route.method === upper) return { handler: route.handler, params };
      if (!allowed.includes(route.method)) allowed.push(route.method);
    }
    return null;
  }

  /** All patterns, for diagnostics (`GET /api/routes` in dev). */
  list(): string[] {
    return this.routes.map((r) => `${r.method} ${r.pattern}`);
  }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
