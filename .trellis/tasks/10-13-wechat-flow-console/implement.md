# implement.md · 执行计划与排期（wechat-flow-console）

> 配套：需求 `prd.md` · 调研 `research.md` · 设计 `design.md`。
> 父任务不直接实现；按子任务逐个 `task.py start` → 实现 → 验收 → 归档。
> **依赖不是父/子关系**：下列批次按"下一件可独立验收的事"排序，依赖写在每个子任务里。

---

## 0. 交付策略（先立骨架、再通闭环、最后加固）

```
M0 规划定稿 ──► M1 基座可登录/可管账号 ──► M2 调度+内容闭环 ──► M3 会话与人在环 ──► M4 运维与公网 ──► M5 加固与交付
   (本任务)          C1                      C2 ─► C3              C4                 C5               C6
```

**一条贯穿原则**：每个里程碑结束时，**既有 CLI 必须仍然可用**（`bun src/cli.ts publish --dry-run` 通过）。

---

## 1. 里程碑与排期

> 估时按**单人 + AI 协作**的净工作日；标注为**名义排期**（默认每天投入半天时的日历区间）。

| 里程碑 | 内容 | 子任务 | 估时 | 名义排期 | 出口条件（可验收） |
|---|---|---|---|---|---|
| **M0** | 规划定稿：prd/design/implement/research + 子任务树 + `.trellis/spec/console` 骨架 | — | 0.5d | D1 | 用户批准规划摘要（Phase 1 收口） |
| **M1** | 基座：服务骨架 + DB + 鉴权/RBAC + 账号 CRUD + 配置继承/覆盖 + 迁移 | C1 | 3–4d | D2–D6 | AC-1/2/3/4/10 全绿 |
| **M2** | 调度 + 内容闭环：计划表/任务模型 + 工作台 UI + 生成→草稿箱→重生成 | C2, C3 | 5–7d | D7–D15 | AC-5/7 全绿 |
| **M3** | 会话与人在环：pi RPC + 流式 + 决策卡片 + 最小权限 | C4 | 4–5d | D16–D22 | AC-6 全绿 |
| **M4** | 运维与公网：邮箱 + CF 隧道 + 凭据加密 + 管理员全局视图 | C5 | 3–4d | D23–D28 | AC-8/9 全绿 |
| **M5** | 加固与交付：反代/隧道、备份、限流、部署、文档、spec/AGENT 更新、最终集成验收 | C6 | 2–3d | D29–D33 | AC-10/11 + 全量回归 |
| | **合计** | | **18–24d** | ~5–7 周（半天/天） | |

**可并行点**：C4 与 C2 相互独立（都只依赖 C1），若想提前体验会话窗口，可在 C2 前插入 C4。
**不可并行点**：C3 依赖 C2 的任务模型；C6 依赖 C1–C5；C2 的调度接管 timer 必须在 C1 迁移验收（AC-3）之后。

---

## 2. 分任务执行清单

### M0 · 规划定稿（本任务，父任务）

- [x] P1 需求收集与澄清（用户 5 问 + 5 答）
- [x] P2 同类项目与底座调研 → `research.md`
- [x] P3 技术设计 → `design.md`
- [x] P4 执行排期 → 本文件
- [x] P5 建 6 个子任务（C1–C6）
- [ ] P6 用户批准规划摘要（**Phase 1 收口门**）
- [ ] P7 建 `.trellis/spec/console/` 骨架（index + api/data-model/security/agent-session）
- [ ] P8 更新 `AGENT.md`（进度看板新增 S11+、ADR 新增 D11–D14、任务地图）

**验证**：`.trellis/tasks/10-13-wechat-flow-console/{prd,design,implement,research}.md` 存在且非空；
`python3 .trellis/scripts/task.py list` 显示 parent + 6 children。

---

### M1 · C1 `console-foundation`

- [ ] I1-1 `src/console/` 骨架 + `http/router.ts` + `respond.ts` + `/health`
- [ ] I1-2 `db/schema.ts` DDL + `migrate.ts`（user_version）+ WAL/foreign_keys
- [ ] I1-3 `crypto/secrets.ts`（AES-256-GCM + master key 装载 + fail-fast）
- [ ] I1-4 `auth/*`：用户/登录/会话/CSRF/RBAC
- [ ] I1-5 `dao/accounts.ts` + `settings` + `account_email` + `account_grants`
- [ ] I1-6 `config/resolve.ts` 深合并 + `config.ts` 新增 `resolveConfig()`（不改旧签名）
- [ ] I1-7 `import-config.ts`（config.json → DB，含备份）+ `render-config.ts`（原子回渲染）
- [ ] I1-8 UI：登录页 + 账号列表/编辑 + 字段来源（继承/覆盖）标记与"恢复继承"
- [ ] I1-9 校验：alias 唯一、`cdpPort` 唯一、端口冲突提示可用端口

