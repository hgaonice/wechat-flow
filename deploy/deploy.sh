#!/usr/bin/env bash
#
# wechat-flow 安全部署脚本
# =========================
#
# 解决两个真实踩过的坑：
#   1. rsync 多个源 + --delete 会把目标目录清空（本项目曾把 app 根目录清过一次）。
#      本脚本只用**单一源 + 结尾斜杠**，绝不拼接多个源。
# 2. content/ 与 prompts/ 会被静默覆盖。本脚本用「上次部署清单」判定 250 上是否有人改过：
#    改过就拦下并让你明确选择（同步回来 / 250 为真源 / 覆盖）。
#    为什么不用「本地 vs 250 是否一致」判定：正常推送（本地改了要发上去）也会不一致，
#    那样每次部署都会被误报。清单对比才能区分「本地新改的」和「250 上偷偷改的」。
#
# 内容维护策略（A 选项，已定）：
#   **本地仓库是 content/ 与 prompts/ 的真源。**
#   要改大纲/提示词 → 改本地仓库 → 跑本脚本部署。
#   如果你更想直接在 250 上改，加 --keep-remote-content（此时 250 为真源）。
#
# 用法：
#   ./deploy/deploy.sh                       # 常规部署（本地为真源，冲突则中止）
#   ./deploy/deploy.sh -n                    # 只预演，不写
#   ./deploy/deploy.sh --force-content       # 用本地覆盖 250（先自动备份 250 的版本）
#   ./deploy/deploy.sh --keep-remote-content # content/ prompts/ 不同步，250 为真源
#
# 可用环境变量：WF_HOST（默认 root@192.168.0.250）WF_REMOTE_DIR（默认 /root/wechat-flow）
#
set -euo pipefail

HOST="${WF_HOST:-root@192.168.0.250}"
REMOTE_DIR="${WF_REMOTE_DIR:-/root/wechat-flow}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

force_content=0
keep_remote=0
dry=0
for arg in "$@"; do
  case "$arg" in
    --force-content) force_content=1 ;;
    --keep-remote-content) keep_remote=1 ;;
    -n | --dry-run) dry=1 ;;
    -h | --help) sed -n '2,40p' "$0" | grep '^#' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)
      echo "未知参数：$arg（用 -h 看用法）" >&2
      exit 2
      ;;
  esac
done

# 运行时目录：这些是目标机上产生的数据，永远不能被本地覆盖
EXCLUDES=(
  --exclude config.json
  --exclude 'data/'
  --exclude 'plans/'
  --exclude 'articles/'
  --exclude 'state/'
  --exclude 'imgs/'
  --exclude 'sessions/'
  --exclude 'logs/'
  --exclude '.env'
  --exclude 'console/'      # 控制台运行时 DB（C1+；--delete 会删库，血训 2026-10-15）
  --exclude 'backups/'      # console-backup.sh 产物（含 master.key）
  --exclude '.wechat-console/'  # 主密钥（若仓内同层部署）
)

echo "· 源：$SRC/"
echo "· 目标：$HOST:$REMOTE_DIR/"

# 记录「上次部署时 250 上 content/prompts 的指纹」，下次部署用它判断 250 是否被改过。
MANIFEST="$REMOTE_DIR/data/_content-backup/deployed.sha1"
remote_fingerprint() {
  ssh -o BatchMode=yes "$HOST" \
    "cd '$REMOTE_DIR' 2>/dev/null || exit 0; find content prompts -type f 2>/dev/null | sort | xargs -r sha1sum" 2>/dev/null || true
}

if [[ $keep_remote -eq 1 ]]; then
  echo "· content/ 与 prompts/：以 250 为真源（本次不同步）"
  EXCLUDES+=(--exclude 'content/' --exclude 'prompts/')
else
  now_fp="$(remote_fingerprint)"
  old_fp="$(ssh -o BatchMode=yes "$HOST" "cat '$MANIFEST' 2>/dev/null || true" 2>/dev/null || true)"

  if [[ -z "$old_fp" ]]; then
    echo "· content/ 与 prompts/：没有上次部署清单（首次或已清理），跳过冲突检查"
  elif [[ "$now_fp" == "$old_fp" ]]; then
    echo "· content/ 与 prompts/：250 上未被修改，可以安全覆盖"
  else
    echo
    echo "⚠️  250 上的 content/ 或 prompts/ 在上次部署之后被改过了："
    # 注意：diff 有差异时返回 1，在 set -e + pipefail 下会直接干掉脚本，所以要 || true
    diff <(printf '%s\n' "$old_fp") <(printf '%s\n' "$now_fp") | grep -E '^[<>]' | sed 's/^/      /' | head -30 || true
    echo "      （< 上次部署时的版本，> 250 上的当前版本）"
    echo
    if [[ $force_content -eq 0 ]]; then
      echo "当前策略：**本地仓库为真源**。请选一个："
      echo "  1) 想保留 250 上的改动 → 先把它们同步回本地仓库，再重新部署"
      echo "       rsync -av $HOST:$REMOTE_DIR/content/ ./content/"
      echo "       rsync -av $HOST:$REMOTE_DIR/prompts/ ./prompts/"
      echo "  2) 以后就想在 250 上改 → ./deploy/deploy.sh --keep-remote-content"
      echo "  3) 确认要丢弃 250 的改动 → ./deploy/deploy.sh --force-content"
      exit 1
    fi
    if [[ $dry -eq 0 ]]; then
      ts="$(date +%Y%m%d-%H%M%S)"
      echo "· 先备份 250 的版本 → $REMOTE_DIR/data/_content-backup/$ts/"
      ssh -o BatchMode=yes "$HOST" \
        "mkdir -p '$REMOTE_DIR/data/_content-backup/$ts' && cp -a '$REMOTE_DIR/content' '$REMOTE_DIR/prompts' '$REMOTE_DIR/data/_content-backup/$ts/' && cp -a '$MANIFEST' '$REMOTE_DIR/data/_content-backup/$ts/deployed.sha1' 2>/dev/null; true" \
        >/dev/null
    fi
  fi
fi

echo
DRY_ARG=()
if [[ $dry -eq 1 ]]; then DRY_ARG=(-n); fi
rsync -a --checksum --delete --human-readable --info=stats1 "${DRY_ARG[@]}" "${EXCLUDES[@]}" \
  "$SRC/" "$HOST:$REMOTE_DIR/"

if [[ $dry -eq 1 ]]; then
  echo "（预演结束，未写入）"
  exit 0
fi

ssh -o BatchMode=yes "$HOST" "chmod +x '$REMOTE_DIR'/deploy/*.sh '$REMOTE_DIR'/bin/*.sh '$REMOTE_DIR'/bin/*.py 2>/dev/null; true" >/dev/null

# 部署成功后刷新清单（keep-remote-content 时不动清单，因为内容没同步）
if [[ $keep_remote -eq 0 ]]; then
  new_fp="$(remote_fingerprint)"
  if [[ -n "$new_fp" ]]; then
    ssh -o BatchMode=yes "$HOST" "mkdir -p '$(dirname "$MANIFEST")' && cat > '$MANIFEST'" <<<"$new_fp"
    echo "· 已刷新 250 内容指纹清单（下次部署据此判断 250 是否被改动）"
  fi
fi

echo
echo "✓ 部署完成"
echo "  自检：ssh $HOST 'cd $REMOTE_DIR && DISPLAY=:99 bun src/cli.ts doctor --all'"
