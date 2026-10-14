# C3 · 内容工作台（console-content-workbench）

> 父任务：`10-13-wechat-flow-console`（源需求 R3.1–R3.3、R3.6）。设计见父 `design.md` §5.4。
> 依赖 C1、C2。

## Goal
让用户用网页完成"编辑计划 → 生成 → 推送草稿箱 → 查看结果 → 不满意重生成"的完整闭环。

## Requirements
- 计划编辑 UI：周（≤7 天）/ 月摘要；条目含日期、选题、摘要、目标字数、备注。
- "生成"触发生成任务并实时显示状态（SSE `job.progress`）。
- 产物查看：文章 md、封面、公式渲染结果、草稿箱正文校验结果。
- 推送结果**以 `verifyDraftBody()` 为唯一真相源**，UI 显示 `✅ 正文校验` 或失败详情。
- 重生成：带用户反馈 → 新 `articles.version`（`parent_id` 链），旧版本保留可查、可对比。
- 失败显形：`ok:false` + 原因 + 重试入口。

## Acceptance Criteria
- AC-5 配置"下周 7 天"并触发生成：任务状态可见流转，文章落 `data/<alias>/articles/`，`bun src/cli.ts drafts --date <日期>` 输出含 `✅ 正文校验`。
- AC-7 对已生成文章"重新生成"+反馈：产生新版本，旧版本可查，新版本可再次推送草稿箱。
- AC-11 生成/推送失败一律显示失败详情，不得显示成功。

## Out of Scope
直接改 `verifyDraftBody`/发布链路实现（只允许传参复用）、agent 对话（C4）。

## Dependencies
C1、C2。真机验收需在 250 上执行（G2 规则）。

## Notes / 关联文件
`src/console/ui/*`、engine `src/publisher.ts`、`src/media.ts`、`src/cover.ts`、`src/wechat.ts`（`verifyDraftBody`）。