**验证命令**
```bash
bunx tsc --noEmit && bun build --target=bun src/console/main.ts >/dev/null
bun src/console/main.ts &            # 起服务
curl -s localhost:8787/health
bun src/cli.ts doctor --all          # 迁移后既有 CLI 仍可用
python3 .trellis/scripts/task.py current --source
```

**验收映射**：AC-1, AC-2, AC-3, AC-4, AC-10
**回滚点**：迁移前 `config.json.bak` + DB 快照；失败则删 `console.db` 并从 `.bak` 恢复。

---

### M2a · C2 `console-scheduler`

- [ ] I2-1 `plans` 表 + 周/月计划 CRUD（`period_key` = `2026-W42` / `2026-10`，周条目 ≤ 7 天）
- [ ] I2-2 `jobs` + `job_logs` + `queue.ts`（入队/认领/心跳/超时回收）
- [ ] I2-3 `worker.ts` 调 engine（`runPlan`/`runPublish`），**每账号互斥** + 全局并发上限
- [ ] I2-4 `scheduler.ts` 到期扫描（默认 60s）→ 入队
- [ ] I2-5 幂等：同账号+同日期已有 succeeded job 则跳过（对齐 `state/published.json`）
- [ ] I2-6 审计：任务触发/计划变更落 `audit`
- [ ] I2-7 停用 systemd timer（迁移期），保留回退脚本

**验证命令**
```bash
bunx tsc --noEmit
bun src/console/main.ts            # 手动入队一个 kind=plan 的任务
sqlite3 console/console.db "select id,kind,status from jobs order by id desc limit 5"
bun src/cli.ts status --all
```

**验收映射**：AC-5（调度侧）、AC-11

---

### M2b · C3 `console-content-workbench`

- [ ] I3-1 计划编辑 UI（周 ≤7 天 / 月摘要；日期/选题/摘要/目标字数）
- [ ] I3-2 "生成"按钮 → 入队 `kind=publish` → 实时状态（SSE `job.progress`）
- [ ] I3-3 产物查看：文章 md / 封面 / 公式渲染结果 / 草稿箱校验结果
- [ ] I3-4 重生成：`kind=regenerate` + 反馈 → 新 `articles.version`（`parent_id` 链）
- [ ] I3-5 版本对比 UI（旧版 vs 新版）
- [ ] I3-6 失败显形：`ok:false` + 原因 + 重试入口

**验证命令**
```bash
bun src/cli.ts drafts --date <YYYY-MM-DD>    # 期望输出含 "✅ 正文校验"
sqlite3 console/console.db "select version,status,file_path from articles where account_id=? order by version"
```

**验收映射**：AC-5, AC-7
**注意**：真机验收需在 250 上跑（G2 规则）；触碰发布链路只允许"传参"，不改 `verifyDraftBody`。

---

### M3 · C4 `console-agent-session`

- [ ] I4-1 `agent/rpc.ts`：`Bun.spawn("pi", ["--mode","rpc", …])` + 严格 JSONL 帧（只在 `\n` 切分，**不用 readline**）
- [ ] I4-2 命令封装：`prompt`/`steer`/`follow_up`/`abort`/`get_state`/`get_messages`/`set_model`；按 `id` 关联
- [ ] I4-3 事件分发：`message_update.text_delta`（SSE 流式）、`message_end`（落库）、`agent_settled`（settled）
- [ ] I4-4 `decisions`：`extension_ui_request` → 落库 + SSE `decision.pending`；应答写回 `extension_ui_response`；超时/取消/lost 状态
- [ ] I4-5 `agent/extensions/console-decision.ts`：注册决策工具 + `pi.on("tool_call")` 最小权限拦截
- [ ] I4-6 会话 UI：聊天窗 + 流式 + 决策卡片（select/confirm/input/editor）+ notify/status 展示
- [ ] I4-7 进程生命周期：崩溃标记 `lost`、pending 决策置 `lost`、自动重启策略
- [ ] I4-8 会话续接与 fork（复用 pi `session_id`/`fork`）

**验证命令**
```bash
bunx tsc --noEmit
# 会话冒烟：发一句 → 收到 text_delta → agent_settled
curl -sN localhost:8787/api/chat/<id>/stream
# 决策冒烟：触发 ask_user → decisions 出现 pending → POST 应答 → agent 继续
sqlite3 console/console.db "select method,status from decisions order by id desc limit 3"
```

