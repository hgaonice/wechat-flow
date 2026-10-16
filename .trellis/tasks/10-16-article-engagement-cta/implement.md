# Implement：文章末尾互动引导语（D4 = R）

> 执行纪律：每步完成必须留**真实命令输出**或**产物路径**；禁止"我记得做过了"。
> 单活动任务：本文件是当前唯一在做的 `.trellis/tasks/` 任务。
> 触碰 `src/` → 动手前读 `.trellis/spec/engine/index.md` 前置清单（已读，见 `implement.jsonl`）。

---

## 阶段 0：规划门（已满足）

- [x] 任务创建（10-16-article-engagement-cta）
- [x] `prd.md` 收敛（D1–D6）
- [x] `design.md`（分层 / 契约 / 回滚）
- [x] **R0**：用户在规划摘要上确认 → 才执行 `python3 .trellis/scripts/task.py start`（状态 → in_progress）

---

## 阶段 1：文案资产（AI 侧，零代码风险）

- [x] **S1** 新增 `prompts/cta/second.md`、`prompts/cta/gaoh.md`；`prompts/article.md` 加「结尾互动引导（必须）」章节；`prompts/editor.md` 加一条人设要求。
  - 验：`grep -c -e 点赞 -e 转发 -e 收藏 -e 评论 prompts/cta/second.md` ≥3；两个文件都命中
  - 验：`grep -n "结尾互动引导" prompts/article.md`
  - 回滚点：纯文件新增，`git checkout` 即还原

## 阶段 2：确定性模块（`src/cta.ts`）

- [x] **S2** 新建 `src/cta.ts`：`hasCtaHint` / `ensureCtaBlock` / `resolveCtaBlock` / `applyCtaToArticle`（签名见 design §2）。
- [x] **S3** `src/config.ts`：`AppConfig.cta`、`AccountEntry.cta`、解析（`acct.cta ?? raw.cta`，默认 `enabled:true`）。
- [x] **S4** `src/publisher.ts`：`runArticleGeneration()` 文件存在性检查之后调用 `applyCtaToArticle(cfg, articlePath)` 并 `log.info` 结果（唯一注入点）。
  - 验：`bun build --target=bun src/cli.ts` + `bunx tsc --noEmit` 零错误
  - 自检：`bash tools/repomap.sh` 生成的 `TREE.md` 里出现 `cta.ts`
  - 回滚点：`src/cta.ts` 删除 + 3 处小改 revert

## 阶段 3：控制台放行 + 配置示例

- [x] **S5** `src/console/server.ts` 的 `OBJECT_ENTRY_KEYS` 加 `"cta"`；`config.example.json` 补 `cta` 示例（注释式文档）。
  - 验：`grep -n '"cta"' src/console/server.ts config.example.json`
  - 注意：无 DB 迁移（`overrides_json` 透传）

## 阶段 4：可复跑的确定性自测

- [x] **S6** 新建 `tools/cta-selftest.ts`（零依赖、`bun tools/cta-selftest.ts` 即可跑），覆盖：
  1. 尾部已有引导语 → `present`，字节不变；
  2. 无引导语 → `appended`，追加块含 ≥3 动作词；
  3. 正文中段出现「收藏」→ 不误判（仍 `appended`）；
  4. 同一输入跑两次 → 输出**字节一致**（幂等）；
  5. frontmatter 原样保留。
  - 验：`bun tools/cta-selftest.ts` 打印全部 `PASS`（命令输出为 AC2 证据）

## 阶段 5：引擎验收（开发机）

