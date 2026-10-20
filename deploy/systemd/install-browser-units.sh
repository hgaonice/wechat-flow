#!/usr/bin/env bash
#
# 安装 + enable 浏览器托管 unit（C1 Step5 / R3-R4）。幂等，可反复跑。
#
# 被两个安装器共用：
#   deploy/install.sh          （timer 模式）
#   deploy/install-console.sh  （控制台模式，250 走这个）
#
# 做三件事，**不做**第四件：
#   ① 安装 wechat-xvfb.service 与 wechat-browser@.service（模板，不展开实例）
#   ② `enable` Xvfb（开机自启），但**不** `start` —— 迁移前机器上还有裸
#      `Xvfb :99`，此时 start 会因 "server already active for display 99" 失败并
#      进入重启循环。启动时机见下方迁移顺序。
#   ③ 体检：unit 里硬编码的 bun 路径是否存在；裸 Xvfb :99 是否还占着显示。
#   ✗ 不 enable 任何 `wechat-browser@<alias>` 实例：多登一个 alias 就是多起一个
#     Chrome，必须由人决定（同 profile 双开会被微信判异常登录并踢线）。
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_DIR="${UNIT_DIR:-/etc/systemd/system}"
BUN_PATH="${WFC_BUN_PATH:-/root/.nvm/versions/node/v24.14.1/bin/bun}"

if [ "$(id -u)" -ne 0 ]; then
  echo "请以 root 运行（systemd 单元安装）" >&2
  exit 1
fi

echo "==> 安装浏览器托管 unit 到 $UNIT_DIR"
for u in wechat-xvfb.service 'wechat-browser@.service'; do
  install -m 0644 "$HERE/$u" "$UNIT_DIR/$u"
done
systemctl daemon-reload

echo "==> enable wechat-xvfb.service（只 enable，不 start）"
systemctl enable wechat-xvfb.service
if systemctl is-active --quiet wechat-xvfb.service; then
  echo "    wechat-xvfb.service: active"
elif pgrep -f 'Xvfb :99' >/dev/null 2>&1; then
  echo "    ⚠️  检测到裸 Xvfb :99 仍在运行 —— 迁移窗口里先停它，再 systemctl start wechat-xvfb.service"
else
  echo "    wechat-xvfb.service: enabled（未启动）"
fi

# unit 的 ExecStart 硬编码了 bun 路径；路径漂了 unit 会直接起不来，提前喊一声。
if [ ! -x "$BUN_PATH" ]; then
  echo "    ⚠️  $BUN_PATH 不存在 —— wechat-browser@.service 的 ExecStart 会失败（改 unit 里的路径或修 bun）" >&2
fi

echo
echo "注意：模板 unit 一装好，250 的托管方式就自动翻成 external（unit 存在即判定 external）。"
echo "此时若裸 Chrome 还占着 CDP 端口（9222/9223），ensureBrowser 会在 cdpVersion 短路直接复用，"
echo "**不会**起第二个 Chrome —— 所以装完 unit 不会打断当天发布。真正接管发生在下一步迁移。"
echo
echo "迁移顺序（一次性，全程不需要扫码）："
echo "  1) systemctl stop wechat-console.service                 # 避免迁移中 console 又 spawn 一个 Chrome"
echo "  2) pgrep -x chrome | xargs -r kill -TERM                 # 裸 Chrome 优雅退出（会 flush Cookies）"
echo "     # 不要用 pkill -f '…--remote-debugging-port…'：那条 ssh 命令行里也含这个字符串，"
echo "     # pkill 会连带杀掉你自己的会话。"
echo "  3) pgrep -x Xvfb | xargs -r kill -TERM                   # 裸 Xvfb（会带走还没退出的 Chrome）"
echo "  4) systemctl start wechat-xvfb.service"
echo "  5) systemctl enable --now wechat-browser@second.service wechat-browser@gaoh.service"
echo "  6) systemctl restart wechat-console.service"
echo "  7) bash deploy/session-check.sh                          # 必须全绿、0 次扫码"
