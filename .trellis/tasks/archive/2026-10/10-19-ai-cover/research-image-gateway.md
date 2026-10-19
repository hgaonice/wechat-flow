# 调研 — meta-gateway 图像生成能力（2026-10-19 实测）

全部结论来自 250 真机 `curl`，命令与响应原文如下。网关地址取自
`/root/.pi/agent/models.json` → `providers["meta-gateway"]`：
`baseUrl=http://192.168.0.251:3011/v1`，`apiKey=sk-GEd…`（已脱敏）。

## 1. `deepseek-v4.1-flash` 不支持图片生成

```bash
POST /v1/images/generations {"model":"cn:deepseek-v4.1-flash","prompt":"blue circle","n":1}
→ http=503 {"error":{"code":"model_not_found",
   "message":"No available channel for model cn:deepseek-v4.1-flash under group default (distributor)"}}
```

结论：它是 **chat 模型**（`api: openai-completions`），只能写文案，不能出图。

## 2. 视觉理解模型也不能出图

| model | images/generations 结果 |
|---|---|
| `cn:glm-4.6v` | ❌ 503 `No available channel` |
| `cn:glm-5v-turbo` | ❌ 503 `No available channel` |
| `cn:hunyuan-2.0-instruct` | ❌ 503 `No available channel` |

这三个是**多模态理解**（看图），不是生成。

## 3. 全表 99 个模型里，只有 2 个能出图

`GET /v1/models` 过滤 `image|dall|flux|seedream|wanx|imagen|...`：

```
cn:hunyuan-image-alpha-edit
global:gpt-image-2.5-sunburst
workbuddy/cn:hunyuan-image-alpha-edit      (同一模型的带前缀写法)
workbuddy/global:gpt-image-2.5-sunburst    (同一模型的带前缀写法)
```

即 **workbuddy/cn 分组下唯一的图像模型 = `workbuddy/cn:hunyuan-image-alpha-edit`**。

## 4. 端点要「裸 id」，不要 pi 的 `provider/model`

| 传入 model | http | 结果 |
|---|---|---|
| `cn:hunyuan-image-alpha-edit` | 200 | ✅ `b64_json` 243KB |
| `global:gpt-image-2.5-sunburst` | 200 | ✅ `b64_json`（~35s，1.5MB） |
| `workbuddy/cn:hunyuan-image-alpha-edit` | 404 | ❌ `openai_error / bad_response_status_code` |
| `workbuddy/global:gpt-image-2.5-sunburst` | 404 | ❌ 同上 |
| `hunyuan-image-alpha-edit`（无 group） | — | ❌（同 gpt 情况）503 `No available channel` |
| `gpt-image-2.5-sunburst`（无 group） | 503 | ❌ `No available channel` |

→ 必须 `<group>:<model>`；配置里写 `workbuddy/cn:x` 时程序需剥掉 `workbuddy/`。

## 5. 速度与尺寸

| model | 请求 size | 耗时 | 实际返回尺寸 |
|---|---|---|---|
| `cn:hunyuan-image-alpha-edit` | 1024×1024 | 15s | 1024×1024 |
| `cn:hunyuan-image-alpha-edit` | 1536×1024 | 21s | 1536×1024 |
| `cn:hunyuan-image-alpha-edit` | **900×383** | 20s | **896×368**（吸附到支持尺寸） |
| `global:gpt-image-2.5-sunburst` | 1536×1024 | 34.5s | 1536×1024 |

**关键**：请求尺寸只是提示，**必须代码裁切到恰好 900×383**。

## 6. 出图质量抽样

测试 prompt（配方法求最值主题）：
> 深蓝紫渐变背景，发光青色抛物线与其最低点处的黄色水平切线，细网格坐标轴，扁平极简数学教学封面插画，无文字

- hunyuan 1536×1024：抛物线 + 切线 + 网格，构图正确，但**画出了坐标轴数字 `-2 -1 1 2`** → prompt 需显式禁数字。
- gpt-image-2.5：构图更干净，同样无中文乱码问题。

两版都可直接用作封面底图（标题由微信/后处理负责，不让 AI 画中文）。

## 7. 对实现的直接影响

1. 模型链：`cn:hunyuan-image-alpha-edit`（快、便宜）→ `global:gpt-image-2.5-sunburst`（质量兜底）。
2. `normalizeImageModelId()` 必须剥 provider 前缀。
3. prompt 硬约束：`禁止任何文字、字母、数字`。
4. 后处理必须 center-crop 到 900×383。
5. 鉴权复用 `models.json`，**无需新增凭据、无需新增 npm 依赖**（bun `fetch`）。