- [x] **S7** 依次执行并留输出：
  ```bash
  bun build --target=bun src/cli.ts >/dev/null && echo BUILD_OK
  bunx tsc --noEmit && echo TSC_OK
  bun src/cli.ts doctor --all
  bun src/cli.ts publish -a second --date <已有文章日期> --reuse --dry-run
  bun src/cli.ts publish -a gaoh   --date <已有文章日期> --reuse --dry-run
  tail -6 data/second/articles/<date>-*.md   # 目视引导语
  grep -c -e 点赞 -e 转发 -e 收藏 -e 评论 data/second/articles/<date>-*.md
  ```
  - 对应 AC1 / AC3 / AC4 / AC7（`CTA_ENABLED=false` 再跑一次验证关闭路径）
  - 注：现有可用样本 `data/second/articles/2026-10-20-一次函数图象.md`
  - 回滚点：`git revert <S2–S4 commit>`

## 阶段 6：250 真机复验（GATE G2，需用户确认可动 250）

- [x] **S8** `rsync` 同步 `src/` + `prompts/` → 250；`bun build`；`publish --force --reuse` → `drafts --date <日期>` 显示 `✅ 正文校验`；草稿箱正文末尾目视引导语（AC5）。
  - 顺序：**先本地全绿再动 250**；`prompts/cta/` 必须一起同步（否则 250 走内置兜底）
  - 若 250 不可用 → 本步标记 `BLOCKED(250)`，不得写"已完成"

## 阶段 7：文档与规范沉淀（Phase 3.3）

- [x] **S9** 更新：`src/README.md`（新增 `cta.ts` 职责/坑）、`TREE.md`（`bash tools/repomap.sh`）、`.trellis/spec/engine/ai-determinism.md`（CTA 归属"确定性后处理"条款）、`AGENT.md`（进度看板 S18 行 + 任务地图 + 变更日志）。
  - 验：`grep -n "cta" .trellis/spec/engine/ai-determinism.md AGENT.md src/README.md`

## 阶段 8：收尾

- [ ] **S10（commit 待复核结论；archive 等 AC5）** 全量复跑阶段 5 命令（最后一遍全范围检查）→ commit（`feat(engine): 文章末尾互动引导语（prompts/cta + 确定性补齐）`）→ `task.py archive`。
  - 验收清单：AC1–AC7 逐条打勾，每条附产物路径或命令输出

---

## 验收命令汇总（一次性）

```bash
cd /workspaces/other/weixin/wechat-flow
bun build --target=bun src/cli.ts >/dev/null && echo BUILD_OK
bunx tsc --noEmit && echo TSC_OK
bun tools/cta-selftest.ts
bun src/cli.ts doctor --all
bun src/cli.ts publish -a second --date 2026-10-20 --reuse --dry-run
grep -c -e 点赞 -e 在看 -e 转发 -e 收藏 -e 评论 data/second/articles/2026-10-20-一次函数图象.md
```

## 风险与前置依赖

| 项 | 说明 |
|---|---|
| 依赖 | 无外部前置；与 `10-15-grade9-math-plans` **无耦合**（不改计划数据，R8） |
| 250 真机 | AC5 需用户在 G2 放行；本地全绿前不得触碰 |
| 样本日期 | AC1/AC4 用已有文章样本日期（`2026-10-20`）；若被清理则先 `--dry-run` 生成一篇 |
| 观测 | 日志 `cta: present|appended|disabled|skipped` 是验收断言点，禁止改文案 |

---

## 执行结果（2026-10-16，本机 251）