**验收映射**：AC-6
**参考**：本机 pi 文档 `docs/rpc.md`、`docs/rpc-commands.md`、`docs/rpc-extension-ui.md`、`docs/json.md`、`docs/extensions.md`

---

### M4 · C5 `console-ops-tunnel`

- [ ] I5-1 `account_email` CRUD + 邮件模板（服务器信息 + CF 地址 + 该账号后台账密）
- [ ] I5-2 `secrets` 写入/轮换（wechat_login / cf_token / smtp）+ 掩码读取，**永不回显明文**
- [ ] I5-3 `tunnel/cloudflared.ts`：子进程监督 + URL 解析 + 健康检查
- [ ] I5-4 变更/过期 → 新 `tunnels` 行（`replaced_by`）+ 触发邮件 + 旧地址 `expired`
- [ ] I5-5 管理员全局视图（跨账号配置总览 + 操作入口）
- [ ] I5-6 发信去重与失败重试（避免地址抖动时邮件轰炸）

**验证命令**
```bash
bunx tsc --noEmit
sqlite3 console/console.db "select kind,url,status,replaced_by from tunnels order by id desc limit 5"
# 重启 cloudflared → 观察 1 分钟内 tunnels 新行 + 邮件到达
```

**验收映射**：AC-8, AC-9

---

### M5 · C6 `console-deploy-hardening`

- [ ] I6-1 `wechat-console.service` + `cloudflared` service（systemd）
- [ ] I6-2 反代/隧道参数化（只映射控制台端口；**不暴露 CDP 端口**）
- [ ] I6-3 限流 + 登录锁定 + 安全响应头（CSP/HSTS/X-Frame-Options）
- [ ] I6-4 备份/恢复脚本（`VACUUM INTO` + `data/` + `config.json`）
- [ ] I6-5 迁移与回滚手册（`docs/`）
- [ ] I6-6 更新 `README.md` / `docs/操作手册.md` 相关节
- [ ] I6-7 更新 `.trellis/spec/console/*` 与 `AGENT.md`（S11+ 看板、D11–D14、任务地图）
- [ ] I6-8 端到端回归：AC-1…AC-11 全量重跑
- [ ] I6-9 GATE 记录：新增 G6（控制台公网放行）/ G7（凭据加密与隧道放行）

**验证命令**
```bash
bunx tsc --noEmit && bun build --target=bun src/console/main.ts >/dev/null
bun src/cli.ts doctor --all && bun src/cli.ts publish --dry-run
systemctl status wechat-console cloudflared --no-pager
```

**验收映射**：AC-10, AC-11 + 全量回归

---

## 3. 风险文件与回滚点

| 文件/区域 | 风险 | 回滚 |
|---|---|---|
| `config.json`（回渲染） | 覆盖真实配置 | 每次回渲染前 `.bak`；AC-3 逐字段比对 |
| `src/config.ts`（加 `resolveConfig`） | 改动核心配置解析 | 只**新增**导出、不改旧签名；`bun src/cli.ts doctor --all` 复验 |
| `src/publisher.ts` / `wechat.ts` | 触碰发布链路 | **不改**；只通过参数/复用调用；G2 真机验收 |
| systemd timer 停用 | 停掉唯一自动入口 | 保留回退脚本；停用前先确认控制台调度已跑通 |
| `cloudflared` 子进程 | 地址抖动/邮件轰炸 | 变更去抖 + 失败重试上限 + 手工静默开关 |
| master key | 丢失 → 凭据不可解 | 首启生成后提示备份；支持 `key_version` 轮换 |

---

## 4. `task.py start` 前置检查（每个子任务启动前）

- [ ] 该子任务 `prd.md` 已写清目标/验收/依赖
- [ ] 该子任务 `design.md`（若复杂）与 `implement.md` 已就绪
- [ ] `implement.jsonl` / `check.jsonl` 已写入**真实** spec/research 条目（非 `_example` 占位）
  - 建议条目：`.trellis/spec/engine/{index,directory-structure,verification,error-handling}.md`、
    `.trellis/spec/console/*`（M0 新建）、`research.md`、`design.md`、pi 文档 `docs/rpc*.md`
- [ ] 上一个依赖子任务已验收并归档

---

## 5. 排期汇总（一句话）

**M0 规划（0.5d）→ C1 基座（3–4d）→ C2 调度 + C3 内容闭环（5–7d）→ C4 会话与人在环（4–5d）→
C5 运维与公网（3–4d）→ C6 加固与交付（2–3d）**，合计 **18–24 净工作日**；
按每天半天投入约 **5–7 周** 完成全部需求，其中 **M1 结束即可交付"能登录、能管账号、能改配置"的最小可用版**。
