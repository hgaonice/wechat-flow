import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "./config.ts";
import { runPi, listAvailableModels, missingModels } from "./pi.ts";
import { renderTemplate } from "./prompts.ts";
import { isoWeek, weekRange, todayInTz, weekdayCn } from "./date.ts";
import { log } from "./log.ts";
import { notify } from "./notify.ts";

export interface PlanDay {
  date: string;
  weekday: string;
  module: string;
  topic: string;
  grade?: string;
  difficulty?: string;
  angle?: string;
  titleSuggestion?: string;
  outline?: string[];
  coverHint?: string;
}

export interface Plan {
  week: string;
  generatedAt: string;
  account: string;
  days: PlanDay[];
}

export function planPath(cfg: AppConfig, week: string): string {
  return path.join(cfg.paths.plans, `${week}.json`);
}

export function loadPlan(file: string): Plan {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Plan;
}

export function findEntryForDate(cfg: AppConfig, date: string): { plan: Plan; day: PlanDay } | undefined {
  if (!fs.existsSync(cfg.paths.plans)) return undefined;
  for (const f of fs.readdirSync(cfg.paths.plans)) {
    if (!f.endsWith(".json")) continue;
    try {
      const plan = loadPlan(path.join(cfg.paths.plans, f));
      const day = plan.days?.find((d) => d.date === date);
      if (day) return { plan, day };
    } catch {
      /* skip malformed */
    }
  }
  return undefined;
}

function validatePlan(plan: Plan, week: string): string[] {
  const errors: string[] = [];
  if (!plan || typeof plan !== "object") errors.push("plan is not an object");
  if (plan?.week !== week) errors.push(`week mismatch: ${plan?.week} != ${week}`);
  if (!Array.isArray(plan?.days) || plan.days.length !== 7) {
    errors.push(`expected 7 days, got ${plan?.days?.length}`);
  } else {
    for (const d of plan.days) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date ?? "")) errors.push(`bad date: ${d.date}`);
      if (!d.topic) errors.push(`missing topic for ${d.date}`);
      if (!d.weekday) d.weekday = weekdayCn(d.date);
    }
  }
  return errors;
}

export async function runPlan(cfg: AppConfig, opts: { date?: string; dryRun?: boolean } = {}): Promise<Plan> {
  const baseDate = opts.date ?? todayInTz();
  const week = isoWeek(baseDate);
  const { monday, sunday } = weekRange(baseDate);
  const outPath = planPath(cfg, week);
  // 预演时写到旁路文件：否则 --dry-run 也会把本周计划覆盖掉（agent 才是写文件的人）。
  const writePath = opts.dryRun ? outPath.replace(/\.json$/, ".dryrun.json") : outPath;
  const syllabus = path.join(cfg.paths.content, "syllabus.md");
  const published = path.join(cfg.paths.state, "published.json");

  log.step(`planning week ${week} (${monday}~${sunday}) -> ${writePath}${opts.dryRun ? " [dry-run]" : ""}`);

  const prompt = renderTemplate(path.join(cfg.paths.prompts, "plan.md"), {
    week,
    weekStart: monday,
    weekEnd: sunday,
    syllabusPath: syllabus,
    publishedPath: published,
    planPath: writePath,
    account: cfg.account,
    accountName: cfg.accountName,
  });

  const absent = missingModels(
    [cfg.model.plan.model, ...(cfg.model.plan.fallbacks ?? [])],
    listAvailableModels(cfg.piBin),
  );
  if (absent.length) {
    log.warn(`model config has unknown id(s): ${absent.join(", ")} — run "doctor" and fix model.fallbacks`);
  }

  const result = await runPi({
    prompt,
    cwd: cfg.paths.content,
    piBin: cfg.piBin,
    model: cfg.model.plan.model,
    thinking: cfg.model.plan.thinking,
    fallbackModels: cfg.model.plan.fallbacks,
    noSession: cfg.noSession,
    sessionId: cfg.noSession ? undefined : `wechat-plan-${week}`,
    sessionDir: cfg.sessionDir,
    appendSystemPrompt: path.join(cfg.paths.prompts, "editor.md"),
    timeoutSec: cfg.timeoutSec.plan,
    env: proxyEnv(cfg),
    onStderr: (s) => process.stderr.write(s),
  });

  if (!result.ok) {
    log.error(`pi plan run failed: ${result.error}`);
    await notify(cfg, {
      kind: "plan",
      title: `❌ ${week} 周编排失败`,
      body: `${result.error}\n${result.stderr.slice(-400)}`,
    });
    throw new Error(`planner agent failed: ${result.error}`);
  }

  if ((result.chain?.length ?? 0) > 1) {
    log.warn(`plan degraded to ${result.usedModel ?? "(default)"} after ${result.chain!.length - 1} failed attempt(s)`);
  }

  if (!fs.existsSync(writePath)) {
    const msg = `planner did not write ${writePath}`;
    log.error(msg);
    await notify(cfg, { kind: "plan", title: `❌ ${week} 周编排未产出计划文件`, body: msg });
    throw new Error(msg);
  }

  const plan = loadPlan(writePath);
  const errors = validatePlan(plan, week);
  if (errors.length) {
    log.error(`plan validation failed: ${errors.join("; ")}`);
    await notify(cfg, { kind: "plan", title: `❌ ${week} 周计划校验失败`, body: errors.join("; ") });
    throw new Error(`invalid plan: ${errors.join("; ")}`);
  }

  if (opts.dryRun) {
    // 预演：校验通过就丢掉旁路文件，不动本周真实计划
    try {
      fs.unlinkSync(writePath);
    } catch {
      /* ignore */
    }
    log.info(`dry-run: plan generated and validated, 未写入 ${outPath}`);
  }
  const topics = plan.days.map((d) => `${d.date} ${d.weekday} [${d.module}] ${d.topic}`).join("\n");
  log.info(`plan OK:\n${topics}`);
  await notify(cfg, {
    kind: "plan",
    title: opts.dryRun ? `✅ ${week} 周计划预演通过（未写入）` : `✅ ${week} 周计划已生成（共 7 篇）`,
    body: topics,
  });
  return plan;
}

export function proxyEnv(cfg: AppConfig): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  if (cfg.proxy?.httpProxy) env.http_proxy = cfg.proxy.httpProxy;
  if (cfg.proxy?.httpsProxy) env.https_proxy = cfg.proxy.httpsProxy;
  if (cfg.proxy?.noProxy) {
    env.no_proxy = cfg.proxy.noProxy;
    env.NO_PROXY = cfg.proxy.noProxy;
  }
  return env;
}
