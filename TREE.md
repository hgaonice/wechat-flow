# TREE.md · 文件与符号索引（自动生成，勿手改）

> 生成命令：`bash tools/repomap.sh`　更新时间：2026-10-16 23:43:46
> 用途：规划时先读本文件替代 `ls` 与整读源码；改动代码后请重跑本脚本。
> 相关：[ARCHITECTURE.md](./ARCHITECTURE.md) · [src/README.md](./src/README.md) · [AGENT.md](./AGENT.md)

```text
wechat-flow/
  bin
  content
  deploy
  deploy/systemd
  docs
  docs/handoffs
  docs/img
  out
  out/plans
  prompts
  prompts/cta
  src
  src/console
  tools

[src/ 模块]
src/browser.ts
src/cli.ts
src/config.ts
src/console/agent/events.ts
src/console/agent/extensions/console-decision.ts
src/console/agent/extensions/pi-ambient.d.ts
src/console/agent/frames.ts
src/console/agent/manager.ts
src/console/agent/rpc.ts
src/console/auth/rbac.ts
src/console/auth/sessions.ts
src/console/auth/users.ts
src/console/bun.d.ts
src/console/config/resolve.ts
src/console/content/generate.ts
src/console/crypto/secrets.ts
src/console/db/dao/accounts.ts
src/console/db/dao/articles.ts
src/console/db/dao/audit.ts
src/console/db/dao/chats.ts
src/console/db/dao/emails.ts
src/console/db/dao/secrets.ts
src/console/db/dao/settings.ts
src/console/db/dao/tunnels.ts
src/console/db/import-config.ts
src/console/db/migrate.ts
src/console/db/render-config.ts
src/console/db/schema.ts
src/console/http/chat-sse.ts
src/console/http/ratelimit.ts
src/console/http/respond.ts
src/console/http/router.ts
src/console/http/sse.ts
src/console/http/static.ts
src/console/jobs/plans.ts
src/console/jobs/queue.ts
src/console/jobs/scheduler.ts
src/console/jobs/types.ts
src/console/jobs/worker.ts
src/console/main.ts
src/console/notify/tunnel-mail.ts
src/console/server.ts
src/console/tunnel/cloudflared.ts
src/console/types.ts
src/console/verify-ac3.ts
src/cover.ts
src/cta.ts
src/date.ts
src/log.ts
src/mailer.ts
src/math.ts
src/media.ts
src/notify.ts
src/pi.ts
src/planner.ts
src/prompts.ts
src/publisher.ts
src/session.ts
src/state.ts
src/wechat.ts
```

## src/ 模块与导出符号

### `src/browser.ts`  (170 行)
> Browser (Chrome CDP) publishing support.

导出：`BrowserConfig, defaultBrowserConfig, resolveProfileDir, displayUp, cdpVersion, ensureDisplay, ensureChrome, ensureBrowser, checkBrowser`

### `src/cli.ts`  (517 行)
>  Command-line entry: parse argv, resolve target accounts (-a/--all), dispatch to modules.

导出：（无，或为可执行入口）

### `src/config.ts`  (359 行)

导出：`SRC_DIR, APP_DIR, CONFIG_PATH, ModelCfg, AccountCfg, AppConfig, defaultAlias, AccountInfo, listAccounts, resolveConfig, loadConfig, ensureDirs`

### `src/console/agent/events.ts`  (110 行)
> In-process chat event bus (C4, I4-5 / design.md D5).

导出：`ChatEvent, Replay, ChatListener, ChatBus`

### `src/console/agent/extensions/console-decision.ts`  (169 行)
> Console decision extension for a console-spawned `pi --mode rpc` session

导出：`READ_ONLY_TOOLS, isReadOnly, isForbidden, needsApproval, AskKind, ConsoleAskParams`

### `src/console/agent/extensions/pi-ambient.d.ts`  (83 行)
> Local ambient declarations for the pi packages an extension may import.

导出：（无，或为可执行入口）

### `src/console/agent/frames.ts`  (40 行)
> Strict JSONL frame decoder for the pi RPC transport (C4, I4-1).

导出：`FrameDecoder, createFrameDecoder`

### `src/console/agent/manager.ts`  (826 行)
> Chat session manager (C4, I4-5 / design.md D1, D3, D4, D6, D8, D9, D13).

导出：`ChatActor, ChatManagerDeps, SessionView, MessageView, DecisionView, ChatDetail, ChatManager, chatEventName`

### `src/console/agent/rpc.ts`  (282 行)
> Long-lived `pi --mode rpc` client (C4, I4-2 / design.md D2, D3).

导出：`RpcRecord, RpcExitInfo, SpawnRpcOptions, SendOptions, RpcHandle, spawnRpc`

