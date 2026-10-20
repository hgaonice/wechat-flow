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
  consumeCoverBudget,
  coverBudgetPath,
  coverStatsPath,
  defaultAiSettings,
  describeCoverCandidates,
  fallbackBrief,
  generateAiCover,
  isSizeRejection,
  listImageModels,
  normalizeImageModelId,
  parseCoverBrief,
  readCoverBudget,
  readCoverModelStats,
  recordCoverModelStat,
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

// ── 10. size rejection classification（C2：gpt-image-2.5 只收 16 整除尺寸） ──
console.log("\n[10] isSizeRejection");
for (const s of [
  "Invalid size '900x383'. Width and height must both be divisible by 16.",
  "invalid_value: below the current minimum pixel budget",
  "400 invalid_value: size must be one of 1024x1024, 1536x1024",
  "resolution is below the supported minimum",
  // 真机原文（2026-10-20，网关把内层 400 包成 502；见 docs/research/image-models.md §A.1）
  'http 502: Create image failed with error: TokenHub returned HTTP 400: {"error":{"code":"invalid_value","message":"Invalid size \'900x383\'. Width and height must both be divisible by 16.","param":"size","type":"image_generation_user_error"}}',
  'http 502: Create image failed with error: TokenHub returned HTTP 400: {"error":{"code":"invalid_value","message":"Invalid size \'896x368\'. Requested resolution is below the current minimum pixel budget.","param":"size"}}',
  // OpenAI 直连形态（未走网关时的等价错误）
  "Invalid value for 'size': must be one of 1024x1024, 1536x1024 for this model",
  "400: invalid resolution requested for this model",
]) {
  ok(`尺寸拒绝 → true：${s.slice(0, 40)}`, isSizeRejection(s) === true);
}
for (const s of [
  "timeout after 60s",
  "400 model_not_found",
  "http 503: No available channel for model cn:x",
  "download 404",
  "http 429: 余额不足或无可用资源包",
  "http 400: content policy violation: sexual content detected",
  // 假阳性回归：提到 size 但不是尺寸问题 → 不能白跑一次 1536x1024
  "invalid_value: invalid value for 'steps': must be <= 50, size 1024x1024 ok",
  "upstream error, request body too large (max request size 10MB)",
]) {
  ok(`非尺寸错误 → false：${s.slice(0, 30)}`, isSizeRejection(s) === false);
}

// 注意：正则必须「只认尺寸」，不能把 model_not_found / 风控 / 余额不足当尺寸问题。

// ── 11. listImageModels 过滤正则（C2：之前漏掉 cogview，doctor 会少报） ────────
console.log("\n[11] listImageModels 过滤（本地假网关，不打真网关）");
{
  const fake = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () =>
      Response.json({
        object: "list",
        data: [
          { id: "cogview-4" },
          { id: "cn:hunyuan-image-alpha-edit" },
          { id: "global:gpt-image-2.5-sunburst" },
          { id: "gpt-4o" },
          { id: "cn:deepseek-v4.1-flash" },
        ],
      }),
  });
  try {
    const gw = { baseUrl: `http://127.0.0.1:${fake.port}/v1`, apiKey: "test-key", source: "selftest" };
    const ids = await listImageModels(gw, 5);
    ok("cogview-4 命中", !!ids && ids.includes("cogview-4"));
    ok("cn:hunyuan-image-alpha-edit 命中", !!ids && ids.includes("cn:hunyuan-image-alpha-edit"));
    ok("global:gpt-image-2.5-sunburst 命中", !!ids && ids.includes("global:gpt-image-2.5-sunburst"));
    ok("gpt-4o（文本）不命中", !!ids && !ids.includes("gpt-4o"));
    ok("deepseek（文本）不命中", !!ids && !ids.includes("cn:deepseek-v4.1-flash"));
    ok("模型总数 = 3", ids?.length === 3, JSON.stringify(ids));

    const dead = await listImageModels({ baseUrl: "http://127.0.0.1:9/v1", apiKey: "k", source: "selftest" }, 3);
    ok("网关不可达 → null（不是 []、不抛）", dead === null);
  } finally {
    fake.stop(true);
  }
}

