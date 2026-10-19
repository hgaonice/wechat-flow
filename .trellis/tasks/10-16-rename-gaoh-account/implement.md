# Implement：账号改名（每天讲点理）

> 纪律：每步留**真实命令输出**或**产物路径**；改 250 前先本地全绿；不手改 `config.json`。
> 顺序原则：**先仓库真源 → 再 250 DB（真源） → 再 250 生成物/草稿**，每步可独立回滚。

---

## 阶段 0：规划门

- [x] 任务创建 `10-16-rename-gaoh-account`（`prd.md` 已收敛 D1–D3）
- [x] `design.md`
- [ ] **R0**：用户确认本规划摘要 → `python3 .trellis/scripts/task.py start`

---

## 阶段 1：仓库真源（零风险、可 git revert）

- [ ] **S1** `prompts/cta/gaoh.md`：账号名 → `{{accountName}}`；末句 → 「每天一个理科小道理，我们下次接着聊。」
  - 验：`grep -c "每天讲点理\|{{accountName}}" prompts/cta/gaoh.md`；动作词数 ≥3（`grep -c -e 点赞 -e 在看 -e 转发 -e 收藏 -e 评论 -e 留言`）
- [ ] **S2** `config.example.json` 三键（`displayName`/`author`/`subjectPrefix`）
  - 验：`python3 -c "import json;d=json.load(open('config.example.json'));print(d['accounts']['gaoh'])"`
- [ ] **S3** `README.md`（2 处）、`docs/操作手册.md`（账号表 + 示例配置）
- [ ] **S4** `tools/gen-grade9-plans.ts`：`displayName` + gaoh 的视角/标题模板措辞
  - 验：`bunx tsc --noEmit`；`bun build --target=bun src/cli.ts`
- [ ] **S5** `AGENT.md`：当前状态文字更新 + §9 新增改名记录（old→new、原因、影响面）
  - 验：`grep -rn "gaoh的技术分享" --include='*.md' --include='*.json' --include='*.ts' . | grep -v node_modules | grep -v '^./data/'` → 仅剩白名单（§9 历史日志 / `archive/**`）

## 阶段 2：250 控制台 DB 改名（**运行时真源**）

- [ ] **S6** 执行一次性脚本（ssh + curl，登录复用 `.credentials-note`；**回传完整 overrides**）：
  ```bash
  # 伪代码要点：GET /api/accounts/2 → patch 三键 → PUT /api/accounts/2 {overrides}
  #            → 再 GET /api/accounts/2 与 config.json 对照
  ```
  - 验（AC1）：250 `config.json` 三键 = 新值；`GET /api/accounts/2` 一致
  - 验（AC8）：`console.db` 新增 `audit(account.update, target=gaoh)`
  - 验（不丢键）：`emailTo`（2 个邮箱）、`cover.mode=ffmpeg`、`cdpPort=9223`、`dataDir`、`promptsDir` 全部保持
  - 回滚：旧三值改回 + 重跑；记录旧值于本文件下方「执行记录」
- [ ] **S7** 确认**无需重启**：`worker.ts:63` 逐任务 `loadConfig` → 用 `publish --reuse --dry-run` 观察日志中的账号名（应已是新名，且**不重启**服务）

## 阶段 3：250 生成物与草稿

- [ ] **S8** `data/gaoh/articles/*.md`（8 文件）旧名 → 新名（先备份 `.bak`）
  - 验（AC4）：`grep -rc "gaoh的技术分享" data/gaoh/articles/*.md | grep -v ':0'` → 空
- [ ] **S9** 重发 10-16 gaoh 草稿（唯一需要重推的一篇，因其 CTA 含旧名）
  - 验（AC5）：`publish -a gaoh --date 2026-10-16 --force --reuse` → `cta: present` → `drafts -a gaoh --date 2026-10-16` **✅ 正文校验**
  - 验（AC5 目视）：只读探针读草稿 DOM 末 320 字含「每天讲点理」
  - 回滚：无需（重复重发即幂等覆盖）

## 阶段 4：回归与收口

- [ ] **S10** 回归：`bun build` / `bunx tsc --noEmit`（AC7）；`plans` 表 62 行与 `data/gaoh/plans/*.json` 未变（AC6，行数 + 抽样比对）
- [ ] **S11** 全量 grep 复核（AC2）+ 文档/规范沉淀（`AGENT.md` §9；如需，`docs/操作手册.md` 已含）
- [ ] **S12** commit（`chore(account): gaoh 改名每天讲点理（定位：每天一个理科小道理）`）→ `task.py archive`

---

## 验收命令汇总

```bash
cd /workspaces/other/weixin/wechat-flow
export PATH="$HOME/.bun/bin:$PATH"
bun build --target=bun src/cli.ts >/dev/null && echo BUILD_OK
bunx tsc --noEmit && echo TSC_OK
grep -rn "gaoh的技术分享" README.md docs/操作手册.md config.example.json prompts/ tools/gen-grade9-plans.ts | wc -l   # 期望 0

ssh root@192.168.0.250 'cd /root/wechat-flow && python3 -c "import json;c=json.load(open(\"config.json\"));print(c[\"accounts\"][\"gaoh\"][\"displayName\"], c[\"accounts\"][\"gaoh\"][\"subjectPrefix\"])"'
ssh root@192.168.0.250 'cd /root/wechat-flow && grep -rc "gaoh的技术分享" data/gaoh/articles/*.md | grep -v ":0" | wc -l'   # 期望 0
```

## 风险与前置依赖

| 项 | 说明 |
|---|---|
| 前置 | 250 可 ssh + 控制台 `/health` ok；控制台凭据在 250 `.credentials-note`（已有） |
| 环境 | 250 bun 在 `/root/.nvm/versions/node/v24.14.1/bin`（非 `~/.bun`） |
| 顺序 | **先改仓库 → 再改 DB → 最后重发**；DB 改名后若立刻有定时任务跑，会直接用新名（预期） |
| 不做 | `src/**`、`plans` 数据、历史已发布草稿、别名与目录 |
