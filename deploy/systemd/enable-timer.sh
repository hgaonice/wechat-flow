#!/usr/bin/env bash
# =============================================================================
# C2 回退脚本：重新启用原有 systemd timer
# -----------------------------------------------------------------------------
# disable-timer.sh 的逆操作。幂等：重复执行安全。
# 用于「控制台调度不可用」时立即恢复自动发布入口。
#
# 用法：
#   bash deploy/systemd/enable-timer.sh            # 启用
#   bash deploy/systemd/enable-timer.sh --dry-run  # 只看会执行什么
# =============================================================================
set -euo pipefail

TIMERS=(wechat-plan.timer wechat-publish.timer)
DRY=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *)
      echo "未知参数: $arg" >&2
      exit 2
      ;;
  esac
done

run() {
  if [ "$DRY" -eq 1 ]; then
    printf '+ %s\n' "$*"
  else
    "$@"
  fi
}

if ! command -v systemctl >/dev/null 2>&1; then
  echo "✖ 未找到 systemctl：本脚本只能在带 systemd 的部署机上运行" >&2
  exit 1
fi

echo "==> 重新启用 wechat-flow timer（回退到 timer 触发）"
for t in "${TIMERS[@]}"; do
  if systemctl list-unit-files "$t" >/dev/null 2>&1; then
    run systemctl enable --now "$t"
  else
    echo "    (跳过：未安装 $t)"
  fi
done

echo
run systemctl list-timers 'wechat-*' --no-pager
echo
echo "✅ 完成：timer 已恢复。若同时运行控制台调度，请停用控制台 worker，避免双重触发："
echo "    systemctl stop wechat-console.service   # 或 bun src/console/main.ts --no-worker 重启"
