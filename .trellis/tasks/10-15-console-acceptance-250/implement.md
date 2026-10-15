# Implement · 控制台 250 真机验收

> 执行约定：每步带真实命令输出作为证据；失败即停并记录，不伪装通过。
> 250 上 PATH：`export PATH="/root/.nvm/versions/node/v24.14.1/bin:$PATH"`。

## Phase 0 · 部署（D1/D2）
- [ ] P0-1 `./deploy/deploy.sh -n` 预演 → 无意外冲突 → 实跑
- [ ] P0-2 250: `bash deploy/console-backup.sh`（迁移前备份）
- [ ] P0-3 `bun src/console/main.ts --init-key`
- [ ] P0-4 `bun src/console/main.ts --import-config`
- [ ] P0-5 `CONSOLE_ADMIN_PASSWORD=<随机> bun src/console/main.ts --create-admin admin`
- [ ] P0-6 `bash deploy/install-console.sh` → `systemctl is-active wechat-console` = active
- [ ] P0-7 复查 `systemctl is-enabled wechat-plan.timer wechat-publish.timer` = disabled
- [ ] P0-8 `/etc/default/wechat-console`：核对 `CONSOLE_TUNNEL=1`；如需 LAN HTTP 预览加 `CONSOLE_ALLOW_INSECURE_COOKIE=1` 后 restart
- [ ] P0-9 `curl 127.0.0.1:8787/health` → `{status:"ok",db:"ok",...}`；`--status` 看到隧道地址（如有）

## Phase 1 · 自动化验收（D3）
- [ ] P1-1 AC-1 账号与隔离（建 A/B、cdpPort 冲突 409、data 隔离）+ sqlite 证据
- [ ] P1-2 AC-2 配置覆盖（math.enabled 全局 false / A 覆盖 true / 清除回落）+ config 端点证据
- [ ] P1-3 AC-3 迁移无损（`--import-config` 幂等 + 回渲染 diff=0 / `--verify-ac3` 如可用）
- [ ] P1-4 AC-4 鉴权（401/403/CSRF + audit `denied` 行）
- [ ] P1-5 AC-5 计划与生成（dry-run 类任务或建计划任务看 queued→running→终态；真实 pi 生成留 Phase 2）
- [ ] P1-6 AC-8 隧道与邮件：`/api/tunnels` ≤1 行 up、旧行 expired；邮件发送证据（若 SMTP 已配）
- [ ] P1-7 AC-9 凭据安全：secrets 密文长度查询；API 无明文；临时移 key 拒启（测毕还原）
- [ ] P1-8 AC-10 零依赖兼容：tsc 0 错 / bun build / 无 dependencies / `doctor --all` / `publish --dry-run`
- [ ] P1-9 AC-11 失败显形：429+Retry-After 且不写审计；备份失败非 0 退出；恢复运行中拒绝；退避 skip 留痕
- [ ] P1-10 C6 专项回归脚本（如 /tmp/wfc-c6-*.ts 在 250 不存在则从本地 scp 或标记「开发机已验」）

## Phase 2 · 半自动（G2 复归，破坏性，先用户确认）
- [ ] P2-1 真实 `publish --force --reuse`（指定账号）→ `drafts --date` `✅ 正文校验`
- [ ] P2-2 控制台触发一次真实 generate（真 pi）→ 版本落库 + workbench 可见

## Phase 3 · 报告与收尾（D4/D5）
- [ ] P3-1 汇总 `report.md`：逐 AC 结论 + 证据摘要 + 需人工项清单（UI/决策卡片/G6/G7）
- [ ] P3-2 更新 `AGENT.md` §5 Checkpoint / §9 变更日志；G6/G7 标「待用户确认」
- [ ] P3-3 spec 更新（如有新坑，如 250 bun 路径与手册不一致 → ops-deploy.md）

## 验证命令速查
```bash
# 服务
ssh root@192.168.0.250 'systemctl is-active wechat-console; curl -sS http://127.0.0.1:8787/health'
# 旧 timer
ssh root@192.168.0.250 'systemctl is-enabled wechat-plan.timer wechat-publish.timer'
# 隧道
ssh root@192.168.0.250 'sqlite3 /root/wechat-flow/console/console.db "select id,status,substr(url,1,40) from tunnels order by id desc limit 3"'
```

## 回滚点
- Phase 0 任何一步失败：`systemctl stop --now wechat-console && bash deploy/systemd/enable-timer.sh`
- Phase 2 前：不影响线上（未真实发布）
