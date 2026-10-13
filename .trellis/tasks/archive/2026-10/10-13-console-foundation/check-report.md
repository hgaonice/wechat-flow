# C1 · check-report.md · 独立验证（`10-13-console-foundation`）

> Agent: trellis-check（独立验证；未修改 `src/**`）
> 环境：repo root `/workspaces/other/weixin/wechat-flow`，Bun `1.4.2` (`/root/.bun/bin/bun`)，TypeScript `5.9.3`，网络不可达。
> 方法：所有 DB 写入指向 `/tmp/check-*/console.db`；为复现 CLI 迁移路径，临时创建了被 gitignore 的
> `config.json`，验证结束后已删除 `config.json` / `config.json.bak`（`git status` 已恢复）。

---

## 0. 总体结论

**PASS（带 4 个需修 Bug 与 6 项 spec 漂移）。**

C1 的 5 条验收（AC-1/2/3/4/10）均有**真实命令输出**支撑；`src/config.ts` 的 `resolveConfig` 抽取为纯增量、
engine 行为未回退，AC-3 达到「逐字段 + 字节一致」。但代码评审发现 2 个中等严重度真实缺陷
（`cdpPort` 字符串绕过唯一约束 → 违反 H4 隔离；账号详情把全局 `notify`/`botToken` 泄露给 owner）
与 1 个未处理异常（畸形 Cookie → 500）。另有 `.trellis/spec/console/*` 未按 DoD 校准到 v1，存在漂移。

---

## 1. 验证命令与原始输出

### 1.1 AC-10 类型/构建/零依赖

```
$ node_modules/.bin/tsc --noEmit
TSC_EXIT=0

$ bun build --target=bun src/console/main.ts > /tmp/check-ac4/build.out
BUILD_EXIT=0 ; 65109 bytes

$ node -e "const p=require('./package.json');console.log('dependencies=',JSON.stringify(p.dependencies))"
dependencies= undefined
OK_NO_RUNTIME_DEPS

$ ls node_modules/bun-types node_modules/@types/bun
No such file or directory, No such file or directory

$ grep -rhoE 'from "[^"]+"' src/console | sed 's/from //' | sort -u
"bun:sqlite"  "node:crypto"  "node:fs"  "node:os"  "node:path"  "node:url"  + 相对 .ts 模块
```

`src/console/bun.d.ts` 为手写 ambient 声明（仅覆盖项目用到的 `Bun.serve/password/sqlite`），无 `bun-types`/`@types/bun`。

### 1.2 AC-1 fail-fast（I1-1 / I1-3）

```
$ CONSOLE_DB=/tmp/check-ac3/db1/console.db bun src/console/main.ts      # 无 master key
✖ master key not found: set CONSOLE_MASTER_KEY (base64 of 32 bytes) or run `bun src/console/main.ts --init-key` to create /root/.wechat-console/master.key
EXIT=1

$ CONSOLE_MASTER_KEY=<32B b64> CONSOLE_DB=/tmp/check-ac3/db2/console.db bun src/console/main.ts   # 有 key、0 user
✖ 尚无任何用户：先运行 `bun src/console/main.ts --create-admin <name>`（拒绝默认口令启动）
EXIT=1
```

两条 fail-fast 均显式报错且退出码 1（无默认口令、无静默降级）。

### 1.3 AC-2 导入（I1-7）

构造的 `config.json`：2 账号（`second` cdpPort 9222 含 `math`/`model`/`cover` 覆盖；`gaoh` cdpPort 9223 含 `model` 覆盖），
顶层含 `browser`/`model`/`notify`/`cover`/`proxy`。

