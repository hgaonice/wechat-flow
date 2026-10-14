# Journal - gaoh (Part 1)

> AI development session journal
> Started: 2026-10-12

---



## Session 1: 上下文治理：.trellis + AGENT.md + 分层文档 + repomap (S9)
<!-- trellis-session: v=2 fp=94198bfdc194d5a9 -->

**Date**: 2026-10-12
**Task**: 上下文治理：.trellis + AGENT.md + 分层文档 + repomap (S9)
**Branch**: `main`

### Summary

为 wechat-flow 建立可续接的工程上下文体系；引擎零逻辑改动，bun build 通过。

### Main Changes

- trellis init（.pi/.agents/AGENTS.md）；spec/frontend -> spec/engine（5 篇真实约定）
- 新增 AGENT.md（续接入口/看板/GATE/任务地图/Checkpoint/证据规则）、ARCHITECTURE.md、src/README.md、TREE.md
- 新增 tools/repomap.sh（生成 TREE.md，--check 幂等）；src/cli.ts 仅加一句文件头注释
- 建任务 10-12-context-governance（进行中）、10-12-cover-auto-upload（backlog）；归档 00-bootstrap-guidelines

### Git Commits

(No commits - planning session)

### Testing

- [OK] bash tools/repomap.sh --check -> 退出 0
- [OK] bun build --target=bun src/cli.ts -> 退出 0
- [OK] get_context.py --mode packages -> Spec layers: engine

### Status

[OK] **Completed**

### Next Steps

- T10：用户确认 G4 后归档 10-12-context-governance
- 按需装 devDeps 使 bunx tsc --noEmit 可用


## Session 2: S9 归档 + S10 封面自动上传调研（G5 待选型）
<!-- trellis-session: v=2 fp=408fbb693970ef16 -->

**Date**: 2026-10-12
**Task**: S9 归档 + S10 封面自动上传调研（G5 待选型）
**Branch**: `main`

### Summary

确认 G4 并归档上下文治理任务；完成封面自动上传的只读调研，产出候选方案，等 G5 选型。

### Main Changes

- G4 确认：归档 10-12-context-governance -> archive/2026-10/
- 启动 10-12-cover-auto-upload（in_progress），产出 research.md：上游 skill v1.118.2 浏览器路径不支持封面（文档化限制，SKILL.md Feature Comparison）
- 封面能力仅在 API 路径（wechat-api.ts --cover -> thumb_media_id）；给出 O-A(API/Remote)/O-B(CDP 封面弹窗)/O-C(上游补丁) 候选
- 更新 AGENT.md 看板/门/任务地图/Checkpoint/变更日志/下一步

### Git Commits

(No commits - planning session)

### Testing

- [OK] task.py list -> 1 个 in_progress
- [OK] bash tools/repomap.sh --check -> 0；bun build -> 0

### Status

[OK] **Completed**

### Next Steps

- G5：250 上验证出口 IP 能否进白名单（决定 O-A/O-B），再实施封面


## Session 3: S10 O-B 实现：封面自动上传（CDP 封面弹窗）
<!-- trellis-session: v=2 fp=036625c7febd13e6 -->

**Date**: 2026-10-12
**Task**: S10 O-B 实现：封面自动上传（CDP 封面弹窗）

### Summary

G5 选定 O-B 并完成实现：wechat.ts 新增 setDraftCover/probeDraftCover；cover 命令；cover.uploadToDraft 开关（默认关，失败降级）。bun build + tsc 通过；待 250 真机验收。

### Main Changes

