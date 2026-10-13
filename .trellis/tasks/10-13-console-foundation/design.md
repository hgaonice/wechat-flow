# C1 · design.md · 控制台基座技术设计

> 父任务：`.trellis/tasks/10-13-wechat-flow-console/`（`prd.md` / `design.md`）。
> 契约基线：`.trellis/spec/console/{index,api,data-model,security}.md`（v0，本文落地时校准）。
> 范围：**只做 C1**（服务骨架 / DB / 鉴权 RBAC / 账号 CRUD / 配置继承与覆盖 / 迁移与回渲染）。
> 不做：计划调度（C2）、内容生成（C3）、agent 会话（C4）、隧道邮件（C5）、部署（C6）。

---

## 1. 目标与验收映射

交付一个**可登录、可管账号、可改配置**的最小可用控制台，engine 与发布链路保持不变。

| AC | 落地位置 |
|---|---|
| AC-1 账号 A/B 隔离、`cdpPort` 冲突拒绝 + 可用端口提示 | `dao/accounts.ts` + `POST /api/accounts` 校验 |
| AC-2 全局 `math.enabled=false`，A 覆盖 `true`，清除后回落 | `config/resolve.ts` 深合并 + `reset-override` |
| AC-3 DB 解析 `AppConfig` 与原 `loadConfig()` 逐字段一致；回渲染无非预期 diff | `db/import-config.ts`+`render-config.ts`+`--verify-ac3` |
| AC-4 未登录 401 / 越权 403 + 审计 / admin 全通 | `auth/sessions.ts` + `auth/rbac.ts` + `audit` |
| AC-10 `tsc`/`build` 零错误；无新增 runtime 依赖；`doctor --all` 可用 | 见 §3 类型策略 + §9 验证 |

---

## 2. 新增文件（C1 实际落地）

```text
src/console/
  main.ts                 # 入口 + 子命令: serve(默认)/--import-config/--create-admin/--verify-ac3
  server.ts               # Bun.serve 装配：路由 + 静态 UI + 错误中间件 + 安全响应头
  bun.d.ts                # 最小 Bun 环境类型声明（见 §3）
  http/router.ts          # method+pattern 路由（无依赖）
  http/respond.ts         # json/html/error + 统一错误包
  http/static.ts          # ui/ 静态资源
  auth/users.ts           # 用户 CRUD + Bun.password(argon2id)
  auth/sessions.ts        # 登录/登出/会话校验 + CSRF
  auth/rbac.ts            # admin/owner 授权判定 + 越权审计
  crypto/secrets.ts       # AES-256-GCM + master key 装载(fail-fast)
  db/schema.ts            # v1 全量 DDL（源 spec/console/data-model.md）
  db/migrate.ts           # user_version 前滚（事务化）
  db/import-config.ts     # config.json → DB（一次性，备份 .bak）
  db/render-config.ts     # DB → config.json（原子回渲染 + .bak）
  db/dao/{users,accounts,settings,grants,audit}.ts
  config/resolve.ts       # deepMerge + buildRawConfig(alias)（喂给 engine）
  config/raw.ts           # RawConfig 类型（宽松）+ 键来源判定
  verify-ac3.ts           # AC-3 逐字段比对器
  ui/{login.html,index.html,account.html,settings.html,app.js,app.css}
```

**依赖方向**：`console/* → ../*.ts`；engine 不引用 console（H2）。

---

## 3. engine 集成契约（两处必要改动，均在 engine 侧“只增不改”）

### 3.1 `src/config.ts`：抽取 `resolveConfig`

```ts
export interface RawConfig { [k: string]: any }

// 新增导出：等价于现有 loadConfig 的“raw → AppConfig”核心逻辑
export function resolveConfig(raw: RawConfig, accountAlias?: string): AppConfig;

// loadConfig 改为：
export function loadConfig(accountAlias?: string): AppConfig {
  return resolveConfig(readRawConfig(), accountAlias);
}
```

