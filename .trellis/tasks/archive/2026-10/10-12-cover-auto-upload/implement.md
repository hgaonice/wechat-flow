# Implement · O-B 封面自动上传（CDP 驱动封面弹窗）

> 2026-10-13，作者 gaoh/pi。设计见 [design.md](./design.md)。
> **250 真机验收通过（G2，2026-10-13）**：成功路径 + 降级路径均已实测。

## 改动清单

| 文件 | 改动 | 说明 |
|---|---|---|
| `src/wechat.ts` | **新增** `setDraftCover()` / `probeDraftCover()` + `SetCoverOptions` / `CoverResult`；`COVER_SELECTORS` / `COVER_*_EXPR` / `COVER_HELP` 常量；`openDraftEditor()` / `closeDraftEditor()` / `evalJson()` / `collectFileInputs()` / `findCoverFileInput()` 内部辅助 | 复用 `openMpSession` / `fetchDrafts` / 编辑器 URL / CDP 会话；文件框走 **DOM 树遍历**（覆盖 iframe/shadow）；失败按 stage 返回，**从不抛** |
| `src/config.ts` | `cover.uploadToDraft?: boolean`（默认 `false`）；`AccountCfg.cover` 支持按账号覆盖 | 默认关：真机校准选择器后再开 |
| `src/publisher.ts` | `verifyDraftBody` 通过后调用 `setDraftCover`（`uploadToDraft && browser` 才跑），try/catch 降级；`coverUploaded` 影响通知文案 | **不改发布成功判定**；封面失败只 warn + 保留“手动选封面”提示 |
| `src/cli.ts` | 新命令 `cover`（`--date` / `--title` / `--cover` / `--probe` / `--explore` / `-a` / `--all`）；`USAGE` 更新 | `--probe` 只读 dump，供真机校准选择器 |
| `config.example.json` | `cover.uploadToDraft: false` | 示例与文档一致 |
| `package.json` | `drafts` / `cover` / `typecheck` 脚本；devDeps `typescript@^5` + `@types/node@^22` | devDeps 仅类型检查，**runtime 仍零依赖** |
| `.trellis/spec/engine/{index,quality-guidelines}.md` | tsc 由“可选/需自行装”改为“devDeps 已随仓库提供” | 类型检查现为标准门 |
| `README.md` / `docs/操作手册.md` / `src/README.md` / `ARCHITECTURE.md` / `AGENT.md` | 命令、配置、原理、排障、进度同步 | 操作手册新增 §2.3 |

## 封面流程（stage，250 实测）

`session → locate → editor → open-cover → file-input → upload → confirm → verify → save`

真实交互为 **两步弹窗**：

1. 点 `#js_cover_area`（空态文案「拖拽或选择封面」）→ 打开操作浮层；
2. 点 `a.pop-opr__button.js_imagedialog`（「从图片库选择」）→ 打开 **「选择图片」dialog**（`weui-desktop-dialog`）；
3. 在该 dialog 的 `input[type=file]`（**经 DOM 树遍历 + 祖先路径打分**选中，避开正文 `js_editor_insertimage` 的诱饵 input）上 `DOM.setFileInputFiles` 注入 `cover.png`；
4. 轮询「选择图片」dialog：`下一步` 解除 disabled **且** 图片自动选中（`.weui-desktop-img-picker__item.selected`）→ 点 `下一步`；
5. 进入 **「编辑封面」dialog** → 点 `确认`；
6. **轮询** `#js_cover_area` 封面预览的 `background-image` 变为真实 URL（确认后异步 XHR，需等待）→ 点 `#js_submit button` 保存。

关键坑（真机踩过）：
- **保存必须点 `#js_submit button`（内层 button）**，点 `#js_submit` 容器不会保存 → 封面不持久。
- **确认后要轮询**，立即读 DOM 会读到旧值 → 误判失败。
- **上传后不等自动选中就点 `下一步`** 会因按钮 disabled 而空转；已改为轮询 `下一步` 可点 + 已选中。
- **不点任意缩略图兜底**：上传失败时若点首个缩略图会误设成图库里旧图 → 故不做兜底，直接 `ok:false` 降级。

## 验证

| 项 | 命令 | 结果 |
|---|---|---|
| 语法/打包 | `bun build --target=bun src/cli.ts` | ✅ exit 0 |
| 类型 | `bunx tsc --noEmit` | ✅ 0 错误 |
| USAGE | `bun src/cli.ts` | ✅ 显示 `cover` |
| 成功路径（250） | `cover --date 2026-10-13` | ✅ `draft cover set ✓`，`--probe` 复读背景图为真实 URL |
| 持久化（250） | `cover --probe`（重开编辑器） | ✅ `js_cover_preview_new` bg = `https://mmbiz.qpic.cn/...` |
| 完整发布（250） | 开 `cover.uploadToDraft=true` 后 `publish --date 2026-10-13 --reuse --force` | ✅ 正文校验 + `draft cover set ✓` + 邮件送达 |
| 降级路径（250） | 塞入非法 `cover.png` 跑 `cover --date` | ✅ `❌ 封面未设置（upload）…` exit 1，**不误设、不抛** |
| 降级路径（250） | 封面阶段 CDP 超时后跑 `publish` | ✅ `done`，邮件含「封面自动上传未成功…请手动选封面」 |
| 开关（250） | `drafts --date` | ✅ `✅ 正文校验` |

## 回滚

`cover.uploadToDraft:false` 即完全退回旧行为（代码仍在，不进发布路径）。
250 备份：`config.json.pre-cover-verify.bak`、`.cover-verify-backup/`（改动前 4 个 `src/*.ts`）。
