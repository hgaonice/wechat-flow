# 设计：模型降级链韧性

## 边界

只改「生成阶段的容错与可观测」，不改发布链路、不改 AI/确定性分层。
落点：`src/pi.ts`（核心）、`src/cli.ts`（doctor）、`src/publisher.ts` / `src/planner.ts`（降级通知）、
`src/console/jobs/{scheduler,queue}.ts`（重试窗口）、`config.example.json`、250 的 console DB 全局设置。

---

## D1 错误分类（纯函数，可离线自测）

```ts
export type PiFailureClass = "fatal" | "retryable";
export function classifyPiFailure(input: { error?: string; stderr?: string }): PiFailureClass;
```

匹配对象是 `error` + `stderr` 拼接后的文本（`Model not found` 走的是 exit 1 + stderr 路径）。

**fatal（换模型，不重试）**

| 模式 | 来源 |
|---|---|
| `/Model\s+"[^"]*"\s+not found/i` | pi 本地模型解析失败（配置错） |
| `/model_not_found/i` | new_api 上游无渠道 |
| `/No available channel/i` | 同上（当前 503 的主要形态） |
| `/invalid api key|无可用令牌|令牌无效/i` | 凭据错 |
| `/\b(401|403)\b/` | 鉴权类 |
| `/Insufficient (balance|quota)|余额不足|已欠费/i` | 余额类 |

**retryable（同模型退避重试）**

| 模式 | 来源 |
|---|---|
| `/\b(429|5\d{2})\b/` | 限流 / 5xx |
| `/Upstream request failed/i` | 本次事故的最后一跳 |
| `/Quota service is temporarily unavailable/i` | job#5 的 402 |
| `/Service Unavailable/i`、`/timeout|ETIMEDOUT|ECONNRESET|socket hang up/i` | 网络类 |

**默认 retryable**（宁可多试一次，也不因误判丢掉唯一可用模型）。

> `No available channel` 判 fatal 的依据：new_api 的渠道分组是静态配置，同一模型在分钟级内不会自愈；
> 重试它只会白烧 30s。这一点由 AC2 实测耗时验证（~64s → <10s）。

## D2 重试循环（`runPi`）

```
for (model of [primary, ...fallbacks]) {
  for (attempt = 0; ; attempt++) {
    if (budget 剩余 <= 60s) break outer       // 链路预算
    timeoutSec  = min(opts.timeoutSec, 剩余预算) // 单次不允许超预算
    r = runPiOnce(model, timeoutSec, idleTimeoutSec)
    record(model, r, ms)
    if (r.ok) return { ...r, usedModel: model }
    if (r.timedOut) return r                     // 全局超时：不重试（现状语义）
    cls = classifyPiFailure(r)
    if (cls === "fatal") break                   // 立即换下一个模型
    if (attempt >= retriesForRetryable) break
    await sleep(backoff(attempt))                // 30s → 60s → 120s，±20% jitter
  }
}
return last with chain summary
```

- `retries` 语义收窄为「**可恢复**错误的重试次数」，默认 2（每模型最多 3 次尝试）
- 退避：`base = PI_RETRY_BASE_MS ?? retryDelaySec*1000 ?? 30_000`，`min(base*2^attempt, PI_RETRY_MAX_MS ?? 120_000)`
- jitter：`±20%`，避免多账号同刻重试（当前 two accounts 完全同拍 → 同时打满上游）
- `PI_RETRY_BASE_MS` 存在时跳过 sleep（自测用，值 `0` = 不退避）

### D2b 空闲看门狗 + 链路预算（真机事故 2026-10-19 07:41 补入）

事故：job#21 的 `pi` 进程从 07:41 起**无任何输出挂了 15 分钟**，`timeoutSec`(1800s) 是整次生成上限，
单次尝试挂死就能吃光整个发布窗口。

- **空闲看门狗**（`runPiOnce`）：连续 `idleTimeoutSec`（默认 600s，env `PI_IDLE_TIMEOUT_SEC`）
  stdout/stderr 无输出 → SIGTERM(10s)→SIGKILL，错误记为 `idle timeout (Ns without output)`，
  归类 **retryable**（换一次往往就好）。
- **链路预算**（`runPiWith`）：`chainBudgetSec` 默认 900s；每次尝试的 `timeoutSec` 被
  `剩余预算` 截断，剩余 ≤60s 不再开新尝试。保证整条链 bounded。

## D3 链路记录与摘要

```ts
export interface PiAttempt {
  model?: string;
  class: "ok" | "fatal" | "retryable" | "timeout";
  ms: number;
  error?: string;
}
```

`PiRunResult` 新增 `chain: PiAttempt[]`、`usedModel?: string`、保留 `attempts: number`。

错误串生成（`formatChainError`）：

