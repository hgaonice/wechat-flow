# Research（C1）：真机只读诊断记录（2026-10-20）

> 全部为**只读**操作（`systemctl show` / `/proc` / `journalctl` / sqlite 只读），未修改 250 任何配置、未重启任何服务。
> 目标：验证「每次代码调整都要重新扫码」的真实根因。

## 1. 假设与验证结果

| 假设 | 验证方式 | 结果 |
|---|---|---|
| H1：`systemctl restart wechat-console` 会杀 Chrome（cgroup 连带） | `systemctl show wechat-console -p KillMode` + `/proc/<chrome-pid>/cgroup` | **否证**。`KillMode=control-group` 属实，但 Chrome 根进程不在 console 的 cgroup，而在 `user@0.service/app.slice/app-com.google.Chrome-<pid>.scope` |
| H2：重启 console 会导致退登 | 对比 10-20 00:55–01:06 连续 6 次重启与 11:11 keepalive 结果 | **否证**。重启后两账号 keepalive 均成功，无扫码 |
| H3：会话真的频繁过期 | 近 14 天 keepalive 全量日志 | **部分否证**。仅 1 次真失效（10-19 23:12 gaoh）；其余 13 次全绿 |
| H4：会话有效性**探测**会误判 | 10-20 07:02 vs 07:17 同账号对照 | **成立**（见 §2） |
| H5：浏览器进程寄生在 SSH 会话 scope（结构性隐患） | `/proc/<pid>/cgroup` | **成立**：renderer/zygote 在 `session-1955.scope` / `session-2022.scope`；Chrome 根在自动 scope。SSH 会话被清理时可能连带杀 renderer |

## 2. 决定性时间线（10-20 早间发布）

| 时间 | 事件 |
|---|---|
| 07:00:40 | 账号 A 的 publish job 启动 |
| 07:01:31 | `wechat session: session valid` → 07:01:33 `MP tab visibility: visible` → 发布成功 |
| 07:02:25 | gaoh：**`WeChat session expired (url: https://mp.weixin.qq.com/) — requesting a new login`** |
| 07:02:32/33 | 二维码邮件发往 2 个邮箱 |
| 07:06:19 / 07:12:36 | 二维码轮换，重发 2 次 |
| 07:17:33 | **`login timeout after 900s (QR not scanned)`** → 失败邮件「❌ 公众号登录失效，未能发布」 |
| 07:17:37 | gaoh 重试 job 24 启动（同 Chrome、同 profile、无人扫码） |
| **07:18:44** | **`wechat session: session valid`** |
| 07:19:16 / 07:19:22 | `draft verified in 草稿箱 ✓` / `body=3148 chars, svg=1, img=2` |
| 07:19:44 | `draft cover set ✓` → 推送成功、成功邮件发出 |
| 07:50:45 | 另一账号出现 expired（QR）→ 08:04:00 用户真实扫码 → `logged in after QR scan` |

**结论**：07:02 判定"失效"后，**同一账号在 15 分钟内（无人扫码）被判 valid 并成功发布**。⇒ 07:02 是**误判**，却造成了「二维码邮件 ×3 + 失败邮件 ×2 + 当天推迟发布」的完整打扰链。

## 3. 误判的机制线索（代码侧，待 Step 1–2 复现确认）

| 线索 | 代码位置 |
|---|---|
| 判定只有 DOM 一条证据，无 cookie 到期、无鉴权请求 | `src/session.ts:431-460`（`ensureLoggedIn`） |
| 只有 `url:` 进入日志，无证据摘要 → 事后无法归因 | `src/session.ts:459` |
| 重载等待依赖 `window.__wfcProbe` marker 时序，浏览器繁忙时可能读到旧 DOM | `src/session.ts:119-160`（`revalidatePage`） |
| 已知陷阱：MP 会用缓存的 `page_timeout`（「登录超时，请重新登录」）壳页掩盖有效 token | `src/session.ts:74` 注释 |
| 单次失败即进入扫码流程（无阈值/无抖动抑制），且 keepalive 只有 2 种结果（成功/失效） | `src/session.ts:445-470` |

## 4. 其它现场事实（供部署迁移参考）

