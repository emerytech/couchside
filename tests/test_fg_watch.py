#!/usr/bin/env python3
"""Unit tests for the Windows foreground-window + caret watcher.

Run: python3 tests/test_fg_watch.py

No pytest, no deps — pure stdlib like the agent, so CI runs it straight after
py_compile.

What this covers and what it CANNOT:
  * The PURE logic — caret-focus decision, window-class filtering, exe-basename
    splitting — is tested directly and runs on any OS.
  * The TICK's edge/on-change dedup is driven with injected fake probes + a
    fresh state dict, so the "push osk once per focus edge" and "push foreground
    once per app change" contracts are proven without Win32.
  * NOT covered here: the actual ctypes calls into user32/kernel32
    (GetGUIThreadInfo, GetForegroundWindow, GetClassNameW, GetWindowTextW,
    OpenProcess/QueryFullProcessImageNameW). ctypes.WinDLL does not exist on this
    macOS CI host, so _caret_query()/_fg_query() return None here by design
    (degrade closed). Those paths need real Windows (box EMERY-PC) to verify:
    that a focused Notepad field raises the app keyboard, and that alt-tabbing
    emits a {"t":"foreground"} frame with the right title/exe.
"""
import importlib.util
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location(
    "couchsided_win", os.path.join(ROOT, "agent", "win", "couchsided-win.py"))
win = importlib.util.module_from_spec(_spec)
sys.modules["couchsided_win"] = win
_spec.loader.exec_module(win)

FAILURES = []


def check(name, got, want):
    if got == want:
        print("  PASS  %s" % name)
    else:
        print("  FAIL  %s (got %r, want %r)" % (name, got, want))
        FAILURES.append(name)


# --------------------------------------------------------------------------
# _caret_field_focused: a field is focused when a caret handle exists OR the
# caret is blinking. Exactly the Mando caret_active rule.
# --------------------------------------------------------------------------
def test_caret_focused():
    print("caret focus decision")
    f = win._caret_field_focused
    B = win.GUI_CARETBLINKING
    check("hwndCaret non-null -> focused", f(0x1234, 0), True)
    check("GUI_CARETBLINKING set -> focused", f(0, B), True)
    check("handle AND blinking -> focused", f(0x1234, B), True)
    check("no caret, no blink -> not focused", f(0, 0), False)
    check("None handle, no blink -> not focused", f(None, 0), False)
    check("other flag bits only -> not focused", f(0, 0x2 | 0x10), False)


# --------------------------------------------------------------------------
# _fg_classify: the two taskbar classes are skipped, the desktop host is named,
# everything else (incl. unknown/empty) is a real window.
# --------------------------------------------------------------------------
def test_classify():
    print("window-class filter")
    f = win._fg_classify
    check("Shell_TrayWnd -> skip", f("Shell_TrayWnd"), "skip")
    check("Shell_SecondaryTrayWnd -> skip", f("Shell_SecondaryTrayWnd"), "skip")
    check("Progman -> desktop", f("Progman"), "desktop")
    check("WorkerW -> desktop", f("WorkerW"), "desktop")
    check("Notepad -> window", f("Notepad"), "window")
    check("unknown class -> window", f("SomeAppWindow"), "window")
    check("empty class -> window", f(""), "window")


# --------------------------------------------------------------------------
# _exe_basename: split on BOTH separators (os.path.basename would miss the
# backslash on POSIX, which is exactly where this test runs).
# --------------------------------------------------------------------------
def test_exe_basename():
    print("exe basename split")
    f = win._exe_basename
    check("backslash path", f(r"C:\Windows\System32\notepad.exe"), "notepad.exe")
    check("forward-slash path", f("C:/Program Files/App/app.exe"), "app.exe")
    check("mixed separators", f(r"C:/Program Files\App\game.exe"), "game.exe")
    check("bare filename", f("explorer.exe"), "explorer.exe")
    check("empty string", f(""), "")
    check("None", f(None), "")


