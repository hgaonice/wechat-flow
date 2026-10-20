#!/usr/bin/env bun
/**
 * image-model-probe.ts — deterministic image-model census for the AI cover chain.
 *
 * Why: the cover chain only ever used 2 image models (`hunyuan` → `gpt-image-2.5`),
 * and that choice was "whatever worked at the time". This tool produces the *evidence*
 * (latency / returned size / snapping / structure score / sha256) that a model choice
 * can be argued from. It is a one-shot ops tool: it is NOT part of the publish path,
 * it never writes into `src/`, and every failure is recorded as an explicit
 * `ok:false` row with a non-empty `reason` — never skipped silently.
 *
 * Contract: `.trellis/tasks/10-20-image-model-scout/design.md` §C-1 (report shape)
 *           and §C-2 (structure score). Extra fields are additive only.
 *
 * Usage:
 *   bun tools/image-model-probe.ts --all-image
 *   bun tools/image-model-probe.ts --models cn:hunyuan-image-alpha-edit,cogview-4
 *   bun tools/image-model-probe.ts --all-image --brief data/second/imgs/2026-10-20/cover-brief.json
 *   bun tools/image-model-probe.ts --all-image --json-only     # print only, no files
 *
 * Outputs (default --out-dir data/research, which is gitignored):
 *   data/research/image-models-<YYYY-MM-DD>.json   matrix (merged per model on rerun)
 *   data/research/samples/<model>-<HHMMSS>.png     raw model output (NOT fitted)
 *
 * Exit codes: 0 = report produced with at least one ok row;
 *             1 = operational error (no gateway / no brief / no models / unwritable dir);
 *             3 = report produced but **every** model failed — still written, but non-zero so
 *                 a shell/CI caller cannot mistake a total outage for a clean census.
 *
 * Never prints or persists a plaintext apiKey: every string that leaves this process
 * (reason, report, stderr lines) goes through `redactSecrets()`.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULT_COVER_SIZE, fitImageTo, imageSize, parseSize } from "../src/cover.ts";
import {
  buildImagePrompt,
  listImageModels,
  normalizeImageModelId,
  parseCoverBrief,
  resolveImageGateway,
  type CoverBrief,
} from "../src/cover-ai.ts";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Style phrase used for the probe prompt when a brief file has none of its own. */
export const DEFAULT_PROBE_STYLE = "扁平矢量插画，几何极简，教育科技感，构图简洁留白大";

// ── thresholds (see §C-2) ──────────────────────────────────────────────────

/**
 * All structure-score thresholds in one place, so the matrix report can print them
 * and a human can re-judge a row without reading the source.
 *
 * Calibration notes (why these values):
 *  - `minStdDev` 0.015 on normalised luminance (0..1): a uniform fill (the classic
 *    "model returned a blank canvas") is exactly 0, PNG/JPEG noise on a flat fill
 *    stays below ~0.004, while a two-tone flat illustration with >= 8 grey levels of
 *    separation over >= 30% of the canvas lands at >= 0.018. So 0.015 separates
 *    "blank" from "usable flat illustration" with margin on both sides.
 *  - `darkBgMin` 0.20 only (no upper bound): the brief demands a dark background, so
 *    this catches "model returned a light canvas". Do NOT add an upper bound: measured
 *    on-brief covers from both models sit at darkRatio 0.978 / 0.998 / 0.999 — the
 *    "large negative space, one motif" style the brief explicitly asks for looks almost
 *    entirely dark. Earlier bounds of 0.95 and then 0.995 both mis-flagged good covers;
 *    a missing subject is already covered by `not-blank` + `accentMinRatio`.
 *  - `accentMinRatio` 0.002 of 96x48 samples (~9 px): an accent stroke that is
 *    *visible* at cover size, while a 1-2 px antialiasing artefact does not count.
 */
export const SCORE_THRESHOLDS = {
  minStdDev: 0.015,
  darkLumaBelow: 0.4,
  darkBgMin: 0.2,
  darkBgMax: 1,
  accentMinSat: 0.3,
  accentMinLuma: 0.2,
  accentHueToleranceDeg: 35,
  accentMinRatio: 0.002,
  minBytes: 5120,
  minSide: 64,
  sampleW: 96,
  sampleH: 48,
} as const;

// ── redaction ──────────────────────────────────────────────────────────────

/** `sk-abcdef123456` → `***3456`; short values collapse to `***`. */
export function maskKey(key: string | undefined): string {
  const k = (key ?? "").trim();
  if (!k) return "***";
  return k.length <= 4 ? "***" : `***${k.slice(-4)}`;
}

/**
 * Strip credential-looking substrings from anything that may be logged or persisted
 * (gateway error bodies love to echo the Authorization header back).
 * `known` takes the concrete apiKey(s) in play so an opaque key with no recognisable
 * shape still gets replaced.
 */
