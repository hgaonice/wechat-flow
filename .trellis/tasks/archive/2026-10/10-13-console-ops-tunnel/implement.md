# C5 · implement.md · 执行计划（console-ops-tunnel）

> 设计见 `design.md`；契约在实现期同步 `.trellis/spec/console/ops-tunnel.md`（新增，v0→v1）；父排期见父 `implement.md` M4。
> 完成 = 产物路径 或 真实命令输出；禁止「我记得做过了」。

---

## 0. 开工前置检查

- [x] `prd.md` 就绪（含 AC-C5-1..9 与 D-C5-1..8）
- [x] `design.md` 就绪（本目录）
- [x] 本文件就绪
- [x] `implement.jsonl` / `check.jsonl` 写入真实条目
- [x] **G-C5（用户确认）**：用户已于 2026-10-14 确认 D-C5-2（复用 engine `sendMail` + 共享 SMTP，不改 engine）、
      D-C5-3（SMTP 全局共用；每账号接收邮箱动态配置；`smtp` kind 保留入库不消费）、D-C5-4（管理员副本默认开）—— 已确认 ✅
- [x] `python3 .trellis/scripts/task.py start 10-13-console-ops-tunnel` → `planning → in_progress`

> 未获 G-C5 前**不动** `src/`。本任务是**纯增量**：不触碰 `src/pi.ts` / `src/wechat.ts` / `src/publisher.ts` / `src/mailer.ts` / 推送链路。
> **依赖 C1 已交付**（`account_email`/`secrets`/`tunnels` 表、`crypto/secrets.ts`、`auth/rbac.ts`、`AppState.masterKey`）。

---

## 1. 实施顺序（每步含验证）

### I5-0 spec 先行：新增 `spec/console/ops-tunnel.md`（v0）
- 内容：组件边界、迁移 v3、不变量 I24–I28、路由与错误码、邮件组装与去重/重试语义、环境变量、H8 暴露面。
- 同步更新 `spec/console/data-model.md`（I24–I28 + v3 迁移）、`api.md`（新端点）、`security.md`（凭据/邮件/暴露面）、`index.md`（Guides Index + 反模式）。
- **验证**：spec 文件存在；`index.md` 状态行与 Guides 表指向新 guide。

### I5-1 DB：migration v3 + `dao/{emails,secrets,tunnels}.ts`
- `schema.ts`：`MIGRATIONS` 追加
  `{version:3, name:"tunnel_notify", sql:"ALTER TABLE tunnels ADD COLUMN notified_at TEXT; ALTER TABLE tunnels ADD COLUMN notify_attempts INTEGER NOT NULL DEFAULT 0;"}`。
- `dao/emails.ts`：`getEmail`/`upsertEmail`/`deleteEmail`。
- `dao/secrets.ts`：`SECRET_KINDS`、`listSecretMetas`、`putSecret`、`getSecretCipher`、`deleteSecret` + NULL 判重（design §3.2）。
- `dao/tunnels.ts`：`getCurrentTunnel`/`listTunnels`/`openTunnel`（同事务 I24）/`setTunnelStatus`/`markHeard`/`markNotified`/`bumpNotifyAttempts`。
- **验证**：单测——旧库 v2→v3 数据不丢、`user_version=3`；`openTunnel` 后旧行 `expired`+`replaced_by` 且全局仅 1 行 `up`（I24）；
  `putSecret` 密文 ≠ 明文、`listSecretMetas` 不含密文；全局 kind（`account_id IS NULL`）重复写入不产生第二行。

### I5-2 `tunnel/cloudflared.ts` —— 子进程监督
- `TunnelSupervisor`：`start/stop/status/restart`；spawn `cloudflared tunnel --url <target> --no-autoupdate`；
  stderr 逐行解析 `trycloudflare.com` + 尾 2KB 存档；健康检查（本地 `/health` + 远端 `HEAD`）；退出 → I28 + 退避重启；去抖发信；审计。
