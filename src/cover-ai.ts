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
 *
 * Side channels (both optional, keyed off `AiCoverInput.stateDir`):
 *   `<stateDir>/cover-model-stats.json` — last ok/fail per model, for `doctor`.
 *   `<stateDir>/cover-budget.json`      — `cover.ai.dailyBudget` counter.
 * Neither may ever turn a working cover into a failed one: write errors are WARNs.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { averageColor, fitImageTo, fitImageToContent, imageSize, luminance, parseSize } from "./cover.ts";
import { POSTER_CANVAS, buildPosterPrompt, missingPosterFields, type PosterCopy } from "./cover-poster.ts";
import { log } from "./log.ts";
import { renderTemplate } from "./prompts.ts";
import { runPi } from "./pi.ts";
import { atomicWriteJson } from "./state.ts";

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
  /**
   * 封面生成路线（默认 `illustration`，与旧行为逐字节一致）：
   *   illustration = 文本模型产出视觉简报 → 图像模型画「无字几何插画」；
   *   poster       = **不调文本模型**，直接用 module/topic/title 拼确定性文案 → 教辅海报风。
   * poster 缺少任一文案字段时**显式回落** illustration（并不静默降级）。
   */
  layout?: "illustration" | "poster";
  fallbackPalette: string[];
  overlayTitle: boolean;
  timeoutSec: number;
  maxTotalSec: number;
  /**
   * Cost guardrail: max AI cover generations per article date per account.
   * `0` (default) = unlimited — i.e. the pre-guardrail behaviour.
   * Counted per *article* (one `generateAiCover()` call), not per model attempt.
   */
  dailyBudget?: number;
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
  /** 选题（plans 的 `topic`），poster 路线必填；illustration 路线忽略。 */
  topic?: string;
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
  /**
   * Per-account state dir (`cfg.paths.state`). When set, model stats
   * (`cover-model-stats.json`) and the daily budget counter (`cover-budget.json`)
   * are persisted there. Omitted → no side effects (backward compatible).
   */
  stateDir?: string;
  /** Article date `YYYY-MM-DD`; drives budget day rollover. Defaults to local date. */
  date?: string;
}

export interface AiCoverResult {
  ok: boolean;
  reason?: string;
  model?: string;
  brief?: CoverBrief;
  /** poster 路线实际用到的确定性文案（供日志/审计回读） */
  poster?: PosterCopy;
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

/**
 * Some gateways/models refuse the cover-sized request outright instead of snapping it.
 * Measured 2026-10-20 on the 250 gateway: `global:gpt-image-2.5-sunburst` returns
 * `invalid_value: Invalid size '900x383'` (divisible-by-16 / minimum pixel budget),
 * while the same model happily renders `1536x1024` in ~24s. Without this escalation the
 * whole second AI fallback was dead in production and only surfaced as a generic
 * 502 after the 180s budget — the deterministic crop (`fitImageTo`) can always bring a
 * bigger canvas back to 900x383, so retrying bigger is free of risk.
 */
export const SIZE_ESCALATION = "1536x1024";

export function isSizeRejection(reason: string): boolean {
  // Deliberately *size*-specific: a blanket `invalid[_ ]value.*size` also matched
  // unrelated 400s (e.g. `invalid value for 'steps': … size 1024x1024 ok`) and each
  // false positive burns a 1536x1024 retry (25–74s). Real strings matched here are
  // quoted verbatim in tools/cover-selftest.ts §10 (captured from the 250 gateway).
  return /divisible by 16|invalid size|unsupported size|invalid resolution|unsupported resolution|size (?:must be|is not supported|not supported|is invalid|is unsupported)|invalid[_ ]value for ['"]?size|below the current minimum pixel|resolution is below|width and height must/i.test(
    reason,
  );
}

export async function generateOneImage(
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
    return ids.filter((id) => /image|dall|flux|seedream|wanx|imagen|t2i|cogview|kolors|hunyuan-image|sd3|sdxl/i.test(id));
  } catch {
    return null;
  }
}

