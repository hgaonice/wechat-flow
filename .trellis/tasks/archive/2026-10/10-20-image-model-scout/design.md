# 设计（C2）：图像模型普查与封面链接入

## 0. 设计目标与边界

**要解决的问题**：现在的封面主力只有两个模型（`cn:hunyuan-image-alpha-edit` → `global:gpt-image-2.5-sunburst`），选它俩的依据是"当时能跑通"，不是实测对比。C2 要把**选择依据**变成可复读的实测矩阵。

**明确不做**：

| 不做 | 原因 |
|---|---|
| 自动把主力模型换成"评分最高"的 | 出图质量的最终裁判是人眼（AC5 要求人工目视）；自动切换会在无人知晓时改变每天的风格 |
| 接入任何需付费/需信用卡的图像服务做默认主力 | PRD 非目标；且 250 是无人值守服务器，余额耗尽=发布链断 |
| 改动 `fitImageTo`/`parseSize`/`imageSize` | 确定性裁切已验证，属于"AI 只做内容、其余确定性"铁律的确定性侧 |
| 为外部源写自动适配器 | Q3：先交付"清单 + 验证步骤"，用户逐个放行后才实测接入 |

**关键约束**：

- 零新增运行时依赖（`dependencies` 保持为空）；探测脚本只能用 `fetch` + `Bun.write`。
- 探测失败一律显形：每个模型的结果必须是 `ok | failed(reason)`，禁止"跳过不记录"。
- 复用现有能力：`listImageModels()`（`src/cover-ai.ts:326`）、`generateAiCover()` 的降级链、`fitImageTo()`。

---

## 1. As-is（当前状态）

```
publisher → cover-ai.generateAiCover
              ├─ summarizeCoverBrief()（文本模型，可降级 fallbackBrief）
              └─ chain = [model, ...fallbacks]           # 默认 2 个
                   for each: POST /v1/images/generations  # 900x383 请求
                   成功 → fitImageTo(实际尺寸 → 900x383) → PNG
                   全失败 → reason "all image models failed: …"
                         → cover.ts 继续降级 ffmpeg → template
```

事实：

- `cover.ai.model` = `cn:hunyuan-image-alpha-edit`（15–21s），`fallbacks` = [`global:gpt-image-2.5-sunburst`]（~35s）。
- 网关 `http://127.0.0.1:3011/v1` 共 99 个模型，图像类 5 个（去重）：`cn:hunyuan-image-alpha-edit`、`cogview-3-flash`、`cogview-4`、`cogview-4-250304`、`global:gpt-image-2.5-sunburst`。
- **3 个 cogview 从未被本项目调用过**，延迟/尺寸/费用/中文字形全是空白。
- 图像模型会"吸尺寸"（900×383 → 实测 896×368），由 `fitImageTo` 兜底。
- `doctor` 目前**没有**任何图像模型相关行；模型挂了只能等发布日志里出现 `all image models failed`。

---

## 2. To-be（本任务交付形态）

```
tools/image-model-probe.ts   ← 新增：确定性探测矩阵（不参与发布链）
   │ 输入：--gw <url> --models a,b,c|--all-image --size 900x383 --brief <json>
   │ 输出：data/research/image-models-<date>.json   (矩阵)
   │       data/research/samples/<model>-<ts>.png   (原始产物, 未裁切)
   ▼
docs/research/image-models.md  ← 新增：R3 选型矩阵（人工可读，含每条外部源验证命令）
   ▲
   │ 参考
config.json  cover.ai.model / fallbacks            ← R4 按结论更新（人工决策点）
config.json  cover.ai.dailyBudget（新增，0=不限）   ← R6 成本护栏
src/cover-ai.ts  budget 计数 + stats 落盘
src/cli.ts#doctor  cover-candidates 行
tools/cover-selftest.ts  + 简报符合度结构断言
```

### 新增/改动清单

| 文件 | 性质 | 说明 |
|---|---|---|
| `tools/image-model-probe.ts` | 新增 | 探测矩阵：逐模型真实出图、计时、量尺寸、落盘 PNG + JSON |
| `src/cover-ai.ts` | 改动（附加） | ① 每次尝试记 `cover-model-stats.json`（最近成功/失败时间、延迟）；② `dailyBudget` 计数与耗尽降级 |
| `src/cli.ts` | 改动（附加） | `doctor` 增 `cover-candidates`（live 枚举 + 本地 stats）；`cover probe` 子命令可选（薄封装 tools 脚本） |
| `tools/cover-selftest.ts` | 改动 | 新增简报符合度结构断言 + budget 断言 |
| `docs/research/image-models.md` | 新增 | R3 矩阵 + R2 外部源清单 |
| `config.example.json` | 改动 | `cover.ai.dailyBudget`（默认 0）+ 注释 |

---

## 3. 契约

### C-1 探测矩阵 JSON（`data/research/image-models-<YYYY-MM-DD>.json`）

```ts
type ProbeRow = {
  model: string;                 // 请求时用的 id（原文，不 normalize）
  ok: boolean;
  status: number | null;         // HTTP 状态
  requestedSize: "900x383";
  returnedSize: string | null;   // 如 "896x368"
  snapped: boolean;              // returnedSize !== requestedSize
  ttfbMs: number | null;         // 首字节（有则记，无则 null）
  totalMs: number;
  bytes: number | null;
  pngPath: string | null;        // 相对 data/research/samples/
  sha256: string | null;
  reason: string | null;         // 失败原因（可读、非空）
};
type ProbeReport = {
  startedAt: string; gateway: string; brief: object;   // 同一份简报，保证可比
  rows: ProbeRow[];
  summary: { ok: number; failed: number; fastest?: string; slowest?: string };
};
```