- G5 选定 O-B（CDP 驱动编辑器封面弹窗），据 design.md 实施
- src/wechat.ts: setDraftCover/probeDraftCover + COVER_SELECTORS/COVER_*_EXPR + collectFileInputs/findCoverFileInput（DOM 树遍历，覆盖 iframe/shadow）
- src/config.ts + config.example.json: cover.uploadToDraft（默认 false，可按账号覆盖）
- src/publisher.ts: 正文校验后集成，try/catch 降级，不改发布成功判定
- src/cli.ts: cover 命令（--date/--title/--cover/--probe/-a/--all）+ USAGE
- devDeps: typescript@^5 + @types/node@^22（仅类型检查，runtime 仍零依赖）；package.json 加 cover/typecheck 脚本
- 文档同步: README.md、docs/操作手册.md(§2.3)、src/README.md、ARCHITECTURE.md、AGENT.md、spec/engine
- 任务: prd.md 更新 + design.md/implement.md 产出；implement.jsonl 补 design.md

### Git Commits

(No commits - planning session)

### Testing

- [OK] [OK] bun build --target=bun src/cli.ts -> exit 0
- [OK] [OK] bunx tsc --noEmit -> 0 错误
- [OK] [OK] bun src/cli.ts -> USAGE 含 cover；config.example.json JSON 合法
- [OK] [PENDING] 250 真机: cover --probe 校准选择器 -> cover --date -> publish 过 G2

### Status

[OK] **Completed**

### Next Steps

- 250 上: eval $E; bun src/cli.ts cover --date <d> --probe，按 dump 更新 COVER_SELECTORS
- 250 上: cover --date <d> 实测 -> 开 cover.uploadToDraft:true -> publish --reuse --force 过 G2
- 验收后归档 10-12-cover-auto-upload，固化选择器取值


## Session 4: S10 真机验收通过 + 归档：封面自动上传 O-B（250）
<!-- trellis-session: v=2 fp=6599f20d09cd9da5 -->

**Date**: 2026-10-12
**Task**: S10 真机验收通过 + 归档：封面自动上传 O-B（250）
**Branch**: `main`

### Summary

在 250 真机完成 S10 O-B 验收：成功路径（设封面 + 持久化 + 完整发布）与降级路径（封面失败不阻断正文）均通过；真机修正保存/轮询/自动选中/去掉缩略图兜底；任务归档并写 deploy/ACCEPTANCE-250.md。

### Main Changes

- 真机修正（src/wechat.ts）：保存点 #js_submit button（容器无效）；确认后轮询封面背景图；上传后等自动选中再点下一步；去掉缩略图兜底（避免误设旧图）
- 验收证据：cover 成功 -> 'draft cover set ✓ (before=- -> after=https://mmbiz.qpic.cn/...)'; 重开编辑器 --probe 复读 js_cover_preview_new bg 为真实 URL（持久化）
- 完整发布：开 cover.uploadToDraft=true 后 publish -a second --date 2026-10-13 --reuse --force -> 正文校验 + draft cover set ✓ + 邮件送达
- 降级：非法 cover.png -> cover 命令 60s 后 '❌ 封面未设置（upload）…' exit 1（不误设、不抛）；发布中封面阶段 CDP 超时 -> WARN + publish 仍 done + 邮件提示手动选封面
- 文档：新增 deploy/ACCEPTANCE-250.md（可复跑验收清单）；更新 AGENT.md（看板/GATE/ADR D10/变更日志/Checkpoint）、spec/engine/verification.md、docs/操作手册.md §2.3、task implement.md
- 任务：10-12-cover-auto-upload 归档 -> archive/2026-10/

### Git Commits

(No commits - planning session)

### Testing

- [OK] bash tools/repomap.sh --check -> exit 0
- [OK] bun build --target=bun src/cli.ts -> exit 0
- [OK] bunx tsc --noEmit -> 0 错误
- [OK] 250: cover --probe / cover --date / publish --reuse --force / drafts --date 全绿
- [OK] 250: 降级（非法图 / CDP 超时）publish 仍成功

### Status

[OK] **Completed**

### Next Steps

- 可选：清理 250 上重复草稿（反复 --force 遗留）
- 可选：cover 支持 --all 回填历史草稿；repomap 升级 AST 级

---

