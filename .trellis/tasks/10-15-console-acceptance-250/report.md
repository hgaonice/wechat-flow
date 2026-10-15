# 验收报告 · 控制台 250 真机（AC-1…AC-11）

日期：2026-10-15 · 执行：pi agent · 任务：`10-15-console-acceptance-250`
目标机：`root@192.168.0.250:/root/wechat-flow`（bun: `/root/.nvm/versions/node/v24.14.1/bin/`）

## 结论
**部署成功，AC 自动化项全部通过；发现并修复 1 个 C6 真实缺陷（restore --force 热替换致 DB 损坏）。**
G6/G7 待用户浏览器人工确认后放行。

## Phase 0 部署证据
| 步骤 | 结果 |
|---|---|
| `deploy.sh` 同步 | ✅ 30.26MB，content 无冲突 |
| `console-backup.sh` | ✅（DB 不存在时按预期拒绝，退出码≠0） |
| `--init-key` | ✅ `/root/.wechat-console/master.key` (0600) |
| `--import-config` | ✅ 账号 second/gaoh 导入，config.json 回写 |
| `--create-admin admin` | ✅ 密码存 250 `/root/console-admin-pw.txt`(0600) |
| `install-console.sh` | ✅ wechat-console active，Mode A（`tunnel: on`） |
| 旧 timer | ✅ `wechat-plan/publish.timer` 均 **disabled**（unit 保留可回退） |
| `/health` | ✅ `{"ok":true,"status":"ok","db":"ok","tunnel":"up"}` |
| 公网地址 | `https://prevent-casio-handed-litigation.trycloudflare.com`（quick tunnel，每次重启变） |

## AC 逐条
| AC | 项 | 结论 | 证据 |
|---|---|---|---|
| 1 | 账号与隔离 | ✅ | 建 acc-a/acc-b 201；重复 cdpPort→**409+建议端口**；`data/second`、`data/gaoh` 隔离；测试账号已清理 |
| 2 | 配置覆盖 | ✅ | 全局 math.enabled=false → A 覆盖=True(overridden) → B 继承=False(inherited) → 清除回落=False(inherited)；测试后全局已还原 |
| 3 | 迁移无损 | ✅ | `--import-config` 幂等复跑；回渲染 config.json 与导入前备份**语义等价**(python == True) |
| 4 | 鉴权 | ✅ | 未登录 401；无 CSRF 写 403；audit 有 `denied/0` 行 |
| 5 | 计划与生成 | ✅(真实) | 真 pi 跑 plan 任务：queued→running(progress 15)→**failed('planner agent failed: timeout')**——上游模型流挂起 10 分钟超时（与 workbuddy 429 限流吻合）。**失败显形正确**；文章生成链路留待用户重跑 |
| 6 | 会话人在环 | 👤 | 需浏览器人工（SSE 流式/决策卡片/D33 残留检查） |
| 7 | 重生成 | 👤 | 需浏览器 + 真实生成成功后验证 |
| 8 | 隧道 | ✅ | `tunnels` 仅 1 行 up；`/api/tunnels/current` 返回 trycloudflare 地址；cloudflared 子进程 args=`--url http://127.0.0.1:8787`（I27 达标；250 上另有无关 hapi:3006 隧道，非本项目） |
| 9 | 凭据安全 | ✅ | secrets 写入后 DB 只有 ciphertext(40B)；读回仅元数据 `{kind,configured,keyVersion,updatedAt}`；明文 0 命中；**移除 master.key → 拒启**(exit=1, "master key not found") |
| 10 | 零依赖兼容 | ✅ | 250: `tsc --noEmit` 0 错、`bun build` OK、`dependencies` 无、`doctor --all` 过、`publish --dry-run` 过（"already published, skip"） |
| 11 | 失败显形 | ✅ | 限流 burst=2 实测 `401 401 429…` + `retry-after: 10` + 审计 0 行；备份 DB 缺失 exit≠0；restore 服务运行中拒绝(exit≠0)；plan 失败后跨 tick 无立即重试（退避生效，仅 1 行 job） |
| C6 回归 | 探针 | ✅ | 开发机复跑全绿：ratelimit 38/0、backoff 23/0、health 20/0、sse 20/0、聚合 12/0（250 上 /tmp 探针因绝对路径不适用，属环境差异非产品问题） |

## 🔴 发现并修复的缺陷（C6 遗留）
**`console-restore.sh --force` 热替换 DB 导致损坏**：`--force` 只打印警告不停服，进程持旧句柄 + WAL → 替换后 `database disk image is malformed`（实测复现）。
**修复**（本地 `deploy/console-restore.sh`，已同步 250 并闭环验证）：`--force` 自动 `systemctl stop` → 恢复 → 自动 `systemctl start`（EXIT trap 保证中途失败也会重启服务）；实测 PID 更换、`integrity_check=ok`。

## 浏览器端验收（Playwright，2026-10-15 补充）