```
$ CONSOLE_DB=/tmp/check-ac3/db3/console.db bun src/console/main.ts --import-config
已导入 config.json → DB
  账号: second(new), gaoh(new)
  defaultAccount=second
  原始备份: .../config.json.bak
  回写 config.json: .../config.json (2800 bytes)
EXIT=0

$ diff /tmp/check-ac3/original-config.json config.json.bak && echo BAK_IDENTICAL
BAK_IDENTICAL

# DB 内容（只读脚本）
ACCOUNTS: [ {id:1, alias:"second", cdp_port:9222, enabled:1, overrides_json:"{...\"math\":{\"enabled\":true,\"scale\":1.25},\"model\":...,\"cover\":...}"},
            {id:2, alias:"gaoh",   cdp_port:9223, enabled:0, overrides_json:"{...\"model\":{\"plan\":...}}"} ]
SETTINGS keys: [ "global" ]   GLOBAL has accounts? false   defaultAccount=second
USER_VERSION: 1
```

`overrides_json` 为**原样条目**（无 `alias` 键，engine 重新补；无深合并）。`config.json.bak` 与导入前原件**字节一致**。
（`.bak` 在后续多次回渲染后仍未被覆盖 → backup-not-clobber 成立。）

### 1.4 AC-3 等价（I1-6 / I1-7）—— 关键项

导入前捕获每个 alias 的 `loadConfig(alias)`，导入 + 回渲染后再捕获：

```
$ bun /tmp/check-ac3/before.ts > before.json   # 导入前
$ CONSOLE_DB=... bun src/console/main.ts --import-config
$ bun /tmp/check-ac3/before.ts > after.json    # 导入+回渲染后
$ diff before.json after.json && echo DIFF_CLEAN_BYTE_IDENTICAL
DIFF_CLEAN_BYTE_IDENTICAL
$ sha256sum before.json after.json
52f1c510…b18c4  before.json
52f1c510…b18c4  after.json

$ CONSOLE_DB=/tmp/check-ac3/db3/console.db bun src/console/main.ts --verify-ac3
AC-3 校验源: .../config.json.bak
✅ account second — AppConfig 逐字段一致
✅ account gaoh — AppConfig 逐字段一致
✅ 回渲染无意外 diff
== AC-3 PASS ==
EXIT=0
```

**合并语义确认（verbatim + 浅回退是等价的前提）**：`resolve.ts` 注释与实现一致 —— DB 存**原样条目**，
engine 逐**顶层键** `acct[k] ?? raw[k]`，`model` 再按 kind `acct.model?.[kind] ?? raw.model?.[kind]`。
用「假想 deepMerge」对比证明：`second` 的 `math` 覆盖 `{enabled:true,scale:1.25}`、全局 `math` 含 `color:""`；
浅回退得到 `math.color === undefined`，deepMerge 会得到 `color:""` —— **deepMerge 会破坏 AC-3**。故 verbatim 是正解。

### 1.5 AC-4 鉴权 / RBAC / CSRF / 审计（I1-4 / I1-5）

服务：`CONSOLE_MASTER_KEY=… CONSOLE_ALLOW_INSECURE_COOKIE=1 CONSOLE_DB=/tmp/check-ac4/console.db CONSOLE_PORT=8799`。

| # | 请求 | 期望 | 实测 |
|---|---|---|---|
| 1 | 未登录 `GET /api/accounts` | 401 | **401** |
| 2 | 未登录 `POST /api/accounts` | 401 | **401** |
| 3 | 错口令 `POST /api/login` | 401 | **401** |
| 4 | 正确登录 | Set-Cookie HttpOnly | `set-cookie: wfc_sid=…; HttpOnly; Path=/; SameSite=Lax; Max-Age=43200` |
| 4b | 不设 `ALLOW_INSECURE`（:8800） | 带 Secure | `…; Max-Age=43200; Secure` |
| 5 | `GET /api/me`（admin） | 200 | 200，`grantedAccounts:"all"`，`isAdmin:true` |
| 6 | `PUT /api/settings` 无 CSRF | 403 | **403**（审计 `CSRF 校验失败`） |
| 7 | `PUT /api/settings` 带 CSRF | 200 | **200** |
| 8 | owner 仅授权账号 1，`GET /api/accounts` | 仅 id1 | 仅 `second` |
| 9 | owner `GET /api/accounts/2` | 403 | **403** |
| 10 | owner `GET /api/settings` | 403 | **403** |
| 11 | owner `POST /api/accounts` | 403 | **403** |
| 12 | 降级最后一个 admin | 409 | **409** |
| 13 | 连续 5 次错口令后第 6 次 | 429 | **429** |
| 14 | 登出无 CSRF / 有 CSRF / 登出后 me | 403 / 200 / 401 | **403 / 200 / 401** |
| 15 | 会话过期（DB 置过去）后 me | 401 | **401** |
| 16 | `GET /api/audit?limit=50` | 含 denied | **denied 行存在**（`GET /api/accounts/2`、`POST /api/accounts`、`GET /api/settings`、CSRF 失败；`ok:0`） |
| 17 | `GET /api/accounts/9999` | 404 | **404** |