### `src/console/auth/rbac.ts`  (47 行)
>  Central RBAC decision point. Handlers must not re-implement these rules.

导出：`AuthContext, authContextOf, isAdmin, assertAdmin, canAccessAccount, assertAccountAccess, assertAccountAccessById, visibleAccountIds`

### `src/console/auth/sessions.ts`  (187 行)
> Cookie sessions + login throttling.

导出：`SESSION_COOKIE, DEFAULT_TTL_HOURS, MAX_LOGIN_ATTEMPTS, ATTEMPT_WINDOW_MIN, SessionContext, ttlHours, createSession, lookupSession, touchSession, destroySession, destroyUserSessions, purgeExpiredSessions, recordAttempt, failedAttempts, LockState, lockState, clearAttempts, parseCookie, sessionCookie, clearSessionCookie, csrfEqual`

### `src/console/auth/users.ts`  (104 行)
>  Users: CRUD + argon2id password hashing (Bun.password).

导出：`Role, ROLES, USERNAME_RE, MIN_PASSWORD_LEN, UserRow, PublicUser, toPublic, listUsers, countUsers, countAdmins, getUserById, getUserByUsername, validateUsername, validatePassword, validateRole, hashPassword, createUser, setPassword, verifyPassword, setRole, setDisabled`

### `src/console/bun.d.ts`  (77 行)
> Minimal ambient types for the Bun runtime APIs used by the console.

导出：（无，或为可执行入口）

### `src/console/config/resolve.ts`  (68 行)
> Config resolution helpers: DB ↔ `config.json`.

导出：`Source, buildRawConfig, renderConfigObject, accountEntry, effectiveAccount, overrideKeys, keySource, removeOverride`

### `src/console/content/generate.ts`  (192 行)
> Article generation orchestration (C3).

导出：`ArticleRunner, SnapshotResult, versionedPath, snapshotVersion, DraftRecordInput, DraftRecordResult, recordDraftResult, GenerateArticleOptions, GenerateArticleResult, generateArticle`

### `src/console/crypto/secrets.ts`  (94 行)
> Credential encryption (AES-256-GCM) + master-key loading.

导出：`MASTER_KEY_BYTES, KEY_VERSION, defaultKeyPath, loadMasterKey, initMasterKey, Encrypted, encryptSecret, decryptSecret, sha256Hex, randomToken, safeEqual`

### `src/console/db/dao/accounts.ts`  (192 行)
> Accounts DAO + owner grants.

导出：`AccountRow, listAccountRows, getAccountById, getAccountByAlias, getAccountByCdpPort, parseOverrides, insertAccount, updateAccount, deleteAccount, usedCdpPorts, suggestCdpPorts, accountIdsForUser, grantAccount, revokeGrant, setGrants, grantRowsForUser`

### `src/console/db/dao/articles.ts`  (170 行)
> Articles + drafts DAO (C3).

导出：`ArticleRow, DraftRow, nextVersion, ArticleInput, DraftInput, insertArticle, getArticle, ListArticlesOptions, listArticles, listVersions, setArticleStatus, insertDraft, getDraft, listDrafts`

### `src/console/db/dao/audit.ts`  (48 行)
>  Append-only audit trail (logins, account/config changes, denied access).

导出：`AuditEntry, recordAudit, AuditRow, recentAudit`

### `src/console/db/dao/chats.ts`  (386 行)
> Chat sessions / messages / decisions DAO (C4, I4-3 / design.md D10, D6).

导出：`CHAT_STATUSES, ChatStatus, DECISION_METHODS, DecisionMethod, DecisionStatus, ChatSessionRow, ChatMessageRow, DecisionRow, CreateChatSessionInput, createChatSession, getChatSession, listChatSessions, listLiveChatSessions, setChatStatus, touchChatSession, setChatPiRefs, deleteChatSession, ChatMessageInput, insertChatMessage, listChatMessages, DecisionInput, InsertDecisionResult, insertDecision, getDecision, getDecisionByRequest, ListDecisionsOptions, listDecisions, AnswerDecisionInput, answerDecision, expireDecision, loseDecisionsForSession, ChatLostCounts, markChatLost, closeChatSession, countPendingDecisions, pendingCountsForAccount, reapStaleChats`

### `src/console/db/dao/emails.ts`  (65 行)
> `account_email` DAO — per-account recipients for control-plane mail (C5).

导出：`EmailRow, EmailInput, parseEmailList, getEmail, upsertEmail, deleteEmail`

### `src/console/db/dao/secrets.ts`  (126 行)
> `secrets` DAO — encrypted credential storage (I25: ciphertext only).

