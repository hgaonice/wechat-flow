#!/usr/bin/env bash
# manim-gif.sh — 把一个 manim 场景渲染成适合公众号正文的 GIF。
#
# 为什么是 GIF 而不是 MP4：公众号正文只能内联图片，视频要单独上传且不能自动插入。
# 实测 GIF 会以 mmbiz_gif 上传到微信 CDN 并正常显示（MP4 不行）。
#
# 用法：
#   bin/manim-gif.sh scene.py SceneName                     # -> scene.gif
#   bin/manim-gif.sh scene.py Parabola -o out.gif --width 720 --fps 12
#   bin/manim-gif.sh scene.py Parabola --quality qh         # 先高画质再压
#
# 参数：
#   -o, --out      输出 GIF（默认与场景同名 .gif）
#   --width        GIF 宽度，默认 720（公众号正文 640 左右最稳）
#   --fps          默认 12
#   --quality      manim 画质：ql(480p15) qm(720p30) qh(1080p60)，默认 ql
#   --colors       调色板颜色数，默认 128
#   --max-mb       超过这个大小自动降档重压，默认 2
#   --manim        manim 可执行文件，默认 /opt/manim-venv/bin/manim
#   --keep         保留中间 mp4
set -euo pipefail

MANIM="${MANIM_BIN:-/opt/manim-venv/bin/manim}"
QUALITY="ql"
WIDTH=720
FPS=12
COLORS=128
MAX_MB=2
OUT=""
KEEP=0

die() { echo "manim-gif: $*" >&2; exit 1; }

[[ $# -ge 2 ]] || die "用法: manim-gif.sh <scene.py> <SceneName> [-o out.gif] [--width N] [--fps N]"
SCENE_FILE="$1"; SCENE_NAME="$2"; shift 2

while [[ $# -gt 0 ]]; do
  case "$1" in
    -o|--out) OUT="$2"; shift 2 ;;
    --width) WIDTH="$2"; shift 2 ;;
    --fps) FPS="$2"; shift 2 ;;
    --quality) QUALITY="$2"; shift 2 ;;
    --colors) COLORS="$2"; shift 2 ;;
    --max-mb) MAX_MB="$2"; shift 2 ;;
    --manim) MANIM="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) die "未知参数 $1" ;;
  esac
done

command -v ffmpeg >/dev/null || die "找不到 ffmpeg"
[[ -x "$MANIM" ]] || die "找不到 manim：$MANIM（用 --manim 指定，或 pip 装到 /opt/manim-venv）"

SCENE_FILE="$(readlink -f "$SCENE_FILE")"
[[ -f "$SCENE_FILE" ]] || die "场景文件不存在：$SCENE_FILE"
SCENE_DIR="$(dirname "$SCENE_FILE")"
[[ -n "$OUT" ]] || OUT="$SCENE_DIR/$SCENE_NAME.gif"

WORK="$(mktemp -d -t wf-manim-XXXXXX)"
cleanup() { [[ $KEEP -eq 1 ]] || rm -rf "$WORK"; }
trap cleanup EXIT

echo "→ manim 渲染 $SCENE_NAME ($QUALITY) …"
if ! "$MANIM" render "-$QUALITY" --disable_caching --media_dir "$WORK/media" "$SCENE_FILE" "$SCENE_NAME" >"$WORK/manim.log" 2>&1; then
  echo "--- manim 输出（末 25 行）---" >&2
  tail -25 "$WORK/manim.log" >&2
  die "manim 渲染失败"
fi

MP4="$(find "$WORK/media" -path '*/partial_movie_files/*' -prune -o -name "$SCENE_NAME.mp4" -print | head -1)"
[[ -n "$MP4" ]] || die "manim 没有产出 mp4"

to_gif() {  # $1=宽 $2=fps $3=颜色数 $4=输出
  ffmpeg -y -v error -i "$MP4" \
    -vf "fps=$2,scale=$1:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=$3[p];[b][p]paletteuse=dither=bayer:bayer_scale=3" \
    -loop 0 "$4"
}

W="$WIDTH"; F="$FPS"; C="$COLORS"
to_gif "$W" "$F" "$C" "$OUT"
SIZE_MB=$(( $(stat -c%s "$OUT") / 1048576 ))

# 太大就降档（宽度先降，再降帧率）
while [[ $SIZE_MB -ge $MAX_MB && $W -gt 420 ]]; do
  W=$(( W * 3 / 4 )); F=$(( F > 8 ? F - 2 : F )); C=$(( C > 64 ? C / 2 : C ))
  echo "  体积偏大，降到 ${W}px/${F}fps/${C}色 重压…"
  to_gif "$W" "$F" "$C" "$OUT"
  SIZE_MB=$(( $(stat -c%s "$OUT") / 1048576 ))
done

DUR="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$MP4" 2>/dev/null || echo '?')"
DIM="$(ffprobe -v error -select_streams v -show_entries stream=width,height -of csv=p=0:s=x "$OUT" 2>/dev/null || echo '?')"
echo "✅ $OUT"
printf '   %s  时长 %ss  宽高 %s  原始mp4 %s\n' "$(du -h "$OUT" | cut -f1)" "$DUR" "$DIM" "$(du -h "$MP4" | cut -f1)"
echo "   在文章里引用：![]($(realpath --relative-to="$SCENE_DIR" "$OUT" 2>/dev/null || echo "$OUT"))"
