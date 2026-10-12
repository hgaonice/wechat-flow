# Research · 封面自动上传（S10）

> 只读调研，未改动任何发布代码（G5 未放行）。
> 环境：skill 源码 `/tmp/baoyu-skills/skills/baoyu-post-to-wechat`（版本 **1.118.2**，与 250 一致）。

---

## 1. 结论先行

**skill 的浏览器路径（本项目当前所用）根本不支持封面**，这是上游的**文档化限制**，不是 bug：

> `SKILL.md` §Feature Comparison 原文：
> `| Default cover fallback (imgs/cover.png) | ✗ | ✓ | ✓ | ✗ |`
> （列顺序：Image-Text / Article(API) / Article(Remote API) / **Article(Browser)**）

同时确认：

- 浏览器脚本 `scripts/wechat-article.ts` 的参数里**没有** `--cover`，全文无 `cover/thumb/media_id` 逻辑；
  发布调用链是 `--markdown/--theme/--color/--account/--title/--author/--summary/--cdp-port`。
- 封面逻辑只存在于 **API 脚本** `scripts/wechat-api.ts`：`--cover <path>` → `uploadImage(..., "material")`
  → `thumb_media_id` → 调 `cgi-bin/draft/add|update` 时带上（`thumb_media_id`，见该文件 65/377/826-834 行）。
- 因此本项目 README 里“**需在后台手动选封面**”是必然结果。

## 2. 三个可选方案

| # | 方案 | 做法 | 优点 | 代价/风险 |
|---|------|------|------|-----------|
| **O-A** | **改走 API / Remote API** | `publishMethod: "api"`；或 `--remote-host` 让 250（白名单 IP）跑 API | **原生带封面**；去掉浏览器脆弱性；最快 | 需 250 出口 IP 进白名单（`errcode 40164`）；Remote 需 SSH 可达 |
| **O-B** | **CDP 驱动编辑器封面弹窗** | 保存草稿后，用 CDP 打开编辑器「封面」弹窗，`DOM.setFileInputFiles` 上传 `imgs/<date>/cover.png`，等缩略图 → 确认 | 契合现有 D1（浏览器路径）；无需 API | 封面弹窗可能是 iframe/新结构，选择器脆弱，需真机抓 DOM |
| **O-C** | **给上游打 `--cover` 补丁**（browser 路径） | 仿照 body 修复，写 `patch-baoyu-skill.sh v3` | 干净、可复用 | 依赖上游、增加补丁维护面 |
| O-D | 半自动 | 脚本用 CDP 打开封面弹窗停在“选图”，人工点确认 | 简单 | 仍需人工，未真正自动化 |

## 3. 可直接复用的既有技术（支撑 O-B）

- skill 的**图片上传**已用 CDP 文件注入：
  `scripts/wechat-article.ts:688` `DOM.querySelector('input[type="file"][accept*="image"]')`
  → `:693` `DOM.setFileInputFiles`。
  封面弹窗内同样是一个 `input[type=file][accept*=image]`，技术路径一致（注意弹窗打开时页面可能存在多个 file input，需限定作用域）。
- 正文图片占位符流程 `WECHATIMGPH_`（`md-to-wechat.ts`）+ `selectAndReplacePlaceholder()`（`wechat-article.ts:521`）
  可参考“上传后校验 DOM 变化”的写法；封面同理需要“上传后校验封面缩略图出现”。
- 本仓库已有只读探针 `tools/draft-probe.ts`（读 `.rich_media_content .ProseMirror` 的真实 DOM），
  O-B 只需**扩展该探针**输出封面弹窗结构，即可在 250 上无副作用地摸清选择器。

## 4. 建议（待 G5 用户确认）

**先并行验证两件事，用结果决定方向：**

1. **O-A 可行性（最高杠杆，先做）**：在 250 上确认出口 IP 是否可加入公众号 IP 白名单。
   - 若可行 → 选 O-A：`publishMethod: "api"`，封面零额外开发，且顺带消除浏览器/登录自愈的脆弱性。
   - 若不可行 → 进 O-B。
2. **O-B 只读探测**：扩展 `tools/draft-probe.ts`，在草稿编辑器里打开「封面」入口，打印其 DOM/iframe/文件输入结构。

**推荐**：O-A 优先；不可行则 O-B（不推荐一上来就 O-C，避免扩大补丁维护面）。

## 5. 在 250 上执行的最小验证命令（人工确认用）

```bash
# (a) O-A 可行性：看微信 API 是否仍拒绝本机出口 IP
curl -s "https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=<APPID>&secret=<SECRET>" \
  | head -c 300      # 期望：{"access_token":"...","expires_in":7200}；若 40164 则被白名单卡住

# (b) skill 是否真的无 --cover（browser 路径）
grep -n -- "--cover" /root/.agents/skills/baoyu-post-to-wechat/scripts/wechat-article.ts || echo "无 --cover（符合预期）"

# (c) O-B 探测：先看封面入口的 DOM（只读）
bun tools/draft-probe.ts 9223 latest      # 现有正文探针；扩展后再加封面字段
```

## 6. 开放问题（阻塞项）

- [ ] 250 出口 IP 能否加入白名单？（决定 O-A/O-B）
- [ ] 封面弹窗是否在 iframe 内？file input 选择器与作用域？
- [ ] 设置封面后，是“立即生效并保存草稿”，还是需要额外点“保存”？
- [ ] 多账号下封面/素材是否隔离？（素材库按号独立，应无碍）

## 7. 参考

- `README.md` §发布方式（L485-527）——为何选浏览器、`40164` 实测、API 回退步骤
- `.trellis/spec/engine/verification.md` —— 任何方案都必须以草稿箱真实状态为验收
- 任务 `.trellis/tasks/10-12-cover-auto-upload/prd.md`
