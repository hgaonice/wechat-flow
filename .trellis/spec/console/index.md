# Console Development Guidelines

> 控制面（control plane）：在既有 engine（`src/*.ts`，见 `../engine/index.md`）之上加一层**带鉴权的 Web 管理控制台**，
> 让非命令行使用者能自助管理多账号、编排内容计划、与 pi agent 会话并在环审批。
>
> **状态：C1 + C2 + C3 + C4 + C5 + C6 已落地；`api.md`/`security.md` 校准为 v6；`data-model.md` v5；`agent-session.md` v2；`ops-tunnel.md` v1；`ops-deploy.md` v1。**
> 于 M0 编写（源：父任务 `design.md`）。
> 契约与代码冲突时：**先改本目录，再改代码**；DDL / API / 安全语义变更必须同步本目录。

---

## 一、硬约束（违反视为失败）

| # | 约束 | 来源 |
|---|---|---|
| H1 | **不改发布铁律**：AI 只做内容，其余确定性；`verifyDraftBody()` 是唯一真相源 | `../engine/ai-determinism.md`、`../engine/verification.md` |
| H2 | **engine 不得反向依赖 console**；依赖方向 `console/* → ../*.ts` | `design.md` §2 |
| H3 | **运行时不新增 npm 依赖**（`package.json` 的 `dependencies` 保持为空）；只用 `Bun.serve` / `bun:sqlite` / WebCrypto | AC-10 |
| H4 | **多账号隔离**：`data/<alias>/` 且 `cdpPort` 唯一；冲突**报错**，不静默回退 | `../engine/directory-structure.md` |
| H5 | **失败显形**：`ok:false` + 原因 + 告警；降级可接受，伪装成功不可接受 | `../engine/error-handling.md` |
| H6 | **迁移期兼容**：任何里程碑结束时 `bun src/cli.ts publish --dry-run` 必须仍可用 | `design.md` §6 |
| H7 | **凭据永不回显明文**；无 master key 必须 fail-fast（拒绝启动/拒绝解密） | AC-9、`security.md` |
| H8 | **只暴露控制台端口**；Chrome CDP 端口绝不入隧道 | `design.md` §7 |

---

## 二、技术栈

| 维度 | 约定 |
|---|---|
| 运行时 | `bun >= 1.3`（实测 1.4.2），直接执行 `.ts`，不编译不打包 |
| 服务端 | `Bun.serve`（HTTP + SSE/WS 升级） |
| 数据 | `bun:sqlite`，WAL + `foreign_keys=ON`，`console/console.db`（不入 git） |
| 加密 | **`node:crypto`** AES-256-GCM（`createCipheriv`，**非** WebCrypto）；口令 `Bun.password`（argon2id） |
| 前端 | 静态页面（`src/console/ui/`）+ 原生 JS，**无构建步骤**（R5.1） |
| 类型检查 | `node_modules/.bin/tsc --noEmit`（本地）或 `bunx tsc --noEmit`；另 `bun build --target=bun src/console/main.ts` |

---

## 三、代码结构（新增层）

```text
src/console/
  main.ts  server.ts
  http/{router,respond,sse}.ts
  auth/{users,sessions,rbac}.ts
  crypto/secrets.ts
  db/{schema,migrate,import-config,render-config}.ts + db/dao/*.ts
  config/resolve.ts
  jobs/{queue,worker,scheduler}.ts
  content/generate.ts
  agent/{frames,rpc,events,manager}.ts + agent/extensions/console-decision.ts
  tunnel/cloudflared.ts
  notify/tunnel-mail.ts
  ui/{ds.css,ds.js}            # 设计系统 + shell（唯一全局 CSS/JS 底座）
  ui/{index,login,account,settings,admin,workbench,chat}.html + 同名 .js
  ui/_ds.html,_ds.js           # 组件样板页，WFC_DS_PREVIEW=1 才可访问
```

详见 `design.md` §1（架构图）/ §2（目录）。**依赖方向单向**，见 H2。

---

## 四、Guidelines Index

| Guide | 说明 | 状态 |
|-------|------|------|
| [API Contract](./api.md) | HTTP/SSE 约定、错误包、端点清单、鉴权头 | v6（C1–C6） |
| [Data Model](./data-model.md) | SQLite DDL、不变量、迁移、`config.json` 派生关系（AC-3） | v5（C1–C5） |
| [Security](./security.md) | 鉴权/RBAC/CSRF/限流/凭据加密/暴露面/审计（K1） | v6（C1–C6） |
| [Agent Session](./agent-session.md) | pi `--mode rpc` 帧协议、决策生命周期、最小权限 | v2（C4） |
| [Ops & Tunnel](./ops-tunnel.md) | CF Quick Tunnel 监督、地址变更邮件下发、凭据加密、管理员总览 | v1（C5） |
| [Deploy & Hardening](./ops-deploy.md) | 部署模式（Mode A/B）、systemd、限流、备份/恢复、失败退避、`/health` | v1（C6） |
| 设计系统（本文 §八） | `ds.css`/`ds.js` 令牌、组件、shell、主题、闸门与基线 | v1（C3） |

