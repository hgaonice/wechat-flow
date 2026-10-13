# wechat-flow-console · 公众号多账号 Web 管理控制台

> 父任务 PRD：只记录**需求、约束、验收标准、子任务映射**。
> 技术设计见 `design.md`，执行排期见 `implement.md`，调研见 `research.md`。
> 来源：用户 2026-10-13 需求（5 条）+ 追加确认（5 条）。

---

## Goal

在**不改动发布链路铁律**（AI 只做内容、草稿箱 DOM 为唯一真相源）的前提下，为现有 `wechat-flow`
引擎加一层**带鉴权的 Web 管理控制台**，让非命令行使用者能：

1. 自助管理多个公众号账号与各自的隔离任务/数据（含默认共享 + 单账号覆盖）；
2. 通过邮件拿到可公网访问的控制台地址与该账号的后台登录凭据；
3. 用网页控制每日/每周（≤7 天）/每月的内容计划，由 pi agent 规划并生成，产物推送到草稿箱；
4. 在**类 HAPI 的会话窗口**里与 agent 对话，对 agent 抛出的决策做人工确认，不满意可重新生成；
5. 由管理员总览并操作全部账号。

**用户价值**：把"只有作者本人会用的 CLI + systemd"升级为"可分发给多个公众号运营者自助使用、手机也能审批"的产品。

---

## Background / 现状锚点

- 现有引擎：`src/cli.ts` + 无状态库，TypeScript + bun，**运行时零第三方依赖**，systemd timer 触发。
- 多账号隔离已具备：`data/<alias>/` + 唯一 `cdpPort`（`src/config.ts`，见 `.trellis/spec/engine/directory-structure.md`）。
- pi 集成已具备：`src/pi.ts`（`--print --mode json` 事件流 + 重试/模型降级）。
- 发布链路已具备：`src/publisher.ts` → `src/wechat.ts` → `verifyDraftBody()` 唯一真相源。
- 现状缺口：**无服务端、无前端、无数据库、无鉴权、无人工审批入口、账号配置只能改 `config.json`**。

---

## Requirements

### R1 · 账号管理、隔离与配置覆盖

- R1.1 Web 界面支持公众号账号的**增 / 删 / 改 / 查**，以及**启用 / 禁用**。
- R1.2 每个账号有**独立的任务与数据**（沿用 `data/<alias>/` 与唯一 `cdpPort` 的既有隔离规则）。
- R1.3 存在**全局默认配置**，账号可**默认共享**；允许对任意配置项做**单账号覆盖**，未覆盖项回落全局。
- R1.4 覆盖关系必须**可见、可清除**（UI 上能看出"继承自全局"还是"已覆盖"，并能恢复继承）。
- R1.5 账号新增时必须校验隔离冲突（alias 唯一、`cdpPort` 唯一），冲突要**报错而非静默回退**。

### R2 · 邮箱、Cloudflare 隧道地址与凭据下发

- R2.1 每个公众号配置**自己的接收邮箱**（可多个）。
- R2.2 系统维护内网服务（192.168.0.250）经 **Cloudflare 映射**后的**公网访问地址**；地址**过期/变更时自动重新生成**。
- R2.3 下发的邮件内容包含：当前服务器信息、当前可用的 Cloudflare 映射地址、该微信账号对应的**后台登录账号与密码**。
- R2.4 存在**管理员角色**，可查看并操作当前服务下**所有账号**的配置信息。
- R2.5 手机可直开该地址完成操作（网关授权邮件式体验）。

### R3 · 内容计划、生成、会话与重生成

- R3.1 网页可控制**每天发送的文本内容**。
- R3.2 可预设**一周（≤ 7 天）**的计划，也可设置**一个月的发送摘要**。
- R3.3 计划交由 **pi agent 底座规划生成**（复用现有 `plan` / `publish` 能力）。
- R3.4 **每个任务窗口可对话**（类 HAPI）：agent 的中间过程与提问可见，能多轮追加指令。
- R3.5 agent 产生的**决策/结果交由用户操作**（人在环），控制台**不授予额外权限**（最小权限）。
- R3.6 生成结果推送到**用户草稿箱**；用户不满意可**重新生成**（可带反馈意见），保留版本历史。

### R4 · 存储与语言（已定）

