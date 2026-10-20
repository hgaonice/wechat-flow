#!/usr/bin/env bun
/**
 * tools/console-secret.ts — 控制台凭据（`secrets` 表）运维工具。
 *
 * 为什么需要它：C5 的隧道地址变更邮件正文里带「【本账号后台账密】」一段，
 * 内容取自 `secrets` 表中该账号的 `wechat_login`（AES-256-GCM，只写不读）。
 * 表里没有这一行时邮件就只会写「未配置（请管理员在控制台补录）」——
 * 这正是 2026-10-20 用户反馈「为什么邮件里没有账号密码」的原因。
 *
 * 控制台 UI 也能录入（账号详情 → 凭据），但那是「明文过浏览器」，本工具
 * 走 stdin/文件，明文不进 shell 历史、不进截图、不在终端回显，适合批量/脚本。
 *
 * 用法（在 250 上、以 root 运行）：
 *
 *   # 录入（密码从 stdin 读，不回显；--user 可选，不给则邮件里「账号」显示未填）
 *   read -rsp '公众号后台密码: ' P; echo; printf '%s' "$P" | \
 *     bun tools/console-secret.ts set --alias gaoh --user 'your-mp-username'
 *   unset P
 *
 *   # 从文件读（文件用完即删）
 *   bun tools/console-secret.ts set --alias second --user u --from-file /tmp/pw
 *
 *   # 看看现在有什么 / 校验某个账号能否解出账密（密码永远打码）
 *   bun tools/console-secret.ts list
 *   bun tools/console-secret.ts verify --alias gaoh
 *
 * 选项：
 *   --db <path>        控制台 DB（默认 env CONSOLE_DB → ./console/console.db）
 *   --alias <a>        账号 alias（必填，除 list）
 *   --kind <k>         凭据类型（默认 wechat_login；可选 SECRET_KINDS）
 *   --user <name>      只对 wechat_login 生效：与密码一起存成 JSON
 *   --from-file <p>    从文件读明文（默认读 stdin）
 *   --dry              只做加解密往返验证，不写库
 *   --quiet            只输出一行结果
 *
 * 退出码：0 成功；1 参数/环境错；2 账号不存在；3 加解密校验失败。
 */
import fs from "node:fs";
import path from "node:path";
import { openDb } from "../src/console/db/migrate.ts";
import { getAccountByAlias, listAccountRows } from "../src/console/db/dao/accounts.ts";
import { isSecretKind, listSecretMetas, putSecret, SECRET_KINDS } from "../src/console/db/dao/secrets.ts";
import { decryptSecret, encryptSecret, loadMasterKey } from "../src/console/crypto/secrets.ts";
import { buildTunnelMail, decryptWechatLogin } from "../src/console/notify/tunnel-mail.ts";
import type { TunnelRow } from "../src/console/db/dao/tunnels.ts";

function die(msg: string, code = 1): never {
  console.error(`✖ ${msg}`);
  process.exit(code);
}

interface Args {
  cmd: string;
  db?: string;
  alias?: string;
  kind: string;
  user?: string;
  fromFile?: string;
  dry: boolean;
  quiet: boolean;
}

function parseArgs(argv: string[]): Args {
  const [cmd = "", ...rest] = argv;
  const out: Args = { cmd, kind: "wechat_login", dry: false, quiet: false };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    const next = (): string => {
      const v = rest[i + 1];
      if (v === undefined) die(`${a} 缺少参数值`, 1);
      i += 1;
      return v;
    };
    if (a === "--db") out.db = next();
    else if (a === "--alias") out.alias = next();
    else if (a === "--kind") out.kind = next();
    else if (a === "--user") out.user = next();
    else if (a === "--from-file") out.fromFile = next();
    else if (a === "--dry") out.dry = true;
    else if (a === "--quiet") out.quiet = true;
    else if (a === "-h" || a === "--help") {
      console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("*/")[0]!.replace(/^#!.*\n/, ""));
      process.exit(0);
    } else die(`未知参数 ${a}`, 1);
  }
  return out;
}

function dbPath(explicit?: string): string {
  const p = explicit || process.env.CONSOLE_DB || path.join(process.cwd(), "console", "console.db");
  if (!fs.existsSync(p)) die(`数据库不存在: ${p}（用 --db 指定，或 cd 到仓库根）`, 1);
  return p;
}

/** `xxxx…（n 字符）` — 用于在任何输出里替代明文。 */
function mask(secret: string): string {
  return `${"*".repeat(Math.min(secret.length, 8))}…（${secret.length} 字符）`;
}