---

## 五、Pre-Development Checklist（写 console 代码前逐条确认）

- [ ] 已读本文件 + 涉及的 1–2 篇 guide（**不要**整读 `README.md` / `操作手册.md`）
- [ ] 已读 `../engine/index.md` 与该改动相关的 engine guide
- [ ] 确认改动**不触碰**发布链路铁律（H1）；若必须触碰，先写 `prd.md` 并等用户确认
- [ ] 确认没有新增 runtime npm 依赖（H3）
- [ ] 若涉及账号/端口：确认隔离不变量（H4）
- [ ] 若涉及凭据：确认加密落库 + 不回显（H7）
- [ ] 若涉及 DDL / API / 安全语义：已同步本目录对应 guide
- [ ] 失败路径想清楚：如何被检出、如何显形（H5）

## 五之二、前端设计系统（C3，2026-10-20）

**底座**：`src/console/ui/ds.css`（约 1500 行）+ `ds.js`，零依赖、零构建。
旧 `app.css` / `chat.css` / `workbench.css` **已删除**（C3 Step 7），别再引用。

| 层 | 内容 |
|---|---|
| 令牌 | `--ds-*`（`--ds-n-0..9` 中性阶、`--ds-bg/panel/border/text/muted`、`--ds-accent`(**文字**) / `--ds-accent-solid`(**按钮底**)、`--ds-ok/warn/danger/info`、间距 `--ds-s-*`、圆角 `--ds-r-*`、字号 `--ds-fs-*`、阴影 `--ds-sh-*`） |
| 主题 | 默认暗色；`html[data-theme="light"]` 只重映射 `--ds-*`；`localStorage['wfc.theme']`，无值时跟随 `prefers-color-scheme` |
| Shell | `.ds-shell`（sidebar + main 两列）、`.ds-sidebar`/`.ds-nav__item`、`header.ds-topbar`、`main.ds-content`；≥1280 侧栏 / 768–1280 图标轨 / <768 抽屉（`.ds-menu-btn` + `.ds-scrim` + `body.ds-nav-open`） |
| 组件 | `.ds-card`、`.ds-stat`、`.ds-table(--compact/--form)`、`.ds-badge(--ok/--warn/--danger/--accent)`、`.ds-btn(--primary/--ghost/--danger/--quiet/--danger-quiet/--sm/--icon)`、`.ds-field/__label`、`.ds-input/--sm`、`.ds-select`、`.ds-textarea`、`.ds-progress/__bar`、`.ds-tabs`、`.ds-toast`、`.ds-dialog`、`.ds-empty`、`.ds-tip(--danger)`、`.ds-chips/.ds-chip`、`.ds-diff/.ds-diff-box`、`.ds-log`、`.ds-md`、`.ds-chat*`/`.ds-bubble*`/`.ds-tools`/`.ds-decision` |
| JS | `DS.mount()`（幂等，把 `<header>` 导航搬进 sidebar，**id 全保留**）、`DS.setTheme/theme`、`DS.icon(name)`、`DS.toast(msg,kind)`、`DS.confirm(opts)`、`DS.prompt(opts)` |

**硬规则**

1. **0 内联 `style=`**（CSP `style-src 'self'`）。需要动态尺寸时只写 `el.style.width = …`（CSSOM 允许）或用类切换。
2. **禁止 `window.confirm` / `window.prompt` / `window.alert`**：可能被 CSP 或父页面静默抑制 → 用 `DS.confirm` / `DS.prompt`（原生 `<dialog>`，`DS.prompt` 自带 Enter 提交 + focus/select）。
3. **页面迁移只换类名与结构，不改 `id`**：所有页面 JS 按 id 绑定；`ds.js` 把 `#who`/`#logout`/`#nav-admin` 等搬进新 shell，id 必须原封不动。
4. **新 CSS 只写 `.ds-*` 或 `body.ds-mounted` 作用域**，否则会波及未迁移/异常页面。
5. **按钮填充色与链接文字色必须是两个令牌**（`--ds-accent-solid` vs `--ds-accent`），否则对比度必有一方不达 4.5:1。
6. 页面内联删除按钮用 `.ds-btn--danger-quiet`（透明底红字）；实心 `.ds-btn--danger` 只留给对话框主按钮。
7. 表格数字列加 `.ds-num`（右对齐 + nowrap），等宽内容加 `.ds-mono`；时间列先截断成 `YYYY-MM-DD HH:MM:SS`。
8. 空态用 `.ds-empty`（`hidden` 切换），不要留空白区；失败用 `.ds-tip--danger` + 非空文本。

