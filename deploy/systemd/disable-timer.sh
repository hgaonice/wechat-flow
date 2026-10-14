#!/usr/bin/env bash
# =============================================================================
# C2 迁移期：停用原有 systemd timer（控制台调度接管触发点）
# -----------------------------------------------------------------------------
# 幂等：只 `disable --now` 既有 unit，**不删除** unit 文件 → 可随时用
#       `enable-timer.sh` 回退。重复执行安全。
#
# 用法：
#   bash deploy/systemd/disable-timer.sh            # 停用
#   bash deploy/systemd/disable-timer.sh --dry-run  # 只看会执行什么
#
# 注意：在开发机上跑 `--dry-run` 即可；真正的停用发生在部署环境（C6 收口）。
# =============================================================================
set -euo pipefail

TIMERS=(wechat-plan.timer wechat-publish.timer)
DRY=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    -h|--help)
      sed -n '2,14p' "$0"
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

echo "==> 停用并禁用 wechat-flow timer（保留 unit 文件，可用 enable-timer.sh 回退）"
for t in "${TIMERS[@]}"; do
  if systemctl list-unit-files "$t" >/dev/null 2>&1; then
    run systemctl disable --now "$t"
  else
    echo "    (跳过：未安装 $t)"
  fi
done

echo
run systemctl list-timers 'wechat-*' --no-pager
echo
echo "✅ 完成。控制台调度接管后，确认控制台正在跑（bash deploy/console-scheduler.md 见验证步骤）。"
echo "   回退：  bash deploy/systemd/enable-timer.sh"
