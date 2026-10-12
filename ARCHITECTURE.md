# ARCHITECTURE.md · wechat-flow 宏观架构

> **读者**：接手本项目的 AI / 人。
> **范围**：只想在 1 分钟内建立“系统长什么样、边界在哪、什么不能动”的心智模型。
> **不包含**：安装步骤（看 `README.md`）、日常操作（看 `操作手册.md`）、逐模块 API（看 `src/README.md` / `TREE.md`）。
> **进度与下一步**：看 [`AGENT.md`](./AGENT.md)。

---

## 一句话

用 **pi coding agent** 按周计划写公众号文章，经**确定性后处理**（封面 / 公式 / 动图）后，
用 **Chrome CDP** 把正文写进微信公众号**草稿箱**，并**回查草稿箱**确认真的写进去了。

---

## 技术栈

| 层 | 选型 |
|---|---|
| 引擎 | TypeScript（无编译）+ **bun ≥ 1.3** |
| 内容生成 | `pi` CLI（`--print --mode json` 事件流） |
| 发布 | `baoyu-post-to-wechat` skill（browser/CDP 方式，绕过 IP 白名单） |
| 调度 | **systemd timer**（唯一触发器；无常驻进程） |
| 浏览器 | 无头 `Xvfb :99` + `google-chrome --remote-debugging-port` |
| 通知 | `email-sender` skill（python3 + SMTP） |
| 后处理 | ImageMagick `convert` / `ffmpeg` / python `tex2svg` |

---

## 运行拓扑

```
                    ┌──────── systemd timers（唯一自动入口）────────┐
   Sun 20:00        │                                              │  每天 07:30
  wechat-plan.timer ┘                                      wechat-publish.timer
        │  bun src/cli.ts plan --all                                │  bun src/cli.ts publish --all
        ▼                                                           ▼
  ┌───────────────┐                                    ┌──────────────────────────┐
  │ pi agent      │  产出 plans/<周>.json              │ pi agent 写当天文章 md     │
  │ 编排 7 天选题  │  （每周每人一份，落 data/<alias>/）  │ → data/<alias>/articles/  │
  └───────────────┘                                    └───────────┬──────────────┘
                                                                   │
                                          ┌────────────────────────▼─────────────────────┐
                                          │ 确定性后处理（src/media.ts，非 AI）            │
                                          │  · cover.ts   ImageMagick 模板封面             │
                                          │  · math.ts    $…$ → 内联 SVG                   │
                                          │  · manim      scene.py → scene.gif             │
                                          └────────────────────────┬─────────────────────┘
                                                                   │
                                          ┌────────────────────────▼─────────────────────┐
                                          │ wechat.ts  baoyu skill → CDP → 公众号编辑器    │
                                          │          浏览器方式，绕过 IP 白名单             │
                                          └────────────────────────┬─────────────────────┘
                                                                   │
                                          ┌────────────────────────▼─────────────────────┐
                                          │ 安全网 verifyDraftBody()：回后台读真实 DOM       │
                                          │ 正文非空（剔除占位符）才算成功                   │
                                          └────────────────────────┬─────────────────────┘
                                                                   │
                                                ✅ 邮件（含正文附件） / ❌ 失败邮件
```

---

## 模块分层（依赖方向自上而下，见 `src/README.md`）

| 层 | 模块 | 职责 |
|---|---|---|
| 入口 | `cli.ts` | 解析命令/flag、解析目标账号、分发 |
| 编排 | `planner.ts` / `publisher.ts` | 周编排 / 每日全流程 |
| 后处理 | `media.ts` / `math.ts` / `cover.ts` | 公式 SVG、manim GIF、封面（确定性） |
| 集成 | `pi.ts` | pi CLI 事件流 + 重试/降级 |
| 发布 | `wechat.ts` / `browser.ts` / `session.ts` | skill 调用、CDP 生命周期、登录自愈、正文校验、封面自动上传（O-B） |
| 基础设施 | `config.ts` / `state.ts` / `notify.ts` / `mailer.ts` / `date.ts` / `log.ts` / `prompts.ts` | 配置、幂等状态、通知、日期、日志、模板 |

---

## 五条不可动摇的架构约束

1. **AI 与确定性分离**：AI 只产出内容；封面/公式/动图/上传/校验/通知全是代码。
   → 违反会让系统不可复现、不可重跑、无法自动验收。详见 `.trellis/spec/engine/ai-determinism.md`。
2. **唯一真相源 = 后台草稿箱的真实 DOM**：不信 skill 的 stdout，不信中间态。
   → `verifyDraftBody()` 是发布成功的唯一依据。详见 `.trellis/spec/engine/verification.md`。
3. **引擎与题材解耦**：引擎不认识“数学”，只认 `contentDir` / `promptsDir` / `model`。
   → 换学科 = 换配置，不改代码。
4. **多账号强隔离**：`data/<alias>/` 数据目录 + **唯一 `cdpPort`**。
   → 共用端口会串号发错号，且不报错。详见 `.trellis/spec/engine/directory-structure.md`。
5. **失败必须显形**：降级可接受，伪装成功不可接受；失败写 `ok:false` + 告警邮件。
   → 详见 `.trellis/spec/engine/error-handling.md`。

---

## 数据与状态

| 数据 | 位置 | 说明 |
|---|---|---|
| 运行配置 | `config.json`（仅 250，不进 git） | 多账号、模型、发布方式、通知、代理 |
| 选题大纲 / 提示词 | `content/` `prompts/`（**本地仓库是真源**） | 可被单账号用 `contentDir`/`promptsDir` 覆盖 |
| 周计划 | `data/<alias>/plans/<ISO周>.json` | 发布时才读 |
| 文章 | `data/<alias>/articles/<日期>-<slug>.md` | 原文；公式转换另存 `.math.md` |
| 图片/封面/动图 | `data/<alias>/imgs/<日期>/` | `cover.png` / `scene.gif` |
| 幂等状态 | `data/<alias>/state/published.json` | 发布成功/失败记录，`--force` 可覆盖 |
| 登录态 | Chrome profile（按账号独立） | 失效时二维码邮件自愈 |
| 日志 | `data/<alias>/logs/` | 按账号隔离 |

---

## 外部依赖与边界

| 依赖 | 位置 | 边界 |
|---|---|---|
| npm devDeps | `typescript` + `@types/node`（仅类型检查） | **runtime 零依赖**；devDeps 不进运行路径，`bunx tsc --noEmit` 用 |
| pi CLI | 目标机 `pi`（provider 配在 `~/.pi/agent/models.json`） | 通过子进程；版本解耦 |
| baoyu skill | `skillDir`（默认 `/root/.agents/skills/baoyu-post-to-wechat`） | 只调用其脚本，不打补丁（新版原生修复，`deploy/patch-baoyu-skill.sh` 自适应） |
| email-sender skill | `/root/.claude/skills/email-sender` | 只调用，凭据在其 `config.env` |
| 部署机 | `192.168.0.250` | 代码/内容真源在本地仓库，用 `deploy/deploy.sh` 部署 |

---

## 相关文档

- 安装与结构：[`README.md`](./README.md)
- 日常操作/维护/排障：[`操作手册.md`](./docs/操作手册.md)
- 模块微观上下文：[`src/README.md`](./src/README.md)
- 文件/符号索引：[`TREE.md`](./TREE.md)
- 引擎编码规范：[`.trellis/spec/engine/index.md`](./.trellis/spec/engine/index.md)
- 进度与续接：[`AGENT.md`](./AGENT.md)
