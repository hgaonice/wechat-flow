/**
 * math.ts — 把文章里的 LaTeX 公式（$...$ / $$...$$）在发布前转成内联 SVG。
 *
 * 为什么要自己转：上游 skill 的 Markdown→HTML 是在 bun/Node 里跑的，
 * 而 baoyu-md 只有在 `typeof window !== "undefined"` 时才启用 MathJax 公式扩展，
 * 所以 $...$ 会被原样当成文本发出去（实测：正文字面出现 $\frac{...}$，svg 数 = 0）。
 *
 * 为什么是内联 SVG：实测微信编辑器会保留内联 <svg>（粘贴后、保存后、重新打开后都在），
 * 且 dvisvgm --no-fonts 把字形转成路径，读者端不需要装数学字体。
 * 而 KaTeX/MathJax 那种「HTML+CSS+JS」方案在微信里是死的（不执行 JS、会剥 class）。
 *
 * 设计原则：
 *   · 只在**确定是公式**时才替换；认不出来就原样保留（宁可难看，不可报错/丢内容）。
 *   · 逐条缓存到 data/<alias>/imgs/formula/<sha1>.html，重复发布不再编译。
 *   · 单条公式编译失败不影响整篇：记 warning，保留原文。
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { log } from "./log.ts";

export interface MathOptions {
  enabled?: boolean;
  /** 行内公式高度，默认 1.5em */
  height?: string;
  /** 整体缩放系数，默认 1 */
  scale?: number;
  /** 公式颜色（留空跟随正文色） */
  color?: string;
  /** bin/tex2svg.py 的路径 */
  scriptPath?: string;
  /** 缓存目录（通常是 paths.imgs/formula） */
  cacheDir?: string;
  python?: string;
  timeoutMs?: number;
}

export interface MathResult {
  markdown: string;
  rendered: number;
  failed: string[];
  skipped: number;
}

/** 一条公式在正文里的位置与形式。 */
interface Token {
  start: number;
  end: number;
  tex: string;
  display: boolean;
}

/** 行内公式：$...$，内容不许有换行/未转义 $；前后不能是数字（避免 $5、$100 误判）。 */
const INLINE_RE = /(?<![\w$\\])\$(?![\s$])((?:[^$\n\\]|\\.)+?)(?<![\s\\])\$(?![\w$])/g;
/** 块级公式：$$...$$，可跨行。 */
const DISPLAY_RE = /\$\$[ \t]*\n?([\s\S]+?)\n?[ \t]*\$\$/g;
/** 反斜杠写法 \(...\) 与 \[...\]。 */
const PAREN_RE = /\\\(([\s\S]+?)\\\)/g;
const BRACKET_RE = /\\\[([\s\S]+?)\\\]/g;
/** 行内代码 / 围栏代码块：这些区域里的 $ 不是公式。 */
const FENCE_RE = /^(```|~~~)[\s\S]*?^\1.*$/gm;
const CODE_SPAN_RE = /`[^`\n]*`/g;

function isLikelyMath(tex: string): boolean {
  const t = tex.trim();
  if (!t) return false;
  // 必须含 LaTeX 命令或上下标/分式等数学记号，否则极可能是普通文本里的 $…$
  if (!/\\[a-zA-Z]+|[\^_=<>≤≥≠±×÷√∑∫]|\d\s*[+\-*/]\s*\d/.test(t)) return false;
  // 纯中文/纯单词的直接放过
  if (/^[\u4e00-\u9fa5，。！？；：、"'（）\s]+$/.test(t)) return false;
  return true;
}

/** 收集所有公式，跳过代码区域。 */
function collect(md: string): Token[] {
  const masked = new Array<string>(md.length).fill(" ");
  const mask = (re: RegExp) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(md))) for (let i = m.index; i < m.index + m[0].length; i++) masked[i] = "#";
  };
  mask(FENCE_RE);
  mask(CODE_SPAN_RE);

  const insideCode = (i: number) => masked[i] === "#";
  const found: Token[] = [];
  const seen: Array<[number, number]> = [];
  const overlaps = (s: number, e: number) => seen.some(([a, b]) => s < b && e > a);

  const scan = (re: RegExp, display: boolean, group = 1) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(md))) {
      const s = m.index;
      const e = s + m[0].length;
      if (insideCode(s) || overlaps(s, e)) continue;
      const tex = (m[group] ?? "").trim();
      if (!isLikelyMath(tex)) continue;
      found.push({ start: s, end: e, tex, display });
      seen.push([s, e]);
    }
  };

  // 先块级（$$...$$），再括号写法，最后行内
  scan(DISPLAY_RE, true);
  scan(BRACKET_RE, true);
  scan(PAREN_RE, false);
  scan(INLINE_RE, false);
  return found.sort((a, b) => a.start - b.start);
}

