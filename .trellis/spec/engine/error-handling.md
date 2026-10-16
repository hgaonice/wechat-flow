# Error Handling & Degradation

> 无人值守系统：**失败必须显形、可重跑、可降级**。目标是“今天这篇文章尽量发出去”，
> 而不是“一有错就崩”。但降级绝不能把失败伪装成成功。

---

## 三类错误与处理方式

| 类别 | 例子 | 处理 |
|---|---|---|
| **上游模型失败** | `503 all nodes exhausted` / `402 quota` | 同模型重试 → 依次 `fallbacks` 降级（`src/pi.ts`） |
| **可选增强失败** | 公式转换 / manim 渲染 / 封面字体缺失 | **不阻断发布**，保留原文，日志 + 邮件提示（`src/media.ts`） |
| **发布真实性失败** | 草稿箱查不到 / 正文为空 | **判失败**：写 `ok:false`、发失败邮件、非零退出，**绝不静默** |

---

## pi 的特殊约定（必须遵守）

pi 在**上游失败时仍以 exit 0 退出**（错误只在事件流里）。所以 `src/pi.ts`：

1. 监听 assistant 事件的 `stopReason` / `errorMessage`；
2. 把它当作失败，对同模型重试（`retries`，默认 1 次，间隔 30s）；
3. 仍失败则依次尝试 `model.*.fallbacks`。

> **不要用 `exit code` 判断 pi 成功与否。** 必须读事件流。

---

## 通用规则

- **子进程**：统一 `spawnSync` / `spawn`，捕获 stdout/stderr 与退出码；不吞异常。
- **超时**：所有网络/浏览器动作都要有超时（`config.timeoutSec`、CDP 超时参数）。
- **幂等**：发布成功后写 `state/published.json`；重复运行自动跳过；`--force` 才重发。
- **原子写**：状态/JSON 落盘用 `atomicWriteJson`（临时文件 + rename），避免半截文件。
- **降级要有痕迹**：降级成功也要在日志/邮件里写清“用了哪个 fallback / 跳过了哪步”。
- **退出码**：命令行失败返回非零；但单个账号失败不应阻止 `--all` 中其他账号继续（各自隔离）。

---

## 已知真机故障模式（实测+处置）

### E1 · 浏览器发布报 `New tab not found: mp.weixin.qq.com`

- **现象**：`publish`（browser 方式）在 skill 的 `waitForNewTab()` 超时 30s 后失败：
  `browser publish failed (exit 1, saved=false, waiting=false, emptyBody=false) Error: New tab not found: mp.weixin.qq.com`；
  草稿箱正文保持旧版（未更新）。
- **根因（2026-10-16 实测）**：该 Chrome 实例里积了**重复的 `https://mp.weixin.qq.com/` 桩 tab**（跳转中/未完成页）与 `about:blank`；
  skill 点击「新建图文」后新编辑器 tab 的建立/认定被这些 tab 干扰（`waitForNewTab` 只认“初始集合之外的新 page”）。
- **处置（已验证有效，两账号各复现一次后均修复）**：只关掉**重复桩 tab**，保留带 `token=` 的已登录 home tab，然后重跑 `publish --force --reuse`：
  ```bash
  for id in $(curl -s http://127.0.0.1:<cdpPort>/json/list | python3 -c "import json,sys
  [print(x['id']) for x in json.load(sys.stdin) if x.get('type')=='page' and x.get('url') in ('https://mp.weixin.qq.com/','about:blank')]"); do
    curl -s http://127.0.0.1:<cdpPort>/json/close/$id >/dev/null
  done
  ```
- **不要**关掉带 `token=` 的 home tab（那会丢失登录上下文）；也不要盲目重启 Chrome（会引出扫码）。
- **待办（未做，需单独评审）**：`cleanupAppmsgTabs()` 目前只清理 `/cgi-bin/appmsg` tab；可考虑扩展为「保留带 token 的 home tab，关掉其余重复/桩页」——属发布链路改动，必须走 G2 真机门后再合入。

---

## 检查清单

- [ ] 新加的失败路径：会不会静默？有没有日志？有没有邮件/退出码？
- [ ] 新加的“可选增强”：坏了会不会误伤主流程？
- [ ] 新加的降级：成功后能否从日志看出“曾降级”？
- [ ] 重跑是否安全（幂等）？`--force` 是否只影响目标日期？
