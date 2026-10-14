# implement.md · C6 执行计划（console-deploy-hardening）

> 依赖 C1–C5。**不改发布链路/engine，零新增运行时依赖。** 设计见 `design.md`（D28–D33 / I29–I34）。
> 每个 I 步骤完成即跑其「验证」；全部完成后 §2 全量回归 + §4 真机。

---

## 0. 开工前置检查

- [x] C1–C5 全部交付并归档（父任务 5/6）。
- [x] 关键决策 G-C6-1..4 已按推荐落档（`design.md` §0）。
- [x] `git status` 干净；HEAD = C5 收口提交。
- [x] 确认 `src/{pi,wechat,publisher,mailer}.ts` 基线哈希（用于“engine 未动”断言）。

---

## 1. 实施顺序（每步含验证）

### I6-1 spec 先行：新增 `spec/console/ops-deploy.md`（v0）
- 内容：部署模式（Mode A/B + 互斥）、systemd 单元契约、限流参数与 429 语义、备份/恢复契约（I30/I31）、
  失败退避（I32）、`/health` 契约（I33）、CDP 不暴露（I34）。
- 验证：文件存在，含 I29–I34 与 D28–D33 映射表。

### I6-2 限流：`http/ratelimit.ts` + `server.ts` 接入
- 新增 `RateLimiter`（令牌桶，纯函数可测）；`server.ts#handle()` 在 `route()` 前对 `/api/*` 计数；
  429 带 `Retry-After`；env `CONSOLE_RATE_PER_MIN`/`CONSOLE_RATE_BURST`/`CONSOLE_TRUST_CF`。
- 验证：单测（突发放行 N、第 N+1 限流、时间推进后恢复、key 隔离、`perMin=0` 关闭）；HTTP e2e 连续请求得 429 + `Retry-After`。

### I6-3 `/health` 增强（D32）
- `{status,version,uptimeSec,db,tunnel}`；`db="ok"|"error"`；`tunnel=<status>|null`。
- 验证：HTTP e2e（未启用隧道 → `tunnel:null`；注入 fake supervisor → `up`）；断言响应**不含** `account`/`queue`/密钥字段。

### I6-4 失败退避：`jobs/queue.ts` + `jobs/scheduler.ts`（D31/I32）
- 新增 `countFailed`/`lastFailureAt`；`schedulerTick` 加预算 + 冷却；env `CONSOLE_JOB_MAX_ATTEMPTS`/`CONSOLE_JOB_RETRY_COOLDOWN_MIN`。
- 验证：单测——失败 1 次后窗内不再入队；窗过后重试；达上限永久 skip；成功路径行为不变（回归旧单测）。

### I6-5 SSE/事件遗留修复（D33：N1–N3 + 前端）
- `http/chat-sse.ts`：重放期失败可清理；`signal.aborted` 立即清理。
- `agent/events.ts`：`close()` 广播终态后再清。
- `ui/chat.js`：`chat.closed`/`chat.lost` 关闭 `EventSource`。
- 验证：单测（已 abort 的 signal → 无残留监听；bus.close → 订阅者收到终态；enqueue 抛错 → listener/interval 被清）；前端静态断言。

### I6-6 备份：`main.ts --backup/--restore-check` + `deploy/console-backup.sh`
- 验证：临时目录造库 → `--backup` → `integrity_check=ok`、`user_version` 保留、原子（无 `.tmp` 残留）；
  `--restore-check` 能读；脚本打包 tgz 含 manifest、保留 KEEP 份。

### I6-7 恢复：`deploy/console-restore.sh`
- 验证：模拟「服务在跑」→ 拒绝；`--force` 通过；恢复后行数一致；恢复前现状被自动备份。

### I6-8 部署：`deploy/systemd/{wechat-console,cloudflared}.service` + `env.example` + `install-console.sh` + `nginx-console.conf.example`
- 验证：`systemd-analyze verify`（若可用）或 `bash -n` + 关键指令静态断言；unit 含 `Restart=on-failure`、只监听 127.0.0.1、无明文密钥；`cloudflared.service` 含 Mode B 互斥警示。

### I6-9 手册与文档：`deploy/console-deploy.md`、`deploy/console-acceptance.md`、`README.md`、`docs/操作手册.md`
- 验证：文件存在且含「部署 / 迁移 / 回滚 / 备份恢复 / 限流 / 故障排查」节；README/手册增控制台入口指引（不改既有铁律表述）。

