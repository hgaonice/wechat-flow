#!/usr/bin/env bun
/**
 * cover-compare.ts — same-brief / same-prompt / same-crop image-model shoot-out.
 *
 * Why: the production cover chain used `cn:hunyuan-image-alpha-edit` because it worked,
 * not because it won. "出图不达标" is a *visual* judgement, so the evidence has to be
 * viewable side by side — not a table of numbers. This tool generates the *same* topic
 * with N models and composes one vertical contact sheet per topic, so a human can pick
 * a winner (task 10-20-cover-model-upgrade, GATE-1).
 *
 * Contract: `.trellis/tasks/10-20-cover-model-upgrade/design.md` §3 (variable control),
 *           §4 (outputs), §5 (matrix row shape + exit codes).
 *
 * Reuses the **production** call path on purpose:
 *   - `generateOneImage()`  — the only gateway call site (`src/cover-ai.ts`)
 *   - `isSizeRejection()` / `SIZE_ESCALATION` — the same 1536x1024 retry the publisher does
 *   - `fitImageTo(..., "900x383")` — pixel-identical to what gets uploaded
 * Nothing here is on the publish path; nothing writes into `src/`; no npm deps.
 *
 * Usage:
 *   bun tools/cover-compare.ts                                   # 4 titles x default models
 *   bun tools/cover-compare.ts --models cogview-4 --titles 1      # smoke: 1 title
 *   bun tools/cover-compare.ts --models cogview-4,cogview-4-250304
 *   bun tools/cover-compare.ts --out-dir data/research/cc-test
 *
 * Exit codes: 0 = at least one usable row; 1 = operational error (no gateway / bad args /
 *             unwritable dir); 3 = every model failed (matrix still written, reasons inside).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULT_COVER_SIZE, fitImageTo, imageSize, parseSize } from "../src/cover.ts";
import {
  SIZE_ESCALATION,
  buildImagePrompt,
  fallbackBrief,
  generateOneImage,
  isSizeRejection,
  normalizeImageModelId,
  resolveImageGateway,
  type CoverBrief,
} from "../src/cover-ai.ts";
import { log } from "../src/log.ts";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_ROOT = path.join(APP_DIR, "data", "research");

/** Online style string — keep in sync with `cover.ai.style` on the box under test. */
export const DEFAULT_STYLE = "扁平矢量插画，几何极简，教育科技感，构图简洁留白大";
export const DEFAULT_PALETTE = ["#0F4C81", "#2D8AE0", "#FFD54F"];

/**
 * Four real topics covering the motifs this account actually publishes
 * (geometry / parabola-extremum / function-graph / statistics). Titles are inputs to
 * `fallbackBrief`, which is pure — so every model gets the *same* brief and palette.
 */
export const DEFAULT_TITLES: { title: string; slug: string }[] = [
  { title: "配方法的应用(二)：求最值，三步模型 + 端点陷阱", slug: "parabola-max" },
  { title: "相似三角形的判定（一）：两角对应相等", slug: "similar-triangle" },
  { title: "一次函数与方程、不等式：图象法解不等式", slug: "linear-graph" },
  { title: "统计图表的三个误读陷阱：纵轴截断与百分比错觉", slug: "stats-traps" },
];

/** Candidates inside the existing gateway (no new provider, no key). */
export const DEFAULT_MODELS = [
  "cn:hunyuan-image-alpha-edit",
  "cogview-4",
  "cogview-4-250304",
  "global:gpt-image-2.5-sunburst",
];

/** Models that need a credential we may not have; recorded as `skipped`, never silently dropped. */
const EXTERNAL_CANDIDATES = [
  { model: "google/gemini-nano-banana-2.1", env: "OPENROUTER_API_KEY", baseUrl: "https://openrouter.ai/api/v1" },
];

