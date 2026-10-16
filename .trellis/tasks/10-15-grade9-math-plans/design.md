# Design：九上数学 211 篇推文计划批量入排程

## 1. 总体方案

```
本机生成计划 JSON（31 周 × 2 账号）
  → rsync 到 250
  → 250 上走控制台 API PUT /api/accounts/:id/plans（每周一次调用）
      → DB 落库 + 自动物化 data/<alias>/plans/<week>.json
  → 现有 scheduler 每日 07:30 自动 publish
  → publisher 内：ffmpeg 封面 + manim gif（条件） + 邮件推送
```

原则：**不碰调度器与发布链路**；封面改 ffmpeg 是引擎层最小改动（`src/cover.ts` 内部换实现或新增 mode）。

## 2. 计划生成器（本机一次性脚本）

新增 `tools/gen-grade9-plans.ts`（bun 脚本，不进引擎）：

- 内置 37 讲大纲数据（讲号/主题/板块列表/manim 适用标记）。
- 逐板块生成 `PlanDay`：
  - `date`：从 2026-10-16（周五）起逐日递增，211 天 = 31 周（W42 末 3 天 10-16~10-18 + W43~W72 完整 30 周，至 2027-05-14）。
  - `module`：`第N讲 主题`，`board`：板块名，`lecture: N`，`isSummary: bool`。
  - `topic`：板块名 + 中考定位短语（如「根的判别式——中考必考的参数取值问题」）。
  - `angle`：按账号区分两种写法模板（second=教学视角「孩子这类题总丢分…」；gaoh=技术视角「用代数结构看…」）。
  - `titleSuggestion`：带钩子的标题模板。
  - `outline`：5~7 条，含：知识点精讲 → **历年中考真题拆解（2~3 道，标注年份/地区）** → 易错点 → 变式。真题由生成器按板块匹配（内置真题要点库，用户已确认此方案），agent 写文章时再展开。
  - `manimHint`：适用板块给出场景建议（如「抛物线平移动画」「旋转 60° 构全等演示」），汇总篇不加。
- 输出：`out/plans/{second,gaoh}/2026-Wxx.json`（与物化格式一致，便于直接校验）。
- 校验：211 天连续、每周 ≤7 天、date 与 ISO week 一致（复用 `validatePlanInput` 的规则口径）。

## 3. 写入 250 控制台

- 认证：控制台 API 需登录 cookie。方案：在 250 本地用 `curl` 先 `POST /api/login`（控制台 admin 凭据从 250 `.env`/secrets 读取，脚本内不落明文到 git）。
- **W42 特例（用户已确认）**：upsert 整周覆盖——W42 的 days 仅含新 3 天（10-16~10-18 = 第1讲前3篇），不做旧天合并；已发布文章记录不受影响。
- 顺序：先 second 后 gaoh，每周一个 PUT（W42 即 3 天版），失败即停并打印。
- 幂等：`upsertPlan` 天然幂等，重跑安全。
- 校验脚本：sqlite3 查询两账号 W42=3天、W43~W72 各7天、新计划合计 211；抽查物化文件。

## 4. 邮件推送（R3）

- 配置：`config.json` 两账号 `emailTo` 改为 `["2199382542@qq.com","1653491523@qq.com"]`（用户原话"发送给这两个邮箱"，不按账号区分）。注意 console 的 `account_email.to_json` 可能覆盖 config——落库后检查并同步该表。
- 邮件附账号密码（**用户已确认：控制台 Web 管理后台的登录用户名/密码**）：在发布成功邮件 body 尾部追加账号信息块：
  - 内容：控制台登录 URL、控制台用户名/密码、对应公众号账号别名。
  - 实现：优先**不改代码**——检查 email-sender skill 的 body 是否可经模板注入；若不行，在 `src/mailer.ts` 的 `sendMail` 调用处（publisher 发邮件点）拼接账号块，凭据从 250 本地文件 `/root/wechat-flow/.credentials-note`（chmod 600，不进 git）读取。

## 5. ffmpeg 封面（R5）

- 改造 `src/cover.ts`：新增 `generateFfmpegCover()`，用 ffmpeg lavfi 生成 900x500 封面：
  - 深色渐变底（`gradients` filter 或纯色+暗角），`drawtext` 写主标题（知识点）+ 副标题（讲次/账号名），可选叠加简单数学装饰（用 drawtext 画 ∫ ∑ √ π 符号或公式文本）。
  - 字体复用现有 `detectCjkFont` 的候选列表。
- `config.json` `cover.mode` 支持 `"ffmpeg"`（默认仍 `template`，250 上切换）；`mode=ffmpeg` 时走新函数。
- 兼容：保留 ImageMagick 路径不动；250 无 convert 时自动降级 ffmpeg（顺序：mode 指定 → ffmpeg → convert）。

## 6. manim gif（R4）

- **用户已确认：渲染在 250 服务器本地跑。**
- 250 安装：`pip3 install manim`（community 版），依赖 cairo/pango——安装后 `manim --version` 验证并渲染一个 hello scene；失败则 `manim.enabled=false` 优雅降级（需确认 publisher 对 scene.py 渲染失败不阻塞发布，必要时补 try/catch 跳过）。
- 引擎侧已有 `manimEnabled` 预处理管线（`publisher.ts` 189 行），agent 写文章时按 `manimHint` 产出 scene.py 即可。
- 计划项 `manimHint` 仅对适合板块写入（二次函数图象/旋转/圆/抛物线类约 90 个板块）。

## 7. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 计划写错需批量撤销 | 写前备份 console.db（`console-backup.sh` 已有）；删除脚本按 period_key DELETE W42 新3天 与 W43~W72 |
| W42 覆盖误伤已发布内容 | 仅计划表条目被覆盖；articles/drafts/已发布状态不受影响；写前备份 console.db |
| 邮件带密码泄露 | 凭据文件 600 权限；邮件仅发这两个指定邮箱；git 不含明文 |
| manim 安装污染 250 | 失败即 `manim.enabled=false`，无残留影响 |
| ffmpeg drawtext 中文字体缺失 | 复用 `detectCjkFont`；无字体时降级 convert/模板 |
| 250 与开发机代码漂移 | 按 ACCEPTANCE-250 §2 外科式同步改动文件（cover.ts / mailer.ts / publisher.ts / config 相关） |

## 8. 实施顺序（见 implement.md）

1. 计划生成器 + 本地校验（211×2）
2. ffmpeg 封面改造 + 本地单测
3. 250：manim 安装（或降级开关）、config 邮箱、凭据文件
4. 计划写入 250（含 W42 合并）+ 校验
5. 端到端：首日 10-16 真发验证（AC6）