export function redactSecrets(input: string, known: (string | undefined)[] = []): string {
  let s = String(input ?? "");
  for (const secret of known) {
    const k = (secret ?? "").trim();
    if (k.length >= 6) s = s.split(k).join(maskKey(k));
  }
  // Authorization headers
  s = s.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, "Bearer ***");
  // OpenAI-style keys, including vendor-prefixed forms (`sk-proj-…`, `ak-sk-…`)
  s = s.replace(/\bsk-[A-Za-z0-9._-]{4,}/g, "sk-***");
  s = s.replace(/([A-Za-z0-9_-]{0,12}\bsk-)[A-Za-z0-9._-]{4,}/g, "$1***");
  // `api_key=…`, `"token": "…"`, `x-api-key: …`
  s = s.replace(
    /((?:api[_-]?key|x-api-key|apikey|token|access[_-]?token|authorization)["'\s]*[:=]\s*["']?)([A-Za-z0-9._~+/=-]{8,})/gi,
    "$1***",
  );
  // Long opaque hex (bearer tokens that are not sk-prefixed)
  s = s.replace(/\b[0-9a-f]{32,}\b/gi, "***");
  return s;
}

/** Keep error excerpts readable in a JSON report. */
function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// ── measurement (reuses src/cover.ts header parsing) ───────────────────────

export interface MeasuredImage {
  ok: boolean;
  width?: number;
  height?: number;
  bytes: number;
  contentType: string | null;
  /** Detected container extension, e.g. `.png`. */
  ext?: string;
  reason?: string;
}

interface ImageKind {
  mime: string;
  ext: string;
  test: (b: Buffer) => boolean;
}

const IMAGE_KINDS: ImageKind[] = [
  { mime: "image/png", ext: ".png", test: (b) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: "image/jpeg", ext: ".jpg", test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/gif", ext: ".gif", test: (b) => b.length >= 6 && b.toString("ascii", 0, 3) === "GIF" },
  {
    mime: "image/webp",
    ext: ".webp",
    test: (b) => b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP",
  },
];

function sniffImage(buf: Buffer): ImageKind | undefined {
  return IMAGE_KINDS.find((k) => k.test(buf));
}

function baseContentType(ct: string | null | undefined): string | null {
  if (!ct) return null;
  const base = ct.split(";")[0]!.trim().toLowerCase();
  return base || null;
}

/**
 * Bytes → width/height/content-type. The header parsing itself is `imageSize()`
 * from `src/cover.ts` (single source of truth, already battle-tested against
 * model-returned PNG/JPEG/WebP); it reads a file, so the bytes are spilled to a
 * temp file rather than re-implementing the parser here.
 */
export function measureImage(data: Uint8Array, contentTypeHint?: string | null): MeasuredImage {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const kind = sniffImage(buf);
  if (!kind) {
    return {
      ok: false,
      bytes: buf.length,
      contentType: baseContentType(contentTypeHint),
      reason: `unrecognised image header (${buf.length} bytes, head ${buf.subarray(0, 8).toString("hex") || "empty"})`,
    };
  }
  const tmp = path.join(os.tmpdir(), `wfm-measure-${process.pid}-${crypto.randomBytes(4).toString("hex")}${kind.ext}`);
  try {
    fs.writeFileSync(tmp, buf);
    const dim = imageSize(tmp);
    const hint = baseContentType(contentTypeHint);
    const contentType = hint && hint.startsWith("image/") ? hint : kind.mime;
    if (!dim) {
      return {
        ok: false,
        bytes: buf.length,
        contentType,
        ext: kind.ext,
        reason: `header parse failed (${kind.mime}, ${buf.length} bytes — truncated or corrupt)`,
      };
    }
    return { ok: true, width: dim.w, height: dim.h, bytes: buf.length, contentType, ext: kind.ext };
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort temp cleanup */
    }
  }
}

// ── pixel sampling (variance / dark ratio / accent) ────────────────────────

interface PixelSample {
  pixels: number;
  stdDev: number;
  darkRatio: number;
  /** Ratio of pixels that look like a bright saturated accent (any hue). */
  accentRatio: number;
  /** Ratio of pixels within `accentHueToleranceDeg` of the brief accent colour. */
  accentHueRatio: number;
}

const FFMPEG_CANDIDATES = ["/usr/bin/ffmpeg", "/bin/ffmpeg", "ffmpeg"];
let ffmpegBin: string | undefined | null = null;

function runBinary(cmd: string, args: string[]): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => (stderr += c));
    child.on("error", (err) => resolve({ code: null, stdout: Buffer.concat(chunks), stderr: err.message }));
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(chunks), stderr }));
  });
}

