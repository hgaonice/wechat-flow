# 报告：封面模型升级（GATE-1 = A，gpt-image-2.5 接主力）

- 任务：`.trellis/tasks/10-20-cover-model-upgrade`
- 日期：2026-10-20
- 结论：**主力换成 `global:gpt-image-2.5-sunburst`，混元退为兜底**；250 真机已验证出图 + 草稿封面替换成功。
- 回滚：250 `config.json` → `cover.ai.model = "cn:hunyuan-image-alpha-edit"`、`fallbacks = ["global:gpt-image-2.5-sunburst"]`
  （备份 `/root/config.json.bak-cover-20261020-184703`；config 每次请求读取，无需重启）

---

## 0. gpt-image-2.5 的来源（用户提问，本节为取证结论）

调用链（不是直连 OpenAI）：

```
wechat-flow（250）
  └─ http://192.168.0.251:3011/v1        ← 自建聚合网关，pi 里 provider = meta-gateway
       └─ 网关内 "global:" 分组 → vendor_id = -1012
            └─ 上游中转 "TokenHub"
                 └─ OpenAI  gpt-image-2.5（渠道别名后缀 "sunburst"）
```

| 环节 | 证据（可复读） |
|---|---|
| 网关软件 = **New API**（one-api 系分支，自建，品牌前缀 `workbuddy`） | `GET /api/status` → `docs_link = https://docs.newapi.pro`、`passkey_display_name = "New API"`；`/api/pricing` 返回 99 条 new-api 结构；模型清单里有镜像 id `workbuddy/global:gpt-image-2.5-sunburst` |
| 模型厂牌 = **OpenAI**（GPT Image 家族） | ① `GET /v1/models` → `{"id":"global:gpt-image-2.5-sunburst","owned_by":"openai","supported_endpoint_types":["image-generation","openai"]}`；② 错误体是 OpenAI 图像 API 的 schema：`{"code":"invalid_value","type":"image_generation_user_error","message":"Invalid size '900x383'. Width and height must both be divisible by 16."}`；③ 另一个 OpenAI 特征约束同样命中："Requested resolution is below the current minimum pixel budget."（见 C2 记录）；④ 只能出 `1024x1024` / `1536x1024` 这类 ≥1024 像素预算的尺寸 |
| 上游中转 = **TokenHub** | 网关错误原文：`Create image failed with error: TokenHub returned HTTP 400: {"error":{...},"request_id":"722b9d82-b92b-41de-848b-7ca02810949e"}`（复现命令见下） |
| 与混元是两个不同渠道 | `/api/pricing`：`gpt-image-2.5-sunburst → vendor_id=-1012`，`cn:hunyuan-image-alpha-edit → vendor_id=-1020`；分组前缀 `global:` = 海外直连组，`cn:` = 国内组（腾讯混元） |
| 计费在网关侧 | `/api/pricing`：两者 `model_ratio = 37.5`、`quota_type = 0`（按 token 计）、`model_price = 0`；单价需管理员 token 查 `/api/vendors`（401，未取）。实际单张成本以网关账单为准，我们付的是网关额度 |

复现来源的两条命令：

```bash
K=$(python3 -c "import json;print(json.load(open('/root/.pi/agent/models.json'))['providers']['meta-gateway']['apiKey'])")
curl -s -H "Authorization: Bearer $K" http://127.0.0.1:3011/v1/models | grep gpt-image
curl -s -X POST http://127.0.0.1:3011/v1/images/generations -H "Authorization: Bearer $K" \
  -H 'content-type: application/json' \
  -d '{"model":"global:gpt-image-2.5-sunburst","prompt":"x","n":1,"size":"900x383"}'   # 必被拒，回 TokenHub 原始错误
```

> 一句话：**模型是 OpenAI 的 gpt-image-2.5，经「TokenHub」中转、再经我们自建的 New API 网关（`192.168.0.251:3011`，品牌 workbuddy）调用；不是直连 api.openai.com。**

---

## 1. Step 1 对比结果（AC1 / AC2）

产物：`data/research/cover-compare-2026-10-20/`（raw 原图 / fit 900×383 裁切 / 4 张 compare 拼图 / matrix.json / summary.txt / cogview-429.txt）

| 模型 | 结果 | 平均耗时 | 原始尺寸 | 放大重试 | 备注 |
|---|---|---|---|---|---|
| `cn:hunyuan-image-alpha-edit` | ok 4/4 | **11.4s** | 896×368 | 0 | 1/4 白底（无视 palette）、2/4 语义错乱 |
| `global:gpt-image-2.5-sunburst` | ok 4/4 | **75.9s** | 1536×1024 | 4/4 | 4/4 命中主题、深底、无文字 |
| `cogview-4` | ❌ 4/4 fail | — | — | — | `http 429 余额不足或无可用资源包,请充值。` |
| `cogview-4-250304` | ❌ 4/4 fail | — | — | — | 同上（同源无额度） |
| `google/gemini-nano-banana-2.1` | skipped | — | — | — | `no OPENROUTER_API_KEY`（AC2 要求显式记录） |