- `readRawConfig` / `normalizeAccounts` / `defaultAlias` / `listAccounts` / `ensureDirs` **签名与行为不变**。
- 用原始 `config.json` 调用 `resolveConfig(readRawConfig(), a)` 必须与原 `loadConfig(a)` **逐字段一致**（`--verify-ac3` 双向校验）。
- `SRC_DIR` / `APP_DIR` / `CONFIG_PATH` 保持导出（回渲染复用 `CONFIG_PATH`）。

### 3.2 Bun 类型策略（AC-10 关键）

现状：`bun` 未安装、`tsconfig.types=["node"]`、devDeps 仅 `@types/node`+`typescript`。
`Bun.serve` / `Bun.password` / `bun:sqlite` 无类型 → 直接写会 `tsc --noEmit` 报错。

**决策**：新增 `src/console/bun.d.ts`，手写**最小**环境声明（仅覆盖本项目用到的 API），保持零新增依赖：

```ts
declare module "bun:sqlite" {
  export class Database { constructor(path: string); query(sql: string): any; run(sql: string, ...p: any[]): any;
    exec(sql: string): void; prepare(sql: string): any; transaction<T>(fn: (...a:any[])=>T): (...a:any[])=>T; close(): void; }
}
interface BunServeOptions { port: number; hostname?: string; fetch(req: Request): Response | Promise<Response>; }
interface BunPassword { hash(pw: string, opts?: any): Promise<string>; verify(pw: string, hash: string): Promise<boolean>; }
interface BunSpawnOptions { cwd?: string; env?: Record<string,string|undefined>; stdin?: "pipe"|"inherit"; stdout?: "pipe"|"inherit"; stderr?: "pipe"|"inherit"; }
declare const Bun: {
  serve(o: BunServeOptions): { port: number; stop(): void };
  password: BunPassword;
  spawn(cmd: string[], o?: BunSpawnOptions): any;
  env: Record<string,string|undefined>;
  file(p: string): { text(): Promise<string>; exists(): Promise<boolean> };
};
```

- 若日后引入 `bun-types`（devDep）则删除本文件并在 `tsconfig.types` 增加 `bun-types`；**不改 runtime `dependencies`**（AC-10）。
- 加解密用 `node:crypto`（`createCipheriv('aes-256-gcm')` / `randomBytes` / `timingSafeEqual` / `createHash('sha256')`）——**已被 `@types/node` 覆盖**，Bun 原生兼容，避免 WebCrypto 类型问题。同步校准 `spec/console/{security,data-model}.md` 措辞（WebCrypto → node:crypto）。

---

## 4. DB 与迁移

- DDL 采用 `spec/console/data-model.md` §2 的 **v1 全量 schema**（16 表 + 3 索引），`db/schema.ts` 单一常量。
- `db/migrate.ts` 以 `PRAGMA user_version` 前滚；迁移在事务内执行，失败**中止启动**并显式报错。
- 每次连接：`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;`
- DB 路径：`console/console.db`（`CONSOLE_DB` 可覆盖；`.gitignore` 追加 `console/`）。

`accounts` 表存**配置真源**（`overrides_json` = 账号显式条目，见 §5），热字段 `alias/cdp_port/enabled/data_dir/display_name` 作为**镜像列**，仅用于 `UNIQUE` 约束与列表查询；两者在同一事务内同步（C1 约定，写入经 `dao/accounts.save()` 单入口）。

---

## 5. 配置重建与回渲染（AC-2 / AC-3 核心）

### 5.1 存储形态

- `settings(key='global').value_json` = 原始 `config.json` **去掉 `accounts` 与 `defaultAccount`** 后的顶层对象。
- `accounts.overrides_json` = 原始 `config.json.accounts[alias]` **原样条目**（显式键即“覆盖”，缺省键即“继承”）。

### 5.2 解析（喂给 engine `resolveConfig`）

```
globalRaw = settings('global')
entryA    = JSON.parse(accounts[A].overrides_json)      // 显式条目
merged    = deepMerge(globalRaw, entryA)                 // 对象递归 / 数组整体替换 / null 清空 / undefined 跳过
raw       = { ...globalRaw, defaultAccount: A, accounts: { [A]: { ...merged, alias: A } } }
cfg       = resolveConfig(raw, A)
```