## Session 5: 控制台 M0 规划收口（S11）：spec/console 骨架 + AGENT.md 更新
<!-- trellis-session: v=2 -->

**Date**: 2026-10-13
**Task**: 10-13-wechat-flow-console（父任务 · M0 收口）
**Branch**: `main`

### Summary

用户确认「按控制台路线推进」。完成 M0 规划收口 P6–P8：新建 `.trellis/spec/console/` 五篇 v0 契约，更新 `AGENT.md` 看板（S11–S17）、GATE（G6/G7）、任务地图（C1–C6）、ADR（D11–D14），并勾选父任务 `implement.md` 的 P6–P8。

### Main Changes

- 新增 `.trellis/spec/console/{index,api,data-model,security,agent-session}.md`（契约先行，源=父任务 design.md + pi 官方 rpc 文档）
- `AGENT.md`：§1 新增「控制台路线 S11–S17」表；§2 新增 G6/G7；§3 补 6 个子任务行；§5 当前任务改为「M0 已收口 → C1 规划」；§8 补 D11–D14；§9 变更日志；§10 下一步
- 父任务 `implement.md`：P6/P7/P8 打勾（含证据）
- 未触碰 `src/` 与发布链路

### Git Commits

(见随后的 chore(trellis) 提交)

### Testing

- [OK] `.trellis/spec/console/` 5 文件存在
- [OK] AGENT.md 关键小节渲染正常（§1/§5）
- [OK] 未改 `src/`、未改发布链路（本次无代码）

### Status

[OK] **M0 收口完成**（父任务保持 planning，子任务逐个 start）

### Next Steps

- C1 `console-foundation` 规划：补 design.md/implement.md/真实 jsonl → 方案 + 验证命令 + 回滚点 → 用户批准 → `task.py start`


## Session 6: 控制台 C1 基座交付并归档（S12/M1）
<!-- trellis-session: v=2 -->

**Date**: 2026-10-13
**Task**: C1 控制台基座（`10-13-console-foundation`）
**Branch**: `main`

### Summary

实现并交付控制台基座（`src/console/**`）：Bun HTTP 服务 + SQLite(WAL) + 鉴权/RBAC/CSRF + 账号 CRUD/配置继承/导入回渲染 + 静态 UI，**零新增运行时依赖**。AC-1/2/3/4/10 实测通过，trellis-check 独立复核 PASS（5 项缺陷已修），engine CLI 未回退；console spec 校准 v0→v1；任务归档。

### Main Changes

- 新增 `src/console/**`：`main.ts`/`server.ts`、`http/{router,respond,static}.ts`、`auth/{users,sessions,rbac}.ts`、`crypto/secrets.ts`、`db/{schema,migrate,import-config,render-config}.ts` + `db/dao/*`、`config/resolve.ts`、`ui/*`、`bun.d.ts`、`verify-ac3.ts`
- `src/config.ts`：**仅新增** `resolveConfig(raw, alias)` 导出；`loadConfig` 内部改为调用（签名/行为不变）
- `.gitignore`：`console/` → `/console/`（锚定，避免吞掉 `src/console/`）
- 语义要点：配置真相源 = DB（global + 账号条目 **verbatim**）→ 回渲染 `config.json`（`.bak` 不覆盖 + tmp→fsync→rename）；账号热列仅为约束镜像；无 master key/无管理员 fail-fast；登录 5 次/15 分钟锁定；审计含 `actor`/`ok`
- spec 校准：`.trellis/spec/console/{index,api,data-model,security}.md` → v1（node:crypto、verbatim、`login_attempts`、401 code、reset `{key}`）
- 收口：`AGENT.md` §1/§3/§5/§9/§10；本 journal

### Git Commits

- (本次收口提交) feat(console): C1 控制台基座 + spec v1 校准

### Testing

