/**
 * cover-poster.ts · 教辅海报风封面（确定性文案 + 确定性 prompt）
 *
 * 与 cover-ai.ts 的「插画风」互补：
 *   illustration : 文本模型读正文 → 产出视觉简报(subject/motif/palette) → 图像模型画「无字几何插画」
 *   poster       : **不做文本模型调用** → 直接把「章节 · 选题 · 标题」三条确定性文案拼成海报 prompt
 *
 * 为什么必须确定性（项目铁律「AI 只做内容，其余确定性」）：
 *   图上的中文是**输入**而非模型自由发挥 —— module/topic/title 全部来自
 *   `plans/<周>.json`（module/topic）与文章 frontmatter（title），可逐字节断言，
 *   不会出现「模型自己编一个标题」的情况。
 *
 * 依据：2026-10-22 用户验收的 1/2 推荐版（`data/research/cover-preview-2026-10-22/`）。
 */

export interface PosterCopy {
  /** 章节·讲次，如「第二十五章 一元二次方程·第2讲 一元二次方程根的判别式」 */
  module: string;
  /** 选题（含括号里的知识点说明），如「第二十五章 一元二次方程 第2讲｜根的判别式（Δ=b²-4ac …）」 */
  topic: string;
  /** 文章最终标题（frontmatter title），如「九上必考｜根的判别式：一条 Δ 看清方程有几个根」 */
  title: string;
}

/**
 * poster 的首选画布。
 *
 * 教训（2026-10-22 实机）：直接请求 900x383 时，混元会「吸附」成 896x368 并在这么小的
 * 画布上排版 —— 结果只剩一行章节名加两条公式，海报元素全没了。
 * 所以 poster 必须先要一张 1536x1024（边长 ÷16 且满足最小像素预算）的大画布，
 * 再由 `fitImageTo()` 居中裁回 900x383（2.35:1）。
 */
export const POSTER_CANVAS = "1536x1024";

/** 用户固定追加的那句（原话，不改写） */
export const POSTER_FIXED_SENTENCE = "根据上述为内容进行总结，生成一张微信公众号的封面图片。";

/**
 * 三条约束（来自 1/2 推荐版被验收的原因）：
 *   ① 去掉「选题：」「标题：」这类排版标签 —— 否则模型会把标签当正文画进图里；
 *   ② 公式必须书写正确 —— 混元/gpt-image 都会写歪 Δ；
 *   ③ 内容集中在中部 —— 2.35:1 裁切只保留中间 654/1024，靠边的内容会被切掉。
 */
export const POSTER_CONSTRAINTS = [
  "画面上不要出现「选题：」「标题：」「第1讲」「要求：」这类标签字样，只保留真正的标题与知识点文字；",
  "所有数学公式必须书写正确（Δ = b² − 4ac，求根公式 x = (−b ± √(b²−4ac)) / (2a)），不得出现错误变形；",
  // 措辞保持与 2026-10-22 验收版一致：一旦在里面提「按 2.35:1 裁切」，模型会退化成白底纯文字。
  // 裁切安全性改由代码保证（fitImageToBanded 的 0.35 上偏）。
  "整体为超宽横幅构图，文字与图形集中在画面中部，上下留出可裁切的空白。",
].join("\n");

/** 缺失/空白的文案字段（poster 模式必须三样齐全，否则退回插画风） */
export function missingPosterFields(copy: Partial<PosterCopy>): string[] {
  return (["module", "topic", "title"] as const).filter((k) => !String(copy[k] ?? "").trim());
}

/**
 * 拼出海报 prompt —— 逐字节确定性（同输入 → 同输出）。
 * 顺序与用户在邮件里给的模板一致：module / 选题 / 标题 / 空行 / 固定句 / 要求。
 */
export function buildPosterPrompt(copy: PosterCopy): string {
  const missing = missingPosterFields(copy);
  if (missing.length) throw new Error(`poster prompt 缺少字段: ${missing.join(", ")}`);
  return [
    copy.module.trim(),
    `选题：${copy.topic.trim()}`,
    `标题：${copy.title.trim()}`,
    "",
    POSTER_FIXED_SENTENCE,
    `要求：${POSTER_CONSTRAINTS}`,
    "",
  ].join("\n");
}