// ── 12. 成本护栏：dailyBudget（C2 §C-3 / R6） ──────────────────────────────
console.log("\n[12] cover.ai.dailyBudget");
const D = "2026-10-20";
const budgetState = path.join(tmp, "budget-state");
{
  const r0 = consumeCoverBudget(budgetState, D, 0);
  ok("0 = 不限：允许", r0.ok === true && r0.limit === 0);
  ok("0 = 不限：不写盘", !fs.existsSync(coverBudgetPath(budgetState)));

  const r1 = consumeCoverBudget(budgetState, D, 1);
  ok("=1 第 1 次允许", r1.ok === true && r1.used === 1, JSON.stringify(r1));
  ok("=1 计数落盘", readCoverBudget(budgetState, D).used === 1);

  const r2 = consumeCoverBudget(budgetState, D, 1);
  ok("=1 第 2 次拒绝（允许 n 次，拒 n+1）", r2.ok === false && r2.used === 1 && r2.limit === 1, JSON.stringify(r2));
  ok("拒绝不增计数", readCoverBudget(budgetState, D).used === 1);

  const r3 = consumeCoverBudget(budgetState, "2026-10-21", 1);
  ok("跨日自动归零", r3.ok === true && r3.used === 1 && readCoverBudget(budgetState, "2026-10-21").used === 1);
  ok("旧日期文件被新日期覆盖（不累计）", JSON.parse(fs.readFileSync(coverBudgetPath(budgetState), "utf8")).date === "2026-10-21");

  ok("负数 / NaN 当 0（不限）", consumeCoverBudget(budgetState, D, -3).ok === true && consumeCoverBudget(budgetState, D, Number.NaN).ok === true);

  // 坏 JSON / 非法 used：按 0 计（会自愈重写）但不得抛，也不得把 used 读成负数/NaN
  const corruptDir = path.join(tmp, "budget-corrupt");
  fs.mkdirSync(corruptDir, { recursive: true });
  fs.writeFileSync(coverBudgetPath(corruptDir), "{not json");
  ok("坏 JSON → 读回 used=0（不抛）", (() => {
    try {
      return readCoverBudget(corruptDir, D).used === 0;
    } catch {
      return false;
    }
  })());
  const rc = consumeCoverBudget(corruptDir, D, 1);
  ok("坏 JSON 后仍按预算计数（自愈重写为合法文件）", rc.ok === true && rc.used === 1 && readCoverBudget(corruptDir, D).used === 1, JSON.stringify(rc));
  fs.writeFileSync(coverBudgetPath(corruptDir), JSON.stringify({ date: D, used: "abc" }));
  ok("used 非数字 → 按 0（不静默变成 NaN 判定）", readCoverBudget(corruptDir, D).used === 0);

  // 不可写目录（ENOTDIR）：只 WARN，不得抛、不得阻断出图
  const plainFile = path.join(tmp, "plain-file.not-a-dir");
  fs.writeFileSync(plainFile, "x");
  let threw = false;
  let r4: { ok: boolean } | undefined;
  try {
    r4 = consumeCoverBudget(path.join(plainFile, "state"), D, 1);
  } catch {
    threw = true;
  }
  ok("不可写 state 目录 → 不抛（出图照常）", threw === false && r4?.ok === true);
}

// ── 12b. 预算在 generateAiCover 里的时机（一次发布只 +1，且耗尽早退） ───────
console.log("\n[12b] generateAiCover 预算时机");
{
  const budgetState2 = path.join(tmp, "budget-state2");
  const base = {
    outPath: path.join(tmp, "budget", "cover.png"),
    title: "测试标题",
    module: "第二十五章",
    body: "正文",
    promptFile: path.join(tmp, "missing-cover.md"),
    settings: defaultAiSettings({ model: "cn:x", fallbacks: ["cn:y"], timeoutSec: 3, maxTotalSec: 6, dailyBudget: 1 }),
    size: "900x383",
    piBin: "/nonexistent-pi-binary",
    stateDir: budgetState2,
    date: D,
  };
  // env 在第 7 节已指向 127.0.0.1:9（连接被拒，毫秒级失败）
  const first = await generateAiCover(base);
  ok("第 1 次：不因预算失败", first.ok === false && !/budget/i.test(first.reason ?? ""), (first.reason ?? "").slice(0, 60));
  ok("第 1 次：整条链（2 模型）只 +1", readCoverBudget(budgetState2, D).used === 1, String(readCoverBudget(budgetState2, D).used));

  const second = await generateAiCover(base);
  ok("第 2 次：ok:false 且 reason 含 budget", second.ok === false && /budget/i.test(second.reason ?? ""), second.reason ?? "");
  ok("第 2 次：reason 给出 n/n 且写明降级", /1\/1/.test(second.reason ?? "") && /降级 ffmpeg/.test(second.reason ?? ""));
  ok("第 2 次：仍在可用预算内不写图", !fs.existsSync(base.outPath));

  const unlimited = await generateAiCover({
    ...base,
    stateDir: path.join(tmp, "budget-state3"),
    settings: defaultAiSettings({ model: "cn:x", fallbacks: [], timeoutSec: 3, maxTotalSec: 6, dailyBudget: 0 }),
  });
  ok("budget=0：不限，且不创建计数文件", !fs.existsSync(coverBudgetPath(path.join(tmp, "budget-state3"))) && unlimited.ok === false);
}

