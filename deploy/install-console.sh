#!/usr/bin/env bash
# =============================================================================
# C6 — install the wechat-flow console as a systemd service (Mode A).
# Run on the target host (192.168.0.250) as root, from the repo root.
#
#   bash deploy/install-console.sh              # install + enable --now
#   bash deploy/install-console.sh --no-start   # install only
#   bash deploy/install-console.sh --mode-b     # ALSO install cloudflared.service
#
# Mode A (default) = the console supervises cloudflared in-process
# (CONSOLE_TUNNEL=1). Mode B (`--mode-b`) is mutually exclusive and disables the
# console's tunnel status/notify — see deploy/systemd/cloudflared.service.
# =============================================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/root/wechat-flow}"
UNIT_DIR="${UNIT_DIR:-/etc/systemd/system}"
ENV_FILE="${ENV_FILE:-/etc/default/wechat-console}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_SRC="$HERE/systemd"

START=1
MODE_B=0
for arg in "$@"; do
  case "$arg" in
    --no-start) START=0 ;;
    --mode-b) MODE_B=1 ;;
    -h | --help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "未知参数: $arg" >&2
      exit 2
      ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "请以 root 运行（systemd 单元安装）" >&2
  exit 1
fi

echo "==> 安装 unit 到 $UNIT_DIR"
install -m 0644 "$UNIT_SRC/wechat-console.service" "$UNIT_DIR/wechat-console.service"

if [ "$MODE_B" -eq 1 ]; then
  echo "==> [Mode B] 同时安装 cloudflared.service（务必在 $ENV_FILE 设 CONSOLE_TUNNEL=0）"
  install -m 0644 "$UNIT_SRC/cloudflared.service" "$UNIT_DIR/cloudflared.service"
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "==> 生成 $ENV_FILE（模板）"
  install -m 0600 "$UNIT_SRC/wechat-console.env.example" "$ENV_FILE"
  echo "    请按需编辑（尤其 CONSOLE_PORT / CONSOLE_TUNNEL）"
else
  echo "==> 保留既有 $ENV_FILE"
fi

echo "==> 停用旧 systemd timer（控制台调度接管；unit 保留可回退）"
if [ -x "$HERE/systemd/disable-timer.sh" ]; then
  bash "$HERE/systemd/disable-timer.sh" || true
fi

echo "==> systemd daemon-reload"
systemctl daemon-reload

if [ "$START" -eq 1 ]; then
  echo "==> 启用并启动 wechat-console.service"
  systemctl enable --now wechat-console.service
  if [ "$MODE_B" -eq 1 ]; then
    systemctl enable --now cloudflared.service
  fi
fi

echo "==> 状态"
systemctl --no-pager --full status wechat-console.service || true
echo
echo "回退：systemctl disable --now wechat-console.service && bash deploy/systemd/enable-timer.sh"
