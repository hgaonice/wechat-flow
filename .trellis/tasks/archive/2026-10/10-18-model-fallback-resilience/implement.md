# 实施计划：模型降级链韧性

## 顺序（先止血，再防复发，再收口）

### S1 止血：修配置（不改代码，10 分钟见效）

1. 在 250 上 `GET /api/settings` 存档旧 `model` 块到 `data/backups/settings-model-<ts>.json`
2. `PUT /api/settings` 写入 design D6 的新 `model` 块（自动回渲 `config.json`）
3. 断言：
   - `bun src/cli.ts doctor --all`（250）无 CLI 报错
   - `pi --print --no-session --model agentrouter/claude-opus-5-5 -- 'reply ok'` → `ok`
   - `pi --print --no-session --model deepseek/deepseek-flash -- 'reply ok'` → `ok`
4. 若当日文章仍缺：`bun src/cli.ts publish --date 2026-10-19 --dry-run`（各账号）确认能出文

**验证命令（250）**
```bash
cd /root/wechat-flow && bun src/cli.ts publish --date 2026-10-19 --dry-run -a gaoh
cd /root/wechat-flow && bun src/cli.ts publish --date 2026-10-19 --dry-run -a second
```

### S2 代码：`src/pi.ts` 核心改造

- [ ] 新增 `classifyPiFailure()`（D1 模式表，纯函数、无 IO）
- [ ] 新增 `shortReason()`（≤24 字，未知回落到前 40 字）
- [ ] 新增 `formatChainError(chain)`（单条沿用旧格式，多条 `all N models failed: a[x] → b[y]`）
- [ ] `runPiOnce` 返回值补 `ms`（耗时），失败时把 `stderr` 一起交给分类器
- [ ] `runPi` 改为 D2 循环：fatal → `break` 换模型；retryable → 指数退避 + jitter
- [ ] `PiRunResult` 增 `chain: PiAttempt[]` / `usedModel?: string`
- [ ] 退避可被 `PI_RETRY_BASE_MS`(0=不睡) / `PI_RETRY_MAX_MS` 覆盖
- [ ] 新增 `listAvailableModels()` / `missingModels()` + 10 分钟缓存（D4）
- [ ] 保留 `retries` / `retryDelaySec` / `fallbackModels` 的向后兼容语义

### S3 代码：消费方

- [ ] `src/publisher.ts`：生成成功且 `chain.length > 1` → `log.warn` + `notify("⚠️ ... 已降级")`
- [ ] `src/planner.ts`：同上但只 `log.warn`
- [ ] `src/cli.ts` `doctor()`：新增 `models` 检查行（缺失 ❌ / 探测失败 ⚠️）
- [ ] `publisher` / `planner` 调 `runPi` 前做一次 `missingModels` WARN（不阻塞）

### S4 代码：调度重试窗口

- [ ] `src/console/jobs/scheduler.ts`：
  - `MAX_ATTEMPTS` 默认 3 → 8
  - 冷却改指数：`min(base * 2^(failures-1), COOLDOWN_MAX)`，base 15min / max 60min
  - 新增 `schedule.publishDeadlineHour`（默认 12；`0` 不限），仅在已有失败记录时阻止重试
- [ ] `src/console/jobs/queue.ts`：提供 `consecutiveFailures()`（或复用 `countFailed`）
- [ ] `deploy/console-scheduler.md` 同步参数说明
- [ ] `deploy/systemd/wechat-console.env.example` 补 `CONSOLE_JOB_RETRY_COOLDOWN_MAX_MIN`

### S5 自测脚本

- [ ] 新增 `tools/pi-retry-selftest.ts`（无网络）：
  - 分类矩阵：8 组真实报错文本 → fatal/retryable 断言
  - 摘要拼接：单条保旧格式、多条含 `all N models failed` 与 `→`
  - 模拟事件流注入 `runPiOnce` 的解析逻辑（导出可测的纯解析函数 `parsePiStream(lines)`）
- [ ] 断言 `PI_RETRY_BASE_MS=0` 下 fatal 场景耗时 < 1s、retryable 场景重试次数正确

### S6 验证

- [ ] `bun build --target=bun src/cli.ts`
- [ ] `bunx tsc --noEmit`
- [ ] `bun tools/pi-retry-selftest.ts`
- [ ] `bun src/cli.ts doctor --all`（本地）
- [ ] 部署到 250 → `doctor --all` → `publish --dry-run --date 2026-10-19`（两账号）
- [ ] 真机观察一次失败场景（可用 `--model agentrouter/does-not-exist` 人为触发 fatal）：
      日志应显示「跳过」而非「retrying in 30s」，且错误含链路摘要

### S7 文档

- [ ] `.trellis/spec/engine/error-handling.md`：新增「错误分类矩阵」「链路摘要」「模型自检」契约
- [ ] `AGENT.md` §1 看板 + 变更日志
- [ ] `config.example.json` 与 design D6 对齐