| 步骤 | 状态 | 真实证据 |
|---|---|---|
| S1 文案资产 | ✅ | `grep -c -e 点赞 -e 在看 -e 转发 -e 收藏 -e 评论 prompts/cta/second.md` → `3`；`gaoh.md` → `3`；`prompts/article.md:11` = `5. **结尾互动引导（必须）**` |
| S2 `src/cta.ts` | ✅ | `src/cta.ts`（162 行）；`TREE.md` 出现 `src/cta.ts` |
| S3 config | ✅ | `git diff src/config.ts`：`AppConfig.cta` + `AccountCfg.cta` + 解析（默认 `enabled:true`） |
| S4 publisher 注入点 | ✅ | `git diff src/publisher.ts`：`applyCtaToArticle` 就在 `runArticleGeneration` 存在性检查之后（reuse 路径同样经过） |
| S5 控制台/示例 | ✅ | `src/console/server.ts:270` `OBJECT_ENTRY_KEYS = [..., "cta"]`；`config.example.json` 顶层 + gaoh 账号级 |
| S6 自测 | ✅ | `bun tools/cta-selftest.ts` → **13 PASS / ALL PASS** |
| S7 引擎验收 | ✅（AC4/AC5 见下） | `BUILD_OK`；`TSC_OK`；`publish -a second --date 2026-10-20 --reuse --dry-run` → `cta: appended (from prompts/cta/second.md (chars=156))`；gaoh → `cta: appended (from prompts/cta/gaoh.md (chars=161))`；二次跑 second → `cta: present (tail hits=6)`；`cta.enabled=false` → `cta: disabled (config — CTA 已关闭)` 且文件 76B 未变 |
| AC6 控制台路径 | ✅ | 内存 DB + `generateArticle(db,cfg,id,date,{runner:真实 runArticleGeneration(reuse)})` → `2026-10-22-一次函数图象.v1.md` 尾部含 CTA；AI 已写引导语变体 → `cta: present (tail hits=2)`（不重复） |
| S8 250 真机 | ✅ 通过 | `rsync src/ prompts/` → 250（含 `prompts/cta/`）；250 `BUILD_OK` / `TSC_OK` / `bun tools/cta-selftest.ts` ALL PASS；两账号 `--reuse --dry-run` → `cta: appended (chars=156 / 161)`；真机 `publish --force --reuse` → `drafts --date 2026-10-16` 两账号 **✅ 正文校验**（second body 3098→3224、gaoh 3088→3219）；**只读探针读草稿 DOM** 末尾 320 字为引导语、**动作词 6/6** |
| 附带发现 E1 | ✅ 已记录 | 真机 `New tab not found: mp.weixin.qq.com`（重复 mp 桩 tab 干扰 skill `waitForNewTab`）→ 关桩 tab（保留带 token 的 home）后重跑成功；沉淀 `.trellis/spec/engine/error-handling.md` §E1；`cleanupAppmsgTabs` 扩展留待单独评审 + G2 |
| S9 文档 | ✅ | `AGENT.md`（S18 行 / 任务地图 / §5 Checkpoint / §9 变更日志）；`TREE.md`（`bash tools/repomap.sh`）；`.trellis/spec/engine/ai-determinism.md`（CTA 作为第二例）；`src/README.md`（新增 `cta.ts` 段 + publisher 坑位补充） |

**遗留**：AC4 的「开发机 dry-run 全绿」受本机环境限制（缺 `convert` / `baoyu-post-to-wechat` skill，与本改动无关）——已在 250 完成等价真机验收（AC5）。

## 验收清单（收口）

| AC | 状态 | 证据 |
|---|---|---|
| AC1 两账号文末含引导语（本地） | ✅ | `cta: appended (chars=156/161)` + 文件 tail |
| AC2 幂等/不误判/字节一致 | ✅ | `bun tools/cta-selftest.ts` **13 PASS** |
| AC3 build + tsc | ✅ | 251 与 250 均 `BUILD_OK` / `TSC_OK` |
| AC4 dry-run 不阻断 | ✅（250） | 250 两账号 `--reuse --dry-run` → `dry-run ok`（开发机环境缺 convert/skill） |
| AC5 250 真机发布 + 正文校验 + 末尾可见 | ✅ | `drafts --date` ✅ 正文校验；草稿 DOM 末 320 字含引导语、动作词 6/6 |
| AC6 控制台路径快照带 CTA | ✅ | 内存 DB `generateArticle` → `.v1.md` 含 CTA；AI 已写时不重复 |
| AC7 关闭开关 | ✅ | `cta: disabled (config — CTA 已关闭)` + 文件未变 |
