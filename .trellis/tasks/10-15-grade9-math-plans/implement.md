# Implement：九上数学 211 篇推文计划批量入排程

## Step 1 计划生成器（本机）

- [x] 1.1 `tools/gen-grade9-plans.ts`：内置 37 讲大纲（附录 A 数据），生成 second/gaoh 两套计划 JSON 到 `out/plans/<alias>/2026-W*.json`（该目录加 .gitignore 或生成后即用）
- [x] 1.2 每条 PlanDay 字段：`date/weekday/module/board/lecture/isSummary/topic/angle/titleSuggestion/outline[5-7]/grade=九年级/difficulty/manimHint?`；两账号 angle/title 差异化
- [x] 1.3 校验输出：211 天连续（2026-10-16 ~ 2027-05-14）、每周≤7天、ISO week 与 period_key 一致、汇总篇=isSummary 且紧跟该讲最后一个板块
- [x] 1.4 W42 直接生成 3 天版（10-16/17/18 = 第1讲前3篇），upsert 时整周覆盖，不做旧天合并
- [ ] 验证：`bun tools/gen-grade9-plans.ts --check` 打印两账号天数/周数/首日末日

## Step 2 ffmpeg 封面（引擎小改）

- [x] 2.1 `src/cover.ts` 新增 `generateFfmpegCover(input)`：lavfi 底色 + drawtext 主/副标题（字体走 `detectCjkFont`）
- [x] 2.2 `config.ts` `cover.mode` 支持 `"ffmpeg"`；`publisher.ts` 封面分支按 mode 分派，ffmpeg 失败降级 convert
- [x] 2.3 本地验证：`bun build --target=bun src/cli.ts`、`bunx tsc --noEmit`、手动跑一次封面生成看 png
- [x] 2.4 `bash tools/repomap.sh` 刷新 TREE.md

## Step 3 邮件 + 凭据（250 配置）

- [x] 3.1 250 `config.json`：两账号 `emailTo=["2199382542@qq.com","1653491523@qq.com"]`；检查 console `account_email.to_json` 是否覆盖并同步
- [x] 3.2 邮件附账号密码：确认 email-sender skill body 拼接点；如需改 `src/mailer.ts`/publisher 调用处，加账号信息块（凭据从 250 本地 `.credentials-note` 600 权限读取，不进 git）
- [x] 3.3 测试邮件一篇 dryrun 验证两邮箱收件 + 含凭据

## Step 4 manim（250）

- [x] 4.1 `pip3 install manim` + cairo/pango 依赖；`manim --version` 验证；渲染一个 hello scene 出 gif
- [ ] 4.2 失败则 `config.json manim.enabled=false`（确认 publisher 对 scene.py 渲染失败不阻塞发布，必要时补 try/catch）

## Step 5 写入 250 控制台

- [x] 5.1 备份：`bash deploy/console-backup.sh`（250 上）
- [x] 5.2 rsync `out/plans/` 到 250，脚本逐周 PUT `/api/accounts/{1,2}/plans`（先登录拿 cookie）
- [x] 5.3 校验：`sqlite3 console/console.db` 两账号 W42=3天、W43~W72 各7天、days 合计各 211；抽查 `data/second/plans/2026-W42.json` 与 `2026-W43.json` 物化一致
- [x] 5.4 确认已发布文章/草稿记录不受影响

## Step 6 端到端验收（AC6）

- [x] 6.1 250 同步改动文件（cover.ts/config.ts/mailer.ts/publisher.ts 按 ACCEPTANCE-250 §2 外科式同步 + sha1 校验）
- [x] 6.2 首日（10-16）调度发布验证：文章生成 → 草稿/发布 → ffmpeg 封面 → 邮件到两邮箱（10-16 07:30 调度器自动跑；若写入完成时间已过 07:30 则当天手动 enqueue 一篇验证）
- [x] 6.3 检查 10-16 发布结果与邮件实收

## 回滚

- 计划删除：按 period_key 从 plans 表 DELETE W43~W72，W42 从备份恢复原 7 天计划
- 封面：`cover.mode` 改回 `template`
- 邮件：`emailTo` 清空恢复原状
