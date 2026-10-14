# 控制台端到端验收清单（AC-1…AC-11，真机 250）

> 来源：父任务 `.trellis/tasks/10-13-wechat-flow-console/prd.md` §验收标准。
> 用法：在 250 上按序执行，逐条记录证据（命令输出/截图/DB 查询），失败即不勾选。
> C6 关注 AC-10/AC-11，但**全量 AC-1…AC-11 都要回归**。
> 约定：`CURL='curl -sS -b cookies -H "X-CSRF-Token: $CSRF"'`。

```bash
cd /root/wechat-flow && export PATH="$HOME/.bun/bin:$PATH"
BASE=http://127.0.0.1:8787
```

---

## 前置

- [ ] `bash deploy/install-console.sh` → `systemctl is-active wechat-console` = active
- [ ] `curl -sS $BASE/health` → `{status:"ok",...,"db":"ok","tunnel":"up"|null}`（无敏感字段）
- [ ] 浏览器可登录（经隧道/反代），拿到公网地址（G6）

---

## AC-1 账号与隔离
- [ ] 管理员新建账号 A/B，`dataDir`、`cdpPort` 互不相同
- [ ] 重复 `cdpPort` 被拒绝并提示可用端口
- [ ] 对 A 的任务不影响 B 的 `data/` 目录
- 证据：`sqlite3 console/console.db "select alias,data_dir,cdp_port from accounts"`

## AC-2 配置覆盖
- [ ] 全局 `math.enabled=false`，A 覆盖 `true` → A 生效 `true`、B 生效 `false`
- [ ] 清除 A 覆盖 → A 回落 `false`；UI 显示「继承/覆盖」
- 证据：`GET /api/accounts/:id/config`（或等价预览端点）

## AC-3 迁移无损
- [ ] `--import-config` 后 DB 解析 `AppConfig` 与 `loadConfig()` 逐字段一致
- [ ] `config.json` 回渲染 diff 无非预期变化
- 证据：`bun src/console/main.ts --import-config` + diff 输出

## AC-4 鉴权与角色
- [ ] 未登录访问 API → 401
- [ ] 普通用户仅见被授权账号；跨账号 → 403
- [ ] 越权写入 `audit`（`action=denied`）
- 证据：`sqlite3 console/console.db "select action,ok from audit order by id desc limit 5"`

## AC-5 计划与生成
- [ ] 网页配置「下周 7 天」并触发生成 → 状态 `queued→running→succeeded/failed`
- [ ] 文章落 `data/<alias>/articles/`
- [ ] 发布后 `bun src/cli.ts drafts --date <日期>` 显示 `✅ 正文校验`
- 证据：任务日志 + 草稿校验输出

## AC-6 会话与人在环
- [ ] `/chat` 实时流式输出
- [ ] 决策卡片可交互，操作后 agent 继续
- [ ] 决策超时/取消状态明确、无悬挂（并验证 C6 D33：会话关闭后 SSE 不残留）
- 证据：浏览器 + `ss -tnp | grep 8787`（无残留连接）

## AC-7 重生成
- [ ] 对已生成文章「重新生成」+反馈 → 产生新版本，旧版本可查
- [ ] 新版本可再次推送草稿箱
- 证据：版本列表 UI + `articles/….v<N>.md`

## AC-8 隧道与邮件（G7）
- [ ] 隧道地址变更 1 分钟内更新为新地址
- [ ] 向账号邮箱 + 管理员发信（服务器信息 + 新地址 + 该账号后台账密）
- [ ] 旧地址标记失效
- 证据：`GET /api/tunnels?limit=5`（≤1 行 `status='up'`，旧行 `expired`）

## AC-9 凭据安全
- [ ] DB 凭据字段为密文（`select kind,length(ciphertext) from secrets`）
- [ ] API 不回显明文
- [ ] 无 master key 时拒启/拒解密并显式报错
- 证据：DB 查询 + 移除 key 后的启动日志

## AC-10 零依赖与兼容（C6）
- [ ] `bunx tsc --noEmit` 0 错误
- [ ] `bun build src/console/main.ts --target=bun` 成功
- [ ] `package.json` 无新增 runtime `dependencies`
- [ ] `bun src/cli.ts doctor --all` 通过
- [ ] `bun src/cli.ts publish --dry-run` 通过
- 证据：命令输出贴回 `AGENT.md` / C6 `implement.md` §5

## AC-11 失败显形（C6）
- [ ] 限流触发 → 429 + `Retry-After`（且不写审计）
- [ ] 备份失败（如 DB 缺失）→ 退出码非 0 + 明确错误
- [ ] 恢复时服务在跑 → 拒绝（无 `--force`）
- [ ] 调度达失败上限 → skip 且留痕（日志/审计），不伪装成功
- 证据：`journalctl -u wechat-console` + 命令退出码

---

## C6 专项回归（本地即可）

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun /tmp/wfc-c6-ratelimit.ts
bun /tmp/wfc-c6-backoff.ts
bun /tmp/wfc-c6-health.ts
bun /tmp/wfc-c6-sse.ts
bash /tmp/wfc-c6-backup.sh
bash /tmp/wfc-c6-verify.sh     # 聚合
bash /tmp/wfc-c5-verify.sh     # C1–C5 回归
```

## 门（GATE）

- [ ] **G6（控制台公网放行）**：浏览器经公网登录并使用核心流程无阻断 → 用户确认
- [ ] **G7（凭据加密与隧道放行）**：AC-8/AC-9 通过 → 用户确认
- 记录：`AGENT.md` §2 门清单 + §9 变更日志