- **验证**：单测——URL 解析（多行噪声/重复/大小写）；进程退出 → `status='down'` + detail 含 exit/signal；
  **fake-cloudflared**（打印地址到 stderr 的脚本）→ `tunnels` 出现 1 行 `up`；改地址 → 新行 + 旧行 `expired`+`replaced_by`。

### I5-3 `notify/tunnel-mail.ts` —— 邮件组装与下发
- `notifyTunnelChange(db, key, tunnel, opts)`：组装（服务器信息 + 地址 + 该账号账密）+ 收件人计算（账号邮箱 ∪ 可选管理员副本）
  + 去重（`notified_at`）+ 重试封顶 + 审计；`send` 可注入。
- **验证**：单测——收件人 ⊆ 该账号邮箱 ∪ 管理员；已 `notified_at` → `skipped`；fake sender 断言成功仅 1 封、失败累加 attempts、
  达上限后 `status='error'` 且不再调用 sender；`wechat_login` 未配置时正文含「未配置」而非崩溃。

### I5-4 `server.ts` —— 路由 + `ops` 注入（纯增量）
- `createApp(state, chat?, ops?)`；新增 11 条路由（design §6）：email(3)、secrets(3)、tunnels(4)、admin/overview(1)。
- 复用 `assertAccountAccess`/`assertAdmin`/CSRF/`recordAudit`/统一信封；`ops.tunnel` 缺失时 restart/notify → 503 `tunnel_unavailable`。
- **验证**：HTTP e2e（`curl`）——401（未登录）/403（owner 越权他人账号 + `audit('denied')`）/400（非法邮箱、非法 kind）/
  404；secrets `GET` 响应**不含**密文或明文；`PUT` 后 `GET` 显示 `configured:true`；CSRF 缺失 → 403。

### I5-5 `main.ts` —— 接线
- `CONSOLE_TUNNEL=1` 时 `new TunnelSupervisor({db, masterKey})` → `createApp(state, chat, {tunnel})` → `tunnel.start()`；
  shutdown 顺序：`scheduler.stop()` → `worker.stop()` → `chat.shutdown()` → `tunnel.stop()` → `server.stop()` → `db.close()`。
- **验证**：`CONSOLE_TUNNEL=0` 启动日志无隧道、（未破坏 C1–C4 行为）；`--status` 仍可用。

### I5-6 UI：`account` 邮箱/凭据表单 + `/admin` 总览页 + 隧道徽标
- `account.html`/`app.js`：邮箱表单 + 凭据表单（只写、读回显示 `configured` 徽标/时间/删除）。
- 新增 `ui/admin.{html,js}`：隧道状态卡（地址/PID/状态/重启/重发）+ 账号总览表；`http/static.ts` 加 `/admin` 路由。
- `ui/{index,workbench,chat}.html`：加「运维」入口（`admin` 可见）。
- **验证**：`bun build` 含新资源；浏览器手测（真实机器 G2）；移动端视口不溢出。

### I5-7 测试夹具 + 验证脚本（`/tmp`，不提交）
- `/tmp/fake-cloudflared.ts`（`#!/usr/bin/env bun`：读 argv，打印模拟地址 + 可被信号触发改地址/退出）、
  `/tmp/wfc-c5-unit.ts`、`/tmp/wfc-c5-http.sh`、`/tmp/wfc-c5-tunnel.ts`、`/tmp/wfc-c5-verify.sh`（聚合：tsc/build/零依赖/engine 未改/C1–C4 回归）。
- **验证**：`bash /tmp/wfc-c5-verify.sh` → `pass=N fail=0`；**脚本内每个断言必须 `pass++/fail++`**（C4 教训）。

