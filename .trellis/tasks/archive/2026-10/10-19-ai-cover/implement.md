# Implement — AI 封面（900×383）

## 0. 前置

- 250 真机：`root@192.168.0.250`，仓库 `/root/wechat-flow`，bun 在 `/root/.nvm/versions/node/v24.14.1/bin`
- 网关 key（已在 `~/.pi/agent/models.json` → `providers.meta-gateway.apiKey`）
- 备份即将改动的配置：`GET /api/settings` 存 `backups/settings-<ts>.json`

## S1 — 尺寸参数化（先把 900×500 全部换成 900×383）

- [x] `src/cover.ts`：`CoverInput.size?: string`（默认 `"900x383"`）
- [x] `generateFfmpegCover`：`gradients=size=<size>`；`drawbox` / `drawtext` 的坐标按宽高比例算，不写死
- [x] `generateTemplateCover`：`-size <size>`，`rectangle` / `annotate` 偏移按比例
- [x] 新增 `fitImageTo(src, outPath, size)`（ffmpeg → convert 双路）
- [x] 新增 `parseSize(s): {w,h}`

验证：`bun -e` 直接调两个生成器，`identify` 断言 900×383。

## S2 — `src/cover-ai.ts` 新增

- [x] `resolveImageGateway(cfg)`：配置 → env → `~/.pi/agent/models.json`（`providers.meta-gateway`）
- [x] `normalizeImageModelId(id)`：`workbuddy/cn:x` → `cn:x`
- [x] `summarizeCoverBrief(cfg, {title, module, excerpt})`：`runPi` + `prompts/cover.md`，宽松解析 JSON（首个 `{...}`），失败返回确定性兜底简报
- [x] `buildImagePrompt(brief, style)`：拼 prompt（含「禁止文字/字母/数字」硬约束）
- [x] `generateAiCover(cfg, opts)`：
  - 逐模型 `POST /v1/images/generations`，`AbortSignal.timeout(timeoutSec)`
  - `b64_json` → `cover-raw.png` → `fitImageTo(...)` → `cover.png`（恰好 900×383）
  - 返回 `{ok:true, model}` / `{ok:false, reason}`，**不抛异常给调用方**
- [x] `listImageModels(cfg)`：`GET /v1/models` 过滤，供 doctor / selftest

## S3 — 配置接线

- [x] `src/config.ts`：`cover.size`、`cover.ai.*`（含 `style`/`fallbackPalette`/`overlayTitle`/`timeoutSec`/`maxTotalSec`），按叶子回退
- [x] `config.example.json` 同步
- [x] `src/publisher.ts`：`mode === "ai"` 时走 `generateAiCover` → 失败回落 `generateFfmpegCover` → 再失败 `generateTemplateCover`；全程 try/catch，`log.warn` 不阻断
- [x] `cover-brief.json` 落盘到 `imgs/<date>/`

## S4 — 运维可观测

- [x] `src/cli.ts#doctor`：新增 `cover-model` 行（解析网关 → 列模型 → 断言 `cover.ai.model` 与 fallbacks 存在）
- [x] `src/cli.ts` 新增 `cover --ai <date>`：只重跑封面（不跑文章），用于补救
- [x] 日志：`cover-ai: model=... <ms>`、`cover-ai: 降级 <reason>`

## S5 — Prompt 资产

- [x] `prompts/cover.md`：只输出 JSON 的摘要提示词（subject / palette(3×hex) / motif / mood / avoid）
- [x] 约束里明确「从正文提取视觉意象，不要复述标题」

## S6 — 自测 `tools/cover-selftest.ts`