async function pickFfmpeg(): Promise<string | undefined> {
  if (ffmpegBin !== null) return ffmpegBin ?? undefined;
  for (const bin of FFMPEG_CANDIDATES) {
    const r = await runBinary(bin, ["-hide_banner", "-version"]);
    if (r.code === 0) {
      ffmpegBin = bin;
      return bin;
    }
  }
  ffmpegBin = undefined;
  return undefined;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function luma(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** HSV saturation + hue (degrees); max=min → sat 0, hue 0. */
function satHue(r: number, g: number, b: number): { sat: number; hue: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (max === 0 || delta === 0) return { sat: 0, hue: 0 };
  let hue: number;
  if (max === r) hue = 60 * (((g - b) / delta) % 6);
  else if (max === g) hue = 60 * ((b - r) / delta + 2);
  else hue = 60 * ((r - g) / delta + 4);
  if (hue < 0) hue += 360;
  return { sat: delta / max, hue };
}

function hexToHue(hex: string): number | undefined {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return undefined;
  const n = parseInt(m[1]!, 16);
  const { sat, hue } = satHue((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  return sat === 0 ? undefined : hue;
}

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Downscale to 96x48 with ffmpeg and compute pixel statistics.
 * Returns undefined when no ffmpeg / undecodable image — the caller must record that
 * as a failed assertion, not as a pass.
 */
async function sampleImage(file: string): Promise<PixelSample | undefined> {
  const ffmpeg = await pickFfmpeg();
  if (!ffmpeg) return undefined;
  const { sampleW: sw, sampleH: sh } = SCORE_THRESHOLDS;
  const r = await runBinary(ffmpeg, [
    "-v", "error", "-i", file,
    "-vf", `scale=${sw}:${sh}:flags=bilinear`,
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ]);
  if (r.code !== 0 || r.stdout.length < sw * sh * 3) return undefined;

  const pixels = sw * sh;
  const lumas: number[] = [];
  let dark = 0;
  let accent = 0;
  let accentHue = 0;
  for (let i = 0; i < pixels; i++) {
    const r8 = r.stdout[i * 3]!;
    const g8 = r.stdout[i * 3 + 1]!;
    const b8 = r.stdout[i * 3 + 2]!;
    const l = luma(r8, g8, b8);
    lumas.push(l);
    if (l < SCORE_THRESHOLDS.darkLumaBelow) dark++;
    const { sat, hue } = satHue(r8, g8, b8);
    if (sat >= SCORE_THRESHOLDS.accentMinSat && l >= SCORE_THRESHOLDS.accentMinLuma) {
      accent++;
      if (hue) accentHue++;
    }
  }
  const mean = lumas.reduce((a, b) => a + b, 0) / pixels;
  const variance = lumas.reduce((a, b) => a + (b - mean) ** 2, 0) / pixels;
  return {
    pixels,
    stdDev: Math.sqrt(variance),
    darkRatio: dark / pixels,
    accentRatio: accent / pixels,
    accentHueRatio: accentHue / pixels,
  };
}

// ── structure score (§C-2, automatic half only) ────────────────────────────

export const ASSERTION_IDS = ["size-normalized", "not-blank", "palette-usable", "not-placeholder"] as const;
export type AssertionId = (typeof ASSERTION_IDS)[number];

export interface StructureScore {
  passed: string[];
  failed: string[];
  /** Raw pixel measurements, persisted so a human can re-judge a matrix row later. */
  metrics?: {
    stdDev: number;
    darkRatio: number;
    accentRatio: number;
    accentHueRatio: number;
  };
}

/**
 * Automatic structure checks — "is this image usable as a cover at all".
 * They deliberately do NOT judge content (typos / stray digits / gibberish): that
 * is the human eye's job (§C-2), and a self-graded "looks good" would be a false
 * positive source (see `.trellis/spec/engine/ai-determinism.md`).
 *
 *   1. size-normalized  — `fitImageTo()` (the same code the publish path uses) yields
 *                         exactly `<w>x<h>`; proves the model's size snapping is
 *                         recoverable by the deterministic crop.
 *   2. not-blank        — luminance std dev >= SCORE_THRESHOLDS.minStdDev.
 *   3. palette-usable   — dark background share in [darkBgMin, darkBgMax] AND a
 *                         visible bright accent (matching the brief accent hue when
 *                         `opts.palette[2]` is given).
 *   4. not-placeholder  — header parses to a real canvas (>= minSide) and the payload
 *                         is bigger than minBytes (kills 1x1 / "OK" pixel stubs).
 */
export async function scoreImageStructure(
  data: Uint8Array,
  size: string,
  opts: { palette?: string[] } = {},
): Promise<StructureScore> {
  const passed: string[] = [];
  const failed: string[] = [];
  const mark = (id: AssertionId, cond: boolean): void => {
    (cond ? passed : failed).push(id);
  };

  let metrics: StructureScore["metrics"];
  const measured = measureImage(data);
  mark("not-placeholder", measured.ok && measured.bytes > SCORE_THRESHOLDS.minBytes &&
    (measured.width ?? 0) >= SCORE_THRESHOLDS.minSide && (measured.height ?? 0) >= SCORE_THRESHOLDS.minSide);
  if (!measured.ok) {
    // No decodable image → the remaining assertions cannot be satisfied.
    mark("size-normalized", false);
    mark("not-blank", false);
    mark("palette-usable", false);
    return { passed, failed, metrics };
  }

  const { w, h } = parseSize(size);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wfm-score-"));
  try {
    const src = path.join(tmpDir, `in${measured.ext ?? ".png"}`);
    const fitted = path.join(tmpDir, "fitted.png");
    fs.writeFileSync(src, Buffer.isBuffer(data) ? data : Buffer.from(data));

    // 1) exact size after the publish path's own fit/crop
    try {
      await fitImageTo(src, fitted, size);
      const dim = imageSize(fitted);
      mark("size-normalized", !!dim && dim.w === w && dim.h === h);
    } catch {
      mark("size-normalized", false);
    }

    const sample = await sampleImage(src);
    if (!sample) {
      // ffmpeg missing / undecodable: surface it instead of pretending it passed.
      mark("not-blank", false);
      mark("palette-usable", false);
    } else {
      mark("not-blank", sample.stdDev >= SCORE_THRESHOLDS.minStdDev);
      const darkOk = sample.darkRatio >= SCORE_THRESHOLDS.darkBgMin && sample.darkRatio <= SCORE_THRESHOLDS.darkBgMax;
      const accentHex = opts.palette?.[2];
      const wantHue = accentHex ? hexToHue(accentHex) : undefined;
      const accentOk = wantHue === undefined
        ? sample.accentRatio >= SCORE_THRESHOLDS.accentMinRatio
        : sample.accentHueRatio >= SCORE_THRESHOLDS.accentMinRatio;
      mark("palette-usable", darkOk && accentOk);
      metrics = {
        stdDev: round4(sample.stdDev),
        darkRatio: round4(sample.darkRatio),
        accentRatio: round4(sample.accentRatio),
        accentHueRatio: round4(sample.accentHueRatio),
      };
    }
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  }
  return { passed, failed, metrics };
}

// ── request building ───────────────────────────────────────────────────────

export interface ProbeGateway {
  baseUrl: string;
  apiKey: string;
}

/**
 * Build the exact request the publish path sends (`POST /images/generations`, bare
 * `<group>:<model>` id) so the probe measures the real thing, not a lookalike.
 *
 * NOTE: `init` contains the Authorization header — never log or persist `init`.
 */
export function buildProbeRequest(
  gw: ProbeGateway,
  model: string,
  size: string,
  brief: CoverBrief,
  opts: { style?: string } = {},
): { url: string; init: RequestInit } {
  const { w, h } = parseSize(size);
  const prompt = buildImagePrompt(brief, opts.style ?? DEFAULT_PROBE_STYLE);
  return {
    url: `${gw.baseUrl.replace(/\/+$/, "")}/images/generations`,
    init: {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${gw.apiKey}` },
      body: JSON.stringify({ model, prompt, n: 1, size: `${w}x${h}` }),
    },
  };
}

// ── report types (§C-1) ────────────────────────────────────────────────────

export interface ProbeRow {
  model: string;
  ok: boolean;
  status: number | null;
  requestedSize: string;
  returnedSize: string | null;
  snapped: boolean;
  ttfbMs: number | null;
  /** Generation wall time (request → image bytes), excludes local fit/score work. */
  totalMs: number;
  bytes: number | null;
  /** Relative to `--out-dir` (default `data/research`) → `samples/<file>`; null with `--json-only`. */
  pngPath: string | null;
  sha256: string | null;
  reason: string | null;
  // ── additive fields (not in C-1, used by Step 2 triage / §A matrix) ──
  retryable?: boolean;
  contentType?: string | null;
  score?: StructureScore;
  scoreMs?: number;
}

export interface ProbeReport {
  startedAt: string;
  finishedAt?: string;
  gateway: string;
  brief: CoverBrief;
  size?: string;
  thresholds?: typeof SCORE_THRESHOLDS;
  rows: ProbeRow[];
  summary: {
    ok: number;
    failed: number;
    fastest?: string;
    slowest?: string;
    medianMs?: number;
    snapped?: number;
  };
  /** Rows replaced by a later same-day rerun (kept for audit). */
  history?: ProbeRow[];
  apiKeyHint?: string;
}

// ── one model ──────────────────────────────────────────────────────────────

export interface ProbeRunOptions {
  outDir: string;
  size: string;
  timeoutSec: number;
  /** false → do not write sample PNGs (temp files are still used for measurement). */
  writeFiles: boolean;
  style?: string;
  /** Concrete secrets to scrub from anything that leaves the process. */
  knownSecrets?: string[];
}

interface ImageGenResponse {
  data?: { b64_json?: string; url?: string; mime_type?: string; revised_prompt?: string }[];
  error?: { message?: string; code?: string; type?: string };
}

/** 404/model-not-found style answers will never succeed on retry; 5xx/network might. */
export function classifyRetryable(status: number | null, message: string): boolean {
  if (/model_not_found|not found|no available channel|does not exist|invalid api key|unauthorized/i.test(message)) return false;
  if (status === null) return true;
  if (status >= 400 && status < 500) return status === 408 || status === 409 || status === 429;
  return true;
}

function safeModelSlug(model: string): string {
  return model.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "model";
}

function hhmmss(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Probe one model exactly once. Always returns a row; a failure has a non-empty
 * `reason` that names the failure class (http status / content-type / header /
 * timeout) so Step 2 can decide "retry or drop".
 */
export async function probeOneImage(
  gw: ProbeGateway,
  model: string,
  brief: CoverBrief,
  opts: ProbeRunOptions,
): Promise<ProbeRow> {
  const secrets = [gw.apiKey, ...(opts.knownSecrets ?? [])];
  const { url, init } = buildProbeRequest(gw, model, opts.size, brief, { style: opts.style });
  const row: ProbeRow = {
    model,
    ok: false,
    status: null,
    requestedSize: opts.size,
    returnedSize: null,
    snapped: false,
    ttfbMs: null,
    totalMs: 0,
    bytes: null,
    pngPath: null,
    sha256: null,
    reason: null,
  };

  const t0 = performance.now();
  let imageBytes: Buffer | null = null;
  let contentType: string | null = null;

  try {
    const res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(Math.max(1, Math.round(opts.timeoutSec)) * 1000),
    });
    // fetch() resolves once headers arrive → this is the TTFB.
    row.ttfbMs = Math.round(performance.now() - t0);
    row.status = res.status;
    const hint = res.headers.get("content-type");
    const raw = Buffer.from(await res.arrayBuffer());
    row.totalMs = Math.round(performance.now() - t0);

    if (!res.ok) {
      const body = raw.toString("utf8");
      let msg = "";
      try {
        const parsed = JSON.parse(body) as ImageGenResponse;
        msg = parsed?.error?.message ?? parsed?.error?.code ?? "";
      } catch {
        /* not JSON — fall through to the raw body */
      }
      const detail = clip(redactSecrets(msg || body, secrets), 200) || "(empty body)";
      row.retryable = classifyRetryable(res.status, detail);
      row.reason = `http ${res.status}: ${detail} [${row.retryable ? "retryable" : "permanent"}]`;
    } else {
      const got = await extractImage(res, raw, hint, secrets, gw.baseUrl);
      if (got.ok) {
        imageBytes = got.bytes;
        contentType = got.contentType;
      } else {
        row.reason = got.reason;
        row.retryable = false;
      }
    }
  } catch (err) {
    row.totalMs = Math.round(performance.now() - t0);
    const e = err as Error;
    const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError" || /timeout|timed out/i.test(e?.message ?? "");
    row.reason = timedOut
      ? `timeout after ${opts.timeoutSec}s (no response from gateway) [retryable]`
      : `request error: ${clip(redactSecrets(e?.message ?? String(err), secrets), 200)} [retryable]`;
    row.retryable = true;
  }

  if (!imageBytes) {
    if (!row.reason) row.reason = "unknown failure (no image bytes extracted) [permanent]";
    return row;
  }

  // ── measurement ──
  const measured = measureImage(imageBytes, contentType);
  row.bytes = imageBytes.length;
  row.contentType = measured.contentType ?? contentType;
  if (!measured.ok || measured.width === undefined || measured.height === undefined) {
    row.reason = measured.reason ?? "image measurement failed";
    row.retryable = false;
    return row;
  }
  row.returnedSize = `${measured.width}x${measured.height}`;
  const want = parseSize(opts.size);
  row.snapped = row.returnedSize !== `${want.w}x${want.h}`;

  // ── persistence + hash ──
  row.sha256 = crypto.createHash("sha256").update(imageBytes).digest("hex");
  if (opts.writeFiles) {
    const dir = path.join(opts.outDir, "samples");
    try {
      fs.mkdirSync(dir, { recursive: true });
      // Timestamped name → reruns never overwrite an earlier sample.
      const name = `${safeModelSlug(model)}-${hhmmss()}${measured.ext ?? ".png"}`;
      fs.writeFileSync(path.join(dir, name), imageBytes);
      row.pngPath = `samples/${name}`;
    } catch (err) {
      row.reason = `sample write failed: ${clip((err as Error).message, 160)}`;
      row.retryable = false;
      return row;
    }
  }

  // ── structure score (automatic half of §C-2) ──
  const scoreStart = performance.now();
  try {
    row.score = await scoreImageStructure(imageBytes, opts.size, { palette: brief.palette });
  } catch (err) {
    row.score = { passed: [], failed: [...ASSERTION_IDS] };
    row.reason = `structure score threw: ${clip((err as Error).message, 160)}`;
  }
  row.scoreMs = Math.round(performance.now() - scoreStart);

  row.ok = true;
  return row;
}

/** Pull image bytes out of a 2xx response: raw `image/*`, `data[0].b64_json`, or `data[0].url`. */
async function extractImage(
  res: Response,
  raw: Buffer,
  contentTypeHint: string | null,
  secrets: (string | undefined)[],
  baseUrl: string,
): Promise<{ ok: true; bytes: Buffer; contentType: string | null } | { ok: false; reason: string }> {
  const ct = baseContentType(contentTypeHint);
  if (ct?.startsWith("image/")) {
    return { ok: true, bytes: raw, contentType: ct };
  }

  let body: ImageGenResponse | undefined;
  try {
    body = JSON.parse(raw.toString("utf8")) as ImageGenResponse;
  } catch {
    body = undefined;
  }
  const item = body?.data?.[0];
  if (item?.b64_json) {
    try {
      return { ok: true, bytes: Buffer.from(item.b64_json, "base64"), contentType: baseContentType(item.mime_type) };
    } catch {
      return { ok: false, reason: "base64 payload was not decodable" };
    }
  }
  if (item?.url) {
    // Some relays hand back a relative file URL (`/v1/files/x.png`) instead of an
    // absolute one; resolve it against the gateway so the row reflects the model,
    // not a URL-parsing quirk.
    const absUrl = /^https?:\/\//i.test(item.url) ? item.url : new URL(item.url, `${baseUrl.replace(/\/+$/, "")}/`).toString();
    try {
      const dl = await fetch(absUrl, { signal: AbortSignal.timeout(60_000) });
      if (!dl.ok) return { ok: false, reason: `image download http ${dl.status}` };
      const dlCt = baseContentType(dl.headers.get("content-type"));
      return { ok: true, bytes: Buffer.from(await dl.arrayBuffer()), contentType: dlCt };
    } catch (err) {
      return { ok: false, reason: `image download failed: ${clip(redactSecrets((err as Error).message, secrets), 160)}` };
    }
  }
  if (body) {
    const detail = clip(redactSecrets(raw.toString("utf8"), secrets), 200);
    return { ok: false, reason: `http ${res.status} ok but no image payload: ${detail || "(empty)"}` };
  }
  return { ok: false, reason: `non-image content-type: ${ct ?? "(missing)"} (no JSON image payload)` };
}

// ── report merge / summary ─────────────────────────────────────────────────

/**
 * Same-day rerun semantics: one row per model, newest wins; superseded rows are
 * moved to `history` instead of being dropped (audit trail for "it worked an hour
 * ago"). Models that were not re-run keep their previous row.
 */
export function mergeReport(previous: ProbeReport | undefined, fresh: ProbeReport): ProbeReport {
  if (!previous || !Array.isArray(previous.rows)) return fresh;
  const history = [...(previous.history ?? [])];
  const freshModels = new Set(fresh.rows.map((r) => r.model));
  const carried: ProbeRow[] = [];
  for (const old of previous.rows) {
    if (freshModels.has(old.model)) history.push(old);
    else carried.push(old);
  }
  const rows = [...fresh.rows, ...carried];
  return { ...fresh, rows, history: history.length ? history : undefined };
}

export function summarize(rows: ProbeRow[]): ProbeReport["summary"] {
  const okRows = rows.filter((r) => r.ok && Number.isFinite(r.totalMs));
  const sorted = [...okRows].sort((a, b) => a.totalMs - b.totalMs);
  const times = rows.map((r) => r.totalMs).sort((a, b) => a - b);
  const median = times.length ? times[Math.floor(times.length / 2)] : undefined;
  return {
    ok: rows.filter((r) => r.ok).length,
    failed: rows.filter((r) => !r.ok).length,
    fastest: sorted[0]?.model,
    slowest: sorted[sorted.length - 1]?.model,
    medianMs: median,
    snapped: rows.filter((r) => r.ok && r.snapped).length,
  };
}

// ── brief loading ──────────────────────────────────────────────────────────

export interface LoadedBrief {
  brief: CoverBrief;
  source: string;
}

/**
 * Resolve the brief that is fed to *every* model (comparable numbers require an
 * identical prompt). Search order:
 *   1. explicit `--brief <path|inline-json>`
 *   2. `data/<alias>/cover-brief.json`
 *   3. `data/<alias>/imgs/<date>/cover-brief.json`   (where publisher actually writes it)
 *   4. `data/<alias>/imgs/<latest-date>/cover-brief.json`
 * No file → error (never invent a brief silently: the matrix would be incomparable).
 */
export function loadBrief(spec: string | undefined, alias: string, date?: string): LoadedBrief {
  const tried: string[] = [];
  if (spec) {
    const asPath = path.isAbsolute(spec) ? spec : path.resolve(process.cwd(), spec);
    if (fs.existsSync(asPath)) return parseBriefFile(asPath);
    const inline = spec.trim();
    if (inline.startsWith("{")) {
      const brief = parseCoverBrief(inline);
      if (brief) return { brief, source: "inline-json" };
      throw new Error("--brief inline JSON has no parsable object");
    }
    tried.push(asPath);
  } else {
    const root = path.join(APP_DIR, "data", alias);
    const candidates = [path.join(root, "cover-brief.json")];
    if (date) candidates.push(path.join(root, "imgs", date, "cover-brief.json"));
    const imgsDir = path.join(root, "imgs");
    if (fs.existsSync(imgsDir)) {
      const dates = fs
        .readdirSync(imgsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
        .reverse();
      for (const d of dates) candidates.push(path.join(imgsDir, d, "cover-brief.json"));
    }
    for (const c of candidates) {
      if (fs.existsSync(c)) return parseBriefFile(c);
      tried.push(c);
    }
  }
  throw new Error(`no cover brief found. Tried:\n  ${tried.join("\n  ")}\nPass --brief <path|inline-json>.`);
}

function parseBriefFile(file: string): LoadedBrief {
  const raw = fs.readFileSync(file, "utf8");
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file}: not JSON (${(err as Error).message})`);
  }
  // publisher writes `{ brief: {...}, summaryOk, summaryReason, at }`; accept a bare brief too.
  const payload = parsed?.brief ?? parsed;
  const brief = parseCoverBrief(JSON.stringify(payload));
  if (!brief || !brief.subject) throw new Error(`${file}: no usable brief (need subject/palette)`);
  return { brief, source: file };
}

/**
 * `--all-image`: collapse gateway enumeration by normalised id, because the gateway
 * lists the same model twice (`cn:x` + `workbuddy/cn:x` mirror). The bare
 * `<group>:<model>` form wins (that is what the gateway accepts); mirrors are
 * reported as `collapsed` so the operator can see them.
 */
export function dedupeImageModels(ids: string[]): { models: string[]; collapsed: string[] } {
  const chosen = new Map<string, string>();
  const collapsed: string[] = [];
  for (const id of ids) {
    const norm = normalizeImageModelId(id);
    const prev = chosen.get(norm);
    if (prev === undefined) {
      chosen.set(norm, id);
      continue;
    }
    collapsed.push(id);
    if (prev !== norm && id === norm) chosen.set(norm, id);
  }
  return { models: [...chosen.values()], collapsed };
}

// ── cli ────────────────────────────────────────────────────────────────────

interface Args {
  models?: string;
  allImage: boolean;
  brief?: string;
  alias: string;
  date?: string;
  size: string;
  outDir: string;
  timeoutSec: number;
  jsonOnly: boolean;
  gateway?: string;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    allImage: false,
    alias: process.env.WF_ALIAS ?? "second",
    size: DEFAULT_COVER_SIZE,
    outDir: path.join(APP_DIR, "data", "research"),
    timeoutSec: 60,
    jsonOnly: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case "--models":
        args.models = next();
        break;
      case "--all-image":
        args.allImage = true;
        break;
      case "--brief":
        args.brief = next();
        break;
      case "--alias":
        args.alias = next();
        break;
      case "--date":
        args.date = next();
        break;
      case "--size":
        args.size = next();
        break;
      case "--out-dir":
        args.outDir = path.resolve(process.cwd(), next());
        break;
      case "--timeout-sec":
        args.timeoutSec = Number(next());
        break;
      case "--json-only":
        args.jsonOnly = true;
        break;
      case "--gw":
      case "--gateway":
        args.gateway = next();
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        throw new Error(`unknown option: ${a}`);
    }
  }
  if (!Number.isFinite(args.timeoutSec) || args.timeoutSec <= 0) throw new Error("--timeout-sec must be > 0");
  if (!/^\d{2,5}x\d{2,5}$/.test(args.size)) throw new Error(`--size must look like 900x383 (got ${args.size})`);
  return args;
}

const HELP = `image-model-probe — image model census for the AI cover chain (design §C-1/C-2)

Usage:
  bun tools/image-model-probe.ts --all-image [options]
  bun tools/image-model-probe.ts --models <id,id,...> [options]

Options:
  --models <ids>       comma separated model ids, passed to the gateway verbatim
                       (the raw id is recorded — no normalisation, so a bad
                       "workbuddy/cn:x" prefix shows up as a failure)
  --all-image          enumerate image models via GET /v1/models (listImageModels),
                       collapsed by normalised id so mirror prefixes don't skew the matrix
  --brief <v>          cover brief: path to cover-brief.json, or inline JSON.
                       Default: data/<alias>/cover-brief.json, then
                       data/<alias>/imgs/<date|latest>/cover-brief.json
                       (no brief → error; a fabricated brief would make rows incomparable)
  --alias <name>       account alias for the default brief lookup (default: $WF_ALIAS | second)
  --date <YYYY-MM-DD>  prefer data/<alias>/imgs/<date>/cover-brief.json
  --size <WxH>         requested canvas (default ${DEFAULT_COVER_SIZE})
  --out-dir <dir>      output root (default data/research; samples go to <dir>/samples)
  --timeout-sec <n>    per-model request timeout (default 60)
  --gw <url>           override gateway base url (key still comes from COVER_IMAGE_API_KEY
                       or ~/.pi/agent/models.json — never from argv, to keep it out of ps)
  --json-only          print the report to stdout, write nothing
  -h, --help           this text

Output:
  <out-dir>/image-models-<YYYY-MM-DD>.json   matrix; a same-day rerun replaces the row
                                             for a re-run model and moves the old row
                                             to "history"; untouched models keep their row
  <out-dir>/samples/<model>-<HHMMSS>.<ext>   raw model output (before fit/crop)

Exit codes: 0 = report produced with at least one ok model;
             1 = operational error (gateway/brief/models/output);
             3 = report produced but every model failed (failures are data, all-fail is an alarm).
The apiKey is never printed or written; every outgoing string passes redactSecrets().
`;

export function reportFile(outDir: string, date: string): string {
  return path.join(outDir, `image-models-${date}.json`);
}

/**
 * "No model answered" must not look like a clean run. Individual failures are data
 * (they belong in the report), but an all-failed matrix is an outage and the process
 * must be non-zero so cron/CI/`set -e` catches it.
 */
export const EXIT_ALL_FAILED = 3;

export function exitCodeFor(rows: ProbeRow[]): number {
  return rows.length > 0 && rows.every((r) => !r.ok) ? EXIT_ALL_FAILED : 0;
}

function todayLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function printTable(report: ProbeReport, out: (s: string) => void): void {
  const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));
  out(pad("model", 34) + pad("ok", 4) + pad("status", 7) + pad("size", 11) + pad("ttfb", 8) + pad("total", 8) + pad("bytes", 9) + "score");
  for (const r of report.rows) {
    const score = r.score ? `${r.score.passed.length}/4 pass${r.score.failed.length ? ` (fail: ${r.score.failed.join(",")})` : ""}` : "-";
    out(
      pad(r.model, 34) +
        pad(r.ok ? "yes" : "no", 4) +
        pad(String(r.status ?? "-"), 7) +
        pad(r.returnedSize ?? "-", 11) +
        pad(r.ttfbMs === null ? "-" : `${r.ttfbMs}ms`, 8) +
        pad(`${r.totalMs}ms`, 8) +
        pad(String(r.bytes ?? "-"), 9) +
        score,
    );
    if (!r.ok) out(`  └─ ${r.reason}`);
  }
  const s = report.summary;
  out("");
  out(`summary: ok=${s.ok} failed=${s.failed} snapped=${s.snapped ?? 0} median=${s.medianMs ?? "-"}ms fastest=${s.fastest ?? "-"} slowest=${s.slowest ?? "-"}`);
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`❌ ${(err as Error).message}\n\n${HELP}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(HELP);
    return;
  }

  // 1) gateway (config → env → ~/.pi/agent/models.json)
  const gw = resolveImageGateway({ gateway: args.gateway });
  if (!gw) {
    console.error("❌ no image gateway. Set COVER_IMAGE_API_KEY + --gw, or ~/.pi/agent/models.json providers.meta-gateway");
    process.exit(1);
  }
  const secrets = [gw.apiKey];

  // 2) brief (identical for every model → comparable rows)
  let loaded: LoadedBrief;
  try {
    loaded = loadBrief(args.brief, args.alias, args.date);
  } catch (err) {
    console.error(`❌ ${(err as Error).message}`);
    process.exit(1);
  }

  // 3) models
  let models: string[] = [];
  if (args.models) {
    models = args.models.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (args.allImage) {
    const listed = await listImageModels({ baseUrl: gw.baseUrl, apiKey: gw.apiKey, source: "probe" });
    if (listed === null) {
      console.error(`❌ GET ${gw.baseUrl}/models failed — gateway unreachable or key rejected (models ?)`);
      process.exit(1);
    }
    const { models: deduped, collapsed } = dedupeImageModels(listed);
    models = [...new Set([...models, ...deduped])];
    console.error(`enumerated ${listed.length} image ids → ${deduped.length} unique models${collapsed.length ? ` (collapsed ${collapsed.join(", ")})` : ""}`);
  }
  if (!models.length) {
    console.error("❌ no models to probe. Use --all-image or --models a,b,c");
    process.exit(1);
  }

  const startedAt = new Date().toISOString();
  console.error(
    `probing ${models.length} model(s) via ${gw.baseUrl} (key ${maskKey(gw.apiKey)}, source ${gw.source})\n` +
      `brief: ${loaded.source}\nrequested size: ${args.size}, timeout ${args.timeoutSec}s`,
  );

  // 4) probe sequentially — parallel calls would contend for the same upstream quota
  //    and make latency numbers meaningless.
  const rows: ProbeRow[] = [];
  for (const model of models) {
    console.error(`→ ${model}`);
    const row = await probeOneImage(gw, model, loaded.brief, {
      outDir: args.outDir,
      size: args.size,
      timeoutSec: args.timeoutSec,
      writeFiles: !args.jsonOnly,
      knownSecrets: secrets,
    });
    // Belt and braces: nothing readable-by-anyone may carry the key.
    if (row.reason) row.reason = redactSecrets(row.reason, secrets);
    console.error(`  ${row.ok ? "ok" : "FAIL"} ${row.totalMs}ms ${row.returnedSize ?? "-"}${row.reason ? ` — ${row.reason}` : ""}`);
    rows.push(row);
  }

  const fresh: ProbeReport = {
    startedAt,
    finishedAt: new Date().toISOString(),
    gateway: gw.baseUrl,
    brief: loaded.brief,
    size: args.size,
    thresholds: SCORE_THRESHOLDS,
    rows,
    summary: summarize(rows),
    apiKeyHint: maskKey(gw.apiKey),
  };

  if (args.jsonOnly) {
    console.log(JSON.stringify(fresh, null, 2));
    const code = exitCodeFor(fresh.rows);
    if (code !== 0) console.error(`⚠️  every model failed (${fresh.rows.length}/${fresh.rows.length}) — exit ${code}`);
    process.exitCode = code;
    return;
  }

  const date = args.date ?? todayLocal();
  const file = reportFile(args.outDir, date);
  let report = fresh;
  try {
    fs.mkdirSync(args.outDir, { recursive: true });
    if (fs.existsSync(file)) {
      try {
        report = mergeReport(JSON.parse(fs.readFileSync(file, "utf8")) as ProbeReport, fresh);
      } catch {
        console.error(`⚠️  ${file} unreadable — overwriting with this run`);
      }
    }
    report.summary = summarize(report.rows);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(report, null, 2) + "\n");
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error(`❌ cannot write report: ${(err as Error).message}`);
    process.exit(1);
  }
  printTable(report, (s) => console.log(s));
  console.log(`\nreport: ${file}`);
  if (report.history?.length) console.log(`history: ${report.history.length} superseded row(s) kept`);
  const code = exitCodeFor(report.rows);
  if (code !== 0) console.error(`⚠️  every model failed (${report.summary.failed}/${report.rows.length}) — exit ${code}`);
  process.exitCode = code;
}

if (import.meta.main) {
  await main();
}