### I5-8 回归、spec 校准 v4→v5、状态同步
- spec：`ops-tunnel.md` v0→v1（校准项）；`api.md`/`data-model.md`/`security.md`/`index.md` 升 v5。
- `AGENT.md`：§1（S16 → ✅）、§3、§5（新增 C5 Checkpoint + C5→上一）、§8（D22–D24）、§9 变更日志、§10；
  `src/README.md`（`tunnel/`/`notify/`/`dao` 段）；`bash tools/repomap.sh` 重生成 `TREE.md`。
- **验证**：`bash /tmp/wfc-c5-verify.sh` 全绿；`trellis-check` 独立复核 PASS。

---

## 2. 验收命令（可复现）

```bash
export PATH="$HOME/.bun/bin:$PATH"
# 静态
node_modules/.bin/tsc --noEmit
bun build --target=bun src/console/main.ts >/dev/null
node -e "const p=require('./package.json');process.exit(p.dependencies?1:0)" && echo ZERO_DEPS_OK
git diff --quiet -- src/pi.ts src/wechat.ts src/publisher.ts src/mailer.ts && echo ENGINE_UNTOUCHED_OK

# 单元 / 集成 / HTTP / 隧道
bun /tmp/wfc-c5-unit.ts
bun /tmp/wfc-c5-tunnel.ts        # fake-cloudflared：地址变更→新行+旧 expired+replaced_by+去重发信
bash /tmp/wfc-c5-http.sh         # 401/403/CSRF/400/secrets 不回显/audit

# 聚合 + 回归
bash /tmp/wfc-c5-verify.sh       # 期望 pass=N fail=0
bash /tmp/wfc-c4-verify.sh       # C4 回归 pass=8 fail=0
bash /tmp/wfc-c3-verify.sh       # C3 回归 pass=7 fail=0
bun src/cli.ts doctor --all      # H6 兼容
```

**AC 映射**：AC-C5-1/2 → I5-2 + fake-cloudflared；AC-C5-3/4 → I5-3 单测；AC-C5-5 → I5-1/I5-4（密文 + 不回显）；
AC-C5-6 → I5-4（403 + audit）；AC-C5-7 → I5-2 + I5-4 断言（无 CDP）；AC-C5-8 → I5-2 退出路径；
AC-C5-9 → §2 静态命令 + 回归。

---

## 3. 回滚点

| 层 | 回滚动作 |
|----|----------|
| 运行期 | `CONSOLE_TUNNEL=0`（或不设）→ 不启动隧道；restart/notify 返回 503 |
| 迁移 v3 | 两列加法，旧代码读新库无影响；彻底回退需重建 `tunnels`（记录于 spec） |
| 代码 | 删除 `tunnel/`、`notify/`、`dao/{emails,secrets,tunnels}.ts`、`ui/admin.*`；还原 `server.ts`/`main.ts`/`schema.ts` 增量 |
| 数据 | `account_email`/`secrets`/`tunnels` 行按需 DELETE；凭据删除即失效 |

---

## 4. 真机验收（G2，需 250 主机）

- [ ] `cloudflared` 真实 quick tunnel：拿到真实 `https://*.trycloudflare.com` 并可公网访问 `/health`。
- [ ] 真实重启 `cloudflared` → ≤ 60s 内 DB 出现新 `up` 行、旧行 `expired`；真实邮箱收到含「服务器信息 + 新地址 + 账密」的邮件。
- [ ] 手机直开地址可登录并操作（R2.5）。
- [ ] `email-sender` skill 的真实 SMTP 配置可用（`/workspaces/resources/notebook/ai/skill/email-sender/config.env`）。

---

## 5. 证据（实现后回填，路径 或 真实输出）