### I6-10 spec 校准 v5→v6 + 治理同步
- `.trellis/spec/console/{api,security,index}.md`：429 与 `/health`、限流实现、I29–I34；`index.md` 增 `ops-deploy.md` 行。
- `AGENT.md`：S17 ✅、任务图 6/6、D28–D33、G6/G7、§9 变更日志、§10 收尾。
- `src/README.md`（ratelimit + `--backup`）、`TREE.md`（`tools/repomap.sh`）。
- 验证：grep 版本号一致；`TREE.md` 含 `http/ratelimit.ts`、`deploy/console-*`。

---

## 2. 验收命令（可复现）

```bash
export PATH="$HOME/.bun/bin:$PATH"

# 静态
tsc --noEmit && echo TSC_OK
bun build src/console/main.ts --target=bun >/dev/null && echo BUILD_OK
grep -q '"dependencies"' package.json && echo "FAIL: deps" || echo NO_DEPS_OK

# engine 未动 + 兼容
git diff --quiet -- src/pi.ts src/wechat.ts src/publisher.ts src/mailer.ts && echo ENGINE_UNTOUCHED_OK
bun src/cli.ts doctor --all
bun src/cli.ts publish --dry-run

# C6 专项
bun /tmp/wfc-c6-ratelimit.ts      # 限流单测
bun /tmp/wfc-c6-backoff.ts        # 退避单测
bash /tmp/wfc-c6-backup.sh        # 备份/恢复 e2e
bun /tmp/wfc-c6-health.ts         # /health 契约
bun /tmp/wfc-c6-sse.ts            # D33 修复
bash /tmp/wfc-c6-deploy.sh        # unit/脚本静态断言

# 回归（C1–C5）
bash /tmp/wfc-c5-verify.sh        # 含 C3/C4 回归（pass=22）

# 聚合
bash /tmp/wfc-c6-verify.sh        # 全部串起来
```

---

## 3. 回滚点

| 步骤 | 回滚 |
|---|---|
| I6-2/I6-3 | 纯增量新文件 + 少量 `server.ts` 改动 → `git revert` 或 `CONSOLE_RATE_PER_MIN=0` 关闭 |
| I6-4 | `CONSOLE_JOB_MAX_ATTEMPTS=0`/`CONSOLE_JOB_RETRY_COOLDOWN_MIN=0` 还原旧行为 |
| I6-5 | `git revert`（C4 契约不变，仅修泄漏） |
| I6-6/I6-7 | 脚本不修改线上；恢复脚本强制停服 + 自动备份现状 |
| I6-8 | `systemctl disable --now wechat-console` + `enable-timer.sh` 回退 timer |

---

## 4. 真机验收（G2/G6/G7，需 250 主机）

- 部署：`deploy/install-console.sh` → `systemctl status wechat-console` active。
- 公网：`cloudflared` 拿到 `https://*.trycloudflare.com`，浏览器可登录（G6）。
- 凭据：DB 中密文、API 不回显、无 key 拒启（G7，复用 C5 验证）。
- 限流：脚本并发打 `/api/me` → 出现 429 + `Retry-After`。
- 备份/恢复：`console-backup.sh` 出 tgz；停机 `console-restore.sh` 恢复后账号/计划仍在。
- 回归：`deploy/console-acceptance.md` AC-1…AC-11 清单逐条勾选并留证据。

---

## 5. 证据（实现后回填，路径 或 真实输出）

| 项 | 证据 | 状态 |
|----|------|------|
| spec 先行 | `.trellis/spec/console/ops-deploy.md` | 待填 |
| 限流 | `src/console/http/ratelimit.ts` + `/tmp/wfc-c6-ratelimit.ts` | 待填 |
| `/health` | `server.ts` + `/tmp/wfc-c6-health.ts` | 待填 |
| 失败退避 | `jobs/{queue,scheduler}.ts` + `/tmp/wfc-c6-backoff.ts` | 待填 |
| SSE 修复 | `agent/events.ts`/`http/chat-sse.ts`/`ui/chat.js` + `/tmp/wfc-c6-sse.ts` | 待填 |
| 备份 | `main.ts --backup` + `deploy/console-backup.sh` + `/tmp/wfc-c6-backup.sh` | 待填 |
| 恢复 | `deploy/console-restore.sh` | 待填 |
| 部署 | `deploy/systemd/*` + `deploy/install-console.sh` + `/tmp/wfc-c6-deploy.sh` | 待填 |
| 手册 | `deploy/console-deploy.md`、`deploy/console-acceptance.md` | 待填 |
| 聚合 | `bash /tmp/wfc-c6-verify.sh` → `pass=_ fail=0` | 待填 |
| 独立复核 | `check-report.md` | 待填 |
| spec 校准 | `api.md`/`security.md`/`index.md` v6 | 待填 |

## 6. 偏差与观察（实现后回填）

- 待填。
