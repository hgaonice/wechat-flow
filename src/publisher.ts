import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "./config.ts";
import { runPi } from "./pi.ts";
import { renderTemplate } from "./prompts.ts";
import { publishArticle, publishArticleBrowser, verifyDraftPublished, verifyDraftBody, cleanupAppmsgTabs, setDraftCover } from "./wechat.ts";
import { ensureLoggedIn } from "./session.ts";
import { generateTemplateCover } from "./cover.ts";
import { prepareArticleForPublish } from "./media.ts";
import { findEntryForDate, proxyEnv, type PlanDay } from "./planner.ts";
import { isPublished, recordPublished } from "./state.ts";
import { todayInTz } from "./date.ts";
import { log } from "./log.ts";
import { notify } from "./notify.ts";

export interface PublishRunResult {
  date: string;
  skipped: boolean;
  reason?: string;
  ok: boolean;
  articlePath?: string;
  coverPath?: string;
  mediaId?: string;
  title?: string;
  error?: string;
}

function slugify(s: string, max = 40): string {
  const cleaned = s
    .trim()
    .replace(/[^\p{Script=Han}a-zA-Z0-9]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.slice(0, max) || "article";
}

export function parseFrontmatter(md: string): Record<string, string> {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

export async function runPublish(
  cfg: AppConfig,
  opts: { date?: string; dryRun?: boolean; reuse?: boolean; force?: boolean } = {},
): Promise<PublishRunResult> {
  const date = opts.date ?? todayInTz();
  const dryRun = opts.dryRun === true;

  const found = findEntryForDate(cfg, date);
  if (!found) {
    const msg = `no plan entry for ${date}; run "plan" first`;
    log.warn(msg);
    return { date, skipped: true, reason: msg, ok: false };
  }
  const { plan, day } = found;

  const existing = isPublished(cfg.paths.state, date);
  if (existing && !opts.reuse && !opts.force) {
    log.info(`already published ${date} (media_id=${existing.mediaId}); skip`);
    return { date, skipped: true, reason: "already published", ok: true, mediaId: existing.mediaId, title: existing.title };
  }

  const slug = slugify(day.topic);
  const articlePath = path.join(cfg.paths.articles, `${date}-${slug}.md`);
  const coverPath = path.join(cfg.paths.imgs, date, "cover.png");

  log.step(`publishing ${date} [${day.module}] ${day.topic}`);

  // 1) Generate the article Markdown with the pi agent.
  if (!(opts.reuse && fs.existsSync(articlePath))) {
    const prompt = renderTemplate(path.join(cfg.paths.prompts, "article.md"), {
      accountName: cfg.accountName,
      author: cfg.author,
      date,
      weekday: day.weekday,
      entryJson: JSON.stringify(day, null, 2),
      articlePath,
      imgsDir: path.join(cfg.paths.imgs, date),
      imgRefBase: "../imgs/" + date,
      mathEnabled: cfg.math.enabled ? "true" : "false",
      manimEnabled: cfg.manim.enabled ? "true" : "false",
    });
    const gen = await runPi({
      prompt,
      cwd: cfg.paths.content,
      piBin: cfg.piBin,
      model: cfg.model.article.model,
      thinking: cfg.model.article.thinking,
      fallbackModels: cfg.model.article.fallbacks,
      noSession: cfg.noSession,
      sessionId: cfg.noSession ? undefined : `math-article-${date}`,
      sessionDir: cfg.sessionDir,
      appendSystemPrompt: path.join(cfg.paths.prompts, "editor.md"),
      timeoutSec: cfg.timeoutSec.article,
      env: proxyEnv(cfg),
      onStderr: (s) => process.stderr.write(s),
    });
    if (!gen.ok) {
      const msg = `article generation failed: ${gen.error}`;
      log.error(msg);
      await notify(cfg, {
        kind: "publish",
        title: `❌ ${date} 文章生成失败`,
        body: `日期：${date}\n模块：${day.module}\n选题：${day.topic}\n错误：${gen.error}`,
      });
      return { date, skipped: false, ok: false, error: msg, articlePath };
    }
  }

  if (!fs.existsSync(articlePath)) {
    const msg = `article file missing: ${articlePath}`;
    log.error(msg);
    await notify(cfg, { kind: "publish", title: `❌ ${date} 文章文件缺失`, body: articlePath });
    return { date, skipped: false, ok: false, error: msg };
  }

  const md = fs.readFileSync(articlePath, "utf8");
  const fm = parseFrontmatter(md);
  const title = fm.title || day.titleSuggestion || day.topic;
  const summary = (fm.description || fm.summary || "").slice(0, 120) || undefined;
  const bodyWords = md.replace(/^---[\s\S]*?---/, "").replace(/\s/g, "").length;

  // 1.5) 发布前媒体预处理：LaTeX 公式 -> 内联 SVG；manim scene.py -> scene.gif
  const media = prepareArticleForPublish(cfg, articlePath, date);
  const publishFile = media.file;
  for (const w of media.warnings) log.warn(w);

  // 2) Cover image.
  if (!(opts.reuse && fs.existsSync(coverPath))) {
    await generateTemplateCover({
      outPath: coverPath,
      title,
      subtitle: `${cfg.accountName} · ${day.module}`,
      font: cfg.cover.font,
    });
  }

  // 3a) Browser method: make sure the MP session is alive (self-heal by emailing a QR).
  if (!dryRun && cfg.publishMethod === "browser") {
    const lg = await ensureLoggedIn({
      browser: cfg.browser,
      skillDir: cfg.skillDir,
      account: cfg.account,
      email: cfg.notify.email,
      qrOutPath: path.join(cfg.paths.state, "wechat-login-qr.png"),
      env: proxyEnv(cfg),
      waitSec: cfg.browser.loginWaitSec ?? 900,
    });
    if (lg.ok) {
      log.info(`wechat session: ${lg.detail}`);
    } else {
      const msg = `wechat login unavailable: ${lg.detail}`;
      log.error(msg);
      await notify(cfg, {
        kind: "publish",
        title: `❌ ${date} 公众号登录失效，未能发布《${title}》`,
        body: [
          `日期：${date}`,
          `标题：${title}`,
          `原因：${lg.detail}`,
          "",
          "已在失效时向邮箱发送了登录二维码；若二维码已过期，请手动执行：",
          "  cd /root/wechat-flow && bun src/cli.ts login",
          "然后重试：systemctl start wechat-publish.service",
        ].join("\n"),
      });
      return { date, skipped: false, ok: false, error: msg, articlePath, coverPath };
    }
  }

  // 3b) Publish (draft) via the baoyu skill script — API or browser (CDP).
  const pub =
    cfg.publishMethod === "browser"
      ? await publishArticleBrowser({
          file: publishFile,
          cwd: cfg.paths.content,
          skillDir: cfg.skillDir,
          browser: cfg.browser,
          bunBin: cfg.bunBin,
          account: cfg.account,
          theme: cfg.theme,
          color: cfg.color,
          title,
          author: cfg.author,
          summary,
          dryRun,
          env: proxyEnv(cfg),
        })
      : await publishArticle({
          file: publishFile,
          cwd: cfg.paths.content,
          bunBin: cfg.bunBin,
          skillDir: cfg.skillDir,
          account: cfg.account,
          theme: cfg.theme,
          color: cfg.color,
          cover: coverPath,
          title,
          author: cfg.author,
          summary,
          dryRun,
          env: proxyEnv(cfg),
        });

  // 3c) Draft cover (O-B). The skill's browser publish path does not set a
  // cover, so we do it ourselves on the same CDP session. Never fatal: if it
  // fails we keep the "select cover manually" reminder.
  let coverUploaded = false;
  if (!dryRun && cfg.publishMethod === "browser" && pub.ok) {
    // The skill's success toast is unreliable, so confirm against 草稿箱.
    const verified = await verifyDraftPublished(cfg.browser, cfg.skillDir, title);
    if (verified === true) {
      log.info("draft verified in 草稿箱 ✓");
      // A title in 草稿箱 is NOT proof of success: a draft can exist with a title
      // and an empty body (see verifyDraftBody). Always read the real body.
      const body = await verifyDraftBody(cfg.browser, cfg.skillDir, title, { minChars: 200 });
      if (body.ok === true) {
        log.info(`draft body verified ✓ ${body.detail}`);
        if (cfg.cover.uploadToDraft && fs.existsSync(coverPath)) {
          try {
            const cover = await setDraftCover({ browser: cfg.browser, skillDir: cfg.skillDir, title, coverPath });
            coverUploaded = cover.ok === true;
            if (coverUploaded) log.info(`draft cover set ✓ (${cover.detail})`);
            else log.warn(`封面自动上传未成功（${cover.stage ?? "?"}）：${cover.detail} — 请在后台手动选封面`);
          } catch (err) {
            log.warn(`封面自动上传异常：${err instanceof Error ? err.message : String(err)} — 请在后台手动选封面`);
          }
        }
      } else if (body.ok === false) {
        pub.ok = false;
        pub.error = `draft body empty/short: ${body.detail}`;
        log.error(pub.error);
      } else {
        log.warn(`draft body verification unavailable: ${body.detail}`);
      }
    } else if (verified === false) {
      pub.ok = false;
      pub.error = "draft not found in 草稿箱 after publish";
      log.error(pub.error);
    } else {
      log.warn("draft verification unavailable (CDP query failed) — relying on skill signal");
    }
    // The skill leaves the editor tab open; close it to avoid leaking tabs.
    try {
      const closed = await cleanupAppmsgTabs(cfg.browser, cfg.skillDir);
      if (closed) log.info(`closed ${closed} leftover editor tab(s)`);
    } catch {
      /* ignore */
    }
  }

  if (!pub.ok) {
    const msg = `publish failed: ${(pub.error ?? "").slice(0, 300)}`;
    log.error(msg);
    recordPublished(cfg.paths.state, {
      date, week: plan.week, topic: day.topic, title, file: articlePath,
      account: cfg.account, publishedAt: new Date().toISOString(), ok: false, error: msg,
    });
    await notify(cfg, {
      kind: "publish",
      title: `❌ ${date}《${title}》发布失败`,
      body: `日期：${date}\n模块：${day.module}\n标题：${title}\n正文：${articlePath}\n错误：${msg}`,
    });
    return { date, skipped: false, ok: false, error: msg, articlePath, coverPath };
  }

  if (dryRun) {
    log.info(`dry-run ok: ${title} words=${bodyWords} (not recorded, not published)`);
    await notify(cfg, {
      kind: "publish",
      title: `🧪 ${date} dry-run 成功《${title}》`,
      body: `日期：${date}\n标题：${title}\n状态：仅渲染测试，未发布、未记录\n字数：${bodyWords}`,
      articlePath,
    });
    return { date, skipped: false, ok: true, articlePath, coverPath, mediaId: undefined, title };
  }

  recordPublished(cfg.paths.state, {
    date, week: plan.week, topic: day.topic, title, file: articlePath,
    mediaId: pub.mediaId, account: cfg.account,
    publishedAt: new Date().toISOString(), ok: true,
  });

  log.info(`done: ${title} media_id=${pub.mediaId ?? "(draft)"} words=${bodyWords}`);
  await notify(cfg, {
    kind: "publish",
    title: `✅ ${date} 已推送到草稿箱《${title}》`,
    body: [
      `日期：${date} ${day.weekday}`,
      `模块：${day.module}`,
      `选题：${day.topic}`,
      `标题：${title}`,
      `字数：${bodyWords}`,
      `account：${cfg.account}（${cfg.accountName}）`,
      `发布方式：${cfg.publishMethod === "browser" ? "浏览器（CDP）" : "API"}`,
      media.formulaRendered ? `公式：${media.formulaRendered} 条已渲染为内联 SVG` : "",
      media.gif ? `动图：${path.basename(media.gif)}` : "",
      ...media.warnings.map((w) => `⚠️ ${w}`),
      pub.mediaId ? `media_id：${pub.mediaId}` : coverUploaded ? `封面：已自动设置（${path.basename(coverPath)}）` : `cover：${coverPath}（草稿中需手动选为封面）`,
      `正文：${articlePath}`,
      `时间：${new Date().toISOString()}`,
      "",
      "状态：已在公众号「草稿箱」（已通过后台接口校验），请登录公众号后台确认内容" + (coverUploaded ? "并群发。" : "、设置封面并群发。"),
    ].filter(Boolean).join("\n"),
    articlePath,
  });
  return { date, skipped: false, ok: true, articlePath, coverPath, mediaId: pub.mediaId, title };
}
