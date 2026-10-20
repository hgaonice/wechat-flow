# 执行计划

顺序执行 1 → 2 → 3（用户指定）。**Step 1 结束处有 GATE：用户先看封面是否可行**。

## Step 1 多模型同题对比（产出给用户看）

- [x] 1.1 `src/cover-ai.ts`：`async function generateOneImage` → `export async function generateOneImage`
      （零行为变更；验证：`bun x tsc --noEmit`）
- [x] 1.2 新建 `tools/cover-compare.ts`
      - 常量 4 个真实标题（几何 / 抛物线最值 / 函数图象 / 统计图表）
      - brief 一律 `fallbackBrief(title, palette)`（design §3）
      - 每 (brief × model)：`generateOneImage`（失败按 `isSizeRejection` 放大 `1536x1024` 重试一次）
        → 写 `raw/` → `fitImageTo → fit/900x383`
      - 模型默认：`cn:hunyuan-image-alpha-edit,cogview-4,cogview-4-250304,global:gpt-image-2.5-sunburst`
      - 若环境无 `OPENROUTER_API_KEY` → matrix 追加 `skipped` 行（AC2），不失败
      - 拼图：python3 + Pillow（缺失 → ffmpeg vstack 兜底 + summary 显式标注）
      - `matrix.json` / `summary.txt` / 退出码 0|1|3（design §5）
      - 验证：`bun x tsc --noEmit`；`bun tools/cover-compare.ts --models cogview-4 --titles 1`
        （单模型单题冒烟，确认产物结构）
- [x] 1.3 全量跑：4 brief × 4 model（gpt-image-2.5 预计每张 ~74s，总耗时预算 ≤ 12 分钟）
- [x] 1.4 自检：`matrix.json` 每 fail 行有非空 reason；`compare-*.png` 4 张；`fit/*.png` 尺寸全为 900x383
- [x] 1.4a 实测发现：`cogview-4` / `cogview-4-250304` → `http 429 余额不足或无可用资源包`
      （智谱账号无额度，证据 `data/research/cover-compare-2026-10-20/cogview-429.txt`）
      ⇒ 网关内**可用图像模型只剩 2 个**：hunyuan / gpt-image-2.5-sunburst
- [x] 1.5 **GATE-1**（已完成，用户选 A）：把 `compare-*.png` 与 `summary.txt` 交给用户 → 用户拍板胜者（或"都不达标"）

## Step 2 择优接入

- [x] 2.1 按 GATE-1 结论改 250 `config.json` → `cover.ai.model` / `fallbacks`（design §6）
- [x] 2.2 `bun src/cli.ts doctor` 检查 `cover-model` / `cover-candidates` 两行（AC4）
- [x] 2.3 若胜者是新模型：`docs/`（封面章节）+ `AGENT.md` 补记"为什么换、什么时候换的"

## Step 3 250 真机验证

- [x] 3.1 优先走真实发布（有次日计划格时）；否则 `bun src/cli.ts cover -a gaoh --date <date> --ai` 并说明未走全链路（design §7）
- [x] 3.2 证据：`journalctl -u wechat-console | grep cover-ai`（含 `model=<胜者>`）、
      `draft cover set ✓`（或显式 ffmpeg 降级原因）、`ls -l data/gaoh/imgs/<date>/cover-raw.png`
- [x] 3.3 闸门：`bash tools/ui-gates.sh --strict` → 7 passed / 0 failed；`bun x tsc --noEmit`
- [x] 3.4 写 `report.md`（含 AC1–AC6 逐条证据、偏差、回滚路径）

## 执行结果（2026-10-20）

- GATE-1：用户选 **A** → `cover.ai.model = global:gpt-image-2.5-sunburst`，`fallbacks = [cn:hunyuan-image-alpha-edit]`
- 真机：`cover -a gaoh --date 2026-10-21 --ai --upload` → `model=global:gpt-image-2.5-sunburst 71.7s b64=774308B → 900x383`
  + `draft cover set ✓ (before=… → after=…)`；`cover-raw.png` 580730B / `cover.png` 267110B(900×383)
- 偏差：非 `publish` 全链路（10-21 草稿已存在，只重设封面），详见 `report.md` §3
- 闸门：`ui-gates.sh --strict` 7 passed / 0 failed
- 详见 `report.md`（含 gpt-image-2.5 来源取证：OpenAI 模型 / TokenHub 中转 / 自建 New API 网关）

## 回滚点

| 步骤后 | 回滚动作 |
|---|---|
| 1.x | 删 `tools/cover-compare.ts` + 撤销 `export`，生产零影响 |
| 2.x | 250 `cover.ai.model` 改回 `cn:hunyuan-image-alpha-edit`（settings 每请求读，无需重启） |

## 验证命令速查

```bash
bun x tsc --noEmit
bun tools/cover-compare.ts --models cogview-4 --titles 1
bun src/cli.ts doctor
bash tools/ui-gates.sh --strict
ssh root@192.168.0.250 'journalctl -u wechat-console --since "-10min" | grep -E "cover-ai|cover:"'
```