- R4.1 数据存储使用 **SQLite**（理由见 `research.md` §DB 选型：事务型 CRUD、零依赖、单机部署）。
- R4.2 语言沿用 **TypeScript + bun**，服务端用 `Bun.serve`，避免跨语言重写发布链路。
- R4.3 **继续满足"运行时不新增 npm 依赖"**（用 bun 内置能力实现 HTTP/WS/SQLite/哈希）。

### R5 · 治理与排期

- R5.1 不引入 OpenDesign / 重设计系统；UI 以**可用的最小界面**为准。
- R5.2 通过 `AGENT.md` + `.trellis/`（tasks / spec / workspace）管理。
- R5.3 完成**调研 + 项目设计 + 开发任务排期**。
- R5.4 全部交付物都要排期（"全都要"）。

---

## 关键约束（不可违反）

| 约束 | 来源 |
|---|---|
| AI 只做内容，其余确定性；确定性层不得混入非确定性逻辑 | `.trellis/spec/engine/ai-determinism.md` |
| 唯一真相源 = 草稿箱真实 DOM（`verifyDraftBody`）；不接受上游自报成功 | `.trellis/spec/engine/verification.md` |
| 多账号共用 `dataDir`/`cdpPort` 会串号——禁止 | `.trellis/spec/engine/directory-structure.md` |
| 失败必须显形（`ok:false` + 告警），降级可接受、伪装成功不可接受 | `.trellis/spec/engine/error-handling.md` |
| 运行时零第三方 npm 依赖 | `.trellis/spec/engine/index.md` |
| 现有 CLI / systemd 在迁移期必须保持可用（向后兼容） | D4 / D7 |

---

## In Scope

- 控制台服务端（鉴权、账号 CRUD、配置继承与覆盖、任务/计划、会话、决策、运维、审计）。
- 控制台前端（无构建步骤的静态页面 + 原生 JS）。
- SQLite 数据层与从现有 `config.json` 的**一次性迁移**。
- Cloudflare 隧道管理器（地址生成 / 过期重生成 / 健康检查）+ 邮件下发。
- 凭据加密存储。
- 调度器接管/并行于 systemd timer。
- 部署与安全加固（systemd 服务、反代/隧道、备份）。
- 文档与 `.trellis` 治理更新（`AGENT.md` 看板、新增 `.trellis/spec/console/`）。

## Out of Scope

- 原生 iOS/Android App、语音、Telegram Mini App、E2E 加密中继（HAPI 的高级特性，明确不做）。
- 微信 API 发布（受 IP 白名单限制，既有决策 D1 不变）。
- 多租户 SaaS、计费、SSO/OIDC 联邦登录。
- 富文本 WYSIWYG 编辑器与设计系统。
- 替换 `pi`/`baoyu skill`/`email-sender skill` 等外部能力。

---

## Acceptance Criteria（跨子任务，端到端）

- **AC-1（账号与隔离）** 管理员可新建账号 A/B；二者 `dataDir` 与 `cdpPort` 互不相同；对 A 的任务不影响 B 的数据目录；重复 `cdpPort` 被拒绝并给出可用端口提示。
- **AC-2（配置覆盖）** 把全局 `math.enabled` 改为 `false`，账号 A 覆盖为 `true`：A 生效值为 `true`，B 为 `false`；清除 A 的覆盖后 A 回落到 `false`。UI 明确显示"继承/覆盖"状态。
- **AC-3（迁移无损）** 用现有 `config.json` 初始化后，DB 解析出的 `AppConfig` 与原 `loadConfig()` 结果**逐字段一致**（含 `paths.*`、`browser`、`model`、`notify`、`cover`）；`config.json` 回渲染后 diff 无非预期变化。
- **AC-4（鉴权与角色）** 普通用户仅能访问被授权的账号；管理员可见全部；未登录访问任何 API 返回 401；跨账号越权返回 403；越权尝试写入审计日志。
- **AC-5（计划与生成）** 在网页配置"下周 7 天"计划并触发生成：任务状态可见（queued→running→succeeded/failed），产出文章落 `data/<alias>/articles/`，且发布后 `drafts --date <日期>` 显示 `✅ 正文校验`。
- **AC-6（会话与人在环）** 会话窗口能实时看到 agent 流式输出；agent 抛出的决策以卡片呈现（选择/确认/输入），用户操作后 agent 继续；决策超时/取消有明确状态且不留悬挂。
- **AC-7（重生成）** 对已生成文章点"重新生成"并填写反馈：产生**新版本**，旧版本可查；新版本可再次推送草稿箱。
- **AC-8（隧道与邮件）** 隧道地址变更（重启/过期）后，系统在 1 分钟内更新为可用新地址，并向该账号邮箱与管理员发出含"服务器信息 + 新地址 + 该账号后台账密"的邮件；旧地址失效被标记。
- **AC-9（凭据安全）** DB 中凭据字段为密文；API 读取不回显明文；无 master key 时服务拒绝启动或拒绝解密并显式报错。
- **AC-10（零依赖与兼容）** `bunx tsc --noEmit` 与 `bun build` 零错误；`package.json` 无新增 runtime `dependencies`；迁移期 `bun src/cli.ts publish --dry-run` 仍可用。
- **AC-11（失败显形）** 任一子任务失败均写 `ok:false` + 原因 + 告警；控制台 UI 显示失败详情，不显示"成功"。

