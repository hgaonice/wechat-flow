# 250 真机验收清单（S10 封面自动上传 O-B）

> 目标机：`root@192.168.0.250`（`/root/wechat-flow`，非 git 仓库）。
> 适用：**任何改动发布链路 / 封面（`src/{wechat,publisher,cli,config}.ts`）后**，上线前在 250 复跑本清单（对应 `AGENT.md` G2 门）。
> 最近一次全绿：**2026-10-13**（S10 封面自动上传，成功 + 降级双路径）。

## 0. 环境约定

```bash
# 从开发机（192.168.0.251）SSH 到 250；过滤 trellis 代理噪音
SSH='ssh -o BatchMode=yes -o ConnectTimeout=8 root@192.168.0.250'

# 250 上每次执行前的前置环境（bun 在 nvm 下，非 /root/.bun）
ON250='bash -lc "
  cd /root/wechat-flow;
  export DISPLAY=:99 HOME=/root XDG_RUNTIME_DIR=/tmp/runtime-root;
  export PATH=/root/.nvm/versions/node/v24.14.1/bin:\$PATH
  '
```

> 账号：`second`（cdpPort 9222，用户数据目录 `/root/.local/share/baoyu-skills/wechat-second`）。
> 依赖服务：Xvfb `:99` 常驻；Chrome 带 `--remote-debugging-port=9222` 常驻。

## 1. 本地静态门（开发机）

```bash
cd /workspaces/other/weixin/wechat-flow
export PATH=/root/.bun/bin:$PATH
bun build --target=bun src/cli.ts      # 期望 exit 0
bunx tsc --noEmit                      # 期望 0 错误
bash tools/repomap.sh --check          # 期望 exit 0（改代码后先 bun tools/repomap.sh 刷新 TREE.md）
```

## 2. 外科式同步到 250（**不要**跑完整 `deploy/deploy.sh`）

`deploy.sh` 全量会推送 `node_modules` 等本地内容并删除 250 的根级 `操作手册.md`。**只同步改动文件**：

```bash
$SSH 'mkdir -p /root/wechat-flow/.cover-verify-backup'
$SSH 'cp -f /root/wechat-flow/src/{wechat,publisher,cli,config}.ts /root/wechat-flow/.cover-verify-backup/ 2>/dev/null; true'   # 备份
rsync -a -e "ssh -o BatchMode=yes -o ConnectTimeout=8" src/wechat.ts src/publisher.ts src/cli.ts src/config.ts root@192.168.0.250:/root/wechat-flow/src/
# 校验一致
for f in wechat publisher cli config; do
  a=$(sha1sum src/$f.ts | cut -d' ' -f1)
  b=$($SSH "sha1sum /root/wechat-flow/src/$f.ts" 2>/dev/null | cut -d' ' -f1)
  [ "$a" = "$b" ] && echo "OK $f" || echo "MISMATCH $f"
done
```

**250 上语法确认**：

```bash
$SSH "$ON250; bun build --target=bun src/cli.ts >/dev/null 2>&1 && echo BUILD_OK"
$SSH "$ON250; bun src/cli.ts | grep -q cover && echo COVER_CMD_PRESENT"
```

## 3. 封面探针（只读，校准选择器）

```bash
$SSH "$ON250; bun src/cli.ts cover -a second --date 2026-10-13 --probe" 2>&1 | grep -v 'UNDICI-EHPA\|trace-warnings'
```

**期望**：输出 `{ "dump": { ... } }`，含 `coverAreaHTML`（空态文案「拖拽或选择封面」）、`coverVisuals`、`coverClassEls`。
若 DOM 结构变了（找不到 `#js_cover_area`），需按 dump 更新 `src/wechat.ts` 顶部 `COVER_SELECTORS`。
排查用 `--explore`（额外注入 `coverPath` 做一次完整彩排）。

## 4. 成功路径：设封面

```bash
$SSH "$ON250; bun src/cli.ts cover -a second --date 2026-10-13"
```

**期望日志**（顺序）：
```
cover: clicked cover entry (#js_cover_area ...)
cover: opened 图片库 (.js_imagedialog)
cover: uploaded cover.png (input accept=image/bmp, image/png, ...)
cover: clicked «下一步»
cover: clicked «确认»
cover: clicked 保存 (#js_submit button)
draft cover set ✓ (before=... → after=https://mmbiz.qpic.cn/...)
✅ 草稿封面已设置（verify）
```

**持久化复验**（重开编辑器，只读）：

```bash
$SSH "$ON250; bun src/cli.ts cover -a second --date 2026-10-13 --probe" 2>&1 \
  | grep -v 'UNDICI-EHPA\|trace-warnings'   # 期望 coverVisuals 中 js_cover_preview_new 的 bg=url("https://mmbiz.qpic.cn/...")
```