| 项 | 证据 | 状态 |
|----|------|------|
| spec 先行 | `.trellis/spec/console/ops-tunnel.md`（v0→**v1**） | ✅ |
| migration v3 | `src/console/db/schema.ts`（`tunnel_notify`；v2→v3 单测 8/8） | ✅ |
| DAO | `src/console/db/dao/{emails,secrets,tunnels}.ts`（65/126/154 行） | ✅ |
| 隧道监督 | `src/console/tunnel/cloudflared.ts`（462 行）+ `bun /tmp/wfc-c5-tunnel.ts` → `pass=19 fail=0` | ✅ |
| 邮件下发 | `src/console/notify/tunnel-mail.ts`（319 行）+ 独立 `c5-check-smtp.ts` 7/0、`c5-check-tunnel.ts` 26/0 | ✅ |
| 路由 | `src/console/server.ts`（+282/−1，11 条；`createApp(state,chat,ops?)`、`requireTunnel→503`）+ `c5-check-http.ts` 50/0 | ✅ |
| UI | `src/console/ui/{account.html,app.js,admin.html,admin.js}` + `http/static.ts`(+/admin) + `c5-check-static.sh` 14/0 | ✅ |
| 聚合验证 | `bash /tmp/wfc-c5-verify.sh` → **`pass=22 fail=0`**（含 C3 7/0、C4 8/0 回归） | ✅ |
| 独立复核 | `.trellis/tasks/10-13-console-ops-tunnel/check-report.md` → 首轮 171/172；修复后 **196/0**（unit 53/http 50/tunnel 26/static 14/deviations 18/extra 4/smtp 7/recheck 24） | ✅ |
| spec 校准 | `ops-tunnel.md` **v1** + `api.md`/`data-model.md`/`security.md` **v5** + `index.md` | ✅ |
| 静态/零依赖 | `tsc --noEmit` = 0 err；`bun build` 无新依赖；`package.json` 无 `dependencies`；engine 四文件 `git diff --quiet` → OK | ✅ |
| 真机（G2，250 主机） | 真实 `cloudflared` + `email-sender` 发信、浏览器 `/admin` | ⏳ 待 250 主机 |

## 6. 偏差与观察（实现后回填）

**与规划稿的偏差（均已回写 `ops-tunnel.md` §九）**：

1. `openTunnel` 收编范围由「旧 `up`」扩为「旧 `up` **与 `down`**」（同事务），确保全局至多一行 `up`（I24）。
2. `replaced_by` 方向明确为**旧行 → 新行 id**（前向链）——同步修正了 `data-model.md` I8 旧稿的方向笔误。
3. admin 副本收件源 = **`settings(global).notify.email.to`**（与 engine `EmailConfig` 同源），非 `notify.to`。
4. `emailConfigFor()` 总能构造可用 `EmailConfig`（`enabled:true`、缺省 `skill.dir`/`python` 补齐）；`email-sender` 未配置时仅通过 `sendMail=false` **显形失败**（重试封顶→`error`），不伪造成功。
5. 某账号无收件人时，仅当 `adminCopy` 开启才退化为**仅管理员副本**邮件。
6. 新增测试缝 `TunnelDeps.{probe,autoRestart,consolePort}`。
7. `DELETE` 幂等返回 `{deleted:n}`；email GET **不含 `updatedAt`**（表无该列）。
8. `createApp` 扩为 `(state, chat?, ops?:{tunnel?})`。
9. **（复核发现，已修复）** I27 原来只校验回环**主机**、不校验**端口** → 误配 `CONSOLE_TUNNEL_URL=…:9222` 会把 CDP 发到公网。已在 `TunnelSupervisor` 构造期加「端口 === `CONSOLE_PORT`」+「不得为任何 `accounts.cdp_port`」双重校验（fail-fast）；新增复核断言 24/0。

**非阻塞观察（不修，登记备查）**：

- `emailConfigFor` 忽略全局 `notify.email.enabled=false`（C5 只在隧道变更时发信，不受全局开关影响；如未来需尊重，C6 再议）。
- 多账号部分失败时，下一轮会对**已成功账号重发**（每人 at-least-once；正文不含跨账号信息，可接受）。
- `decision.expired` 等 C4 观察项仍由 C6 统一收口。
