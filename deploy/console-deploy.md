# 控制台部署与加固手册（C6 / M5）

> 目标机：`192.168.0.250`（Debian/Ubuntu，root）。仓库：`/root/wechat-flow`。
> 铁律：控制台只监听 `127.0.0.1`；**CDP 端口绝不对外**；发布链路不改。
> 相关 spec：`.trellis/spec/console/ops-deploy.md`。

---

## 0. 一页速览

```bash
# 在 250 上、仓库根目录
cd /root/wechat-flow
export PATH="$HOME/.bun/bin:$PATH"

# 1) 初始化管理员与主密钥（首次）
bun src/console/main.ts --init-key
bun src/console/main.ts --import-config      # 从 config.json 导入账号
bun src/console/main.ts --create-admin admin # 交互设置密码

# 2) 安装为 systemd 服务（Mode A：控制台内监督 cloudflared）
bash deploy/install-console.sh

# 3) 查看公网地址（隧道地址 + 可选邮件通知）
bun src/console/main.ts --status
systemctl status wechat-console --no-pager
```

浏览器打开 `https://<随机>.trycloudflare.com`（或被通知的地址）登录控制台。

---

## 1. 部署模式（D28）

| 模式 | 组成 | `CONSOLE_TUNNEL` | 何时用 |
|---|---|---|---|
| **Mode A（默认，推荐）** | 仅 `wechat-console.service` | `1` | 控制台进程内监督 `cloudflared`；C5 隧道状态与地址变更邮件可用 |
| Mode B（备用，**互斥**） | `wechat-console.service` + `cloudflared.service` | `0` | 外部托管隧道；**会使 `/api/tunnels` 与变更邮件失效** |

- 两种模式**不可同时启用**（会双隧道冲突）。
- Mode B 安装：`bash deploy/install-console.sh --mode-b`，并务必将 `/etc/default/wechat-console` 的 `CONSOLE_TUNNEL` 设为 `0`。

---

## 2. 环境与配置

- 运行时参数文件：`/etc/default/wechat-console`（模板 `deploy/systemd/wechat-console.env.example`，`0600`）。
- **不放明文密钥**：主密钥在 `~/.wechat-console/master.key`（`0600`），凭据以密文存 DB。
- 常用变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `CONSOLE_HOST` / `CONSOLE_PORT` | `127.0.0.1` / `8787` | 监听地址/端口（保持 loopback） |
| `CONSOLE_DB` | `console/console.db` | SQLite 路径 |
| `CONSOLE_MAX_CONCURRENCY` | `2` | worker 并发 |
| `CONSOLE_RATE_PER_MIN` / `CONSOLE_RATE_BURST` | `600` / `120` | API 限流（`0` 关闭） |
| `CONSOLE_TRUST_CF` | `0` | 置 `1` 时用 `CF-Connecting-IP` 作为限流 key |
| `CONSOLE_JOB_MAX_ATTEMPTS` / `CONSOLE_JOB_RETRY_COOLDOWN_MIN` | `3` / `30` | 调度失败退避（`0` 关闭） |
| `CONSOLE_TUNNEL*` | 见模板 | 隧道监督（Mode A） |

---

## 3. 迁移（从 systemd timer → 控制台调度）

1. **先备份**：`bash deploy/console-backup.sh`（见 §5）。
2. `bash deploy/install-console.sh`：
   - 安装并启用 `wechat-console.service`；
   - 调用 `deploy/systemd/disable-timer.sh` 停用 `wechat-plan.timer`/`wechat-publish.timer`（**unit 保留不删**）。
3. `--import-config` 把 `config.json` 的账号导入 DB（幂等）。
4. 在控制台「计划」页确认各账号周/月计划，并核对 `state/published.json`（幂等来源不变）。
5. 观察一个发布周期；确认草稿箱正文与既有铁律一致（`verifyDraftBody` 仍为准）。

> 迁移期 DB 为真源；`fillMissingPlansFromFiles` 会把仅存在于文件的历史计划补进 DB。

---

## 4. 回滚

```bash
# 停控制台，恢复 timer 触发
systemctl disable --now wechat-console.service
bash deploy/systemd/enable-timer.sh
systemctl list-timers 'wechat-*' --no-pager
```

- 数据无损：控制台数据在 `console/console.db`，timer 路径读的是 `config.json` + `plans/` + `state/`，二者不冲突。
- 如需连库一起回滚：见 §5 恢复。

---

## 5. 备份 / 恢复（I30/I31）

```bash
# 备份（DB 用 VACUUM INTO 一致性快照 + data/ + config.json + master.key）
bash deploy/console-backup.sh
# 产物：backups/console-<ts>.tgz（0600，含主密钥，勿提交/外传）

# 恢复（会拒绝在服务运行时执行；先 stop）
systemctl stop wechat-console.service
bash deploy/console-restore.sh backups/console-<ts>.tgz
systemctl start wechat-console.service
```

- 恢复前脚本会：预检 `--restore-check` → 用 `--backup` 快照**现状**（`.pre-restore-<ts>`）→ 再替换。
- 单独校验备份：`bun src/console/main.ts --restore-check <file>`。

---

## 6. 限流与安全

- **API 限流**：仅 `/api/*`；超限 `429` + `Retry-After`；`/health` 与静态资源豁免；限流不写审计。
- **登录锁定**：同用户名 15 分钟窗口内失败 5 次锁定（`login_attempts`）。
- **安全响应头**：CSP / HSTS（HTTPS 下）/ `X-Frame-Options: DENY` / `nosniff` / `no-store`。
- **可选前置身份门**：Cloudflare Access（在 CF 侧加策略；控制台无需改动）。
- `/health` 免鉴权返回 `{status,version,uptimeSec,db,tunnel}`，不含任何敏感字段。

---

## 7. 故障排查

| 症状 | 排查 |
|---|---|
| 网页打不开 | `systemctl status wechat-console`；`curl -sS http://127.0.0.1:8787/health` |
| 拿不到公网地址 | Mode A 下看 `bun src/console/main.ts --status`；检查 `CONSOLE_TUNNEL=1` 与 `cloudflared` 可执行 |
| 大量 429 | 调大 `CONSOLE_RATE_PER_MIN/BURST`，或置 `CONSOLE_RATE_PER_MIN=0` |
| 发布会话失败 | 先确认 Chrome/`DISPLAY=:99`；必要时临时移除 `NoNewPrivileges`（保守沙箱说明见 service 注释） |
| 凭据无法解密 | 主密钥丢失/更换；用备份的 `master.key` 恢复 |
| 计划不触发 | 看 `journalctl -u wechat-console`；确认账号 `enabled`、`schedule` 与服务时钟 |

---

## 8. 验证入口

- 端到端验收清单：`deploy/console-acceptance.md`（AC-1…AC-11）。
- 本地静态与专项：`bash /tmp/wfc-c6-verify.sh`（tsc/build/限流/退避/备份/health/SSE）。
