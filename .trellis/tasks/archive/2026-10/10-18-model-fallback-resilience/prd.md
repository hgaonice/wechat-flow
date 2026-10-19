# PRD：修复文章生成反复失败（模型降级链 + 重试策略）

## 背景

2026-10-19 07:00 两条账号（`second` / `gaoh`）同时失败，邮件只写：

```
错误：provider: 500 {"error":{"type":"","message":"Upstream request failed (request id: 2026...)"},"type":"error"}
```

用户反馈「出现过好几次」。实际是**模型降级链整体失效**，用户看到的只是链路最后一跳。

## 证据（250 真机，2026-10-19 07:00–07:15 journal + `console/console.db`）

### 失败链（job#19 second / job#20 gaoh，07:00:03 起）

| # | 模型 | 结果 | 单次耗时 | 退避 |
|---|---|---|---|---|
| 1 | `justwoker/claude-opus-4-8` | 503 `No available channel for model claude-opus-4-8` (`model_not_found`) | 36s | 30s |
| 2 | `agentrouter/claude-opus-4-8` | **`Model "agentrouter/claude-opus-4-8" not found`** | 4s | 30s |
| 3 | `anyrouter/claude-opus-4-7` | 503 Service Unavailable | 34s | 30s |
| 4 | `anyrouter/claude-sonnet-4-5-20250929` | 503 Service Unavailable | 28s | 30s |
| 5 | `agentrouter/deepseek-v4-flash` | 500 Upstream request failed | 72s | 30s |

合计 ~7.5 分钟，最终错误 = 第 5 跳的错误。

### 模型存在性（`pi --list-models`，250）

- 存在：`agentrouter/claude-opus-5-5`、`anyrouter/claude-opus-4-8`、`anyrouter/claude-opus-4-7`、`anyrouter/claude-sonnet-4-5-20250929`、`agentrouter/deepseek-v4-flash`、`justwoker/claude-opus-4-8`、`deepseek/deepseek-flash`、`deepseek/deepseek-v4-pro`
- **不存在**：`agentrouter/claude-opus-4-8`（article 链 fallback#1）
- **不存在**：`packyapi-deepseek/deepseek-flash`（plan 链 fallback#1，实测报 `Use /login ...`）

### 冗余真实度

`justwoker/*`、`agentrouter/*`、`anyrouter/*` 全部由 **同一个 meta-gateway**（250 上 `http://192.168.0.251:3011/v1`）承载 → 5 个 fallback 实际是**单点**。真正独立的上游只有 `deepseek`（直连 `api.deepseek.com`），而它不在 article 链里。

### 现场可用性（07:46 实测）

| 模型 | 结果 |
|---|---|
| `justwoker/claude-opus-4-8` | ❌ 503 no channel |
| `agentrouter/claude-opus-5-5` | ✅ ok |
| `deepseek/deepseek-flash` | ✅ ok |
| `anyrouter/claude-opus-4-8` / `-4-7` / `workbuddy/global:gpt-5.5` | ⏱ 35s 无响应 |

### 历史失败（`jobs` 表）

| job | 时间 | 错误类别 |
|---|---|---|
| #5 | 10-15 | `provider: 402 Quota service is temporarily unavailable` |
| #6/#8/#12 | 10-15/16 | `Editor did not load (#title not found)`（另一问题，已由 ecd79fa 处理） |
| #14 | 10-16 | `New tab not found: mp.weixin.qq.com` |
| #19/#20 | 10-18 | `provider: 500 Upstream request failed` ← 本任务 |

## 根因

- **R1 配置含不存在的模型 ID**：article / plan 链各一个 → 每次失败白烧 ~64s，且真兜底少一个。
- **R2 冗余是假的**：全部 fallback 共用 meta-gateway 单点，上游一挂全挂。
- **R3 重试策略无差别**：`src/pi.ts:209` `runPi()` 对 `Model not found`（不可恢复）也退避重试；对真正的 5xx 只重试 1 次；退避固定 30s 无 jitter。
- **R4 错误只保留最后一跳**：`src/pi.ts:165` 用户看到 500，看不到「主模型上游缺渠道 → 5 个全挂」。402 同样被掩盖。
- **R5 调度兜底窗口太窄**：`CONSOLE_JOB_MAX_ATTEMPTS=3` + `CONSOLE_JOB_RETRY_COOLDOWN_MIN=30` → 07:00 起最多到 ~08:40 就 `attempts-exhausted`，当天彻底放弃。