导出：`SECRET_KINDS, SecretKind, isSecretKind, SecretMeta, SecretCipher, listSecretMetas, getSecretCipher, putSecret, deleteSecret`

### `src/console/db/dao/settings.ts`  (42 行)
> Global config (`settings` key = 'global') storage.

导出：`GLOBAL_KEY, getSetting, setSetting, delSetting, getGlobalRaw, setGlobalRaw`

### `src/console/db/dao/tunnels.ts`  (154 行)
> `tunnels` DAO — the control-plane tunnel ledger (C5).

导出：`TunnelStatus, TunnelKind, TunnelRow, getTunnel, getCurrentTunnel, listTunnels, OpenTunnelInput, openTunnel, setTunnelStatus, HeardPatch, markHeard, markNotified, clearNotified, bumpNotifyAttempts`

### `src/console/db/import-config.ts`  (107 行)
> One-time import: existing `config.json` → DB (`settings` + `accounts`).

导出：`ImportResult, importConfig`

### `src/console/db/migrate.ts`  (41 行)
>  DB connection + forward-only migration runner (see spec/console/data-model.md §4).

导出：`openDb, schemaVersion, migrate`

### `src/console/db/render-config.ts`  (38 行)
> Render the DB back to `config.json` (the engine still reads the file).

导出：`RenderResult, renderConfig`

### `src/console/db/schema.ts`  (267 行)
> v1 schema baseline for the console DB.

导出：`Migration, MIGRATIONS`

### `src/console/http/chat-sse.ts`  (106 行)
> SSE bridge for chat sessions (C4, I4-6 / design.md D5).

导出：`ChatSseOptions, streamChatEvents`

### `src/console/http/ratelimit.ts`  (109 行)
> In-process token-bucket rate limiter (C6, I29 / design.md D29).

导出：`RateLimitResult, RateLimiterOptions, RateLimiter`

### `src/console/http/respond.ts`  (64 行)
>  Uniform HTTP responses + the single error type handlers throw (spec/console/api.md §1).

导出：`ErrorBody, HttpError, badRequest, unauthorized, forbidden, notFound, conflict, tooMany, json, ok, fail, html, text, noContent, redirect`

### `src/console/http/router.ts`  (85 行)
> Tiny dependency-free router. Patterns are literal segments plus `:name`

导出：`Handler, Match, Router`

### `src/console/http/sse.ts`  (148 行)
> Zero-dependency Server-Sent Events for job progress (C3, spec/console/api.md §3).

导出：`StreamOptions, streamJobEvents`

### `src/console/http/static.ts`  (45 行)
>  Static UI serving from `src/console/ui` (no bundler, no dependencies).

导出：`serveUi`

### `src/console/jobs/plans.ts`  (243 行)
> Plans: DB is the console's source of truth; the engine's on-disk

导出：`PeriodType, PlanValidation, validatePlanInput, PlanFilter, listPlans, getPlan, upsertPlan, findPlanDay, materializePlans, fillMissingPlansFromFiles, importPlansFromFiles`

### `src/console/jobs/queue.ts`  (211 行)
> Job queue: enqueue, atomic claim, progress, and terminal transitions.

导出：`EnqueueOptions, enqueue, getJob, ListJobsOptions, listJobsForAccount, listJobLogs, appendLog, setProgress, claimNext, finish, cancel, reapStartup, hasPublishJobForDate, hasActivePlanJob, countFailed, lastFailureAt`

### `src/console/jobs/scheduler.ts`  (219 行)
> Scheduler: scan due plans on a timer and enqueue jobs (idempotently).

导出：`TZ, ScheduleConfig, readSchedule, ScheduleAction, schedulerTick, SchedulerHandle, SchedulerOptions, startScheduler`

### `src/console/jobs/types.ts`  (109 行)
> Job / plan type model for the console queue (C2).

导出：`JobKind, ALL_KINDS, EXECUTABLE_KINDS, isJobKind, JobStatus, JobRow, JobLogRow, PlanRow, PlanDay, PlanItems, JobPayload, parseJobPayload, parseItems`

### `src/console/jobs/worker.ts`  (262 行)
> Worker: drain the job queue and call the engine.

导出：`WorkerHandle, WorkerOptions, executeJob, startWorker`

### `src/console/main.ts`  (352 行)
> wechat-flow console entry point (C1).

导出：（无，或为可执行入口）

### `src/console/notify/tunnel-mail.ts`  (319 行)
> C5 tunnel-change mail (design §5).

导出：`SendFn, NotifyOpts, NotifyResult, internalIpv4, consolePort, WechatLogin, decryptWechatLogin, formatStamp, TunnelMailBody, buildTunnelMail, notifyTunnelChange`

