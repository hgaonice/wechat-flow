# 图像模型选型矩阵与外部免费源清单

> 生成日期：2026-10-20 · 任务：`.trellis/tasks/10-20-image-model-scout`（C2）
> 全部网关内数据来自**真实出图**（同一份简报、同一台 250），命令与原始报告可复读：
> `data/research/image-models-2026-10-20.json` · 样张 `data/research/samples/`
> **本文档不含任何"据说/应该可用"**；未实测的一律标注「未实测（待放行）」。

---

## §A 网关内实测矩阵（已出图）

网关：`meta-gateway` → `http://192.168.0.251:3011/v1`（250 上解析自 `~/.pi/agent/models.json`）
简报：`data/gaoh/imgs/2026-10-20/cover-brief.json`（抛物线 / 深底 `#0C1327` / 强调 `#FFC24B` / 禁文字）
探测命令：`bun tools/image-model-probe.ts --models <ids> --size <size> --brief <brief>`

> 证据位置：原始报告与样张落在 **250 的 `data/research/`**（`data/` 已 gitignore，不进仓库），
> 所以本页数字只能回到 250 上复读；仓库里没有可离线核对的 JSON 副本。
> 2026-10-20 复核（开发容器直连同一网关 `127.0.0.1:3011`）：`global:gpt-image-2.5-sunburst`
> `1536x1024` → **200 / 31.5s / 330098B / 4-4 pass**，样张人工目视：深底 + 抛物线 + 金色顶点，**无文字/无数字**
> （延迟比 250 当次的 23.7–25.3s 更慢 → 该列是「当次实测区间」，不是 SLA）。

| 模型 | 可用 | 实测延迟 | 实际返回尺寸 | 结构分 | 配色符合 | 图上文字/水印 | 结论 |
|---|---|---|---|---|---|---|---|
| `cn:hunyuan-image-alpha-edit` | ✅ 200 | **8.8–14.5s**（1536×1024）／11.0s（900×383） | 896×368（吸附）· 1536×1024 | 4/4 | 符合 | 无 | **主力** |
| `global:gpt-image-2.5-sunburst` | ⚠️ 有条件 | 23.7–25.3s（1536×1024） | 1536×1024 | 4/4 | 符合 | 无 | **兜底**（必须先放大尺寸请求） |
| `cogview-3-flash` | ✅ 200 | **9.5–9.9s**（1024×1024） | 1024×1024 | 3/4（配色不过） | **忽略**配色，全灰 | **右下角 "AI生成" 水印** | **淘汰**（水印=硬伤） |
| `cogview-4` | ❌ 429 | 114s 才失败 | — | — | — | — | 不可用（无额度） |
| `cogview-4-250304` | ❌ 429 | 114s 才失败 | — | — | — | — | 不可用（无额度，与上同源） |

镜像 id（`workbuddy/cn:hunyuan-image-alpha-edit`、`workbuddy/global:gpt-image-2.5-sunburst`）与上表前两行**同源**，不重复实测。

### §A.1 关键发现（比选型本身更重要）

1. **`gpt-image-2.5` 作为第二级 AI 降级，在生产里一直是死的。**
   - 它拒绝封面尺寸：`900x383` → `invalid_value: Invalid size '900x383'. Width and height must both be divisible by 16.`
   - 连 `896x368`（已满足 /16）也拒：`Requested resolution is below the current minimum pixel budget.`
   - 只在 `1024x1024` / `1536x1024` 成功（21.5s / 18.7s，直接 API 实测）。
   - 因为主力 `hunyuan` 基本都成功，这条死链从未暴露；一旦 hunyuan 抽风，实际降级是 **直接跳到 ffmpeg**。
   - **已修**：`src/cover-ai.ts` 新增 `isSizeRejection()` + `SIZE_ESCALATION="1536x1024"`，命中尺寸类拒绝时自动放大请求、再由 `fitImageTo()` 确定性裁回 900×383。真机验证：`rejected size 900x383 → retrying at 1536x1024 → 900x383 ✓`（74.3s，含两次请求）。
