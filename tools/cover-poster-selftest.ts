/**
 * Cover poster self-test — 纯函数，无网络、无 pi、无图像模型。
 *
 * Run: bun tools/cover-poster-selftest.ts
 *
 * 为什么需要它：poster 路线的全部价值在于「图上的中文是**输入**而不是模型自由发挥」，
 * 所以 prompt 必须**逐字节确定**；同时 illustration 路线必须**一点没变**（默认关闭的保证）。
 *
 * 覆盖：
 *   1. buildPosterPrompt 逐字等于验收版模板（golden）
 *   2. 同一输入两次调用字节一致（幂等）
 *   3. 空/缺字段 → missingPosterFields 报出，buildPosterPrompt 抛错（调用方回落插画风）
 *   4. 三条约束齐全（标签 / 公式 / 中部集中）
 *   5. illustration prompt 结构未变，且不掺入 poster 文案
 *   6. poster 画布 1536x1024（900x383 会让模型只写一行字）
 *   7. 裁切带选址：内容偏上/居中/偏下都不切字
 */
import { buildImagePrompt, fallbackBrief } from "../src/cover-ai.ts";
import { pickBandStart } from "../src/cover.ts";
import {
  POSTER_CANVAS,
  POSTER_CONSTRAINTS,
  POSTER_FIXED_SENTENCE,
  buildPosterPrompt,
  missingPosterFields,
} from "../src/cover-poster.ts";

let pass = 0;
let fail = 0;

function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// 真实样例（2026-10-22 验收版 1/2 的输入）
const COPY = {
  module: "第二十五章 一元二次方程·第2讲 一元二次方程根的判别式",
  topic: "第二十五章 一元二次方程 第2讲｜根的判别式（Δ=b²-4ac 判断根的情况每年必考）",
  title: "九上必考｜根的判别式：一条 Δ 看清方程有几个根（附中考真题拆解）",
};

const GOLDEN = [
  "第二十五章 一元二次方程·第2讲 一元二次方程根的判别式",
  "选题：第二十五章 一元二次方程 第2讲｜根的判别式（Δ=b²-4ac 判断根的情况每年必考）",
  "标题：九上必考｜根的判别式：一条 Δ 看清方程有几个根（附中考真题拆解）",
  "",
  "根据上述为内容进行总结，生成一张微信公众号的封面图片。",
  "要求：画面上不要出现「选题：」「标题：」「第1讲」「要求：」这类标签字样，只保留真正的标题与知识点文字；",
  "所有数学公式必须书写正确（Δ = b² − 4ac，求根公式 x = (−b ± √(b²−4ac)) / (2a)），不得出现错误变形；",
  "整体为超宽横幅构图，文字与图形集中在画面中部，上下留出可裁切的空白。",
  "",
].join("\n");

console.log("[1] poster prompt 黄金样本");
{
  const got = buildPosterPrompt(COPY);
  ok("逐字节等于验收版模板", got === GOLDEN, got === GOLDEN ? `${got.length} chars` : "内容不一致");
  ok("首行就是章节（不带任何前缀）", got.split("\n")[0] === COPY.module);
  ok("包含「选题：」行", got.includes(`\n选题：${COPY.topic}\n`));
  ok("包含「标题：」行", got.includes(`\n标题：${COPY.title}\n`));
  ok("包含用户固定句（原文）", got.includes(POSTER_FIXED_SENTENCE));
  ok("结尾换行（与服务端字段风格一致）", got.endsWith("\n"));
}

console.log("[2] 幂等：同输入两次字节一致");
{
  const a = buildPosterPrompt(COPY);
  const b = buildPosterPrompt({ ...COPY });
  ok("两次输出一致", a === b);
  const trimmed = buildPosterPrompt({
    module: `  ${COPY.module}  `,
    topic: `${COPY.topic}\n`,
    title: `\t${COPY.title} `,
  });
  ok("首尾空白被规整后仍一致", trimmed === GOLDEN);
}

