#!/usr/bin/env bun
/**
 * image-model-probe-selftest.ts — offline self-test for `tools/image-model-probe.ts`.
 *
 *   bun tools/image-model-probe-selftest.ts
 *
 * A local Bun.serve() plays the role of the image gateway (port 0, loopback only),
 * so every failure class of §C-1 can be reproduced deterministically and **no real
 * gateway / apiKey is ever touched**. Fixtures are generated in-process (a tiny PNG
 * encoder over node:zlib) — no fixtures to download, no network.
 *
 * Covers the 6 required classes:
 *   1) 200 + 1x1 PNG            → ok:true, but score must fail "not-placeholder"
 *   2) 400 + JSON error          → ok:false, reason names the status, "permanent"
 *   3) 200 + text/html           → ok:false, reason names the content-type
 *   4) slow response             → ok:false, reason names the timeout
 *   5) truncated PNG / data: URL → ok:false, header parse / measurement failure
 *   6) redactSecrets             → sk-…/Bearer … never survive in cleartext
 * Plus: 900x383 + accent fixture must pass all 4 structure checks (threshold sanity),
 *       a low-contrast but large fixture must fail only "not-blank",
 *       and nothing in a row/report may contain the apiKey.
 */
import crypto from "node:crypto";
import zlib from "node:zlib";
import {
  ASSERTION_IDS,
  EXIT_ALL_FAILED,
  SCORE_THRESHOLDS,
  buildProbeRequest,
  dedupeImageModels,
  exitCodeFor,
  measureImage,
  mergeReport,
  probeOneImage,
  redactSecrets,
  reportFile,
  scoreImageStructure,
  summarize,
  type ProbeGateway,
  type ProbeReport,
  type ProbeRow,
} from "./image-model-probe.ts";

// ── harness ────────────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

