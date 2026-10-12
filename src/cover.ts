import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { log } from "./log.ts";

/** Generate a deterministic 900x500 cover via ImageMagick (`convert`). */

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
