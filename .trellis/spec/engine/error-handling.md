# Error Handling & Degradation

> 无人值守系统：**失败必须显形、可重跑、可降级**。目标是“今天这篇文章尽量发出去”，
> 而不是“一有错就崩”。但降级绝不能把失败伪装成成功。

---

## 三类错误与处理方式

| 类别 | 例子 | 处理 |
|---|---|---|
| **上游模型失败** | `503 all nodes exhausted` / `402 quota` | 先按错误类别分流：fatal 立刻换模型，可恢复的才退避重试（`src/pi.ts`） |
| **可选增强失败** | 公式转换 / manim 渲染 / 封面字体缺失 | **不阻断发布**，保留原文，日志 + 邮件提示（`src/media.ts`） |
| **发布真实性失败** | 草稿箱查不到 / 正文为空 | **判失败**：写 `ok:false`、发失败邮件、非零退出，**绝不静默** |

---

## pi 的特殊约定（必须遵守）

pi 在**上游失败时仍以 exit 0 退出**（错误只在事件流里）。所以 `src/pi.ts`：

1. 监听 assistant 事件的 `stopReason` / `errorMessage`；
2. 把它当作失败，**先分类再决定动作**（`classifyPiFailure`）；
3. 仍失败则依次尝试 `model.*.fallbacks`。

> **不要用 `exit code` 判断 pi 成功与否。** 必须读事件流。

### 错误分类矩阵（2026-10-19 真机事故沉淀）

| 分类 | 判据（正则） | 动作 |
|---|---|---|
| `fatal` | `Model "…" not found`、`model_not_found`、`No available channel`、401/403、`invalid api key`、余额不足 | **不重试**，立刻换下一个模型 |
| `retryable` | `Upstream request failed`、`Service Unavailable`、`Quota service is temporarily unavailable`、429/5xx、`timeout`/`idle timeout`/`ECONNRESET` | 同模型指数退避重试（30→60→120s，±20% jitter） |
| 默认 | 无法识别 | `retryable`（宁可多等 30s，也不误杀唯一可用模型） |

**为什么 `No available channel` 判 fatal**：new_api 的渠道分组是静态配置，分钟级内不会自愈；
重试它只是白烧 30s（实测：单次 fatal 误重试 = 64s，正确跳过后 <10s）。

### 链路摘要（禁止只报最后一跳）

全部模型失败时，`error` 必须是链式摘要，而不是最后一跳的 `provider: 500`：

```
all 3 models failed (5 attempts): justwoker/claude-opus-4-8[no channel] → agentrouter/claude-opus-4-8[model not found] → anyrouter/claude-opus-4-7[503 unavailable]
```

单跳失败保持旧格式（`provider: …` / `exit N`），向后兼容日志与 grep。

### 挂死保护（空闲看门狗 + 链路预算）

- 单次尝试连续 `idleTimeoutSec`（默认 600s）无任何 stdout/stderr → SIGTERM/SIGKILL，错误 `idle timeout`，按 `retryable` 处理。
- 整条链 `chainBudgetSec`（默认 900s）：单次 `timeoutSec` 被「剩余预算」截断，剩余 ≤60s 不再开新尝试。
- **教训**：`timeoutSec`（1800s）是整次生成上限，不是单次尝试上限。2026-10-19 一个挂死的 `pi` 进程 15 分钟无输出，直接堵死发布窗口。

### 模型存在性自检

配置里的 `model` / `fallbacks` 必须能被 `pi --list-models` 解析到。
`doctor` 会输出 `models (pi --list-models)` 一行：

- 全部存在 → ✅
- 有不存在的 ID → ❌ 并列出（这些 ID 每次失败都要白烧一轮退避）
- 探测失败 → ⚠️（**不阻塞发布**，`listAvailableModels()` 返回 `null`）

发布/编排前也会 `log.warn` 一次（`missingModels()`），但**永不 throw**。

---

## 通用规则