// ── observability: per-model stats (doctor) ────────────────────────────────
//
// Why this exists: image models fail in ways that only show up in the publish log
// (`all image models failed: …`), i.e. after the article already shipped with a
// fallback cover. Recording the last ok/fail per model lets `doctor` answer
// "is model X still alive, and why did it die" without a real image request.
//
// A model can be *reachable but unusable* (e.g. `cogview-3-flash` renders but
// ignores the palette and stamps an "AI生成" watermark). Those are still `ok:true`
// here — this file is about availability, the brief-conformance judgement lives in
// tools/cover-selftest.ts + human review. `lastFailReason` is kept verbatim
// (redacted + truncated) so "429 no quota" stays distinguishable from "model missing".

export interface CoverModelStat {
  /** ISO timestamp of the last successful image generation. */
  lastOkAt?: string;
  /** Latency of that success, milliseconds. */
  lastOkMs?: number;
  /** ISO timestamp of the last failure. */
  lastFailAt?: string;
  /** Redacted, ≤200 chars — the gateway's own words, so the cause survives. */
  lastFailReason?: string;
  okCount: number;
  failCount: number;
}

export type CoverModelStats = Record<string, CoverModelStat>;

export const COVER_STATS_FILE = "cover-model-stats.json";
export const COVER_BUDGET_FILE = "cover-budget.json";

/** Absolute path of the per-model stats file (`<stateDir>/cover-model-stats.json`). */
export function coverStatsPath(stateDir: string): string {
  return path.join(stateDir, COVER_STATS_FILE);
}

/** Absolute path of the daily budget counter (`<stateDir>/cover-budget.json`). */
export function coverBudgetPath(stateDir: string): string {
  return path.join(stateDir, COVER_BUDGET_FILE);
}