- [OK] `node_modules/.bin/tsc --noEmit` 0 错误；`bun build --target=bun src/console/main.ts` OK
- [OK] `dependencies=undefined`（零新增运行时依赖）
- [OK] AC-1 fail-fast：无 master key → exit 1；0 用户 → exit 1
- [OK] AC-2 `--import-config`：accounts=2、config.json 回写(1733B)、`config.json.bak` 保留原始
- [OK] AC-3 `--verify-ac3` PASS：两账号逐字段一致 + 回渲染 diff=0；`loadConfig` before/after 字节一致
- [OK] AC-4 curl 断言 17+9 项：401/403/409/429、owner 隔离、CSRF、audit `denied`
- [OK] 迁移期：`bun src/cli.ts doctor --all` / `publish --dry-run` 均 exit 0
- [OK] DB：`user_version=1`、`journal_mode=wal`、`foreign_keys=1`、19 表
- [OK] trellis-check 复核 PASS（5 项缺陷修复后回归）

### Status

[OK] **C1 完成并归档**（父任务 M1 收口）

### Next Steps

- C2 `console-scheduler` 规划：周/月计划表 + jobs + 调度器 + 每账号互斥 → 父任务 `implement.md` M2

---

## Session 7: 控制台 C2 调度与任务模型交付并归档（S13/M2a）
<!-- trellis-session: v=2 -->

**Date**: 2026-10-14
**Task**: C2 调度与任务模型（`10-13-console-scheduler`）
**Branch**: `main`

### Summary

在 C1 基座上落地调度与任务模型（`src/console/jobs/**`，886 行）：周/月计划表 + 任务队列 + 进程内 worker（每账号互斥）+ 定时调度器；新增 7 条 API 路由与 `main.ts` 生命周期开关；新增 systemd timer 停用/回退脚本与迁移文档。AC-5/AC-10/AC-11 实测通过，trellis-check 独立复核 PASS-with-issues（无阻塞），engine **零改动**；console spec 校准 v1→v2，任务归档。

### Main Changes

- 新增 `src/console/jobs/{types,plans,queue,worker,scheduler}.ts`
  - `queue`：`enqueue`(+audit) / `getJob` / `listJobsForAccount` / `appendLog` / `setProgress` / `claimNext`（单条原子 `UPDATE ... WHERE NOT EXISTS(running) ... RETURNING`）/ `finish`（仅 `running`）/ `cancel`（仅 `queued`）/ `reapStartup` / `hasPublishJobForDate` / `hasActivePlanJob`（`json_extract(payload_json,'$.date')` 去重）
  - `plans`：`validatePlanInput`（week `YYYY-Www` 且 days∈[1,7] 且日期落在该周内）/ `upsertPlan` / `findPlanDay` / `materializePlans`（DB→文件，tmp+rename 原子）/ `importPlansFromFiles`（跳过 `*.dryrun.json`）/ **`fillMissingPlansFromFiles`（迁移桥，仅 DB 缺该周时采纳 → 控制台编辑永不被回灌）**
  - `worker`：`executeJob`（`plan`→`runPlan`+导入；`publish`→`isPublished`+物化+`runPublish`；`generate`/`regenerate` 在 C2 落 400/`failed`，不伪装成功）/ 启动 `reapStartup` / `stop()` **有界 drain**（`CONSOLE_WORKER_DRAIN_MS`，默认 30s）
  - `scheduler`：单一时钟 `Asia/Shanghai`；publish = 当天在计划内 && `hour≥publishHour` && 未发布 && 无 live job；plan = `weekday===planWeekday` && 本周无计划 && 无 live plan job；`ticking` 防重入 + **启动即 tick**
