#!/usr/bin/env bun
/**
 * pi-retry-selftest.ts — 模型降级链自测（零依赖、无网络、bun 直跑）。
 *
 *   PI_RETRY_BASE_MS=0 bun tools/pi-retry-selftest.ts
 *
 * 覆盖 10-18-model-fallback-resilience 的 AC2/AC3/AC4/AC5：
 *   1) 错误分类矩阵（fatal / retryable），用 250 真机抓到的原文
 *   2) fatal 不重试（同一模型只跑一次）
 *   3) retryable 指数退避重试，次数正确
 *   4) 链路摘要（单跳保持旧格式、多跳含全部模型）
 *   5) 模型清单解析 + 缺失检测
 * 任一条失败 → 打印 FAIL 并以退出码 1 结束。
 */
import {
  backoffMs,
  classifyPiFailure,
  formatChainError,
  missingModels,
  parseModelList,
  runPiWith,
  shortReason,
  type PiAttempt,
  type PiRunResult,
  type PiRunOptions,
} from "../src/pi.ts";

let failures = 0;
function check(name: string, cond: boolean, extra?: string): void {
  if (cond) console.log(`PASS ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}${extra ? " — " + extra : ""}`);
  }
}

// 退避归零，避免自测等 30s
process.env.PI_RETRY_BASE_MS = "0";

// ── 1) 分类矩阵（原文来自 250 journal，2026-10-19 07:00） ─────────────────

const CASES: [string, string, "fatal" | "retryable"][] = [
  [
    "model not found (pi 本地解析失败)",
    `exit 1\nError: Model "agentrouter/claude-opus-4-8" not found. Use --list-models to see available models.`,
    "fatal",
  ],
  [
    "no available channel (503 + model_not_found)",
    `provider: 503: {"message":"No available channel for model claude-opus-4-8 under group default (distributor)","type":"new_api_error","param":"","code":"model_not_found"}`,
    "fatal",
  ],
  ["invalid api key", `provider: 401 {"message":"Invalid API key"}`, "fatal"],
  ["insufficient balance", `provider: 402 {"message":"Insufficient balance"}`, "fatal"],
  [
    "upstream 500（本次事故的最后一跳）",
    `provider: 500 {"error":{"type":"<nil>","message":"Upstream request failed (request id: 202610182309115260451348268d9d64w68O1k5)"},"type":"error"}`,
    "retryable",
  ],
  ["503 service unavailable", `provider: 503: {"message":"Service Unavailable","type":"error","param":"","code":null}`, "retryable"],
  [
    "402 quota service unavailable（job#5）",
    `provider: 402 {"error":{"type":"<nil>","message":"Quota service is temporarily unavailable. Please try again later."},"type":"error"}`,
    "retryable",
  ],
  ["timeout", "timeout", "retryable"],
  ["network reset", `exit 1\nError: socket hang up`, "retryable"],
  ["unknown → 默认 retryable", `exit 1\nError: something weird`, "retryable"],
];

for (const [name, text, want] of CASES) {
  const got = classifyPiFailure({ error: text, stderr: text });
  check(`classify: ${name} → ${want}`, got === want, `got ${got}`);
}

// ── 2) shortReason ────────────────────────────────────────────────────────

check("shortReason: no channel", shortReason(`provider: 503: {"message":"No available channel for model x"}`) === "no channel");
check(
  "shortReason: model not found",
  shortReason(`Error: Model "agentrouter/claude-opus-4-8" not found`) === "model not found",
);
check("shortReason: upstream 500", shortReason(`provider: 500 {"error":{"message":"Upstream request failed"}}`) === "500 upstream");
check("shortReason: 402 quota", shortReason(`provider: 402 {"error":{"message":"Quota service is temporarily unavailable."}}`) === "402 quota");

// ── 3) 链路摘要 ───────────────────────────────────────────────────────────

const single: PiAttempt[] = [{ model: "a", class: "fatal", ms: 1, error: "provider: 500 x" }];
check("formatChainError: 单跳保持旧格式", formatChainError(single) === "provider: 500 x");