- `wechat-console`：`KillMode=control-group`、`TimeoutStopUSec=30s`、`MainPID` 属于 cgroup `/system.slice/wechat-console.service`。
- Chrome 根进程：`second` PID 3019969（cgroup `app-com.google.Chrome-3019969.scope`，etimes ≈ 7.7d）、`gaoh` PID 3063474（同型，≈7.7d）→ **Chrome 比 console 命长**，说明现网确实是"浏览器独立于 console"在跑（只是无人托管）。
- Chrome 子进程（renderer/zygote）落在 `session-1955.scope` / `session-2022.scope`。
- keepalive：`enabled/active`，`LastTrigger=2026-10-20 11:11:39 CST`，间隔 12h。
- cookie 文件位于 `data` 之外：`/root/.local/share/baoyu-skills/wechat-<alias>/Default/Cookies`（+ `Cookies-journal`），不在仓库、不被 `deploy.sh --delete` 触碰。
- keepalive 失败时的日志样例：`❌ 会话已失效：QR captured (no wait requested)`（默认不等待扫码，`--wait` 才等）。

## 5. 待办（已由 §6 关闭）

- [x] 归档证据：命令与输出片段内嵌 §6.1–6.5（只读约束下不落 250 的 `/tmp`）
- [x] 用 cookie 到期时间作为独立证据判定归因 → §6.4 误判（确证）／§6.5 未确证失效
- [x] `page_timeout` 壳页机制确认：mock DOM 单测 `tools/session-selftest.ts`（6e/6i）断言「壳页 ⇒ unknown」

## 6. 归因定案（Step 0，2026-10-20 11:34 CST，全程只读）

> 约束：对 250 只做 `ssh` + `journalctl` + `sqlite3 -readonly` 读取；未重启任何服务、未写任何文件（因此 §6 的证据片段直接内嵌在此文件，不落 `/tmp`）。

### 6.1 证据采集命令（可复制）

```bash
# 只读读取两账号 cookie 的 slave_sid 到期时间（Chrome 时间：expires_utc/1e6 - 11644473600）
ssh root@192.168.0.250 'for a in second gaoh; do echo "=== $a ==="; \
  sqlite3 -readonly /root/.local/share/baoyu-skills/wechat-$a/Default/Cookies \
  "select name, host_key, expires_utc, datetime(expires_utc/1000000 - 11644473600, \"unixepoch\", \"+8 hours\") as expires_cst \
   from cookies where host_key like \"%weixin%\" and name in (\"slave_sid\",\"data_ticket\",\"bizuin\",\"wxuin\") order by name;"; done; date'

# 保活历史（全部 8 次运行 / 16 次账号探测）
ssh root@192.168.0.250 'journalctl -u wechat-keepalive --since "-14 days" --no-pager | grep -vE "Consumed|logind"'

# 10-20 早间发布窗口（含 07:18 对照）
ssh root@192.168.0.250 'journalctl -u wechat-console --since "2026-10-20 07:00" --until "2026-10-20 08:10" --no-pager | grep -vE "skip publish"'
```

### 6.2 当前 cookie 基线（10-20 11:34 CST 读，`-readonly`）

| host_key | name | expires_cst | 说明 |
|---|---|---|---|
| mp.weixin.qq.com | `slave_sid` | `2026-10-24 11:12:02`（second） / `2026-10-24 11:11:58`（gaoh） | ≈ 96h 滑动窗口，读取时剩 95.6h |
| mp.weixin.qq.com | `data_ticket` | 同上（与 `slave_sid` 同步） | 同一票据族，同时失效 |
| mp.weixin.qq.com | `bizuin` | 同上 | 同上 |
| mp.weixin.qq.com | `wxuin` | `2027-11-16` | 长期标识，不参与 4 天窗口 |

两条决定性事实：`slave_sid` 的 `expires_utc` 恰好等于「最近一次保活 + 96h」（11:11 保活 → 10-24 11:11/11:12），
且 `Cookies` 文件 mtime 为 `Oct 20 11:12`（= 11:11:39 那次 keepalive 写回）。

### 6.3 保活历史：16 次探测 = 15 ✅ + 1 ❌

```
Oct 19 11:11:40  ✅ 会话保活成功（票据已顺延）：草稿箱 10 条        # gaoh，24h 前
Oct 19 23:11:48  ✅ 会话保活成功（票据已顺延）：草稿箱 2 条         # second
Oct 19 23:12:10  [WARN] WeChat session expired (url: https://mp.weixin.qq.com/) — requesting a new login   # gaoh ❌
Oct 19 23:12:17  QR emailed ... 23:12:19 ❌ 会话已失效：QR captured (no wait requested)
Oct 20 11:11:51  ✅ 会话保活成功（票据已顺延）：草稿箱 12 条        # gaoh，无需扫码即恢复
```

### 6.4 判定 10-19 23:12（gaoh）：**误判（确证）**