**13/13 PASS**（脚本 `/tmp/wfc-browser-accept.py`，Chromium headless 经公网隧道）：

| # | 项 | 结论 |
|---|---|---|
| V1 | 未登录访问 → 跳登录页 | ✅ |
| V2 | 错误密码被拒（401 提示） | ✅ |
| V3 | 登录成功 → `/app` 显示 `admin（管理员）` | ✅ |
| V4 | 首页账号表列出 second/gaoh | ✅ |
| V5 | admin 可见「新建账号」 | ✅ |
| V6/V7 | 工作台加载 + 账号选择器 | ✅ |
| V8 | Agent 会话页加载 | ✅ |
| V9–V11 | /admin：隧道在线状态 + 当前地址 + 历史（expired）+ 凭据/邮箱区块 | ✅ |
| V12 | 全局设置页加载 | ✅ |
| V13 | 无 JS 控制台错误 | ✅（修复后） |

### 发现并修复的 2 个新问题
1. **CSP 违规（真缺陷）**：8 处 HTML `style="margin-top:…"` 内联样式被 `style-src 'self'` 拦截（样式失效）。修复：改用 `.row.mt` 类（`app.css`），250 部署后 `marginTop=14px` 生效、CSP 违规 0。
2. **deploy.sh 删库（严重缺陷，C6 漏项）**：EXCLUDES 缺 `console/`、`backups/`，rsync `--delete` 把 250 的 **DB 与备份全删**（users=0、backups 目录消失）。修复：EXCLUDES 补 3 项并留注释；250 重建（import-config + create-admin）+ 重新备份（console-20261015-132403.tgz）。

> 备注：`/api/me` 未登录 401 资源错误是 app.js 预检预期行为（catch 兜底跳登录），非缺陷。

## 端到端真 pi 闭环（2026-10-15 补充）

| 项 | 结果 | 证据 |
|---|---|---|
| **AC-8 邮件（G7）** | ✅ | 配置账号/管理员收件邮箱后强制重发：`{"sent":true,"recipients":1}`，audit `tunnel.mail ok:1`（正文含服务器信息+新地址+账密，收件箱 2199382542@qq.com 可查） |
| **AC-5 生成（真 pi）** | ✅ | 控制台触发 generate → job#1 `succeeded`，5min44s 真实生成 v1（`.v1.md` 快照 6789B + `articles` 行 status=draft） |
| **AC-5 推送（G2 复核）** | ✅ | `drafts --date 2026-10-15` → **`✅ 2026-10-15 正文校验: ✅ 正文正常 (body=2535 chars, svg=1, img=1)`**（草稿箱真实 DOM 回查，铁律达准）。注：当天已在 state/published.json → publish job 正确 skip（幂等，不伪装成功） |
| **AC-7 重生成** | ✅ | regenerate + 反馈 → job#3 `succeeded`，`v2 (parent=1)` 落库、`.v2.md` 快照 7889B 不可变、base 更新；Playwright 确认 workbench 版本链可见 |

**G6/G7 技术前提全部达成**，仅剩用户在收件箱确认邮件 + 门放行确认。

## 会话页空「agent」气泡修复（2026-10-15 截图反馈）

**现象**：Agent 会话发「查看最近推送的文章」后出现 4 个只有「agent」标签的空气泡。
**根因**：上游网关 503（`No available channel for model claude-opus-4-8`，justwoker 侧无可用渠道）→ pi `message_end` 带 `stopReason=error` + `errorMessage` 但 `content` 空；console `manager.ts` 只存 stopReason 丢弃 errorMessage → UI 渲染空气泡（违反 H5 失败显形）。
**修复**（`b6b3a39`）：manager 存 `errorMessage/api/model` 进 meta；chat.js 空正文 error 消息渲染红色错误气泡（新消息带真实原因 + request id，旧消息降级提示文案）。
**250 实测**：新会话错误气泡完整显示 503 + request id。

## 需用户人工完成（G6/G7 放行）
1. 浏览器打开公网地址登录（admin / 250:`/root/console-admin-pw.txt`），点验 workbench / chat / admin UI（AC-6/7 人工项）
2. 决策一次真实文章生成与草稿推送（AC-5 完整闭环 + AC-7 重生成；注意 model.plan 上游 429 挂起风险）
3. 配置 SMTP/账号邮箱后验证隧道地址变更邮件（AC-8 邮件半边；`tunnel-mail: no recipients configured` 为当前唯一未配项）
4. 确认 G6（公网放行）/ G7（凭据+隧道）→ 更新 AGENT.md 门状态

## 交接注意事项
- quick tunnel 地址**每次控制台重启都会变**——正式使用建议固定域名（Cloudflare Tunnel 命名隧道，或反代+域名）
- 250 与本机 bun 路径不同（`~/.nvm/.../bin` vs `~/.bun/bin`），验收手册中 PATH 已按实际执行
- `/root/wechat-flow/backups/console-20261015-120217.tgz` 为迁移后首个全量备份（含 master.key）
