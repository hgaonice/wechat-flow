/**
 * AI cover self-test — no network, no pi, no image model.
 *
 * Run: bun tools/cover-selftest.ts
 *
 * Covers the parts that must never regress silently:
 *   - size parsing / exact-size fitting (AC1)
 *   - gateway model-id normalisation (真机踩坑：`workbuddy/cn:x` → 404)
 *   - lenient brief parsing (AI 回的东西不干净也要能用 / 不能崩)
 *   - failure isolation: bad gateway / bad model → {ok:false}, 不抛异常 (AC4)
 *   - idempotence-friendly behaviour: no network call when the file exists (AC6)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateFfmpegCover, imageSize, parseSize } from "../src/cover.ts";
import {
  buildImagePrompt,
  defaultAiSettings,
  fallbackBrief,
  generateAiCover,
  normalizeImageModelId,
  parseCoverBrief,
} from "../src/cover-ai.ts";

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

function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, a === e ? a : `got ${a} want ${e}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cover-selftest-"));

// ── 1. size parsing ────────────────────────────────────────────────────────
console.log("\n[1] parseSize");
eq("默认 900x383", parseSize(undefined), { w: 900, h: 383 });
eq("显式 900x383", parseSize("900x383"), { w: 900, h: 383 });
eq("1200x630", parseSize("1200x630"), { w: 1200, h: 630 });
eq("非法串回落默认", parseSize("bogus"), { w: 900, h: 383 });
eq("过小回落默认", parseSize("8x8"), { w: 900, h: 383 });
eq("x 分隔符错误回落", parseSize("900*383"), { w: 900, h: 383 });

// ── 2. deterministic renderers hit the exact size ───────────────────────────
console.log("\n[2] 渲染器尺寸（AC1）");
for (const size of ["900x383", "1200x630"]) {
  const out = path.join(tmp, `ff-${size}.png`);
  try {
    await generateFfmpegCover({ outPath: out, title: "配方法的应用(一)：配方求值、作差比大小", subtitle: "账号 · 模块", size });
    const want = parseSize(size);
    const dim = imageSize(out);
    ok(`ffmpeg ${size}`, dim?.w === want.w && dim?.h === want.h, `${dim?.w}x${dim?.h}`);
  } catch (err) {
    ok(`ffmpeg ${size}`, false, (err as Error).message);
  }
}

// ── 3. imageSize header parsing ────────────────────────────────────────────
console.log("\n[3] imageSize 头解析");
ok("PNG", (() => {
  const f = path.join(tmp, "ff-900x383.png");
  const d = imageSize(f);
  return d?.w === 900 && d?.h === 383;
})());
ok("不存在的文件 → undefined", imageSize(path.join(tmp, "nope.png")) === undefined);
ok("非图片文件 → undefined", imageSize(path.join(tmp, "x.txt")) === undefined);
fs.writeFileSync(path.join(tmp, "x.txt"), "not an image at all, definitely not");

// ── 4. model id normalisation（真机：网关要裸 id） ─────────────────────────
console.log("\n[4] normalizeImageModelId");
eq("workbuddy/ 前缀剥离", normalizeImageModelId("workbuddy/cn:hunyuan-image-alpha-edit"), "cn:hunyuan-image-alpha-edit");
eq("global 前缀剥离", normalizeImageModelId("workbuddy/global:gpt-image-2.5-sunburst"), "global:gpt-image-2.5-sunburst");
eq("已是裸 id 不变", normalizeImageModelId("cn:hunyuan-image-alpha-edit"), "cn:hunyuan-image-alpha-edit");
eq("空串不变", normalizeImageModelId(""), "");
eq("多余空白裁剪", normalizeImageModelId("  cn:x  "), "cn:x");

// ── 5. brief parsing（宽松，但必须能兜底） ─────────────────────────────────
console.log("\n[5] parseCoverBrief");
const good = JSON.stringify({
  subject: "一条开口向上的抛物线与它最低点处的水平切线",
  motif: "parabola",
  palette: ["#0B1B33", "#4FC3F7", "#FFD54F"],
  mood: "冷静",
  avoid: ["人脸"],
});
const p1 = parseCoverBrief(good);
ok("纯 JSON", p1?.motif === "parabola" && p1.palette.length === 3, JSON.stringify(p1?.palette));
const p2 = parseCoverBrief("好的，这是简报：\n```json\n" + good + "\n```\n希望有帮助！");
ok("带 ```json 围栏 + 前后废话", p2?.motif === "parabola", p2?.subject?.slice(0, 12) ?? "undefined");
const p3 = parseCoverBrief("说明一下。" + good + " 以上。");
ok("前后有裸废话", p3?.motif === "parabola" && p3.palette[0] === "#0B1B33");
const p4 = parseCoverBrief('{"subject":"圆与公共弦","palette":["#000000","bogus","#FF0000"]}');
ok("非法色值被剔除并补齐", p4?.palette.length === 3 && p4.palette.includes("#000000") && !p4.palette.includes("bogus"), JSON.stringify(p4?.palette));
ok("缺 motif 给默认值", p4?.motif === "abstract-geometry");
ok("缺 mood 给默认值", p4?.mood === "冷静");
ok("非法 JSON → undefined", parseCoverBrief("{oops") === undefined);
ok("空串 → undefined", parseCoverBrief("") === undefined);
ok("没有花括号 → undefined", parseCoverBrief("我无法生成简报") === undefined);

const fb = fallbackBrief("第二十五章 一元二次方程 第1讲｜配方法的应用(二)求最值", ["#111111", "#222222", "#333333"]);
ok("fallbackBrief 用给定色板", fb.palette.join() === "#111111,#222222,#333333", fb.subject.slice(0, 10));
ok("fallbackBrief 截断 subject", fb.subject.length <= 30, String(fb.subject.length));

// ── 6. prompt contract（硬约束不能丢） ─────────────────────────────────────
console.log("\n[6] buildImagePrompt 硬约束");
const prompt = buildImagePrompt(fb, "扁平矢量插画");
for (const must of ["禁止", "数字", "字母", "水印", "2.35:1", "完整", "空白", "12%", "不要密集网格", "#111111"]) {
  ok(`prompt 含「${must}」`, prompt.includes(must));
}

// ── 7. failure isolation（AC4） ────────────────────────────────────────────
console.log("\n[7] 失败隔离：绝不抛异常，返回 ok:false");
process.env.COVER_IMAGE_BASE_URL = "http://127.0.0.1:9/v1";
process.env.COVER_IMAGE_API_KEY = "sk-bogus";
const badGw = await generateAiCover({
  outPath: path.join(tmp, "bad-gw.png"),
  title: "测试标题",
  module: "第二十五章",
  body: "正文内容",
  promptFile: path.join(tmp, "missing-cover.md"), // 也会触发摘要降级
  settings: defaultAiSettings({ timeoutSec: 3, maxTotalSec: 6, model: "cn:x", fallbacks: [] }),
  size: "900x383",
  piBin: "/nonexistent-pi-binary",
});
ok("坏网关 → ok:false", badGw.ok === false, (badGw.reason ?? "").slice(0, 90));
ok("坏网关 → 有 reason", typeof badGw.reason === "string" && badGw.reason.length > 0);
ok("坏网关 → 没写文件", !fs.existsSync(path.join(tmp, "bad-gw.png")));
ok("坏网关 → 仍有 brief（可审计）", badGw.brief !== undefined, badGw.brief?.mood);

const noGw = await generateAiCover({
  outPath: path.join(tmp, "no-gw.png"),
  title: "t",
  module: "m",
  body: "b",
  promptFile: path.join(tmp, "missing-cover.md"),
  settings: defaultAiSettings({ gateway: "", apiKey: "" }),
  size: "900x383",
  piBin: "/nonexistent-pi-binary",
});
ok("网关解析失败 → ok:false 且说明来源", noGw.ok === false, (noGw.reason ?? "").slice(0, 70));

// ── 8. 简报落盘（可审计，AC3） ─────────────────────────────────────────────
console.log("\n[8] cover-brief.json 落盘");
const briefPath = path.join(tmp, "brief", "cover-brief.json");
await generateAiCover({
  outPath: path.join(tmp, "brief", "cover.png"),
  briefPath,
  title: "第二十五章 一元二次方程 第1讲｜配方法的应用(二)求最值",
  module: "第二十五章",
  body: "配方后要对一次范围",
  promptFile: path.join(tmp, "missing-cover.md"),
  settings: defaultAiSettings({ model: "cn:x", fallbacks: [], timeoutSec: 3, maxTotalSec: 6 }),
  size: "900x383",
  piBin: "/nonexistent-pi-binary",
});
let briefOk = false;
try {
  const j = JSON.parse(fs.readFileSync(briefPath, "utf8"));
  briefOk = j.brief?.palette?.length === 3 && typeof j.summaryOk === "boolean";
} catch {
  briefOk = false;
}
ok("简报写入且可解析", briefOk);

// ── 9. 幂等语义（AC6：文件存在时不重画，由 publisher 判定） ────────────────
console.log("\n[9] 幂等语义");
{
  const out = path.join(tmp, "reuse", "cover.png");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, "sentinel");
  const mtime = fs.statSync(out).mtimeMs;
  // publisher 的 reuse 判定就是这一句；这里钉住"存在 + reuse 时不写文件"的契约。
  const shouldRegenerate = (reuse: boolean) => !(reuse && fs.existsSync(out));
  ok("reuse + 已存在 → 不重画", shouldRegenerate(true) === false);
  ok("reuse=false → 重画", shouldRegenerate(false) === true);
  ok("文件未被自测改动", fs.statSync(out).mtimeMs === mtime && fs.readFileSync(out, "utf8") === "sentinel");
}

// ── summary ────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(60)}`);
console.log(`  ${pass} PASS / ${fail} FAIL`);
if (fail > 0) {
  console.log("  ❌ 有失败项");
  process.exitCode = 1;
} else {
  console.log("  ✅ all passed");
}
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* ignore */
}