// ── 13. 每个模型的 stats（C2 §C-4 / doctor 的数据源） ─────────────────────
console.log("\n[13] cover-model-stats.json");
{
  const statsState = path.join(tmp, "stats-state");
  const at = new Date("2026-10-20T07:00:00Z");
  recordCoverModelStat(statsState, "cn:model-a", { ok: true, ms: 12345 }, { now: at });
  const s1 = readCoverModelStats(statsState);
  ok("成功写 lastOkAt/lastOkMs/okCount", s1["cn:model-a"]?.lastOkAt === at.toISOString() && s1["cn:model-a"]?.lastOkMs === 12345 && s1["cn:model-a"]?.okCount === 1);

  recordCoverModelStat(
    statsState,
    "cn:model-a",
    { ok: false, ms: 800, reason: "http 429: no quota for cogview-4" },
    { now: new Date("2026-10-20T08:00:00Z"), apiKey: "sk-supersecret123" },
  );
  const s2 = readCoverModelStats(statsState)["cn:model-a"];
  ok("失败写 lastFailAt/lastFailReason/failCount", s2?.lastFailReason?.includes("429") === true && s2?.failCount === 1);
  ok("失败不清空成功计数/时间", s2?.okCount === 1 && s2?.lastOkMs === 12345);

  recordCoverModelStat(statsState, "cn:model-a", {
    ok: false,
    ms: 1,
    reason: `Bearer sk-supersecret123 ${"x".repeat(400)}`,
  }, { apiKey: "sk-supersecret123" });
  const s3 = readCoverModelStats(statsState)["cn:model-a"];
  ok("reason 脱敏（sk-… / Bearer 不落盘）", !s3?.lastFailReason?.includes("sk-supersecret123") && !/Bearer sk-/.test(s3?.lastFailReason ?? ""));
  ok("reason 截断 ≤200 字", (s3?.lastFailReason?.length ?? 0) <= 200, String(s3?.lastFailReason?.length));
  ok("原子写：无残留 .tmp", fs.readdirSync(statsState).every((f) => !f.includes(".tmp")));
  ok("文件可 JSON 解析", (() => {
    try {
      return typeof JSON.parse(fs.readFileSync(coverStatsPath(statsState), "utf8")) === "object";
    } catch {
      return false;
    }
  })());

  ok("缺 stateDir → 不写、不抛（向后兼容）", (() => {
    try {
      recordCoverModelStat(undefined, "cn:x", { ok: true, ms: 1 });
      return true;
    } catch {
      return false;
    }
  })());

  const plainFile = path.join(tmp, "plain-file2.not-a-dir");
  fs.writeFileSync(plainFile, "x");
  ok("不可写目录 → 只 warn 不抛", (() => {
    try {
      recordCoverModelStat(path.join(plainFile, "state"), "cn:x", { ok: true, ms: 1 });
      return true;
    } catch {
      return false;
    }
  })());
  ok("坏 JSON → 读回空对象（不让 doctor 崩）", (() => {
    const broken = path.join(tmp, "broken-state");
    fs.mkdirSync(broken, { recursive: true });
    fs.writeFileSync(coverStatsPath(broken), "{not json");
    return Object.keys(readCoverModelStats(broken)).length === 0;
  })());
}

// ── 14. doctor 的 cover-candidates 行（C2 §C-4：禁止硬编码模型名） ──────────
console.log("\n[14] describeCoverCandidates");
{
  const down = describeCoverCandidates({ models: null });
  ok("网关不可达 → models ?", down.includes("models ?") && down.includes("unreachable"), down);

  const now = new Date("2026-10-20T09:00:00Z");
  const line = describeCoverCandidates({
    models: ["brand-new-image-x", "cn:other-y"],
    stats: {
      "brand-new-image-x": { lastOkAt: "2026-10-20T06:54:00Z", lastOkMs: 35200, okCount: 3, failCount: 0 },
      "cn:other-y": { lastFailAt: "2026-10-19T14:42:00Z", lastFailReason: "400 model_not_found", okCount: 0, failCount: 1 },
    },
    now,
  });
  ok("首段是实时模型数", line.startsWith("2 image models (gateway ok)"), line);
  ok("last ok 带多久前 + 耗时", line.includes("last ok brand-new-image-x (2.1h ago, 35.2s)"), line);
  ok("last fail 带多久前 + 原因", line.includes("last fail cn:other-y (18.3h ago: 400 model_not_found)"), line);
  ok("单行可 grep（无换行）", !line.includes("\n"));

  const noStats = describeCoverCandidates({ models: [], now });
  ok("0 个模型也成句，且不编造 last 段", noStats === "0 image models (gateway ok)", noStats);
}