2. **`cogview-3-flash` 虽快且"免费"，但不能用作封面**：忽略简报配色（全灰），且右下角烧进 "AI生成" 水印 —— 封面是公众号门面，水印/文字是硬性淘汰项。
3. **`cogview-4` 系在本网关无额度**（`429 余额不足或无可用资源包`），且失败要等 **114s**；作为降级链成员只会拖长发布窗口 → 不接入。
4. **`listImageModels()` 曾漏报 cogview**（正则不含 `cogview`），doctor 会少报模型；已补 `cogview|kolors|hunyuan-image|sd3|sdxl`，现报 `7 image models`（5 个唯一模型 + 2 个镜像）。
5. **结构分阈值踩过一个坑**：`darkBgMax` 原设 0.95（后 0.995）会把「留白大」的合格封面判不合格（实测 darkRatio 0.978 / 0.998 / 0.999）。已改为**只设下界**（缺主体由 `not-blank` + `accentMinRatio` 兜住），并把 `metrics` 写进报告，任何人可复判。

### §A.2 自动分能判什么、不能判什么

自动（`scoreImageStructure`）：尺寸归一 / 非空白 / 深底+强调色可用 / 非占位图。
**不能判**：错字、乱码、多余数字、构图好坏 —— 这些只能人眼（本页 §D 记录人工目视结论）。
不要把 4/4 当成"好看"，它只说明"能当封面用"。

---

## §B 外部免费/可用源清单（**均未实测**，每条需用户放行）

> Q3 决策：先交付清单 + 验证步骤，逐个放行后再实测接入。
> 「注册/信用卡/商用」按官方文档标注，**以官方页面为准**（可能随时调整）。

| 来源 | 代表模型 | 免费额度（按官方文档） | 需注册 | 需信用卡 | 商用 | 250 直连 | 官方文档 |
|---|---|---|---|---|---|---|---|
| 智谱 BigModel | `cogview-3-flash`（免费档） | 该模型当前免费（平台侧政策） | 是 | 否 | 需遵守平台条款 | 未实测 | https://docs.bigmodel.cn/cn/guide/models/image-generation/cogview-3-flash |
| Cloudflare Workers AI | `flux-1-schnell`、`stable-diffusion-xl` | 每日免费 Neurons 额度（约 1 万 Neurons/天） | 是 | 免费档不需 | 允许（受 AUP） | 未实测 | https://developers.cloudflare.com/workers-ai/models/ |
| SiliconFlow 硅基流动 | `Kolors`、`FLUX.1-schnell` | 部分模型限时免费 / 新用户赠额 | 是 | 否 | 按模型许可 | 未实测 | https://docs.siliconflow.cn/cn/userguide/models/model-list |
| ModelScope 魔搭 | 社区生图模型 API-Inference | 每模型每日调用配额（文档为准） | 是 | 否 | 按模型许可 | 未实测 | https://modelscope.cn/docs/model-service/API-Inference/intro |
| Google Gemini | `gemini-2.5-flash-image`（nano banana） | 免费层有速率限制（RPM/RPD，按官方） | 是 | 否（免费层） | 需遵守条款 | 预计需代理（未实测） | https://ai.google.dev/gemini-api/docs/image-generation |
| Pollinations | `flux`、`turbo` | 公开免费、官方 README 当前称无需 key（可能要求 referrer/token，以页面为准） | 否 | 否 | 需注明来源 | 未实测 | https://github.com/pollinations/pollinations |
| Hugging Face Inference Providers | `FLUX.1-schnell` 等 | 免费层有月度额度 | 是 | 否 | 按模型许可 | 预计需代理（未实测） | https://huggingface.co/docs/inference-providers |

> `250 直连` 一列**没有任何一条实测过**（Q3：待用户逐个放行）；写「未实测」而不是「可」，
> 因为出网可达性只能由 250 上的 `curl` 证明，不能由国内网络常识推断。

### §B.1 每个候选的验证命令（两条）

通用形态（把 `<BASE>`/`<KEY>`/`<MODEL>` 换成上表对应值）：

```bash
# 1) 模型是否在你的账号下可见
curl -sS -H "Authorization: Bearer $KEY" "<BASE>/models" | head -c 400

# 2) 出图是否真的能拿到字节（不解析、只看状态与体积）
curl -sS -o /tmp/probe.png -w "%{http_code} %{size_download}B %{time_total}s\n" \
  -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"model":"<MODEL>","prompt":"flat vector illustration, dark navy background, one geometric motif, no text","n":1,"size":"1024x1024"}' \
  "<BASE>/images/generations"
```

Pollinations（无需 key）：

```bash
curl -sS -o /tmp/poll.png -w "%{http_code} %{size_download}B %{time_total}s\n" \
  "https://image.pollinations.ai/prompt/flat%20vector%20illustration%20dark%20navy%20one%20motif?width=1536&height=1024&nologo=true"
```

