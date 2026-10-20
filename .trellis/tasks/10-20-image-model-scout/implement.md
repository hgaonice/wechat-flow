# 执行计划（C2）：图像模型普查与封面链接入

> 前置：`task.py start` 后进入 `in_progress`。Step 3 是**人工决策门**（G-Q4），Step 2 完成前不得改 `cover.ai.model`。

## Step 0 · 基线快照（10 分钟，只读）

- [x] 0.1 记录当前链路与行为：`grep -n "hunyuan\|gpt-image" config.json config.example.json src/cover-ai.ts | head`；`bun src/cli.ts doctor --all | grep -i cover`（预期：无 cover 行）
- [x] 0.2 抓一次当日封面作基线样张：`bun src/cli.ts drafts -a second --date <today>` 记录 `img=` 计数；保存当前 `data/second/logs/publish.log` 中封面相关行
- [x] 0.3 枚举网关图像模型（真实请求，不打印 key）：
      `bun -e 'import {listImageModels} from "./src/cover-ai.ts"; ...'` 或复用 selftest 输出，落盘 `data/research/models-baseline.txt`
- [x] 0.4 成本口径确认：向用户/文档确认 cogview 系列在网关侧是否计费（不确定就标"未知"，不猜）

**Gate 0**：无代码改动，纯记录。若 0.4 发现"按次计费且无免费额度"，立刻回来讨论是否把 cogview 降为"兜底候选"。

## Step 1 · 探测矩阵工具（`tools/image-model-probe.ts`）

- [x] 1.1 抽出可复用的纯函数（放 `tools/` 内，不污染 `src/`）：
      - `buildProbeRequest(model, size)` → `{ url, init }`（复用 `resolveImageGateway()`，不重复解析 models.json）
      - `measureImage(bytes)` → `{ w, h, bytes }`（复用 `src` 里已有 `imageSize()`，不新写解析器）
      - `scoreImageStructure(bytes, size)` → `{ passed: string[], failed: string[] }`（C-2 四条自动断言）
- [x] 1.2 主流程：逐模型 `fetch` → 计时（`performance.now()`，含 TTFB 若响应头可得）→ 落盘 PNG → 计算 sha256 → 组装 `ProbeRow`
- [x] 1.3 失败路径必须显形：非 2xx / 非图片 content-type / 解析不出尺寸 / 超时 → 都是 `ok:false` 且 `reason` 非空（含 status 与网关返回体前 200 字，**先脱敏 key**）
- [x] 1.4 CLI：`--models a,b,c` 或 `--all-image`（= `listImageModels()`）；`--brief <path|inline-json>`；`--size`；`--out-dir`；`--timeout-sec`（默认 60）
- [x] 1.5 幂等：同一日期同一模型重复跑不覆盖旧样张（文件名带 `-<HHMMSS>`），报告按 `model` 合并最新一行
- [x] 1.6 自测：`tools/image-model-probe-selftest.ts` —— 用本地假响应（`Bun.serve` 起临时端口返回 1×1 PNG / 400 / HTML / 慢响应）验证 4 类结果分类，**不打真网关**

**验证**：`bun tools/image-model-probe-selftest.ts` → ALL PASS；`bunx tsc --noEmit` 0 错。

## Step 2 · 跑真实矩阵（R1 / AC1）

- [x] 2.1 在 250 上跑（避免本机网络差异）：`bun tools/image-model-probe.ts --all-image --size 900x383 --brief <当日真简报>`
      简报取自现有产物 `data/<alias>/cover-brief.json`（同一份喂给所有模型，保证可比）
- [x] 2.2 逐模型落 PNG 到 `data/research/samples/`，报告落 `data/research/image-models-<date>.json`
- [x] 2.3 每个失败模型至少重试 1 次（区分"偶发/永久"），把 `retryable` 结论写进报告 `reason`
- [x] 2.4 汇总：`fastest/slowest`、`snapped` 分布、单次耗时中位数

**Gate 2（用户可见的中间结论）**：把矩阵结果表格贴给用户 —— 尤其 **3 个 cogview 的首次实测数据**（延迟/尺寸/是否出字）。无此表不得进入 Step 3。

## Step 3 · 选型与外部源清单（R2 / R3 / AC2）+ 人工决策门

- [ ] 3.1 写 `docs/research/image-models.md` §A 网关内矩阵：模型 / 来源 / 成本（含"未知"）/ 延迟 / 尺寸支持 / 吸附 / 中文字形（人工目视 1 张）/ 稳定性 / 推荐用途
- [ ] 3.2 写 §B 外部免费源清单，每条**必须**含：官方文档链接、免费额度、是否需注册、是否需信用卡、是否可商用、**两条验证命令**（curl 模型列表 + curl 出图），以及"是否需在 250 配代理"
      至少覆盖：Cloudflare Workers AI、智谱 CogView-flash、SiliconFlow、ModelScope、Gemini 免费层、Pollinations
