#!/usr/bin/env python3
"""Visual regression for the console UI (C3).

Dev-only tool. Uses the SYSTEM Python Playwright (`playwright` 1.64 + cached
Chromium) — nothing is added to package.json, so the console keeps zero runtime
dependencies (spec/console/index.md H3).

    # boot an isolated console first
    bash tools/ui-dev-console.sh start

    # capture / refresh baselines
    python3 tools/ui-visual.py --update

    # compare against baselines (exit 2 on any difference / JS error / CSP hit)
    python3 tools/ui-visual.py

Exit codes: 0 ok · 2 difference or console/CSP error · 3 setup error.

Why viewport-sized shots (not full_page): `full_page` changes height whenever a
table gains a row, which turns every baseline into noise. Each page is captured
at a fixed 1280x900 viewport with reduced-motion emulated; long pages are
covered by the per-page "ready selector" assertions instead.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

try:
    from PIL import Image, ImageChops
    from playwright.sync_api import sync_playwright
except Exception as exc:  # noqa: BLE001
    print(f"setup error: {exc}", file=sys.stderr)
    sys.exit(3)

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "tools" / "ui-baselines"

# name -> (path, ready selector, hide selectors)
PAGES: dict[str, tuple[str, str, list[str]]] = {
    "login": ("/login", "#login-form", []),
    "index": ("/app", "#accounts", []),
    "account": ("/account?id=1", "main", []),
    "settings": ("/settings", "main", []),
    "admin": ("/admin", "main", []),
    "workbench": ("/workbench", "#account", []),
    "chat": ("/chat", "#chat-list", []),
}

# ids the page JS binds to; the shell must never lose them (design S-1 invariant 1)
DOM = {
    "login": ["#login-form", "#username", "#password"],
    "index": ["#accounts", "#who", "#logout", "#nav-admin"],
    "account": ["#alias", "#who", "#effective"],
    "settings": ["#who", "#global-json"],
    "admin": ["#who", "#tunnel-stats"],
    "workbench": ["#account", "#who", "#logout"],
    "chat": ["#chat-list", "#who", "#logout"],
}

DIFF_THRESHOLD = 0.005  # 0.5% of pixels


def login(page, base: str, user: str, password: str) -> None:
    page.goto(f"{base}/login", wait_until="load")
    page.wait_for_selector("#username", timeout=15000)
    page.fill("#username", user)
    page.fill("#password", password)
    page.click("#login-form button[type=submit]")
    page.wait_for_url(f"{base}/app", timeout=20000)
    page.wait_for_load_state("load")


def diff_ratio(a: Path, b: Path) -> tuple[float, str]:
    ia, ib = Image.open(a).convert("RGB"), Image.open(b).convert("RGB")
    if ia.size != ib.size:
        return 1.0, f"size {ia.size} != {ib.size}"
    diff = ImageChops.difference(ia, ib)
    gray = diff.convert("L")
    hist = gray.histogram()
    changed = sum(hist[8:])  # ignore <=7/255 noise (antialiasing)
    total = ia.size[0] * ia.size[1]
    return changed / total, f"{changed}/{total} px"


def capture(page, base: str, name: str, theme: str, out_dir: Path, hide: list[str], anonymous: bool = False) -> list[str]:
    path, ready, default_hide = PAGES[name]
    problems: list[str] = []

    errors: list[str] = []
    csp: list[str] = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    page.add_init_script(
        "try{localStorage.setItem('wfc.theme', %s)}catch(e){}" % json.dumps(theme)
    )

    page.goto(f"{base}{path}", wait_until="load")
    if not anonymous and name != "login":
        # page scripts decide auth state; an unauthenticated hop lands on /login
        if page.url.rstrip("/").endswith("/login"):
            raise RuntimeError("redirected to /login — session was not established")
    try:
        page.wait_for_selector(ready, timeout=10000, state="visible")
    except Exception as exc:  # noqa: BLE001
        problems.append(f"{name}: ready selector {ready!r} not visible ({exc})")

    for sel in list(default_hide) + hide:
        for el in page.query_selector_all(sel):
            el.evaluate("e => e.style.visibility='hidden'")

    page.wait_for_timeout(250)
    target = out_dir / f"{name}-{theme}.png"
    page.screenshot(path=str(target))

    missing = [sel for sel in DOM.get(name, []) if page.query_selector(sel) is None]
    if missing:
        problems.append(f"{name}: missing DOM node(s) {missing} — shell ate a page id")
    recorded_csp = page.evaluate("window.__csp || []")
    if recorded_csp:
        csp.extend(str(x) for x in recorded_csp)
    errors = [e for e in errors if not ("Failed to load resource" in e and "401" in e)]
    if errors:
        problems.append(f"{name}/{theme}: console error(s): " + " | ".join(errors[:3]))
    if csp:
        problems.append(f"{name}/{theme}: CSP violation(s): " + " | ".join(csp[:3]))
    return problems


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://127.0.0.1:8799")
    ap.add_argument("--user", default=os.environ.get("WFC_DEV_USER", "admin"))
    ap.add_argument("--password", default=os.environ.get("WFC_DEV_PASSWORD", "dev-pass-123456"))
    ap.add_argument("--page", default="all", help="all | comma-separated names")
    ap.add_argument("--theme", default="both", choices=["dark", "light", "both"])
    ap.add_argument("--out-dir", default=str(DEFAULT_OUT))
    ap.add_argument("--diff-dir", default="/tmp/ui-diff")
    ap.add_argument("--update", action="store_true", help="write baselines instead of comparing")
    ap.add_argument("--suffix", default="", help="append to filename, e.g. '-before'")
    ap.add_argument("--hide", action="append", default=[], help="extra CSS selectors to hide")
    args = ap.parse_args()

    names = list(PAGES) if args.page == "all" else [p.strip() for p in args.page.split(",") if p.strip()]
    unknown = [n for n in names if n not in PAGES]
    if unknown:
        print(f"unknown page(s): {unknown}", file=sys.stderr)
        return 3
    themes = ["dark", "light"] if args.theme == "both" else [args.theme]
    out_dir = Path(args.out_dir)
    diff_dir = Path(args.diff_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    Path("/tmp/ui-current").mkdir(parents=True, exist_ok=True)
    diff_dir.mkdir(parents=True, exist_ok=True)

    base = args.base_url.rstrip("/")
    problems: list[str] = []
    diffs: list[str] = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1280, "height": 900}, device_scale_factor=1,
                                  reduced_motion="reduce")
        page = ctx.new_page()

        # CSP violations are reported on the document, not on console
        page.add_init_script(
            "window.__csp=[];document.addEventListener('securitypolicyviolation',"
            "e=>window.__csp.push(e.violatedDirective+' '+e.blockedURI));"
        )

        login(page, base, args.user, args.password)  # warm the shared context (cookies) once

        for name in names:
            for theme in themes:
                if name == "login":
                    # fresh context: an authenticated session redirects /login -> /app
                    anon = browser.new_context(viewport={"width": 1280, "height": 900},
                                               device_scale_factor=1, reduced_motion="reduce")
                    problems += capture(anon.new_page(), base, name, theme, Path("/tmp/ui-current"),
                                        args.hide, anonymous=True)
                    anon.close()
                else:
                    pg = ctx.new_page()
                    problems += capture(pg, base, name, theme, Path("/tmp/ui-current"), args.hide)
                    pg.close()
                cur = Path("/tmp/ui-current") / f"{name}-{theme}.png"
                basefile = out_dir / f"{name}-{theme}{args.suffix}.png"
                if args.update:
                    basefile.write_bytes(cur.read_bytes())
                    print(f"  baseline {basefile.name}")
                    continue
                if not basefile.exists():
                    diffs.append(f"{name}/{theme}: missing baseline {basefile.name}")
                    continue
                ratio, detail = diff_ratio(basefile, cur)
                if ratio > DIFF_THRESHOLD:
                    d = diff_dir / f"{name}-{theme}.png"
                    import shutil as _sh
                    _sh.copyfile(cur, d)
                    diffs.append(f"{name}/{theme}: {ratio*100:.2f}% changed ({detail}) -> {d}")
                else:
                    print(f"  ok {name}/{theme} ({ratio*100:.3f}%)")

        browser.close()

    if problems:
        print("\nFAIL — runtime problems:", file=sys.stderr)
        for p in problems:
            print("  - " + p, file=sys.stderr)
    if diffs:
        print("\nFAIL — visual differences:", file=sys.stderr)
        for d in diffs:
            print("  - " + d, file=sys.stderr)
    if problems or diffs:
        return 2
    print("\nOK — no runtime problems, no visual differences")
    return 0


if __name__ == "__main__":
    sys.exit(main())
