# Design：文章末尾互动引导语（D4 = R 混合方案）

> 目标：**AI 写文风，代码断言"必须有"**。与 `.trellis/spec/engine/ai-determinism.md` 的分层完全一致。

---

## 1. 分层与数据流

```
                 ┌─────────────────── AI（非确定性）───────────────────┐
planner → prompts/article.md ─► pi agent ─► data/<alias>/articles/<date>-<slug>.md
                 └────────────── 新增「结尾互动引导」章节 ────────────────┘
                                        │
                                        ▼
        ┌──────────── 代码（确定性，新增 src/cta.ts）────────────┐
        │ runArticleGeneration() 末尾：ensureCtaInArticle()      │
        │   检测尾部是否有引导语 → 有: 原样保留（幂等）          │
        │                      → 无: 追加 prompts/cta/<alias>.md │
        └────────────────────────────────────────────────────────┘
                                        │
                     （同一份 base 文件被下游复用）
                                        ▼
   prepareArticleForPublish()（媒体预处理）→ publish（草稿箱）→ verifyDraftBody（真相源）
```

**关键点：唯一注入点 = `runArticleGeneration()`**，因为生成与发布两条路径都必经此处：
- 每日发布：`runPublish()` → `runArticleGeneration(cfg,{date,reuse})`（`src/publisher.ts:169`）
- 控制台生成：`src/console/content/generate.ts:19` 直接用同一个 `runArticleGeneration`，随后才快照 `.v<N>.md` → 版本文件天然带 CTA
- `--reuse` 复用旧文同样经过该函数 → 旧文可被补回（AC2）

因此**不需要**改 `media.ts` / `wechat.ts` / 发布链路，也不需要第二个注入点。

---

## 2. 新模块 `src/cta.ts`（纯函数 + 一个薄 I/O 包装）

```ts
/** 引导语动作词（用于确定性检测）。 */
const ACTION_WORDS = ["点赞", "在看", "转发", "收藏", "评论", "留言"]; // 核心六词（不含 分享/关注，见复核 F1）
const TAIL_CHARS = 500;      // 只看正文尾部
const MIN_ACTION_HITS = 2;   // 尾部命中 ≥2 个不同动作词 → 视为已有引导语

export interface CtaApplyResult {
  action: "present" | "appended" | "disabled" | "skipped";
  detail: string;            // 供日志/验收断言
}

/** 正文尾部的引导语检测（纯函数，可断言）。 */
export function hasCtaHint(body: string): boolean;

/** 归一化 + 追加；已有则原样返回；保证幂等（跑两次字节一致）。 */
export function ensureCtaBlock(markdown: string, block: string): { markdown: string; appended: boolean };

/** 解析 CTA 文案（配置文件 → 内置兜底），并渲染 {{accountName}} 等占位符。 */
export function resolveCtaBlock(cfg: AppConfig): { text: string; source: string } | null;

/** 薄 I/O 包装：读文章 → ensure → 变更时写回；永不抛错（R6 降级）。 */
export function applyCtaToArticle(cfg: AppConfig, articlePath: string): CtaApplyResult;
```

### 2.1 检测规则（确定性、可断言）

- 取**去掉 frontmatter 后的正文**；只看**最后 `TAIL_CHARS=500` 个字符**（等价于最后若干行）。
- 统计尾部出现的**不同** `ACTION_WORDS` 个数；`≥2` → `present`（AI 已写引导语，原样保留）。
- `<2` → `appended`（追加标准块）。
- **检测词表只收核心六词**（`点赞/在看/转发/收藏/评论/留言`）：`分享/关注` 在普通结尾也常见，入表会把非引导结尾误判为“已有” → **该补未补**，破坏 R1（2026-10-16 独立复核 F1 后修正，`tools/cta-selftest.ts` 11/12 两条断言守护）。
- 说明：
  - 阈值取 2（而非 3）是**有意放宽**：AI 只提醒「点赞+留言」时也算引导语，避免追加造成重复感；严格 ≥3 的要求由**提示词**（D6）和**标准块**保证，而不是靠检测器。
  - 只用尾 500 字符 → 正文中段偶然出现「收藏」不会误判。
  - 标准块本身含 6 个动作词 → 追加后再次运行时必然 `present`，**幂等成立**。

### 2.2 追加的归一化

- `body = body.replace(/\s+$/,"")` 去掉尾部空行 → 拼 `"\n\n" + block.trim() + "\n"`。
- 不动 frontmatter（`---` 块按首个闭合 `---` 定位，原样保留字节）。
- 不做任何"润色/改写"，附录型内容（练习题答案）保持在上方。

### 2.3 配置与降级链（R3 / R6 / R7）

`src/config.ts` 新增（模式与既有 `manim` / `cover` 完全一致）：

```ts
// AppConfig
cta: { enabled: boolean; file?: string };
// AccountEntry（可被控制台 overrides 覆盖）
cta?: { enabled?: boolean; file?: string };
```

