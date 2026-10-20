# 设计：封面模型同题对比与择优接入

## 1. 边界

```
tools/cover-compare.ts   ← 新增（一次性运维工具，不进 src/，不在发布链上）
src/cover-ai.ts          ← 仅加一个 `export`（generateOneImage），零行为变更
data/research/cover-compare-<date>/  ← 产物，gitignored / deploy EXCLUDES
250 config.json cover.ai ← 择优后唯一生产改动点
```

**为什么不复用 `tools/image-model-probe.ts`**：它面向"模型普查"（单 brief、结构化打分、
矩阵 JSON），产出的是**数字**；本任务要的是**可目视的同题拼图**（多 brief × 多模型的
图片网格），并且必须与生产裁切 `fitImageTo(...→900x383)` 完全一致。两者输出形态不同，
硬塞进 probe 会让 probe 的契约（`.trellis/tasks/10-20-image-model-scout/design.md` §C-1）
变得含糊。probe 保留不动，作为"结构分"来源的参考实现。

## 2. 唯一真相源：复用生产链，不重写调用

`generateOneImage(gw, model, prompt, size, timeoutSec)` 是生产链的**唯一**网关调用点
（`src/cover-ai.ts:319`）。对比工具直接调它，从而自动继承：

- `isSizeRejection()` 判定 + `SIZE_ESCALATION = "1536x1024"` 放大重试（gpt-image-2.5 必走）
- `redactCoverReason()` 打码
- 超时语义

唯一改动：`async function generateOneImage` → `export async function generateOneImage`。
不新增导出行为、不改签名、不改生产调用点。

裁切复用 `fitImageTo(rawPath, outPath, "900x383")`（`src/cover.ts`）——和发布时逐像素同规则，
避免"对比图好看、上线变形"。

## 3. 变量控制（可比性的关键）

| 变量 | 处理 |
|---|---|
| brief | **全部走 `fallbackBrief(title, palette)`**（纯函数、确定性）—— 若用 `summarizeCoverBrief`，250 上无 summary 模型，反而引入 `summaryOk:false` 噪声；且不同模型若各自抽 brief 就不可比 |
| prompt | `buildImagePrompt(brief, style)`，style 取**线上同一个** `cover.ai.style` |
| 尺寸 | 请求 `900x383`；被拒则按生产逻辑放大到 `1536x1024` 重试（matrix 里 `escalated:true`） |
| 裁切 | `fitImageTo → 900x383` |
| 题目 | 4 个真实标题（覆盖几何/抛物线/函数图象/统计四类 motif），写在工具里的常量数组，可 `--titles-file` 覆盖 |

模型间的**唯一差异**就是模型本身。

## 4. 产出结构

```
data/research/cover-compare-2026-10-20/
  raw/<slug>-<modelSlug>.png         模型原图（未裁切）
  fit/<slug>-<modelSlug>.png         900×383 裁切后（= 上线长什么样）
  compare-<slug>.png                 纵向拼图：每行 900×383 + 左侧 ASCII 模型标签
  matrix.json                        AC1 的客观数据
  summary.txt                        人读摘要：每模型 ok/fail 次数、均耗时、放大次数
```

`compare-<slug>.png` 用 **python3 + Pillow**（系统已装，`tools/ui-visual.py` 也在用），
不引 npm 依赖；标签用 DejaVuSans（`/usr/share/fonts/truetype/dejavu/`），模型 id 全 ASCII。

若 Pillow 缺失 → 退化为 ffmpeg `vstack`（无标签），并在 summary.txt 里显式记
`montage: ffmpeg-fallback (no PIL)`，不静默降级。

## 5. matrix.json 行契约

```jsonc
{
  "model": "cogview-4",
  "briefId": "parabola",
  "title": "…",
  "ok": true,
  "ms": 12800,
  "rawSize": "1024x576",
  "finalSize": "900x383",
  "escalated": false,
  "sha256": "…",
  "reason": null            // ok:false 时必须是**非空**字符串
}
```

`skipped` 行：`{"model":"google/gemini-nano-banana-2.1","skipped":"no OPENROUTER_API_KEY"}`
（AC2）。退出码：`0` 至少一行 ok；`1` 运维错（网关不可达 / 无 brief / 目录不可写）；
`3` 全部模型全失败（report 仍写出，便于 `cat` 看原因）。

## 6. 择优接入（Step 2 的唯一生产改动）

只改 250 `config.json` 的 `cover.ai`：

```jsonc
"cover": {
  "ai": {
    "model": "<胜者>",
    "fallbacks": ["global:gpt-image-2.5-sunburst"],   // 若胜者就是它，则 fallbacks 换成另一候选
    ...
  }
}
```

- **不改** `cover.mode`（`gaoh` 仍 `ai`，`second` 仍 `ffmpeg`）
- **不改** `dailyBudget` 语义（按文章计数，C2 结论）
- 回滚 = 把 `model` 改回 `cn:hunyuan-image-alpha-edit`（一条 `PUT /api/settings` 或手工编辑 + 重启 console 不需要，settings 每请求读）

## 7. 真机验证路径（Step 3）

优先级：
1. 若 250 上**有次日未发布的计划格** → 用控制台单篇发布（走真实链路）
2. 否则 `bun src/cli.ts cover -a gaoh --date <date> --ai`（只出封面，不动草稿）
   —— 这只能验出图，验不到 `draft cover set ✓`；此时用 250 上最近一次
   `job_logs` 的 `draft#` 记录作对照，并在报告里写明"未走全链路"

证据口径（AC5）：`journalctl -u wechat-console | grep cover-ai` +
`sqlite3 console.db "select … from job_logs where message like '%cover%'"` +
`ls -l data/gaoh/imgs/<date>/cover-raw.png`

## 8. 兼容与回滚

- 工具是**加法**：不跑它，生产行为 100% 不变
- `src/cover-ai.ts` 的 `export` 变更对运行时无影响（`bun build src/cli.ts` 闸门兜底）
- 配置回滚一条命令；无 DB schema 变更、无迁移、无新依赖
