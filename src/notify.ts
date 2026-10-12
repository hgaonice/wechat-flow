import { log } from "./log.ts";
import type { AppConfig } from "./config.ts";
import { sendMail } from "./mailer.ts";

export interface NotifyMessage {
  /** Short subject line. */
  title: string;
  /** Multi-line body. */
  body: string;
  kind?: "plan" | "publish" | "test";
  /** Article .md to attach to the email (when attachArticle is enabled). */
  articlePath?: string;
}

export async function notify(cfg: AppConfig, msg: NotifyMessage): Promise<void> {
  const anyChannel =
    cfg.notify.enabled ||
    cfg.notify.email?.enabled === true ||
    Boolean(cfg.notify.telegram?.botToken && cfg.notify.telegram?.chatId);
  if (!anyChannel) return;
  await Promise.all([sendTelegram(cfg, msg), sendEmail(cfg, msg)]);
}

async function sendTelegram(cfg: AppConfig, msg: NotifyMessage): Promise<void> {
  const tg = cfg.notify.telegram;
  if (!tg?.botToken || !tg?.chatId) return;
  try {
    const text = msg.body ? `${msg.title}\n${msg.body}` : msg.title;
    const resp = await fetch(`https://api.telegram.org/bot${tg.botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: tg.chatId, text, disable_web_page_preview: true }),
    });
    if (!resp.ok) log.warn(`telegram notify failed: HTTP ${resp.status}`);
  } catch (err) {
    log.warn(`telegram notify error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function sendEmail(cfg: AppConfig, msg: NotifyMessage): Promise<void> {
  const email = cfg.notify.email;
  if (!email?.enabled) return;

  const kind = msg.kind ?? "publish";
  const on = email.on ?? "publish";
  if (kind !== "test" && on === "publish" && kind !== "publish") return;

  const subject = `${email.subjectPrefix ?? ""}${msg.title}`;
  await sendMail(email, {
    subject,
    body: msg.body || msg.title,
    articlePath: msg.articlePath,
  });
}
