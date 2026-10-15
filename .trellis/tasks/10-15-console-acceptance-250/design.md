# Design · 控制台 250 真机验收

## 执行环境
- 开发机 → 250：`ssh root@192.168.0.250`（已验证 BatchMode 可用）。
- 250 运行时：bun 在 `/root/.nvm/versions/node/v24.14.1/bin/`（**不是** `~/.bun/bin`，验收手册里的 PATH 需按实际修正）。
- 代码同步：`./deploy/deploy.sh`（单源 rsync，排除 `config.json`/`data/` 等运行时数据；本地为 content/prompts 真源）。

## 部署顺序（Mode A）
```
1. deploy.sh 同步代码          → /root/wechat-flow（src/console 上去）
2. console-backup.sh 先备份    → 迁移前安全网（DB 此刻尚不存在，备份 config/data）
3. --init-key                  → ~/.wechat-console/master.key (0600)
4. --import-config             → config.json 账号导入 DB（幂等）
5. --create-admin admin        → CONSOLE_ADMIN_PASSWORD 环境变量非交互
6. install-console.sh          → 装服务 + 自带 disable-timer.sh 停旧 timer
7. /etc/default/wechat-console → 按模板，CONSOLE_TUNNEL=1；LAN HTTP 预览需 CONSOLE_ALLOW_INSECURE_COOKIE=1（公网走 https 不需要）
8. /health 探活 + --status     → 服务可用、隧道地址产出
```

## 验收分层
| 层 | 方式 | 项 |
|---|---|---|
| A 自动化（ssh 可完成） | curl / sqlite3 / CLI / journalctl | AC-1…AC-5、AC-8（隧道+邮件若 SMTP 已配）、AC-9、AC-10、AC-11、C6 专项回归脚本 |
| B 半自动（需 250 上 Chrome 登录态） | ssh + DISPLAY=:99 跑 CLI | 真实 `publish --force --reuse` → `drafts --date` 正文校验（G2 复归） |
| C 人工（用户） | 浏览器 | workbench/chat/admin UI、决策卡片交互、G6/G7 确认 |

## 风险与对策
| 风险 | 对策 |
|---|---|
| deploy.sh 触发 content 冲突拦截 | 先 `-n` 预演；冲突则按「本地为真源」用户已确认策略处理 |
| 双触发（timer 未停 + 控制台调度） | install-console.sh 自带 disable-timer.sh；部署后显式复查 `is-enabled` |
| 隧道暴露公网 | 仅 Mode A + D22 构造期校验；验收时核对 `tunnels` 目标地址必为 127.0.0.1:8787 |
| 真实发布污染线上账号 | publish 类真机项放在最后，且先与用户确认账号与时间窗 |
| master.key 丢失 → 凭据不可解 | 备份脚本已含 master.key；验收 AC-9 的「移除 key 拒启」测试用临时改名的 key，测毕立即还原 |

## 回滚
```bash
systemctl stop --now wechat-console
bash deploy/systemd/enable-timer.sh   # 恢复旧 timer 触发
# DB/配置：console-backup.sh 产物按 console-restore.sh 恢复
```