静态路径穿越：`/../src/config.ts`、`/..%2f..%2fsrc%2fconfig.ts`、`/%2e%2e%2f%2e%2e%2fsrc%2fconfig.ts`、`/ui/../server.ts` 全部 **404**；
`/app.js` 200、`/` 200。（WHATWG URL 会把 `%2e%2e/` 归一化掉，`..%2f` 含字面 `..` 被 `rel.includes("..")` 拦截。）

### 1.6 AC-2 覆盖/回退（R1.3 / R1.4）

```
PUT /api/settings {"global":{"math":{"enabled":false}}}      → 200
GET /api/accounts/1  → effective.math={"enabled":true,"scale":1.25}  source(math)=overridden
GET /api/accounts/2  → effective.math={"enabled":false}              source(math)=inherited
loadConfig(second).math.enabled = true ; loadConfig(gaoh).math.enabled = false
POST /api/accounts/1/reset-override {"key":"math"}           → 200，source(math)=inherited
loadConfig(second).math.enabled = false ; loadConfig(gaoh).math.enabled = false
```

**AC-2 PASS**（含 UI 字段来源徽标：`overridden`/`inherited`）。

### 1.7 AC-1 冲突（I1-9）

```
POST /api/accounts {"alias":"second","cdpPort":9224}  → 409 {"code":"conflict","message":"alias 已存在：second"}
POST /api/accounts {"alias":"third","cdpPort":9222}   → 409 {"message":"cdpPort 9222 已被账号「second」占用",
                                                          "detail":{"suggestions":[9224,9225,9226,9227,9228]}}
POST /api/accounts {"alias":"third","cdpPort":9224,"dataDir":"./data/third"} → 201
```

A/B/… 的 `dataDir` 互不相同；重复端口被拒并给出可用端口提示。

### 1.8 engine 回归

```
$ bun src/cli.ts accounts
★ 默认  second 巧思初数 ...  停用 gaoh ...  停用 third ...        EXIT=0

$ timeout 60 bun src/cli.ts doctor --all
✅ config.json … ❌ skill script … ✅ pi 1.0.4 ✅ bun 1.4.2 … ✅ CDP 端口唯一 :9222   EXIT=0
（❌ 项均为环境缺失：baoyu skill / Chrome / convert / email-sender，与本次改动无关）

$ timeout 90 bun src/cli.ts publish --dry-run
[WARN] no plan entry for 2026-10-14; run "plan" first                    EXIT=0
```

`src/config.ts` 改动是「只增 `resolveConfig` + `loadConfig` 改为调用它」，行为未变（AC-3 字节一致为强证据）。

---

## 2. AC 汇总表

| AC | 结论 | 证据 |
|---|---|---|
| AC-1 账号隔离/端口冲突 | **PASS** | §1.7 409 + suggestions；`dataDir` 互异；§1.2 fail-fast |
| AC-2 全局⊕覆盖/恢复继承 | **PASS** | §1.6，A=true/B=false，reset 后 A=false；来源徽标 |
| AC-3 迁移逐字段一致 | **PASS** | §1.4 `DIFF_CLEAN_BYTE_IDENTICAL` + `== AC-3 PASS ==`；verbatim 语义已验证 |
| AC-4 鉴权/RBAC/CSRF/审计 | **PASS** | §1.5 全表；401/403/409/429 + denied 审计 |
| AC-10 零依赖/兼容 | **PASS** | §1.1 tsc/build 0、deps 空、无 bun-types；§1.8 CLI 可用 |