**为什么与 `loadConfig` 等价**：engine 取值为 `entry[K] ?? global[K]`。
- `entry[K]` 有值 → `deepMerge` 保留 `entry[K]` → 等价；
- `entry[K]` 缺省 → `deepMerge` 填 `global[K]` → `global[K] ?? global[K]` 等价。
故 AC-3 逐字段一致成立（`null` 清空为设计增强，原配置无 `null` 时不引入差异）。

### 5.3 回渲染（`render-config.ts`）

```
json = { ...globalRaw, defaultAccount, accounts: { [alias]: explicitEntry } }   // 不写 merged
```
- 写前：现有 `config.json` 复制为 `config.json.bak`；
- 原子写：同目录 `config.json.tmp` → `fsync` → `rename`；
- 触发点：`PUT /api/settings`、账号 CRUD / `reset-override` 成功后。
- 目标：与导入前 `config.json` 的语义 diff 为空（`--verify-ac3` 用规范化 JSON 比对）。

### 5.4 “恢复继承”与来源判定

- `entry[K]` 缺省 → **继承**；存在且值与 global 不同 → **覆盖**；存在且相同 → **显式同值**。
- `POST /api/accounts/:id/reset-override { path }` → 删除 `entry` 中该路径 → 保存 → 回渲染。
- C1 仅支持删除**叶子路径 / 子对象**；父对象清空后若为空则一并删除（避免残留 `{}`）。

---

## 6. 鉴权 / RBAC / 引导

### 6.1 首次引导与 master key（fail-fast）

- `--create-admin <user>`：读 `CONSOLE_ADMIN_PASSWORD`（或交互输入）→ `Bun.password.hash` → 写 `users(role='admin')`。
- 启动时若 `users` 为空 → **拒绝启动**并提示先 `--create-admin`（不设默认口令）。
- master key：`CONSOLE_MASTER_KEY`（base64 32B）优先；否则 `~/.wechat-console/master.key`（不存在则生成，`0600`）；无 key 时服务**拒绝启动**（`crypto/secrets.ts` fail-fast）。

### 6.2 会话与 CSRF

- 登录成功：生成 32B 随机 `token`（base64url）→ 存 `login_sessions(token_hash=sha256(token), csrf_token, expires_at=now+TTL)` → `Set-Cookie: wfc_sid=<token>; HttpOnly; Secure; SameSite=Lax; Path=/`。
  - 本地 http 调试：`CONSOLE_ALLOW_INSECURE_COOKIE=1` 时才去掉 `Secure`（默认加）。
- 每请求：`sha256(cookie)` 查表 → 校验 `expires_at` → 装载 `{user, role, grantedAccounts}`（懒清理过期）。
- 写请求（POST/PUT/PATCH/DELETE）必须带 `X-CSRF-Token`，与 `login_sessions.csrf_token` 恒定时间比对；不匹配 403。

### 6.3 RBAC 与审计

- `admin` 全通；`owner` 仅 `account_grants` 内账号；否则 **403 + `audit`**。
- 集中判定：`auth/rbac.ts#assertAccount(user, accountId)`；handler 不得自行判断（H/rules）。
- 审计落库：登录成功/失败、账号增删改、配置变更、越权尝试、用户/授权变更。
- 管理接口：`POST /api/users`、`GET /api/users`、`PUT /api/users/:id`、`POST /api/accounts/:id/grants`（均 admin）。

---

