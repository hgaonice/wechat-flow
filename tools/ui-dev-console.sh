#!/usr/bin/env bash
# Dev-only console harness for UI work (C3). Boots an ISOLATED console instance:
#   - its own master key dir + SQLite DB under /tmp/wfc-dev
#   - 2 fake accounts (no secrets, no real WeChat data) so tables/lists look real
#   - loopback port 8799 by default
#
# Never touches ~/.wechat-console, console/console.db, or any data/<alias>/.
#
#   bash tools/ui-dev-console.sh start     # boot in background, print PID/URL
#   bash tools/ui-dev-console.sh stop
#   bash tools/ui-dev-console.sh reset     # stop + wipe /tmp/wfc-dev
set -uo pipefail
cd "$(dirname "$0")/.."

DEV_ROOT="${WFC_DEV_ROOT:-/tmp/wfc-dev}"
HOME_DIR="$DEV_ROOT/home"
DB="$DEV_ROOT/console.db"
LOG="$DEV_ROOT/console.log"
PIDFILE="$DEV_ROOT/console.pid"
PORT="${WFC_DEV_PORT:-8799}"
USER_NAME="${WFC_DEV_USER:-admin}"
PASSWORD="${WFC_DEV_PASSWORD:-dev-pass-123456}"
BUN="${WFC_BUN_PATH:-bun}"

stop() {
  if [ -f "$PIDFILE" ]; then
    pid=$(cat "$PIDFILE")
    kill "$pid" 2>/dev/null || true
    sleep 0.4
    kill -9 "$pid" 2>/dev/null || true
    rm -f "$PIDFILE"
    echo "stopped (pid $pid)"
  else
    echo "not running"
  fi
}

reset() {
  stop
  rm -rf "$DEV_ROOT"
  echo "wiped $DEV_ROOT"
}

seed() {
  # Fake accounts: enabled=1, distinct cdp ports, mixed publish methods.
  "$BUN" -e '
import { Database } from "bun:sqlite";
const db = new Database(process.env.DB);
const rows = [
  ["second", "巧思初数", 9223, "browser", 1],
  ["gaoh", "每天讲点理", 9222, "browser", 1],
];
for (const [alias, name, port, pm, en] of rows) {
  db.run(
    `INSERT INTO accounts (alias, display_name, cdp_port, publish_method, enabled)
     VALUES (?,?,?,?,?) ON CONFLICT(alias) DO UPDATE SET display_name=excluded.display_name`,
    [alias, name, port, pm, en],
  );
}
console.log("seeded accounts:", db.query("SELECT count(*) c FROM accounts").get().c);
db.close();
'
}

start() {
  mkdir -p "$DEV_ROOT" "$HOME_DIR"
  export HOME="$HOME_DIR"
  export DB

  if [ ! -f "$HOME_DIR/.wechat-console/master.key" ]; then
    "$BUN" src/console/main.ts --init-key >/dev/null 2>&1 || { echo "init-key failed"; exit 1; }
  fi
  CONSOLE_DB="$DB" "$BUN" src/console/main.ts --create-admin "$USER_NAME" --password "$PASSWORD" >/dev/null 2>&1 || true
  # migrate happens in any subcommand; seed after the DB exists
  CONSOLE_DB="$DB" "$BUN" src/console/main.ts --status >/dev/null 2>&1 || { echo "db init failed"; exit 1; }
  seed

  HOME="$HOME_DIR" CONSOLE_DB="$DB" CONSOLE_PORT="$PORT" WFC_DS_PREVIEW="${WFC_DS_PREVIEW:-1}" \
    nohup "$BUN" src/console/main.ts >"$LOG" 2>&1 &
  echo $! >"$PIDFILE"

  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
      echo "up http://127.0.0.1:$PORT  user=$USER_NAME  pid=$(cat "$PIDFILE")  db=$DB"
      return 0
    fi
    sleep 0.25
  done
  echo "failed to start; tail $LOG:"; tail -20 "$LOG"; exit 1
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  reset) reset ;;
  log) tail -n "${2:-40}" "$LOG" ;;
  *) echo "usage: $0 {start|stop|reset|log [n]}"; exit 1 ;;
esac