- AC1 自检：`matrix.json` 12 行 / 8 ok / 4 skip；**所有失败行 `reason` 非空**（脚本断言 `reasons all non-empty on fail: True`）；`fit/*.png` 8 张**全部 900×383**（`fit 尺寸非 900x383 的文件数: 0`）
- AC2：`cogview-3-flash` 未出现；nano-banana 有显式 `skipped` 行
- 退出码：全失败 `3`、运维错 `1`、有可用行 `0`（实测 cogview 单模型冒烟 → exit 3）

### 目视判定（GATE-1 依据）

| 题目 | hunyuan | gpt-image-2.5 |
|---|---|---|
| 配方法求最值 | 白底 + 圆/三角/虚线框，**无抛物线** | 深底 + 抛物线 + 顶点/端点标记 + 三步指示符 |
| 相似三角形判定 | 白底，构图空 | 深底 + 大小三角形 + 等角弧标记 |
| 一次函数与不等式 | 坐标系图形错乱 | 深底 + 直线 + 不等式区域阴影 |
| 统计图表误读 | 仅柱状图，未表达"陷阱" | 纵轴截断锯齿 + 两枚饼图对比 |

**4:0，gpt-image-2.5 完胜。**

## 2. GATE-1 与接入（AC3 / AC4）

- **AC3**：用户在 GATE-1 明确选择 **A（gpt-image-2.5 当主力）**。
- **AC4**：250 改配置后 `bun src/cli.ts doctor -a gaoh`：

```
✅ cover-model (图像模型)  global:gpt-image-2.5-sunburst / cn:hunyuan-image-alpha-edit 存在 · 网关 http://192.168.0.251:3011/v1（pi-models.json）
cover-candidates: 7 image models (gateway ok) · last ok global:gpt-image-2.5-sunburst (5.1h ago, 74.0s)
```

变更（250 `config.json`，最小文本替换 + JSON 合法性断言 + 0600 原子写）：

```diff
-        "model": "cn:hunyuan-image-alpha-edit",
+        "model": "global:gpt-image-2.5-sunburst",
         "fallbacks": [
-          "global:gpt-image-2.5-sunburst"
+          "cn:hunyuan-image-alpha-edit"
         ],
```

**未改**：`cover.mode`（gaoh=ai / second=ffmpeg）、`size`、`uploadToDraft`、`dailyBudget` 语义、`style`、`timeoutSec/maxTotalSec`。
四级降级链保持不变：`AI(主力) → AI(兜底) → ffmpeg → template`。

## 3. 250 真机验证（AC5）

命令：`bun src/cli.ts cover -a gaoh --date 2026-10-21 --ai --upload`（10-21 草稿已于 2026-10-19 写入草稿箱，故只重设封面，不重写正文）

原始输出（节选，未加工）：

```
cover --ai: date=2026-10-21 文章=…第1讲汇总-一元二次方程及其解法-知识地图与中考真题串.md 尺寸=900x383
[WARN] cover-ai: 摘要降级为确定性简报 (summary model failed: all 4 models failed (4 attempts): …)
[WARN] cover-ai: global:gpt-image-2.5-sunburst rejected size 900x383 (http 502: Create image failed with error: TokenHub returned HTTP 400 …) — retrying at 1536x1024
[INFO] cover-ai: model=global:gpt-image-2.5-sunburst 71.7s b64=774308B → 900x383 (总 71.7s)
✅ AI 封面：global:gpt-image-2.5-sunburst → data/gaoh/imgs/2026-10-21/cover.png (900x383, 71.7s)
[INFO] [session] verdict=valid consecutive=0/3 evidence=cookie:ok(in 95.9h),http:ok,dom:loggedin
[INFO] cover: draft already has a cover, replacing it
[INFO] cover: uploaded cover.png (input accept=image/bmp, image/png, image/jpeg, image/jpg, image/gif, image/webp)
[INFO] cover: clicked «下一步» / «确认» / 保存 (#js_submit button)
[INFO] draft cover set ✓ (before=https://mmbiz.qpic.cn/mmbiz_jpg/lVMyHg0IJiago9X9dBYiaMQicXCE → after=https://mmbiz.qpic.cn/mmbiz_jpg/lVMyHg0IJiag2FLSU3Jlw9zzuNCc)
✅ 草稿封面已设置（verify）：before=… → after=…
```

文件证据：

| 路径 | 大小 | 说明 |
|---|---|---|
| `data/gaoh/imgs/2026-10-21/cover-raw.png` | 580730 B | 模型原图（1536×1024） |
| `data/gaoh/imgs/2026-10-21/cover.png` | 267110 B | `fitImageTo → 900×383`（PIL 复核 `size (900, 383)`） |
| `data/gaoh/imgs/2026-10-21/cover-brief.json` | 615 B | `summaryOk=false` + 降级原因（摘要模型 4 跳全挂，不影响出图） |
| `data/gaoh/state/cover-model-stats.json` | — | `global:gpt-image-2.5-sunburst: okCount=2, failCount=0, lastOkMs=71024` |

