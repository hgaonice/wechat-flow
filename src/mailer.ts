import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { log } from "./log.ts";

/**
 * Email notifications are delegated to the pre-installed `email-sender` skill
 * (python3 + QQ SMTP, credentials in the skill's config.env):
 *
 *   python3 <skill>/scripts/send-mail.py -b "<body>" [-f <attach.md>] -s "<subject>" [-t <to>]
 *
 * When both -b and -f are given, the script uses -b as the (HTML-rendered)
 * body and -f as the `.md` attachment — exactly a "notification + article".
 */

export interface EmailSkillConfig {
  dir: string;
  python?: string;
}

export interface EmailConfig {
  enabled: boolean;
  /** Path to a 0600 credentials note file appended to every email body (host-local, never in git). */
  credentialsNotePath?: string;
  /** "publish" = only publish events; "all" = also weekly plan events. */
  on?: "publish" | "all";
  /** Override recipients; if empty the skill's default RECEIVER_EMAIL is used. */
  to?: string[];
  subjectPrefix?: string;
  attachArticle?: boolean;
  skill: EmailSkillConfig;
}

export interface MailInput {
  subject: string;
  body: string;
  /** Path to the article .md to attach (when attachArticle is enabled). */
  articlePath?: string;
}

function readCredentialsNote(p?: string): string {
  if (!p) return "";
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    return ""; // missing/unreadable note must never block the mail
  }
}

function scriptPath(cfg: EmailConfig): string {
  return path.join(cfg.skill.dir, "scripts", "send-mail.py");
}

export async function sendMail(cfg: EmailConfig, input: MailInput): Promise<boolean> {
  const py = cfg.skill.python ?? "python3";
  const script = scriptPath(cfg);

  if (!fs.existsSync(script)) {
    log.error(`email: skill script not found: ${script}`);
    return false;
  }

  const recipients = cfg.to?.length ? cfg.to : [undefined];
  const attach = cfg.attachArticle !== false && input.articlePath && fs.existsSync(input.articlePath);
  // Optional account/credentials block appended to the body (never committed;
  // read from a 0600 file on the host, one "label: value" per line).
  const note = readCredentialsNote(cfg.credentialsNotePath);
  const body = note ? `${input.body}\n\n──────\n账号信息\n${note}` : input.body;
  let allOk = true;

  for (const to of recipients) {
    const args: string[] = [script, "-b", body, "-s", input.subject];
    if (attach) args.push("-f", input.articlePath as string);
    if (to) args.push("-t", to);

    log.info(`email: ${py} ${script} -s "${input.subject}"${attach ? " (+md)" : ""}${to ? ` -t ${to}` : " (skill default recipient)"}`);

    const ok = await runOnce(py, args);
    if (!ok) allOk = false;
  }
  return allOk;
}

function runOnce(py: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(py, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));

    const timer = setTimeout(() => {
      stderr += "\n[email timeout] killing after 60s";
      child.kill("SIGKILL");
    }, 60_000);

    child.on("error", (err) => {
      clearTimeout(timer);
      log.error(`email: spawn error: ${err.message}`);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        log.info(`email: sent${stdout.trim() ? " — " + stdout.trim().split("\n")[0] : ""}`);
        resolve(true);
      } else {
        log.error(`email: skill failed (exit ${code}): ${(stderr || stdout).slice(0, 400)}`);
        resolve(false);
      }
    });
  });
}

/** Validate the email config and the email-sender skill. */
export function checkEmail(cfg: EmailConfig | undefined): { ok: boolean; detail: string } {
  if (!cfg) return { ok: false, detail: "not configured" };
  const script = scriptPath(cfg);
  if (!fs.existsSync(script)) return { ok: false, detail: `skill script missing: ${script}` };
  const skillCfg = path.join(cfg.skill.dir, "config.env");
  if (!fs.existsSync(skillCfg)) return { ok: false, detail: `skill config.env missing: ${skillCfg}` };
  const to = cfg.to?.length ? cfg.to.join(", ") : "(skill default)";
  return { ok: true, detail: `${cfg.skill.dir} → ${to}` };
}