**硬要求**：`failed` 行必须有非空 `reason`；报告里不出现 apiKey（打印前脱敏，只留后 4 位或 `***`）。

### C-2 质量评分（R5）——自动只判结构，人判内容

自动断言（`cover-selftest` + 探测脚本共用纯函数）：

| 断言 | 判据 | 为什么可自动化 |
|---|---|---|
| 尺寸归一 | `fitImageTo(png)` 后严格 `900x383` | 确定性 |
| 非空白 | 像素方差 > 阈值（复用 `averageColor`/采样） | 纯像素统计 |
| 主色可用 | 深色背景占比在 [0.2, 0.95]，强调色出现在前景 | 与简报要求对应 |
| 不越界 | PNG 可被 `imageSize()` 解析、`bytes` > 5KB | 防"1×1 占位图" |

**不自动判**：是否画错字/数字/乱码 → 由 AC5 人工目视（1 张）记录到矩阵文档 `质量` 列。**明确写进文档：自动分只反映"能不能用"，不反映"好不好看"**，避免自欺。

### C-3 成本护栏（R6）

- 新配置 `cover.ai.dailyBudget: number`，**默认 0 = 不限**（不改变今天的绑定行为）。
- 计数文件：`data/<alias>/state/cover-budget.json` = `{ date: "YYYY-MM-DD", used: n }`；跨日自动归零（日期由**文章日期**而非 UTC 决定，避免时区漂移）。
- 耗尽时：`generateAiCover()` 直接返回 `{ ok:false, reason:"daily AI cover budget exhausted (n/n)" }` → 上层照常降级 ffmpeg（**不阻断发布**），并打 WARN + 记 stats。

### C-4 `doctor` 的 `cover-candidates` 行

格式（单行、可 grep）：

```
cover-candidates: 5 image models (gateway ok) · last ok global:gpt-image-2.5-sunburst (2.1h ago, 35.2s) · last fail cogview-4 (18.3h ago: 400 model_not_found)
```

- `5 image models (gateway ok)` 来自 `listImageModels()` 实时枚举；`gateway null` → 写 `models ?`（best-effort，**绝不让 doctor 失败**）。
- last ok / last fail 来自 `cover-model-stats.json`（每账号，读不到就省略该段）。
- 禁止硬编码任何模型名（AC4）。

---

## 4. 取舍与理由

| 决策 | 选择 | 理由 |
|---|---|---|
| 探测放 `tools/` 而非 `src/` | `tools/image-model-probe.ts` | 探测是一次性运维动作，不该进发布链二进制；也避免 `src/` 里出现"只在人工跑"的分支 |
| 产物 PNG 放 `data/research/` | 否 → 放 `data/research/`（`data/` 已在 deploy EXCLUDES 与 gitignore） | 原始样张是调试料，不进仓库；矩阵文档只记 `sha256 + 路径 + 人工结论` |
| budget 默认 0（不限） | 是 | R6 要"护栏"，但默认收紧要改今天的成本模型；先用"可开"的护栏，实测后按需打开 |
| 是否把 cogview 直接插进 fallbacks | 先不插 | 未实测就进链 = 用线上发布做实验；Step 4 拿到矩阵后由人工（G-Q4）决定 |
| 外部源（R2） | 只交付清单 + 两条验证命令 | Q3 已定：用户逐个放行；且 250 出网需代理，未验证前不写适配器 |

---

## 5. 回滚

| 改动 | 回滚方式 | 风险 |
|---|---|---|
| `cover.ai.model/fallbacks` | `git revert` 配置行 / 控制台 `PUT /api/settings` 改回 | 低（下一天的封面即恢复） |
| `dailyBudget` | 设回 `0` | 低 |
| `cover-candidates` doctor 行 | best-effort，失败只影响这一行文字 | 无 |
| stats / budget 落盘 | 删 `data/<alias>/state/cover-{model-stats,budget}.json` 即回空态 | 无 |
| 探测脚本 | 独立文件，删掉不影响任何链路 | 无 |

**不变量**：AI → ffmpeg → template 三级降级与"封面失败不阻断正文"保持不变；`verifyDraftBody` 一行不动。

---

## 6. 验收映射

| AC | 由谁证明 |
|---|---|
| AC1 实测矩阵 | Step 2 产出的 `data/research/image-models-*.json`（5 行，含 3 个 cogview 首次真实数据） |
| AC2 外部源可执行 | `docs/research/image-models.md` 每行含官方链接 + 2 条命令 + 注册需求标注 |
| AC3 链路落地 | Step 4 改配置 + 故障注入（不存在的模型名 / 停网关）→ `publish --dry-run` 仍成功 |
| AC4 自检生效 | `doctor --all` 的 `cover-candidates` 行（数字与 `GET /v1/models` 一致） |
| AC5 质量门 | `cover-selftest` 新断言 + 1 张真机封面人工目视记录 |
| AC6 零回退 | `tsc`/`bun build`/`dependencies` 空/当天 `drafts --all` ✅ 正文校验 |
