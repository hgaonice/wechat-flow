import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { log } from "./log.ts";

/**
 * Deterministic covers. Two renderers (ffmpeg / ImageMagick) plus a
 * deterministic "fit to exact size" post-processor used by the AI cover path.
 *
 * Default size is the WeChat 头条大图 standard 900x383 (2.35:1). Every renderer
 * takes `size` so the whole chain (AI fail → ffmpeg → template) stays on the
 * same canvas instead of silently switching dimensions on downgrade.
 */

export const DEFAULT_COVER_SIZE = "900x383";

export function parseSize(size?: string): { w: number; h: number } {
  const m = /^(\d{2,5})x(\d{2,5})$/.exec((size ?? "").trim());
  if (!m) return { w: 900, h: 383 };
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 16 || h < 16) return { w: 900, h: 383 };
  return { w, h };
}

/** Escape a drawtext text value: backslash-escape \ ' : and strip % { } to avoid expansion. */
function escapeDrawtext(s: string): string {
  return s.replace(/[%{}]/g, "").replace(/([\\':])/g, "\\$1");
}

/**
 * Pick an ffmpeg binary that actually has drawtext. Some hosts carry a
 * static ffmpeg first in PATH (e.g. /usr/local/bin/ffmpeg) built without
 * libfreetype; the distro build (/usr/bin/ffmpeg) usually has drawtext.
 */
const FFMPEG_CANDIDATES = ["/usr/bin/ffmpeg", "/bin/ffmpeg", "ffmpeg"];

async function pickFfmpegWithDrawtext(): Promise<string | undefined> {
  const { spawnSync } = await import("node:child_process");
  for (const bin of FFMPEG_CANDIDATES) {
    try {
      const r = spawnSync(bin, ["-hide_banner", "-filters"], { encoding: "utf8", timeout: 10_000 });
      if (r.status === 0 && (r.stdout ?? "").includes("drawtext")) return bin;
    } catch {
      /* try next */
    }
  }
  return undefined;
}

async function pickAnyFfmpeg(): Promise<string | undefined> {
  const { spawnSync } = await import("node:child_process");
  for (const bin of FFMPEG_CANDIDATES) {
    try {
      const r = spawnSync(bin, ["-hide_banner", "-version"], { encoding: "utf8", timeout: 10_000 });
      if (r.status === 0) return bin;
    } catch {
      /* try next */
    }
  }
  return undefined;
}

/**
 * Deterministic "cover fit": scale to fill, then center-crop to exactly `size`.
 * Image models snap to their own supported sizes (hunyuan answers 900x383 with
 * 896x368), so the requested size is only a hint — this is what guarantees the
 * final file matches the WeChat spec.
 */
export async function fitImageTo(src: string, outPath: string, size?: string): Promise<string> {
  const { w, h } = parseSize(size);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const ffmpeg = await pickAnyFfmpeg();
  if (ffmpeg) {
    const vf = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
    const { code, stderr } = await run(ffmpeg, ["-y", "-i", src, "-vf", vf, "-frames:v", "1", "-update", "1", outPath]);
    if (code === 0) return outPath;
    log.warn(`fitImageTo ffmpeg failed (exit ${code}): ${stderr.slice(0, 200)} — trying convert`);
  }
  const { code, stderr } = await run("convert", [
    src, "-resize", `${w}x${h}^`, "-gravity", "center", "-extent", `${w}x${h}`, outPath,
  ]);
  if (code !== 0) throw new Error(`fitImageTo failed: ${stderr.slice(0, 200)}`);
  return outPath;
}

/**
 * Read image dimensions by parsing the file header directly (PNG / JPEG / GIF / WebP).
 *
 * Deliberately does NOT shell out: on some hosts `ffprobe` is a symlink to a static
 * ffmpeg build that rejects ffprobe-only flags, and ImageMagick is not always
 * installed. Header parsing is deterministic and dependency-free.
 */
export function imageSize(file: string): { w: number; h: number } | undefined {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return undefined;
  }
  if (buf.length < 24) return undefined;

  // PNG: 8-byte signature, then IHDR with width/height as big-endian uint32 at 16/20.
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  // GIF: "GIF87a"/"GIF89a", little-endian uint16 at 6/8.
  if (buf.toString("ascii", 0, 3) === "GIF") {
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  }
  // WebP (VP8X): "RIFF....WEBP", canvas size at 24..30 (24-bit LE minus 1).
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buf.toString("ascii", 12, 16);
    if (chunk === "VP8X" && buf.length >= 30) {
      const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return { w, h };
    }
    if (chunk === "VP8L" && buf.length >= 25) {
      const b = buf.readUInt32LE(21);
      return { w: 1 + (b & 0x3fff), h: 1 + ((b >> 14) & 0x3fff) };
    }
  }
  // JPEG: walk segments to the first SOFn marker.
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = buf[i + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return undefined;
}

/**
 * Average RGB of an image, via one ffmpeg downscale to 1x1 rawvideo (3 bytes).
 * Used only as a cheap sanity probe: image models sometimes ignore the requested
 * dark background, and a light cover looks cheap in the WeChat list.
 */
export async function averageColor(file: string): Promise<{ r: number; g: number; b: number } | undefined> {
  const ffmpeg = await pickAnyFfmpeg();
  if (!ffmpeg) return undefined;
  const r = await run(ffmpeg, [
    "-v", "error", "-i", file, "-vf", "scale=1:1", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ]);
  if (r.code !== 0) return undefined;
  // run() accumulates stdout as utf8; the 3 raw bytes survive that round-trip.
  const bytes = Buffer.from(r.stdout, "utf8");
  if (bytes.length < 3) return undefined;
  return { r: bytes[0]!, g: bytes[1]!, b: bytes[2]! };
}

/** Perceived luminance 0..1 of an RGB triple. */
export function luminance(c: { r: number; g: number; b: number }): number {
  return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
}

/** Layout numbers derived from canvas height so any `size` looks intentional. */
function layout(h: number, lineCount: number) {
  const titleFont = Math.max(24, Math.round(h * 0.12));
  const subFont = Math.max(14, Math.round(titleFont * 0.56));
  const lineGap = Math.round(titleFont * 1.35);
  const subGap = Math.round(subFont * 1.8);
  const block = titleFont + (lineCount - 1) * lineGap + subGap + subFont;
  const top = Math.round((h - block) / 2);
  return { titleFont, subFont, lineGap, subGap, top };
}

/**
 * Generate a cover via ffmpeg lavfi + drawtext (no ImageMagick).
 * Blue gradient base, translucent frame, centred title (≤2 lines) and subtitle.
 */
export async function generateFfmpegCover(input: CoverInput): Promise<string> {
  fs.mkdirSync(path.dirname(input.outPath), { recursive: true });
  const font = detectCjkFont(input.font);
  const { w, h } = parseSize(input.size);
  const titleLines = wrap(input.title, 13, 2).map(escapeDrawtext);
  const subtitle = escapeDrawtext(input.subtitle);
  const L = layout(h, titleLines.length);
  const margin = Math.round(h * 0.104);

  const filters: string[] = [
    // Base: vertical gradient #0F4C81 → #2D8AE0 via gradients source.
    `gradients=size=${w}x${h}:c0=0x0F4C81:c1=0x2D8AE0:speed=1`,
    // Translucent inner frame.
    `drawbox=x=${margin}:y=${margin}:w=${w - margin * 2}:h=${h - margin * 2}:color=white@0.10:t=fill`,
  ];
  if (font) {
    titleLines.forEach((line, i) => {
      filters.push(
        `drawtext=fontfile=${font}:text='${line}':fontcolor=white:fontsize=${L.titleFont}:x=(w-text_w)/2:y=${L.top + L.titleFont + i * L.lineGap}`,
      );
    });
    filters.push(
      `drawtext=fontfile=${font}:text='${subtitle}':fontcolor=0xE6F0FF:fontsize=${L.subFont}:x=(w-text_w)/2:y=${L.top + L.titleFont + titleLines.length * L.lineGap + L.subGap - L.subFont}`,
    );
  } else {
    log.warn("ffmpeg cover: no CJK font found, text will be skipped");
  }

  const ffmpeg = await pickFfmpegWithDrawtext();
  if (!ffmpeg) {
    throw new Error("no ffmpeg with drawtext support found (tried /usr/bin/ffmpeg, /bin/ffmpeg, ffmpeg)");
  }

  const args = ["-y", "-f", "lavfi", "-i", filters.join(","), "-frames:v", "1", "-update", "1", input.outPath];
  const { code, stderr } = await run(ffmpeg, args);
  if (code !== 0) {
    log.warn(`ffmpeg cover failed (exit ${code}): ${stderr.slice(0, 300)}`);
    throw new Error(`ffmpeg cover generation failed: ${stderr.slice(0, 300)}`);
  }
  log.info(`cover generated via ffmpeg (${w}x${h}): ${input.outPath}${font ? "" : " (no CJK font found!)"}`);
  return input.outPath;
}

const FONT_CANDIDATES = [
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc",
  "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
  "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
  "/usr/share/fonts/truetype/arphic/uming.ttc",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
];

export function detectCjkFont(configured?: string): string | undefined {
  if (configured && fs.existsSync(configured)) return configured;
  for (const f of FONT_CANDIDATES) if (fs.existsSync(f)) return f;
  return undefined;
}

function wrap(text: string, perLine: number, maxLines: number): string[] {
  const chars = [...text.trim()];
  const lines: string[] = [];
  for (let i = 0; i < chars.length && lines.length < maxLines; i += perLine) {
    lines.push(chars.slice(i, i + perLine).join(""));
  }
  if (lines.length === maxLines && chars.length > perLine * maxLines) {
    lines[maxLines - 1] = lines[maxLines - 1].slice(0, perLine - 1) + "…";
  }
  return lines.length ? lines : [""];
}

function run(cmd: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));
    child.on("error", (err) => resolve({ code: null, stdout, stderr: err.message }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export interface CoverInput {
  outPath: string;
  title: string;
  subtitle: string;
  font?: string;
  /** "900x383" (default) — WeChat 头条大图 2.35:1. */
  size?: string;
}

export async function generateTemplateCover(input: CoverInput): Promise<string> {
  fs.mkdirSync(path.dirname(input.outPath), { recursive: true });
  const font = detectCjkFont(input.font);
  const { w, h } = parseSize(input.size);
  const titleLines = wrap(input.title, 13, 2);
  const L = layout(h, titleLines.length);
  const margin = Math.round(h * 0.104);
  const args: string[] = ["-size", `${w}x${h}`, "gradient:#0F4C81-#2D8AE0"];
  if (font) args.push("-font", font);
  args.push(
    "-fill", "rgba(255,255,255,0.10)", "-draw",
    `rectangle ${margin},${margin} ${w - margin},${h - margin}`,
  );
  // Title lines centred around the middle; offsets are relative to canvas centre.
  const centre = h / 2;
  const block = L.titleFont + (titleLines.length - 1) * L.lineGap + L.subGap + L.subFont;
  const firstCentre = centre - block / 2 + L.titleFont / 2;
  titleLines.forEach((line, i) => {
    const y = Math.round(firstCentre + i * L.lineGap - centre);
    args.push("-fill", "#FFFFFF", "-pointsize", String(L.titleFont), "-gravity", "center",
      "-annotate", y >= 0 ? `+0+${y}` : `+0${y}`, line);
  });
  const subY = Math.round(firstCentre + (titleLines.length - 1) * L.lineGap + L.subGap - centre + L.subFont / 2);
  args.push(
    "-fill", "#E6F0FF", "-pointsize", String(L.subFont), "-gravity", "center",
    "-annotate", subY >= 0 ? `+0+${subY}` : `+0${subY}`, input.subtitle,
  );
  args.push(input.outPath);

  const { code, stderr } = await run("convert", args);
  if (code !== 0) {
    log.warn(`template cover failed (exit ${code}): ${stderr.slice(0, 200)}`);
    throw new Error(`cover generation failed: ${stderr.slice(0, 200)}`);
  }
  log.info(`cover generated (${w}x${h}): ${input.outPath}${font ? "" : " (no CJK font found!)"}`);
  return input.outPath;
}
