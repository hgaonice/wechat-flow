#!/usr/bin/env bash
# =============================================================================
# C6 — back up the wechat-flow console (DB snapshot + data/config/master key).
#
#   bash deploy/console-backup.sh                 # write $OUT_DIR/console-<ts>.tgz
#   OUT_DIR=/mnt/backups KEEP=14 bash deploy/console-backup.sh
#
# The DB snapshot uses `VACUUM INTO` (consistent under WAL), verified with
# PRAGMA integrity_check before it is packaged. The archive contains:
#   console.db, data/, config.json, master.key, manifest.txt
# It is chmod 0600 because it contains the master key. Do NOT commit it.
# =============================================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/root/wechat-flow}"
OUT_DIR="${OUT_DIR:-$APP_DIR/backups}"
KEEP="${KEEP:-7}"
DB="${CONSOLE_DB:-$APP_DIR/console/console.db}"
KEY="${CONSOLE_MASTER_KEY_FILE:-$HOME/.wechat-console/master.key}"
BUN="${BUN:-$(command -v bun || echo /root/.nvm/versions/node/v24.14.1/bin/bun)}"

if [ ! -f "$DB" ]; then
  echo "数据库不存在: $DB" >&2
  exit 1
fi
if [ ! -x "$BUN" ] && ! command -v "$BUN" >/dev/null 2>&1; then
  echo "找不到 bun: $BUN" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
TS="$(date +%Y%m%d-%H%M%S)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> DB 快照（VACUUM INTO）"
CONSOLE_DB="$DB" "$BUN" "$APP_DIR/src/console/main.ts" --backup "$WORK/console.db"

if [ -d "$APP_DIR/data" ]; then
  echo "==> 打包 data/"
  cp -a "$APP_DIR/data" "$WORK/data"
  # 快照目录含 Cookies + Local State（登录凭证），与 design C-3/操作手册口径一致：不进备份包。
  rm -rf "$WORK"/data/*/session-snapshots 2>/dev/null || true
else
  echo "==> 无 data/，跳过"
fi

if [ -f "$APP_DIR/config.json" ]; then
  cp -a "$APP_DIR/config.json" "$WORK/config.json"
else
  echo "==> 无 config.json，跳过"
fi

if [ -f "$KEY" ]; then
  echo "==> 打包 master key（敏感）"
  install -m 0600 "$KEY" "$WORK/master.key"
else
  echo "==> 警告：未找到 master key ($KEY)，备份将无法解密既有凭据" >&2
fi

{
  echo "wechat-flow console backup"
  echo "time=$TS"
  echo "db=$DB"
  echo "app_dir=$APP_DIR"
  echo "files:"
  (cd "$WORK" && find . -type f | sed 's|^\./||' | sort)
} > "$WORK/manifest.txt"

ARCHIVE="$OUT_DIR/console-$TS.tgz"
tar czf "$ARCHIVE" -C "$WORK" .
chmod 0600 "$ARCHIVE"

echo "==> 保留最近 $KEEP 份"
# shellcheck disable=SC2012
ls -1t "$OUT_DIR"/console-*.tgz 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
  echo "    删除旧备份: $old"
  rm -f "$old"
done

echo "已备份: $ARCHIVE"
