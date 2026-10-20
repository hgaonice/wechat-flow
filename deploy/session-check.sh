#!/usr/bin/env bash
#
# 会话/浏览器自检（C1 Step 5；AC4「部署不打扰」的验收口径）
#
# 在目标机（250）上运行，也可被 deploy.sh 在部署后自动调用：
#   ssh root@192.168.0.250 'cd /root/wechat-flow && bash deploy/session-check.sh'
#
# 检查三件事，全部只读：
#   ① Xvfb 托管（external 模式下必须有）
#   ② 每个 alias 的浏览器 unit 真的在跑，且 MainPID 就是 chrome（不是"unit 活着但
#      Chrome 没人管"——那通常是迁移顺序错了：裸 Chrome 还占着 CDP 端口）
#   ③ `session probe` 逐账号判定，**只有 invalid 算失败**（unknown = 证据不足，不算）
#
# 退出码：0 = 全绿；1 = 至少一项硬失败（具体证据在输出里）。
#
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

fail=0
ok() { echo "  ✅ $*"; }
bad() {
  echo "  ❌ $*"
  fail=1
}
note() { echo "  ·  $*"; }

# ---- bun 解析 ---------------------------------------------------------------
# 250 上 bun 由 nvm 安装，**非登录 ssh 的 PATH 里没有**（2026-10-20 实测：本脚本
# 直接调 `bun` 会 "command not found"，导致部署自检整体失效）。解析顺序与 unit 的
# ExecStart 保持一致，避免"自检用的 bun"与"服务用的 bun"不是同一个。
BUN="${WFC_BUN_PATH:-}"
if [ -z "$BUN" ] || [ ! -x "$BUN" ]; then
  BUN="$(command -v bun 2>/dev/null || true)"
fi
if [ -z "$BUN" ] || [ ! -x "$BUN" ]; then
  for c in /root/.nvm/versions/node/*/bin/bun /root/.bun/bin/bun /usr/local/bin/bun; do
    if [ -x "$c" ]; then
      BUN="$c"
      break
    fi
  done
fi
if [ -z "$BUN" ] || [ ! -x "$BUN" ]; then
  bad "找不到可执行的 bun（可用 WFC_BUN_PATH=/path/to/bun 指定）"
  exit 1
fi
note "bun: $BUN"

# ---- 0. 托管方式（与 src/browser.ts#describeBrowserMode 同一套规则） ----------
mode="${WFC_BROWSER_MODE:-}"
source="WFC_BROWSER_MODE"
if [ -z "$mode" ]; then
  source="自动"
  if systemctl cat wechat-browser@.service >/dev/null 2>&1; then
    mode=external
  else
    mode=inline
  fi
fi
echo "· 浏览器托管方式：$mode（$source）"

aliases="$("$BUN" -e 'const m = await import("./src/config.ts"); console.log(m.listAccounts().filter((a) => a.enabled).map((a) => a.alias).join(" "));' 2>/dev/null | tail -1)"
if [ -z "$aliases" ]; then
  bad "读不到启用账号列表（bun src/config.ts listAccounts 失败）—— 先修 config.json"
  echo
  echo "✖ 自检中断"
  exit 1
fi
note "启用账号：$aliases"

# ---- 1/2. 浏览器托管（仅 external；inline 是回滚态，没有 unit 可查） ----------
if [ "$mode" = "external" ]; then
  if systemctl is-active --quiet wechat-xvfb.service; then
    ok "wechat-xvfb.service active"
  elif pgrep -x Xvfb >/dev/null 2>&1; then
    # 迁移还没做：裸 Xvfb 仍在跑，unit 只是装了没接管。
    note "wechat-xvfb.service 未接管（裸 Xvfb :99 仍在跑）—— 迁移未完成，按 docs/操作手册.md §2.5b 执行"
  else
    bad "wechat-xvfb.service 未 active 且没有裸 Xvfb —— 显示没了（systemctl status wechat-xvfb.service --no-pager）"
  fi
  for a in $aliases; do
    unit="wechat-browser@${a}.service"
    if ! systemctl is-active --quiet "$unit"; then
      # 「装了 unit 但从没 enable」= 迁移没做（黄）；「enable 了却不在跑」= 真回退（红），
      # 这样迁移窗口里的中间态不会把无关部署判成失败，而迁移后的掉线一定会被抓到。
      if [ "$(systemctl is-enabled "$unit" 2>/dev/null || true)" = "disabled" ]; then
        note "$unit 已安装但未 enable —— 迁移未完成，按 docs/操作手册.md §2.5b 执行"
      else
        bad "$unit 未 active —— systemctl status $unit --no-pager / journalctl -u $unit -n 50 --no-pager"
      fi
      continue
    fi
    pid="$(systemctl show "$unit" -p MainPID --value 2>/dev/null)"
    if [ -z "$pid" ] || [ "$pid" = "0" ]; then
      bad "$unit 是 active 但 MainPID=0（无主进程）"
      continue
    fi
    cmd="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)"
    case "$cmd" in
      *chrome*)
        ok "$unit active · MainPID=$pid（chrome）"
        ;;
      *)
        bad "$unit 的 MainPID=$pid 不是 chrome：${cmd:-<读不到 /proc/$pid/cmdline>} —— 这条路径意味着 Chrome 没被 unit 托管（迁移顺序：先停裸 Chrome 再 enable --now）"
        ;;
    esac
  done
else
  note "inline 模式：跳过 unit 检查（回滚态，由 console 自己 spawn Chrome）"
fi

# ---- 3. 会话三态（每账号一次；只有 invalid 失败） ----------------------------
for a in $aliases; do
  # --no-persist：部署自检绝不推高 consecutiveFailures（否则部署本身会把会话
  # 推向扫码阈值）。
  out="$("$BUN" src/cli.ts session probe -a "$a" --no-persist --json 2>&1)"
  rc=$?
  if [ $rc -ne 0 ]; then
    bad "$a: session probe 失败（exit $rc）：$(printf '%s' "$out" | tail -3 | tr '\n' ' ')"
    continue
  fi
  if printf '%s' "$out" | grep -q "API 方式"; then
    note "$a: publishMethod=api，无浏览器会话，跳过"
    continue
  fi
  verdict="$(printf '%s' "$out" | sed -n 's/.*"verdict": *"\([a-z]*\)".*/\1/p' | head -1)"
  ev="$(printf '%s' "$out" | sed -n 's/.*"evidence": *"\(.*\)",\{0,1\}$/\1/p' | head -1)"
  case "$verdict" in
    valid) ok "$a: verdict=valid · evidence=$ev" ;;
    unknown) note "$a: verdict=unknown（证据不足，不算失败）· evidence=$ev" ;;
    invalid)
      bad "$a: verdict=invalid —— 会话已确认失效（证据：$ev）。处理：bun src/cli.ts login -a $a --qr --wait 900"
      ;;
    *)
      bad "$a: 无法解析 verdict（输出：$(printf '%s' "$out" | head -3 | tr '\n' ' ')）"
      ;;
  esac
done

# ---- 附：console 状态（信息性，不算失败） ------------------------------------
if systemctl is-active --quiet wechat-console.service; then
  note "wechat-console.service active"
else
  note "wechat-console.service 非 active —— 引擎改动后需要 systemctl restart wechat-console 才生效"
fi

echo
if [ $fail -eq 0 ]; then
  echo "✓ 会话自检全绿"
  exit 0
fi
echo "✖ 会话自检有失败项（见上方 ❌ 行，每行都带具体证据）"
exit 1