const multi: PiAttempt[] = [
  { model: "justwoker/claude-opus-4-8", class: "fatal", ms: 1, error: `provider: 503: {"message":"No available channel for model claude-opus-4-8"}` },
  { model: "agentrouter/claude-opus-4-8", class: "fatal", ms: 1, error: `exit 1\nError: Model "agentrouter/claude-opus-4-8" not found` },
  { model: "anyrouter/claude-opus-4-7", class: "retryable", ms: 1, error: `provider: 503: {"message":"Service Unavailable"}` },
];
const summary = formatChainError(multi);
check("formatChainError: 含 all N models failed", summary.startsWith("all 3 models failed"), summary);
check("formatChainError: 每跳都在", ["justwoker/claude-opus-4-8[no channel]", "agentrouter/claude-opus-4-8[model not found]", "anyrouter/claude-opus-4-7[503 unavailable]"].every((s) => summary.includes(s)), summary);

// ── 4) 模型清单解析 / 缺失检测 ────────────────────────────────────────────

const TABLE = `provider      model                                    context  max-out  thinking  images
deepseek      deepseek-flash                           1M       384K     yes       yes
meta-gateway  justwoker/claude-opus-4-8                200K     32K      yes       yes
meta-gateway  agentrouter/claude-opus-5-5              128K     16.4K    no        yes
`;
const models = parseModelList(TABLE);
check("parseModelList: provider/model 键", models.has("deepseek/deepseek-flash"));
check("parseModelList: 裸 model 键", models.has("justwoker/claude-opus-4-8"));
check("parseModelList: 不含坏 ID", !models.has("agentrouter/claude-opus-4-8"));

const missing = missingModels(
  ["justwoker/claude-opus-4-8", "agentrouter/claude-opus-4-8", "deepseek/deepseek-flash", undefined],
  models,
);
check("missingModels: 只报缺失项", missing.length === 1 && missing[0] === "agentrouter/claude-opus-4-8", JSON.stringify(missing));
check("missingModels: 探测失败不报错", missingModels(["x"], null).length === 0);

// ── 5) 退避 ───────────────────────────────────────────────────────────────

const b0 = backoffMs(0, 30_000, 120_000);
const b1 = backoffMs(1, 30_000, 120_000);
const b2 = backoffMs(2, 30_000, 120_000);
const b3 = backoffMs(3, 30_000, 120_000);
check("backoff: 30s±20%", b0 >= 24_000 && b0 <= 36_000, String(b0));
check("backoff: 60s±20%", b1 >= 48_000 && b1 <= 72_000, String(b1));
check("backoff: 封顶 120s±20%", b2 <= 144_000 && b3 <= 144_000, `${b2}/${b3}`);

// ── 6) 重试循环行为 ───────────────────────────────────────────────────────

const base: PiRunOptions = { prompt: "x", cwd: "/tmp" };

function fakeResult(error?: string, extra: Partial<PiRunResult> = {}): PiRunResult {
  return {
    ok: !error,
    finalText: error ? "" : "done",
    events: [],
    stdout: "",
    stderr: extra.stderr ?? "",
    exitCode: error ? 1 : 0,
    signal: null,
    timedOut: false,
    attempts: 1,
    error,
    ...extra,
  };
}

/** Run a chain against a scripted per-model response table. */
async function scenario(
  script: Record<string, string[]>,
  opts: Partial<PiRunOptions>,
  expect: (r: PiRunResult, calls: string[]) => void,
): Promise<PiRunResult> {
  const calls: string[] = [];
  const counters = new Map<string, number>();
  const r = await runPiWith({ ...base, ...opts }, async (o) => {
    const m = o.model ?? "(default)";
    calls.push(m);
    const n = counters.get(m) ?? 0;
    counters.set(m, n + 1);
    const list = script[m] ?? ["provider: 500 boom"];
    return fakeResult(list[Math.min(n, list.length - 1)]);
  });
  expect(r, calls);
  return r;
}