## 需求

### 功能需求

- **F1 错误分类重试**：按错误类别决定「重试」还是「立即换模型」。
  - 不可恢复（不重试，直接下一模型）：`Model "..." not found`、`No available channel`、`model_not_found`、HTTP 401/403
  - 可恢复（指数退避重试）：HTTP 429/5xx、`Upstream request failed`、`Quota service is temporarily unavailable`、`Service Unavailable`、超时
- **F2 链接路摘要**：全部模型失败时，错误信息包含每一跳的 `model[原因]`，写入邮件正文与 `jobs.error`。
- **F3 模型存在性自检**：用 `pi --list-models` 校验配置中每个模型 ID；不存在则 `doctor` 报红、启动时 WARN。结果进程内缓存。
- **F4 降级可见**：主模型失败但降级成功时，发「⚠️ 已降级」通知，不静默。
- **F5 配置修正**：article / plan 链改为真实存在 + 跨上游冗余，去掉两个坏 ID。
- **F6 调度重试窗口**：失败后当天可持续重试至配置的截止时刻（默认 12:00），而不是 3 次即放弃。
- **F7 挂死保护**（实施中追加，真机事故）：上游流挂死（无任何输出）时必须被杀掉并换模型，
  而不是拖到 `timeoutSec`(1800s)；整条链总耗时必须有上界。

### 非功能需求

- **N1** 运行时零新增依赖（bun 内置 `fetch` / `spawnSync`）。
- **N2** 不改发布铁律：唯一真相源仍是草稿箱真实 DOM。
- **N3** 可回滚：配置改动备份 `config.json`；代码改动为纯增量，语义向后兼容（新参数有默认值）。
- **N4** 单测/自测可在无网络下验证错误分类与摘要拼接（注入假事件流）。

## 不在范围内

- WeChat 浏览器发布链路（`Editor did not load` / `New tab not found`）——另一个问题域。
- 控制台 UI 展示任务的尝试历史（只保证 `jobs.error` 存摘要；UI 后续再评估）。
- 更换 provider 供应商或新增中转站账号。

## 验收标准

- **AC1**（配置）`pi --list-models` 的模型集合 ⊇ 配置中所有 `model` 与 `fallbacks`；在 250 上跑 `bun src/cli.ts doctor --all` 出现 `models` 行且为 ✅。
- **AC2**（分类）注入 `Model "x" not found` 事件 → 该模型**不产生退避重试**，直接进入下一模型；实测同一场景总耗时从 ~64s 降到 <10s。
- **AC3**（分类）注入 503 `Service Unavailable` 事件 → 同一模型重试且退避递增（30s→60s），可用 `PI_RETRY_BASE_MS` 缩短后在自测中观测。
- **AC4**（摘要）全部模型失败时，`error` 形如 `all 5 models failed: justwoker/claude-opus-4-8[503 no channel] → agentrouter/...[model not found] → ...`，邮件正文含同样的链路。
- **AC5**（自检）故意把某 fallback 改成 `agentrouter/does-not-exist`，`doctor` 输出 ❌ 并指出该 ID；恢复后 ✅。
- **AC6**（降级可见）primary 必失败 + fallback 可用 → 生成成功且发出「已降级到 X」通知（dry-run 下日志可见）。
- **AC7**（真机）在 250 上 `publish --dry-run --date 2026-10-19` 两条账号均成功出文（或其上游确实全挂时，错误信息含完整链路摘要，不再只有 500）。
- **AC8**（回归）`bun build --target=bun src/cli.ts` + `bunx tsc --noEmit` 零错误；现有 `publish --dry-run` 正常。
- **AC9**（挂死）注入「静默无输出」的假 runner：达到 `idleTimeoutSec` 后被杀且错误为 `idle timeout`，归类 retryable 会重试；
  链路总耗时被 `chainBudgetSec` 限住（单次 `timeoutSec` 被剩余预算截断）。