## 5. 完整发布（开自动封面）

```bash
# 开开关（默认关）；先备份
$SSH 'cd /root/wechat-flow && cp -n config.json config.json.pre-cover-verify.bak; python3 -c "import json;c=json.load(open(\"config.json\"));c.setdefault(\"cover\",{})[\"uploadToDraft\"]=True;json.dump(c,open(\"config.json\",\"w\"),ensure_ascii=False,indent=2)"'

$SSH "$ON250; bun src/cli.ts publish -a second --date 2026-10-13 --reuse --force" 2>&1 | grep -v 'UNDICI-EHPA\|trace-warnings'
$SSH "$ON250; bun src/cli.ts drafts -a second --date 2026-10-13" 2>&1 | grep -v 'UNDICI-EHPA\|trace-warnings'
```

**期望**：
- `draft verified in 草稿箱 ✓` → `draft body verified ✓ ...` → `draft cover set ✓ ...`；
- `drafts` 输出 `✅ 正文校验`；
- 邮件送达（标题 `✅ <date> 已推送到草稿箱…`，正文含 `封面：已自动设置`）。

## 6. 降级路径：封面失败**不得**阻断正文

**(a) 非法封面图**

```bash
$SSH 'cd /root/wechat-flow && cp -f data/second/imgs/2026-10-13/cover.png /tmp/cover-real.png && printf "not a real png" > data/second/imgs/2026-10-13/cover.png'
$SSH "$ON250; bun src/cli.ts cover -a second --date 2026-10-13; echo EXIT=\$?" 2>&1 | grep -v 'UNDICI-EHPA\|trace-warnings'
$SSH 'cp -f /tmp/cover-real.png /root/wechat-flow/data/second/imgs/2026-10-13/cover.png'   # 还原
```

**期望**：轮询约 60s 后 `❌ 封面未设置（upload）：uploaded image never became selectable…`，`EXIT=1`；**不会**误设图库里的旧图为封面。

**(b) 发布链路内降级**（覆盖阶段 CDP/会话异常等）

```bash
$SSH "$ON250; bun src/cli.ts publish -a second --date 2026-10-13 --reuse --force" 2>&1 | grep -v 'UNDICI-EHPA\|trace-warnings'
```

**期望**：`[WARN] 封面自动上传未成功（<stage>）：… — 请在后台手动选封面`，但随后仍 `done: … media_id=(draft)` 且邮件送达。
> 注：`publish` 会重写草稿从而**清掉旧封面**，所以封面必须由发布流程在校验正文后设置；若封面步骤失败，草稿将无封面（属预期降级态）。

## 7. 回滚

```bash
# 关闭开关即退回旧行为（代码仍在，不进发布路径）（在 250 上）
$SSH 'cd /root/wechat-flow && cp -f config.json.pre-cover-verify.bak config.json'
# 代码回滚（在 250 上恢复到改动前的 4 个 src 文件）
$SSH 'cd /root/wechat-flow && cp -f .cover-verify-backup/wechat.ts .cover-verify-backup/cli.ts .cover-verify-backup/publisher.ts .cover-verify-backup/config.ts src/'
```

## 8. 真机已知要点（踩坑记录，改代码时勿回退）

| 要点 | 说明 |
|---|---|
| 保存点 `#js_submit button` | 点 `#js_submit` **容器无效**，封面不持久；必须点内层 `button`（对齐 `wechat-article.ts:1088`） |
| `确认` 后须**轮询** | 点「编辑封面」的「确认」触发异步 XHR，立即读 DOM 会读到旧值；轮询 `#js_cover_area` 背景图直至变化 |
| 上传后等**自动选中** | 必须等「下一步」解除 disabled 且图片 `.selected`，否则空转 |
| **不做缩略图兜底** | 上传失败时点首个缩略图会误设图库旧图 → 宁可 `ok:false` 降级 |
| 文件框选择 | 走 DOM 树遍历 + 祖先路径打分，避开正文 `js_editor_insertimage` 的诱饵 `input[type=file]` |
| 封面预览是 `background-image` | `.js_cover_preview_new` 用 `background-image`，不是内层 `<img>` |
| 遗留标签页 | 失败发布会留下 `appmsg_edit` 标签，可用 CDP `GET /json/close/<id>` 关闭；`publish` 结尾会 `cleanupAppmsgTabs` |

## 9. 结果记录

| 日期 | 版本/提交 | 成功路径 | 降级路径 | 结论 | 执行人 |
|------|-----------|----------|----------|------|--------|
| 2026-10-13 | S10 O-B | ✅ | ✅ | G2 通过 | gaoh/pi |