- **子进程**：统一 `spawnSync` / `spawn`，捕获 stdout/stderr 与退出码；不吞异常。
- **超时**：所有网络/浏览器动作都要有超时（`config.timeoutSec`、CDP 超时参数）。
- **幂等**：发布成功后写 `state/published.json`；重复运行自动跳过；`--force` 才重发。
- **原子写**：状态/JSON 落盘用 `atomicWriteJson`（临时文件 + rename），避免半截文件。
- **降级要有痕迹**：降级成功也要在日志/邮件里写清“用了哪个 fallback / 跳过了哪步”。
- **退出码**：命令行失败返回非零；但单个账号失败不应阻止 `--all` 中其他账号继续（各自隔离）。

---

## 已知真机故障模式（实测+处置）

### E1 · 浏览器发布报 `New tab not found: mp.weixin.qq.com`

- **现象**：`publish`（browser 方式）在 skill 的 `waitForNewTab()` 超时 30s 后失败：
  `browser publish failed (exit 1, saved=false, waiting=false, emptyBody=false) Error: New tab not found: mp.weixin.qq.com`；
  草稿箱正文保持旧版（未更新）。
- **根因（2026-10-16 实测）**：该 Chrome 实例里积了**重复的 `https://mp.weixin.qq.com/` 桩 tab**（跳转中/未完成页）与 `about:blank`；
  skill 点击「新建图文」后新编辑器 tab 的建立/认定被这些 tab 干扰（`waitForNewTab` 只认“初始集合之外的新 page”）。
- **处置（已验证有效，两账号各复现一次后均修复）**：只关掉**重复桩 tab**，保留带 `token=` 的已登录 home tab，然后重跑 `publish --force --reuse`：
  ```bash
  for id in $(curl -s http://127.0.0.1:<cdpPort>/json/list | python3 -c "import json,sys
  [print(x['id']) for x in json.load(sys.stdin) if x.get('type')=='page' and x.get('url') in ('https://mp.weixin.qq.com/','about:blank')]"); do
    curl -s http://127.0.0.1:<cdpPort>/json/close/$id >/dev/null
  done
  ```
- **不要**关掉带 `token=` 的 home tab（那会丢失登录上下文）；也不要盲目重启 Chrome（会引出扫码）。
- **待办（未做，需单独评审）**：`cleanupAppmsgTabs()` 目前只清理 `/cgi-bin/appmsg` tab；可考虑扩展为「保留带 token 的 home tab，关掉其余重复/桩页」——属发布链路改动，必须走 G2 真机门后再合入。

---

### E2 · 文章生成报 `provider: 500 Upstream request failed`（降级链整体失效）

- **现象**（2026-10-19 07:00，两账号同时）：失败邮件只写
  `provider: 500 {"error":{"message":"Upstream request failed (request id: …)"}}`，看起来像偶发 5xx，实际是**整条降级链全挂**。
- **根因（250 journal 逐跳回放）**：
  1. 主模型 `justwoker/claude-opus-4-8` → 503 `No available channel`；
  2. fallback#1 `agentrouter/claude-opus-4-8` → **本地不存在**（`Model … not found`），每轮白烧 4s + 30s 退避；
  3. fallback#2/#3 `anyrouter/*` → 503；
  4. fallback#4 `agentrouter/deepseek-v4-flash` → 500（**用户看到的就是这一跳**）。
  即：5 个 fallback 有 3 个同属一个 meta-gateway 单点 + 1 个坏 ID + 1 个跨网关兜底也没有 → 上游抖一早就全挂。
- **处置**：
  - 错误分类（fatal 不重试）+ 链路摘要（不再只报最后一跳）+ 模型存在性自检（`doctor` 的 `models` 行）；
  - 配置改为跨上游冗余（`justwoker → agentrouter → anyrouter → deepseek`，其中 `deepseek/*` 直连 `api.deepseek.com`，绕开本地网关）；
  - 调度重试窗口拉到整个上午（指数冷却 15→30→60min，`publishDeadlineHour=12`）。