function renderOne(tex: string, display: boolean, opts: Required<Pick<MathOptions, "height" | "scale" | "python" | "timeoutMs">> & MathOptions): string | undefined {
  const script = opts.scriptPath ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), "../bin/tex2svg.py");
  const cacheDir = opts.cacheDir;
  const key = crypto
    .createHash("sha1")
    .update([tex, display ? "D" : "I", opts.height, opts.scale, opts.color ?? ""].join("\u0000"))
    .digest("hex")
    .slice(0, 16);

  if (cacheDir) {
    const cached = path.join(cacheDir, `${key}.html`);
    if (fs.existsSync(cached)) return fs.readFileSync(cached, "utf8").trim();
  }

  const args = [script, "--height", opts.height, "--scale", String(opts.scale)];
  if (display) args.push("--display");
  if (opts.color) args.push("--color", opts.color);
  args.push(tex);

  const r = spawnSync(opts.python, args, { encoding: "utf8", timeout: opts.timeoutMs });
  if (r.status !== 0 || !r.stdout?.trim().startsWith("<")) {
    log.warn(`formula render failed: ${tex.slice(0, 60)} — ${(r.stderr || r.stdout || "").slice(-200)}`);
    return undefined;
  }
  const html = r.stdout.trim();
  if (cacheDir) {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, `${key}.html`), html, "utf8");
  }
  return html;
}

export function mathEnabled(cfg: { math?: MathOptions }): boolean {
  return cfg.math?.enabled === true;
}

/**
 * 把 Markdown 里的公式替换成内联 SVG。返回新 markdown（原文件不改）。
 */
export function renderFormulasInMarkdown(md: string, opts: MathOptions = {}): MathResult {
  const options = {
    height: opts.height ?? "1.5em",
    scale: opts.scale ?? 1,
    color: opts.color,
    python: opts.python ?? "python3",
    timeoutMs: opts.timeoutMs ?? 60000,
    scriptPath: opts.scriptPath,
    cacheDir: opts.cacheDir,
  };
  const tokens = collect(md);
  if (!tokens.length) return { markdown: md, rendered: 0, failed: [], skipped: 0 };

  let out = "";
  let cursor = 0;
  let rendered = 0;
  const failed: string[] = [];

  for (const t of tokens) {
    out += md.slice(cursor, t.start);
    const html = renderOne(t.tex, t.display, options);
    if (html) {
      out += html;
      rendered++;
    } else {
      out += md.slice(t.start, t.end); // 失败就保留原文，不阻断发布
      failed.push(t.tex.slice(0, 60));
    }
    cursor = t.end;
  }
  out += md.slice(cursor);

  if (rendered) log.info(`formulas: ${rendered} rendered as inline SVG${failed.length ? `, ${failed.length} failed` : ""}`);
  if (failed.length) log.warn(`公式未渲染（已保留原文）：${failed.join(" | ")}`);
  return { markdown: out, rendered, failed, skipped: 0 };
}

/** 是否存在公式（用于日志/提示）。 */
export function hasFormula(md: string): boolean {
  return collect(md).length > 0;
}
