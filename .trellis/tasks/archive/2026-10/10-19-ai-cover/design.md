# Design — AI 封面（900×383）

## 1. 核心不变量

> **AI 决定「画什么 / 什么颜色」，代码决定「多大 / 放哪 / 存哪 / 兜底」。**

这条决定了整条链路必须在**任何一步失败**时都能退回已知可用的确定性封面，
并且落盘路径恒为 `data/<alias>/imgs/<date>/cover.png`（`setDraftCover` 的唯一契约）。

## 2. 流水线（四段式）

```
article .md (title + 正文)
   │
   ├─① 摘要（AI，文本模型 workbuddy/cn:deepseek-v4.1-flash，~5-15s）
   │     prompts/cover.md + {{title}} {{module}} {{body_excerpt}}
   │     → 严格 JSON：{ "subject", "palette":[hex..], "motif", "mood", "avoid":[…] }
   │     → 落盘 imgs/<date>/cover-brief.json（可审计 / 可复算）
   │
   ├─② 拼 prompt（代码，纯确定性）
   │     style 模板（账号级 cover.ai.style） + 简报字段 + 硬约束（无文字/主体居中/宽幅留白）
   │
   ├─③ 出图（图像模型，POST /v1/images/generations）
   │     model 链：cn:hunyuan-image-alpha-edit → global:gpt-image-2.5-sunburst
   │     → b64_json → imgs/<date>/cover-raw.png
   │
   └─④ 后处理（代码，确定性）
         scale(cover) 到铺满 → center-crop → **恰好 900×383**
         （可选 overlayTitle=false 默认关）
         → imgs/<date>/cover.png
```

**失败矩阵**

| 失败点 | 行为 |
|---|---|
| ① 摘要失败/JSON 解析失败 | 用确定性兜底简报（topic 关键词 + 账号 `fallbackPalette`）继续 ③ |
| ③ 主模型失败 | 换 fallback 模型（换一个上游实现）；都失败 → 降级 ④' |
| ④' 全 AI 失败 | `generateFfmpegCover`（900×383）→ 失败再 `generateTemplateCover` |
| 任何一步抛异常 | `publish` 捕获 → `log.warn` + 继续发布（**封面永不阻断**） |

## 3. 模块边界

### 新增 `src/cover-ai.ts`（唯一新增文件）

```ts
export interface CoverBrief { subject: string; palette: string[]; motif: string; mood: string; avoid?: string[] }
export interface AiCoverInput {
  brief: CoverBrief; prompt: string; size: string; style: string;
}
export interface AiCoverOpts {
  model: string; fallbacks?: string[]; timeoutSec?: number;
  gateway?: string; apiKey?: string;               // 空 → 三级解析
  rawPath: string; outPath: string; size?: string; // "900x383"
  overlayTitle?: boolean; title?: string; subtitle?: string; font?: string;
}
export async function resolveImageGateway(cfg): Promise<{ baseUrl: string; apiKey: string; source: string }>
export function normalizeImageModelId(id: string): string   // workbuddy/cn:x → cn:x
export async function summarizeCoverBrief(cfg, input): Promise<{ brief: CoverBrief; ok: boolean; reason?: string }>
export async function generateAiCover(cfg, opts): Promise<{ ok: true; model: string } | { ok: false; reason: string }>
export async function listImageModels(cfg): Promise<string[] | null>  // doctor 用
```

设计约束：
- **不 import `node:child_process` 做 HTTP**，用 `fetch`（bun 内置）；
- 后处理复用 `cover.ts` 里已有的 ffmpeg/convert 探测思路，抽成 `fitImageTo(outPath, size)`；
- 所有网络调用带 `AbortSignal.timeout()`，不用 `retry` 库。

### 改造 `src/cover.ts`

- `CoverInput` 增 `size?: string`，默认 `"900x383"`；`generateFfmpegCover` / `generateTemplateCover` 的
  lavfi `gradients=size=` 与 `-size` 全部改为参数化（**同时修掉 `drawbox`/`annotate` 里硬编码的坐标**）。
- 新增 `fitImageTo(src, outPath, size)`：`scale=w:h:force_original_aspect_ratio=increase,crop=w:h`，
  ffmpeg 缺失时回落 `convert -resize WxH^ -gravity center -extent WxH`。

### 改造 `src/publisher.ts`

封面段落改成一条显式降级链（保持"永不阻断"）：

```ts
if (!(reuse && exists(coverPath))) {
  const okAi = mode === "ai" && await tryAiCover(cfg, { title, summary, body: md, date, coverPath });
  if (!okAi) { ffmpeg → template }
}
```