## 7. HTTP API（C1 子集，遵循 `spec/console/api.md`）

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/health` | 免鉴权 | `{ok,version,db,uptime}` |
| POST | `/api/login` | 免 | 登录 → Cookie；连续失败锁定 |
| POST | `/api/logout` | 登录 | 吊销当前会话 |
| GET | `/api/me` | 登录 | `{id,username,role,grantedAccounts,csrfToken}` |
| POST | `/api/password` | 登录 | 改密 + 吊销其它会话 |
| GET | `/api/accounts` | 登录 | owner 仅授权账号 |
| POST | `/api/accounts` | 登录 | 新建；`alias`/`cdpPort` 唯一校验，冲突 409 + 可用端口提示 |
| GET | `/api/accounts/:id` | 授权 | 详情 + 字段来源（`inherited`/`overridden`/`explicit`） |
| PUT | `/api/accounts/:id` | 授权 | 更新基本信息 + 覆盖条目 |
| DELETE | `/api/accounts/:id` | admin | 解除登记（**不删** `data/<alias>/`，显式确认） |
| POST | `/api/accounts/:id/reset-override` | 授权 | 恢复继承 |
| GET | `/api/settings` | admin | 全局默认 + 各键来源 |
| PUT | `/api/settings` | admin | 更新全局 → 回渲染 |
| GET/POST | `/api/users`、`PUT /api/users/:id` | admin | 用户与角色 |
| POST | `/api/accounts/:id/grants` | admin | owner 授权 |

错误包与状态码遵循 `api.md` §1；**任何失败不得 200 伪装成功**（H5）。

---

## 8. UI（无构建静态页）

- `login.html`：用户名/密码 → `POST /api/login`。
- `index.html`：账号列表（别名 / 名称 / `cdpPort` / 启用）+ 新建入口。
- `account.html`：编辑基本信息；配置字段以**徽标**显示 `继承 / 覆盖 / 显式同值`，覆盖项提供「恢复继承」按钮。
- `settings.html`：全局默认编辑（admin）。
- `app.js`：`fetch` 封装（自动带 `X-CSRF-Token`）+ 表单渲染；`app.css` 极简样式。
- **不内嵌任何凭据**；所有数据走 API。

---

## 9. 验证与回滚

### 验证命令
```bash
node_modules/.bin/tsc --noEmit                       # 等价 bunx tsc --noEmit
bun build --target=bun src/console/main.ts >/dev/null
bun src/console/main.ts --import-config              # 备份 + 导入
bun src/console/main.ts --verify-ac3                 # AC-3 逐字段 / 渲染 diff
bun src/console/main.ts --create-admin admin
CONSOLE_ADMIN_PASSWORD=*** bun src/console/main.ts & # 起服务
curl -s localhost:8787/health
curl -s -i -X POST localhost:8787/api/accounts | head  # 期望 401
bun src/cli.ts doctor --all && bun src/cli.ts publish --dry-run
```

### AC-3 比对器（`verify-ac3.ts`）
1. 读 `config.json.bak`（导入前原件）→ `resolveConfig(orig, a)`。
2. DB 重建 raw → `resolveConfig(dbRaw, a)`。
3. 对每账号做**深比较**（键集合 + 值 + 类型，忽略键序）→ 差异即失败并打印路径。
4. 回渲染到临时文件 → 与 `.bak` 规范化 JSON diff。

### 回滚点
- 迁移前：`config.json.bak`（import 生成）；
- DB：删除 `console/console.db*` 可从 `.bak` 重建；
- engine：`resolveConfig` 为纯增量导出，回滚仅需恢复 `src/config.ts`；
- 服务：停 `main.ts` 进程即可，engine CLI 不受影响。

---

## 10. 风险与权衡

| 点 | 取舍 |
|---|---|
| `overrides_json` 存“显式条目”而非“diff” | 回渲染与 AC-3 可无损；UI 来源用实时 diff 计算 |
| 热字段列 + JSON 双存 | 满足 `UNIQUE` 与查询；用单入口 `save()` 事务同步防漂移 |
| 手写 `bun.d.ts` 而非加 `bun-types` | 守零依赖红线；代价是类型覆盖窄（仅本项目 API） |
| `node:crypto` 而非 WebCrypto | 已被 `@types/node` 类型覆盖、Bun 兼容；同步校准 spec 措辞 |
| 启动强依赖 admin 与 master key | 安全优先（fail-fast），无默认口令 |
