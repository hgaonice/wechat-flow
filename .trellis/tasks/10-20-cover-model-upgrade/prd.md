# 封面模型升级：多模型同题对比 → 择优接入 → 真机验证

## 背景（事实，非推测）

- 生产封面走 `cover.ai.model = cn:hunyuan-image-alpha-edit`（网关 `192.168.0.251:3011`），
  250 真机唯一一次 AI 出图：`cover-ai: model=cn:hunyuan-image-alpha-edit 9.7s b64=110784B → 900x383`。
- **用户判定混元出图不达标**（本任务唯一驱动）。
- 2026-10-20 网络调研（本仓库实测，非传闻）结论：
  - `gpt-image-2.5` **无任何免费渠道**（OpenRouter 470 模型里图像输出 12 个、`:free` 0 个；
    Google Nano Banana 2.1 / 3.1 Flash Image 的 Free Tier = `Not available`；
    HF Inference Free 用户额度 = None）。
  - 免费且无水印的只有 Cloudflare Workers AI `flux-1-schnell`（10k neurons/天 ≈ 173 张/天），
    但需 CF account id + token，且质量未知。
  - 现有网关内可直接 A/B 的候选：`cogview-4`、`cogview-4-250304`（均为计费、无水印），
  - `cogview-3-flash` 已因水印淘汰（C2 结论），不参与。
- 因此本任务**不动网关、不引新 provider**，先在现有网关内做同题对比择优；nano-banana 需
  OpenRouter key，缺 key 时**跳过并显式标注 skipped**（不静默）。

## 目标

1. 用**同一份 brief / 同一个 prompt / 同一裁切规则**，让 4 个候选模型各出同题封面，
   产出可直接目视对比的拼图，由用户拍板"封面是否可行、选谁"。
2. 胜者接进 `cover.ai.model`（失败链 `cogview-4 → global:gpt-image-2.5-sunburst` 等），
   **保留四级降级** `AI → ffmpeg → template` 与"封面失败绝不阻断发布"铁律。
3. 250 真机发一篇，`cover-raw.png` 与 `draft cover set ✓` 双证据闭环。

## 范围

**做**
- 一次性对比工具（`tools/`，产物落 `data/research/`，不进 `src/`、不进发布链）
- 对比图（每 brief 一张纵向拼图：4 行 × 900×383 + 模型标签）
- 择优后的配置变更（250 `config.json` 的 `cover.ai`）+ 文档更新
- 250 真机单篇验证

**不做**
- 不改 `fitImageTo` / `verifyDraftBody` / 发布链其他环节
- 不新增 npm 依赖（对比图用系统 `python3 -c "import PIL"`，已在用；ffmpeg 已有）
- 不接 CF Workers AI / OpenRouter（无凭据；作为后续任务，PRD 只记录数据）
- 不改 `second` 账号（它仍是 `mode=ffmpeg`，不属于本任务）

## 候选与判定口径

| 模型 id | 来源 | 已知特性 |
|---|---|---|
| `cn:hunyuan-image-alpha-edit` | 网关 | 现役基线，用户判定不达标 |
| `cogview-4` | 网关 | 计费，无水印（C2：不淘汰但当时未接入） |
| `cogview-4-250304` | 网关 | 同上，快照版 |
| `global:gpt-image-2.5-sunburst` | 网关 | 现兜底；只收 ≥1024 且边长 ÷16，900×383 必被拒 → 自动放大 1536×1024 重试（实测 ~74s） |
| `google/gemini-nano-banana-2.1`（OpenRouter） | 缺 key | 若用户补 key 则加入第五列，否则记 `skipped: no key` |

判定：**人工目视**（用户）为准；脚本只提供结构分（复用 `image-model-probe.ts` 的结构分口径）
与耗时/尺寸/是否触发放大作为客观辅助。

## 验收标准

- **AC1**：`data/research/cover-compare-<date>/` 下产出，含
  - 每个候选 × 每个 brief 的 raw 原图与 900×383 裁切图，文件名含模型与 brief 短 id
  - 每 brief 一张 `compare-<briefId>.png`（4/5 行纵向拼图，行首为模型 id）
  - `matrix.json`：每行 `{model, briefId, ok, ms, rawSize, finalSize, escalated, reason?, sha256}`
  - **任何失败行都有非空 `reason`**，且脚本退出码能区分"全失败"（≠0）与"有可用行"（0）
- **AC2**：`cogview-3-flash` 不出现；nano-banana 若缺 key 则 matrix 中出现
  `{"model": "google/gemini-nano-banana-2.1", "skipped": "no OPENROUTER_API_KEY"}` 一行
- **AC3**：用户目视后明确选定胜者（或判定"都不达标"，则本任务以"不接入、记录结论"收尾）
- **AC4**：接入后 `bun src/cli.ts doctor` 的 `cover-model` 与 `cover-candidates` 两行反映新链
  （主模型 = 胜者，链里仍含 `gpt-image-2.5-sunburst` 与 ffmpeg 兜底）
- **AC5**：250 真机一篇：日志出现 `cover-ai: model=<胜者>` + `draft cover set ✓`，
  且 `data/<alias>/imgs/<date>/cover-raw.png` 存在；若 AI 全失败，则必须看到
  `cover generated via ffmpeg` + `cover: AI 全部失败` 类显式原因（不是静默）
- **AC6**：`ui` / `engine` 既有闸门不回归：`bash tools/ui-gates.sh --strict`（含 `tsc --noEmit`
  + `bun build src/cli.ts`）仍 7 passed / 0 failed

## 人工确认门（GATE）

- **G1**：AC3 的胜者选择必须由用户拍板（助手只出对比图与客观数据）
- **G2**：AC5 真机发布前，用户确认"封面可行"（即本任务第 1 步产出先给用户看）

## 风险

- `cogview-4` 可能对 `900x383` 也报尺寸错误 → 脚本必须复用生产链的
  `isSizeRejection` + `SIZE_ESCALATION` 逻辑，而不是自己发明重试
- 出图可能**带文字/水印**：判定时必须记录（这是用户淘汰 3-flash 的唯一原因）
- 对比图里模型标签必须 ASCII（避免中文字体缺失导致拼图乱码）
