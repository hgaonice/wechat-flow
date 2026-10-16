import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "./config.ts";
import { APP_DIR } from "./config.ts";
import { log } from "./log.ts";

/**
 * 文章末尾互动引导语（CTA）——确定性后处理。
 *
 * 分层铁律（.trellis/spec/engine/ai-determinism.md）：
 *   - 文风/内容由 prompts（AI 侧）负责（prompts/article.md + prompts/cta/<alias>.md）；
 *   - “必须有引导语”由本模块用可重跑、可断言的方式保证，绝不阻断发布。
 * 唯一注入点是 publisher.runArticleGeneration()，生成/复用/控制台三条路径都经过它。
 *
 * 日志契约：present / appended / disabled / skipped（见 design §2.4）。
 */

/**
 * 引导语动作词（用于确定性检测，均按出现与否计数，不重复计）。
 * 只收「引导动作」本身：`分享`/`关注` 太常见（普通结尾也可能出现），
 * 放进检测词会让非引导结尾被误判为“已有引导语”而**不补**，破坏「必有」承诺（复核 F1）。
 */
export const ACTION_WORDS = ["点赞", "在看", "转发", "收藏", "评论", "留言"];

/** 只看正文尾部这么多个字符。 */
export const TAIL_CHARS = 500;

/** 尾部命中 ≥2 个不同动作词 → 视为 AI 已写引导语（有意放宽，避免追加造成重复感）。 */
export const MIN_ACTION_HITS = 2;

/** 追加块自身必须显式含 ≥3 类动作词（D6），否则降级。 */
export const MIN_BLOCK_ACTIONS = 3;

/** 文件全部缺失时的兜底文案，保证“必有”（R6）；含 ≥3 动作词。 */
const BUILTIN_CTA = [
  "> 如果这篇讲解对你有帮助，欢迎**点赞**、点个**在看**，",
  "> **转发**给正在为这类题发愁的同学；也别忘了**收藏**，复习时随时翻回来。",
  "> 有问题欢迎在**评论**区**留言**交流；关注「{{accountName}}」，我们下次继续。",
].join("\n");

export interface CtaApplyResult {
  action: "present" | "appended" | "disabled" | "skipped";
  /** 供日志/验收断言的可读细节。 */
  detail: string;
}

/** 统计一段文本里出现的“不同”动作词个数。 */
export function countActionWords(text: string): number {
  let hits = 0;
  for (const word of ACTION_WORDS) if (text.includes(word)) hits++;
  return hits;
}

/**
 * 拆分 frontmatter 与正文：frontmatter 原样保留字节（首个闭合 `---` 定位）。
 * 与 publisher.parseFrontmatter 的边界一致。
 */
export function splitFrontmatter(markdown: string): { frontmatter: string; body: string } {
  const m = markdown.match(/^---\r?\n[\s\S]*?\r?\n---/);
  if (!m) return { frontmatter: "", body: markdown };
  const frontmatter = m[0];
  return { frontmatter, body: markdown.slice(frontmatter.length) };
}

/** 正文尾部是否已有引导语（纯函数，可断言）。 */
export function hasCtaHint(body: string): boolean {
  return countActionWords(body.slice(-TAIL_CHARS)) >= MIN_ACTION_HITS;
}

/**
 * 归一化 + 追加；已有则原样返回；保证幂等（同一输入跑两次字节一致）。
 * 不动 frontmatter；不做任何“润色/改写”。
 */
export function ensureCtaBlock(
  markdown: string,
  block: string,
): { markdown: string; appended: boolean } {
  const { frontmatter, body } = splitFrontmatter(markdown);
  if (hasCtaHint(body)) return { markdown, appended: false };
  const trimmed = body.replace(/\s+$/, "");
  return { markdown: `${frontmatter}${trimmed}\n\n${block.trim()}\n`, appended: true };
}

/** 渲染 {{accountName}} / {{author}} / {{accountAlias}} 占位符（不依赖 prompts.ts 的文件 I/O）。 */
function renderVars(text: string, cfg: AppConfig): string {
  return text
    .split("{{accountName}}").join(cfg.accountName)
    .split("{{author}}").join(cfg.author)
    .split("{{accountAlias}}").join(cfg.accountAlias);
}

/**
 * 解析 CTA 文案，降级链（design §2.3）：
 *   1. cfg.cta.file（相对路径按 cwd 解析）
 *   2. <prompts>/cta/<alias>.md
 *   3. <prompts>/cta/default.md
 *   4. 内置常量（source=builtin）
 * 每个候选都需显式含 ≥3 类动作词，否则跳过；全部不合格返回 null。
 */
export function resolveCtaBlock(cfg: AppConfig): { text: string; source: string } | null {
  const candidates: Array<{ file: string; source: string }> = [];
  const custom = cfg.cta?.file?.trim();
  if (custom) {
    candidates.push({
      file: path.isAbsolute(custom) ? custom : path.resolve(APP_DIR, custom),
      source: custom,
    });
  }
  candidates.push({
    file: path.join(cfg.paths.prompts, "cta", `${cfg.accountAlias}.md`),
    source: `prompts/cta/${cfg.accountAlias}.md`,
  });
  candidates.push({
    file: path.join(cfg.paths.prompts, "cta", "default.md"),
    source: "prompts/cta/default.md",
  });

  for (const c of candidates) {
    if (!fs.existsSync(c.file)) continue;
    try {
      const text = renderVars(fs.readFileSync(c.file, "utf8"), cfg);
      if (countActionWords(text) >= MIN_BLOCK_ACTIONS) return { text, source: c.source };
      log.warn(`cta: ${c.source} 动作词不足（<${MIN_BLOCK_ACTIONS}），改用下一候选`);
    } catch (err) {
      log.warn(`cta: 读取 ${c.source} 失败：${(err as Error).message}`);
    }
  }

  const builtin = renderVars(BUILTIN_CTA, cfg);
  if (countActionWords(builtin) >= MIN_BLOCK_ACTIONS) return { text: builtin, source: "builtin" };
  return null;
}

/**
 * 薄 I/O 包装：读文章 → ensure → 变更时写回；永不抛错（R6 降级）。
 * - `cta.enabled=false` → disabled（不写，只记日志）
 * - 尾部已有引导语 → present（原样保留）
 * - 缺失 → appended（写回标准块）
 * - 任何异常 → skipped + warn，文章主体照常发布
 */
export function applyCtaToArticle(cfg: AppConfig, articlePath: string): CtaApplyResult {
  try {
    if (cfg.cta?.enabled === false) {
      return { action: "disabled", detail: "config — CTA 已关闭" };
    }

    const resolved = resolveCtaBlock(cfg);
    if (!resolved) {
      log.warn("cta: skipped — no valid CTA block (builtin validation failed)");
      return { action: "skipped", detail: "block failed validation: no valid CTA block" };
    }

    const original = fs.readFileSync(articlePath, "utf8");
    const { markdown, appended } = ensureCtaBlock(original, resolved.text);
    if (!appended) {
      const hits = countActionWords(splitFrontmatter(original).body.slice(-TAIL_CHARS));
      return { action: "present", detail: `tail hits=${hits}` };
    }

    fs.writeFileSync(articlePath, markdown);
    return { action: "appended", detail: `from ${resolved.source} (chars=${resolved.text.trim().length})` };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn(`cta: skipped — ${detail}`);
    return { action: "skipped", detail };
  }
}