interface Row {
  model: string;
  briefId: string;
  title: string;
  ok: boolean;
  skipped?: string;
  ms?: number;
  rawSize?: string;
  finalSize?: string;
  escalated?: boolean;
  sha256?: string;
  reason?: string | null;
  files?: { raw: string; fit: string };
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function has(args: string[], name: string): boolean {
  return args.includes(name);
}

/** Explicit slugs (CJK titles have no usable ASCII): `<NN>-<topic-slug>`. */
function slugFor(slug: string, index: number): string {
  return `${String(index + 1).padStart(2, "0")}-${slug}`;
}

/** `global:gpt-image-2.5-sunburst` → `gpt-image-2.5-sunburst` (filename/pillow-label safe). */
function modelSlug(model: string): string {
  return model.replace(/^[a-z]+:/i, "").replace(/[^A-Za-z0-9.+-]+/g, "-");
}

function sha256File(p: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex").slice(0, 16);
}

function sizeStr(p: string): string | undefined {
  const s = imageSize(p);
  return s ? `${s.w}x${s.h}` : undefined;
}

/**
 * Compose the contact sheet with Pillow (already used by tools/ui-visual.py → no new dep).
 * Falls back to ffmpeg `vstack` without labels and *says so* in summary.txt (design §4).
 */
function montage(rows: { label: string; png: string }[], outPath: string): "pil" | "ffmpeg" | "none" {
  const py = `
import sys
from PIL import Image, ImageDraw, ImageFont
rows = sys.argv[1:]           # pairs: label, path
out = rows.pop(0)
pairs = list(zip(rows[0::2], rows[1::2]))
imgs = [(lab, Image.open(p).convert("RGB")) for lab, p in pairs]
pad, bar = 8, 132
w = max(im.width for _, im in imgs) + bar
h = sum(im.height + pad for _, im in imgs) + pad
canvas = Image.new("RGB", (w, h), (24, 24, 28))
try:
    font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 15)
except OSError:
    font = ImageFont.load_default()
d = ImageDraw.Draw(canvas)
y = pad
for lab, im in imgs:
    canvas.paste(im, (bar, y))
    d.text((6, y + im.height // 2 - 8), lab[:13], fill=(240, 240, 240), font=font)
    y += im.height + pad
canvas.save(out, "PNG")
print("ok")
`;
  const args = ["-c", py, outPath, ...rows.flatMap((r) => [r.label, r.png])];
  const r = spawnSync("python3", args, { encoding: "utf8" });
  if (r.status === 0) return "pil";
  log.warn(`cover-compare: PIL montage failed (${(r.stderr || "").trim().split("\n").pop()?.slice(0, 120)}) — ffmpeg fallback`);

  const ffArgs = ["-y"];
  for (const row of rows) ffArgs.push("-i", row.png);
  const n = rows.length;
  ffArgs.push("-filter_complex", `${Array.from({ length: n }, (_, i) => `[${i}:v]`).join("")}vstack=inputs=${n}[v]`, "-map", "[v]", outPath);
  const f = spawnSync("ffmpeg", ffArgs, { encoding: "utf8" });
  if (f.status === 0) return "ffmpeg";
  log.warn("cover-compare: montage unavailable (PIL + ffmpeg both failed) — originals only");
  return "none";
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (has(args, "--help") || has(args, "-h")) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
    return 0;
  }

  // ── `--remontage <dir>`: rebuild the contact sheets from an existing matrix.json.
  //    Zero gateway calls — lets a label/layout tweak be applied without re-billing images.
  const remontage = flagValue(args, "--remontage");
  if (remontage) {
    const dir = path.resolve(remontage);
    const mPath = path.join(dir, "matrix.json");
    if (!fs.existsSync(mPath)) {
      log.error(`cover-compare: no matrix.json in ${dir}`);
      return 1;
    }
    const m = JSON.parse(fs.readFileSync(mPath, "utf8")) as { rows: Row[]; models: string[] };
    const rebuilt: { briefId: string; png: string; how: string }[] = [];
    for (const briefId of [...new Set(m.rows.map((r) => r.briefId))]) {
      const rowsFor = m.models
        .map((model) => m.rows.find((r) => r.model === model && r.briefId === briefId && r.ok))
        .filter((r): r is Row => Boolean(r?.files?.fit));
      if (!rowsFor.length) continue;
      const sheetPath = path.join(dir, `compare-${briefId}.png`);
      const how = montage(rowsFor.map((r) => ({ label: modelSlug(r.model), png: path.join(dir, r.files!.fit) })), sheetPath);
      rebuilt.push({ briefId, png: path.basename(sheetPath), how });
    }
    m.rows.length; // keep shape
    fs.writeFileSync(
      mPath,
      JSON.stringify({ ...(m as object), sheets: rebuilt }, null, 2) + "\n",
    );
    for (const s of rebuilt) log.info(`cover-compare: rebuilt ${s.png} [montage=${s.how}]`);
    return rebuilt.length ? 0 : 1;
  }