---

## 3. Spec 漂移（`.trellis/spec/console/*` 未校准为 v1）

DoD 要求「spec 按实现校准（`crypto.subtle`→`node:crypto` 等）」，实际未做：

| # | 位置 | 漂移 | 建议 |
|---|---|---|---|
| D1 | `data-model.md:15-17`「深合并规则：对象递归深合并」 | **实现是 verbatim + 逐顶层键浅回退，不是深合并**。深合并会破坏 AC-3（见 §1.4 证明）。`design.md:17,43,125-132` 同样写 `deepMerge` | 改为「存储原样条目，engine 逐顶层键 `??` 回退」并删除 deepMerge 描述 |
| D2 | `data-model.md:18`「`null`：显式清空该键」；`design.md` 同 | **`null` 实为“视为缺省/继承”**。实测：全局 `color=red` + 账号 `color=null` → 生效 `red`；`""` 才覆盖 | 改为「`null` 等同缺省」 |
| D3 | `security.md:5`（§5）、`index.md` 技术栈表「AES-256-GCM（`crypto.subtle`）WebCrypto」 | 实现用 `node:crypto`（`design.md:3.2` 明确要求改措辞） | 改为 `node:crypto` |
| D4 | `data-model.md:47-52` DDL 无 `login_attempts` 表；`audit` 无 `actor`/`ok` 列 | 实现新增 `login_attempts` 表 + `audit.actor`/`audit.ok` | 同步 DDL（或说明为 C1 增补） |
| D5 | `api.md:28` 401 code = `unauthenticated` | 实现 `respond.ts:26` 返回 `unauthorized` | 二者对齐 |
| D6 | `api.md:59` reset-override 入参 `{path}` | 实现 `server.ts:312` 用 `{key}`，且仅支持**顶层键**（删整棵子树） | 对齐为 `{key}` 或明确语义 |

> 其它：`security.md §1` 要求响应头含 `Strict-Transport-Security` 与「CSP 最小集」，实现只发
> `X-Content-Type-Options/X-Frame-Options/Referrer-Policy`（见 Bug B5/风险）。

---

## 4. Bug / 风险（含 file:line）

### B1（中）`cdpPort` 字符串绕过唯一约束 → 违反 H4 账号隔离
- 位置：`src/console/server.ts:144-146`（`cdpPortConflict` 仅当 `typeof port === "number"` 才检查）；
  `src/console/db/dao/accounts.ts` 的 `mirror()/numOrNull`（非 number → 列为 `NULL`，因此 `UNIQUE(cdp_port)` 不触发）。
- 复现：
  ```
  POST /api/accounts {"alias":"strport","cdpPort":"9222"}  → 201（cdp_port 列为 null）
  DB: second.cdp_port=9222 ; strport.cdp_port=null
  loadConfig("strport").browser.cdpPort === "9222"  (string)   # 与 second 的 9222(number) 指向同一 CDP 端口
  ```
- 影响：两个账号可共用同一 CDP 端口 → 串号发布（H4 硬约束）。UI 因 `Number(portRaw)` 不会触发，但 API 可被直接调用绕过。
- 建议：对 `cdpPort` 做严格类型/范围校验（`Number.isInteger` 且 1..65535），非法 400；并把校验放在 `mirror` 之前对所有写入路径共用。

