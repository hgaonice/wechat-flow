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
# 注意：每条模式都以 `/` 开头锚定到仓库根。不锚定的 `console/` 会匹配到
# `src/console/`（rsync 的目录模式不分层），曾导致控制台源码从 2026-10-15 起
# 一直没被部署、250 跑着旧前端（C3 Step 7 真机验收时发现：/ds.css 404）。
EXCLUDES=(
  --exclude /config.json
  --exclude '/data/'        # 含 session-snapshots/（Cookies + Local State = 登录凭证，绝不出机器）
  --exclude '/plans/'
  --exclude '/articles/'
  --exclude '/state/'
  --exclude '/imgs/'
  --exclude '/sessions/'
  --exclude '/logs/'
  --exclude '/.env'
  --exclude '/console/'     # 控制台运行时 DB（C1+；--delete 会删库，血训 2026-10-15）
  --exclude '/backups/'     # console-backup.sh 产物（含 master.key）
  --exclude '/.wechat-console/'  # 主密钥（若仓内同层部署）
  --exclude '/.venv/'       # manim 虚拟环境（250 本地安装；--delete 会连 python/manim 一起删，血训 2026-10-19）
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
  EXCLUDES+=(--exclude '/content/' --exclude '/prompts/')
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

# 同步后校验（两条都是真实踩过的坑，宁可部署失败也不要静默跑旧代码/删库）
remote_sha=$(ssh -o BatchMode=yes "$HOST" "sha1sum '$REMOTE_DIR/src/console/http/static.ts' 2>/dev/null | cut -d' ' -f1")
local_sha=$(sha1sum "$SRC/src/console/http/static.ts" | cut -d' ' -f1)
if [[ "$remote_sha" != "$local_sha" ]]; then
  echo "✖ src/console 未同步（本地 $local_sha ≠ 250 ${remote_sha:-缺失}）" >&2
  echo "  多半是 EXCLUDES 里某条模式没锚定到根（如 'console/' 会连 src/console/ 一起排除）" >&2
  exit 1
fi
echo "· src/console 校验一致（sha1 ${local_sha:0:12}）"

if ! ssh -o BatchMode=yes "$HOST" "test -f '$REMOTE_DIR/console/console.db'"; then
  echo "✖ 250 上的 console/console.db 不见了（--delete 误伤？）" >&2
  echo "  立刻从 $REMOTE_DIR/backups/ 或 deploy/console-restore.sh 恢复，不要重启控制台" >&2
  exit 1
fi

# 控制台进程直接执行 .ts（无构建步骤），源码同步后**必须重启**才生效；
# 静态页（src/console/ui/*）是按请求读盘，不需要重启。
# 之前缺这一步 → src/console 同步了但 250 仍跑旧代码（C3 Step 7 真机 404 /ds.css 时发现）。
if ssh -o BatchMode=yes "$HOST" "systemctl is-active --quiet wechat-console.service" 2>/dev/null; then
  echo "· 重启 wechat-console.service（源码已更新）"
  ssh -o BatchMode=yes "$HOST" "systemctl restart wechat-console.service" >/dev/null
  health_ok=0
  for _ in $(seq 1 20); do
    if ssh -o BatchMode=yes "$HOST" "curl -fsS -m 2 -o /dev/null http://127.0.0.1:8787/health" 2>/dev/null; then health_ok=1; break; fi
    sleep 1
  done
  if [[ $health_ok -eq 1 ]]; then
    echo "  ✅ /health 恢复"
  else
    echo "  ✖ 重启后 20s 内 /health 未恢复：ssh $HOST 'systemctl status wechat-console --no-pager; journalctl -u wechat-console -n 50 --no-pager'" >&2
    exit 1
  fi
fi
# 部署成功后刷新清单（keep-remote-content 时不动清单，因为内容没同步）
if [[ $keep_remote -eq 0 ]]; then
  new_fp="$(remote_fingerprint)"
  if [[ -n "$new_fp" ]]; then
    ssh -o BatchMode=yes "$HOST" "mkdir -p '$(dirname "$MANIFEST")' && cat > '$MANIFEST'" <<<"$new_fp"
    echo "· 已刷新 250 内容指纹清单（下次部署据此判断 250 是否被改动）"
  fi
fi

echo
echo "· 部署后自检（浏览器托管 + 会话三态，C1 Step5 / AC4）"
if [[ "${WFC_DEPLOY_SKIP_CHECKS:-0}" == "1" ]]; then
  echo "  （已跳过：WFC_DEPLOY_SKIP_CHECKS=1）"
else
  # 只转发合法值，避免把任意字符串拼进远端命令行。
  REMOTE_ENV=""
  case "${WFC_BROWSER_MODE:-}" in
    external | inline) REMOTE_ENV="WFC_BROWSER_MODE=$WFC_BROWSER_MODE" ;;
  esac
  # deploy/session-check.sh（随本次 rsync 已在 250 上）：
  #  ① Xvfb/浏览器 unit 是否真的在跑（且 MainPID 是 chrome，不是“unit 活着但没人管”）
  #  ② session probe 逐账号：只有 invalid 算失败（unknown = 证据不足，不算）
  if ! ssh -o BatchMode=yes "$HOST" "cd '$REMOTE_DIR' && $REMOTE_ENV bash deploy/session-check.sh"; then
    echo
    echo "✖ 部署后自检失败（文件已同步，但运行态不对）。不要盲目重启/重登，按下面取证：" >&2
    echo "    浏览器：ssh $HOST 'systemctl status wechat-browser@<alias> --no-pager; journalctl -u wechat-browser@<alias> -n 50 --no-pager'" >&2
    echo "    会话  ：ssh $HOST 'cd $REMOTE_DIR && bun src/cli.ts session probe --all'" >&2
    echo "    应急  ：WFC_DEPLOY_SKIP_CHECKS=1 ./deploy/deploy.sh（跳过本自检，不修任何东西）" >&2
    exit 1
  fi
fi

echo
echo "✓ 部署完成"
echo "  自检：ssh $HOST 'cd $REMOTE_DIR && DISPLAY=:99 bun src/cli.ts doctor --all'"