# --------------------------------------------------------------------------
# _fg_watch_tick: the edge/on-change dedup, with injected probes so no Win32 is
# touched. A recorder captures each push.
# --------------------------------------------------------------------------
def _run_tick(caret_seq, fg_seq):
    """Drive one tick per paired (caret, fg) step through a shared state dict.
    Returns the list of ('osk',) / ('fg', title, exe) pushes, in order."""
    pushes = []
    state = {"caret": None, "fg": None}
    steps = list(zip(caret_seq, fg_seq))
    idx = {"i": 0}

    def caret_fn():
        return steps[idx["i"]][0]

    def fg_fn():
        return steps[idx["i"]][1]

    def osk_fn():
        pushes.append(("osk",))

    def fg_notify_fn(info):
        pushes.append(("fg", info.get("title", ""), info.get("exe", "")))

    for i in range(len(steps)):
        idx["i"] = i
        win._fg_watch_tick(caret_fn=caret_fn, fg_fn=fg_fn, osk_fn=osk_fn,
                           fg_notify_fn=fg_notify_fn, state=state)
    return pushes, state


def test_caret_edge():
    print("caret osk edge-trigger + dedup")
    # Not-focused -> focused fires exactly once; staying focused does not refire.
    pushes, _ = _run_tick([False, True, True, True], [None, None, None, None])
    check("one osk on the focus edge, none while held",
          [p for p in pushes if p[0] == "osk"], [("osk",)])
    # Refocus after losing focus fires again.
    pushes, _ = _run_tick([True, False, True], [None, None, None])
    check("re-focus after blur fires again",
          [p for p in pushes if p[0] == "osk"], [("osk",), ("osk",)])
    # First-ever tick already focused (prev None) still counts as an edge.
    pushes, _ = _run_tick([True], [None])
    check("already-focused on first tick fires once",
          [p for p in pushes if p[0] == "osk"], [("osk",)])


def test_caret_unknown_degrades_closed():
    print("caret None (probe failed) pushes nothing, keeps state")
    # None must not fire and must not overwrite a known prior state, so a real
    # focus seen before a probe blip is not mistaken for a fresh edge after it.
    pushes, state = _run_tick([True, None, True], [None, None, None])
    check("None tick does not refire after a held True",
          [p for p in pushes if p[0] == "osk"], [("osk",)])
    check("state preserved across None tick", state["caret"], True)


def test_foreground_on_change():
    print("foreground push on change only")
    fg = [
        {"title": "Untitled - Notepad", "exe": "notepad.exe"},
        {"title": "Untitled - Notepad", "exe": "notepad.exe"},  # same -> no push
        {"title": "game - Steam", "exe": "steam.exe"},          # change -> push
        None,                                                    # probe fail -> no push
        {"title": "game - Steam", "exe": "steam.exe"},           # same as last -> no push
    ]
    pushes, _ = _run_tick([None] * len(fg), fg)
    fgp = [p for p in pushes if p[0] == "fg"]
    check("foreground pushed only on the two distinct apps", fgp,
          [("fg", "Untitled - Notepad", "notepad.exe"),
           ("fg", "game - Steam", "steam.exe")])


def test_query_degrades_closed_off_windows():
    print("ctypes probes degrade closed off Windows")
    # On this macOS host _user32/_kernel32 are None, so both probes must return
    # None/'' without raising -- the whole watcher is inert off Windows.
    check("_caret_query() -> None off Windows", win._caret_query(), None)
    check("_fg_query() -> None off Windows", win._fg_query(), None)
    check("_fg_exe_for_pid(1234) -> '' off Windows", win._fg_exe_for_pid(1234), "")


if __name__ == "__main__":
    for fn in (test_caret_focused, test_classify, test_exe_basename,
               test_caret_edge, test_caret_unknown_degrades_closed,
               test_foreground_on_change, test_query_degrades_closed_off_windows):
        fn()
    print()
    if FAILURES:
        print("FAILED: %s" % ", ".join(FAILURES))
        sys.exit(1)
    print("all fg-watch tests passed")