### B2（中）账号详情向 owner 泄露全局配置（含潜在凭据）
- 位置：`src/console/server.ts:121-129`（`accountDetail` 返回完整 `global`）。
- 复现：`GET /api/accounts/1`（owner 授权账号即可）→ 响应含 `global.notify.telegram.botToken`、`global.skillDir` 等。
- 影响：`botToken` 属凭据（H7 凭据不回显）；owner 无需 `GET /api/settings`（admin-only）即可读取全局。
- 建议：只返回 `effective` 与 `sources`，或对 `global` 做凭据字段白名单/脱敏。

### B3（中低）畸形 Cookie 触发未处理异常 → 500
- 位置：`src/console/auth/sessions.ts:154`（`parseCookie` 内 `decodeURIComponent(...)` 未 try/catch）。
- 复现：`curl -H 'Cookie: wfc_sid=%' /api/me` → **500**（`/health` 与静态资源不解析 Cookie，故 200；`/api/*` 全中招）。
- 影响：未认证客户端可稳定触发 500 与日志噪音；不构成越权，但违反「失败显形/健壮」。
- 建议：`parseCookie` 内 try/catch，非法值按无 Cookie 处理（→ 401）。

### B4（中低）`POST /api/users` 传入不存在的 `accountIds` → 500 且留下孤儿用户
- 位置：`src/console/server.ts:364-368` 调 `setGrants`；`src/console/db/dao/accounts.ts:161-177`（FK 失败）。
- 复现：`POST /api/users {"username":"ghost",...,"accountIds":[9999]}` → **500**
  （server.log：`SQLiteError: FOREIGN KEY constraint failed ... at setGrants`）；`createUser` 已提交，用户被创建但授权未写。
- 建议：先校验 `accountId` 存在，非法 400；把「建用户 + 授权」放进同一事务。

### B5（低）安全响应头缺 HSTS / CSP；`syncConfigFile` 吞掉回渲染失败
- `src/console/server.ts:90-99` 未设置 `Strict-Transport-Security` / `Content-Security-Policy`（spec/security §1 要求）。
- `src/console/server.ts:156-162` `syncConfigFile` 捕获 `renderConfig` 异常仅 `console.error` 后继续，API 仍返回 **200**；
  若写盘失败会出现「DB 已改、config.json 未同步」的静默漂移，违反 H5（失败显形）。建议失败时返回 5xx 并提示不一致。

### 观察（非阻断）
- `recordAudit` 从不传 `userId`（`src/console/db/dao/audit.ts:16`），`audit.user_id` 恒为 `NULL`；且 `handle()` 记录 403 审计时
  拿不到会话，`actor` 恒为 `"unknown"`（`src/console/server.ts:458-462`）。建议在越权审计中带上已认证用户。
- `sessions.ts:lockState` 用 `ORDER BY ts DESC LIMIT 1` 取的是**最新**失败（变量名 `oldest`），`retryAfterSec` 偏保守（安全但偏长）。
- `login_attempts` 无清理，长期增长；`touchSession` 定义了但从未调用（`last_seen_at` 不更新）。
- `verify-ac3.ts` 的 `renderDiffIgnored` 过滤 `d === "accounts"` 对递归路径（`accounts.<alias>…`）无效，基本是死代码（本次 diff 为空故无影响）。
- `GET /api/accounts/:id` 对不存在账号返回 404、对无权返回 403，owner 可据此枚举账号存在性（低危信息泄露）。
- `PUT /api/settings` 为顶层浅合并（`{...global, ...incoming}`），替换整个 `math` 子对象；与 engine 语义一致，但设计文档写「深合并」，易误用（见 D1）。

---

## 5. 复验建议（最小）

```bash
# B1：应 400/409，而不是 201
curl -b admin.jar -X POST :8787/api/accounts -H 'x-csrf-token: …' \
  -d '{"alias":"strport","cdpPort":"9222"}'
# B3：应 401，而不是 500
curl -i -H 'Cookie: wfc_sid=%' :8787/api/me
# B4：应 400，且不产生用户
curl -b admin.jar -X POST :8787/api/users -H 'x-csrf-token: …' \
  -d '{"username":"ghost","password":"ghostpass123","role":"owner","accountIds":[9999]}'
```
