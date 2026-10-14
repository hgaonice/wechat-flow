#!/usr/bin/env bash
# repomap.sh —— 生成/刷新 TREE.md（文件 + 符号索引，Aider repomap 的轻量等价物）
#
# 目的：让 AI 在规划时先读 TREE.md（几 KB），而不是 ls 全盘 / 整读源码。
# 只输出「结构 + 导出符号 + 一句话职责」，不输出实现，Token 占用极小。
#
# 用法：
#   bash tools/repomap.sh            # 生成 TREE.md
#   bash tools/repomap.sh --check    # 只在有差异时退出码 1（用于 CI/自检）
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="TREE.md"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

{
  echo "# TREE.md · 文件与符号索引（自动生成，勿手改）"
  echo
  echo "> 生成命令：\`bash tools/repomap.sh\`　更新时间：$(date '+%Y-%m-%d %H:%M:%S')"
  echo "> 用途：规划时先读本文件替代 \`ls\` 与整读源码；改动代码后请重跑本脚本。"
  echo "> 相关：[ARCHITECTURE.md](./ARCHITECTURE.md) · [src/README.md](./src/README.md) · [AGENT.md](./AGENT.md)"
  echo
  echo '```text'
  echo "wechat-flow/"
  # 顶层目录树（排除运行时/缓存）
  find . -maxdepth 2 -mindepth 1 \
    \( -name node_modules -o -name data -o -name .trellis -o -name .git -o -name .pi -o -name .agents \) -prune -o \
    -type d -print 2>/dev/null | sed 's|^\./||' | sort | sed 's|^|  |'
  echo
  echo "[src/ 模块]"
  find src -name '*.ts' 2>/dev/null | sort
  echo '```'
  echo
  echo "## src/ 模块与导出符号"
  echo
  for f in $(find src -name '*.ts' 2>/dev/null | sort); do
    lines=$(wc -l < "$f" | tr -d ' ')
    # 取文件头第一个 ///** 或 // 注释行作为一句话职责
    # 文件级注释：取第一个出现在任何 export 之前的 /** 块
    doc=""
    d=$(grep -n -m1 '/\*\*' "$f" 2>/dev/null | cut -d: -f1 || true)
    e=$(grep -n -m1 -E '^export ' "$f" 2>/dev/null | cut -d: -f1 || true)
    if [ -n "$d" ] && { [ -z "$e" ] || [ "$d" -lt "$e" ]; }; then
      doc=$(awk -v start="$d" '
        NR < start { next }
        /^[[:space:]]*\/\*\*/ { inb=1; sub(/^[[:space:]]*\/\*\*/,"");
          if ($0 ~ /\*\//) { sub(/[[:space:]]*\*\/.*$/,""); if (length($0)) { print; exit } }
          next }
        inb && /\*\// { exit }
        inb { sub(/^[[:space:]*]+/,""); sub(/[[:space:]]+$/,""); if (length($0)) { print; exit } }
      ' "$f" || true)
    fi
    echo "### \`$f\`  ($lines 行)"
    [ -n "$doc" ] && echo "> $doc"
    echo
    syms=$( (grep -nE '^export (async )?(function|const|class|interface|type|enum)' "$f" 2>/dev/null || true) \
      | sed -E 's/^([0-9]+):export (async )?(function|const|class|interface|type|enum) ([A-Za-z0-9_]+).*/\4/' \
      | paste -sd, - | sed 's/,/, /g' || true)
    if [ -n "$syms" ]; then echo "导出：\`$syms\`"; else echo "导出：（无，或为可执行入口）"; fi
    echo
  done

  echo "## bin/ 脚本"
  echo
  echo "| 文件 | 用途 |"
  echo "|---|---|"
  for f in bin/*; do
    [ -f "$f" ] || continue
    case "$f" in
      *.py) desc=$(awk 'p&&/"""/{exit} p{print;exit} /^"""/{p=1}' "$f" 2>/dev/null || true) ;;
      *.sh) desc=$(grep -m1 -E '^#[^!].*' "$f" 2>/dev/null | sed 's/^# *//' || true) ;;
      *)    desc="" ;;
    esac
    echo "| \`$f\` | ${desc:-—} |"
  done
  echo
  echo "## tools/ 脚本"
  echo
  for f in tools/*; do
    [ -f "$f" ] || continue
    desc=$(grep -m1 -E '^#[^!].*' "$f" 2>/dev/null | sed 's/^# *//' || true)
    echo "- \`$f\` — ${desc:-—}"
  done
} > "$TMP"

if [ "${1:-}" = "--check" ]; then
  strip_ts() { grep -v '^> 生成命令：' "$1"; }
  if [ -f "$OUT" ] && diff <(strip_ts "$OUT") <(strip_ts "$TMP") >/dev/null; then
    echo "TREE.md 已是最新"
  else
    echo "TREE.md 需要刷新（运行：bash tools/repomap.sh）" >&2
    exit 1
  fi
else
  mv "$TMP" "$OUT"
  trap - EXIT
  echo "已生成 $OUT"
fi