function readPlaintext(args: Args): string {
  let raw: string;
  if (args.fromFile) {
    raw = fs.readFileSync(args.fromFile, "utf8");
  } else {
    if (process.stdin.isTTY) die("没有 stdin 可读：用 `printf '%s' \"$P\" | bun tools/console-secret.ts set …` 或 --from-file", 1);
    raw = fs.readFileSync(0, "utf8");
  }
  const value = raw.replace(/\r?\n$/, ""); // 只去掉一个结尾换行
  if (!value.trim()) die("明文为空", 1);
  return value;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!["list", "set", "verify"].includes(args.cmd)) {
    die("用法：bun tools/console-secret.ts <list|set|verify> [选项]（--help 查看完整说明）", 1);
  }

  const db = openDb(dbPath(args.db));
  try {
    if (args.cmd === "list") {
      const rows = listAccountRows(db);
      if (!rows.length) die("账号表为空", 2);
      for (const acc of rows) {
        const metas = listSecretMetas(db, acc.id);
        const desc = metas.length
          ? metas.map((m) => `${m.kind}(v${m.key_version}, ${m.updated_at})`).join(" ")
          : "（无）";
        console.log(`${acc.alias}\t凭据: ${desc}`);
        const login = decryptWechatLogin(db, loadMasterKey(), acc.id);
        console.log(`\t\twechat_login: ${login ? `已配置 username=${login.username || "（未填）"} password=${mask(login.password)}` : "未配置"}`);
      }
      return;
    }

    if (!args.alias) die("缺少 --alias", 1);
    const acc = getAccountByAlias(db, args.alias);
    if (!acc) die(`账号不存在: ${args.alias}（现有：${listAccountRows(db).map((a) => a.alias).join(", ")}）`, 2);
    if (!isSecretKind(args.kind)) die(`kind 非法（可选：${SECRET_KINDS.join(", ")}）`, 1);

    const key = loadMasterKey();

    if (args.cmd === "set") {
      if (args.user && args.kind !== "wechat_login") die("--user 只对 wechat_login 生效", 1);
      const password = readPlaintext(args);
      const plaintext = args.user
        ? JSON.stringify({ username: args.user, password })
        : password;
      const enc = encryptSecret(plaintext, key);
      // 往返校验：解不回来就不落库（防止把密钥/编码问题写成一条永远读不了的记录）
      const back = decryptSecret(enc.ciphertext, enc.nonce, key);
      if (back !== plaintext) die("加解密往返校验失败，未写入", 3);

      if (args.dry) {
        console.log(`(dry) ${acc.alias} ${args.kind} 加密往返 ok，password=${mask(password)}，未写库`);
      } else {
        putSecret(db, acc.id, args.kind, enc);
        const after = decryptWechatLogin(db, key, acc.id);
        if (!after) die("写入后无法解密（master key 可能已更换）", 3);
        console.log(
          `✓ ${acc.alias} ${args.kind} 已写入（keyVersion=${enc.keyVersion}）` +
            ` username=${after.username || "（未填）"} password=${mask(after.password)}`,
        );
      }
      if (args.quiet) return;
      console.log("  下一步：控制台「运维 → 重发邮件」会立刻用新凭据重发地址邮件；否则等下一次地址变更。");
      return;
    }

    // verify
    const login = decryptWechatLogin(db, key, acc.id);
    if (!login) {
      die(`${acc.alias} 的 wechat_login 未配置（或 master key 不匹配），邮件会写「未配置」`, 3);
    }
    console.log(`✓ ${acc.alias} wechat_login 可解密：username=${login.username || "（未填）"} password=${mask(login.password)}`);
    const stub: TunnelRow = {
      id: 0,
      kind: "quick",
      status: "up",
      url: "https://example.trycloudflare.com",
      pid: 1,
      since: new Date().toISOString(),
      last_checked_at: null,
      detail: null,
      notify_attempts: 0,
      notified_at: null,
      replaced_by: null,
      created_at: new Date().toISOString(),
    } as unknown as TunnelRow;
    const mail = buildTunnelMail(stub, login, `[${acc.alias}]`, new Date());
    const preview = mail.body
      .replace(/密码：([^<\n]*)/, (_m, pw: string) => `密码：${mask(pw)}`)
      .split("\n")
      .filter((line) => /账密|账号|密码|当前地址|控制台端口/.test(line))
      .join("\n");
    console.log(`  邮件预览（密码已打码）：
${preview}`);
  } finally {
    db.close();
  }
}

main();