Cloudflare Workers AI（要求 JSON base64 响应，注意 `-d` 形态与上不同）：

```bash
curl -sS -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/ai/run/@cf/black-forest-labs/flux-1-schnell" \
  -H "Authorization: Bearer $CF_TOKEN" -H "content-type: application/json" \
  -d '{"prompt":"flat vector illustration, dark navy, one motif, no text","steps":4}' | head -c 200
```

> **放行后的实测方式**：把 `COVER_IMAGE_BASE_URL` / `COVER_IMAGE_API_KEY` 指到该源，或写进 `config.json cover.ai.gateway/apiKey`，然后跑
> `bun tools/image-model-probe.ts --models <model> --size 1536x1024 --brief data/gaoh/imgs/<date>/cover-brief.json`
> —— 直接得到延迟/尺寸/结构分，再与本页 §A 的网关内结果同表比较。

### §B.2 排序建议（如要逐个放行）

1. **Pollinations**（零注册零 key，最适合先验证"外部源这条路通不通"；风险是可用性不稳定 + 需注明来源）
2. **智谱 CogView-3-Flash 官方直连**（网关里已证明可出图 9.5s；直连可绕开网关额度；但仍需人眼确认水印是否存在——网关版有 "AI生成" 水印，官方版是否相同未实测）
3. **Cloudflare Workers AI FLUX-schnell**（免费额度明确、无信用卡；FLUX 对"扁平矢量"风格通常表现好）
4. **SiliconFlow / ModelScope**（国内直连、有免费模型；需逐个核对模型许可与配额）
5. **Gemini flash-image**（质量好但 250 需代理，且免费层限速；作为"人工补图"工具而非日更主力）

---

## §C 结论：生产链路建议

| 档位 | 建议 | 理由 |
|---|---|---|
| **主力** | `cn:hunyuan-image-alpha-edit`（保持不变） | 最快（8.8–14.5s）、配色符合、无文字水印；连续多日真机封面目视合格 |
| **兜底** | `global:gpt-image-2.5-sunburst`（**依赖尺寸放大重试**） | 出图质量可接受、无文字；但只在 ≥1024 像素预算时可用，已由 `SIZE_ESCALATION` 自动处理；耗时 24–74s，属于"能用但慢" |
| **备用（不接入）** | `cogview-*` | 3-flash 有水印且忽略配色；4 系无额度且失败耗时 114s |
| **确定性最终兜底** | `ffmpeg` → `template` | 不变；封面失败绝不阻断正文 |

**生产不动的部分**：`cover.ai.model/fallbacks` 维持现状（hunyuan → gpt-image-2.5），因为本次修的是"兜底为什么从来没生效"（尺寸），而不是"该换谁"。

---

## §D 人工目视记录

| 日期 | 模型 | 结论 | 记录人 |
|---|---|---|---|
| 2026-10-20 | `global:gpt-image-2.5-sunburst`（1536×1024 → 裁切） | 抛物线 + 顶点水平切线 + 两侧虚线区间，深底 + 金色强调，**无文字/无数字/无乱码**；构图契合"留白大"要求 | pi（待用户复核） |
| 2026-10-20 | `cogview-3-flash` | 全灰阶几何图，右下角 **"AI生成" 水印**；无强调色 | pi |
| 2026-10-20 | `cn:hunyuan-image-alpha-edit` | 与简报一致的深底 + 强调色，无文字 | pi |

> AC5 要求「至少 1 张真机封面人工目视认可」：2026-10-20 用真草稿封面复核后在此补一行。

---

## §E 复读方式（任何人可重跑）

```bash
# 全量枚举（含镜像去重）
bun tools/image-model-probe.ts --all-image --brief data/gaoh/imgs/<date>/cover-brief.json --out-dir data/research

# 指定模型（推荐按模型原生尺寸，避免"尺寸拒绝"污染结论）
bun tools/image-model-probe.ts --models cn:hunyuan-image-alpha-edit,global:gpt-image-2.5-sunburst \
  --size 1536x1024 --brief data/gaoh/imgs/<date>/cover-brief.json
bun tools/image-model-probe.ts --models cogview-3-flash --size 1024x1024 --brief ... 

# 报告字段：ok/status/returnedSize/snapped/totalMs/bytes/pngPath/sha256/reason/score.metrics

# 退出码：0 = 至少一个模型 ok；1 = 操作性错误（网关/简报/模型/目录）；
#         3 = 报告已生成但**所有模型都失败**（失败是数据，全失败是告警，不要当 0 用）
```