## 各步骤验证命令

| 步骤 | 命令 | 期望 |
|---|---|---|
| S1 | `ssh 250 'cd /root/wechat-flow && bun src/cli.ts publish --date 2026-10-19 --dry-run -a gaoh'` | `dry-run ok ... words=N` |
| S2/S5 | `bun tools/pi-retry-selftest.ts` | 全部 PASS |
| S6 | `bunx tsc --noEmit` | 无输出 |
| S6 | `bun src/cli.ts doctor --all` | `models` 行 ✅ |
| S6 | 人为 fatal 场景 | 日志无 `retrying in 30s` |

## 评审门

- G-A（S1 后）：今天两条账号能出文 → 才继续改代码
- G-B（S2 后）：`pi-retry-selftest` 全绿 → 才改调度
- G-C（S6 后）：250 真机 dry-run 通过 → 才更新 spec 并提交

## 回滚点

- 每步独立可回滚：S1 用存档 `PUT` 回旧配置；S2–S4 在同一个 commit 内，`git revert` 即整体回退

---

## 执行结果（2026-10-19）

| 步骤 | 状态 | 证据 |
|---|---|---|
| S1 修配置（真源 = console DB） | ✅ | `GET /api/settings` 存档 → `backups/settings-20261019-075408.json`；`PUT /api/settings` 写入新 `model` → 回渲 `config.json` 一致 |
| S2 `src/pi.ts` | ✅ | `classifyPiFailure` / `shortReason` / `formatChainError` / `listAvailableModels` / `missingModels` / `runPiWith` / `backoffMs`；`PiRunResult.chain/usedModel/idleTimedOut` |
| S2b 空闲看门狗 + 链路预算 | ✅ | 真机事故补入：`idleTimeoutSec`(600s) + `chainBudgetSec`(900s)，单次 `timeoutSec` 被剩余预算截断 |
| S3 消费方 | ✅ | `publisher.ts`（未知模型 WARN + 降级 notify）、`planner.ts`（WARN）、`cli.ts#doctor`（`models` 行） |
| S4 调度重试窗口 | ✅ | `MAX_ATTEMPTS` 3→8、冷却指数 15→30→60min、`publishDeadlineHour`(12)、`deploy/*` 文档与 env 示例 |
| S5 自测 | ✅ | `PI_RETRY_BASE_MS=0 bun tools/pi-retry-selftest.ts` → **40 PASS / all passed**（250 上跑） |
| AC1 配置存在性 | ✅ | 250 `doctor --all` → `✅ models (pi --list-models) 7 个模型全部存在` |
| AC2 fatal 不重试 | ✅ | 线上日志：`[pi] justwoker/claude-opus-4-8 is not retryable (no channel); moving on`（旧行为是 36s+30s 退避） |
| AC3 retryable 退避 | ✅ | selftest：30s→60s→封顶 120s（±20% jitter），重试次数=retries |
| AC4 链路摘要 | ✅ | selftest：`all 3 models failed (…)` 含每跳 `model[reason]`；单跳保持旧格式 |
| AC5 doctor 自检 | ✅ | 250 实跑 `models` 行 ✅；探测失败返回 ⚠️ 不阻塞 |
| AC6 降级可见 | ✅ | 邮件 `[gaoh的技术分享] ⚠️ 2026-10-19 已降级到 agentrouter/claude-opus-5-5` |
| AC7 真机双账号 | ✅ | `gaoh` job#22 → 草稿《拆解九上数学｜配方法的应用(一)…》(2943 字, svg=5)；`second` 手跑 → 草稿《九上必考｜配方法比大小、求值…》(2526 字, svg=8)；`drafts --all --date 2026-10-19` 两账号 **✅ 草稿校验 + ✅ 正文校验** |
| AC8 回归 | ✅ | `npx tsc --noEmit` 0 错；250 `doctor --all` 全绿 |
| AC9 挂死保护 | ✅ | selftest：`idle timeout 会重试（3 次）`、`单次 timeout ≤ 链路预算`、`预算耗尽后停止` |

### 连带修复

- **`drafts --date` 假阴性**：原来盲取 `readdirSync(...)[0]`，会拿到 `.v1.md` 历史版本或 `.math.md` 副本 → 标题对不上 → 误报 `❌ 未找到`。改为排除 `*.v<N>.md` / `*.math.md` 并打印所用文件名（`src/cli.ts`）。修复后 gaoh 从 ❌ → ✅。
- **`deploy.sh` 缺 `--exclude .venv/`**：rsync `--delete` 删掉了 250 的 manim venv（血训 2026-10-19）。已补排除项；`/opt/manim-venv` 用 `python3 -m venv --upgrade` + 重建 `bin/manim` wrapper 恢复，`manim -ql --format=gif` 渲染冒烟通过。