- `src/console/server.ts`：7 条路由（`GET/PUT /api/accounts/:id/plans`、`GET /api/accounts/:id/plans/find`、`POST/GET /api/accounts/:id/jobs`、`GET /api/jobs/:id`、`POST /api/jobs/:id/cancel`）+ `jobView`/`planView`/`loadJob`；403 `denied` 审计改为**请求局部** `actor`（消除 C1 写死 `unknown` 与共享可变状态）
- `src/console/main.ts`：`serve` 内联 `startScheduler`+`startWorker`（`--no-worker` 关闭）；新增 `--worker` 无头模式；SIGINT/SIGTERM 优雅退出
- `deploy/console-scheduler.md` + `deploy/systemd/{disable,enable}-timer.sh`（`--dry-run` 幂等、不删 unit、可回退）
- `.gitignore` 增 `config.json.bak`
- spec 校准：`.trellis/spec/console/{index,api,data-model,security}.md` → **v2**；`design.md` 补 **I13 计划物化契约**
- 收口：`AGENT.md` §1（S13 ✅ / S14 🟡）/§3/§5/§8（D11–D13 ✅、新增 D15）/§9/§10；本 journal

### 关键决策（本会话新增）

- 调度/worker **内嵌 `serve` 进程**，不再依赖 systemd timer（保留 timer 停用/回退脚本）
- **计划真源 = `plans` 表**，engine 计划文件为派生物（`materializePlans`）；迁移民桥 `fillMissingPlansFromFiles` **DB 优先**
- 到期时刻由数据推导，**不新增表列**（不破坏 C1 已冻结 schema）
- 崩溃安全：启动 reaper 把遗留 `running` 置 `failed('interrupted by restart')`
- `bun:sqlite` 无行返回 `null` 而非 `undefined` → 在 `queue`/`plans` 归一为 `?? undefined`

### Git Commits

- (本次收口提交) feat(console): C2 调度与任务模型（S13/M2a）+ spec v2

### Testing

- [OK] `node_modules/.bin/tsc --noEmit` 0 错误；`bun build --target=bun src/console/main.ts` OK；`dependencies=undefined`
- [OK] 任务层单测 `bun /tmp/wfc-c2-jobs.ts`：**35 passed, 0 failed**（状态机单向 / 每账号 running≤1 / cancel 仅 queued / reap / 去重 / schedule clamp）
- [OK] HTTP e2e `bash /tmp/wfc-c2-http.sh`：CSRF 403、计划校验 200/400、`kind=generate` 400、**AC-11 `failed + error='no plan entry for 1999-01-01; run "plan" first'`**、`queued→running→failed(planner agent failed: timeout)`、互斥 `[(1,1)]`、cancel 200/409、RBAC owner(alpha 403 / beta 200 / settings 403 / POST users 403 / POST beta job 201 / POST alpha job 403)、匿名 401
- [OK] 调度 e2e `bash /tmp/wfc-c2-sched.sh`：启动即刻 tick → 1 条 publish（`created_by=NULL`、`audit actor='scheduler'`、`detail.source='scheduler'`）；再 +12s 仍为 1（幂等）
- [OK] 迁移桥：`fillMissingPlansFromFiles` 首采 1 / 二次 0 / DB 优先；集成实测「仅存在引擎文件计划 → 调度器自动入队 publish，再 tick 为 0」
- [OK] 启动模式：`--no-worker`（不注册调度）/ `--worker`（不监听 HTTP）/ SIGTERM 优雅退出 均实测
- [OK] 失败显形 H5：engine 真调模型遇上游 503 → `status=failed` 且 `error` 非空
- [OK] `bash -n` + `--dry-run`（可重复）systemd timer 脚本；engine 零改动（`git status --porcelain src/ | grep -v src/console/` 为空）
- [OK] trellis-check 独立复核 PASS-with-issues（直接修 5 处死代码 + 403 审计 actor 局部化；D3/D4/D7 本轮同修）

### Status

[OK] **C2 完成并归档**（父任务 M2a 收口）

### Next Steps

- C3 `console-content-workbench` 规划：计划编辑 UI → pi 生成 → 草稿箱推送 → 重生成/版本历史（含 SSE、`articles`/`drafts` 落地）→ 父任务 `implement.md` M2b
- C2 遗留（C6 加固）：计划 job 持续失败无退避（D2）

