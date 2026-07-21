#!/usr/bin/env python3
"""The desktop switch must honour the box's CONFIGURED session, not force one.

Run: python3 tests/test_desktop_session.py

SteamOS ships both desktop sessions, and steamos-session-select maps the bare
"plasma" arg to the X11 one:

    plasma)         steamosctl switch-to-desktop-mode plasmax11.desktop
    plasma-wayland) steamosctl switch-to-desktop-mode plasma.desktop

We passed "plasma" (and hardcoded plasmax11.desktop in _session_to_desktop), so
every Couch Mode return and every "Switch to Desktop" silently downgraded a
Wayland-configured box to X11. Measured on a real Steam Deck, SteamOS
20260701.2:

    steamosctl get-default-desktop-session -> plasma.desktop   (Wayland)
    loginctl show-session ... -p Type       -> x11             (what we forced)

The user noticed their desktop had changed and had no idea we had done it.

DEGRADE CLOSED is the load-bearing property here: any read failure, or a session
name not on the frozen allowlist, must fall back to the X11 pair that shipped
before -- a box we cannot read must behave exactly as it did.

Pure stdlib, no pytest.
"""
import importlib.util
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location(
    "couchsided", os.path.join(ROOT, "agent", "couchsided.py"))
cs = importlib.util.module_from_spec(_spec)
sys.modules["couchsided"] = cs
_spec.loader.exec_module(cs)

PASS = "  \033[32mPASS\033[0m"
FAIL = "  \033[31mFAIL\033[0m"
_fail = []


def check(cond, label):
    print((PASS if cond else FAIL) + "  " + label)
    if not cond:
        _fail.append(label)


class _Run:
    def __init__(self, stdout="", raise_=False):
        self.stdout, self.raise_ = stdout, raise_

    def __call__(self, *a, **k):
        if self.raise_:
            raise OSError("steamosctl missing")
        class R:
            pass
        r = R()
        r.stdout = self.stdout
        r.returncode = 0
        return r


def _with_default(stdout="", raise_=False):
    orig = cs.subprocess.run
    cs.subprocess.run = _Run(stdout, raise_)
    try:
        return cs._default_desktop_session()
    finally:
        cs.subprocess.run = orig


def test_wayland_box_is_left_on_wayland():
    print("a Wayland-configured box gets the Wayland session")
    session, arg = _with_default("plasma.desktop\n")
    check(session == "plasma.desktop", "session file is plasma.desktop")
    check(arg == "plasma-wayland",
          "select arg is plasma-wayland, NOT the bare 'plasma' that means X11")


def test_x11_box_stays_x11():
    """CONTROL. An X11-configured box must be unaffected -- this fix is about
    not overriding the user, in either direction."""
    print("control: an X11-configured box still gets X11")
    session, arg = _with_default("plasmax11.desktop\n")
    check(session == "plasmax11.desktop", "session file is plasmax11.desktop")
    check(arg == "plasma", "select arg is the bare 'plasma' (X11)")


def test_unreadable_degrades_closed():
    print("an unreadable or unknown default degrades to the shipped X11 pair")
    for label, kw in (("command raises", {"raise_": True}),
                      ("empty output", {"stdout": ""}),
                      ("unknown name", {"stdout": "something-else.desktop\n"}),
                      ("junk", {"stdout": "; rm -rf /\n"})):
        session, arg = _with_default(**kw)
        check(session == "plasmax11.desktop" and arg == "plasma",
              "%s -> falls back to the previously shipped X11 pair" % label)


def test_never_passes_an_unvetted_name():
    """The session name comes from the system, not a client -- but it still must
    only ever SELECT a known value, never be interpolated through."""
    print("a hostile default name is never passed through")
    session, arg = _with_default("$(reboot).desktop\n")
    check(session in cs._DESKTOP_SESSIONS, "returned name is on the allowlist")
    check(arg in set(cs._DESKTOP_SESSIONS.values()), "returned arg is on the allowlist")


def test_injected_action_uses_the_resolved_arg():
    print("the injected Switch to Desktop action carries the resolved arg")
    orig_which, orig_run = cs.shutil.which, cs.subprocess.run
    cs.shutil.which = lambda *a, **k: "/usr/bin/steamos-session-select"
    cs.subprocess.run = _Run("plasma.desktop\n")
    cs.ACTIONS, cs.ACTION_ORDER = {}, []
    try:
        cs._inject_session_actions()
    finally:
        cs.shutil.which, cs.subprocess.run = orig_which, orig_run
    cmd = (cs.ACTIONS.get("switch-desktop") or {}).get("cmd")
    check(cmd == ["steamos-session-select", "plasma-wayland"],
          "action cmd targets Wayland on a Wayland box (got %r)" % (cmd,))
    check(cs.ACTIONS["switch-desktop"]["cmd"] is not
          cs.SESSION_ACTIONS["switch-desktop"]["cmd"],
          "and the static SESSION_ACTIONS spec was not mutated")


if __name__ == "__main__":
    test_wayland_box_is_left_on_wayland()
    test_x11_box_stays_x11()
    test_unreadable_degrades_closed()
    test_never_passes_an_unvetted_name()
    test_injected_action_uses_the_resolved_arg()
    print()
    if _fail:
        print("FAILED: %d" % len(_fail))
        for f in _fail:
            print("  - " + f)
        raise SystemExit(1)
    print("all desktop-session tests passed")