async function main() {
  // AC2: fatal 不重试
  await scenario(
    { "a": [`exit 1\nError: Model "a" not found`] },
    { model: "a", retries: 2 },
    (_r, calls) => {
      check("AC2 fatal 不重试（只调用 1 次）", calls.length === 1, calls.join(","));
    },
  );

  // AC3: retryable 重试 retries 次
  await scenario(
    { "a": [`provider: 500 boom`] },
    { model: "a", retries: 2 },
    (_r, calls) => {
      check("AC3 retryable 重试到上限（1 + 2 = 3 次）", calls.length === 3, calls.join(","));
    },
  );

  // 降级成功：primary fatal → fallback ok
  const r2 = await scenario(
    {
      "justwoker/claude-opus-4-8": [`provider: 503: {"message":"No available channel for model claude-opus-4-8"}`],
      "deepseek/deepseek-flash": [""],
    },
    { model: "justwoker/claude-opus-4-8", fallbackModels: ["deepseek/deepseek-flash"], retries: 2 },
    (_r, calls) => {
      check("降级：fatal 直接换模型，不重试", calls.length === 2, calls.join(","));
    },
  );
  check("降级：ok=true", r2.ok === true);
  check("降级：usedModel 正确", r2.usedModel === "deepseek/deepseek-flash", String(r2.usedModel));
  check("降级：chain 记录 2 跳", (r2.chain?.length ?? 0) === 2);

  // AC4: 全链失败 → 链路摘要
  const r3 = await scenario(
    {
      "a": [`provider: 503: {"message":"No available channel for model a"}`],
      "b": [`exit 1\nError: Model "b" not found`],
      "c": [`provider: 500 Upstream request failed`],
    },
    { model: "a", fallbackModels: ["b", "c"], retries: 1 },
    () => {},
  );
  check("AC4 全链失败：ok=false", r3.ok === false);
  check("AC4 全链失败：错误含 all 3 models failed", (r3.error ?? "").startsWith("all 3 models failed"), r3.error);
  check("AC4 全链失败：错误含三跳模型", ["a[no channel]", "b[model not found]", "c[500 upstream]"].every((s) => (r3.error ?? "").includes(s)), r3.error);

  // 超时不重试（保持原有语义）
  const calls: string[] = [];
  const r4 = await runPiWith({ ...base, model: "a", retries: 2 }, async () => {
    calls.push("a");
    return fakeResult("timeout", { timedOut: true, exitCode: null });
  });
  check("timeout 不重试", calls.length === 1 && r4.error === "timeout", `${calls.length}/${r4.error}`);

  // 空闲看门狗：静默超时是可恢复错误，要重试
  const idleCalls: string[] = [];
  await runPiWith({ ...base, model: "a", retries: 2 }, async () => {
    idleCalls.push("a");
    return fakeResult("idle timeout (600s without output)", { idleTimedOut: true, exitCode: null });
  });
  check("idle timeout 会重试（3 次）", idleCalls.length === 3, String(idleCalls.length));

  // 链路预算：单次尝试的 timeout 必须被剩余预算截断；预算耗尽要停
  const seen: number[] = [];
  await runPiWith(
    { ...base, model: "a", retries: 20, timeoutSec: 1800, chainBudgetSec: 61 },
    async (o) => {
      seen.push(o.timeoutSec ?? -1);
      await new Promise((r) => setTimeout(r, 1000));
      return fakeResult("provider: 500 Upstream request failed");
    },
  );
  check("预算：单次 timeout ≤ 链路预算", seen.every((t) => t > 0 && t <= 61), JSON.stringify(seen));
  check("预算：耗尽后停止（远小于 retries=20）", seen.length < 6, String(seen.length));

  // 单模型失败仍是旧格式
  const r5 = await scenario({ "a": [`provider: 500 uptream`] }, { model: "a", retries: 0 }, () => {});
  check("单模型失败保持旧格式", (r5.error ?? "").startsWith("provider: 500"), r5.error);

  console.log(failures === 0 ? "\n✅ all pi-retry selftests passed" : `\n❌ ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
