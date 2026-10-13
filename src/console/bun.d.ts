/**
 * Minimal ambient types for the Bun runtime APIs used by the console.
 *
 * Why hand-written instead of `bun-types` / `@types/bun`:
 *   - the engine keeps `dependencies` empty (AC-10) and this repo pins
 *     `compilerOptions.types = ["node"]`, so Bun types are not installed;
 *   - offline build environments cannot fetch a new devDependency.
 * Only the surface the console actually touches is declared. If `bun-types`
 * is ever adopted: delete this file and add "bun-types" to tsconfig `types`.
 */

declare module "bun:sqlite" {
  export type SQLQueryBindings = string | number | bigint | boolean | null | Uint8Array;

  export interface Statement<Row = any> {
    all(...params: SQLQueryBindings[]): Row[];
    get(...params: SQLQueryBindings[]): Row | undefined;
    run(...params: SQLQueryBindings[]): { changes: number; lastInsertRowid: number | bigint };
    values(...params: SQLQueryBindings[]): any[][];
    finalize(): void;
  }

  export interface DatabaseOptions {
    readonly?: boolean;
    create?: boolean;
    strict?: boolean;
  }

  export class Database {
    constructor(filename?: string, options?: DatabaseOptions | boolean);
    query<Row = any>(sql: string): Statement<Row>;
    prepare<Row = any>(sql: string): Statement<Row>;
    run(sql: string, ...params: SQLQueryBindings[]): { changes: number; lastInsertRowid: number | bigint };
    exec(sql: string): void;
    transaction<T extends (...args: any[]) => any>(fn: T): T;
    close(throwOnError?: boolean): void;
    serialize(): Uint8Array;
  }
}

interface BunServer {
  readonly port: number;
  readonly hostname: string;
  readonly url: URL;
  stop(closeActiveConnections?: boolean): void;
}

interface BunServeOptions {
  port?: number;
  hostname?: string;
  unix?: string;
  fetch(req: Request, server: BunServer): Response | Promise<Response>;
  error?(error: Error): Response | Promise<Response>;
  development?: boolean;
  idleTimeout?: number;
}

interface BunPasswordOptions {
  algorithm?: "argon2id" | "argon2i" | "argon2d" | "bcrypt" | "scrypt";
  memoryCost?: number;
  timeCost?: number;
}

interface BunPassword {
  hash(password: string, options?: BunPasswordOptions): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
}

declare const Bun: {
  serve(options: BunServeOptions): BunServer;
  readonly password: BunPassword;
  env: Record<string, string | undefined>;
  version: string;
  readonly main: string;
  sleep(ms: number): Promise<void>;
  spawn(cmd: string[], options?: any): any;
};
