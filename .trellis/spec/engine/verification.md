# Verification & Truth Source

> **唯一真相源是公众号后台草稿箱的真实 DOM，不是 skill 的 stdout，也不是我们自己的中间状态。**
> 这条规则来自一次真实事故：草稿箱里只有标题、正文为空，而整条链路都在报“成功”。

---

## 三层置信度（从弱到强）

| 层 | 判据 | 可信度 |
|---|---|---|
| ① skill 自报 | 打印 `Done.` / `Body content verified OK` | **不可信**（无条件打印的假阳性） |
| ② 草稿箱标题匹配 | 在已登录页面查 `action=list_ex`，标题命中 | 中等（只证明标题在） |
| ③ 正文 DOM 校验 | 读 `.rich_media_content .ProseMirror` 的真实长度 | **强（发布成功的唯一依据）** |

`verifyDraftPublished()` 做 ②；`verifyDraftBody()` 做 ③。发布流程必须在 ② 通过后**再过 ③**。

---

## 硬性规则

1. **正文选择器**：只用 `.rich_media_content .ProseMirror`。绝不用裸 `.ProseMirror`
   （编辑器里有多个，裸选择器会命中标题框 `title-editor__input`）。
2. **正文长度判定**：剔除占位符“从这里开始写正文”后再计数，低于阈值判失败
   （公式文章按加权规则，见 `操作手册.md` §8.2）。
3. **粘贴**：必须走 CDP 编辑命令 `Input.dispatchKeyEvent { commands: ['copy'|'paste'] }`
   （在 Blink 内部执行，不依赖 X 焦点）；粘贴前必须重新聚焦正文
   （`prepareEditorPasteTarget()`）。
4. **上游升级后**：`deploy/patch-baoyu-skill.sh` 是**自适应**的 —— 检测到上游已原生修复就跳过，
   只给旧版打补丁。`doctor` 检查的是**能力**（选择器 + 聚焦），不是“补丁是否存在”。
5. **失败要显形**：`publish` 失败时写 `published.json(ok:false)` 并发失败邮件，
   **不得**静默记成成功。

---

## 验收命令（真机，唯一可信凭证）

```bash
# 草稿箱到底有什么 + 正文是否正常（带日期会做正文校验）
bun src/cli.ts drafts -a second --date 2026-10-12
# → ✅ 正文校验: ✅ 正文正常 (body=2806 chars («开学一个多月…») (min 200))

# 三维核对：草稿箱 / 状态文件 / 日志
systemctl start wechat-publish.service
journalctl -u wechat-publish.service -n 120 --no-pager
```

---

## 封面（S10 / O-B）验收

封面同属“确定性产物”，验收口径一致：**只认草稿编辑器里封面预览的真实 `background-image`**。

- **成功判据**：上传前后 `#js_cover_area` 内 `.js_cover_preview_new` 的 `background-image` 由空变为真实 `https://mmbiz.qpic.cn/...` URL。
- **只读复验**：`bun src/cli.ts cover -a <acct> --date <d> --probe` → `coverVisuals` 里 `js_cover_preview_new` 的 `bg` 非空即已持久化（重开编辑器仍成立）。
- **发布链路**：`publish` 会重写草稿从而清掉旧封面，故封面必须由 `publisher` 在 `verifyDraftBody` 通过后设置（不能只靠事后单独 `cover`）。
- **降级即通过**：封面任一步失败必须只 `warn` + 保留“手动选封面”，`publish` 仍 `done`（正文不受影响）。这本身就是一条必须验的路径。

真机步骤与踩坑记录见 [`deploy/ACCEPTANCE-250.md`](../../../deploy/ACCEPTANCE-250.md)。

---

## 检查清单

- [ ] 改动没有把“上游成功提示”当成“发布成功”。
- [ ] 发布链路仍以草稿箱回查 + 正文 DOM 校验收尾。
- [ ] 失败路径会写状态 + 报警，而不是静默跳过。
- [ ] 封面成功以封面预览 `background-image` 变化为准；封面失败仍不阻断正文（降级已验证）。
- [ ] 结论用真实命令输出表述（贴 `body=NNNN chars` / `cover set ✓ (after=https://mmbiz.qpic.cn/…)` 这类数字），不用“应该没问题”。
