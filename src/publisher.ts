import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "./config.ts";
import { runPi, listAvailableModels, missingModels } from "./pi.ts";
import { renderTemplate } from "./prompts.ts";
import { publishArticle, publishArticleBrowser, verifyDraftPublished, verifyDraftBody, cleanupAppmsgTabs, setDraftCover } from "./wechat.ts";
import { ensureLoggedIn, focusMpTab } from "./session.ts";
import { generateFfmpegCover, generateTemplateCover } from "./cover.ts";
import { generateAiCover } from "./cover-ai.ts";
import { prepareArticleForPublish } from "./media.ts";
import { applyCtaToArticle } from "./cta.ts";
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

/** Result of a standalone article generation (no push) — shared with the console. */
export interface ArticleGenResult {
  ok: boolean;
  date: string;
  articlePath: string;
  title?: string;
  error?: string;
  /** True when an existing base file was reused (no pi call). */
  reused?: boolean;
}

/**
 * Build the article prompt. `feedback`, when non-empty, is appended as a
 * dedicated section so a regenerate can steer the model. With empty/absent
 * feedback the output is byte-identical to the original inline prompt.
 * Exported so tests can prove that byte-equality (I3-1).
 */
export function buildArticlePrompt(
  cfg: AppConfig,
  day: PlanDay,
  date: string,
  articlePath: string,
  feedback?: string,
): string {
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
  const extra = feedback?.trim();
  if (!extra) return prompt;
  return `${prompt}\n\n## 修改要求（用户反馈）\n${extra}\n`;
}

/**
 * Generate (or reuse) the article Markdown for a date — extracted verbatim
 * from the old inline block in `runPublish` (C3/D1, pure extraction). It does
 * NOT push anything; the publish pipeline stays the only push path (H1).
 */