// ── fixtures: minimal deterministic PNG encoder (no deps, no fixtures on disk) ──

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** RGB8 PNG from a per-pixel painter. */
function makePng(w: number, h: number, paint: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0; // filter type 0 (None)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = paint(x, y);
      raw[p++] = r;
      raw[p++] = g;
      raw[p++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const hex = (h: string): [number, number, number] => {
  const n = parseInt(h.replace("#", ""), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
};

const PALETTE: string[] = ["#0F4C81", "#2D8AE0", "#FFD54F"]; // brief default: bg / lines / accent
const BG = hex(PALETTE[0]!);
const LINES = hex(PALETTE[1]!);
const ACCENT = hex(PALETTE[2]!);

const SIZE = "900x383";
const [SIZE_W, SIZE_H] = SIZE.split("x").map(Number) as [number, number];

/**
 * "Usable flat illustration": dark vertical gradient background, a 7% accent disc
 * in the middle and a light line — i.e. what a competent flat-vector model returns.
 * Big enough (>5KB) and high-enough contrast to pass all four structure checks.
 */
const PNG_NICE = makePng(SIZE_W, SIZE_H, (x, y) => {
  const dx = x - SIZE_W / 2;
  const dy = y - SIZE_H / 2;
  if (dx * dx + dy * dy < 90 * 90) return [ACCENT[0], ACCENT[1], ACCENT[2]];
  if (Math.abs(y - SIZE_H * 0.78) < 3) return LINES as [number, number, number];
  const t = (y / SIZE_H) * 0.45;
  return [
    Math.round(BG[0] + (LINES[0] - BG[0]) * t),
    Math.round(BG[1] + (LINES[1] - BG[1]) * t),
    Math.round(BG[2] + (LINES[2] - BG[2]) * t),
  ];
});

/**
 * "Blank": near-uniform canvas. The per-pixel +/-3 dither keeps the file large
 * (>5KB, so `not-placeholder` passes) while the luminance spread stays ~±0.012,
 * which isolates `not-blank` as the assertion that must catch it.
 */
const PNG_BLANK = makePng(SIZE_W, SIZE_H, (x, y) => {
  const d = ((x * 7 + y * 13) % 7) - 3;
  return [BG[0] + d, BG[1] + d, BG[2] + d];
});

const PNG_TINY = makePng(1, 1, () => [BG[0], BG[1], BG[2]]);
const PNG_TRUNCATED = PNG_TINY.subarray(0, 18); // valid signature, no complete IHDR

// ── fake gateway ───────────────────────────────────────────────────────────

const API_KEY = "sk-selftest-abcdefgh12345678";
let lastRequestBody: any = null;
let lastAuthHeader: string | null = null;

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req: Request) {
    const url = new URL(req.url);
    if (url.pathname === "/img/nice.png") {
      return new Response(new Uint8Array(PNG_NICE), { headers: { "content-type": "image/png" } });
    }
    if (url.pathname !== "/v1/images/generations") {
      return new Response("not found", { status: 404 });
    }
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      /* keep {} */
    }
    lastRequestBody = body;
    lastAuthHeader = req.headers.get("authorization");

    const json = (obj: unknown, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

    switch (body?.model) {
      case "ok-tiny":
        return new Response(new Uint8Array(PNG_TINY), { headers: { "content-type": "image/png" } });
      case "ok-blank":
        return new Response(new Uint8Array(PNG_BLANK), { headers: { "content-type": "image/png" } });
      case "ok-nice":
        return new Response(new Uint8Array(PNG_NICE), { headers: { "content-type": "image/png" } });
      case "json-b64":
        return json({ data: [{ b64_json: PNG_NICE.toString("base64"), mime_type: "image/png" }] });
      case "json-url":
        return json({ data: [{ url: `http://127.0.0.1:${server.port}/img/nice.png` }] });
      case "data-url":
        // The `data:` prefix is what a lazy adapter would forget to strip; must be
        // recorded as a failure, because src/cover-ai.ts would decode it to garbage too.
        return json({ data: [{ b64_json: `data:image/png;base64,${PNG_NICE.toString("base64")}` }] });
      case "bad-model":
        return json({ error: { message: "model_not_found: bad-model does not exist", code: "model_not_found" } }, 400);
      case "html":
        return new Response("<!doctype html><h1>upstream proxy error</h1>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      case "slow":
        await new Promise((r) => setTimeout(r, 2500));
        return new Response(new Uint8Array(PNG_TINY), { headers: { "content-type": "image/png" } });
      case "truncated":
        return new Response(new Uint8Array(PNG_TRUNCATED), { headers: { "content-type": "image/png" } });
      default:
        return json({ error: { message: `unknown test model ${body?.model}` } }, 404);
    }
  },
});

const URL_BASE = `http://127.0.0.1:${server.port}/v1`;
const gw: ProbeGateway = { baseUrl: URL_BASE, apiKey: API_KEY };
const outDir = `${process.env.TMPDIR ?? "/tmp"}/wfm-probe-selftest-${process.pid}`;
const baseOpts = { outDir, size: SIZE, timeoutSec: 20, writeFiles: true };

const brief = {
  subject: "几何图形与坐标轴",
  motif: "abstract-geometry",
  palette: PALETTE,
  mood: "冷静",
  avoid: ["文字"],
};

// ── 0. request shape ───────────────────────────────────────────────────────

section("[0] buildProbeRequest（与发布链同形：POST {base}/images/generations，裸 id）");
{
  const { url, init } = buildProbeRequest(gw, "cn:hunyuan-image-alpha-edit", SIZE, brief);
  const bodyStr = String(init.body);
  check("url", url === `${URL_BASE}/images/generations`, url);
  check("method", (init as any).method === "POST");
  check("content-type json", (init.headers as any)["content-type"] === "application/json");
  check("model 原样透传（不 normalize）", JSON.parse(bodyStr).model === "cn:hunyuan-image-alpha-edit");
  check("size 来自 --size", JSON.parse(bodyStr).size === "900x383");
  check("n=1", JSON.parse(bodyStr).n === 1);
  check("prompt 含 brief 主体", JSON.parse(bodyStr).prompt.includes(brief.subject));
  check("prompt 含禁止文字约束", JSON.parse(bodyStr).prompt.includes("不得出现任何字符"));
  check("authorization 头存在（不进报告）", (init.headers as any).authorization === `Bearer ${API_KEY}`);
}

// ── 1. 200 + 1x1 PNG ───────────────────────────────────────────────────────

section("[1] 200 + 1x1 PNG → ok:true，但结构分必须 fail「非占位图」");
const m1 = measureImage(PNG_TINY, "image/png");
check("measureImage 解析出 1x1", m1.ok && m1.width === 1 && m1.height === 1, `${m1.width}x${m1.height}`);

const rowTiny = await probeOneImage(gw, "ok-tiny", brief, baseOpts);
check("ok:true（HTTP/尺寸解析都成功）", rowTiny.ok, rowTiny.reason ?? "");
check("status=200", rowTiny.status === 200);
check("returnedSize=1x1", rowTiny.returnedSize === "1x1");
check("snapped=true（1x1 ≠ 900x383）", rowTiny.snapped === true);
check("score.failed 含 not-placeholder", rowTiny.score?.failed.includes("not-placeholder") === true, JSON.stringify(rowTiny.score));
check("sha256 是 64 hex", /^[0-9a-f]{64}$/.test(rowTiny.sha256 ?? ""));
check("样张落盘且路径相对 out-dir", rowTiny.pngPath?.startsWith("samples/ok-tiny-") === true, rowTiny.pngPath ?? "");

// ── 2. 400 + JSON error ────────────────────────────────────────────────────

section("[2] 400 + JSON error → ok:false，reason 含 status，判 permanent");
const row400 = await probeOneImage(gw, "bad-model", brief, baseOpts);
check("ok:false", row400.ok === false);
check("status=400", row400.status === 400, String(row400.status));
check("reason 含 400", (row400.reason ?? "").includes("400"), row400.reason ?? "");
check("reason 含 model_not_found", (row400.reason ?? "").includes("model_not_found"), row400.reason ?? "");
check("retryable=false（坏 id 不重试）", row400.retryable === false, row400.reason ?? "");
check("reason 非空（失败必须显形）", (row400.reason ?? "").length > 0);
check("无 png / 无 hash", row400.pngPath === null && row400.sha256 === null);

// ── 3. 200 + text/html ─────────────────────────────────────────────────────

section("[3] 200 + text/html → ok:false，reason 指出 content-type");
const rowHtml = await probeOneImage(gw, "html", brief, baseOpts);
check("ok:false", rowHtml.ok === false);
check("status=200（HTTP 层成功，但内容不是图）", rowHtml.status === 200);
check("reason 含 content-type", /content-type/i.test(rowHtml.reason ?? ""), rowHtml.reason ?? "");
check("reason 指出 text/html", /text\/html/.test(rowHtml.reason ?? ""), rowHtml.reason ?? "");

// ── 4. slow response ───────────────────────────────────────────────────────

section("[4] 慢响应（2.5s）+ --timeout-sec 1 → ok:false，reason 含 timeout");
const t4 = performance.now();
const rowSlow = await probeOneImage(gw, "slow", brief, { ...baseOpts, timeoutSec: 1 });
const elapsed = performance.now() - t4;
check("ok:false", rowSlow.ok === false);
check("reason 含 timeout", /timeout/i.test(rowSlow.reason ?? ""), rowSlow.reason ?? "");
check("1s 超时生效（<2000ms 返回）", elapsed < 2000, `${Math.round(elapsed)}ms`);

// ── 5. truncated PNG / data: URL ───────────────────────────────────────────

section("[5] 截断 PNG / data: 前缀 → 尺寸解析失败，必须 ok:false");
const m5 = measureImage(PNG_TRUNCATED, "image/png");
check("measureImage 对截断 PNG → ok:false", m5.ok === false, m5.reason ?? "");
check("截断 reason 非空", (m5.reason ?? "").length > 0);

const rowTrunc = await probeOneImage(gw, "truncated", brief, baseOpts);
check("截断样张 ok:false", rowTrunc.ok === false);
check("截断 reason 提到 header parse", /header parse failed/i.test(rowTrunc.reason ?? ""), rowTrunc.reason ?? "");
check("截断仍在 score.failed 里全 fail", rowTrunc.score === undefined || rowTrunc.score.failed.length === 4);

const rowDataUrl = await probeOneImage(gw, "data-url", brief, baseOpts);
check("data: 前缀 → ok:false", rowDataUrl.ok === false);
check("data: reason 提到 unrecognised header", /unrecognised image header/i.test(rowDataUrl.reason ?? ""), rowDataUrl.reason ?? "");

// ── 6. redactSecrets ───────────────────────────────────────────────────────

section("[6] redactSecrets：sk-… / Bearer … 不得以明文出现");
{
  const r1 = redactSecrets("upstream said: invalid key sk-abcdef123456 for model x");
  check("sk- 被遮蔽", !r1.includes("abcdef123456") && r1.includes("sk-***"), r1);

  const r2 = redactSecrets("Authorization: Bearer abcdef1234567890xyz rejected");
  check("Bearer 被遮蔽", !r2.includes("abcdef1234567890xyz") && /Bearer \*\*\*/.test(r2), r2);

  const r3 = redactSecrets(`gateway echoed ${API_KEY} back`, [API_KEY]);
  check("已知 key 被遮蔽", !r3.includes(API_KEY), r3);
  check("已知 key 只保留后 4 位", /(?:^|[^*])\b5678\b/.test(r3.replace(/\*\*\*5678/, "...5678")) && r3.includes("***"), r3);

  const r4 = redactSecrets('{"api_key":"sk-zzzzzzzzzzzz","token":"deadbeefcafebabe1234"}');
  check("api_key/token 字段被遮蔽", !r4.includes("zzzzzzzzzzzz") && !r4.includes("deadbeefcafebabe1234"), r4);

  check("普通文本不被误伤", redactSecrets("http 503: No available channel for model cn:x") === "http 503: No available channel for model cn:x");
}

// ── 7. 结构分阈值可区分「空白」与「合格扁平插画」 ──────────────────────────

section("[7] scoreImageStructure：空白图 fail「not-blank」，合格扁平插画 4/4 pass");
const sBlank = await scoreImageStructure(PNG_BLANK, SIZE, { palette: PALETTE });
check("空白图 fail not-blank", sBlank.failed.includes("not-blank"), JSON.stringify(sBlank));
check("空白图 pass size-normalized（尺寸没问题，问题在内容）", sBlank.passed.includes("size-normalized"));
check("空白图 FAIL not-placeholder? 否（文件很大）", sBlank.passed.includes("not-placeholder"), JSON.stringify(sBlank));

const sNice = await scoreImageStructure(PNG_NICE, SIZE, { palette: PALETTE });
check("合格插画 4/4 pass", sNice.failed.length === 0 && sNice.passed.length === ASSERTION_IDS.length, JSON.stringify(sNice));
check("断言集合固定为 4 条", ASSERTION_IDS.length === 4);

const sTiny = await scoreImageStructure(PNG_TINY, SIZE);
check("1x1 fail not-placeholder", sTiny.failed.includes("not-placeholder"), JSON.stringify(sTiny));

const sTrunc = await scoreImageStructure(PNG_TRUNCATED, SIZE);
check("截断图 4 条全 fail", sTrunc.failed.length === 4 && sTrunc.passed.length === 0, JSON.stringify(sTrunc));

// ── 8. 2xx JSON 变体（b64 / url）也能拿到图 ────────────────────────────────

section("[8] 2xx JSON 载荷：b64_json 与 url 两条路径都要能量到尺寸");
const rowB64 = await probeOneImage(gw, "json-b64", brief, baseOpts);
check("b64_json → ok:true", rowB64.ok, rowB64.reason ?? "");
check("b64_json → 900x383", rowB64.returnedSize === "900x383", rowB64.returnedSize ?? "");
check("b64_json → 4/4 score", rowB64.score?.failed.length === 0, JSON.stringify(rowB64.score));

const rowUrl = await probeOneImage(gw, "json-url", brief, baseOpts);
check("url 回源 → ok:true", rowUrl.ok, rowUrl.reason ?? "");
check("url 回源 → 900x383", rowUrl.returnedSize === "900x383", rowUrl.returnedSize ?? "");
check("不吸附（900x383 请求 = 900x383 返回）", rowUrl.snapped === false);

// ── 9. 报告卫生：任何输出都不含 apiKey ────────────────────────────────────

section("[9] 报告与样张路径不得包含 apiKey");
{
  const blob = JSON.stringify([rowTiny, row400, rowHtml, rowSlow, rowTrunc, rowB64, rowUrl]);
  check("行 JSON 不含 apiKey", !blob.includes(API_KEY));
  check("行 JSON 不含 key 主体", !blob.includes("abcdefgh12345678"));
  const report: ProbeReport = {
    startedAt: new Date().toISOString(),
    gateway: URL_BASE,
    brief,
    size: SIZE,
    rows: [rowTiny, row400],
    summary: summarize([rowTiny, row400]),
  };
  check("报告 JSON 不含 apiKey", !JSON.stringify(report).includes(API_KEY));
  check("summary 计数正确", report.summary.ok === 1 && report.summary.failed === 1, JSON.stringify(report.summary));
  check("summary.fastest 只从 ok 行里选", report.summary.fastest === "ok-tiny", String(report.summary.fastest));
}

// ── 10. 同日重跑合并 / 枚举去重 ────────────────────────────────────────────

section("[10] mergeReport / dedupeImageModels / reportFile");
{
  const old: ProbeRow = { ...row400, model: "reused", ok: true, reason: null };
  const older: ProbeRow = { ...row400, model: "ok-tiny", totalMs: 999, reason: "old run" };
  const prev: ProbeReport = {
    startedAt: "2026-10-20T00:00:00Z",
    gateway: URL_BASE,
    brief,
    rows: [older, old],
    summary: summarize([older, old]),
  };
  const merged = mergeReport(prev, {
    startedAt: "2026-10-20T01:00:00Z",
    gateway: URL_BASE,
    brief,
    rows: [rowTiny],
    summary: summarize([rowTiny]),
  });
  check("重跑模型只留最新一行", merged.rows.filter((r) => r.model === "ok-tiny").length === 1);
  check("最新一行是新数据", merged.rows.find((r) => r.model === "ok-tiny")?.totalMs === rowTiny.totalMs);
  check("旧行进 history", merged.history?.some((r) => r.totalMs === 999) === true);
  check("未重跑的模型保留", merged.rows.some((r) => r.model === "reused"));

  const d = dedupeImageModels(["cn:cogview-4", "workbuddy/cn:cogview-4", "global:gpt-image-2.5-sunburst"]);
  check("镜像 id 折叠", d.models.length === 2, JSON.stringify(d.models));
  check("保留裸 id 形态", d.models.includes("cn:cogview-4") && !d.models.includes("workbuddy/cn:cogview-4"));
  check("折叠项可见", d.collapsed.includes("workbuddy/cn:cogview-4"));

  check("报告文件名带日期", reportFile("/tmp/x", "2026-10-20") === "/tmp/x/image-models-2026-10-20.json");
  check("阈值常量存在（报告里可复读）", SCORE_THRESHOLDS.minBytes === 5120 && SCORE_THRESHOLDS.minStdDev === 0.015);

  // 全失败必须非 0：否则 cron/CI 会把“整条探测挂掉”当成干净结果
  check("全部失败 → 退出码 3", exitCodeFor([row400, rowHtml]) === EXIT_ALL_FAILED, String(exitCodeFor([row400, rowHtml])));
  check("有一个 ok → 退出码 0", exitCodeFor([row400, rowTiny]) === 0);
  check("空矩阵不报全失败（交给操作性错误码）", exitCodeFor([]) === 0);
}

// ── teardown ───────────────────────────────────────────────────────────────

server.stop(true);
try {
  const fs = await import("node:fs");
  fs.rmSync(outDir, { recursive: true, force: true });
} catch {
  /* best-effort */
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILED"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