**闸门与基线（写前端必跑）**

```bash
bash tools/ui-dev-console.sh start          # 隔离实例 /tmp/wfc-dev，端口 8799
bash tools/ui-gates.sh --strict             # G1..G5（G1 内联 style / G2 ds.css+ds.js 顺序 / G3 令牌引用率 / G4 旧类残留 / G5 零依赖+tsc+build）
python3 tools/ui-visual.py --page all --theme both           # 与 tools/ui-baselines/*.png 比对，>0.5% 退出 2
python3 tools/ui-visual.py --page all --theme both --update  # 有意改观感时刷新基线（一页一 commit）
python3 tools/ui-accept.py                  # V1–V15 浏览器验收（功能等价 + 390px 溢出 + 主题切换）
```

Playwright 走**系统 Python 版**（`/usr/local/bin/playwright` 1.64），不写进 `package.json`（H3）。
`_ds` 页只在 `WFC_DS_PREVIEW=1` 时可达（`src/console/http/static.ts` 的 `PREVIEW_ROUTES`），生产 404。

## 六、Quality Check（声明「做完」前必须实测）

- [ ] `bunx tsc --noEmit` 零错误；`bun build --target=bun src/console/main.ts` 通过
- [ ] `bun src/cli.ts doctor --all` 与 `bun src/cli.ts publish --dry-run` 仍可用（H6）
- [ ] 受影响 API 有真实 `curl` 输出（含 401/403 越权路径）
- [ ] `package.json` `dependencies` 仍为空（H3）
- [ ] 前端改动：`bash tools/ui-gates.sh --strict` 全绿 + `python3 tools/ui-visual.py --page all --theme both` 无差异 + `python3 tools/ui-accept.py` 全 PASS
- [ ] 关键结论写回 `AGENT.md` 变更日志；新约定写回本目录

> 打勾规则：完成 = 产物存在（路径）**或**命令真实输出。禁止「我记得做过了」。

---

## 七、反模式（禁止重犯）

| 反模式 | 为什么 | 见 |
|---|---|---|
| console 直接内联「选题/写文/润色」逻辑 | 违反 AI 只做内容（H1） | `../engine/ai-determinism.md` |
| engine 里 `import` console 的模块 | 反向依赖，破坏可独立运行 | H2 |
| 为图省事引入 express/sqlite3 等 npm 包 | 违反零依赖红线 | H3 |
| 新增账号复用已有 `cdpPort` | 会串号发错公众号 | H4 |
| API 读接口把 `secrets` 明文/密文返回前端 | 凭据泄露 | H7 |
| 无 `CONSOLE_MASTER_KEY` 时降级为明文存储 | 静默降级，违反 H5/H7 | `security.md` |
| 用 `readline` 解析 pi RPC 帧 | 会按行缓冲丢/并帧；必须只在 `\n` 切分 | `agent-session.md` |
| SSE 订阅晚于 `prompt`，或用 `agent_end` 当轮次结束 | 漏掉快速事件 / 提前判完；必须先订阅、认 `agent_settled` | `agent-session.md` §4 |
| 会话失联时把会话与 pending 决策分两个事务清 | 崩溃/中断会留下悬挂决策 | `agent-session.md` §5、`data-model.md` I23 |
| 预期关闭（TTL `sweepIdle` / 删除 / 退出）只改会话状态、不清 pending | 进程已死但决策卡仍 `pending`（I21），直到下次重启才回收 | `agent-session.md` §1/§5 |
| `ChatManager` 缺失时把 `/api/chats*` 降级为 200 空结果 | 伪装成功，调用方误以为无会话 | `api.md` §2.4（应 503 `chat_unavailable`） |
| 经隧道暴露 CDP 端口或监听 `0.0.0.0` | 远程接管 Chrome | H8、`security.md` |
| 用 `window.confirm/prompt` 做确认/输入 | CSP 与父页面可静默抑制，返回 `undefined` 而不报错，用户只看到按钮无反应 | §五之二规则 2 |
| 用内联 `style=` 调间距 | `style-src 'self'` 直接拦截，样式失效且无告警（10-15 真实缺陷） | §五之二规则 1 |
| 新写 CSS 用 `.card`/`.row`/`.ghost` 等旧类名 | 旧 CSS 已删，这些类不再有任何样式；G4 `--strict` 会失败 | §五之二、`tools/ui-gates.sh` |
| 隧道目标只校验回环主机、不校验端口 | 误配 `CONSOLE_TUNNEL_URL=…:9222` 会把 CDP 发到公网；必须同时校验 `port===CONSOLE_PORT` 且非 `accounts.cdp_port`（fail-fast） | `ops-tunnel.md` I27/T1、`security.md` §8 |
