# Design（C1）：登录态长期保存与滚动更新

> 依据：`prd.md` 的 E1–E7 证据。核心判断：**问题不是"会话存不住"，而是"会话有效性判定不可靠" + "浏览器进程寄生在 SSH 会话里"**。
> 因此设计分两条主线：**A 判定可靠性**（立刻降低打扰）、**B 生命周期解耦**（结构性消除隐患）。

## 1. 现状架构（as-is）

```
systemd: wechat-console.service  (KillMode=control-group)   ← deploy 重启的就是它
   └─ bun src/console/main.ts ──(spawn detached)──► chrome --user-data-dir=.../wechat-<alias>
                                                      └─ renderer/zygote ... (落进 session-1955/2022.scope)
systemd: wechat-keepalive.timer (12h) ──► bun src/cli.ts keepalive --all ──► session.ts#ensureLoggedIn
systemd: （无）                              ← Xvfb :99 也是裸进程
src/session.ts#ensureLoggedIn: DOM 单证据 → 不通过就发二维码 + 900s 等待 + 失败邮件
```

问题点：
1. `ensureLoggedIn` 的判定是**二值**（loggedIn / not），且唯一证据是 DOM；`page_timeout` 壳页、旧渲染、reload 时序都会误判 → 直接触发扫码与失败邮件（E3/E6）。
2. Chrome 与 Xvfb **无人托管**：console 重启不杀它（E1/E2 已证），但 SSH 会话结束/被清理会连带杀 renderer（E4）；同时没有"每 alias 唯一实例"的硬约束，`ensureChrome()` 删 `SingletonLock` 后可能起第二实例。
3. 会话状态**不可见**：没有 cookie 到期时间、没有"上次保活"、没有判定来源。

## 2. 目标架构（to-be）

```
systemd:
  wechat-xvfb.service            Xvfb :99 (RemainAfterExit=yes)
  wechat-browser@second.service  ExecStart=chrome ... --remote-debugging-port=9222   KillMode=mixed, Restart=always
  wechat-browser@gaoh.service    ExecStart=chrome ... --remote-debugging-port=9223   KillMode=mixed, Restart=always
  wechat-console.service         ↳ 只做 CDP 客户端；不再 spawn Chrome（external 模式）
  wechat-keepalive.timer         5h ──► keepalive --all [--snapshot]

bun:
  src/session-state.ts     本地证据：Cookies DB 只读解析（slave_sid 到期）
  src/session-probe.ts     三态判定：valid | invalid | unknown（三层证据 + 失败计数）
  src/session-snapshot.ts  cookie 快照 / 校验 / 回滚
  src/browser.ts           新增 backend 抽象：external(systemctl) | inline(现状，回滚用)
```

## 3. 关键契约

### C-1 会话判定（`SessionVerdict`）

```ts
type Verdict = "valid" | "invalid" | "unknown";
interface SessionFacts {
  cookie: { ok: boolean; slaveSidExpiresAt?: number; dataTicketExpiresAt?: number; reason?: string };
  http:   { ok: boolean; status?: number; redirectedToLogin?: boolean; reason?: string };
  dom:    { ok: boolean; loggedIn?: boolean; pageTimeoutShell?: boolean; url?: string };
}
interface SessionProbe { verdict: Verdict; facts: SessionFacts; detail: string }
```

**判定规则（必须实现为纯函数 `decideVerdict(facts)` 以便单测）**

| cookie | http | dom | verdict | 说明 |
|---|---|---|---|---|
| 已过期 / 不存在 | — | — | `invalid` | 强证据，本地即可判定，无需请求 |
| 未过期 | `redirectedToLogin` | — | `invalid` | 强证据（服务端明说） |
| 未过期 | ok | loggedIn | `valid` | |
| 未过期 | ok/未知 | `pageTimeoutShell` 或 DOM 读不到 | `unknown` | **绝不判 invalid** |
| 读取失败(BUSY/无文件) | 未知 | 读不到 | `unknown` | |

**抗抖动状态机**（持久化到 `data/<alias>/state/session-probe.json`）
- `unknown` → 只记日志、不告警；计入连续失败
- `invalid` 或连续失败 ≥ `WFC_SESSION_FAIL_THRESHOLD`（默认 3，两次间隔 ≥60s）→ 进入扫码流程
- 扫码流程与"发布失败告警"分离：**扫码超时**的邮件文案必须写明「探测判定 + 证据摘要」，且与真实失效区分

### C-2 浏览器归属（`browser.ts` backend）

