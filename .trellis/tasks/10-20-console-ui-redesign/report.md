# C3 · 控制台前端重做 — 收尾报告（Step 7）

日期：2026-10-20 ｜ 分支 `main` ｜ 任务 `10-20-console-ui-redesign`

## 1. 交付物

| 产物 | 路径 | 说明 |
|---|---|---|
| 设计系统 | `src/console/ui/ds.css`（≈1500 行）/ `ds.js` | `--ds-*` 令牌（暗+亮）、shell、30+ 组件、`DS.mount/setTheme/toast/confirm/prompt/icon` |
| 组件样板页 | `src/console/ui/_ds.html` / `_ds.js` | `WFC_DS_PREVIEW=1` 才可达，生产 404（实测 on=200 / off=404） |
| 七页迁移 | `login` `index` `account` `settings` `admin` `workbench` `chat`（`.html` + `.js`） | 只换类名/结构，**页面 id 全保留** |
| 旧 CSS 删除 | `app.css` `chat.css` `workbench.css` | Step 7 删除；G4 `--strict` 证明 0 残留 |
| 闸门 | `tools/ui-gates.sh`（G1–G5） | G4 改为 token 感知：`ds-btn--ghost` 不再被误判为 `ghost`；`--strict` 全绿 |
| 视觉基线 | `tools/ui-baselines/*.png` | 7 页 × dark/light + `_ds` × 2 = **16 张终版基线**（无后缀）；过程基线保留 `-before/-step1/-step3/-step4/-step5` |
| 浏览器验收 | `tools/ui-accept.py` | V1–V13（复跑 10-15）+ V14（四档宽度无横向溢出）+ V15（主题往返持久化） |
| 隔离开发实例 | `tools/ui-dev-console.sh` | `/tmp/wfc-dev`，端口 8799，2 个假账号，不碰真实 `data/` |

## 2. 闸门与验收原始输出

```
$ bash tools/ui-gates.sh --strict
G1 ✓ no style= in ui/*.html
G2 ✓ ds.css + ds.js present and ordered on all pages
G3 ✓ tokens referenced: 60/63 (95%)
G4 ✓ no legacy classes in ui/*.html or ui/*.js
G5 ✓ dependencies: none · tsc --noEmit · bun build src/cli.ts
GATES: 7 passed, 0 failed
```

```
$ python3 tools/ui-visual.py --page all --theme both
OK — no runtime problems, no visual differences        # 16 张基线，0 error / 0 CSP / 0 缺失 DOM id
```

```
$ python3 tools/ui-accept.py
V1  GET /app → / (login page)                     # 匿名跳登录
V2  stayed on /login, role=alert, '用户名或密码错误'
V3  /app as 'admin（管理员）'
V4  2 account row(s): ['second', 'gaoh']
V5  #create-card visible=True (admin)
V6  2 account option(s): ['second · 巧思初数', 'gaoh · 每天讲点理']
V7  7 editable cells in #plan-days
V8  #chat-list present, composer=True, chats=1
V9  7 tunnel stat(s) in #tunnel-stats
V10 2 table(s), largest tbody=2 row(s)
V11 id=1 alias='second' sections=[有效配置, 覆盖项 overrides, 邮箱配置, 凭据, 全局默认（只读）]
V12 #global-json present, tables=2
V13 0 console error(s), 0 CSP violation(s)
V14 horizontal overflow: none                     # 1440/1024/768/390 四档全 0
V15 toggle dark→light, stored='light', after reload=light
ACCEPT: 15/15 passed
```

## 3. 删旧 CSS 后暴露的真实缺陷（已修）

**删掉 `app.css` 后全站横向溢出 40px**：`app.css` 里的 `* { box-sizing: border-box }` 是全局兜底，
`main.ds-content` 的 `width:100%` + `padding: 24px 20px` 因此在 `border-box` 下才不溢出。
删除后 `documentElement.scrollWidth = 1320 > clientWidth = 1280`（实测数字）。
修复：`ds.css §2` 增加 `body.ds-mounted *, ::before, ::after { box-sizing: border-box }`（作用域化，不影响未挂载页面），
修复后 `scrollWidth == clientWidth == 1280`。

> 这也是保留"运行时搬移、页面 CSS 逐步迁移"顺序的价值：全局兜底类的归属必须显式化，不能依赖被删文件。

## 4. 与设计稿的偏差（已记录理由）

| 设计稿 | 实际 | 理由 |
|---|---|---|
| 工作台三栏（计划/任务/版本） | 纵向 6 区块 + 详情内 `.ds-split` 两栏 | 计划编辑表 8 列可编辑，三栏会把每格压到 <80px，不可用（Step 5 记录） |
| 版本链用 `.ds-timeline` | `.ds-chips` + `.ds-chip.is-active` | 版本选择器语义更贴切；`.ds-timeline` 保留并在 `_ds` 页演示 |
| 对比两列并排 | `.ds-diff-box` 单列，`.ds-diff__add/__del/__ctx` 整行着色 | 1280 下并排每侧 <500px，长行折断难读；单列更接近 cdk/github 移动端形态 |

视觉基线差异（终版 vs 各 Step 基线）：`index` 9.1%/16.7%、`account` 10.2%/17.5%、`settings` 10.9%/17.3%、
`workbench` 20.4%/31.7%（dark/light），来源是删 `app.css` 后 `ds` 侧间距令牌（card 20px vs 旧 18px）与
`--ds-fs-*` 生效，属**设计意图内的观感变化**，不是回归；`admin` 0.13%、`chat` 0.87% 说明未受影响页几乎不变。

## 5. 未在本次闭环的项

- **7.6 250 真机逐页**：需要 `deploy.sh` 部署后用真实数据跑（含真实 SSE 进度数字、真实隧道状态、390px 手测）。
- C1 **AC3**（真实扫码）/ **AC6b**（到期前 24h 预警邮件）、C2 **AC5**（封面人工目视）仍待用户在场。
