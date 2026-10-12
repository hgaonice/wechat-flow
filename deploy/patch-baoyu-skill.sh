#!/usr/bin/env bash
# Patch baoyu-post-to-wechat's `wechat-article.ts` so the browser (CDP) publish
# path actually fills the article BODY.
#
# Why this is needed
# ------------------
# On the current 公众号 editor there are several `.ProseMirror` nodes and the
# FIRST one is the TITLE field (`title-editor__input`); the article body lives
# under `.rich_media_content`. The upstream script does
# `document.querySelector('.ProseMirror')` (=> the title) and moves the content
# with `xdotool key ctrl+v`, which needs a *focused X window*. Under headless
# Xvfb (no window manager) the keystroke is delivered nowhere, so nothing is
# pasted. The script's own guard
#     const editor = document.querySelector('.ProseMirror');
#     return (editor.innerText || '').length > 0;
# then passes anyway — because the title is non-empty. Net effect: a draft is
# saved with a correct title and an EMPTY body, and everything reports success.
#
# What this patch changes
# -----------------------
#  v1
#   1. Resolve the BODY editor explicitly: `.rich_media_content .ProseMirror`
#      (fallback: the largest ProseMirror node).
#   2. Replace the xdotool copy/paste keystrokes with CDP *editing commands*
#      (`Input.dispatchKeyEvent { ..., commands: ['copy'|'paste'] }`), which run
#      inside Blink, need no X focus and read/write the browser clipboard
#      directly.
#  v2
#   3. Re-focus the BODY editor immediately before pasting. The body HTML is
#      copied from a throwaway `file://` tab; creating *and closing* that tab
#      resets the editor page's DOM focus, so the CDP paste command had no
#      editable target and was silently dropped. (Verified: with an explicit
#      `focus()` + caret placement the very same paste inserts the whole article.)
#
# Idempotent. The pristine file is backed up once to `wechat-article.ts.orig`.
#
# NOTE: upstream >= 1.118.2 fixes both issues natively
#   (BODY_EDITOR_SELECTOR + prepareEditorPasteTarget + tab activation),
#   so this script now detects that and exits without touching anything.
#
# Usage:  deploy/patch-baoyu-skill.sh [/root/.agents/skills/baoyu-post-to-wechat]
set -euo pipefail

SKILL_DIR="${1:-/root/.agents/skills/baoyu-post-to-wechat}"
TARGET="$SKILL_DIR/scripts/wechat-article.ts"

if [ ! -f "$TARGET" ]; then
  echo "✗ not found: $TARGET" >&2
  exit 1
fi

python3 - "$TARGET" <<'PY'
import re
import shutil
import sys

path = sys.argv[1]
src = open(path, encoding="utf-8").read()

MARK = "wechat-flow-patch"
has_v1 = MARK + " v1" in src
has_v2 = MARK + " v2" in src

# Upstream >= 1.118.2 landed its own fix for exactly this bug: the body editor
# is resolved via BODY_EDITOR_SELECTOR and `prepareEditorPasteTarget()` verifies
# (and repairs) focus before pasting, throwing if it cannot. Nothing to patch.
_body_sel = ("BODY_EDITOR_SELECTOR = '.rich_media_content .ProseMirror'" in src
             or 'BODY_EDITOR_SELECTOR = ".rich_media_content .ProseMirror"' in src)
if _body_sel and "prepareEditorPasteTarget" in src:
    print("✓ 上游版本已原生修复（BODY_EDITOR_SELECTOR + prepareEditorPasteTarget）— 无需补丁")
    sys.exit(0)

if has_v1 and has_v2:
    print("✓ already patched (v1+v2) — nothing to do")
    sys.exit(0)

orig = path + ".orig"
if not __import__("os").path.exists(orig):
    shutil.copy2(path, orig)
    print(f"· backup written: {orig}")

edits = []