- [ ] 3.3 写 §C 结论：主力 / 兜底 / 备用 三档建议 + **不建议使用**的模型及理由（例：会画字的模型不适合封面）
- [ ] 3.4 明确标注：外部源**均未实测**（Q3：待用户逐个放行），文档不得出现"据说/应该可用"

**Gate 3（G-Q4 人工决策）**：向用户提交 §C 建议（含"改配置的具体两行 diff"），用户拍板后才进 Step 4。

## Step 4 · 链路落地（R4 / AC3）

- [x] 4.1 按 Gate 3 决议更新 `config.example.json` 与 250 `config.json`（真源是控制台 `PUT /api/settings`，改完回渲核对）
- [x] 4.2 故障注入 A：`cover.ai.model` 指向不存在的模型 → `publish --dry-run` 日志出现 `fatal, next model` → 降级成功 → 发布不被阻断
- [x] 4.3 故障注入 B：`cover.ai.gateway` 指向关闭端口 → 整链失败 → 降级 ffmpeg → 仍 `✅ 正文校验`（用真跑或 `--reuse --dry-run`）
- [x] 4.4 记录注入前后 `cover-model-stats.json` 的变化（这就是 doctor 行要读的数据）

## Step 5 · 可观测与护栏（R4 / R6 / AC4）

- [x] 5.1 `src/cover-ai.ts`：每次尝试后写 `data/<alias>/state/cover-model-stats.json`（`{ model: { lastOkAt, lastOkMs, lastFailAt, lastFailReason } }`），写失败只 WARN 不抛
- [x] 5.2 `src/cover-ai.ts`：`dailyBudget` 计数（C-3 契约：按**文章日期**归零；耗尽返回 `ok:false` 并可读 reason；不静默）
- [x] 5.3 `src/cli.ts#doctor`：新增 `cover-candidates` 行（C-4 格式），gateway 不可达时写 `models ?` 且**不失败**
- [x] 5.4 `tools/cover-selftest.ts`：新增断言 —— ① 结构评分四条对"空白图/1×1/尺寸错误"必须 fail、对真实样张必须 pass；② budget 用满后返回 `ok:false` 且不抛；③ stats 落盘/读回幂等
- [x] 5.5 `config.example.json` 增 `cover.ai.dailyBudget: 0` 并在 `docs/操作手册.md` 记一行（默认关闭，怎么开）

**验证**：`bun tools/cover-selftest.ts` ALL PASS；`bun src/cli.ts doctor --all` 出现 `cover-candidates: 5 image models (gateway ok) …`。

## Step 6 · 真机收口（AC5 / AC6）

- [x] 6.1 250 部署：`bash deploy/deploy.sh --keep-remote-content` → 自检全绿（会话/C1 能力不受影响）
- [x] 6.2 真机出一张封面：`bun src/cli.ts publish -a second --date <today> --reuse --force` → `draft cover set ✓`；下载草稿箱封面图 **人工目视**：无错字/无乱码/无数字，结论写进 `docs/research/image-models.md` §D
- [x] 6.3 两账号 `drafts --all --date <today>` → 双 `✅ 正文校验`（AC6）
- [x] 6.4 `bunx tsc --noEmit` / `bun build --target=bun src/cli.ts` / `dependencies` 仍为空 → 记录
- [x] 6.5 更新 `AGENT.md` §1/§5/§9、`docs/操作手册.md`（budget 与 doctor 行）、spec（`engine/quality-guidelines.md` 记"质量自动分只判结构"这条边界）
- [x] 6.6 `bash tools/repomap.sh` 刷新 `TREE.md`；`git commit`；`task.py archive … --skip-branch-validation`

## 回滚点

| 位置 | 回滚动作 |
|---|---|
| Step 4 之后 | 配置改回原两行（`git checkout config.example.json` + 控制台 PUT 回原值） |
| Step 5 之后 | `dailyBudget` 设 0；stats 文件可删；doctor 行是纯附加 |
| 任意时刻 | 探测脚本是独立文件，删除不影响发布链 |

## 时间预算

| Step | 预计 |
|---|---|
| 0 | 10 min |
| 1 | 60–90 min |
| 2 | 30 min（5 模型 × ~20–40s + 重试） |
| 3 | 45 min（外部源链接需要逐条核对官方文档） |
| 4 | 30 min |
| 5 | 60 min |
| 6 | 45 min |
