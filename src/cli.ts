#!/usr/bin/env bun
/** Command-line entry: parse argv, resolve target accounts (-a/--all), dispatch to modules. */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig, ensureDirs, listAccounts, APP_DIR, type AppConfig } from "./config.ts";
import { initLog, log } from "./log.ts";
import { runPlan, findEntryForDate, proxyEnv } from "./planner.ts";
import { runPublish, parseFrontmatter } from "./publisher.ts";
import { loadState } from "./state.ts";
import { checkEmail } from "./mailer.ts";
import { checkBrowser, describeBrowserMode, resolveProfileDir } from "./browser.ts";
import { listDrafts, listDraftTitles, verifyDraftPublished, verifyDraftBody, setDraftCover, probeDraftCover } from "./wechat.ts";
import { ensureLoggedIn, probeAccountSession } from "./session.ts";
import {
  hoursSince,
  markKeepalive,
  readProbeState,
  resetFailureCount,
  type ProbeResult,
} from "./session-probe.ts";
import { describeCookieFacts, readCookieFacts } from "./session-state.ts";
import { listSnapshots, restore, snapshot } from "./session-snapshot.ts";
import { maybeWarnExpiringSession } from "./session-warn.ts";
import { listAvailableModels, missingModels } from "./pi.ts";
import { generateAiCover, listImageModels, normalizeImageModelId, resolveImageGateway } from "./cover-ai.ts";
import { notify } from "./notify.ts";
import { todayInTz, isoWeek } from "./date.ts";

/** Recognised `session` subcommands (matched by name, not by argv position). */
const SESSION_SUBS = new Set(["probe", "snapshot", "restore", "list"]);

const USAGE = `usage: wechat-flow <command> [options]

commands:
  plan      编排下一周选题          publish   生成并发布当天文章
  run       plan 或 publish 自动判断  status    已发布清单
  accounts  列出所有公众号          doctor    环境自检
  login     建立/续期登录会话        drafts    查看草稿箱
  keepalive 会话保活（4 天票据续期；成功后自动做 cookie 快照 + 到期预警）
  session   会话诊断与回滚（见下）
  cover     给草稿自动设封面（--ai 只重画 AI 封面，--upload 同时设到草稿）
  mail-test 发送测试邮件

session 子命令:
  probe                      三层证据判定 valid|invalid|unknown（只读）
  snapshot [--reason <r>]    原子快照 Cookies + Local State（保留 10 份）
  restore --id <id>          校验 → 停浏览器 → 替换 → 启浏览器 → 复验
  list                       列出快照（时间倒序）

options:
  -a, --account <alias>   指定公众号（省略则用默认号）
      --all               对所有已启用公众号依次执行（用于 plan/publish/run/status/doctor）
      --date <YYYY-MM-DD> 指定日期
      --dry-run           只生成不发布
      --reuse             复用已生成的文章
      --force             忽略已发布记录，重新发布（修复历史草稿用）
  -t, --to <a@b,c@d>      邮件收件人（mail-test）
      --wait <sec>        登录等待秒数（login/drafts/keepalive --wait 可阻塞等待扫码）
      --qr                二维码同时发邮件（keepalive 默认开启）
      --no-qr             不发送登录二维码邮件（keepalive）
      --reason <r>        session snapshot：快照原因（默认 manual；同分钟同 reason 只留一份）
      --keep <n>          session snapshot：保留份数（默认 10）
      --id <snapshot>     session restore：快照 id（可用前缀；先 session list）
      --title <t>         cover：直接指定草稿标题
      --cover <png>       cover：封面文件（默认 imgs/<date>/cover.png）
      --ai                cover：用 AI 重画封面（不重跑文章）
      --upload            cover：配合 --ai，重画后设到草稿
      --probe             cover：只读探测封面弹窗 DOM
      --explore           cover：逐步点击封面弹窗并快照（诊断）
      --reload            session probe：先禁缓存重载再读 DOM（会扰动当前 tab）
      --no-persist        session probe：只读，不改写 state（部署自检用）
      --json              session probe：输出 JSON`;