### 改造 `src/config.ts`

```jsonc
"cover": {
  "mode": "template|ffmpeg|agent|ai",
  "size": "900x383",
  "font": "...",
  "uploadToDraft": true,
  "ai": {
    "model": "cn:hunyuan-image-alpha-edit",
    "fallbacks": ["global:gpt-image-2.5-sunburst"],
    "summaryModel": "",              // 空 → 继承 model.article.model
    "gateway": "",                   // 空 → env → pi models.json
    "apiKey": "",
    "style": "扁平矢量插画，几何极简，教育科技感，构图简洁留白大",
    "fallbackPalette": ["#0F4C81", "#2D8AE0"],
    "overlayTitle": false,
    "timeoutSec": 120,
    "maxTotalSec": 300
  }
}
```

按叶子回退（与现有 `cover.mode` / `uploadToDraft` 同样的语义）：
账号级 `cover.ai` 缺字段时继承全局，**不会因为账号只写 `mode` 就把 AI 配置清空**。

## 4. 网关凭据解析（三级，命中即用）

| 顺序 | 来源 | 说明 |
|---|---|---|
| 1 | `cover.ai.gateway` + `cover.ai.apiKey` | 显式配置优先（可指向别的网关） |
| 2 | env `COVER_IMAGE_BASE_URL` / `COVER_IMAGE_API_KEY` | 便于 250 覆盖，不入库 |
| 3 | `$HOME/.pi/agent/models.json` 的 `providers.meta-gateway` | 零配置默认，复用已有 key |

解析失败 → `log.warn` + 降级（不是抛错）。

## 5. 模型 id 归一化（真机踩坑）

网关 images 端点要**裸 id**（`<group>:<model>`），不是 pi 的 `provider/model`：

| 写法 | 实测 |
|---|---|
| `cn:hunyuan-image-alpha-edit` | ✅ 200 |
| `global:gpt-image-2.5-sunburst` | ✅ 200（35s） |
| `workbuddy/cn:hunyuan-image-alpha-edit` | ❌ 404 `openai_error` |
| `hunyuan-image-alpha-edit` | ❌ 503 `No available channel` |

`normalizeImageModelId()`：若含 `/`，取最后一个 `/` 之后的段；否则原样返回。
配置里两种写法都能写，程序归一化，`doctor` 打印归一化后的 id。

## 6. 尺寸与裁切

- 目标 **900×383**，模型输出不保证精确：实测 `900x383` 请求回来是 **896×368**，
  `1536x1024` 回来是 1536×1024。→ **请求尺寸只是提示，最终必须代码裁切**。
- 后处理：`scale=900:383:force_original_aspect_ratio=increase` → `crop=900:383`（居中）。
- 小图 200×200 由微信自动从中心裁 → prompt 硬约束「主体居中、四周留白、不要贴边」。

## 7. Prompt 契约（`prompts/cover.md` + 代码拼接）

摘要提示词**只输出 JSON**，包含字段与取值约束（palette 必须是 3 个 hex、subject 一句话、motif 英文短语）。
出图提示词由代码拼：

```
{style}。主题：{subject}。意象：{motif}。氛围：{mood}。
主色：{palette.join("、")}。
构图：宽幅 2.35:1，主体居中，四周留白 ≥10%，不要贴边。
禁止：任何文字、字母、数字、水印、logo、人物正脸。
```

「禁止数字」很重要：hunyuan 默认会在坐标轴上画 `-2 -1 1 2`，虽不致命但在中文教学封面上显得杂乱。

## 8. 可观测性

- `log.info`：`cover-ai: brief=<json 摘要>`、`cover-ai: model=cn:hunyuan... 21.3s`、`cover-ai: 900x383 ok`
- 降级：`log.warn` + `publish` 的 notify 里带一行 `封面：AI 失败，已回落渐变（原因）`
- 产物保留：`cover-raw.png`（模型原图，供排查）+ `cover-brief.json` + 最终 `cover.png`
- `doctor` 新增 `cover-model` 行：解析网关 → `GET /v1/models` → 断言配置里的图像模型存在

## 9. 兼容与回滚

- `cover.mode` 默认仍是 `template`，**新能力 opt-in**；250 账号逐个切换（先 gaoh，观察 2 天再切 second）
- 回滚：`cover.mode` 改回 `ffmpeg` 即可，无数据迁移
- 尺寸从 900×500 → 900×383 是**全局行为变更**，需在 250 复查 `setDraftCover` 仍能上传（AC7）
