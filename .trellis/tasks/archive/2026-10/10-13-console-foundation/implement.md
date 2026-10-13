# C1 · implement.md · 执行计划（console-foundation）

> 设计见 `design.md`；契约见 `.trellis/spec/console/`；父排期见父任务 `implement.md`（M1）。
> 完成 = 产物路径 或 真实命令输出；禁止“我记得做过了”。

---

## 0. 开工前置检查

- [x] `prd.md` 写明目标/验收/依赖
- [x] `design.md` 就绪（本目录）
- [x] `implement.md` 就绪（本文件）
- [x] `implement.jsonl` / `check.jsonl` 写入真实条目（非占位）
- [x] 用户批准本规划摘要 → 已 `python3 .trellis/scripts/task.py start`（`planning → in_progress`）

---

## 1. 实施顺序（每步含验证）

### I1-1 服务骨架 + 路由
- 新增 `src/console/bun.d.ts`、`http/{router,respond}.ts`、`static.ts`、`server.ts`、`main.ts`（`serve` + 子命令）。
- **验证**：`node_modules/.bin/tsc --noEmit` 零错误；`bun build --target=bun src/console/main.ts` 通过；`curl /health` → 200。 ✅

### I1-2 DB schema + migrate
- `db/schema.ts`（v1 全量 DDL，**18 表** + 索引）+ `db/migrate.ts`（`user_version` 前滚 / WAL / `foreign_keys=ON` / `busy_timeout`）。
- `.gitignore` 追加 **`/console/`**（锚定根目录，避免误伤 `src/console/`）。
- **验证**：首启建库；`PRAGMA user_version=1`、`journal_mode=wal`、`foreign_keys=1`；实测表数 19（18 + `sqlite_sequence`）；重启幂等不重复迁移。 ✅

### I1-3 凭据加密 + master key
- `crypto/secrets.ts`（AES-256-GCM，**`node:crypto`**；`CONSOLE_MASTER_KEY` / `~/.wechat-console/master.key` 0600；无 key fail-fast）。
- **验证**：encrypt→decrypt 往返一致；无 key 时 `serve` **显式报错**（非静默）。 ✅

### I1-4 鉴权 / 会话 / CSRF / RBAC
- `auth/{users,sessions,rbac}.ts` + 登录/登出/me/password 路由 + `--create-admin`。
- **验证**：未登录访问 → **401**；错误口令计数锁定 → **429**；写请求缺 `X-CSRF-Token` → **403**；owner 越权 → **403** 且落 `audit`。 ✅

### I1-5 DAO：settings / accounts / users / grants / audit
- `db/dao/*`；`accounts` 单写入路径同步热字段列与 `overrides_json`（verbatim）。
- **验证**：`tsc`；建 A/B 账号后 `cdp_port` 唯一；重复端口 → 409 + 可用端口建议。 ✅

### I1-6 engine `resolveConfig` 抽取
- 改 `src/config.ts`（**只增不改签名**：新增 `resolveConfig(raw, alias)`，`loadConfig` 内部改为调用它）；新增 `config/resolve.ts`（`buildRawConfig` 条目 **verbatim** + 覆盖来源判定；**不做深合并**）。
- **验证（review gate #2）**：`bun src/cli.ts doctor --all` 与 `bun src/cli.ts publish --dry-run` 仍可用；`loadConfig` 逐字段输出与改动前一致。 ✅

### I1-7 import-config / render-config
- `db/import-config.ts`（备份 `.bak` + 事务导入）、`db/render-config.ts`（tmp→fsync→rename 原子写 + `.bak` 不覆盖）、`verify-ac3.ts`。
- **验证（review gate #3）**：`--import-config` 后 `--verify-ac3` 通过；改设置后回渲染 diff 为空。 ✅

### I1-8 UI：登录 + 账号列表/编辑 + 字段来源 + 恢复继承
- `ui/{login,index,account,settings}.html` + `app.js/app.css`；`http/static.ts`（防目录穿越）。
- **验证**：登录 → 列表 → 编辑 → 恢复继承走通；来源徽标 `inherited/overridden` 正确。 ✅

### I1-9 校验与冲突提示
- API 写入侧 `assertEntryTypes`（类型校验）+ `cdpPort`/`alias` 唯一 → **409** + **可用端口建议**；`accountIds` 校验避免 FK 500。
- **验证**：重复 `cdpPort`/`alias` 被拒并给建议；非整数 `cdpPort` → 400；不存在的 grant id → 400 且不留孤儿用户。 ✅

### I1-10 AC 回归 + 收口
- 跑 §2 全套；`trellis-check` 独立复核（`check-report.md`）；更新 `AGENT.md`（§1 S12、§5 Checkpoint、§9 日志）、journal；归档任务。 ✅

