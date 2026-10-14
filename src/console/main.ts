#!/usr/bin/env bun
/**
 * wechat-flow console entry point (C1).
 *
 * Subcommands (mutually exclusive, evaluated in order):
 *   --init-key                create ~/.wechat-console/master.key (0600)
 *   --import-config           import existing config.json into the DB
 *   --verify-ac3              prove DB-derived config == original loadConfig()
 *   --create-admin <name>     create/promote an admin (password via env or --password)
 *   --status                  print DB/schema/row counts
 *   (default)                 start the HTTP server
 *
 * Fail-fast: the server refuses to start without a master key and without any
 * user (see spec/console/security.md).
 */
import fs from "node:fs";
import path from "node:path";
import { APP_DIR } from "../config.ts";
import type { Database } from "bun:sqlite";
import { migrate, openDb, schemaVersion } from "./db/migrate.ts";
import { importConfig } from "./db/import-config.ts";
import { renderConfig } from "./db/render-config.ts";
import { formatAc3, verifyAc3 } from "./verify-ac3.ts";
import { initMasterKey, loadMasterKey } from "./crypto/secrets.ts";
import {
  countAdmins,
  countUsers,
  createUser,
  getUserByUsername,
  setPassword,
  setRole,
  setDisabled,
  validateRole,
  type Role,
} from "./auth/users.ts";
import { getGlobalRaw } from "./db/dao/settings.ts";
import { listAccountRows } from "./db/dao/accounts.ts";
import { createApp, type AppState } from "./server.ts";
import { startScheduler, type SchedulerHandle } from "./jobs/scheduler.ts";
import { startWorker, type WorkerHandle } from "./jobs/worker.ts";

const VERSION = "0.1.0";
const DB_PATH = process.env.CONSOLE_DB ?? path.join(APP_DIR, "console", "console.db");
const HOST = process.env.CONSOLE_HOST ?? "127.0.0.1";
const PORT = Number(process.env.CONSOLE_PORT ?? 8787);