- `chain.length === 1` → 沿用旧格式 `provider: <msg>` / `exit N`（不破坏现有日志习惯）
- 否则 →
  ```
  all 3 models failed: justwoker/claude-opus-4-8[503 no channel] → agentrouter/claude-opus-4-8[model not found] → anyrouter/claude-opus-4-7[503 service unavailable]
  ```
  `shortReason()` 提取 ≤24 字摘要，未知模式回落到原文前 40 字。

## D4 模型存在性自检

```ts
export function listAvailableModels(piBin: string): Set<string> | null; // null = 探测失败
export function missingModels(configured: (string|undefined)[], available: Set<string>): string[];
```

- 解析 `pi --list-models` 表格：第 1 列 provider、第 2 列 model
- 集合同时收录 `model` 与 `provider/model`（本仓库配置习惯是后者不全写，见 `justwoker/claude-opus-4-8`）
- 进程内缓存 `PI_MODELS_CACHE_TTL_MS`（默认 10 分钟），失败返回 `null` 且**不阻塞**主流程
- 消费方：
  - `doctor`（`src/cli.ts`）新增检查行 `models`：有缺失 → ❌ 并列出 ID；探测失败 → ⚠️
  - `publisher` / `planner` 调 `runPi` 前 WARN 一次（不抛错）

## D5 降级可见

`publisher.runArticleGeneration` 成功后：若 `gen.chain.length > 1` →
`log.warn("已降级：<usedModel>（前 N 个模型失败）")` + `notify({ kind:"publish", title:"⚠️ <date> 已降级到 <model>" })`。
`planner` 只 `log.warn`（避免每天两封噪音邮件）。

## D6 配置修正（真源 = console DB）

`config.json` 是 `renderConfigObject(db)` 的产物（`src/console/db/render-config.ts`），
因此 250 上**必须经 `PUT /api/settings`** 改 `model`，直接改文件会被下一次 `syncConfigFile()` 覆盖。

目标链路（全部经 `pi --list-models` 在 250 验证存在）：

```jsonc
"model": {
  "plan": {
    "model": "agentrouter/deepseek-v4-flash",
    "thinking": "high",
    "fallbacks": ["deepseek/deepseek-v4-pro", "deepseek/deepseek-flash"]
  },
  "article": {
    "model": "justwoker/claude-opus-4-8",
    "thinking": "medium",
    "fallbacks": [
      "agentrouter/claude-opus-5-5",
      "anyrouter/claude-opus-4-8",
      "deepseek/deepseek-flash"
    ]
  }
}
```

- 删除坏 ID：`agentrouter/claude-opus-4-8`、`packyapi-deepseek/deepseek-flash`
- `deepseek/*` 走 `api.deepseek.com`（直连），**打破 meta-gateway 单点**
- 同步更新 `config.example.json`

## D7 调度重试窗口

现状：`MAX_ATTEMPTS=3` × `cooldown 30min` → 07:00 起最多撑到 ~08:40 即 `attempts-exhausted`。

改为：

| 项 | 现状 | 新默认 | 说明 |
|---|---|---|---|
| `CONSOLE_JOB_MAX_ATTEMPTS` | 3 | 8 | 每日最大尝试次数 |
| `CONSOLE_JOB_RETRY_COOLDOWN_MIN` | 30 | 15 | **基础**冷却 |
| `CONSOLE_JOB_RETRY_COOLDOWN_MAX_MIN` | — | 60 | 指数冷却上限 |
| `schedule.publishDeadlineHour` | — | 12 | 超过此小时不再重试（0 = 不限） |

冷却按连续失败次数指数增长：15 → 30 → 60 → 60 …，实际重试时刻 ≈ 07:00 / 07:15 / 07:45 / 08:45 / 09:45 / 10:45 / 11:45，覆盖整个上午的上游抖动。

`deadline` 只在「当天已有失败记录」时生效；首次发布不受限制（避免用户手工改时间后当天完全不发）。

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| 分类误判把可恢复错误当 fatal | 默认 retryable；fatal 只用精确模式；AC2 用真实报错文本回归 |
| `pi --list-models` 慢/失败拖慢发布 | 10 分钟缓存；探测失败返回 `null`，从未阻断 |
| 调度改动改变两账号发布节奏 | deadline 12:00 只限制「重试」，不限制首次发布；env 可回退 |
| 配置改错导致全链不可用 | 改前 `GET /api/settings` 存档，回滚 = 原样 `PUT` 回去 |

## 回滚

- 配置：`GET /api/settings` 存档 → 出错按存档 `PUT` 回去
- 代码：单 PR，`git revert` 即回到旧策略；新参数全部有默认值，不破坏调用方

## 不做

- 不改 `wechat.ts` / 发布链路
- 不引入 retry 库、不新增 npm 依赖