# ---------------------------------------------------------------- 1. helper
if not has_v1:
    old = "const WECHAT_URL = 'https://mp.weixin.qq.com/';"
    new = old + """

/* === wechat-flow-patch v1 (see deploy/patch-baoyu-skill.sh) ===
 * The 公众号 editor renders several ProseMirror nodes; the FIRST is the TITLE
 * (`title-editor__input`), the BODY lives under `.rich_media_content`. Resolve
 * the body editor explicitly (fallback: the largest ProseMirror node). */
const WF_BODY_EDITOR_EXPR = `(document.querySelector('.rich_media_content .ProseMirror') || (function(){var a=document.querySelectorAll('.ProseMirror');var b=null,m=0;for(var i=0;i<a.length;i++){var r=a[i].getBoundingClientRect();var s=r.height*r.width;if(s>m){m=s;b=a[i];}}return b;})())`;
/* === end wechat-flow-patch === */"""
    edits.append(("helper", old, new, 1))

    # ------------------------------------------------- 2. body editor selector
    old = "const editor = document.querySelector('.ProseMirror');"
    new = "const editor = ${WF_BODY_EDITOR_EXPR};"
    edits.append(("body-selector", old, new, 4))

    # ----------------------------------------------------------- 3. focus body
    old = "clickElement(session, '.ProseMirror')"
    new = "clickElement(session, '.rich_media_content .ProseMirror')"
    edits.append(("click-body", old, new, 2))

    # ------------------------------------------------------- 4. pasteInEditor
    old = """async function pasteInEditor(session: ChromeSession): Promise<void> {
  const modifiers = process.platform === 'darwin' ? 4 : 2;
  await session.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'v', code: 'KeyV', modifiers, windowsVirtualKeyCode: 86 }, { sessionId: session.sessionId });
  await sleep(50);
  await session.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', modifiers, windowsVirtualKeyCode: 86 }, { sessionId: session.sessionId });
}"""
    new = """async function pasteInEditor(session: ChromeSession): Promise<void> {
  // [wechat-flow-patch] CDP editing command: no X focus / xdotool required.
  await session.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'v', code: 'KeyV', modifiers: 2, windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86, commands: ['paste'] }, { sessionId: session.sessionId });
  await sleep(50);
  await session.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', modifiers: 2, windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86 }, { sessionId: session.sessionId });
}"""
    edits.append(("pasteInEditor", old, new, 1))

    # ------------------------------------------------------------- 5. sendCopy
    old = """async function sendCopy(cdp?: CdpConnection, sessionId?: string): Promise<void> {
  if (process.platform === 'darwin') {
    spawnSync('osascript', ['-e', 'tell application "System Events" to keystroke "c" using command down']);
  } else if (process.platform === 'linux') {
    spawnSync('xdotool', ['key', 'ctrl+c']);
  } else if (cdp && sessionId) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'c', code: 'KeyC', modifiers: 2, windowsVirtualKeyCode: 67 }, { sessionId });
    await sleep(50);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'c', code: 'KeyC', modifiers: 2, windowsVirtualKeyCode: 67 }, { sessionId });
  }
}"""
    new = """async function sendCopy(cdp?: CdpConnection, sessionId?: string): Promise<void> {
  // [wechat-flow-patch] Prefer the CDP editing command; xdotool needs a focused
  // X window and silently does nothing on headless Xvfb.
  if (cdp && sessionId) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'c', code: 'KeyC', modifiers: 2, windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 67, commands: ['copy'] }, { sessionId });
    await sleep(50);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'c', code: 'KeyC', modifiers: 2, windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 67 }, { sessionId });
    return;
  }
  if (process.platform === 'darwin') {
    spawnSync('osascript', ['-e', 'tell application "System Events" to keystroke "c" using command down']);
  } else {
    spawnSync('xdotool', ['key', 'ctrl+c']);
  }
}"""
    edits.append(("sendCopy", old, new, 1))

    # ------------------------------------------------------------ 6. sendPaste
    old = """async function sendPaste(cdp?: CdpConnection, sessionId?: string): Promise<void> {
  if (process.platform === 'darwin') {
    spawnSync('osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down']);
  } else if (process.platform === 'linux') {
    spawnSync('xdotool', ['key', 'ctrl+v']);
  } else if (cdp && sessionId) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'v', code: 'KeyV', modifiers: 2, windowsVirtualKeyCode: 86 }, { sessionId });
    await sleep(50);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', modifiers: 2, windowsVirtualKeyCode: 86 }, { sessionId });
  }
}"""
    new = """async function sendPaste(cdp?: CdpConnection, sessionId?: string): Promise<void> {
  // [wechat-flow-patch] Prefer the CDP editing command; xdotool needs a focused
  // X window and silently does nothing on headless Xvfb.
  if (cdp && sessionId) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'v', code: 'KeyV', modifiers: 2, windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86, commands: ['paste'] }, { sessionId });
    await sleep(50);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', modifiers: 2, windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86 }, { sessionId });
    return;
  }
  if (process.platform === 'darwin') {
    spawnSync('osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down']);
  } else {
    spawnSync('xdotool', ['key', 'ctrl+v']);
  }
}"""
    edits.append(("sendPaste", old, new, 1))

# ------------------------------------------------- 7. v2: re-focus before paste
if not has_v2:
    old = """async function pasteFromClipboardInEditor(session: ChromeSession): Promise<void> {
  console.log('[wechat] Pasting content...');
  await sendPaste(session.cdp, session.sessionId);
  await sleep(1000);
}"""
    new = """async function pasteFromClipboardInEditor(session: ChromeSession): Promise<void> {
  console.log('[wechat] Pasting content...');
  // [wechat-flow-patch v2] Creating and closing the throwaway file:// tab resets
  // this page's DOM focus, so the CDP paste command had no editable target and
  // was dropped. Re-focus the BODY editor right before pasting; keep an existing
  // in-body selection (the image-placeholder flow relies on it) and otherwise
  // put the caret at the end.
  try {
    await session.cdp.send('Runtime.evaluate', {
      expression: `(function(){
        var e = ${WF_BODY_EDITOR_EXPR};
        if (!e) return false;
        var s = window.getSelection();
        var inBody = !!s && s.rangeCount > 0 && !!s.anchorNode && e.contains(s.anchorNode);
        e.focus();
        if (!inBody) {
          var r = document.createRange();
          r.selectNodeContents(e);
          r.collapse(false);
          s.removeAllRanges();
          s.addRange(r);
        }
        return document.activeElement === e;
      })()`,
      returnByValue: true,
    }, { sessionId: session.sessionId });
  } catch (err) {
    console.warn('[wechat] refocus before paste failed:', err instanceof Error ? err.message : String(err));
  }
  await sleep(250);
  await sendPaste(session.cdp, session.sessionId);
  await sleep(1000);
}"""
    edits.append(("refocus-before-paste (v2)", old, new, 1))

failed = False
for name, old, new, want in edits:
    got = src.count(old)
    if got != want:
        print(f"✗ {name}: expected {want} occurrence(s), found {got} — file changed upstream? aborting")
        failed = True
        continue
    src = src.replace(old, new)
    print(f"· {name}: {got} site(s) patched")

if failed:
    print("! aborting; original left untouched")
    sys.exit(2)

open(path, "w", encoding="utf-8").write(src)
print("✓ patch applied")
PY

# syntax check
if command -v bun >/dev/null 2>&1; then
  bun build --no-bundle "$TARGET" >/dev/null 2>&1 && echo "✓ syntax ok" || echo "⚠ bun could not parse the patched file (check manually)"
fi
