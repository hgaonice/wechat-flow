import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { log } from "./log.ts";

/** Generate a deterministic 900x500 cover via ImageMagick (`convert`). */

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

/**
 * Generate a 900x500 cover via ffmpeg lavfi + drawtext (no ImageMagick).
 * Layout mirrors the template cover: blue gradient-ish base, translucent
 * frame, centred title (≤2 lines) and subtitle.
 */
export async function generateFfmpegCover(input: CoverInput): Promise<string> {
  fs.mkdirSync(path.dirname(input.outPath), { recursive: true });
  const font = detectCjkFont(input.font);
  const titleLines = wrap(input.title, 13, 2).map(escapeDrawtext);
  const subtitle = escapeDrawtext(input.subtitle);

  const filters: string[] = [
    // Base: vertical gradient #0F4C81 → #2D8AE0 via gradients source.
    "gradients=size=900x500:c0=0x0F4C81:c1=0x2D8AE0:speed=1",
    // Translucent inner frame 40,40 → 860,460.
    "drawbox=x=40:y=40:w=820:h=420:color=white@0.10:t=fill",
  ];
  if (font) {
    const y0 = titleLines.length > 1 ? 158 : 188; // visually centred
    titleLines.forEach((line, i) => {
      filters.push(
        `drawtext=fontfile=${font}:text='${line}':fontcolor=white:fontsize=46:x=(w-text_w)/2:y=${y0 + i * 62}`,
      );
    });
    filters.push(
      `drawtext=fontfile=${font}:text='${subtitle}':fontcolor=0xE6F0FF:fontsize=26:x=(w-text_w)/2:y=310`,
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
  log.info(`cover generated via ffmpeg: ${input.outPath}${font ? "" : " (no CJK font found!)"}`);
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

function run(cmd: string, args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => (stderr += c));
    child.on("error", (err) => resolve({ code: null, stderr: err.message }));
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

export interface CoverInput {
  outPath: string;
  title: string;
  subtitle: string;
  font?: string;
}

export async function generateTemplateCover(input: CoverInput): Promise<string> {
  fs.mkdirSync(path.dirname(input.outPath), { recursive: true });
  const font = detectCjkFont(input.font);
  const titleLines = wrap(input.title, 13, 2);
  const args: string[] = ["-size", "900x500", "gradient:#0F4C81-#2D8AE0"];
  if (font) args.push("-font", font);
  args.push(
    "-fill", "rgba(255,255,255,0.10)", "-draw", "rectangle 40,40 860,460",
  );
  // Title lines centered around the middle.
  const y0 = titleLines.length > 1 ? -70 : -40;
  titleLines.forEach((line, i) => {
    args.push("-fill", "#FFFFFF", "-pointsize", "46", "-gravity", "center",
      "-annotate", `+0${y0 + i * 62}`, line);
  });
  args.push(
    "-fill", "#E6F0FF", "-pointsize", "26", "-gravity", "center",
    "-annotate", "+0+60", input.subtitle,
  );
  args.push(input.outPath);

  const { code, stderr } = await run("convert", args);
  if (code !== 0) {
    log.warn(`template cover failed (exit ${code}): ${stderr.slice(0, 200)}`);
    throw new Error(`cover generation failed: ${stderr.slice(0, 200)}`);
  }
  log.info(`cover generated: ${input.outPath}${font ? "" : " (no CJK font found!)"}`);
  return input.outPath;
}