function parseFlags(argv: string[]): Record<string, string | boolean> {
  const short: Record<string, string> = { a: "account", t: "to", d: "date", w: "wait" };
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    let key: string | undefined;
    if (a.startsWith("--")) key = a.slice(2);
    else if (a.startsWith("-") && a.length === 2) key = short[a[1]!];
    if (!key) continue;
    const next = argv[i + 1];
    if (next && !next.startsWith("-")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

/** Which accounts a command should act on. */
function resolveTargets(base: AppConfig, flags: Record<string, string | boolean>): string[] {
  if (flags.all === true) {
    const enabled = listAccounts().filter((a) => a.enabled);
    if (!enabled.length) throw new Error("no enabled accounts in config.json");
    return enabled.map((a) => a.alias);
  }
  const alias = typeof flags.account === "string" ? flags.account : undefined;
  return [alias ?? base.accountAlias];
}

/** Load + prepare the config for one account (dirs, log file). */
function cfgFor(alias: string, cmd: string): AppConfig {
  const cfg = loadConfig(alias);
  ensureDirs(cfg);
  initLog(cfg.paths.logs, cmd);
  return cfg;
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  const base = loadConfig(); // default account (validates config.json shape)
  const targets = resolveTargets(base, flags);
  const multi = targets.length > 1;
  const banner = (alias: string) => {
    if (multi) console.log(`\n${"─".repeat(6)} ${alias} ${"─".repeat(6)}`);
  };

  switch (cmd) {
    case "accounts": {
      const all = listAccounts();
      const def = base.defaultAccount;
      console.log(`默认公众号 : ${def}`);
      for (const a of all) {
        const tag = a.isDefault ? "★ 默认" : a.enabled ? "  启用" : "  停用";
        console.log(`${tag}  ${a.alias.padEnd(12, " ")} ${a.displayName.padEnd(14, " ")} ${a.dataDir}`);
      }
      break;
    }
    case "plan": {
      for (const alias of targets) {
        banner(alias);
        const cfg = cfgFor(alias, cmd);
        await runPlan(cfg, { date: flags.date as string | undefined, dryRun: flags["dry-run"] === true });
      }
      break;
    }
    case "publish": {
      for (const alias of targets) {
        banner(alias);
        const cfg = cfgFor(alias, cmd);
        const res = await runPublish(cfg, {
          date: flags.date as string | undefined,
          dryRun: flags["dry-run"] === true,
          reuse: flags.reuse === true,
          force: flags.force === true,
        });
        if (!res.ok && !res.skipped) process.exitCode = 1;
      }
      break;
    }
    case "run": {
      const date = todayInTz();
      for (const alias of targets) {
        banner(alias);
        const cfg = cfgFor(alias, cmd);
        if (!findEntryForDate(cfg, date)) {
          log.info(`no plan for ${date} -> running weekly planner`);
          await runPlan(cfg, { dryRun: flags["dry-run"] === true });
        } else {
          const res = await runPublish(cfg, { date, dryRun: flags["dry-run"] === true });
          if (!res.ok && !res.skipped) process.exitCode = 1;
        }
      }
      break;
    }
    case "status": {
      for (const alias of targets) {
        banner(alias);
        cfgFor(alias, cmd);
        const cfg = loadConfig(alias);
        const state = loadState(cfg.paths.state);
        const rows = Object.values(state.published).sort((a, b) => (a.date < b.date ? 1 : -1));
        if (!multi) {
          console.log(`APP_DIR   : ${APP_DIR}`);
          console.log(`today     : ${todayInTz()}  (${isoWeek(todayInTz())})`);
        }
        console.log(`account   : ${cfg.accountName} (${cfg.account})${cfg.accountAlias === cfg.defaultAccount ? "  [默认]" : ""}`);
        console.log(`dataDir   : ${cfg.paths.data}`);
        // C1 Step 6.2: remaining session time is part of "status" — it is the
        // first thing to look at when a run mysteriously fails.
        if (cfg.publishMethod === "browser") {
          const cookie = readCookieFacts(resolveProfileDir(cfg.browser, cfg.account));
          const probeState = readProbeState(path.join(cfg.paths.state, "session-probe.json"));
          console.log(
            `session   : ${describeCookieFacts(cookie)} · last keepalive ${keepText(probeState.lastKeepaliveAt)} · snapshots ${listSnapshots(cfg.account, { dataDir: cfg.paths.data }).length}`,
          );
        } else {
          console.log(`session   : n/a（publishMethod=${cfg.publishMethod}）`);
        }
        console.log(`published : ${rows.length} total`);
        for (const r of rows.slice(0, 14)) {
          console.log(`  ${r.date}  ${r.ok ? "✅" : "❌"}  ${r.title}  ${r.mediaId ?? ""}`);
        }
        const plans = fs.existsSync(cfg.paths.plans) ? fs.readdirSync(cfg.paths.plans) : [];
        console.log(`plans     : ${plans.join(", ") || "(none)"}`);
      }
      break;
    }
    case "mail-test": {
      for (const alias of targets) {
        banner(alias);
        const cfg = cfgFor(alias, cmd);
        if (!cfg.notify.email) {
          console.error(`email not configured for ${alias}: add notify.email in config.json`);
          process.exitCode = 1;
          continue;
        }
        if (flags.to) cfg.notify.email.to = String(flags.to).split(",").map((s) => s.trim());
        cfg.notify.email.enabled = true;
        cfg.notify.enabled = true;
        await notify(cfg, {
          kind: "test",
          title: "mail-test 测试邮件",
          body: `这是来自 wechat-flow 的测试邮件。\n时间：${new Date().toISOString()}\n公众号：${cfg.accountName}（${cfg.account}）`,
        });
      }
      break;
    }
    case "doctor": {
      for (const alias of targets) {
        banner(alias);
        await doctor(cfgFor(alias, cmd));
      }
      break;
    }
    case "login": {
      for (const alias of targets) {
        banner(alias);
        await login(cfgFor(alias, cmd), flags);
      }
      break;
    }
    case "drafts": {
      for (const alias of targets) {
        banner(alias);
        await drafts(cfgFor(alias, cmd), flags);
      }
      break;
    }
    case "keepalive": {
      for (const alias of targets) {
        banner(alias);
        await keepalive(cfgFor(alias, cmd), flags);
      }
      break;
    }
    case "session": {
      // Pick the subcommand by name so `session restore --id <id>` is not mistaken
      // for the flag's value.
      const sub = rest.find((a) => SESSION_SUBS.has(a)) ?? "";
      for (const alias of targets) {
        banner(alias);
        await sessionCmd(cfgFor(alias, cmd), flags, sub);
      }
      break;
    }
    case "cover": {
      for (const alias of targets) {
        banner(alias);
        await cover(cfgFor(alias, cmd), flags);
      }
      break;
    }
    default:
      console.log(USAGE);
  }
}

/**
 * Keep the MP web session ticket alive.
 *
 * The ticket (`slave_sid` + `data_ticket`/`bizuin`/… ) carries a HARD 4-day
 * expiry, and MP re-issues it on authenticated activity: measured on 250
 * (2026-10-16) a `drafts` call moved `slave_sid` from +95.9h to +96.0h. So a
 * cheap authenticated request well inside that window slides the session
 * forever and the operator never has to rescan the QR.
 *
 * When the session is really gone we fail loudly and (by default) email a fresh
 * QR, so the human can rescan at their convenience instead of discovering the
 * breakage when the daily publish fails.
 */
async function keepalive(cfg: AppConfig, flags: Record<string, string | boolean>): Promise<void> {
  if (cfg.publishMethod !== "browser") {
    console.log(`publishMethod=${cfg.publishMethod}：API 方式不需要会话保活。`);
    return;
  }
  const lg = await ensureLoggedIn({
    browser: cfg.browser,
    skillDir: cfg.skillDir,
    account: cfg.account,
    email: cfg.notify.email,
    qrOutPath: path.join(cfg.paths.state, "wechat-login-qr.png"),
    stateDir: cfg.paths.state,
    env: proxyEnv(cfg),
    waitSec: flags.wait ? Number(flags.wait) : 0,
    notifyQr: flags["no-qr"] !== true,
  });
  if (!lg.ok) {
    // `lg.detail` carries the evidence summary, so a QR timeout is no longer
    // indistinguishable from a confirmed server-side logout.
    console.error(
      `❌ 会话需要重新登录（判定=${lg.verdict}${lg.emailed ? "，二维码已发邮件" : ""}）：${lg.detail}`,
    );
    process.exitCode = 1;
    return;
  }
  // The probe only proves the page rendered; an authenticated request is what
  // actually slides the ticket, so make one and require it to succeed. A single
  // null is retried once: R2 forbids paging a human on one flaky probe.
  let titles = await listDraftTitles(cfg.browser, cfg.skillDir);
  if (titles === null) {
    log.warn("[session] 鉴权请求失败一次，5s 后重试（单次失败不告警）");
    await new Promise((r) => setTimeout(r, 5000));
    titles = await listDraftTitles(cfg.browser, cfg.skillDir);
  }
  if (titles === null) {
    console.error(
      `❌ 鉴权请求连续失败（判定=${lg.verdict}，未确认失效；证据=${lg.evidence ?? "?"}）——若 cookie 未过期请先重跑 keepalive，仍失败再扫码。`,
    );
    process.exitCode = 1;
    return;
  }
  markKeepalive(path.join(cfg.paths.state, "session-probe.json"));
  // A proven-authenticated call is the strongest live evidence we have: clear the
  // failure counter, otherwise 2 old `unknown` probes + one CDP hiccup would still
  // request a QR *after* we just proved the session works (2026-10-20 复核 N1).
  resetFailureCount(path.join(cfg.paths.state, "session-probe.json"), "keepalive-auth-ok");
  const profileDir = resolveProfileDir(cfg.browser, cfg.account);

  // C1 Step 3.2: refresh the rollback point right after a proven-authenticated
  // run (the ticket was just slid, so this snapshot is the freshest one).
  // A snapshot failure must NEVER fail the keepalive: the ticket already slid.
  const snap = snapshot(cfg.account, profileDir, { dataDir: cfg.paths.data, reason: "keepalive" });
  if (snap.ok) {
    log.info(`[session] snapshot ${snap.id}${snap.skipped ? ` (${snap.reason})` : ""}`);
  } else {
    log.warn(`[session] 快照失败（不影响保活）：${snap.reason}`);
  }

  // C1 Step 3.3: advisory "ticket expires in <24h" mail (≤1 per 24h, never
  // blocking, deliberately worded as a warning rather than a failure).
  const cookie = readCookieFacts(profileDir);
  const warn = await maybeWarnExpiringSession({
    dataDir: cfg.paths.data,
    alias: cfg.account,
    accountName: cfg.accountName,
    ...(cookie.slaveSidExpiresAt !== undefined ? { slaveSidExpiresAt: cookie.slaveSidExpiresAt } : {}),
    email: cfg.notify.email,
  });
  log.info(`[session] expiry-warn=${warn.sent ? "sent" : "no"} — ${warn.reason}`);

  console.log(
    `✅ 会话保活成功（票据已顺延）：草稿箱 ${titles.length} 条 · 判定=${lg.verdict} · ${lg.evidence ?? ""}`,
  );
  console.log(
    `   快照：${snap.ok ? `${snap.id}${snap.skipped ? "（已存在）" : ""}` : `失败（${snap.reason}）`}`,
  );
  console.log(`   到期预警：${warn.sent ? "已发邮件" : "未发"}（${warn.reason}）`);
}

/** `session <sub>`：probe（只读三态判定）| snapshot | restore | list. */
async function sessionCmd(
  cfg: AppConfig,
  flags: Record<string, string | boolean>,
  sub: string,
): Promise<void> {
  switch (sub) {
    case "probe":
      await sessionProbe(cfg, flags);
      return;
    case "snapshot":
      sessionSnapshot(cfg, flags);
      return;
    case "restore":
      await sessionRestore(cfg, flags);
      return;
    case "list":
      sessionList(cfg);
      return;
    default:
      console.error(
        "usage: wechat-flow session <probe|snapshot|restore|list> [-a <alias>|--all] [--json] [--reload] [--reason <r>] [--keep N] [--id <snapshot-id>]",
      );
      process.exitCode = 1;
  }
}

function keepText(iso: string | undefined): string {
  const h = hoursSince(iso);
  return h === null ? "(无记录)" : `${h.toFixed(1)}h ago`;
}

/** `session probe`：read-only, idempotent three-layer verdict for one account. */
async function sessionProbe(cfg: AppConfig, flags: Record<string, string | boolean>): Promise<void> {
  if (cfg.publishMethod !== "browser") {
    console.log(`publishMethod=${cfg.publishMethod}：API 方式没有浏览器会话，无需探测。`);
    return;
  }
  // Read-only: no reload, no navigation, no Chrome spawn (a down CDP port is
  // simply "http/dom unknown" — cookie evidence is still local and free).
  const r: ProbeResult = await probeAccountSession({
    browser: cfg.browser,
    skillDir: cfg.skillDir,
    account: cfg.account,
    stateDir: cfg.paths.state,
    env: proxyEnv(cfg),
    revalidate: flags.reload === true,
    // --no-persist keeps `deploy/session-check.sh` free of side effects: a deploy
    // must never push `consecutiveFailures` towards the QR threshold by itself.
    ...(flags["no-persist"] === true ? { persist: false } : {}),
  });
  if (flags.json === true) {
    console.log(
      JSON.stringify(
        {
          account: cfg.account,
          verdict: r.verdict,
          evidence: r.evidence,
          consecutiveFailures: r.consecutiveFailures,
          threshold: r.threshold,
          needsScan: r.needsScan,
          detail: r.detail,
          facts: r.facts,
        },
        null,
        2,
      ),
    );
    return;
  }
  const cookie = r.facts.cookie;
  const remain =
    cookie.ok && cookie.slaveSidExpiresAt !== undefined
      ? `${((cookie.slaveSidExpiresAt - Date.now() / 1000) / 3600).toFixed(1)}h`
      : "未知";
  console.log(`verdict           : ${r.verdict}${r.needsScan ? "（达到扫码条件）" : ""}`);
  console.log(`判定来源          : ${r.detail}`);
  console.log(`evidence          : ${r.evidence}`);
  console.log(`slave_sid 剩余    : ${remain}${cookie.cookiesFile ? `  (${cookie.cookiesFile})` : ""}`);
  console.log(`连续失败          : ${r.consecutiveFailures}/${r.threshold}`);
  console.log(`最近保活          : ${keepText(r.state.lastKeepaliveAt)}`);
  console.log(`快照              : ${listSnapshots(cfg.account, { dataDir: cfg.paths.data }).length} 份`);
}

/** `session snapshot`：atomic Cookies + Local State copy (rollback point). */
function sessionSnapshot(cfg: AppConfig, flags: Record<string, string | boolean>): void {
  if (cfg.publishMethod !== "browser") {
    console.log(`publishMethod=${cfg.publishMethod}：API 方式没有浏览器会话，快照无意义。`);
    return;
  }
  const rawKeep = flags.keep === undefined ? NaN : Number(flags.keep);
  const r = snapshot(cfg.account, resolveProfileDir(cfg.browser, cfg.account), {
    dataDir: cfg.paths.data,
    reason: typeof flags.reason === "string" ? flags.reason : "manual",
    ...(Number.isFinite(rawKeep) && rawKeep >= 1 ? { keep: Math.floor(rawKeep) } : {}),
  });
  if (!r.ok) {
    console.error(`❌ 快照失败：${r.reason}`);
    process.exitCode = 1;
    return;
  }
  const expires = r.slaveSidExpiresAt ? new Date(r.slaveSidExpiresAt * 1000).toISOString() : "未知";
  const count = listSnapshots(cfg.account, { dataDir: cfg.paths.data }).length;
  console.log(`✅ 快照 ${r.id}${r.skipped ? `（${r.reason}）` : ""}`);
  console.log(`   目录        : ${r.dir}`);
  console.log(`   slave_sid   : ${expires}`);
  console.log(`   大小/份数   : ${((r.sizeBytes ?? 0) / 1024).toFixed(1)}KB · 共 ${count} 份`);
}

/** `session restore --id <id>`：verify → stop browser → swap → start → re-probe. */
async function sessionRestore(cfg: AppConfig, flags: Record<string, string | boolean>): Promise<void> {
  const id = typeof flags.id === "string" ? flags.id.trim() : "";
  if (!id) {
    console.error("❌ 缺少 --id <snapshot-id>（先 bun src/cli.ts session list）");
    process.exitCode = 1;
    return;
  }
  if (cfg.publishMethod !== "browser") {
    console.log(`publishMethod=${cfg.publishMethod}：API 方式没有浏览器会话，无法回滚。`);
    return;
  }
  const r = restore(cfg.account, id, {
    dataDir: cfg.paths.data,
    profileDir: resolveProfileDir(cfg.browser, cfg.account),
  });
  for (const step of r.steps) console.log(`  · ${step}`);
  for (const w of r.warnings) console.log(`  ⚠️  ${w}`);
  if (!r.ok) {
    console.error(`❌ restore 失败：${r.reason}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✅ restore ${r.id} 完成（现网文件已备份为 *.pre-restore，可手工回退）`);

  // Files restored ≠ session alive: the caller MUST re-verify. Read-only probe
  // (no reload/navigation) so we do not fight the tab the browser just restored.
  const probe = await probeAccountSession({
    browser: cfg.browser,
    skillDir: cfg.skillDir,
    account: cfg.account,
    stateDir: cfg.paths.state,
    env: proxyEnv(cfg),
    revalidate: false,
  });
  console.log(`复验：verdict=${probe.verdict} · ${probe.evidence}`);
  if (probe.verdict === "invalid") {
    // `unknown` is NOT failure: it usually means the browser just started / DOM
    // not ready yet. Only positive evidence of a dead session fails the command.
    console.warn(
      `⚠️  复验判定 invalid。若证据是「服务端跳登录」，说明快照回滚无效＝MP 侧真实失效，需要重新扫码：bun src/cli.ts login -a ${cfg.account} --qr --wait 900`,
    );
    process.exitCode = 1;
  } else if (probe.verdict === "unknown") {
    console.warn(
      `⏳ 无法复验（${probe.evidence}）：文件已恢复，请稍后跑 bun src/cli.ts session probe -a ${cfg.account} 确认`,
    );
  }
}

/** `session list`：snapshots newest-first (id / time / reason / remaining ticket). */
function sessionList(cfg: AppConfig): void {
  const rows = listSnapshots(cfg.account, { dataDir: cfg.paths.data });
  if (!rows.length) {
    console.log(`(无快照) ${cfg.paths.data}/session-snapshots`);
    return;
  }
  const nowSec = Date.now() / 1000;
  console.log(`快照 ${rows.length} 份（新→旧）：`);
  for (const s of rows) {
    const sid =
      s.slaveSidExpiresAt === undefined
        ? "slave_sid 未知"
        : `slave_sid in ${((s.slaveSidExpiresAt - nowSec) / 3600).toFixed(1)}h`;
    console.log(
      `  ${s.id}  ${s.createdAt}  ${(s.reason || "?").padEnd(9, " ")}  ${(s.sizeBytes / 1024).toFixed(1)}KB  ${sid}`,
    );
  }
}

/** List 草稿箱 titles; with --date also checks that day's article is present. */
async function drafts(cfg: AppConfig, flags: Record<string, string | boolean>): Promise<void> {
  if (cfg.publishMethod !== "browser") {
    console.log(`publishMethod=${cfg.publishMethod}; 草稿箱查询仅用于浏览器方式。`);
  }
  // Make sure Xvfb + Chrome are up *and* a logged-in MP tab exists (a cold
  // Chrome only has about:blank, so there is no token to query with).
  const lg = await ensureLoggedIn({
    browser: cfg.browser,
    skillDir: cfg.skillDir,
    account: cfg.account,
    email: cfg.notify.email,
    qrOutPath: path.join(cfg.paths.state, "wechat-login-qr.png"),
    stateDir: cfg.paths.state,
    env: proxyEnv(cfg),
    waitSec: flags.wait ? Number(flags.wait) : 60,
    notifyQr: flags.qr === true,
  });
  if (!lg.ok) {
    console.error(`❌ 未登录：${lg.detail}\n   先执行：bun src/cli.ts login -a ${cfg.account}${flags.qr ? "" : "（加 --qr 可在等待时把二维码发到邮箱）"}`);
    process.exitCode = 1;
    return;
  }
  const draftsList = await listDrafts(cfg.browser, cfg.skillDir);
  if (draftsList === null) {
    console.error(`❌ 无法读取草稿箱。请先确认已登录：bun src/cli.ts login -a ${cfg.account}`);
    process.exitCode = 1;
    return;
  }
  console.log(`草稿箱共 ${draftsList.length} 条：`);
  draftsList.forEach((d, i) => console.log(`${String(i + 1).padStart(2, " ")}. [${d.appmsgid}] ${d.title}`));

  if (typeof flags.date === "string") {
    const date = flags.date;
    // Only the canonical article is the truth source. Two other file kinds live
    // next to it and both carry a *different* title:
    //   *.math.md  — media-preprocessed copy (same title, different body)
    //   *.v<N>.md  — console workbench version snapshots (OLD titles)
    // Picking one of those made `drafts --date` report a false ❌.
    const all = fs.existsSync(cfg.paths.articles)
      ? fs.readdirSync(cfg.paths.articles).filter((f) => f.startsWith(`${date}-`) && f.endsWith(".md"))
      : [];
    const files = all
      .filter((f) => !/\.v\d+\.md$/.test(f) && !/\.math\.md$/.test(f))
      .sort((a, b) => a.length - b.length || a.localeCompare(b));
    if (!files.length) {
      console.log(`\n(${date} 无本地文章文件)`);
      return;
    }
    const md = fs.readFileSync(path.join(cfg.paths.articles, files[0]), "utf8");
    const fm = parseFrontmatter(md);
    console.log(`(据 ${files[0]} 的标题校验：${fm.title ?? "(无 title)"})`);
    const v = await verifyDraftPublished(cfg.browser, cfg.skillDir, fm.title ?? "");
    console.log(`\n${v === true ? "✅" : v === false ? "❌" : "⚠️"} ${date} 草稿校验: ${v === true ? "已确认在草稿箱" : v === false ? "未找到" : "无法查询"}`);
    // 标题存在不等于正文存在——务必用后台编辑器实测正文字数。
    const b = await verifyDraftBody(cfg.browser, cfg.skillDir, fm.title ?? "");
    console.log(
      `${b.ok === true ? "✅" : b.ok === false ? "❌" : "⚠️"} ${date} 正文校验: ${
        b.ok === false ? "❌ 正文为空/过短" : b.ok === null ? "无法查询" : "✅ 正文正常"
      } (${b.detail})`,
    );
  }
}

async function cover(cfg: AppConfig, flags: Record<string, string | boolean>): Promise<void> {
  const date = typeof flags.date === "string" ? flags.date : todayInTz();
  const coverPath =
    typeof flags.cover === "string" ? flags.cover : path.join(cfg.paths.imgs, date, "cover.png");

  // Resolve the draft title the same way publish does: article frontmatter first,
  // then the plan entry, unless the caller passed --title explicitly.
  let title = typeof flags.title === "string" ? flags.title : "";
  if (!title) {
    const files = fs.existsSync(cfg.paths.articles)
      ? fs.readdirSync(cfg.paths.articles).filter((f) => f.startsWith(`${date}-`) && f.endsWith(".md"))
      : [];
    if (files.length) title = parseFrontmatter(fs.readFileSync(path.join(cfg.paths.articles, files[0]), "utf8")).title ?? "";
    if (!title) {
      const found = findEntryForDate(cfg, date);
      title = found?.day.titleSuggestion ?? found?.day.topic ?? "";
    }
  }
  if (!title) {
    console.error(`❌ 无法确定 ${date} 的草稿标题，请加 --title <标题>`);
    process.exitCode = 1;
    return;
  }
  if (!flags.probe && !flags.ai && !fs.existsSync(coverPath)) {
    console.error(`❌ 封面文件不存在：${coverPath}（先生成文章/封面，或用 --cover 指定）`);
    process.exitCode = 1;
    return;
  }

  // `cover --ai`：只重画封面（不重跑文章、不碰草稿），故障排查与补救用。
  if (flags.ai) {
    const files = fs.existsSync(cfg.paths.articles)
      ? fs.readdirSync(cfg.paths.articles).filter((f) => f.startsWith(`${date}-`) && f.endsWith(".md"))
          .sort((a, b) => a.length - b.length)
      : [];
    const articleFile = files[0];
    if (!articleFile) {
      console.error(`❌ ${date} 的文章还没生成：${cfg.paths.articles}（先生成文章，或改 --date）`);
      process.exitCode = 1;
      return;
    }
    const md = fs.readFileSync(path.join(cfg.paths.articles, articleFile), "utf8");
    console.log(`cover --ai: date=${date} 文章=${articleFile} 尺寸=${cfg.cover.size}`);
    const r = await generateAiCover({
      outPath: coverPath,
      rawPath: path.join(path.dirname(coverPath), "cover-raw.png"),
      briefPath: path.join(path.dirname(coverPath), "cover-brief.json"),
      title,
      module: findEntryForDate(cfg, date)?.day.module ?? "",
      body: md,
      promptFile: path.join(cfg.paths.prompts, "cover.md"),
      settings: cfg.cover.ai,
      size: cfg.cover.size,
      font: cfg.cover.font,
      summaryModel: cfg.cover.ai.summaryModel || cfg.model.article.model,
      summaryFallbacks: cfg.cover.ai.summaryModel ? [] : cfg.model.article.fallbacks,
      piBin: cfg.piBin,
      cwd: APP_DIR,
    });
    if (!r.ok) {
      console.error(`❌ AI 封面失败：${r.reason}`);
      console.error(`   （发布时会自动回落渐变封面，但本次未写文件）`);
      process.exitCode = 1;
      return;
    }
    console.log(`✅ AI 封面：${r.model} → ${coverPath} (${r.size?.w}x${r.size?.h}, ${((r.ms ?? 0) / 1000).toFixed(1)}s)`);
    console.log(`   简报：${JSON.stringify(r.brief)}`);
    if (flags.upload !== true) {
      console.log(`   （只生成文件；设到草稿请加 --upload）`);
      return;
    }
  }

  if (cfg.publishMethod !== "browser") {
    console.log(`publishMethod=${cfg.publishMethod}；封面自动上传仅适用于浏览器（CDP）方式。`);
  }
  const lg = await ensureLoggedIn({
    browser: cfg.browser,
    skillDir: cfg.skillDir,
    account: cfg.account,
    email: cfg.notify.email,
    qrOutPath: path.join(cfg.paths.state, "wechat-login-qr.png"),
    stateDir: cfg.paths.state,
    env: proxyEnv(cfg),
    waitSec: flags.wait ? Number(flags.wait) : 60,
    notifyQr: flags.qr === true,
  });
  if (!lg.ok) {
    console.error(`❌ 未登录：${lg.detail}\n   先执行：bun src/cli.ts login -a ${cfg.account}`);
    process.exitCode = 1;
    return;
  }

  console.log(`cover: date=${date} title=「${title}」 file=${coverPath}`);
  if (flags.probe) {
    console.log("→ 只读探测封面弹窗 DOM（不改动任何内容）…");
    const r = await probeDraftCover({ browser: cfg.browser, skillDir: cfg.skillDir, title, explore: flags.explore === true, coverPath: flags.explore === true ? coverPath : undefined });
    console.log(r.detail);
    return;
  }
  const r = await setDraftCover({ browser: cfg.browser, skillDir: cfg.skillDir, title, coverPath });
  if (r.ok === true) {
    console.log(`✅ 草稿封面已设置（${r.stage}）：${r.detail}`);
  } else {
    console.error(`❌ 封面未设置（${r.stage ?? "?"}）：${r.detail}`);
    process.exitCode = 1;
  }
}

async function login(cfg: AppConfig, flags: Record<string, string | boolean>): Promise<void> {
  const waitSec = flags.wait ? Number(flags.wait) : 300;
  const qrOutPath = path.join(cfg.paths.state, "wechat-login-qr.png");
  console.log(`→ [${cfg.account}] 检查/建立公众号登录会话（最长等待 ${waitSec}s）…`);
  const res = await ensureLoggedIn({
    browser: cfg.browser,
    skillDir: cfg.skillDir,
    account: cfg.account,
    email: cfg.notify.email,
    qrOutPath,
    stateDir: cfg.paths.state,
    env: proxyEnv(cfg),
    waitSec,
  });
  if (res.ok) {
    console.log(`✅ ${res.detail}${res.qrPath ? `（二维码：${res.qrPath}）` : ""}`);
    return;
  }
  if (res.qrPath) {
    console.log(`→ 二维码已保存：${res.qrPath}${res.emailed ? "（并已发送到邮箱）" : ""}`);
  }
  console.error(`❌ ${res.detail}`);
  process.exitCode = 1;
}

async function doctor(cfg: AppConfig): Promise<void> {
  const checks: [string, boolean, string][] = [];
  const exists = (p: string) => fs.existsSync(p);
  checks.push(["config.json", exists(path.join(APP_DIR, "config.json")), path.join(APP_DIR, "config.json")]);
  checks.push(["syllabus", exists(path.join(cfg.paths.content, "syllabus.md")), path.join(cfg.paths.content, "syllabus.md")]);
  checks.push(["editor prompt", exists(path.join(cfg.paths.prompts, "editor.md")), ""]);
  checks.push(["skill script", exists(path.join(cfg.skillDir, "scripts", "wechat-api.ts")), path.join(cfg.skillDir, "scripts", "wechat-api.ts")]);
  checks.push(["skill browser script", exists(path.join(cfg.skillDir, "scripts", "wechat-article.ts")), path.join(cfg.skillDir, "scripts", "wechat-article.ts")]);
  // The upstream browser script saves drafts with an EMPTY body on the current
  // MP editor; without our patch every "success" is a lie. See
  // deploy/patch-baoyu-skill.sh and verifyDraftBody().
  {
    let ok = false;
    let detail = "未检测到可用的正文写入实现 — 见 README「空正文事故」";
    try {
      const src = fs.readFileSync(path.join(cfg.skillDir, "scripts", "wechat-article.ts"), "utf8");
      const bodyOk = /BODY_EDITOR_SELECTOR\s*=\s*['"]\.rich_media_content/.test(src) || src.includes("wechat-flow-patch v1");
      const focusOk = src.includes("prepareEditorPasteTarget") || src.includes("wechat-flow-patch v2");
      ok = bodyOk && focusOk;
      if (ok) {
        const how = src.includes("prepareEditorPasteTarget") ? "上游原生修复" : "wechat-flow-patch v1+v2";
        detail = `正文选择器 + 粘贴前聚焦 ✓ (${how})`;
      } else {
        const miss = [!bodyOk && "正文选择器", !focusOk && "粘贴前聚焦"].filter(Boolean).join("+");
        detail = `缺少 ${miss} — 运行 deploy/patch-baoyu-skill.sh`;
      }
    } catch {
      /* ignore */
    }
    checks.push(["skill 正文写入能力", ok, detail]);
  }
  checks.push(["wechat EXTEND.md", exists(path.join(process.env.HOME ?? "/root", ".baoyu-skills/baoyu-post-to-wechat/EXTEND.md")), ""]);
  checks.push(["账号登录态 profile", exists(`/root/.local/share/baoyu-skills/wechat-${cfg.account}`), `/root/.local/share/baoyu-skills/wechat-${cfg.account}`]);

  const piV = spawnSync(cfg.piBin, ["--version"], { encoding: "utf8" });
  checks.push([`pi (${cfg.piBin})`, piV.status === 0, (piV.stdout || piV.stderr || "").trim()]);

  // Model config drift: a fallback id that does not exist on this host burns a
  // retry round on every failure (`Model "x" not found`) and shrinks the real
  // fallback depth. Cheap to check, expensive to discover at 07:00.
  {
    const configured = [
      cfg.model.plan.model,
      ...(cfg.model.plan.fallbacks ?? []),
      cfg.model.article.model,
      ...(cfg.model.article.fallbacks ?? []),
    ].filter((m): m is string => typeof m === "string" && m.length > 0);
    const available = listAvailableModels(cfg.piBin);
    const absent = missingModels(configured, available);
    checks.push([
      "models (pi --list-models)",
      available !== null && absent.length === 0,
      available === null
        ? "探测失败（跳过，不阻塞发布）"
        : absent.length
          ? `配置里不存在的模型：${absent.join(", ")} — 改 model.plan/article.fallbacks`
          : `${configured.length} 个模型全部存在`,
    ]);
  }
  const bunV = spawnSync(cfg.bunBin, ["--version"], { encoding: "utf8" });
  checks.push([`bun (${cfg.bunBin})`, bunV.status === 0, (bunV.stdout || "").trim()]);

  // AI 封面：网关可达 + 配置里的图像模型在网关的模型表里。
  // 图像模型写错（或网关要的裸 id 写法不对）不会在发布时才报，而是当场能看出。
  if (cfg.cover.mode === "ai") {
    const gw = resolveImageGateway({ gateway: cfg.cover.ai.gateway, apiKey: cfg.cover.ai.apiKey });
    if (!gw) {
      checks.push(["cover-model (图像网关)", false, "未找到网关：配 cover.ai.gateway/apiKey 或 COVER_IMAGE_* env 或 ~/.pi/agent/models.json"]);
    } else {
      const ids = await listImageModels(gw);
      const want = [cfg.cover.ai.model, ...cfg.cover.ai.fallbacks]
        .filter(Boolean)
        .map(normalizeImageModelId);
      const absent = ids === null ? [] : want.filter((m) => !ids.includes(m));
      checks.push([
        "cover-model (图像模型)",
        ids !== null && absent.length === 0,
        ids === null
          ? `网关不可达（${gw.baseUrl}，源 ${gw.source}）— 跳过，发布时会自动降级`
          : absent.length
            ? `网关里没有：${absent.join(", ")}（可用图像模型：${ids.join(", ") || "无"}）`
            : `${want.join(" / ")} 存在 · 网关 ${gw.baseUrl}（${gw.source}）`,
      ]);
    }
  }
  const conv = spawnSync("convert", ["-version"], { encoding: "utf8" });
  checks.push(["imagemagick convert", conv.status === 0, (conv.stdout || "").split("\n")[0] ?? ""]);

  // LaTeX 公式 -> 内联 SVG（math.enabled 时发布链路会用到）
  {
    const tex = spawnSync("pdflatex", ["--version"], { encoding: "utf8" });
    const dvisvgm = spawnSync("dvisvgm", ["--version"], { encoding: "utf8" });
    checks.push([
      "latex 公式 (pdflatex+dvisvgm)",
      tex.status === 0 && dvisvgm.status === 0,
      `${(tex.stdout || "").split("\n")[0] ?? "pdflatex 缺失"} / ${(dvisvgm.stdout || "").split("\n")[0] ?? "dvisvgm 缺失"}`,
    ]);
    checks.push(["bin/tex2svg.py", exists(cfg.math.script), cfg.math.script]);
  }
  {
    // manim 只在 manim.enabled 时才真的会被调用，这里只提示状态。
    const manimBin = process.env.MANIM_BIN ?? "/opt/manim-venv/bin/manim";
    const m = spawnSync(manimBin, ["--version"], { encoding: "utf8" });
    checks.push([
      "manim",
      !cfg.manim.enabled || m.status === 0,
      [
        `bin/manim-gif.sh ${exists(cfg.math.manimScript) ? "✓" : "✗"}`,
        `manim ${m.status === 0 ? (m.stdout || "").trim().split("\n")[0] : "缺失"}`,
        `ffmpeg ${spawnSync("ffmpeg", ["-version"], { encoding: "utf8" }).status === 0 ? "✓" : "✗"}`,
        cfg.manim.enabled ? "已启用" : "未启用",
      ].join(" · "),
    ]);
  }
  const py = cfg.notify.email?.skill?.python ?? "python3";
  const pyv = spawnSync(py, ["--version"], { encoding: "utf8" });
  checks.push([py, pyv.status === 0, ((pyv.stdout || pyv.stderr || "").trim())]);
  const emailChk = checkEmail(cfg.notify.email);
  checks.push(["email (email-sender skill)", emailChk.ok, emailChk.detail]);

  const bchk = checkBrowser(cfg.browser);
  checks.push(["browser (Chrome CDP)", bchk.ok, bchk.detail]);

  // 谁拥有 Chrome（C1 Step5）：external = systemd unit 托管（重启 console 不影响登录态），
  // inline = console 自己 spawn（回滚态）。auto 判定见 browser.ts#describeBrowserMode。
  {
    const info = describeBrowserMode(cfg.account);
    // Only "declared external but the unit is missing" is a failure; inline
    // (explicit rollback, or auto on a host without units) is a normal state.
    const ok = !info.invalid && !(info.mode === "external" && info.unitPresent === false);
    checks.push(["browser 托管方式", ok, info.detail]);
  }

  // 会话三态 + 证据（C1 / R7）：doctor 必须能一眼看出“还剩多少小时 / 凭什么判定”。
  // 只读探测（不重载页面、不写计数器）— doctor 必须是幂等的。
  if (cfg.publishMethod === "browser") {
    const probe = await probeAccountSession({
      browser: cfg.browser,
      skillDir: cfg.skillDir,
      account: cfg.account,
      stateDir: cfg.paths.state,
      env: proxyEnv(cfg),
      revalidate: false,
      persist: false,
    });
    const cookie = probe.facts.cookie;
    const remain =
      cookie.ok && cookie.slaveSidExpiresAt !== undefined
        ? `${((cookie.slaveSidExpiresAt - Date.now() / 1000) / 3600).toFixed(1)}h`
        : cookie.ok
          ? cookie.slaveSidPresent === false
            ? "缺失"
            : "未知(会话cookie)"
          : "未知(读不到)";
    const keep = hoursSince(readProbeState(path.join(cfg.paths.state, "session-probe.json")).lastKeepaliveAt);
    const snaps = listSnapshots(cfg.account, { dataDir: cfg.paths.data }).length;
    checks.push([
      "mp-session",
      probe.verdict !== "invalid",
      `${probe.verdict} · slave_sid ${remain} · last keepalive ${keep === null ? "(无记录)" : `${keep.toFixed(1)}h ago`} · snapshots ${snaps} · evidence=${probe.evidence}`,
    ]);
  } else {
    checks.push(["mp-session", true, `n/a（publishMethod=${cfg.publishMethod}，无浏览器会话）`]);
  }

  // Per-account CDP ports must be unique, otherwise two accounts share one Chrome.
  const dupes = listAccounts()
    .map((a) => a.alias)
    .filter((al) => al !== cfg.account)
    .filter((al) => {
      try {
        return loadConfig(al).browser.cdpPort === cfg.browser.cdpPort;
      } catch {
        return false;
      }
    });
  checks.push(["CDP 端口唯一", dupes.length === 0, dupes.length ? `与 ${dupes.join(", ")} 冲突` : `:${cfg.browser.cdpPort}`]);

  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? "✅" : "❌"} ${name}${detail ? "  " + detail : ""}`);
  }
  console.log(`\naccount       : ${cfg.accountName} (${cfg.account})${cfg.accountAlias === cfg.defaultAccount ? "  [默认]" : ""}`);
  console.log(`publishMethod : ${cfg.publishMethod}`);
  console.log(`cdpPort       : ${cfg.browser.cdpPort}`);
  console.log(`dataDir       : ${cfg.paths.data}`);
  console.log(`content       : ${cfg.paths.content}`);
  console.log(`email to      : ${cfg.notify.email?.to?.join(", ") || "(skill default)"}`);
  console.log(`model.plan    : ${cfg.model.plan.model} (${cfg.model.plan.thinking})`);
  console.log(`model.article : ${cfg.model.article.model} (${cfg.model.article.thinking})`);
  console.log(`math (LaTeX)  : ${cfg.math.enabled ? `on  height=${cfg.math.height} scale=${cfg.math.scale}` : "off"}`);
  console.log(`manim (动图)  : ${cfg.manim.enabled ? `on  ${cfg.manim.width}px/${cfg.manim.fps}fps/max ${cfg.manim.maxMb}MB` : "off"}`);
}

main().catch((err) => {
  log.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
