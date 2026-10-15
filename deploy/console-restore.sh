#!/usr/bin/env bash
# =============================================================================
# C6 — restore a wechat-flow console backup produced by console-backup.sh.
#
#   bash deploy/console-restore.sh /root/wechat-flow/backups/console-<ts>.tgz
#   bash deploy/console-restore.sh <tgz> --force     # override the "service must
#                                                      be stopped" guard
#
# Safety (I31): refuses while wechat-console.service is running (unless --force),
# pre-flight checks the extracted DB with `--restore-check`, and snapshots the
# CURRENT state first so a botched restore can be undone.
# =============================================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/root/wechat-flow}"
DB="${CONSOLE_DB:-$APP_DIR/console/console.db}"
KEY="${CONSOLE_MASTER_KEY_FILE:-$HOME/.wechat-console/master.key}"
SERVICE="${SERVICE:-wechat-console.service}"
BUN="${BUN:-$(command -v bun || echo /root/.nvm/versions/node/v24.14.1/bin/bun)}"

ARCHIVE=""
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -h | --help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*)
      echo "未知参数: $arg" >&2
      exit 2
      ;;
    *) ARCHIVE="$arg" ;;
  esac
done

if [ -z "$ARCHIVE" ] || [ ! -f "$ARCHIVE" ]; then
  echo "用法: bash deploy/console-restore.sh <backup.tgz> [--force]" >&2
  exit 2
fi

SERVICE_WAS_ACTIVE=0
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "$SERVICE"; then
  if [ "$FORCE" -ne 1 ]; then
    echo "服务 $SERVICE 正在运行；请先 'systemctl stop $SERVICE'（或加 --force）" >&2
    exit 1
  fi
  # --force 必须真的停掉服务再替换：进程持有旧 DB 句柄时热替换文件
  # 会导致 WAL 不一致（实测 database disk image is malformed，2026-10-15 验收）。
  echo "==> 停止 $SERVICE（--force 自动停启）"
  systemctl stop "$SERVICE"
  SERVICE_WAS_ACTIVE=1
fi
restore_service() {
  if [ "$SERVICE_WAS_ACTIVE" = "1" ] && command -v systemctl >/dev/null 2>&1; then
    systemctl start "$SERVICE"
  fi
}
trap 'restore_service; rm -rf "${WORK:-/dev/null}"' EXIT

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> 解包 $ARCHIVE"
tar xzf "$ARCHIVE" -C "$WORK"

if [ ! -f "$WORK/console.db" ]; then
  echo "备份缺少 console.db" >&2
  exit 1
fi

echo "==> 预检（--restore-check）"
"$BUN" "$APP_DIR/src/console/main.ts" --restore-check "$WORK/console.db"

TS="$(date +%Y%m%d-%H%M%S)"
echo "==> 备份现状（回滚保险）"
if [ -f "$DB" ]; then
  CONSOLE_DB="$DB" "$BUN" "$APP_DIR/src/console/main.ts" --backup "$DB.pre-restore-$TS" >/dev/null
  echo "    $DB -> $DB.pre-restore-$TS"
fi

echo "==> 替换 DB"
mkdir -p "$(dirname "$DB")"
install -m 0644 "$WORK/console.db" "$DB"

if [ -d "$WORK/data" ]; then
  echo "==> 替换 data/"
  rm -rf "$APP_DIR/data"
  cp -a "$WORK/data" "$APP_DIR/data"
fi

if [ -f "$WORK/config.json" ]; then
  echo "==> 替换 config.json"
  [ -f "$APP_DIR/config.json" ] && cp -a "$APP_DIR/config.json" "$APP_DIR/config.json.pre-restore-$TS"
  install -m 0644 "$WORK/config.json" "$APP_DIR/config.json"
fi

if [ -f "$WORK/master.key" ]; then
  echo "==> 替换 master key（0600）"
  mkdir -p "$(dirname "$KEY")"
  [ -f "$KEY" ] && cp -a "$KEY" "$KEY.pre-restore-$TS"
  install -m 0600 "$WORK/master.key" "$KEY"
fi

echo
if [ "$SERVICE_WAS_ACTIVE" = "1" ]; then
  echo "==> 重新启动 $SERVICE"
  restore_service
  echo "恢复完成，服务已重启。"
else
  echo "恢复完成。启动：systemctl start $SERVICE"
fi
echo "如 DB 路径为默认值，请确认 $DB 与 .env / $SERVICE 中的 CONSOLE_DB 一致。"
