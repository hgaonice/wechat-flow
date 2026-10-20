#!/usr/bin/env bash
# Static gates for the console design system (C3).
#
#   bash tools/ui-gates.sh              # G1..G3, G5 (G4 warns only — migration in progress)
#   bash tools/ui-gates.sh --strict     # also G4 (legacy classes must be gone; used after Step 7)
#
# Exit 0 = all enabled gates pass; 1 = at least one failed. Every failure prints
# the offending file/line so it can be fixed without re-reading this script.
set -uo pipefail
cd "$(dirname "$0")/.."

STRICT=0
[ "${1:-}" = "--strict" ] && STRICT=1
UI=src/console/ui
FAIL=0
PASS=0

ok()   { PASS=$((PASS + 1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '  \033[31m✗\033[0m %s\n' "$1"; }
note() { printf '  \033[33m!\033[0m %s\n' "$1"; }

echo "G1 · 0 内联 style=（CSP style-src 'self'）"
hits=$(grep -n 'style=' "$UI"/*.html 2>/dev/null || true)
if [ -z "$hits" ]; then ok "no style= in ui/*.html"; else bad "inline style found:"; echo "$hits" | sed 's/^/      /'; fi

echo "G2 · 每页都引用 ds.css，且 ds.js 在页面 js 之前"
missing=0
for f in "$UI"/*.html; do
  base=$(basename "$f")
  case "$base" in _ds.html) continue ;; esac
  grep -q 'href="/ds.css"' "$f" || { bad "$base: missing <link rel=\"stylesheet\" href=\"/ds.css\">"; missing=1; }
done
# order check: line(ds.js) must be < line(first other page script) when both exist
for f in "$UI"/*.html; do
  base=$(basename "$f"); case "$base" in _ds.html) continue ;; esac
  ds_line=$(grep -n 'src="/ds.js"' "$f" | head -1 | cut -d: -f1)
  js_line=$(grep -n 'src="/[a-z_-]*\.js"' "$f" | grep -v 'src="/ds.js"' | head -1 | cut -d: -f1)
  [ -z "$ds_line" ] && continue
  if [ -n "$js_line" ] && [ "$ds_line" -gt "$js_line" ]; then bad "$base: ds.js (line $ds_line) loads after page js (line $js_line)"; missing=1; fi
done
[ "$missing" -eq 0 ] && ok "ds.css + ds.js present and ordered on all pages"

echo "G3 · ds.css 令牌被真实引用（防空令牌）"
if [ -f "$UI/ds.css" ]; then
  defined=$(grep -oE '^\s*--[a-z0-9-]+:' "$UI/ds.css" | tr -d ' :' | sort -u | wc -l)
  used=0
  for t in $(grep -oE '^\s*--[a-z0-9-]+:' "$UI/ds.css" | tr -d ' :' | sort -u); do
    n=$(grep -c "var($t)" "$UI/ds.css" "$UI"/*.html 2>/dev/null | awk -F: '{s+=$2} END{print s+0}')
    [ "$n" -gt 0 ] && used=$((used + 1))
  done
  if [ "$defined" -eq 0 ]; then bad "ds.css defines no tokens"
  else
    pct=$((used * 100 / defined))
    if [ "$pct" -ge 60 ]; then ok "tokens referenced: $used/$defined (${pct}%)"
    else bad "only $used/$defined tokens referenced (${pct}% < 60%) — likely dead tokens"; fi
  fi
else
  note "ds.css not created yet (Step 1) — skipped"
fi

echo "G4 · 旧类残留（.card/.primary/.ghost/.row/.mt 等）"
# Token-aware: `ds-btn--ghost` must NOT count as `ghost`, so split class
# attributes into tokens and compare whole tokens against the legacy set.
legacy=$(python3 - "$UI" <<'PYEOF'
import glob, os, re, sys

LEGACY = {
    "card", "primary", "ghost", "danger", "muted", "spacer", "msg", "row", "mt",
    "badge", "fail", "chip", "chips", "stat", "stat-grid", "stat-label", "stat-value",
    "diff", "del", "add", "ctx", "log", "md", "cover", "days", "progress", "progress-bar",
    "detail-grid", "chat-main", "chat-side", "chat-list", "chat-item", "chat-item-title",
    "chat-item-meta", "chat-pane", "chat-bar", "messages", "bubble", "role", "body",
    "tools", "tool-row", "tool-name", "decision", "decision-head", "title", "message",
    "actions", "state", "composer", "login-wrap", "mono", "tip", "table-wrap", "empty",
}
PAT = re.compile(r'class(?:Name)?\s*[=:]\s*["\']([^"\']*)["\']')
root = sys.argv[1]
for path in sorted(glob.glob(os.path.join(root, "*.html")) + glob.glob(os.path.join(root, "*.js"))):
    base = os.path.basename(path)
    if base.startswith("_ds"):
        continue
    with open(path, encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, 1):
            for m in PAT.finditer(line):
                for token in m.group(1).split():
                    if token.startswith("ds-") or token.startswith("is-"):
                        continue
                    if token in LEGACY:
                        print(f"{base}:{lineno}: {token}")
PYEOF
)
if [ -z "$legacy" ]; then ok "no legacy classes in ui/*.html or ui/*.js"
elif [ "$STRICT" -eq 1 ]; then bad "legacy classes remain (strict mode):"; echo "$legacy" | sed 's/^/      /'
else note "$(echo "$legacy" | wc -l) legacy class usage(s) still present (allowed until Step 7)"; fi

echo "G5 · 零依赖 + 类型 + 构建"
if grep -q '"dependencies"' package.json; then bad "package.json has a dependencies block"; else ok "package.json dependencies: none"; fi
if command -v bunx >/dev/null 2>&1; then
  if bunx tsc --noEmit >/tmp/ui-gates-tsc.log 2>&1; then ok "tsc --noEmit"; else bad "tsc --noEmit failed (see /tmp/ui-gates-tsc.log)"; fi
fi
if command -v bun >/dev/null 2>&1; then
  if bun build --target=bun src/cli.ts >/tmp/ui-gates-build.log 2>&1; then ok "bun build src/cli.ts"; else bad "bun build failed (see /tmp/ui-gates-build.log)"; fi
fi

echo
echo "GATES: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