三条独立证据互相印证，任一条单独即足以推翻「真失效」：

1. **算术**：`slave_sid` 的生命窗口是 96h，10-19 11:11:40 刚顺延成功（草稿箱 10 条 ⇒ 鉴权请求真的被服务端受理）。
   该会话的最早自然到期时刻是 **10-23 11:11**。23:12 距顺延仅 **12h**，不存在"到期"。
2. **同一会话事后仍可用**：10-20 07:18:44 控制台日志 `[INFO] wechat session: logged in after QR scan` 之前
   出现 `[INFO] wechat session: session valid`，随即 07:19:16–07:19:44 gaoh 草稿创建 + 正文校验 + 封面上传全部成功。
   从 23:12 到 07:19 **没有任何扫码**：`data/gaoh/state/wechat-login-qr.png` mtime 仍是 `Oct 19 23:12`
   （若期间重登，该文件会被覆盖成新码）。
3. **日志形态**：失败行只有 `url: https://mp.weixin.qq.com/`（掉回根域、无 `token=`），与已知的
   `page_timeout` 壳页症状完全一致；成功的 keepalive 从不打印 url。

结论：10-19 23:12 是一次 **DOM 壳页误判**，与 PRD R1 描述的"静默误判 → 半夜发码 → 第二天早上才发现"完全吻合。

### 6.5 判定 10-20 07:02 / 07:50（second）：**未确证的失效，同属高度可疑**

```
Oct 20 07:00:35  [scheduler] enqueue publish job#23 for second
Oct 20 07:02:25  [WARN] WeChat session expired (url: https://mp.weixin.qq.com/) — requesting a new login   # 07:02:25
Oct 20 07:02:32  QR emailed → 07:17:33 [ERROR] wechat login unavailable: login timeout after 900s (QR not scanned)
Oct 20 07:17:37  [job 24] start kind=publish account=gaoh
Oct 20 07:18:44  [INFO] wechat session: session valid          # ← 同一时刻 gaoh = valid
Oct 20 07:19:44  done: gaoh 草稿箱 ✓（无需扫码）
Oct 20 07:47:35  [job 25] start kind=publish account=second
Oct 20 07:50:45  [WARN] WeChat session expired (url: https://mp.weixin.qq.com/) — requesting a new login   # 第二次同样判失效
Oct 20 08:04:00  [INFO] wechat session: logged in after QR scan   # 用户真实扫码
Oct 20 08:05:16  [job 25] 已推送到草稿箱 ✓
```

- 「07:02 真失效」在算术上同样不成立：second 的 `slave_sid` 在 10-19 23:11:48 刚顺延，最早自然到期是 **10-23 23:11**。
- 两次探测（07:02:25 / 07:50:45，中间隔 48min、独立进程与独立 job）给出的唯一证据都是「url 掉回根域」，
  与 §6.4 的壳页误判同一代码路径、同一症状。
- **无法确证**的原因：旧探针从不发鉴权请求，07:02–08:04 之间也没有任何一次成功鉴权可作反证；
  08:04 的扫码只能证明"扫码后可用"，不能反推"扫码前不可用"。
- 因此严格表述为：**07:02/07:50 是"未确证的失效判定"，其中至少 07:02 属 96h 窗口内的可疑失效**；
  真正的直接证据（鉴权请求返回 `ret≠0`）在旧实现里根本不存在 —— 这正是 Step 2 要补的第三层证据。

### 6.6 对设计的回溯校验

| PRD/design 断言 | 现场是否成立 | 证据 |
|---|---|---|
| R1 静默误判（壳页/超时被当成退登） | ✅ 成立，且已发生 1 次确证误判 | §6.4 |
| R2 一次误判 → 半夜发码 + 15min 阻塞 | ✅ 成立（07:02 阻塞到 07:17:33 才失败） | §6.5 |
| 96h 滑动窗口、`slave_sid` 与 `data_ticket` 同生共死 | ✅ 成立 | §6.2 |
| 仅 DOM 一条证据，日志无证据摘要 → 事后无法归因 | ✅ 成立（本章全靠交叉时间线反推） | §6.4/6.5 |
| `unknown` 必须与 `invalid` 分离，且不得触发扫码 | ✅ 由上两条直接推导 | — |

**Step 0 结论**：10-19 23:12 gaoh = 误判（确证，占比 1/16 ≈ 6.3%）；10-20 早间 second = 未确证失效。
两者共同指向同一修复方向：**多源证据 + 三态判定 + 连续失败阈值**（Step 1/2），且必须把判定依据写进日志与邮件。