function open(): Database {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = openDb(DB_PATH);
  migrate(db);
  return db;
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function openAt(): Database {
  return open();
}

async function cmdCreateAdmin(args: string[]): Promise<void> {
  const username = flagValue(args, "--create-admin");
  const password = process.env.CONSOLE_ADMIN_PASSWORD ?? flagValue(args, "--password");
  if (!username || username.startsWith("--")) {
    throw new Error("用法: --create-admin <username> [--password <pw>] 或设置 CONSOLE_ADMIN_PASSWORD");
  }
  if (!password) {
    throw new Error("缺少密码: 设置 CONSOLE_ADMIN_PASSWORD 或传 --password <pw>（不会写入代码/日志）");
  }
  const db = openAt();
  const role: Role = "admin";
  validateRole(role);

  const existing = getUserByUsername(db, username);
  if (existing) {
    await setPassword(db, existing.id, password);
    setRole(db, existing.id, role);
    setDisabled(db, existing.id, false);
    console.log(`已更新既有用户为管理员: ${username} (id=${existing.id})`);
  } else {
    const id = await createUser(db, username, password, role);
    console.log(`已创建管理员: ${username} (id=${id})`);
  }
  console.log(`用户总数=${countUsers(db)} 管理员数=${countAdmins(db)}`);
  db.close();
}

async function cmdServe(args: string[]): Promise<void> {
  const masterKey = loadMasterKey(); // fail-fast when missing/insecure
  const db = openAt();
  const userCount = countUsers(db);
  if (userCount === 0) {
    throw new Error("尚无任何用户：先运行 `bun src/console/main.ts --create-admin <name>`（拒绝默认口令启动）");
  }
  if (countAdmins(db) === 0) {
    throw new Error("没有管理员账号：先运行 --create-admin 提升一个管理员");
  }

  // Heal config.json from the DB on boot so a previously failed render can't wedge the engine.
  if (listAccountRows(db).length > 0) {
    try {
      renderConfig(db);
    } catch (err) {
      console.error("[console] startup config render failed:", (err as Error).message);
    }
  }

  const state: AppState = {
    db,
    version: VERSION,
    startedAt: Date.now(),
    secureCookies: process.env.CONSOLE_ALLOW_INSECURE_COOKIE !== "1",
    masterKey,
  };
  const app = createApp(state);
  const server = Bun.serve({
    port: PORT,
    hostname: HOST,
    fetch: (req) => app.handle(req),
    error: (err) => {
      console.error("[console] unhandled:", err);
      return new Response(JSON.stringify({ ok: false, code: "internal", message: err.message }), {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    },
  });
  console.log(`wechat-flow console v${VERSION} → http://${HOST}:${server.port}  (db=${DB_PATH})`);
  console.log(`secure cookies: ${state.secureCookies ? "on" : "off（CONSOLE_ALLOW_INSECURE_COOKIE=1）"}`);

  // C2: in-process scheduler + worker (disable with --no-worker).
  let scheduler: SchedulerHandle | null = null;
  let worker: WorkerHandle | null = null;
  if (!args.includes("--no-worker")) {
    scheduler = startScheduler(db, {
      onActions: (actions) => {
        for (const a of actions) console.log(`[scheduler] enqueue ${a.kind} job#${a.jobId} for ${a.alias} (${a.reason})`);
      },
    });
    worker = startWorker(db);
    console.log("scheduler + worker: on（--no-worker 可关闭）");
  } else {
    console.log("scheduler + worker: off（--no-worker）");
  }

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    console.log(`\n[console] ${signal} → 停止调度/worker…`);
    scheduler?.stop();
    await worker?.stop();
    try {
      server.stop(true);
    } catch {
      /* ignore */
    }
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

/** Headless worker: scheduler + queue only, no HTTP server. */
async function cmdWorker(): Promise<void> {
  const db = openAt();
  const scheduler = startScheduler(db, {
    onActions: (actions) => {
      for (const a of actions) console.log(`[scheduler] enqueue ${a.kind} job#${a.jobId} for ${a.alias} (${a.reason})`);
    },
  });
  const worker = startWorker(db);
  console.log(`wechat-flow console worker → db=${DB_PATH}（scheduler + worker，无 HTTP）`);

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    console.log(`\n[console.worker] ${signal} → 停止…`);
    scheduler.stop();
    await worker.stop();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

function cmdStatus(): void {
  const db = openAt();
  console.log(`db=${DB_PATH}`);
  console.log(`schema_version=${schemaVersion(db)}`);
  console.log(`users=${countUsers(db)} admins=${countAdmins(db)} accounts=${listAccountRows(db).length}`);
  const global = getGlobalRaw(db);
  console.log(`global_defaultAccount=${String(global.defaultAccount ?? "(none)")}`);
  db.close();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const has = (n: string) => args.includes(n);

  if (has("--init-key")) {
    const r = initMasterKey(has("--force"));
    console.log(r.created ? `已生成 master key: ${r.path} (0600)` : `master key 已存在，未改动: ${r.path}`);
    return;
  }
  if (has("--create-admin")) return cmdCreateAdmin(args);
  if (has("--status")) return cmdStatus();

  if (has("--import-config")) {
    const db = openAt();
    const r = importConfig(db);
    const rendered = renderConfig(db);
    console.log(`已导入 config.json → DB`);
    console.log(`  账号: ${r.accounts.map((a) => `${a.alias}${a.created ? "(new)" : ""}`).join(", ") || "(none)"}`);
    console.log(`  defaultAccount=${r.defaultAccount}`);
    console.log(`  原始备份: ${r.backupPath ?? "(已存在，未覆盖)"}`);
    console.log(`  回写 config.json: ${rendered.configPath} (${rendered.bytes} bytes)`);
    db.close();
    return;
  }

  if (has("--verify-ac3")) {
    const db = openAt();
    const report = verifyAc3(db);
    console.log(formatAc3(report));
    db.close();
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  if (has("--worker")) return cmdWorker();

  return cmdServe(args);
}

main().catch((err) => {
  console.error(`✖ ${(err as Error).message}`);
  process.exit(1);
});
