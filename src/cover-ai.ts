/**
 * AI cover: article → structured visual brief → image model → exact-size PNG.
 *
 * Invariant (see .trellis/spec/engine/ai-determinism.md):
 *   AI decides *what to draw* and *which colours*.
 *   Code decides *how big, where, where to save, and what to do when it fails.*
 *
 * Nothing here throws into the publishing path. Every failure returns
 * `{ ok: false, reason }` so `publisher.ts` can fall back to the deterministic
 * gradient cover and still ship the article.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { averageColor, fitImageTo, imageSize, luminance, parseSize } from "./cover.ts";
import { log } from "./log.ts";
import { renderTemplate } from "./prompts.ts";
import { runPi } from "./pi.ts";

// ── types ──────────────────────────────────────────────────────────────────

export interface CoverBrief {
  subject: string;
  motif: string;
  palette: string[];
  mood: string;
  avoid?: string[];
}

export interface AiCoverSettings {
  model: string;
  fallbacks: string[];
  summaryModel?: string;
  gateway?: string;
  apiKey?: string;
  style: string;
  fallbackPalette: string[];
  overlayTitle: boolean;
  timeoutSec: number;
  maxTotalSec: number;
}

export interface SummaryInput {
  title: string;
  module: string;
  /** Raw article markdown; only a trimmed excerpt is sent to the model. */
  body: string;
  /** Prompt template file (`prompts/cover.md`). */
  promptFile: string;
  /** Text model used for the summary. Empty → let pi pick its default. */
  model?: string;
  fallbacks?: string[];
  piBin?: string;
  cwd?: string;
  timeoutSec?: number;
  thinking?: string;
  /** Palette for the deterministic fallback brief (from `cover.ai.fallbackPalette`). */
  palette?: string[];
}

export interface AiCoverInput {
  /** Final cover path — must be `<imgs>/<date>/cover.png` (setDraftCover contract). */
  outPath: string;
  /** Where the raw model output is kept for debugging. */
  rawPath?: string;
  /** Where the brief JSON is kept for auditing. */
  briefPath?: string;
  title: string;
  module: string;
  body: string;
  promptFile: string;
  settings: AiCoverSettings;
  size?: string;
  font?: string;
  subtitle?: string;
  piBin?: string;
  cwd?: string;
  summaryModel?: string;
  summaryFallbacks?: string[];
}

export interface AiCoverResult {
  ok: boolean;
  reason?: string;
  model?: string;
  brief?: CoverBrief;
  size?: { w: number; h: number };
  ms?: number;
}

// ── gateway resolution ─────────────────────────────────────────────────────

export interface ImageGateway {
  baseUrl: string;
  apiKey: string;
  source: string;
}

/** Strip a `provider/` prefix: the gateway wants `<group>:<model>`, pi wants `provider/group:model`. */
export function normalizeImageModelId(id: string): string {
  const t = (id ?? "").trim();
  if (!t) return t;
  const slash = t.lastIndexOf("/");
  if (slash === -1) return t;
  const tail = t.slice(slash + 1);
  return tail || t;
}

function piModelsJson(): any | undefined {
  const home = process.env.HOME ?? "/root";
  const candidates = [
    process.env.PI_MODELS_FILE,
    path.join(home, ".pi", "agent", "models.json"),
    path.join(home, ".config", "pi", "models.json"),
  ].filter(Boolean) as string[];
  for (const f of candidates) {
    try {
      if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
    } catch {
      /* try next */
    }
  }
  return undefined;
}

/**
 * Resolve the image gateway. Order: explicit config → env → pi's models.json
 * (`providers.meta-gateway`). Returns undefined instead of throwing: a missing
 * gateway is a downgrade, not an error.
 */
export function resolveImageGateway(opts: { gateway?: string; apiKey?: string } = {}): ImageGateway | undefined {
  const envUrl = process.env.COVER_IMAGE_BASE_URL;
  const envKey = process.env.COVER_IMAGE_API_KEY;
  if (opts.gateway && opts.apiKey) {
    return { baseUrl: opts.gateway, apiKey: opts.apiKey, source: "config" };
  }
  if (envUrl && envKey) return { baseUrl: envUrl, apiKey: envKey, source: "env" };

  const cfg = piModelsJson();
  const provider = cfg?.providers?.["meta-gateway"] ?? cfg?.providers?.metaGateway;
  const baseUrl: string | undefined = opts.gateway || envUrl || provider?.baseUrl;
  const rawKey: string | undefined = opts.apiKey || envKey || provider?.apiKey;
  if (!baseUrl || !rawKey) return undefined;
  const apiKey = rawKey.startsWith("$") ? process.env[rawKey.slice(1)] ?? "" : rawKey;
  if (!apiKey) return undefined;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, source: opts.gateway || envUrl ? "partial" : "pi-models.json" };
}