```ts
type BrowserMode = "external" | "inline";  // env WFC_BROWSER_MODE，默认 external（250）
ensureBrowser(cfg, alias):
  external: cdpVersion(port) ? ok : (systemctl start wechat-browser@<alias>; 等 CDP ≤30s; 失败抛错，不 spawn)
  inline  : 现状（spawn detached，回滚用）
```
- 硬约束：**每 alias 唯一实例**。`external` 用 unit 名天然互斥；`inline` 保留现有逻辑但先检查 `systemctl is-active wechat-browser@<alias>`，active 则拒绝 spawn。
- Chrome 启动参数**逐字沿用** `browser.ts:128–150`（含 `--no-sandbox`/window-size 等），避免 UA/指纹变化触发微信风控。
- unit 用 `KillMode=mixed` + `TimeoutStopSec=20`：`systemctl stop` 先 SIGTERM 主进程（Chrome 会 flush cookie DB），超时才 SIGKILL。

### C-3 Cookie 快照（`session-snapshot.ts`）

```
data/<alias>/session-snapshots/<ISO8601>/Cookies        # 原子 cp（tmp → rename）
data/<alias>/session-snapshots/<ISO8601>/Local\ State   # cookie 解密密钥所在，必须同快照
data/<alias>/session-snapshots/<ISO8601>/manifest.json  # sha256 + slaveSidExpiresAt + createdAt
```
- 触发点：keepalive 成功 + 发布成功（幂等：同分钟只存一份）
- 保留 N=10 份（按时间）
- `restore`：**先停 browser unit → 校验 sha256 + `PRAGMA integrity_check` → 替换 → 启 unit → 探针复验**；任一步失败则回滚到 restore 前状态并返回非零
- 安全：快照含登录票据 → 目录 `0700`，**不进 git、不进 deploy、不进备份包**（`.gitignore` + deploy EXCLUDES 校验）

### C-4 保活与预警
- `wechat-keepalive.timer`：`OnUnitActiveSec=5h`（可配 `WFC_KEEPALIVE_HOURS`），`AccuracySec=5m`
- 到期前 24h（`slaveSidExpiresAt - now < 24h`）→ 建议性预警邮件，**每 24h 最多 1 封**
- `keepalive --wait <sec>` 支持失败时阻塞等待扫码（人工场景）

### C-5 可观测
- `doctor --all` 新增一行：`mp-session second: valid · slave_sid expires in 62.4h · last keepalive 2.1h ago · evidence=cookie+http+dom`
- 控制台账号视图显示同样的剩余时长（只读展示，不做写操作）
- 所有判定结果写 `log.info("[session] verdict=… evidence=…")`，便于事后归因（当前只有 `url:`）

## 4. 选型对比（Q2）

| 方案 | 改动面 | 重启 console 影响 | SSH 断连影响 | 风险 |
|---|---|---|---|---|
| **A 独立 unit（推荐）** | 新增 3 个 unit + `browser.ts` backend + `deploy.sh` 后置检查 | 无 | 无 | 250 需手工 enable 一次；多实例需靠 unit 名互斥 |
| B `systemd-run --unit` 从 console 拉起 | 仅 `browser.ts` | 无 | 无 | 由 console 决定何时起，语义仍耦合；`--collect` 失败排查更难 |
| C 现状 + 只做 C-1 判定加固 | 最小 | 无 | **有（renderer 随会话清理死）** | E4 隐患不消除 |

采用 **A**，保留 `WFC_BROWSER_MODE=inline` 作为一键回滚。

## 5. 兼容性与迁移

- 现网 Chrome 已经在跑（PID 存活 7.7 天）：迁移时**不重启 Chrome**——写入 unit 后先 `systemctl start wechat-browser@<alias>`（会把已在跑的进程识别为"已在 CDP 端口监听"从而 no-op/失败），因此顺序为：
  1. 先加 unit（不启用）
  2. 在低风险窗口（当天发布完成后）`systemctl stop` 旧裸 Chrome（SIGTERM，优雅落盘）→ `systemctl enable --now wechat-browser@<alias>`
  3. 复验 `doctor` 会话 valid（**不需要扫码**，因为 profile 未变）
- 回滚：`WFC_BROWSER_MODE=inline` + `systemctl disable --now wechat-browser@*`（恢复 console spawn 行为）
- 数据兼容：不新增 DB 列，不新增运行时依赖；快照目录在 `data/`（已被 deploy 排除）

## 6. 失败模式与处置

| 失败 | 表现 | 处置 |
|---|---|---|
| `Cookies` 被 Chrome 锁住读不到 | `cookie.ok=false` | 判 `unknown`，回落到 http/dom；不得判 invalid |
| `systemctl start` 无权限 | 抛错 | 明确报错并提示 `inline` 回滚，不静默 spawn |
| 快照 restore 后仍 invalid | 说明 MP 侧真失效 | 恢复原状态 + 触发扫码流程 + 邮件说明"快照回滚无效=服务端失效" |
| 两 Chrome 同 profile | 第二实例会转发/失败 | unit 互斥 + `inline` 前置 `is-active` 检查 |
| Xvfb 重启 | 所有 Chrome 掉 | `wechat-browser@*.service` 加 `Requires=wechat-xvfb.service` + `Restart=always` 自愈 |
