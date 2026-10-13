# C1 · implement.md · 执行计划（console-foundation）

> 设计见 `design.md`；契约见 `.trellis/spec/console/`；父排期见父任务 `implement.md`（M1）。
> 完成 = 产物路径 或 真实命令输出；禁止“我记得做过了”。

---

## 0. 开工前置检查

- [x] `prd.md` 写明目标/验收/依赖
- [x] `design.md` 就绪（本目录）
- [x] `implement.md` 就绪（本文件）
- [ ] `implement.jsonl` / `check.jsonl` 写入真实条目（非占位）
- [ ] 用户批准本规划摘要 → `python3 .trellis/scripts/task.py start`

---

## 1. 实施顺序（每步含验证）

### I1-1 服务骨架 + 路由
- 新增 `src/console/bun.d.ts`、`http/{router,respond}.ts`、`server.ts`、`main.ts`（`serve` 默认 + 占位子命令）。
- **验证**：`node_modules/.bin/tsc --noEmit`；`bun build --target=bun src/console/main.ts`；`curl /health` 返回 200。

### I1-2 DB schema + migrate
- `db/schema.ts`（v1 全量 DDL）+ `db/migrate.ts`（`user_version` 前滚 / WAL / foreign_keys）。
- `.gitignore` 追加 `console/`。
- **验证**：首次启动建库；`sqlite3 console/console.db .tables` 含 16 表；重启幂等不重复迁移。

### I1-3 凭据加密 + master key
- `crypto/secrets.ts`（AES-256-GCM，`node:crypto`；`CONSOLE_MASTER_KEY` / `~/.wechat-console/master.key` 0600；无 key fail-fast）。
- **验证**：临时脚本 encrypt→decrypt 往返一致；无 key 时启动**显式报错**（非静默）。

### I1-4 鉴权 / 会话 / CSRF / RBAC
- `auth/{users,sessions,rbac}.ts` + 登录/登出/me/password 路由 + `--create-admin`。
- **验证**：未登录 `POST /api/accounts` → **401**；错误口令计数锁定 → **429**；写请求缺 `X-CSRF-Token` → **403**。

### I1-5 DAO：settings / accounts / users / grants / audit
- `db/dao/*`；`accounts.save()` 单入口同步热字段列与 `overrides_json`。
- **验证**：`tsc`；建 A/B 账号后 `sqlite3 ... select alias,cdp_port` 唯一。

### I1-6 engine `resolveConfig` 抽取 + 深合并工具
- 改 `src/config.ts`（**只增不改签名**）；新增 `config/resolve.ts`（`deepMerge` + `buildRawConfig`）。
- **验证**：`bun src/cli.ts doctor --all` 仍通过；`bun src/cli.ts publish --dry-run` 仍生成成功。

### I1-7 import-config / render-config
- `db/import-config.ts`（备份 `.bak` + 事务导入）、`db/render-config.ts`（原子写 + `.bak`）。
- **验证**：`--import-config` 后 `--verify-ac3` 通过；改设置后回渲染 diff 为空。

### I1-8 UI：登录 + 账号列表/编辑 + 字段来源 + 恢复继承
- `ui/*` + `http/static.ts`。
- **验证**：浏览器/`curl` 走通登录 → 列表 → 编辑 → 恢复继承；来源徽标正确。

### I1-9 校验与冲突提示
- `POST /api/accounts` 校验 `alias`/`cdpPort` 唯一，冲突 **409** 且返回**可用端口建议**。
- **验证**：重复 `cdpPort` 被拒并给出可用端口；重复 `alias` 被拒。

### I1-10 AC 回归 + 收口
- 跑 §2 全套；更新 `AGENT.md`（§1 S12、§5 Checkpoint、§9 日志）、journal；归档任务。

---

## 2. 验收命令（AC 映射）

```bash
# AC-10
node_modules/.bin/tsc --noEmit
bun build --target=bun src/console/main.ts >/dev/null
node -e "const p=require('./package.json');if(p.dependencies)process.exit(1)"   # 无 runtime 依赖

# 迁移 + AC-3
bun src/console/main.ts --import-config
bun src/console/main.ts --verify-ac3          # 期望: all accounts identical; render diff = 0

# AC-1
curl -s -b cookie -X POST localhost:8787/api/accounts -d '{"alias":"a","cdpPort":9224,...}'
curl -s -i -b cookie -X POST localhost:8787/api/accounts -d '{"alias":"b","cdpPort":9224,...}'  # 期望 409 + 可用端口

# AC-2
# 全局 math.enabled=false；A 覆盖 true → A 生效 true / B false；reset-override 后 A 回落 false
bun src/console/main.ts --verify-ac3

# AC-4
curl -s -i localhost:8787/api/accounts | head -1                       # 401
curl -s -i -b ownerCookie localhost:8787/api/accounts/<B> -X PUT ...   # 403 + audit 落库
sqlite3 console/console.db "select action,target from audit order by id desc limit 5"

# 兼容（迁移期）
bun src/cli.ts doctor --all
bun src/cli.ts publish --dry-run
```

**AC 映射**：AC-1（I1-9）、AC-2（I1-6/7 + reset-override）、AC-3（I1-7）、AC-4（I1-4/5）、AC-10（全程）。

---

## 3. 影响文件与回滚

| 文件/区域 | 动作 | 回滚 |
|---|---|---|
| `src/config.ts` | **只新增** `resolveConfig` 导出，`loadConfig` 内部改调用 | 恢复该文件即可（行为不变） |
| `src/console/**` | 全新目录 | 删除目录即可 |
| `config.json`（回渲染） | 原子写 + `.bak` | 恢复 `config.json.bak` |
| `console/console.db` | 新建（不入 git） | 删除 DB，从 `.bak` 重建 |
| `.gitignore` | 追加 `console/` | 还原 |

**发布链路（`wechat.ts`/`publisher.ts`/CDP）零改动**；若本任务意外触碰 → 需 G2 真机验收。

---

## 4. Review gates（人工确认点）

1. **本规划批准** → 才 `task.py start` 动代码（Phase 1 收口）。
2. **I1-6 之后**：确认 `resolveConfig` 抽取未改变 engine 行为（`doctor --all` + `publish --dry-run` 证据）。
3. **I1-7 之后**：确认 AC-3 逐字段一致证据（`--verify-ac3` 输出）。
4. **完成时**：AC-1/2/3/4/10 证据齐 → 更新 AGENT.md/journal → `task.py archive`。

---

## 5. 完成定义（DoD）

- AC-1/2/3/4/10 均有**真实命令输出或产物路径**；
- `.trellis/spec/console/*` 按实现校准为 v1（`crypto.subtle`→`node:crypto` 等）；
- `AGENT.md` §1（S12 置 ✅）、§5（Checkpoint 指向 C2）、§9（变更日志）更新；
- 无新增 runtime 依赖；engine CLI 与发布链路可用性未回退。