// ── brief parsing ──────────────────────────────────────────────────────────

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function asString(v: unknown, fallback: string): string {
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

/**
 * Leniently turn whatever the text model produced into a CoverBrief.
 * Models like to wrap JSON in ```json fences or prepend a sentence, and a bad
 * brief must never block publishing — so unknown/missing fields fall back.
 */
export function parseCoverBrief(text: string, fallbackPalette: string[] = ["#0F4C81", "#2D8AE0", "#FFD54F"]): CoverBrief | undefined {
  if (!text) return undefined;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  let parsed: any;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;

  const palette = Array.isArray(parsed.palette)
    ? parsed.palette.filter((c: unknown) => typeof c === "string" && HEX.test(c.trim())).map((c: string) => c.trim())
    : [];
  while (palette.length < 3) palette.push(fallbackPalette[palette.length] ?? "#4FC3F7");

  return {
    subject: asString(parsed.subject, ""),
    motif: asString(parsed.motif, "abstract-geometry"),
    palette: palette.slice(0, 3),
    mood: asString(parsed.mood, "冷静"),
    avoid: Array.isArray(parsed.avoid) ? parsed.avoid.filter((s: unknown) => typeof s === "string").slice(0, 3) : [],
  };
}

/** Deterministic brief used when the summary model is unavailable. */
export function fallbackBrief(title: string, palette: string[]): CoverBrief {
  return {
    subject: title.trim().slice(0, 30) || "几何图形与坐标轴",
    motif: "abstract-geometry",
    palette: [palette[0] ?? "#0F4C81", palette[1] ?? "#2D8AE0", palette[2] ?? "#FFD54F"],
    mood: "冷静",
    avoid: ["文字", "人脸"],
  };
}

export function buildImagePrompt(brief: CoverBrief, style: string): string {
  const palette = brief.palette.join("、");
  const avoid = ["任何文字", "字母", "数字", "水印", "logo", "人脸", ...(brief.avoid ?? [])].join("、");
  return [
    `${style}。`,
    `主体：${brief.subject}。`,
    `视觉类型：${brief.motif}。氛围：${brief.mood}。`,
    `背景：整幅画布纯色填充深色 ${brief.palette[0]}（必须深色，禁止白色/浅色/灰度背景）。`,
    `线条用 ${brief.palette[1]}，强调元素用 ${brief.palette[2]}（整体主色 ${palette}）。`,
    "构图：宽幅 2.35:1 横幅。主体必须**完整**位于画面中央，上下左右各留至少 12% 空白，任何线条都不得碰到或超出画面边缘。",
    "元素少而大：只画 1 个主体图形，不要密集网格、不要细小碎元素（会被裁切或被缩小后看不清）。",
    "画面内绝对不得出现任何字符：数字、字母、公式、汉字、刻度值、标注文字都不行；区间/范围用虚线、阴影或色块表达，不得用文字。",
    `禁止：${avoid}。`,
  ].join("\n");
}

// ── summary (text model) ───────────────────────────────────────────────────

/**
 * Ask the text model for the visual brief. Returns ok:false (never throws) when
 * pi fails or the reply has no parsable JSON, so the caller can use a
 * deterministic brief and still try the image model.
 */
export async function summarizeCoverBrief(
  input: SummaryInput,
): Promise<{ brief: CoverBrief; ok: boolean; reason?: string; usedModel?: string }> {
  const palette = input.palette ?? ["#0F4C81", "#2D8AE0", "#FFD54F"];
  // No text model configured → don't burn a pi call on an unknown default model.
  if (!input.model) {
    return { brief: fallbackBrief(input.title, palette), ok: false, reason: "no summary model configured" };
  }
  const excerpt = input.body
    .replace(/^---[\s\S]*?---/, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/<svg[\s\S]*?<\/svg>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1800);

  let prompt: string;
  try {
    prompt = renderTemplate(input.promptFile, { title: input.title, module: input.module, excerpt });
  } catch (err) {
    return { brief: fallbackBrief(input.title, palette), ok: false, reason: `prompt template: ${(err as Error).message}` };
  }

  const r = await runPi({
    prompt,
    cwd: input.cwd ?? process.cwd(),
    piBin: input.piBin,
    model: input.model,
    fallbackModels: input.fallbacks,
    thinking: input.thinking ?? "low",
    noSession: true,
    timeoutSec: input.timeoutSec ?? 180,
    idleTimeoutSec: input.timeoutSec ?? 180,
    retries: 0,
    chainBudgetSec: (input.timeoutSec ?? 180) + 30,
  });
  if (!r.ok) {
    return { brief: fallbackBrief(input.title, palette), ok: false, reason: `summary model failed: ${(r.error ?? "unknown").slice(0, 200)}` };
  }
  const brief = parseCoverBrief(r.finalText, palette);
  if (!brief) {
    return { brief: fallbackBrief(input.title, palette), ok: false, reason: "summary reply had no parsable JSON" };
  }
  return { brief, ok: true, usedModel: r.usedModel };
}

// ── image generation ───────────────────────────────────────────────────────

interface ImageGenResponse {
  data?: { b64_json?: string; url?: string; mime_type?: string }[];
  error?: { message?: string; code?: string; type?: string };
}

async function generateOneImage(
  gw: ImageGateway,
  model: string,
  prompt: string,
  size: string,
  timeoutSec: number,
): Promise<{ ok: true; b64: string } | { ok: false; reason: string; fatal: boolean }> {
  const url = `${gw.baseUrl}/images/generations`;
  const { w, h } = parseSize(size);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${gw.apiKey}` },
      body: JSON.stringify({ model, prompt, n: 1, size: `${w}x${h}` }),
      signal: AbortSignal.timeout(Math.max(10, timeoutSec) * 1000),
    });
    const text = await res.text();
    let body: ImageGenResponse = {};
    try {
      body = JSON.parse(text);
    } catch {
      /* keep raw text for the reason */
    }
    if (!res.ok) {
      const msg = body?.error?.message ?? text.slice(0, 200);
      // 404 / model_not_found / no-channel: retrying the same id is pointless.
      const fatal =
        res.status === 404 ||
        res.status === 400 ||
        /model_not_found|No available channel|does not exist/i.test(msg);
      return { ok: false, reason: `http ${res.status}: ${msg}`, fatal };
    }
    const item = body?.data?.[0];
    if (item?.b64_json) return { ok: true, b64: item.b64_json };
    if (item?.url) {
      const img = await fetch(item.url, { signal: AbortSignal.timeout(60_000) });
      if (!img.ok) return { ok: false, reason: `download ${img.status}`, fatal: false };
      const buf = Buffer.from(await img.arrayBuffer());
      return { ok: true, b64: buf.toString("base64") };
    }
    return { ok: false, reason: "response had no image", fatal: true };
  } catch (err) {
    const e = err as Error;
    const timedOut = e.name === "TimeoutError" || /timeout/i.test(e.message);
    return { ok: false, reason: timedOut ? `timeout after ${timeoutSec}s` : e.message.slice(0, 200), fatal: false };
  }
}

/** `GET /v1/models` → image-capable ids. Best-effort (doctor / selftest); null when unreachable. */
export async function listImageModels(gw: ImageGateway, timeoutSec = 15): Promise<string[] | null> {
  try {
    const res = await fetch(`${gw.baseUrl}/models`, {
      headers: { authorization: `Bearer ${gw.apiKey}` },
      signal: AbortSignal.timeout(timeoutSec * 1000),
    });
    if (!res.ok) return null;
    const body: any = await res.json();
    const ids: string[] = (body?.data ?? []).map((m: any) => String(m?.id ?? "")).filter(Boolean);
    return ids.filter((id) => /image|dall|flux|seedream|wanx|imagen|t2i/i.test(id));
  } catch {
    return null;
  }
}

/**
 * Full AI cover path. Returns `{ok:false, reason}` on any failure — the caller
 * is responsible for falling back to the deterministic renderer.
 */
export async function generateAiCover(input: AiCoverInput): Promise<AiCoverResult> {
  const t0 = Date.now();
  const size = input.size ?? "900x383";
  const s = input.settings;

  const gw = resolveImageGateway({ gateway: s.gateway, apiKey: s.apiKey });
  if (!gw) {
    return { ok: false, reason: "no image gateway (set cover.ai.gateway/apiKey, COVER_IMAGE_* env, or ~/.pi/agent/models.json)" };
  }

  // 1) brief — a summary failure is not fatal: fall back to a deterministic one.
  const sum = await summarizeCoverBrief({
    title: input.title,
    module: input.module,
    body: input.body,
    promptFile: input.promptFile,
    model: input.summaryModel ?? s.summaryModel,
    fallbacks: input.summaryFallbacks,
    piBin: input.piBin,
    cwd: input.cwd,
    timeoutSec: Math.min(s.timeoutSec, 180),
    palette: s.fallbackPalette,
  });
  if (!sum.ok) log.warn(`cover-ai: 摘要降级为确定性简报 (${sum.reason ?? "?"})`);
  const brief = sum.brief;
  if (input.briefPath) {
    try {
      fs.mkdirSync(path.dirname(input.briefPath), { recursive: true });
      fs.writeFileSync(input.briefPath, JSON.stringify({ brief, summaryOk: sum.ok, summaryReason: sum.reason, at: new Date().toISOString() }, null, 2) + "\n");
    } catch {
      /* audit file is best-effort */
    }
  }

  // 2) prompt — pure code, deterministic
  const prompt = buildImagePrompt(brief, s.style);

  // 3) images — try each model id, normalised for the gateway's `<group>:<model>` form.
  const chain = [s.model, ...(s.fallbacks ?? [])].filter(Boolean).map(normalizeImageModelId);
  const rawPath = input.rawPath ?? path.join(path.dirname(input.outPath), "cover-raw.png");
  const failures: string[] = [];
  const deadline = t0 + Math.max(30, s.maxTotalSec) * 1000;

  for (const model of chain) {
    if (Date.now() > deadline) {
      failures.push("total budget exhausted");
      break;
    }
    const remaining = Math.max(10, Math.round((deadline - Date.now()) / 1000));
    const budget = Math.min(s.timeoutSec, remaining);
    const started = Date.now();
    const r = await generateOneImage(gw, model, prompt, size, budget);
    if (r.ok) {
      const b64size = r.b64.length;
      try {
        fs.mkdirSync(path.dirname(rawPath), { recursive: true });
        fs.writeFileSync(rawPath, Buffer.from(r.b64, "base64"));
      } catch (err) {
        return { ok: false, reason: `write raw failed: ${(err as Error).message}` };
      }
      try {
        await fitImageTo(rawPath, input.outPath, size);
      } catch (err) {
        return { ok: false, reason: `fit failed: ${(err as Error).message}` };
      }
      const dim = imageSize(input.outPath);
      const want = parseSize(size);
      if (!dim || dim.w !== want.w || dim.h !== want.h) {
        return { ok: false, reason: `unexpected final size ${dim ? `${dim.w}x${dim.h}` : "?"} (want ${want.w}x${want.h})` };
      }
      const ms = Date.now() - t0;
      log.info(`cover-ai: model=${model} ${((Date.now() - started) / 1000).toFixed(1)}s b64=${b64size}B → ${dim.w}x${dim.h} (总 ${(ms / 1000).toFixed(1)}s)`);
      // Sanity probe: a light background means the model ignored the palette.
      // Non-blocking — the cover is still usable, but the log makes it visible.
      const avg = await averageColor(input.outPath);
      if (avg && luminance(avg) > 0.6) {
        log.warn(
          `cover-ai: 背景偏亮 (lum=${luminance(avg).toFixed(2)}) 模型可能忽略了深色底 ${brief.palette[0]} — 可改 style/重跑`,
        );
      }
      return { ok: true, model, brief, size: dim, ms };
    }
    failures.push(`${model}[${r.reason}]`);
    log.warn(`cover-ai: ${model} failed — ${r.reason}${r.fatal ? " (fatal, next model)" : ""}`);
  }

  return { ok: false, reason: `all image models failed: ${failures.join(" → ")}`, brief };
}

// ── helpers for tests / cli ────────────────────────────────────────────────

export function defaultAiSettings(overrides: Partial<AiCoverSettings> = {}): AiCoverSettings {
  return {
    model: "cn:hunyuan-image-alpha-edit",
    fallbacks: ["global:gpt-image-2.5-sunburst"],
    style: "扁平矢量插画，几何极简，教育科技感，构图简洁留白大",
    fallbackPalette: ["#0F4C81", "#2D8AE0", "#FFD54F"],
    overlayTitle: false,
    timeoutSec: 120,
    maxTotalSec: 300,
    ...overrides,
  };
}

/** Default prompt template location (`<APP_DIR>/prompts/cover.md`). */
export function defaultCoverPrompt(promptsDir: string): string {
  return path.join(promptsDir, "cover.md");
}

export const HOME_DIR = os.homedir();