目视（本次新图）：深蓝底 + 中央书本/知识地图 + 6 个分支小图标 + 底部三个抛物线模型框（顶点、对称轴、两解），
无文字/数字/水印，配色与 palette `#0F4C81 / #2D8AE0 / #FFD54F` 一致。**待用户最终签字（GATE-2 的一部分）。**

### 与 AC5 的偏差（显式记录，不掩盖）

- 走的是 `cover --ai --upload`（对**已存在草稿**重设封面），**不是** `publish` 全链路的 `publisher → setDraftCover`。
  原因：10-21 草稿已于 2026-10-19 落库（`published.json` `ok:true`），重跑 `publish` 会重写正文并额外消耗一次完整生成。
- 该命令仍经过真实链路的关键环节：真实网关出图 → `fitImageTo` → CDP 上传图片库 → 「下一步/确认/保存」→ **读回 `#js_cover_area` 预览 `background-image` 前后对比**（`before≠after`）。
- 摘要模型全挂是**既有**现象（250 无可用 summary 模型），与本次改动无关，且已按设计降级为 `fallbackBrief`。

## 4. 闸门（AC6）

```
bash tools/ui-gates.sh --strict
GATES: 7 passed, 0 failed        # 含 tsc --noEmit / bun build src/cli.ts / package.json dependencies: none
```

## 5. 代码改动

| 文件 | 性质 |
|---|---|
| `src/cover-ai.ts` | `async function generateOneImage` → `export async function generateOneImage`（零行为变更） |
| `tools/cover-compare.ts` | 新增一次性工具：同题×多模型出图 → fit 900×383 → 拼图 + matrix.json + summary.txt；`--remontage <dir>` 可只重拼图不重新出图（零网关调用） |
| `.trellis/tasks/10-20-cover-model-upgrade/*` | 任务产物 |

## 6. 残留风险 / 后续建议

1. **耗时×6.7**：gpt-image-2.5 单张 71.7s、必走一次尺寸放大（两次上游请求）。当前 `timeoutSec=120 / maxTotalSec=300` 仍够用，
   但最坏情况（放大后超时）留给混元兜底的预算只剩 ~60s，而混元正常只要 11s —— 可接受，未改配置（本任务不改预算语义）。
2. **cogview-4 系仍无额度**：网关侧充值后可作为第三个候选再比一次（`bun tools/cover-compare.ts --models cogview-4`）。
3. **nano-banana 2.1 未验**：给 `OPENROUTER_API_KEY` 后可加第五列（工具已支持 `--models` 追加）。
4. **成本**：`model_ratio=37.5`（与混元同档），实际单张额度消耗以网关账单为准；每天 2 张封面的量级可接受。
5. `second` 账号仍 `cover.mode=ffmpeg`，未纳入本任务范围。

## 7. 上游变更（2026-10-22 追加）：gpt-image-2.5 路由被上游移除

**结论：本任务选出的主力模型当前不可用，属**上游**变更，非本地配置问题。**

| 项 | 证据 |
|---|---|
| 失败表现 | `http 502: Create image failed with error: Image model [gpt-image-2.5-sunburst] route config not found` |
| 报错来源 | `wb-image-proxy`（meta-gateway 的 `image:workbuddy` 渠道 → `http://wb-image-proxy:8098`），日志中四个 acct 轮流报同一句 |
| 本地配置无误 | `/v1/models` 仍有 `global:gpt-image-2.5-sunburst` 与 `workbuddy/global:...`；渠道 `image:workbuddy`(id=16) 仍 `status=1`、`base_url=http://wb-image-proxy:8098` |
| 镜像 id 也失败 | `workbuddy/global:gpt-image-2.5-sunburst` → `404 openai_error bad_response_status_code` |
| 同渠道另一模型可用 | `cn:hunyuan-image-alpha-edit` → 200，16.6s / 1.7MB |

**生产影响（已实测自动降级，未中断）**：
`data/gaoh/state/cover-model-stats.json` 显示
`global:gpt-image-2.5-sunburst` 最后一次失败于 `2026-10-21T23:04:27Z`（`route config not found`），
紧接着 `cn:hunyuan-image-alpha-edit` 于 `23:04:39Z` 成功（11.9s）；
`journalctl -u wechat-console` 同时间段可见 `cover-ai: model=cn:hunyuan-image-alpha-edit` + `draft cover set ✓`。
即：**gaoh 的 AI 封面链路仍能出图，只是画风/质量退回混元**（`cover.ai.model` 仍是 gpt-image，靠 `fallbacks` 兜底）。

**处置建议**：
① 找 WorkBuddy 侧恢复 `gpt-image-2.5-sunburst` 的路由配置（恢复后**无需改本地任何配置**，主力自动回到 gpt-image）；
② 若不恢复，建议把 `cover.ai.model` 直接改为 `cn:hunyuan-image-alpha-edit`、并把 `fallbacks` 留空或换 `ffmpeg`，
   避免每张封面都先白等一次失败（实测失败那次耗掉约 12s 才降级）；
③ `cover-compare` 结论仍成立（混元 4 题中 3 题语义不稳），恢复路由后建议重跑一次同题对比再定主力。
