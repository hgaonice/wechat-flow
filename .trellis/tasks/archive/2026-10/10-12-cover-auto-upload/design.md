# Design · O-B：CDP 驱动编辑器封面弹窗

> 依据：`research.md`（skill v1.118.2 浏览器路径不支持封面）。
> 约束：**封面属确定性产物，失败必须降级，绝不阻断正文发布**（`spec/engine/ai-determinism.md`、`verification.md`）。

## 1. 总体思路

正文草稿写入 + `verifyDraftBody` 通过后，用**同一个已登录的 CDP 会话**打开该草稿编辑器，
在页面内**点击「封面」入口 → 上传 `cover.png` → 确认 → 保存草稿**，最后回查封面真实状态。

全部走 `mp.weixin.qq.com` 的浏览器会话（cookie/token），**不经过 `api.weixin.qq.com`，不受 IP 白名单限制**。

## 2. 新增接口（`src/wechat.ts`）

```ts
export interface SetCoverOptions {
  browser: BrowserConfig;
  skillDir: string;
  title: string;        // 用标题定位草稿（与 verifyDraftBody 相同策略）
  coverPath: string;    // data/<alias>/imgs/<date>/cover.png
  timeoutMs?: number;
}
export interface CoverResult { ok: boolean | null; detail: string; stage?: string }

export async function setDraftCover(opts: SetCoverOptions): Promise<CoverResult>;
export async function probeDraftCover(opts: SetCoverOptions): Promise<CoverResult>; // 只读：dump 封面相关 DOM
```

复用现成设施：`openMpSession()`、`fetchDrafts()`、编辑器 URL（`t=media/appmsg_edit&...`）、`Target.createTarget/attachToTarget`、`DOM.setFileInputFiles`。

## 3. 流程与阶段（每步失败即带 stage 返回，不抛）

| stage | 动作 | 失败处理 |
|-------|------|----------|
| `session` | 打开 mp 会话 | 返回 `ok:null`，调用方告警 |
| `locate` | 按标题在草稿箱找到 appmsgid/type | `ok:false` |
| `editor` | 创建编辑器 tab，等 `.rich_media_content` 就绪 | `ok:false` |
| `open-cover` | 点击「封面」入口（候选选择器 + 文本兜底） | `ok:false` |
| `file-input` | 定位弹窗内 `input[type=file][accept*=image]` | `ok:false` |
| `upload` | `DOM.setFileInputFiles` 注入 `cover.png` | `ok:false` |
| `confirm` | 点「确定/确认/完成/下一步」 | `ok:false` |
| `verify` | 回查封面入口已含真实图片（非占位） | `ok:false` |
| `save` | 点保存草稿（`#js_submit`，若存在） | 记 warn，仍算成功（编辑器多自动保存） |

**成功定义**：`verify` 阶段封面入口出现真实 `<img>`（`src` 非空且非 `data:` 占位）。

## 4. 面对未知 DOM 的策略（重要）

真实封面弹窗 DOM 无法在开发机观测，因此：

1. **候选选择器列表 + 文本兜底**：入口按一组已知候选类名依次尝试，再兜底“可见元素文本含『封面』”。文件输入、确认按钮同理。
2. **只读探针**：`probeDraftCover()` dump 出——所有 `input[type=file]`（含 class/accept）、class/id/文本含 cover/封面 的元素、是否存在 iframe、候选命中情况。用 `bun src/cli.ts cover --date <d> --probe` 在 250 上跑一次即可定准选择器。
3. **配置开关 + 降级**：`cover.uploadToDraft`（默认 `false`）。开启后仍失败也不影响发布，只在日志/邮件提示“封面需手动选”。
4. **选择器集中一处**：全部候选常量放在 `src/wechat.ts` 顶部，改一处即可。

## 5. publisher 集成点

`src/publisher.ts` 在 `body.ok === true` 之后、`cleanupAppmsgTabs` 之前：

```ts
if (cfg.publishMethod === "browser" && cfg.cover.uploadToDraft && fs.existsSync(coverPath)) {
  const c = await setDraftCover({ browser: cfg.browser, skillDir: cfg.skillDir, title, coverPath });
  coverUploaded = c.ok === true;
  if (!coverUploaded) log.warn(`封面自动上传未成功（${c.stage}）：${c.detail} — 请在后台手动选封面`);
}
```

通知邮件文案随之调整（成功则去掉“需手动选为封面”，失败保留）。

## 6. CLI

```
bun src/cli.ts cover --date 2026-10-13            # 给当天草稿自动设封面（回填/测试用）
bun src/cli.ts cover --date 2026-10-13 --probe    # 只读探测封面弹窗 DOM（不改任何东西）
```

## 7. 验收（G2 真机门）

- [ ] `cover --probe` 输出封面入口/文件输入/确认按钮的真实选择器
- [ ] `cover --date <d>` 后，后台草稿封面显示为 `cover.png`
- [ ] 断网/选择器失效时：发布仍成功，邮件提示“需手动选封面”（降级验证）
- [ ] `cover.uploadToDraft:true` 跑一次完整 `publish`，草稿自带封面
- [ ] `README.md` / `操作手册.md` / `AGENT.md` 更新

## 8. 回滚

- 配置 `cover.uploadToDraft:false` 即完全退回现状。
- 代码改动集中在 `wechat.ts`（新增函数）、`publisher.ts`（一段 try/catch）、`cli.ts`（新命令）、`config.ts`（一个字段）。
