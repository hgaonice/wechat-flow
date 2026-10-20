# Directory Structure

> 单仓、扁平、零依赖。所有引擎代码在 `src/`，一层目录，没有子包。

---

## 布局

```
wechat-flow/
├── config.json              # 运行时配置（只在 250；不进 git；deploy 排除）
├── config.example.json      # 配置模板（含多账号示例）
├── src/                     # 引擎（每个文件一个职责，见 src/README.md）
│   ├── cli.ts               # 命令入口：解析 → resolveTargets → 调库
│   ├── config.ts            # 配置加载 + 多账号解析 + 按账号隔离路径
│   ├── planner.ts           # 周编排（调用 pi）
│   ├── publisher.ts         # 每日：生成→后处理→发布→校验→通知
│   ├── media.ts             # 确定性后处理编排（公式 SVG / manim GIF）
│   ├── math.ts              # LaTeX $…$ → 内联 <svg>
│   ├── cover.ts             # ImageMagick 模板封面
│   ├── wechat.ts            # 调用 baoyu skill + 草稿箱查询 + verifyDraftBody
│   ├── browser.ts           # 浏览器归属（external/inline）+ Xvfb/CDP 就绪
│   ├── browser-agent.ts     # unit 入口：execve 换成 Chrome（Chrome 参数的唯一使用者）
│   ├── session.ts           # 登录态自愈（二维码邮件 + 轮询扫码）
│   ├── session-probe.ts     # 会话三态判定（valid/invalid/unknown）与抗抖动状态机
│   ├── session-state.ts     # cookie 证据（Chrome Cookies SQLite 只读）与证据文案
│   ├── session-snapshot.ts  # 登录态快照/恢复（unit 名可注入）
│   ├── session-warn.ts      # 会话告警（限频）
│   ├── pi.ts                # pi CLI 集成（JSON 事件流 + 重试/降级）
│   ├── state.ts             # published.json 幂等状态（原子写）
│   ├── notify.ts            # 通知分发
│   ├── mailer.ts            # 调用 email-sender skill
│   ├── date.ts              # 时区/ISO 周/星期几
│   ├── prompts.ts           # 模板变量渲染
│   └── log.ts               # 按账号日志
├── bin/                     # 独立脚本（非 bun）：manim-gif.sh / tex2svg.py / send-image.py
├── content/                 # 选题大纲（真源；可被单账号覆盖）
├── prompts/                 # 提示词 plan/article/editor（真源；可被单账号覆盖）
├── deploy/                  # systemd unit（含 wechat-xvfb / wechat-browser@）+ deploy.sh + install.sh + session-check.sh
├── tools/                   # 仓库内开发工具（repomap.sh / draft-probe.ts）
└── data/<alias>/            # 每账号运行时数据：plans articles imgs state logs sessions
```

---

## 依赖方向（只允许自上而下）

```
cli.ts
 ├─ config.ts            （配置是所有模块的地基）
 ├─ planner.ts ──────────► pi.ts / prompts.ts / date.ts / log.ts
 ├─ publisher.ts ────────► planner.ts / media.ts / cover.ts / wechat.ts
 │                         / session.ts / browser.ts / state.ts / notify.ts
 └─ doctor/login/drafts ─► browser.ts / session.ts / wechat.ts / mailer.ts
```

- `config.ts` **不反向依赖**任何业务模块。
- `date.ts` / `log.ts` / `state.ts` / `prompts.ts` 是叶子模块，谁都可依赖。
- 不要在模块之间制造环形依赖；共享类型放在使用方或被依赖方导出，不新建 `types.ts` 大杂烩。

---

## 按账号隔离（多公众号的核心不变量）

隔离靠**两个**独立维度，缺一不可：

1. **数据目录**：`data/<alias>/{plans,articles,imgs,state,logs,sessions}`（由 `config.ts` 的路径函数给出）。
2. **Chrome 调试端口 `cdpPort`**：**每个账号必须唯一**。

> 为什么端口关键：`baoyu-post-to-wechat` skill 是按 `--cdp-port` 附着到**已经在跑的那个 Chrome** 的。
> 如果两个账号共用端口，第二个账号会把稿子发进第一个账号的**登录态**里（串号，且没有任何报错）。

规则：

- 新增账号：新 `cdpPort`（9222/9223/…）+ 新 `dataDir` + `enabled: false`（登录成功后再开）。
- 任何读写运行时文件都不允许硬编码 `./data/...`，必须走 `config.ts` 暴露的路径（`ensureDirs` 会建目录）。
- 别名校验：`-a <错别名>` 必须**报错并列出可用别名**，不得静默回退默认号。

---

## 外部依赖（通过子进程，版本解耦）

| 能力 | 调用方式 | 位置 |
|---|---|---|
| 生成内容 | `pi --print --mode json` | `src/pi.ts` |
| 发到草稿箱 | `bun .../wechat-article.ts …` | `src/wechat.ts` |
| 发邮件 | `python3 .../send-mail.py` | `src/mailer.ts` |
| 二维码附件 | `python3 bin/send-image.py` | `src/session.ts` |
| 公式 SVG | `python3 bin/tex2svg.py` | `src/math.ts` |
| 动图 | `bash bin/manim-gif.sh` | `src/media.ts` |
| 封面 | `convert`（ImageMagick） | `src/cover.ts` |