---

## Session 8: 控制台 C3 内容工作台交付（S14/M2b）
<!-- trellis-session: v=2 fp=c3contentworkbench -->

### Goal

在 C2 的 `jobs`/`plans` 之上补齐内容闭环：计划编辑 → engine 生成文章 → 草稿箱推送 → 重生成与版本历史（含 SSE 进度与失败面板）。

### What Changed

- **engine（唯一改动，附加式）**：`src/publisher.ts` 抽出 `runArticleGeneration(cfg,{date,feedback,reuse})` 与 `buildArticlePrompt(...)`；`runPublish` 改为调用前者。空/缺 `feedback` 时 prompt **字节一致（3012B）**，`runPublish` 生成后区段与 HEAD **diff 相同**；`verifyDraftBody`/`src/wechat.ts`/成功判定均未动。
- **新增**：`src/console/db/dao/articles.ts`（版本链 DAO）、`src/console/content/generate.ts`（`snapshotVersion`/`generateArticle`/`recordDraftResult`）、`src/console/http/sse.ts`（零依赖 SSE）、`src/console/ui/workbench.{html,css,js}`。
- **修改**：`jobs/types.ts`（`generate`/`regenerate` 进 `EXECUTABLE_KINDS`）、`jobs/worker.ts`（真执行两 kind；publish 分支补写 `drafts` + `articles.status='pushed'`）、`server.ts`（5 条路由 + `articleView`/`draftView`/`loadArticle`）、`http/static.ts`、`ui/index.html`、`main.ts`（`idleTimeout:120`）。
- **版本链模型**：engine base `<date>-<slug>.md` 恒=最新（发布读它）；每版快照 `<base>.v<N>.md` 不可变；`articles` 每版一行（`version` 单调、`parent_id` 链）；`drafts.verified` **仅镜像** `runPublish.ok`。
- **文档**：console spec v2→v3（`api.md` §2.3/§3、`data-model.md` I15–I18、`security.md` 文章路由/审计、`index.md`）；`AGENT.md` §1/§3/§5/§8(D16–D18)/§9/§10；`src/README.md` 新增 `console/` 小节并更新 `publisher.ts`；`tools/repomap.sh` 改为递归扫描 `src/**/*.ts`（此前完全漏掉 `src/console/**`）。

### Git Commits

- (本次收口提交) feat(console): C3 内容工作台（S14/M2b）+ spec v3

### Testing

- [OK] `tsc --noEmit` 0 错误；`bun build --target=bun src/console/main.ts` 43 modules；`dependencies=undefined`
- [OK] **prompt 字节一致**：空/缺 feedback `sha256` 相同（3012B）；非空 feedback 仅追加 `## 修改要求（用户反馈）`
- [OK] 单测 `/tmp/wfc-c3-content.ts`：30 项（v1→v3 单调、`parent_id` 链、旧 `.vN.md` 不可变、base=最新、生成失败不落行、`recordDraftResult` 成功/失败/跳过）
- [OK] HTTP e2e `/tmp/wfc-c3-http.sh`：401/403/CSRF、articles 列表/详情、regenerate+audit、generate 201、SSE `job.progress/log/done`、`Last-Event-ID` 不重不漏
- [OK] 失败路径 `/tmp/wfc-c3-fail.sh`（AC-11）：4 类失败均 `failed` + 非空 `error`，0 文章行
- [OK] 假 `pi` worker e2e `/tmp/wfc-c3-worker.sh`：v1 行 + `.v1.md`、v2 父链 + 反馈、v1 快照不可变、base=最新
- [OK] `bash /tmp/wfc-c3-verify.sh` → **pass=7 fail=0**
- [OK] trellis-check 独立复核 **PASS**（8/8 必验项；4 项非阻塞观察；ISSUE-1 的 DAO 注释已按事实收敛）
- [~] 真机（250/G2）待验：真 `pi` 生成、真实微信草稿推送、封面/manim、浏览器手工加载 workbench

