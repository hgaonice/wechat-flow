#!/usr/bin/env python3
"""tex2svg.py — LaTeX 公式 → 内联 SVG（可直接嵌进公众号正文）。

为什么用 SVG 而不是图片/纯文本：
  · 微信编辑器会保留内联 <svg>（实测：粘贴后、保存后、重新打开后都在），
    而它不会执行 JS，所以 KaTeX/MathJax 那种「HTML+CSS+JS」方案在微信里是死的。
  · dvisvgm --no-fonts 把字体转成路径，读者端不需要装任何数学字体。

用法：
  python3 tex2svg.py 'x=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}'          # 行内，高度 1.5em
  python3 tex2svg.py --display '\\Delta=b^2-4ac'                    # 块级，居中
  python3 tex2svg.py --height 2em 'S=\\pi r^2'
  python3 tex2svg.py --scale 1.15 'a^2+b^2=c^2'
输出：一段 HTML（内联 SVG）到 stdout。
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile

PREAMBLE = r"""\documentclass[border=1pt]{standalone}
\usepackage{amsmath,amssymb,bm}
\usepackage{xcolor}
"""


def which(name: str) -> str:
    p = shutil.which(name)
    if not p:
        sys.exit(f"[tex2svg] 缺少可执行文件：{name}")
    return p


def strip_svg_noise(svg: str) -> str:
    """去掉 XML 声明/注释，并把根标签的尺寸改成我们想要的。"""
    svg = re.sub(r"<\?xml[^>]*\?>", "", svg)
    svg = re.sub(r"<!--.*?-->", "", svg, flags=re.S)
    svg = re.sub(r">\s+<", "><", svg)
    return svg.strip()


def render(tex: str, display: bool, height: str, scale: float, color: str) -> str:
    # 注意：standalone 文档类里用 \[ ... \] 会报 "Missing $ inserted"，
    # 所以块级公式用 $\displaystyle ...$ 代替（屏幕效果等价）。
    body = f"$\\displaystyle {tex}$" if display else f"${tex}$"
    if color and color.lower() not in ("", "black", "#000"):
        body = "\\color{%s}%s" % (color, body)

    tmp = tempfile.mkdtemp(prefix="wf-tex-")
    try:
        texfile = os.path.join(tmp, "f.tex")
        with open(texfile, "w", encoding="utf-8") as fh:
            fh.write(PREAMBLE + "\\begin{document}\n" + body + "\n\\end{document}\n")

        pdflatex = which("pdflatex")
        dvisvgm = which("dvisvgm")
        env = dict(os.environ, TEXMFVAR=os.path.join(tmp, "texmf"))

        r = subprocess.run(
            [pdflatex, "-interaction=nonstopmode", "-halt-on-error", "-no-shell-escape", "f.tex"],
            cwd=tmp, capture_output=True, text=True, env=env, timeout=120,
        )
        pdf = os.path.join(tmp, "f.pdf")
        if r.returncode != 0 or not os.path.exists(pdf):
            log = (r.stdout or r.stderr)
            hint = ""
            if "Unicode character" in log or "not set up for use with LaTeX" in log:
                hint = (
                    "\n提示：公式里不要写中文（\\(\\text{扇形}\\) 这种）。"
                    "把中文写在正文里，公式只放数学符号。"
                )
            sys.exit("[tex2svg] LaTeX 编译失败：" + hint + "\n" + log[-1500:])

        r = subprocess.run(
            [dvisvgm, "--pdf", "--no-fonts", "--exact-bbox", "--linkmark=local",
             "--bbox=papersize", "f.pdf", "-o", "f.svg"],
            cwd=tmp, capture_output=True, text=True, env=env, timeout=120,
        )
        svgfile = os.path.join(tmp, "f.svg")
        if r.returncode != 0 or not os.path.exists(svgfile):
            sys.exit("[tex2svg] dvisvgm 失败：\n" + (r.stdout or r.stderr)[-1500:])

        svg = strip_svg_noise(open(svgfile, encoding="utf-8").read())
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    m = re.search(r"viewBox='([\d.\- ]+)'", svg) or re.search(r'viewBox="([\d.\- ]+)"', svg)
    if not m:
        sys.exit("[tex2svg] 生成的 SVG 没有 viewBox")
    parts = m.group(1).split()
    vw, vh = float(parts[2]), float(parts[3])
    ratio = (vw / vh) if vh else 1.0

    h = f"{round(float(re.sub(r'[^0-9.]', '', height) or 1.5) * scale, 3)}em"
    w = f"{round(float(h[:-2]) * ratio, 3)}em"

    # 统一成：宽度按比例、高度够高、基线对齐好（行内公式不会把行距撑歪）
    svg = re.sub(r"<svg([^>]*?)>", lambda mo: "<svg%s>" % _fix_root(mo.group(1), w, h), svg, count=1)
    if display:
        return f'<section class="wf-math-block" style="text-align:center;margin:14px 0;">{svg}</section>'
    return svg


def _fix_root(attrs: str, w: str, h: str) -> str:
    attrs = re.sub(r"""\s+(width|height|style)=(['\"])[^'\"]*\2""", "", attrs)
    style = f"display:inline-block;vertical-align:-0.25em;width:{w};height:{h};"
    return f'{attrs} style="{style}"'


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("tex", help="LaTeX 公式（不含 $ 或 \\[ \\]）")
    ap.add_argument("--display", action="store_true", help="块级公式（居中，独占一行）")
    ap.add_argument("--height", default="1.5em", help="行内高度，默认 1.5em")
    ap.add_argument("--scale", type=float, default=1.0, help="再乘一个缩放系数")
    ap.add_argument("--color", default="", help="颜色，如 #0F4C81")
    a = ap.parse_args()
    print(render(a.tex, a.display, a.height, a.scale, a.color))


if __name__ == "__main__":
    main()