解析顺序（`acct.cta ?? raw.cta`）：

| 优先级 | 来源 | 说明 |
|---|---|---|
| 1 | `cta.enabled === false` | 直接 `disabled`，只记日志（AC7 回归开关） |
| 2 | `cfg.cta.file`（显式路径） | 支持绝对/相对路径 |
| 3 | `<prompts>/cta/<alias>.md` | 默认按账号取（`second.md` / `gaoh.md`） |
| 4 | `<prompts>/cta/default.md` | 通用兜底 |
| 5 | `src/cta.ts` 内置常量 | 文件缺失也能保证必有（R6），日志记 `source=builtin` |

**默认值**：`cta.enabled` 默认 `true`（与"每篇都要有"的需求一致，开箱即用）。

**校验**：追加前断言块内 ≥3 个动作词；不合格则降级到内置常量；内置常量也不合格（不可能）则 `skipped` + warn，**绝不阻断发布**。

### 2.4 日志契约（R7）

```
log.info(`cta: present (tail hits=3)`)        // 已有，未改动
log.info(`cta: appended from prompts/cta/second.md (chars=126)`)
log.info(`cta: disabled (config)`)
log.warn(`cta: skipped — block failed validation: ...`)
```

---

## 3. 文案资产（`prompts/cta/`）

- `prompts/cta/second.md` — 巧思初数（初中数学教学视角）：点赞/在看 + 转发家长同学 + 收藏复习 + 评论留言 + 关注，含"每天一道真题拆解"定位。
- `prompts/cta/gaoh.md` — gaoh的技术分享（技术/学习方法视角）：点赞/在看 + 转发同学 + 收藏 + 评论区交流解法。
- 两段均为 **Markdown 引用块（`>`）**，落在文末视觉上与正文区分，微信渲染为灰底引用（不依赖公式/HTML，零风险）。
- 人设统一（D2）：措辞都沿用巧思初数「耐心的数学老师」口吻，**不喊口号、不制造焦虑**。

> 文案放在 `prompts/` 而非代码里，遵守铁律「文风属于 prompts」。后续替换文案**只改 md 文件，不动代码**（R3）。

---

## 4. 提示词改动（AI 侧）

| 文件 | 改动 |
|---|---|
| `prompts/article.md` | 新增第 5 条「结尾互动引导（必须）」：文末 2~4 句、结合当天知识点轻引导、≥3 类动作、禁夸张/焦虑话术、**不要自己造固定签名块**（缺失时引擎会补） |
| `prompts/editor.md` | 人设段补一条：结尾自然邀请互动，语气与正文一致 |

---

## 5. 控制台影响（R9）

- `src/console/server.ts` 的 `OBJECT_ENTRY_KEYS` 增加 `"cta"` → 控制台账号设置可读写 `cta` 对象（否则按现有校验会被 400 拒绝）。**无 DB 迁移**（`overrides_json` 原样透传）。
- `src/console/content/generate.ts` **不改**：快照发生在 `runArticleGeneration` 之后（`generate.ts:19` → `snapshotVersion`），版本文件自带 CTA。

---

## 6. 兼容性 / 回滚

| 维度 | 结论 |
|---|---|
| 历史已发布文章 | 不改（非目标） |
| 已生成未发布草稿 | 下次 `--reuse` 或重生成时补 CTA |
| 211 天计划数据 | 不动（R8）：CTA 与计划项无关 |
| 发布铁律 | 不改：真相源仍是 `verifyDraftBody()` 的真实 DOM |
| 依赖 | 零新增（仅 bun 内置 `node:fs`/`node:path`） |
| 回滚 | ① `cta.enabled=false`（热回滚，不改代码）② revert 单个 commit（`src/cta.ts` + 3 处小改） |

---

## 7. 风险与取舍

| 风险 | 评估 | 处置 |
|---|---|---|
| 尾部误判 → 该补未补 | 低（需在尾 500 字命中 ≥2 个动作词） | 阈值 2 已放宽；`tools/cta-selftest.ts` 覆盖反例 |
| AI 写的 CTA 质量参差 | 中（D4=R 的固有代价） | 提示词给结构约束 + 抽样人工对齐（D1 的"后面对齐"） |
| 追加块与 AI 写的重复 | 由检测规则避免（有则不加） | 幂等自测断言 |
| 微信渲染引用块样式不可控 | 低（纯文本引用，平台原生支持） | 真机 G2 目视复验 |

---

## 8. 不做

- 不做阅读量回流 / A/B / 多套文案轮换（后续另立任务）。
- 不做 CTA 的多语言、不做按星期轮换模板（模板固定是 (A) 的形态，用户选了 R）。
- 不为 CTA 新增 CLI 子命令（验收用现成的 `publish --reuse --dry-run` + `tools/cta-selftest.ts`）。
