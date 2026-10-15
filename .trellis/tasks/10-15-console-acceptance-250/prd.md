# PRD · 控制台 250 真机验收

## 背景
控制台 C1–C6（S11–S17）已全部交付并归档，但全部验证在开发机完成。真机 250（192.168.0.250）上**控制台从未部署**（无 `console/`、无 `wechat-console` 服务、8787 无响应），旧 systemd timer（`wechat-plan/publish.timer`）仍在 active。需在 250 完成部署 + AC-1…AC-11 全量验收，产出 G6/G7 放行证据。

## 目标
1. 250 上部署控制台（Mode A：进程内隧道），迁移调度（停旧 timer，保留回退）。
2. 执行 `deploy/console-acceptance.md` AC-1…AC-11，逐条留证据。
3. 产出验收报告，标清：✅ 自动化通过 / 👤 需用户人工项（浏览器 UI、真实发布、G6/G7 确认）。

## 非目标
- 不改 engine / console 源码（验收中发现缺陷 → 记录并回任务，另开修复流程）。
- 不放行 G6/G7（需用户最终确认）。
- 不删除旧 timer unit（只 disable，保留回退）。

## 约束
- 控制台只监听 `127.0.0.1:8787`；CDP 端口绝不对外（I27）。
- `config.json` / `data/` 是 250 运行时数据，部署永不覆盖。
- 真实发布链路涉及微信草稿箱：破坏性操作（publish）仅在用户确认后执行。
- 管理员密码随机生成，交付时告知用户并建议修改。

## 验收标准
- [ ] D1: `install-console.sh` 完成，`wechat-console` active，`/health` 返回 `{status:"ok",db:"ok"}`
- [ ] D2: 旧 timer 已 disable（`systemctl is-enabled wechat-publish.timer` = disabled），unit 保留
- [ ] D3: AC-1…AC-11 中所有可自动化项在 250 实测通过，证据（命令+输出摘要）落入 `report.md`
- [ ] D4: 需人工项清单明确列出（浏览器 UI、真实 pi 生成/推送、G6/G7）
- [ ] D5: `AGENT.md` §5/§9 更新验收结论；G6/G7 状态更新为「待用户确认」并附证据指针