/** Local-timezone `YYYY-MM-DD`; the article date wins when the caller already knows it. */
export function localDateStr(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Strip credential-looking substrings before anything is persisted.
 * The gateway happily echoes `Authorization: Bearer …` back inside 401/403 bodies.
 * (Deliberately duplicated from the probe tool: `src/` must not import `tools/`.)
 */
export function redactCoverReason(input: string, known: (string | undefined)[] = []): string {
  let s = String(input ?? "");
  for (const secret of known) {
    const k = (secret ?? "").trim();
    if (k.length >= 6) s = s.split(k).join("***");
  }
  s = s.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, "Bearer ***");
  s = s.replace(/\bsk-[A-Za-z0-9._-]{4,}/g, "sk-***");
  s = s.replace(
    /((?:api[_-]?key|x-api-key|apikey|token|access[_-]?token|authorization)["'\s]*[:=]\s*["']?)([A-Za-z0-9._~+/=-]{8,})/gi,
    "$1***",
  );
  return s;
}

function clipText(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Tolerant read: a corrupt/missing file must never break a cover or `doctor`. */
export function readCoverModelStats(stateDir: string | undefined): CoverModelStats {
  const out: CoverModelStats = {};
  if (!stateDir) return out;
  try {
    const file = coverStatsPath(stateDir);
    if (!fs.existsSync(file)) return out;
    const raw: any = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object") return out;
    for (const [model, v] of Object.entries<any>(raw)) {
      if (!v || typeof v !== "object") continue;
      out[model] = {
        lastOkAt: typeof v.lastOkAt === "string" ? v.lastOkAt : undefined,
        lastOkMs: typeof v.lastOkMs === "number" && Number.isFinite(v.lastOkMs) ? v.lastOkMs : undefined,
        lastFailAt: typeof v.lastFailAt === "string" ? v.lastFailAt : undefined,
        lastFailReason: typeof v.lastFailReason === "string" ? v.lastFailReason : undefined,
        okCount: Math.max(0, Math.floor(Number(v.okCount) || 0)),
        failCount: Math.max(0, Math.floor(Number(v.failCount) || 0)),
      };
    }
  } catch {
    /* best-effort: stats are observability, never a dependency */
  }
  return out;
}

/**
 * Record one model attempt (success or failure). Never throws: a read-only or
 * full state dir must not turn a working cover into a failed one.
 * No `stateDir` → no-op (callers that don't pass one keep the old behaviour).
 */
export function recordCoverModelStat(
  stateDir: string | undefined,
  model: string,
  result: { ok: boolean; ms: number; reason?: string },
  opts: { now?: Date; apiKey?: string } = {},
): void {
  if (!stateDir || !model) return;
  try {
    const all = readCoverModelStats(stateDir);
    const prev = all[model] ?? { okCount: 0, failCount: 0 };
    const at = (opts.now ?? new Date()).toISOString();
    const ms = Math.max(0, Math.round(Number(result.ms) || 0));
    all[model] = result.ok
      ? { ...prev, lastOkAt: at, lastOkMs: ms, okCount: prev.okCount + 1 }
      : {
          ...prev,
          lastFailAt: at,
          lastFailReason: clipText(redactCoverReason(result.reason ?? "unknown", [opts.apiKey]), 200),
          failCount: prev.failCount + 1,
        };
    atomicWriteJson(coverStatsPath(stateDir), all);
  } catch (err) {
    log.warn(`cover-ai: 写 ${COVER_STATS_FILE} 失败（不影响出图）：${(err as Error).message}`);
  }
}

// ── cost guardrail: daily AI cover budget ──────────────────────────────────

export interface CoverBudget {
  /** Article date the counter belongs to (`YYYY-MM-DD`). */
  date: string;
  used: number;
}

/**
 * Read the counter for `date`. A counter belonging to another date reads as 0 —
 * that *is* the cross-day rollover (the next `consumeCoverBudget` rewrites the file
 * with the new date), so no timer and no timezone arithmetic is involved.
 *
 * Corrupt / unreadable / non-numeric counter → read as 0 (the next consume rewrites a
 * valid file, so it self-heals) but **with a WARN**, because a silent reset is exactly
 * the "guardrail quietly turned itself off" failure mode. The date mismatch stays
 * silent: that is the intended rollover.
 */
export function readCoverBudget(stateDir: string | undefined, date: string): CoverBudget {
  if (!stateDir) return { date, used: 0 };
  const file = coverBudgetPath(stateDir);
  let text: string;
  try {
    if (!fs.existsSync(file)) return { date, used: 0 };
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    log.warn(`cover-ai: 读 ${COVER_BUDGET_FILE} 失败，本次按 0 计（护栏可能失效）：${(err as Error).message}`);
    return { date, used: 0 };
  }
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    log.warn(`cover-ai: ${COVER_BUDGET_FILE} 不是合法 JSON，本次按 0 计并会在下次调用时重写`);
    return { date, used: 0 };
  }
  if (!raw || typeof raw !== "object") {
    log.warn(`cover-ai: ${COVER_BUDGET_FILE} 结构异常（${typeof raw}），本次按 0 计并会在下次调用时重写`);
    return { date, used: 0 };
  }
  if (raw.date !== date) return { date, used: 0 }; // normal cross-day rollover — silent by design
  const n = Number(raw.used);
  if (!Number.isFinite(n) || n < 0) {
    log.warn(`cover-ai: ${COVER_BUDGET_FILE} 的 used=${JSON.stringify(raw.used)} 非法，本次按 0 计并会重写`);
    return { date, used: 0 };
  }
  return { date, used: Math.floor(n) };
}

/**
 * Reserve one AI-cover slot for `date` (called immediately before the *first*
 * image request, so a release that never reaches the gateway costs nothing).
 *
 * Contract (design §C-3):
 *  - `limit <= 0` → unlimited, **no file written** (today's behaviour).
 *  - `limit = n` → calls 1..n are allowed, call n+1 is refused (`ok:false`).
 *  - one call per `generateAiCover()` — the *article* is counted, not the model,
 *    otherwise a 3-model fallback chain would burn 3 slots for one cover.
 */
export function consumeCoverBudget(
  stateDir: string | undefined,
  date: string,
  limit: number,
): { ok: boolean; used: number; limit: number } {
  const lim = Math.max(0, Math.floor(Number(limit) || 0));
  if (lim === 0) return { ok: true, used: 0, limit: 0 };
  if (!stateDir) {
    log.warn(`cover-ai: cover.ai.dailyBudget=${lim} 但没有 stateDir，预算护栏未生效（出图照常）`);
    return { ok: true, used: 0, limit: lim };
  }
  const prev = readCoverBudget(stateDir, date);
  if (prev.used >= lim) return { ok: false, used: prev.used, limit: lim };
  const next: CoverBudget = { date, used: prev.used + 1 };
  try {
    // Atomic per write (tmp + rename, pid-suffixed tmp) so a crash mid-write cannot
    // leave a half file. The read-modify-write is NOT cross-process locked: two racing
    // processes can both read `used` and write the same +1 (measured: 5 concurrent
    // processes → used=4). Accepted, because per-account publishing is serialized
    // (`CONSOLE_MAX_CONCURRENCY=1`) and this is a cost guardrail, not billing — but it
    // means the counter may under-count, never over-count.
    atomicWriteJson(coverBudgetPath(stateDir), next);
  } catch (err) {
    // Counting is a guardrail, not a publish dependency: warn and let the cover go.
    log.warn(`cover-ai: 写 ${COVER_BUDGET_FILE} 失败（预算未计数，出图照常）：${(err as Error).message}`);
  }
  return { ok: true, used: next.used, limit: lim };
}

// ── observability: the `doctor` line (design §C-4) ──────────────────────────

function agoLabel(iso: string, nowMs: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "?";
  const s = Math.max(0, Math.round((nowMs - t) / 1000));
  if (s < 90) return `${s}s ago`;
  const m = s / 60;
  if (m < 90) return `${Math.round(m)}m ago`;
  const h = m / 60;
  if (h < 48) return `${h.toFixed(1)}h ago`;
  return `${(h / 24).toFixed(1)}d ago`;
}

function latestBy(
  stats: CoverModelStats,
  pick: (s: CoverModelStat) => string | undefined,
): [string, CoverModelStat] | undefined {
  return Object.entries(stats)
    .filter(([, s]) => Boolean(pick(s)))
    .sort((a, b) => Date.parse(pick(b[1])!) - Date.parse(pick(a[1])!))[0];
}

/**
 * Build the `cover-candidates` detail (the caller prefixes `cover-candidates: `).
 * Pure and model-name-agnostic on purpose: the numbers come from the live gateway
 * listing and the local stats file, never from a hardcoded list (AC4).
 */
export function describeCoverCandidates(input: {
  models: string[] | null;
  stats?: CoverModelStats;
  now?: Date;
}): string {
  if (input.models === null) return "models ? (gateway unreachable)";
  const models = input.models; // may legitimately be [] (gateway up, no image model)
  const parts = [`${models.length} image model${models.length === 1 ? "" : "s"} (gateway ok)`];
  const stats = input.stats ?? {};
  const now = (input.now ?? new Date()).getTime();
  const lastOk = latestBy(stats, (s) => s.lastOkAt);
  const lastFail = latestBy(stats, (s) => s.lastFailAt);
  if (lastOk) {
    const ms = lastOk[1].lastOkMs;
    parts.push(`last ok ${lastOk[0]} (${agoLabel(lastOk[1].lastOkAt!, now)}${ms ? `, ${(ms / 1000).toFixed(1)}s` : ""})`);
  }
  if (lastFail) {
    parts.push(`last fail ${lastFail[0]} (${agoLabel(lastFail[1].lastFailAt!, now)}: ${clipText(lastFail[1].lastFailReason ?? "unknown", 60)})`);
  }
  return parts.join(" · ");
}

/**
 * Full AI cover path. Returns `{ok:false, reason}` on any failure — the caller
 * is responsible for falling back to the deterministic renderer.
 */
export async function generateAiCover(input: AiCoverInput): Promise<AiCoverResult> {
  const t0 = Date.now();
  const size = input.size ?? "900x383";
  const s = input.settings;
  const stateDir = input.stateDir;
  const budgetDate = input.date || localDateStr();
  const dailyBudget = Math.max(0, Math.floor(Number(s.dailyBudget ?? 0) || 0));

  const gw = resolveImageGateway({ gateway: s.gateway, apiKey: s.apiKey });
  if (!gw) {
    return { ok: false, reason: "no image gateway (set cover.ai.gateway/apiKey, COVER_IMAGE_* env, or ~/.pi/agent/models.json)" };
  }

  // 0) Cost guardrail — checked *before* the summary call: a budget-exhausted day
  //    must not spend a text-model request either. `>= limit` → the n+1-th cover
  //    of the day is refused here; the n-th is still allowed (see consumeCoverBudget).
  if (dailyBudget > 0) {
    const peek = readCoverBudget(stateDir, budgetDate);
    if (peek.used >= dailyBudget) {
      const reason = `daily cover budget exhausted (${peek.used}/${dailyBudget}) — 降级 ffmpeg`;
      log.warn(`cover-ai: ${reason}`);
      return { ok: false, reason };
    }
  }

  // 1) prompt —— 两条路线：
  //    poster       : 纯确定性（module/选题/标题 直接拼，**不调文本模型**）；
  //    illustration : 文本模型产出视觉简报 → 无字几何插画（旧行为，逐字节不变）。
  //    poster 缺任一文案字段 → **显式 warn 并回落** illustration，绝不静默换风格。
  let prompt = "";
  let brief: CoverBrief | undefined;
  let poster: PosterCopy | undefined;
  if (s.layout === "poster") {
    const missing = missingPosterFields({ module: input.module, topic: input.topic ?? "", title: input.title });
    if (missing.length) {
      log.warn(`cover-ai: poster 文案缺字段 [${missing.join(", ")}] — 回落插画风`);
    } else {
      poster = { module: input.module.trim(), topic: String(input.topic).trim(), title: input.title.trim() };
      prompt = buildPosterPrompt(poster);
      log.info(`cover-ai: poster 文案（确定性，无文本模型调用）title="${poster.title}"`);
      if (input.briefPath) {
        try {
          fs.mkdirSync(path.dirname(input.briefPath), { recursive: true });
          fs.writeFileSync(input.briefPath, JSON.stringify({ layout: "poster", copy: poster, at: new Date().toISOString() }, null, 2) + "\n");
        } catch {
          /* audit file is best-effort */
        }
      }
    }
  }
  if (!prompt) {
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
    brief = sum.brief;
    if (input.briefPath) {
      try {
        fs.mkdirSync(path.dirname(input.briefPath), { recursive: true });
        fs.writeFileSync(
          input.briefPath,
          JSON.stringify({ layout: "illustration", brief, summaryOk: sum.ok, summaryReason: sum.reason, at: new Date().toISOString() }, null, 2) + "\n",
        );
      } catch {
        /* audit file is best-effort */
      }
    }
    // 2) prompt — pure code, deterministic
    prompt = buildImagePrompt(brief, s.style);
  }

  // 3) images — try each model id, normalised for the gateway's `<group>:<model>` form.
  const chain = [s.model, ...(s.fallbacks ?? [])].filter(Boolean).map(normalizeImageModelId);
  const rawPath = input.rawPath ?? path.join(path.dirname(input.outPath), "cover-raw.png");
  const failures: string[] = [];
  const deadline = t0 + Math.max(30, s.maxTotalSec) * 1000;
  // One budget slot per article: reserved lazily, right before the first gateway
  // request, so a call that never reaches the gateway costs nothing.
  let budgetReserved = false;

  for (const model of chain) {
    if (Date.now() > deadline) {
      failures.push("total budget exhausted");
      break;
    }
    if (!budgetReserved) {
      const slot = consumeCoverBudget(stateDir, budgetDate, dailyBudget);
      if (!slot.ok) {
        const reason = `daily cover budget exhausted (${slot.used}/${slot.limit}) — 降级 ffmpeg`;
        log.warn(`cover-ai: ${reason}`);
        return { ok: false, reason, brief };
      }
      budgetReserved = true;
    }
    const remaining = Math.max(10, Math.round((deadline - Date.now()) / 1000));
    const budget = Math.min(s.timeoutSec, remaining);
    const started = Date.now();
    // poster 必须在大画布上排版（900x383 会让模型只写一行字），出图后再裁回 `size`。
    const firstSize = poster ? POSTER_CANVAS : size;
    let r = await generateOneImage(gw, model, prompt, firstSize, budget);
    if (!r.ok && isSizeRejection(r.reason) && firstSize !== SIZE_ESCALATION) {
      log.warn(`cover-ai: ${model} rejected size ${firstSize} (${r.reason.slice(0, 80)}) — retrying at ${SIZE_ESCALATION}`);
      // Re-derive the budget from the chain deadline: a rejection can take ~40s
      // (measured), and reusing the first attempt's full budget let one model
      // overrun `maxTotalSec` by up to `timeoutSec`.
      const remainMs = deadline - Date.now();
      const escalationBudget = Math.min(s.timeoutSec, Math.max(5, Math.round(remainMs / 1000)));
      r = await generateOneImage(gw, model, prompt, SIZE_ESCALATION, escalationBudget);
    }
    const modelMs = Date.now() - started;
    if (r.ok) {
      const b64size = r.b64.length;
      try {
        fs.mkdirSync(path.dirname(rawPath), { recursive: true });
        fs.writeFileSync(rawPath, Buffer.from(r.b64, "base64"));
      } catch (err) {
        const reason = `write raw failed: ${(err as Error).message}`;
        recordCoverModelStat(stateDir, model, { ok: false, ms: modelMs, reason }, { apiKey: gw.apiKey });
        return { ok: false, reason };
      }
      try {
        if (poster) {
          // poster 是文字排版：每次内容位置都不同，固定偏置会切字 → 用内容自适应裁切。
          await fitImageToContent(rawPath, input.outPath, size);
        } else {
          await fitImageTo(rawPath, input.outPath, size);
        }
      } catch (err) {
        const reason = `fit failed: ${(err as Error).message}`;
        recordCoverModelStat(stateDir, model, { ok: false, ms: modelMs, reason }, { apiKey: gw.apiKey });
        return { ok: false, reason };
      }
      const dim = imageSize(input.outPath);
      const want = parseSize(size);
      if (!dim || dim.w !== want.w || dim.h !== want.h) {
        const reason = `unexpected final size ${dim ? `${dim.w}x${dim.h}` : "?"} (want ${want.w}x${want.h})`;
        recordCoverModelStat(stateDir, model, { ok: false, ms: modelMs, reason }, { apiKey: gw.apiKey });
        return { ok: false, reason };
      }
      const ms = Date.now() - t0;
      log.info(`cover-ai: model=${model} ${((Date.now() - started) / 1000).toFixed(1)}s b64=${b64size}B → ${dim.w}x${dim.h} (总 ${(ms / 1000).toFixed(1)}s)`);
      // Only a *usable* cover counts as a success here (usable size + fitted):
      // "reachable but broken" must not look identical to "working" in doctor.
      recordCoverModelStat(stateDir, model, { ok: true, ms: modelMs }, { apiKey: gw.apiKey });
      // Sanity probe: a light background means the model ignored the palette.
      // illustration 路线才检查 —— poster 本身就是浅底海报，亮底属预期。
      if (brief) {
        const avg = await averageColor(input.outPath);
        if (avg && luminance(avg) > 0.6) {
          log.warn(
            `cover-ai: 背景偏亮 (lum=${luminance(avg).toFixed(2)}) 模型可能忽略了深色底 ${brief.palette[0]} — 可改 style/重跑`,
          );
        }
      }
      return { ok: true, model, brief, poster, size: dim, ms };
    }
    failures.push(`${model}[${r.reason}]`);
    recordCoverModelStat(stateDir, model, { ok: false, ms: modelMs, reason: r.reason }, { apiKey: gw.apiKey });
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
    dailyBudget: 0,
    ...overrides,
  };
}

/** Default prompt template location (`<APP_DIR>/prompts/cover.md`). */
export function defaultCoverPrompt(promptsDir: string): string {
  return path.join(promptsDir, "cover.md");
}

export const HOME_DIR = os.homedir();