- [x] `parseSize` / `fitImageTo` 尺寸断言（本地生成色块图，不联网）
- [x] `normalizeImageModelId` 4 组（裸 id / `workbuddy/` 前缀 / 无 group / 空）
- [x] 简报 JSON 宽松解析 5 组（纯 JSON / 带 ```json 围栏 / 前后有废话 / 缺字段 / 非法 JSON→兜底）
- [x] 失败降级：坏 baseUrl、坏 model id → `{ok:false}` 且不抛
- [x] 幂等：`cover.png` 已存在 + reuse → 不调用网络（用计数器注入）

## S7 — 验收

- [x] `npx tsc --noEmit` 0 错
- [x] `bun build --target=bun src/cli.ts` 通过
- [x] 250 部署：`./deploy/deploy.sh --keep-remote-content`（改 src 后必须 `systemctl restart wechat-console`）
- [x] 250 `doctor --all` 全绿（含 `cover-model` 行）
- [x] 250 实跑：`bun src/cli.ts cover --ai 2026-10-20` → `identify` 断言 900×383，人工看图确认与文章匹配
- [x] 250 实跑一篇文章（`publish -a gaoh --date <next> --dry-run`）确认封面来自 AI、日志无降级
- [x] AC4 故障注入：把 `cover.ai.model` 临时改为 `cn:not-a-model` → 断言 fallback 命中；再改坏 `gateway` → 断言回落 ffmpeg 且**文章照常发布**

## S8 — 文档与收尾

- [x] `.trellis/spec/engine/ai-determinism.md`：补「AI 只产内容，尺寸/裁切/路径由代码定」的封面条目
- [x] `.trellis/spec/engine/error-handling.md`：补封面降级链与故障模式 E3
- [x] `deploy/console-scheduler.md` 不需要改（封面不涉及调度）
- [x] `AGENT.md`：任务地图 + 变更日志
- [x] git commit（单 PR），任务归档

## 关键风险点（执行时注意）

1. **别改 `setDraftCover`** —— 它只吃 `cover.png`，尺寸变化后需真机复验（AC7）。
2. **别把「请求 900×383」当结果** —— 实测回 896×368，必须代码裁切。
3. **摘要 prompt 必须只出 JSON** —— 否则解析失败率高；解析器要宽松且能兜底。
4. **出图很慢（15–35s）**，超时给足但要有上限；两个模型总预算 ≤300s。
5. **不要在 `cover.ts` 里塞 HTTP** —— 保持它纯本地渲染，AI 逻辑全在 `cover-ai.ts`。

---

## 执行结果（2026-10-19/20，全程 250 真机）

| 项 | 证据 |
| --- | --- |
| AC1 尺寸精确 900×383 | `cover --ai 2026-10-20` → 日志 `b64=111992B → 900x383`；读文件头 `cover.png (900, 383)`。模版/ffmpeg 兜底同样 900×383（`cover generated via ffmpeg (900x383)`） |
| AC2 随内容变化 | 3 篇不同 topic 的简报（摘要模型实跑 `deepseek-v4.1-flash`）：圆与切线 → `motif=circle` `#0A1428/#8FA8FF/#FFC94D`；频率估计概率 → `statistics-chart` `#08201C/#4FD1C5/#FFD166`；相似三角形 → `triangle` `#12102A/#8AA9FF/#F2C14E` |
| AC3 简报可审计 | `data/gaoh/imgs/2026-10-21/cover-brief.json` → `{brief:{subject,motif,palette[3],mood,avoid}, summaryOk:true, at}`；失败时同样落盘并带 `summaryReason` |
| AC4 失败不阻断发布 | `COVER_IMAGE_BASE_URL=http://127.0.0.1:9/v1 publish -a gaoh --date 2026-10-21 --dry-run` → `cover-ai failed, falling back to ffmpeg` → `cover generated via ffmpeg (900x383)` → `dry-run ok ... words=2951`，退出 0 |
| AC5 双模型互为兜底 | `settings={model:"cn:not-a-real-model", fallbacks:["cn:hunyuan-image-alpha-edit"]}` → 日志 `cn:not-a-real-model failed … (fatal, next model)` → `model=cn:hunyuan-image-alpha-edit 8.6s → 900x383`，`ok:true` |
| AC6 幂等不烧额度 | `publish --reuse` 时 `cover.png` 保留 09:09 的 ffmpeg 版本（mtime/大小未变），未触发 AI 出图；`tools/cover-selftest.ts` 第 [9] 段钉住 `reuse && exists → 不重画` 契约 |
| AC7 250 草稿封面 | `cover -a gaoh --date 2026-10-21 --ai --upload` → `draft cover set ✓ (before=https://mmbiz.qpic.cn/sz_mmbiz_jpg/… → after=https://mmbiz.qpic.cn/mmbiz_jpg/…)`，上传的正是 AI 出的 900×383 图；`setDraftCover` 未改动 |
| AC8 doctor | `doctor -a gaoh` → `✅ cover-model (图像模型) cn:hunyuan-image-alpha-edit / global:gpt-image-2.5-sunburst 存在 · 网关 http://192.168.0.251:3011/v1（pi-models.json）` |
| AC9 回归 | `npx tsc --noEmit` 0 错；`bun tools/cover-selftest.ts` → **46 PASS / 0 FAIL**；250 `doctor -a gaoh` 全绿 |
| AC10 成本可控 | 每次运行：摘要 1 次 + 出图 ≤2 次（主+1 fallback）+ `maxTotalSec=300` 上限；实测单篇总耗时 20–23s（出图 8–11s） |

### 过程中发现并修掉的坑

1. **`ffprobe` 不可用**：`/usr/local/bin/ffprobe` 是 `imageio_ffmpeg` 静态包的符号链接，拒绝 `-select_streams` 等 ffprobe 专有参数；宿主也**没有** ImageMagick `convert` → `imageSize()` 改为**纯二进制头解析**（PNG/GIF/WebP/JPEG），同步返回，零依赖。
2. **请求尺寸 ≠ 结果尺寸**：请求 `900x383` 实际回 `896x368` → 强制 `fitImageTo()` 二次裁切。
3. **模型会画字符**：第一版 prompt 里简报写了“标注取值范围” → 图上出现 `12 = (2% = 18)`。修法不是加更多“禁止”，而是**改简报契约**：`subject` 必须能不用文字表达，区间/范围用虚线、阴影、色块。
4. **深色底会被忽略**：出现过白底封面 → `cover.md` 追加“`palette[0]` 必须是深色”，`buildImagePrompt` 明写“整幅画布填充深色，禁止白色/浅色背景”，并加 `averageColor()` 亮度探针打 WARN（不自动改图）。
5. **摘要模型别用默认值**：`summaryModel` 为空时会落到 pi 的默认模型（本机 `claude-opus-4-8`，503）→ 改为「无摘要模型就不发请求，直接用确定性简报」。