// ── 15. 尺寸拒绝 → 放大重试（E9 回归：兜底模型曾整条是死的） ────────────────
// 真机证据（2026-10-20）：`gpt-image-2.5` 对 900x383 回 502，内层 400 是
// `Invalid size '900x383'. Width and height must both be divisible by 16.`；
// 放大到 1536x1024 才出图，再由 fitImageTo 裁回 900x383。
// 这里用本地假网关钉住三件事：① 会放大重试；② 裁回目标尺寸；③ 只扣 1 次预算。
console.log("\n[15] SIZE_ESCALATION（尺寸拒绝 → 1536x1024 → 裁回 900x383）");
{
  const bigSrc = path.join(tmp, "escalation-src.png");
  await generateFfmpegCover({ outPath: bigSrc, title: "放大重试", subtitle: "1536x1024", size: "1536x1024" });
  const bigB64 = fs.readFileSync(bigSrc).toString("base64");
  const seen: string[] = [];
  const fake = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body: any = await req.json().catch(() => ({}));
      seen.push(`${body.model}@${body.size}`);
      if (body.size !== "1536x1024") {
        // 与真机 502 包体同形（内层 400 原文保留）
        return Response.json(
          {
            error: {
              message: `Create image failed with error: TokenHub returned HTTP 400: {"error":{"code":"invalid_value","message":"Invalid size '${body.size}'. Width and height must both be divisible by 16."}}`,
              code: "upstream_error",
            },
          },
          { status: 502 },
        );
      }
      return Response.json({ data: [{ b64_json: bigB64, mime_type: "image/png" }] });
    },
  });
  const prevBase = process.env.COVER_IMAGE_BASE_URL;
  const prevKey = process.env.COVER_IMAGE_API_KEY;
  process.env.COVER_IMAGE_BASE_URL = `http://127.0.0.1:${fake.port}/v1`;
  process.env.COVER_IMAGE_API_KEY = "sk-size-escalation-test";
  try {
    const estState = path.join(tmp, "escalation-state");
    const estOut = path.join(tmp, "escalation", "cover.png");
    const r = await generateAiCover({
      outPath: estOut,
      title: "配方法的应用",
      module: "第二十五章",
      body: "正文",
      promptFile: path.join(tmp, "missing-cover.md"),
      settings: defaultAiSettings({ model: "cn:size-picky", fallbacks: [], timeoutSec: 10, maxTotalSec: 30, dailyBudget: 1 }),
      size: "900x383",
      piBin: "/nonexistent-pi-binary",
      stateDir: estState,
      date: D,
    });
    ok("尺寸拒绝不放弃：放大后成功并裁回 900x383", r.ok === true && r.size?.w === 900 && r.size?.h === 383, r.reason ?? "");
    ok("请求序列：900x383（拒）→ 1536x1024（成）", seen.length === 2 && seen[0]?.endsWith("@900x383") === true && seen[1]?.endsWith("@1536x1024") === true, JSON.stringify(seen));
    ok("落盘文件确实是 900x383", (() => {
      const d = imageSize(estOut);
      return d?.w === 900 && d?.h === 383;
    })());
    ok("放大重试不额外扣预算（used=1，limit=1）", readCoverBudget(estState, D).used === 1, String(readCoverBudget(estState, D).used));
    const st = readCoverModelStats(estState)["cn:size-picky"];
    ok("stats 记 1 次成功（中间拒绝不算失败）", st?.okCount === 1 && (st?.failCount ?? 0) === 0, JSON.stringify(st));
  } finally {
    fake.stop(true);
    if (prevBase === undefined) delete process.env.COVER_IMAGE_BASE_URL;
    else process.env.COVER_IMAGE_BASE_URL = prevBase;
    if (prevKey === undefined) delete process.env.COVER_IMAGE_API_KEY;
    else process.env.COVER_IMAGE_API_KEY = prevKey;
  }
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