export async function runArticleGeneration(
  cfg: AppConfig,
  opts: { date?: string; feedback?: string; reuse?: boolean } = {},
): Promise<ArticleGenResult> {
  const date = opts.date ?? todayInTz();
  const found = findEntryForDate(cfg, date);
  if (!found) {
    const msg = `no plan entry for ${date}; run "plan" first`;
    log.warn(msg);
    return { ok: false, date, articlePath: "", error: msg };
  }
  const { day } = found;
  const slug = slugify(day.topic);
  const articlePath = path.join(cfg.paths.articles, `${date}-${slug}.md`);
  const reused = opts.reuse === true && fs.existsSync(articlePath);

  if (!reused) {
    // Config drift guard (B4): a fallback id that does not exist on this host
    // silently burns a retry round every single failure. Never fatal.
    const absent = missingModels(
      [cfg.model.article.model, ...(cfg.model.article.fallbacks ?? [])],
      listAvailableModels(cfg.piBin),
    );
    if (absent.length) {
      log.warn(`model config has unknown id(s): ${absent.join(", ")} — run "doctor" and fix model.fallbacks`);
    }

    const prompt = buildArticlePrompt(cfg, day, date, articlePath, opts.feedback);
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
      return { ok: false, date, articlePath, error: msg };
    }
    // Degradation is not silent: the article is fine, but the user must know
    // that the primary model was down (repeated degradation = upstream problem).
    if ((gen.chain?.length ?? 0) > 1) {
      const failed = (gen.chain ?? []).filter((a) => a.class !== "ok");
      log.warn(`degraded to ${gen.usedModel ?? "(default)"} after ${failed.length} failed attempt(s)`);
      await notify(cfg, {
        kind: "publish",
        title: `⚠️ ${date} 已降级到 ${gen.usedModel ?? "默认模型"}`,
        body: [
          `日期：${date}`,
          `模块：${day.module}`,
          `实际使用：${gen.usedModel ?? "(default)"}`,
          "失败链路：",
          ...failed.map((a) => `  - ${a.model ?? "(default)"} [${a.class}] ${a.error ?? ""}`.slice(0, 200)),
        ].join("\n"),
      });
    }
  }

  if (!fs.existsSync(articlePath)) {
    const msg = `article file missing: ${articlePath}`;
    log.error(msg);
    await notify(cfg, { kind: "publish", title: `❌ ${date} 文章文件缺失`, body: articlePath });
    return { ok: false, date, articlePath, error: msg };
  }

  // 确定性补齐文章末尾的互动引导语（唯一注入点；生成 / --reuse / 控制台三条路径都经过这里）。
  // 永不抛错：异常时降级为 skipped，文章主体照常发布（R6）。
  const cta = applyCtaToArticle(cfg, articlePath);
  log.info(`cta: ${cta.action} (${cta.detail})`);

  const fm = parseFrontmatter(fs.readFileSync(articlePath, "utf8"));
  const title = fm.title || day.titleSuggestion || day.topic;
  return { ok: true, date, articlePath, title, reused };
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
  // Only a *successful* record counts as "already published". A failed attempt
  // also writes a record (ok=false) so the retry must not be short-circuited —
  // doing so reported `ok:true, skipped:"already published"` on a day that was
  // never published, permanently blocking the scheduler's retry.
  if (existing?.ok === true && !opts.reuse && !opts.force) {
    log.info(`already published ${date} (media_id=${existing.mediaId}); skip`);
    return { date, skipped: true, reason: "already published", ok: true, mediaId: existing.mediaId, title: existing.title };
  }

  const slug = slugify(day.topic);
  const articlePath = path.join(cfg.paths.articles, `${date}-${slug}.md`);
  const coverPath = path.join(cfg.paths.imgs, date, "cover.png");

  log.step(`publishing ${date} [${day.module}] ${day.topic}`);

  // 1) Generate the article Markdown with the pi agent (extracted → shared with console/C3).
  const genResult = await runArticleGeneration(cfg, { date, reuse: opts.reuse });
  if (!genResult.ok) {
    return { date, skipped: false, ok: false, error: genResult.error, articlePath: genResult.articlePath || articlePath };
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
  //    mode "ai"      → AI brief + image model, deterministic 900x383 crop.
  //    mode "ffmpeg"  → lavfi gradient (also the AI fallback).
  //    mode "template"→ ImageMagick (final fallback).
  //    Every branch is non-fatal except the last one, and even that is caught
  //    by the caller: a cover problem must never block the article.
  let coverNote: string | undefined;
  if (!(opts.reuse && fs.existsSync(coverPath))) {
    const coverInput = {
      outPath: coverPath,
      title,
      subtitle: `${cfg.accountName} · ${day.module}`,
      font: cfg.cover.font,
      size: cfg.cover.size,
    };
    let done = false;
    if (cfg.cover.mode === "ai") {
      const ai = await generateAiCover({
        outPath: coverPath,
        rawPath: path.join(cfg.paths.imgs, date, "cover-raw.png"),
        briefPath: path.join(cfg.paths.imgs, date, "cover-brief.json"),
        title,
        module: day.module,
        body: md,
        promptFile: path.join(cfg.paths.prompts, "cover.md"),
        settings: cfg.cover.ai,
        size: cfg.cover.size,
        font: cfg.cover.font,
        summaryModel: cfg.cover.ai.summaryModel || cfg.model.article.model,
        summaryFallbacks: cfg.cover.ai.summaryModel ? [] : cfg.model.article.fallbacks,
        piBin: cfg.piBin,
        cwd: path.dirname(cfg.paths.data),
        // Observability + cost guardrail (C2 §C-3/C-4): per-account state dir + the
        // article date (not UTC now) so the daily budget rolls over with the article.
        stateDir: cfg.paths.state,
        date,
      });
      if (ai.ok) {
        done = true;
        log.info(`cover: AI 生成（${ai.model}，${ai.brief?.subject ?? ""}）`);
      } else {
        coverNote = `AI 封面失败，已回落渐变：${ai.reason}`;
        log.warn(`cover-ai failed, falling back to ffmpeg: ${ai.reason}`);
      }
    }
    if (!done) {
      try {
        await generateFfmpegCover(coverInput);
      } catch (err) {
        log.warn(`ffmpeg cover failed, falling back to template: ${(err as Error).message}`);
        await generateTemplateCover(coverInput);
      }
    }
  }
  if (coverNote) {
    try {
      await notify(cfg, { kind: "publish", title: `⚠️ ${date} 封面降级`, body: coverNote });
    } catch {
      /* notification is best-effort */
    }
  }

  // 3a) Browser method: make sure the MP session is alive (self-heal by emailing a QR).
  if (!dryRun && cfg.publishMethod === "browser") {
    // Drop leftover appmsg/editor tabs first. The skill reuses an existing
    // mp.weixin.qq.com tab, and a stale editor tab from an earlier failed run is
    // typically a dead "登录超时" page with no #title → "Editor did not load".
    try {
      const closed = await cleanupAppmsgTabs(cfg.browser, cfg.skillDir);
      if (closed) log.info(`closed ${closed} stale editor tab(s) before publish`);
    } catch {
      /* tab hygiene must never block publishing */
    }
    const lg = await ensureLoggedIn({
      browser: cfg.browser,
      skillDir: cfg.skillDir,
      account: cfg.account,
      email: cfg.notify.email,
      qrOutPath: path.join(cfg.paths.state, "wechat-login-qr.png"),
      stateDir: cfg.paths.state,
      env: proxyEnv(cfg),
      waitSec: cfg.browser.loginWaitSec ?? 900,
    });
    if (lg.ok) {
      log.info(`wechat session: ${lg.detail}`);
      // The skill opens the editor with a popup from the 「文章」 menu, which
      // Chrome only allows for a VISIBLE tab. Two Chrome windows share one Xvfb
      // display, so this tab can be occluded (visibilityState=hidden) and the
      // click then dies with "New tab not found: mp.weixin.qq.com".
      const vis = await focusMpTab(cfg.browser, cfg.skillDir);
      if (vis) log.info(`MP tab visibility: ${vis}`);
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
    // Leave no dead editor tab behind for the next retry to attach to.
    if (!dryRun && cfg.publishMethod === "browser") {
      try {
        await cleanupAppmsgTabs(cfg.browser, cfg.skillDir);
      } catch {
        /* ignore */
      }
    }
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