### `src/console/server.ts`  (1411 行)
> Console HTTP app: routing, session middleware, CSRF, RBAC, and the C1 API.

导出：`AppState, OpsDeps, Ctx, App, createApp`

### `src/console/tunnel/cloudflared.ts`  (484 行)
> C5 cloudflared quick-tunnel supervisor (design §4).

导出：`TunnelStatusView, TunnelDeps, TunnelSupervisor`

### `src/console/types.ts`  (35 行)
>  Very small JSON value model shared by the console config layer.

导出：`Json, JsonObject, isPlainObject, asObject, isEmptyObject, jsonEqual`

### `src/console/verify-ac3.ts`  (119 行)
> AC-3 verifier: prove that a DB-derived `AppConfig` is field-for-field equal to

导出：`AccountDiff, Ac3Report, verifyAc3, formatAc3`

### `src/cover.ts`  (153 行)
>  Generate a deterministic 900x500 cover via ImageMagick (`convert`).

导出：`generateFfmpegCover, detectCjkFont, CoverInput, generateTemplateCover`

### `src/cta.ts`  (167 行)
> 文章末尾互动引导语（CTA）——确定性后处理。

导出：`ACTION_WORDS, TAIL_CHARS, MIN_ACTION_HITS, MIN_BLOCK_ACTIONS, CtaApplyResult, countActionWords, splitFrontmatter, hasCtaHint, ensureCtaBlock, resolveCtaBlock, applyCtaToArticle`

### `src/date.ts`  (45 行)
>  Date helpers (Asia/Shanghai by default).

导出：`todayInTz, addDays, isoWeek, weekRange, WEEKDAY_CN, weekdayCn`

### `src/log.ts`  (44 行)

导出：`initLog, log`

### `src/mailer.ts`  (126 行)
> Email notifications are delegated to the pre-installed `email-sender` skill

导出：`EmailSkillConfig, EmailConfig, MailInput, sendMail, checkEmail`

### `src/math.ts`  (193 行)
> math.ts — 把文章里的 LaTeX 公式（$...$ / $$...$$）在发布前转成内联 SVG。

导出：`MathOptions, MathResult, mathEnabled, renderFormulasInMarkdown, hasFormula`

### `src/media.ts`  (119 行)
> media.ts — 发布前的「媒体预处理」：

导出：`MediaResult, mediaDirFor, ensureManimGif, prepareArticleForPublish`

### `src/notify.ts`  (54 行)

导出：`NotifyMessage, notify`

### `src/pi.ts`  (216 行)
> Thin, version-independent integration with the pi CLI.

导出：`PiRunOptions, PiRunResult, runPi, resolvePiBin`

### `src/planner.ts`  (161 行)

导出：`PlanDay, Plan, planPath, loadPlan, findEntryForDate, runPlan, proxyEnv`

### `src/prompts.ts`  (10 行)

导出：`renderTemplate`

### `src/publisher.ts`  (417 行)

导出：`PublishRunResult, parseFrontmatter, ArticleGenResult, buildArticlePrompt, runArticleGeneration, runPublish`

### `src/session.ts`  (504 行)
> WeChat MP login-session helpers (browser/CDP method).

导出：`EmailCfg, LoginProbe, emailQrImage, focusMpTab, EnsureLoginOptions, EnsureLoginResult, ensureLoggedIn`

### `src/state.ts`  (56 行)

导出：`PublishedRecord, StateFile, atomicWriteJson, loadState, saveState, isPublished, recordPublished`

### `src/wechat.ts`  (1033 行)
>  Deterministic publisher: drives the baoyu-post-to-wechat skill script via bun.

导出：`PublishOptions, PublishResult, publishArticle, BrowserPublishOptions, publishArticleBrowser, DraftItem, listDraftTitles, listDrafts, verifyDraftPublished, verifyDraftBody, cleanupAppmsgTabs, SetCoverOptions, CoverResult, setDraftCover, probeDraftCover`

## bin/ 脚本

| 文件 | 用途 |
|---|---|
| `bin/manim-gif.sh` | manim-gif.sh — 把一个 manim 场景渲染成适合公众号正文的 GIF。 |
| `bin/send-image.py` | Send an image (e.g. the WeChat login QR screenshot) as an email attachment. |
| `bin/tex2svg.py` | — |

## tools/ 脚本

- `tools/cta-selftest.ts` — —
- `tools/draft-probe.ts` — —
- `tools/gen-grade9-plans.ts` — —
- `tools/repomap.sh` — repomap.sh —— 生成/刷新 TREE.md（文件 + 符号索引，Aider repomap 的轻量等价物）
- `tools/upload-plans-250.py` — —
