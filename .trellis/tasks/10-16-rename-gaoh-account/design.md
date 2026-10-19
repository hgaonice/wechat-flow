# Design：账号改名（每天讲点理）

## 1. 改名链路（真源 → 派生 → 消费方）

```
                      ┌──────── 仓库真源（git） ────────┐
                      │ config.example.json             │
                      │ prompts/cta/gaoh.md  ← {{accountName}} 占位符化
                      │ README.md / docs/操作手册.md     │
                      │ tools/gen-grade9-plans.ts       │
                      └─────────────────────────────────┘

   ┌── 250 控制台 DB（运行时真源） ──┐
   │ accounts.id=2                   │  PUT /api/accounts/2 { overrides: {...} }
   │  display_name / author          │ ──► updateAccount() ──► syncConfigFile()
   │  overrides_json（三键）          │      + audit(account.update)
   └─────────────────────────────────┘
                    │
                    ▼
            250 config.json（派生产物，勿手改）
                    │
                    ▼  worker 每个任务重新 loadConfig(row.alias)  ← 所以不用重启
   引擎消费：prompts/article.md({{accountName}}) / prompts/cta/gaoh.md / cover 副标题
            / 邮件 subjectPrefix / 草稿 author 署名
                    │
                    ▼
   250 data/gaoh/articles/*.md 的 frontmatter author（历史文件，sed 对齐）
```

**关键点**
1. **只改 DB，不手改 `config.json`**：手改会被下次 `syncConfigFile()` 覆盖（spec/console/data-model.md 明确 `config.json` 是派生产物）。
2. **不需要重启 `wechat-console`**：`worker.ts:63` 每个任务 `loadConfig(row.alias)` 重新读盘（与上次 CTA 改 `src/` 不同——那是代码，不重启不生效）。
3. `prompts/cta/gaoh.md` 占位符化后，**以后的改名只需改 DB 三键**。
4. 文章提示词 `/cover 副标题` 走 `cfg.accountName`，自动跟随。

## 2. 250 侧改名操作（唯一有状态改动）

复用 `tools/upload-plans-250.py` 的登录范式（250 本机 `.credentials-note` 取控制台账号/密码；`BASE=http://127.0.0.1:8787`），**一次性脚本**（不新增仓库工具，命令与响应写入任务 `implement.md` 作证据）：

```python
# 1) 读当前 overrides（GET /api/accounts/2）→ 2) 只改三个键 → 3) PUT 回去
entry["displayName"]  = "每天讲点理"
entry["author"]       = "每天讲点理"
entry["subjectPrefix"] = "[每天讲点理] "
PUT /api/accounts/2  body = {"overrides": entry}
```

- **为什么必须回传完整 `overrides`**：`PUT` 要求 `body.overrides` 为对象并整体落库（不是 patch），漏键=丢配置。
- **幂等**：重复执行结果相同；再次执行不会产生副作用（`updateAccount` 覆盖写 + 一条 audit）。
- **白名单校验**：`assertEntryTypes()` 只允许既有键类型；本次仅改字符串，安全。
- **副作用（预期）**：`syncConfigFile()` 原子回渲染 `config.json`；此时若引擎正在跑任务，任务内已读的 cfg 不受影响（下一任务用新名）。
- **回滚**：保留旧三值（`gaoh的技术分享` / `gaoh的技术分享` / `[gaoh的技术分享] `），改回后重跑同一段脚本即可；代码/文案侧回滚 = `git revert`（一次 commit）。

## 3. 文件级改动清单

| # | 文件 | 改动 | 校验 |
|---|---|---|---|
| 1 | `prompts/cta/gaoh.md` | 末行 → `> 关注「{{accountName}}」，每天一个理科小道理，我们下次接着聊。` | 渲染含「每天讲点理」且 ≥3 动作词 |
| 2 | `config.example.json` | `displayName/author/subjectPrefix` 三处 | grep 旧名 0 |
| 3 | `README.md` | 2 处示例（第 178/221 行附近） | 同上 |
| 4 | `docs/操作手册.md` | 账号表 + 示例配置（第 58/340/341/349 行附近） | 同上 |
| 5 | `tools/gen-grade9-plans.ts` | `ACCOUNTS.gaoh.displayName` → 新名；角度/标题模板措辞 `【技术视角】`→`【理科视角】`、`拆解九上数学｜`→`每天一个理科小道理｜`（**只影响未来重新生成计划，不改已入库的 62 行**） | `tsc` 通过 |
| 6 | `AGENT.md` | §1 进度看板/§3 任务地图中的**当前状态**文字；§9 新增改名记录（含 old→new 与原因） | grep |
| 7 | 250 `data/gaoh/articles/*.md`（8 文件） | `sed -i.bak 's/gaoh的技术分享/每天讲点理/g'` | grep 旧名 0 |
| 8 | 250 草稿（10-16 gaoh） | 改完文件后 `publish --force --reuse` 重发一次 | `drafts` ✅ 正文校验 + DOM 末尾含新名 |

**边界（R6）**：`AGENT.md §9 历史日志`、`.trellis/tasks/archive/**`、`data/gaoh/{logs,sessions}` **不改**（历史事实），另在 §9 顶部记录改名。如用户要求"连历史记录也替换"，执行 `sed` 白名单外全量替换即可（一条命令，风险低）。

## 4. 风险与取舍

| 风险 | 评估 | 处置 |
|---|---|---|
| 手改 `config.json` 被回渲染覆盖 | 高（会静默回退） | 只走 API；改完读回校验 |
| PUT 漏键导致 `emailTo`/`cover` 丢失 | 中 | 回传完整 overrides；改后比对 7 个关键键 |
| 邮件前缀变更影响收件人识别 | 低 | `subjectPrefix` 只是标题前缀；执行后可见 |
| 历史文章 sed 误伤正文 | 低 | 只替换精确串 `gaoh的技术分享`；先 `grep -c` 计数、后 `grep -c` 复核（备份 `.bak`） |
| 已发布草稿仍是旧署名 | 中（无法回炉全部） | 明确非目标；10-16 重发；以后重发自动新名 |
| `tools/gen-grade9-plans.ts` 措辞改动引发"计划与库不一致" | 低 | 已入库计划不动（R7）；仅注释/模板影响未来生成 |

## 5. 不做

- 不建 CLI/工具脚本（一次性操作，脚本与响应写入任务文档即可）。
- 不改 `src/**`（零代码改动 → `build`/`tsc` 是回归证明，而不是功能验证）。
- 不做 A/B 或双名并行期。