---

## 子任务地图（Parent → Children）

| 子任务 | 交付物 | 关键 AC | 依赖 |
|---|---|---|---|
| C1 `console-foundation` | 服务端骨架 + SQLite 数据层 + 鉴权/角色 + 账号 CRUD + 配置继承/覆盖 + `config.json` 迁移与回渲染 | AC-1,2,3,4,10 | — |
| C2 `console-scheduler` | 计划表（周≤7 / 月摘要）+ 任务/运行模型 + 调度器 + 每账号互斥 + 审计 | AC-5（调度侧） | C1 |
| C3 `console-content-workbench` | 计划编辑 UI → 触发 pi 生成 → 推送草稿箱 → 状态与产物查看 → 重生成/版本历史 | AC-5,7 | C1,C2 |
| C4 `console-agent-session` | pi RPC 长连接会话 + 流式 WebSocket/SSE + 决策卡片（人在环）+ 最小权限工具集 | AC-6 | C1（建议 C2 后） |
| C5 `console-ops-tunnel` | 邮箱配置 + Cloudflare 隧道管理（生成/续期/健康检查）+ 凭据加密 + 管理员全局视图 | AC-8,9 | C1 |
| C6 `console-deploy-hardening` | systemd 服务、反代/隧道、备份/恢复、限流与锁定、迁移与回滚手册、文档与 spec/AGENT 更新 | AC-10,11 | C1–C5 |

> 父任务本身不做实现；它拥有需求集、任务地图、跨子任务验收与最终集成验收。
> 依赖关系只写在子任务 `prd.md`/`implement.md` 中，父/子结构不是依赖系统。

---

## 风险与待确认（不阻塞排期，但需在动工前定稿）

| # | 风险/问题 | 现状建议 | 影响 |
|---|---|---|---|
| K1 | **公网暴露管理后台**（CF 隧道 + 存公众号账密）是本需求最高风险 | 强鉴权 + 限流锁定 + 审计 + 可选 Cloudflare Access 前置 + 隧道地址可轮换；账密 AES-256-GCM 加密，master key 走环境变量/本机 0600 文件 | 安全 |
| K2 | 自动填账密登录公众号可能触发风控 | 保留二维码邮件自愈为兜底（已有能力）；账密仅在有显式配置时使用 | 可用性 |
| ~~K3~~ | ~~隧道地址形态：quick vs named~~ | ✅ **已定（2026-10-13）**：无自有域名 → **CF Quick Tunnel**（`https://<随机>.trycloudflare.com`，重启即变）；地址变更/过期即重发邮件（"过期重新生"即此语义）。named tunnel 仅作为未来有域名时的升级项 | 体验 |
| K4 | systemd timer 与 DB 调度并存期双触发 | 迁移期 timer 停用或指向 DB 调度；先并行观察再摘除 | 重复发布 |
| K5 | 现有 spec 只有 `engine` 层 | 新增 `.trellis/spec/console/` 层并更新 `AGENT.md` | 治理 |

*（原 Open Questions 已由用户 2026-10-13 答复：建父子任务 / 内网+CF 公网可达 / 账密入库 / 参考 tiann/hapi / 全部排期。）*
*（K3 已于 2026-10-13 定稿：无自有域名 → CF Quick Tunnel。K1 安全方案按 design.md §7 推荐执行，如无异议即生效。）*