  const gw = resolveImageGateway();
  if (!gw) {
    log.error("cover-compare: no image gateway (set COVER_IMAGE_GATEWAY/COVER_IMAGE_API_KEY or ~/.pi/agent/models.json)");
    return 1;
  }
  log.info(`cover-compare: gateway=${gw.baseUrl} (source=${gw.source})`);

  const style = flagValue(args, "--style") ?? DEFAULT_STYLE;
  const timeoutSec = Math.max(20, Number(flagValue(args, "--timeout") ?? 120) || 120);
  const titlesArg = flagValue(args, "--titles");
  let titles = DEFAULT_TITLES;
  if (titlesArg) {
    const n = Number(titlesArg);
    if (Number.isFinite(n) && n > 0) titles = DEFAULT_TITLES.slice(0, n);
    else
      titles = fs
        .readFileSync(titlesArg, "utf8")
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((title, i) => ({ title, slug: `custom${i + 1}` }));
  }
  if (!titles.length) {
    log.error("cover-compare: no titles");
    return 1;
  }

  const modelsArg = flagValue(args, "--models");
  const models = (modelsArg ? modelsArg.split(",") : DEFAULT_MODELS).map((m) => normalizeImageModelId(m.trim())).filter(Boolean);
  if (!models.length) {
    log.error("cover-compare: no models");
    return 1;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "");
  const outDir = path.resolve(flagValue(args, "--out-dir") ?? path.join(OUT_ROOT, `cover-compare-${stamp.slice(0, 10)}`));
  for (const sub of ["raw", "fit"]) {
    try {
      fs.mkdirSync(path.join(outDir, sub), { recursive: true });
    } catch (err) {
      log.error(`cover-compare: cannot create ${outDir}/${sub}: ${(err as Error).message}`);
      return 1;
    }
  }
  log.info(`cover-compare: ${titles.length} title(s) x ${models.length} model(s) → ${outDir}`);

  const rows: Row[] = [];
  const sheets: { briefId: string; png: string; how: string }[] = [];

  for (let ti = 0; ti < titles.length; ti++) {
    const { title, slug } = titles[ti]!;
    const briefId = slugFor(slug, ti);
    const brief: CoverBrief = fallbackBrief(title, DEFAULT_PALETTE);
    const prompt = buildImagePrompt(brief, style);
    const sheetRows: { label: string; png: string }[] = [];

    for (const model of models) {
      const stem = `${briefId}-${modelSlug(model)}`;
      const rawPath = path.join(outDir, "raw", `${stem}.png`);
      const fitPath = path.join(outDir, "fit", `${stem}.png`);
      const started = Date.now();
      let escalated = false;
      let r = await generateOneImage(gw, model, prompt, DEFAULT_COVER_SIZE, timeoutSec);
      if (!r.ok && isSizeRejection(r.reason) && DEFAULT_COVER_SIZE !== SIZE_ESCALATION) {
        log.warn(`cover-compare: ${model} rejected ${DEFAULT_COVER_SIZE} — retry at ${SIZE_ESCALATION}`);
        escalated = true;
        r = await generateOneImage(gw, model, prompt, SIZE_ESCALATION, timeoutSec);
      }
      const ms = Date.now() - started;
      if (!r.ok) {
        // Failure is data, not a skip: keep the reason verbatim (already redacted upstream).
        log.warn(`cover-compare: ${model} [${briefId}] FAILED — ${r.reason}`);
        rows.push({ model, briefId, title, ok: false, ms, escalated, reason: r.reason || "unknown failure" });
        continue;
      }
      try {
        fs.writeFileSync(rawPath, Buffer.from(r.b64, "base64"));
        await fitImageTo(rawPath, fitPath, DEFAULT_COVER_SIZE);
      } catch (err) {
        const reason = `write/fit failed: ${(err as Error).message}`;
        log.warn(`cover-compare: ${model} [${briefId}] ${reason}`);
        rows.push({ model, briefId, title, ok: false, ms, escalated, reason });
        continue;
      }
      const want = parseSize(DEFAULT_COVER_SIZE);
      const got = imageSize(fitPath);
      if (!got || got.w !== want.w || got.h !== want.h) {
        const reason = `unexpected fitted size ${got ? `${got.w}x${got.h}` : "?"} (want ${want.w}x${want.h})`;
        log.warn(`cover-compare: ${model} [${briefId}] ${reason}`);
        rows.push({ model, briefId, title, ok: false, ms, escalated, reason });
        continue;
      }
      log.info(`cover-compare: ${model} [${briefId}] ok ${(ms / 1000).toFixed(1)}s ${sizeStr(rawPath)} → ${got.w}x${got.h}`);
      rows.push({
        model,
        briefId,
        title,
        ok: true,
        ms,
        rawSize: sizeStr(rawPath),
        finalSize: `${got.w}x${got.h}`,
        escalated,
        sha256: sha256File(rawPath),
        files: { raw: path.relative(outDir, rawPath), fit: path.relative(outDir, fitPath) },
      });
      sheetRows.push({ label: modelSlug(model), png: fitPath });
    }

    if (sheetRows.length) {
      const sheetPath = path.join(outDir, `compare-${briefId}.png`);
      const how = montage(sheetRows, sheetPath);
      sheets.push({ briefId, png: path.basename(sheetPath), how });
    }
  }