### Status

[OK] **C3 完成**（父任务 M2b 收口；2/6 → 3/6 子任务）

### Next Steps

- C4 `console-agent-session` 规划：pi RPC + 严格 JSONL 流式 + 决策卡片人在环 + 最小权限
- C3 遗留：真实推送与 UI 手工项需 250（G2）；`publish` 以 `reuse=false` 绕过 UI 触发时草稿可能挂旧版快照（已记录，UI 固定 `reuse=true`）
- C2 遗留（C6 加固）：计划 job 持续失败无退避（D2）


## Session 9: 控制台 C4 Agent 会话窗口与人在环交付并归档（S15/M3）
<!-- trellis-session: v=2 fp=6172bc8396273f8f -->

**Date**: 2026-10-14
**Task**: 控制台 C4 Agent 会话窗口与人在环交付并归档（S15/M3）
**Branch**: `main`

### Summary

实现「类 HAPI 精简版」：每账号多会话 ↔ `pi --mode rpc` 长活子进程，流式 SSE、extension_ui_request 决策卡片人在环、双层最小权限；engine 与推送链路零改动，零新增运行时依赖。

### Main Changes

- 新增 `src/console/agent/{frames,rpc,events,manager}.ts`：严格 JSONL 切帧（禁 readline）、极简 RPC（按 id 关联）、进程内 ChatBus（500 环 + seq）、会话生命周期（懒 spawn / CONSOLE_CHAT_MAX / CONSOLE_CHAT_TTL_MS / handleExit / reapStale）
- 新增 `agent/extensions/console-decision.ts`（pi 侧最小权限：console_ask 唯一通道 + fail-safe 硬阻断 wechat*/publish*/mail*/backup*）、`db/dao/chats.ts`、`http/chat-sse.ts`、`ui/chat.{html,css,js}`
- `schema.ts` 加 migration v2（chat_sessions.session_file，纯加法）；`server.ts` 加 12 条复数路由 /api/chats/*、/api/decisions（CSRF + 按行 account_id 鉴权）；`main.ts`/`http/static.ts`/`ui/index.html`/`ui/workbench.html` 接线
- 决策 pending→{answered,cancelled,expired,lost}；异常退出/预期关闭/启动回收均同事务清算 pending（I21/I23，closeChatSession/markChatLost），无悬挂

### Git Commits

| Hash | Message |
|------|---------|
| `58d27db` | feat(console): C4 Agent 会话窗口与人在环（S15/M3）+ spec v4 |

### Testing

- [OK] [OK] `tsc --noEmit` 0 错误；`bun build` 49 modules；`dependencies=undefined`；engine `src/pi.ts`/`wechat.ts`/`publisher.ts` 零改动
- [OK] [OK] 单测 /tmp/wfc-c4-unit.ts（frames/ChatBus/chats DAO/rpc 含 closeChatSession 原子性）；fake-pi e2e /tmp/wfc-c4-e2e.sh（流式/决策往返/崩溃 lost/TTL 清算/chat_limit）
- [OK] [OK] `bash /tmp/wfc-c4-verify.sh` → pass=8 fail=0；C3 回归 pass=7 fail=0；trellis-check 首轮 FAIL（唯一阻塞 B1）→ 修复 → 对抗复现 PROBE(S) PASSED + 复审 PASS

### Status

[OK] **Completed**

### Next Steps

- C5 `console-ops-tunnel` 规划：邮箱 + Cloudflare 隧道地址下发 + 凭据加密 + 管理员全局视图（G7）
- 真机（250/G2）待验：真实 pi 流式、pi --extension 加载、浏览器 /chat 手工加载
- C6 加固候选：chat-sse 重放阶段 cleanup no-op（N1）、ChatBus.close 不通知已建 SSE 流（N2）、已 abort 的 signal 不触发清理（N3）
