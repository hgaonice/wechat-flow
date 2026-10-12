#!/usr/bin/env bash
# Install/refresh the wechat-flow systemd timers.
# Run on the target host (192.168.0.250) as root.
set -euo pipefail

APP_DIR="${APP_DIR:-/root/wechat-flow}"
UNIT_DIR="/etc/systemd/system"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Installing units from $HERE to $UNIT_DIR"
for u in wechat-plan.service wechat-plan.timer wechat-publish.service wechat-publish.timer; do
  install -m 0644 "$HERE/$u" "$UNIT_DIR/$u"
done

if [ ! -f "$APP_DIR/config.json" ]; then
  echo "==> Creating $APP_DIR/config.json from example"
  install -m 0600 "$APP_DIR/config.example.json" "$APP_DIR/config.json"
fi

echo "==> Patching baoyu-post-to-wechat (browser publish writes an EMPTY body without it)"
"$HERE/patch-baoyu-skill.sh" "${SKILL_DIR:-/root/.agents/skills/baoyu-post-to-wechat}"

echo "==> systemd daemon-reload"
systemctl daemon-reload

echo "==> Enabling timers"
systemctl enable --now wechat-plan.timer wechat-publish.timer

echo "==> Status"
systemctl list-timers 'wechat-*' --no-pager || true
echo
echo "Manual run:  systemctl start wechat-plan.service"
echo "Logs:        journalctl -u wechat-publish.service -n 100 --no-pager"