  // External candidates we cannot run without a credential: explicit `skipped` rows (design §5).
  for (const ext of EXTERNAL_CANDIDATES) {
    if (process.env[ext.env]) continue;
    titles.forEach((t, i) => {
      rows.push({
        model: ext.model,
        briefId: slugFor(t.slug, i),
        title: t.title,
        ok: false,
        skipped: `no ${ext.env}`,
        reason: null,
      });
    });
  }

  const okRows = rows.filter((r) => r.ok);
  const matrixPath = path.join(outDir, "matrix.json");
  fs.writeFileSync(
    matrixPath,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), gateway: gw.baseUrl, style, size: DEFAULT_COVER_SIZE, models, rows, sheets },
      null,
      2,
    ) + "\n",
  );

  // Human-readable digest — the thing a person actually reads before looking at images.
  const lines: string[] = [];
  lines.push(`# cover-compare ${new Date().toISOString()}`);
  lines.push(`gateway: ${gw.baseUrl}`);
  lines.push(`size: ${DEFAULT_COVER_SIZE}   style: ${style}`);
  lines.push(`titles: ${titles.map((t) => t.title).join(" | ")}`);
  lines.push(`models: ${models.join(", ")}`);
  lines.push("");
  for (const model of models) {
    const mine = rows.filter((r) => r.model === model);
    const ok = mine.filter((r) => r.ok);
    const avg = ok.length ? Math.round(ok.reduce((a, r) => a + (r.ms ?? 0), 0) / ok.length / 100) / 10 : 0;
    const esc = mine.filter((r) => r.escalated).length;
    lines.push(`${model}`);
    lines.push(`  ok ${ok.length}/${mine.length}   avg ${avg}s   escalated ${esc}`);
    for (const r of mine.filter((x) => !x.ok)) lines.push(`  ✗ ${r.briefId}: ${r.reason}`);
    const sizes = [...new Set(ok.map((r) => r.rawSize).filter(Boolean))];
    if (sizes.length) lines.push(`  raw sizes: ${sizes.join(", ")}`);
  }
  const skipped = rows.filter((r) => r.skipped);
  if (skipped.length) lines.push(`skipped: ${[...new Set(skipped.map((r) => `${r.model} (${r.skipped})`))].join(", ")}`);
  lines.push("");
  lines.push(`sheets (${sheets.length}):`);
  for (const s of sheets) lines.push(`  ${s.png}  [montage=${s.how}]`);
  lines.push("");
  lines.push(`matrix: ${path.relative(APP_DIR, matrixPath)}`);
  const summaryPath = path.join(outDir, "summary.txt");
  fs.writeFileSync(summaryPath, lines.join("\n") + "\n");
  console.log("\n" + lines.join("\n") + "\n");

  if (!okRows.length) {
    log.error(`cover-compare: every model failed — see ${summaryPath}`);
    return 3;
  }
  return 0;
}

process.exit(await main());