console.log("[3] 缺字段必须显式暴露（调用方据此回落插画风）");
{
  ok("三字段齐全 → 无缺失", missingPosterFields(COPY).length === 0);
  ok("缺 topic → 报 topic", missingPosterFields({ module: COPY.module, title: COPY.title }).join(",") === "topic");
  ok("全空 → 报三个字段", missingPosterFields({}).join(",") === "module,topic,title");
  ok("纯空白算缺失", missingPosterFields({ module: "  ", topic: "\n", title: "" }).length === 3);
  let threw = "";
  try {
    buildPosterPrompt({ module: COPY.module, topic: "", title: COPY.title });
  } catch (err) {
    threw = (err as Error).message;
  }
  ok("buildPosterPrompt 缺字段时抛错（不产出半成品 prompt）", threw.includes("topic"), threw);
}

console.log("[4] 三条约束齐全");
{
  ok("约束①：不打「选题/标题」标签", POSTER_CONSTRAINTS.includes("标签字样"));
  ok("约束②：公式必须正确（含 Δ 与求根公式）", POSTER_CONSTRAINTS.includes("Δ = b² − 4ac") && POSTER_CONSTRAINTS.includes("(−b ± √(b²−4ac)) / (2a)"));
  ok("约束③：超宽横幅 + 中部集中", POSTER_CONSTRAINTS.includes("超宽横幅构图") && POSTER_CONSTRAINTS.includes("中部"));
  ok("不出现「按 2.35:1 裁切」字样（实测会让模型退化成白底纯文字）", !POSTER_CONSTRAINTS.includes("2.35:1"));
}

console.log("[5] illustration 路线未受影响（默认 layout=illustration 的保证）");
{
  const brief = fallbackBrief("九上必考｜根的判别式", ["#0B1B33", "#4FC3F7", "#FFD54F"]);
  const p = buildImagePrompt(brief, "扁平矢量插画，几何极简，教育科技感，构图简洁留白大");
  ok("仍以 style 开头", p.startsWith("扁平矢量插画"));
  ok("仍包含「主体：」", p.includes("主体："));
  ok("仍要求深色底（palette[0]）", p.includes(brief.palette[0]));
  ok("仍禁止任何字符", p.includes("绝对不得出现任何字符"));
  ok("不掺入 poster 文案（无「选题：」「标题：」）", !p.includes("选题：") && !p.includes("标题："));
  ok("不含用户固定句", !p.includes(POSTER_FIXED_SENTENCE));
}

console.log("[6] poster 画布尺寸（防止回退到 900x383 小画布）");
{
  ok("POSTER_CANVAS = 1536x1024", POSTER_CANVAS === "1536x1024", POSTER_CANVAS);
  const [w, h] = POSTER_CANVAS.split("x").map(Number);
  ok("宽高都能被 16 整除（网关硬约束）", w % 16 === 0 && h % 16 === 0, `${w}x${h}`);
}

console.log("[7] 裁切带选址（内容自适应，防止切字）");
{
  const H = 100;
  const band = 64; // 2.35:1 带占 ~64%
  // 背景 255，内容块 [a..b] 变暗
  const profile = (a: number, b: number) =>
    Array.from({ length: H }, (_, i) => (i >= a && i <= b ? 40 : 250));
  // 居中内容
  const centered = pickBandStart(profile(35, 60), band);
  ok("内容居中 → 带覆盖内容", centered <= 35 && centered + band >= 60, `start=${centered}`);
  // 内容偏下（v3 实测形态）→ 带必须下移
  const low = pickBandStart(profile(58, 92), band);
  ok("内容偏下 → 带下移且不切内容", low <= 58 && low + band >= 92, `start=${low}`);
  // 内容偏上
  const high = pickBandStart(profile(8, 40), band);
  ok("内容偏上 → 带上移且不切内容", high <= 8 && high + band >= 40, `start=${high}`);
  // 全空白 → 几何居中
  const empty = pickBandStart(Array.from({ length: H }, () => 250), band);
  ok("无内容 → 几何居中", Math.abs(empty - (H - band) / 2) <= 1, `start=${empty}`);
  // 越界夹取
  ok("结果永远落在 [0, H-band]", [0, 20, 50, 99].every((_) => {
    const s = pickBandStart(profile(0, 99), band);
    return s >= 0 && s <= H - band;
  }));
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILED"}  pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
