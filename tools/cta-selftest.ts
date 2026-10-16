#!/usr/bin/env bun
/**
 * cta-selftest.ts — 文章末尾互动引导语（CTA）确定性自测（零依赖，bun 直跑）。
 *
 *   bun tools/cta-selftest.ts
 *
 * 覆盖 design §2.1/§2.2/§2.3 的检测、追加、幂等、frontmatter 保留与降级链，
 * 以及 applyCtaToArticle 的 present/appended/disabled 三条路径（AC2/AC7）。
 * 任一条失败 → 打印 FAIL 并以退出码 1 结束。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/config.ts";
import {
  ACTION_WORDS,
  applyCtaToArticle,
  countActionWords,
  ensureCtaBlock,
  hasCtaHint,
  resolveCtaBlock,
  splitFrontmatter,
} from "../src/cta.ts";

let failures = 0;
function check(name: string, cond: boolean, extra?: string): void {
  if (cond) {
    console.log(`PASS ${name}`);
  } else {
    failures++;
    console.log(`FAIL ${name}${extra ? " — " + extra : ""}`);
  }
}

const block =
  "> 如果这篇内容对你有帮助，欢迎**点赞**、**转发**、**收藏**，也欢迎在**评论**区**留言**。\n";

// ---------------------------------------------------------------- 1) present
const withCta = `---\ntitle: 测试标题\nauthor: 巧思初数\n---\n\n# 正文\n\n讲完一道题。\n\n${block}`;
const r1 = ensureCtaBlock(withCta, block);
check("1-present-no-change", r1.appended === false && r1.markdown === withCta);

// ---------------------------------------------------------------- 2) appended
const plain = `---\ntitle: 测试标题\nauthor: 巧思初数\n---\n\n# 正文\n\n今天讲一次函数。\n`;
const r2 = ensureCtaBlock(plain, block);
const appendedPart = r2.markdown.slice(plain.trimEnd().length);
check(
  "2-appended-with-actions",
  r2.appended === true && countActionWords(appendedPart) >= 3,
  `appended actions=${countActionWords(appendedPart)}`,
);

// ----------------------------------------- 3) mid-body 收藏 is not a false positive
// 「收藏」出现在离结尾 > TAIL_CHARS 的正文中段，尾部没有引导语 → 仍应追加。
const filler = "这是一段讲解内容，用来把正文撑长。".repeat(60); // 720 字
const midBody = `---\ntitle: t\n---\n\n# 正文\n\n前面提过把结论**收藏**起来。\n\n${filler}\n\n结尾这里没有引导语。\n`;
check(
  "3-mid-收藏-not-hint",
  hasCtaHint(splitFrontmatter(midBody).body) === false,
  "tail should not be treated as CTA",
);
const r3 = ensureCtaBlock(midBody, block);
check("3b-mid-收藏-still-appended", r3.appended === true);

// ---------------------------------------------------------------- 4) idempotent
const once = ensureCtaBlock(plain, block).markdown;
const twice = ensureCtaBlock(once, block);
check("4-idempotent-byte-identical", twice.appended === false && twice.markdown === once);

// ---------------------------------------------------------------- 5) frontmatter
const fmBefore = splitFrontmatter(plain).frontmatter;
const r5 = ensureCtaBlock(plain, block);
check(
  "5-frontmatter-preserved",
  splitFrontmatter(r5.markdown).frontmatter === fmBefore &&
    r5.markdown.startsWith(`---\ntitle: 测试标题\nauthor: 巧思初数\n---`),
);

// ---------------------------------------------------------------- 6) builtin fallback
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cta-selftest-"));
const mkCfg = (promptsDir: string, enabled = true): AppConfig =>
  ({
    accountAlias: "second",
    accountName: "巧思初数",
    author: "巧思初数",
    cta: { enabled },
    paths: { prompts: promptsDir },
  }) as unknown as AppConfig;

const builtin = resolveCtaBlock(mkCfg(tmp));
check(
  "6-builtin-fallback",
  builtin !== null && builtin.source === "builtin" && countActionWords(builtin.text) >= 3,
  builtin ? `source=${builtin.source}` : "null",
);

// -------------------------------------------- 7) prompts/cta/<alias>.md + render
const promptsDir = path.join(tmp, "prompts");
fs.mkdirSync(path.join(promptsDir, "cta"), { recursive: true });
fs.writeFileSync(
  path.join(promptsDir, "cta", "second.md"),
  "> 喜欢就**点赞**、**转发**、**收藏**，并在**评论**区**留言**。关注「{{accountName}}」。\n",
);
const fromFile = resolveCtaBlock(mkCfg(promptsDir));
check(
  "7-file-and-render",
  fromFile !== null &&
    fromFile.source === "prompts/cta/second.md" &&
    fromFile.text.includes("巧思初数") &&
    !fromFile.text.includes("{{accountName}}"),
  fromFile ? `source=${fromFile.source}` : "null",
);

// ------------------------------------------------- 8/9) applyCtaToArticle paths
const articlePath = path.join(tmp, "article.md");
fs.writeFileSync(articlePath, plain);

const disabled = applyCtaToArticle(mkCfg(promptsDir, false), articlePath);
check(
  "8-disabled-no-write",
  disabled.action === "disabled" && fs.readFileSync(articlePath, "utf8") === plain,
);

const applied = applyCtaToArticle(mkCfg(promptsDir, true), articlePath);
const afterApply = fs.readFileSync(articlePath, "utf8");
check(
  "9-applied-then-present",
  applied.action === "appended" &&
    hasCtaHint(splitFrontmatter(afterApply).body) &&
    applyCtaToArticle(mkCfg(promptsDir, true), articlePath).action === "present",
);

// sanity: the module's own word list still contains the four required categories
check(
  "10-required-action-words",
  ["点赞", "转发", "收藏", "评论"].every((w) => ACTION_WORDS.includes(w)),
);

// F1 回归（2026-10-16 复核）：`分享`/`关注` 属常见词，不得进入检测词表；
// 否则普通结尾会被误判为“已有引导语”→ 该补未补，破坏 R1「必有」承诺。
check(
  "11-not-common-words",
  !ACTION_WORDS.includes("分享") && !ACTION_WORDS.includes("关注"),
);
const plainConclusion = [
  "---",
  "title: t",
  "author: a",
  "---",
  "",
  "## 小结",
  "",
  "关于这个问题，我们关注的是最值，下面分享一个记忆方法。",
  "",
].join("\n");
check(
  "12-common-words-tail-still-appended",
  !hasCtaHint(splitFrontmatter(plainConclusion).body) &&
    ensureCtaBlock(plainConclusion, "-x-").appended,
);

fs.rmSync(tmp, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
