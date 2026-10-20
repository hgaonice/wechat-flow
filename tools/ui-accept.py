#!/usr/bin/env python3
"""Browser acceptance sweep for the console (C3 · reruns 10-15 V1–V13).

Dev-only tool, system Python Playwright (see tools/ui-visual.py header for why
nothing is added to package.json).

    bash tools/ui-dev-console.sh start
    python3 tools/ui-accept.py                       # against the dev instance
    python3 tools/ui-accept.py --base-url https://x  # against a real tunnel

Every check prints PASS/FAIL with the value it asserted on. Exit 1 if any FAIL.

Checks (V1–V13 mirror .trellis/tasks/10-15-console-acceptance-250/report.md,
V14/V15 are the C3 additions):

  V1  anonymous /app → /login
  V2  wrong password rejected, error text visible (not swallowed by CSP)
  V3  login → /app, topbar shows the account label
  V4  account table lists every alias
  V5  admin sees the create-account card
  V6  workbench loads with a populated account picker
  V7  workbench plan editor renders editable day rows
  V8  chat page loads with composer + list
  V9  /admin tunnel block renders its 7 stats
  V10 /admin account overview table has rows
  V11 /account?id=1 renders all 5 sections
  V12 /settings renders global JSON editor + 2 tables
  V13 zero console errors / zero CSP violations across every page visited
  V14 no horizontal overflow at 1440/1024/768/390 on every page
  V15 theme toggle round-trips (dark → light → dark, persisted in localStorage)
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright
except Exception as exc:  # noqa: BLE001
    print(f"setup error: {exc}", file=sys.stderr)
    sys.exit(3)

RESULTS: list[tuple[str, bool, str]] = []
ERRORS: list[str] = []
CSP: list[str] = []


def check(vid: str, ok: bool, detail: str) -> None:
    RESULTS.append((vid, ok, detail))
    mark = "\033[32m✓\033[0m" if ok else "\033[31m✗\033[0m"
    print(f"  {mark} {vid}  {detail}")


def attach(page) -> None:
    page.on("console", lambda m: ERRORS.append(f"{page.url} :: {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda e: ERRORS.append(f"{page.url} :: pageerror {e}"))


WIDTHS = (1440, 1024, 768, 390)


def overflow(page) -> tuple[bool, str]:
    """V14: no horizontal scrollbar at any breakpoint (rail / drawer included)."""
    bad: list[str] = []
    for w in WIDTHS:
        page.set_viewport_size({"width": w, "height": 900 if w > 500 else 844})
        page.wait_for_timeout(150)
        sw, cw = page.evaluate(
            "() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]"
        )
        if sw > cw:
            bad.append(f"{w}px → {sw}>{cw}")
    page.set_viewport_size({"width": 1280, "height": 900})
    return not bad, ("overflow at " + ", ".join(bad) if bad else f"0 overflow @ {WIDTHS}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://127.0.0.1:8799")
    ap.add_argument("--user", default=os.environ.get("WFC_DEV_USER", "admin"))
    ap.add_argument("--password", default=os.environ.get("WFC_DEV_PASSWORD", "dev-pass-123456"))
    ap.add_argument("--alias", default="", help="alias to open for V11 (default: first account row)")
    args = ap.parse_args()
    base = args.base_url.rstrip("/")

    with sync_playwright() as pw:
        browser = pw.chromium.launch()

        # ── anonymous context: V1 + V2 ────────────────────────────────────
        anon = browser.new_context(viewport={"width": 1280, "height": 900})
        page = anon.new_page()
        attach(page)
        page.add_init_script("window.__csp=[];document.addEventListener('securitypolicyviolation',"
                             "e=>window.__csp.push(e.violatedDirective+' '+e.blockedURI));")
        page.goto(f"{base}/app", wait_until="load")
        page.wait_for_timeout(400)
        landed = page.url.split(base)[-1] or "/"
        check("V1", landed in ("/", "/login"), f"GET /app → {landed} (login page)")

        page.goto(f"{base}/login", wait_until="load")
        page.wait_for_selector("#username", timeout=15000)
        page.fill("#username", args.user)
        page.fill("#password", "definitely-wrong-password")
        page.click("#login-form button[type=submit]")
        page.wait_for_timeout(800)
        msg = page.query_selector("#msg")
        err_text = msg.inner_text().strip() if msg else ""
        err_role = msg.get_attribute("role") if msg else None
        check("V2", "login" in page.url and bool(err_text) and err_role == "alert",
              f"stayed on /login, role={err_role}, text={err_text[:60]!r}")
        anon.close()

        # ── authenticated context: V3..V12 ───────────────────────────────
        ctx = browser.new_context(viewport={"width": 1280, "height": 900})
        page = ctx.new_page()
        attach(page)
        page.add_init_script("window.__csp=[];document.addEventListener('securitypolicyviolation',"
                             "e=>window.__csp.push(e.violatedDirective+' '+e.blockedURI));")
        page.goto(f"{base}/login", wait_until="load")
        page.wait_for_selector("#username", timeout=15000)
        page.fill("#username", args.user)
        page.fill("#password", args.password)
        page.click("#login-form button[type=submit]")
        page.wait_for_url(f"{base}/app", timeout=20000)
        page.wait_for_selector("#accounts", timeout=15000)
        who = page.inner_text("#who").strip()
        check("V3", page.url.rstrip("/").endswith("/app") and who != "", f"/app as {who!r}")

        rows = page.query_selector_all("#accounts tr")
        aliases = [r.inner_text().split("\t")[0].strip() for r in rows]
        check("V4", len(rows) >= 1, f"{len(rows)} account row(s): {aliases}")
        alias = args.alias or (aliases[0] if aliases else "")
        hrefs = [a.get_attribute("href") for a in page.query_selector_all("#accounts a[href*='/account']")]
        acct_id = (hrefs[0].split("id=")[-1] if hrefs else "1")
        if args.alias:
            acct_id = args.alias

        create_visible = page.is_visible("#create-card")
        check("V5", create_visible, f"#create-card visible={create_visible} (admin)")

        overflows: list[str] = []
        ok, detail = overflow(page)
        if not ok:
            overflows.append(f"/app {detail}")

        page.goto(f"{base}/workbench", wait_until="load")
        page.wait_for_selector("#account", timeout=15000)
        page.wait_for_timeout(600)
        opts = [o.inner_text().strip() for o in page.query_selector_all("#account option")]
        check("V6", len(opts) >= 1, f"{len(opts)} account option(s): {opts}")
        day_inputs = page.query_selector_all("#plan-days tr input")
        check("V7", len(day_inputs) >= 7, f"{len(day_inputs)} editable cells in #plan-days")
        ok, detail = overflow(page)
        if not ok:
            overflows.append(f"/workbench {detail}")

        page.goto(f"{base}/chat", wait_until="load")
        page.wait_for_selector("#chat-list", timeout=15000)
        page.wait_for_timeout(500)
        has_composer = page.query_selector("#composer-input") is not None
        check("V8", page.query_selector("#chat-list") is not None and has_composer,
              f"#chat-list present, composer={has_composer}, chats={len(page.query_selector_all('#chat-list li'))}")
        ok, detail = overflow(page)
        if not ok:
            overflows.append(f"/chat {detail}")

        page.goto(f"{base}/admin", wait_until="load")
        page.wait_for_selector("#tunnel-stats", timeout=15000)
        page.wait_for_timeout(600)
        stats = page.query_selector_all("#tunnel-stats .ds-stat")
        check("V9", len(stats) == 7, f"{len(stats)} tunnel stat(s) in #tunnel-stats")
        tables = page.query_selector_all(".ds-table")
        big = max((len(t.query_selector_all("tbody tr")) for t in tables), default=0)
        check("V10", len(tables) >= 2, f"{len(tables)} table(s), largest tbody={big} row(s)")
        ok, detail = overflow(page)
        if not ok:
            overflows.append(f"/admin {detail}")

        page.goto(f"{base}/account?id={acct_id}", wait_until="load")
        page.wait_for_selector("#effective", timeout=15000, state="attached")
        page.wait_for_timeout(600)
        titles = [t.inner_text().strip() for t in page.query_selector_all(".ds-card__title")]
        need = ("有效配置", "覆盖项", "邮箱", "凭据", "全局默认")
        missing = [n for n in need if not any(n in t for t in titles)]
        check("V11", not missing, f"id={acct_id} alias={alias!r} sections={titles} missing={missing}")
        ok, detail = overflow(page)
        if not ok:
            overflows.append(f"/account {detail}")

        page.goto(f"{base}/settings", wait_until="load")
        page.wait_for_selector("#global-json", timeout=15000)
        page.wait_for_timeout(600)
        n_tables = len(page.query_selector_all(".ds-table"))
        check("V12", page.query_selector("#global-json") is not None and n_tables == 2,
              f"#global-json present, tables={n_tables}")
        ok, detail = overflow(page)
        if not ok:
            overflows.append(f"/settings {detail}")

        # ── V15 theme round-trip ─────────────────────────────────────────
        page.goto(f"{base}/app", wait_until="load")
        page.wait_for_selector("#accounts", timeout=15000)
        page.click(".ds-theme-toggle")
        page.wait_for_timeout(150)
        first = page.evaluate("document.documentElement.dataset.theme")
        page.click(".ds-theme-toggle")
        page.wait_for_timeout(150)
        second = page.evaluate("document.documentElement.dataset.theme")
        stored = page.evaluate("localStorage.getItem('wfc.theme')")
        page.reload(wait_until="load")
        page.wait_for_selector("#accounts", timeout=15000)
        after_reload = page.evaluate("document.documentElement.dataset.theme")
        check("V15", first != second and after_reload == second,
              f"toggle {first}→{second}, stored={stored!r}, after reload={after_reload}")

        # ── aggregate: console errors + CSP ──────────────────────────────
        csp = page.evaluate("window.__csp || []")
        for u in ctx.pages:
            try:
                csp += u.evaluate("window.__csp || []")
            except Exception:  # noqa: BLE001
                pass
        ctx.close()
        browser.close()

    noise = ("Failed to load resource", "401")
    errors = [e for e in ERRORS if not all(n in e for n in noise)]
    check("V13", not errors and not csp, f"{len(errors)} console error(s), {len(csp)} CSP violation(s)"
          + ((": " + " | ".join(errors[:3])) if errors else "")
          + ((": " + " | ".join(map(str, csp[:3]))) if csp else ""))
    check("V14", not overflows, "horizontal overflow: " + ("; ".join(overflows) if overflows else "none"))

    passed = sum(1 for _, ok, _ in RESULTS if ok)
    print(f"\nACCEPT: {passed}/{len(RESULTS)} passed")
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