---

## 2. 验收命令（AC 映射）+ 实测结果

```bash
# AC-10（零依赖 / 类型 / 构建）
node_modules/.bin/tsc --noEmit                       # ✅ 零错误
bun build --target=bun src/console/main.ts >/dev/null # ✅ OK
node -e "const p=require('./package.json');if(p.dependencies)process.exit(1)"  # ✅ dependencies=undefined

# AC-1 fail-fast
bun src/console/main.ts            # ✅ exit 1: master key not found …
bun src/console/main.ts            # ✅ exit 1: 尚无任何用户 …

# AC-2 导入
bun src/console/main.ts --import-config   # ✅ accounts=2, 回写 config.json(1733B), 备份 config.json.bak

# AC-3 等价（关键）
bun src/console/main.ts --verify-ac3      # ✅ == AC-3 PASS ==（primary/second 逐字段一致, 回渲染 diff=0）
diff <(loadConfig-before) <(loadConfig-after)   # ✅ 字节级一致（sha256 相同）

# AC-4 鉴权/RBAC/CSRF/审计
# ✅ 17 项 curl 断言全过：401/403/409/429；owner 仅见授权账号；CSRF 缺失 403；audit 记 denied

# 迁移期兼容
bun src/cli.ts doctor --all          # ✅ exit 0（按账号正确解析 override/inherit）
bun src/cli.ts publish --dry-run     # ✅ exit 0
```

**AC 映射**：AC-1（I1-9）、AC-2（I1-6/7 + reset-override）、AC-3（I1-7）、AC-4（I1-4/5）、AC-10（全程）。

---

## 3. 影响文件与回滚

| 文件/区域 | 动作 | 回滚 |
|---|---|---|
| `src/config.ts` | **只新增** `resolveConfig` 导出，`loadConfig` 内部改调用 | 恢复该文件即可（行为不变） |
| `src/console/**` | 全新目录 | 删除目录即可 |
| `config.json`（回渲染） | 原子写 + `.bak` | 恢复 `config.json.bak` |
| `console/console.db` | 新建（不入 git，`/console/` 已忽略） | 删除 DB，从 `.bak` 重建 |
| `.gitignore` | 追加 `/console/` | 还原 |

**发布链路（`wechat.ts`/`publisher.ts`/CDP）零改动**；若本任务意外触碰 → 需 G2 真机验收。

---

## 4. Review gates（人工确认点）

1. **本规划批准** → 才 `task.py start` 动代码（Phase 1 收口）。 ✅（用户“批准 C1”）
2. **I1-6 之后**：确认 `resolveConfig` 抽取未改变 engine 行为（`doctor --all` + `publish --dry-run` 证据）。 ✅
3. **I1-7 之后**：确认 AC-3 逐字段一致证据（`--verify-ac3` 输出）。 ✅
4. **完成时**：AC-1/2/3/4/10 证据齐 → 更新 AGENT.md/journal → `task.py archive`。 ⏳ 本次收口

---

## 5. 完成定义（DoD）

- [x] AC-1/2/3/4/10 均有**真实命令输出或产物路径**（见 §6）；
- [x] `.trellis/spec/console/{index,api,data-model,security}.md` 按实现校准为 v1（`crypto.subtle`→`node:crypto`、verbatim 存储、`login_attempts`、`audit.actor/ok`、401 code、reset `{key}`）；
- [x] 无新增 runtime 依赖；
- [x] engine CLI 与发布链路可用性未回退（`doctor --all` / `publish --dry-run`）；
- [x] AGENT.md §1（S12 ✅）、§5（Checkpoint → C2）、§9（变更日志）更新；
- [ ] `task.py archive` + 提交（收口步骤）。

---

## 6. 证据索引（C1 实测）

| 证据 | 位置/命令 | 结果 |
|---|---|---|
| 独立复核报告 | `.trellis/tasks/10-13-console-foundation/check-report.md` | PASS（含 5 项 bug 已修） |
| AC-3 往返 | `--verify-ac3` + `diff before/after loadConfig` | 字节级一致 |
| 鉴权/RBAC | curl 断言 17+9 项 | 全过 |
| DB 元信息 | `PRAGMA user_version=1 / journal_mode=wal / foreign_keys=1` | ✅ |
| 类型/构建 | `tsc --noEmit` / `bun build` | ✅ |
| engine 回归 | `doctor --all` / `publish --dry-run` | ✅ |

> 复核发现的 5 项缺陷（cdpPort 字符串绕过 UNIQUE、owner 详情泄露 global、畸形 Cookie 500、不存在 grant id 的 FK 500 + 孤儿用户、CSP/HSTS 缺失）**已在本任务内修复并回归验证**。