- **配套教训**：
  - 一个挂死的 `pi` 进程（无输出）能堵死整个发布窗口 → 必须用**空闲看门狗**而非只靠 `timeoutSec`；
  - 失败邮件必须包含「失败链路」，否则同类事故永远只能靠翻 journal 定位。

### E3 · AI 封面失败（图像模型 503 / 坏 model id / 网关不可达）

- **现象**（250 实测，2026-10-20）：
  - `cover.ai.model` 写成不存在的 id → `http 503: No available channel for model cn:not-a-real-model`；
  - 网关地址不可达 → `Unable to connect`（两个模型都失败）。
- **根因**：
  - 网关只认**裸 id** `<group>:<model>`；`workbuddy/cn:x` 这类 pi 写法会 404/503 → 必须 `normalizeImageModelId()`；
  - 图像模型会把自己的 503/404 当“正常错误”返回，不做分类就会在同一个坏 id 上反复重试；
  - 出图 15–35s，慢且贵，不能无限重试。
- **处置**：
  - **不抛异常**：`generateAiCover()` 一律返回 `{ok:false, reason}`，降级链 `AI → ffmpeg → template`，三级同尺寸；
  - **错误分类**：`400/404/model_not_found` 视为 fatal → 立刻换下一个模型（`fatal, next model`）；网络/5xx 才在同一模型上有限重试；
  - **总预算**：`cover.ai.timeoutSec`（单模型）+ `maxTotalSec`（整条链），超预算即降级，绝不拖住发布窗口；
  - **邮件可见**：降级时发 `⚠️ <date> 封面降级`，正文含失败链路（沿用 E2 的“失败链路必须可读”教训）；
  - **审计**：失败也写 `cover-brief.json`（含 `summaryOk/summaryReason`），事后能复盘是摘要坏了还是出图坏了。
- **配套教训**：
  - 摘要模型也要能降级：pi 挂了就用 `fallbackBrief()` 的确定性简报，**不要**因为摘要失败就放弃出图；
  - 模型会无视“禁止文字”：prompt 只能降低概率，真正的兜底是**让简报本身不需要文字**（区间用虚线/色块表达）；
  - 背景色同理：`averageColor()`+`luminance()` 打 WARN 而不是自动调色 —— 自动改图会毁掉“AI 决定配色”这个前提。

---

## 检查清单

- [ ] 新加的失败路径：会不会静默？有没有日志？有没有邮件/退出码？
- [ ] 新加的“可选增强”：坏了会不会误伤主流程？
- [ ] 新加的降级：成功后能否从日志看出“曾降级”？
- [ ] 重跑是否安全（幂等）？`--force` 是否只影响目标日期？

---

## E8：登录态「误判」比「失效」更贵（C1，2026-10-20）

- **现象**：日志 `WeChat session expired (url: https://mp.weixin.qq.com/) — requesting a new login`，随后二维码邮件 ×3、900s 超时、失败邮件；同账号 15 分钟后 `session valid` 并发布成功。
- **根因**：判定只有 DOM 一条证据、二值输出；MP 的缓存 `page_timeout` 壳页会把有效会话伪装成退登，reload 时序抖动也会读到旧 DOM。
- **处置（已实现）**：
  - 三态判定 + 证据分层（cookie → 鉴权请求 → DOM），壳页/读不到一律 `unknown`；
  - `unknown` 不打扰人，连续 3 次或 cookie 过期才发码；
  - 失败邮件必须带证据摘要，让人一眼区分「探测不确定」与「服务端确认失效」。
- **反面模式（禁止）**：
  - ❌ 单次探测失败就发二维码/失败邮件；
  - ❌ 用 URL 或「页面出现登录菜单」当唯一证据（缓存页会撒谎）；
  - ❌ 把 `unknown` 当 `invalid`（会让一次网络抖动变成一次人工扫码）。
