#!/usr/bin/env python3
"""Game-mode (gamescope / Big Picture) pointer input: the {t:'gm'} verb.

Run: python3 tests/test_gamemode_input.py

The portal (xdg-desktop-portal RemoteDesktop) is absent in Game Mode, so
absolute menu navigation rides `xdotool` on gamescope's Xwayland instead. This
pins the §6 requirements for that new, security-critical surface — all
pure-stdlib, no box, no xdotool actually run:

  1. DISPATCH ({t:'gm'} on /ws/gamepad, mirroring {t:'ma'}):
       - a NON-HOLDER's frame is DROPPED (the holder gate) — nothing runs;
       - out-of-range / non-numeric / missing coords are DROPPED (nothing runs);
       - a good frame forwards the validated coords + looked-up button;
       - the session stays alive across all of them.
  2. POINTER (_gamescope_pointer -> the xdotool argv):
       - the exact argv is agent-chosen constants + pure-digit clamped coords;
       - an UNKNOWN button key never reaches argv (looked up, default '1');
       - coords are CLAMPED inside the display (a known-answer control);
       - degrade-closed: absent xdotool OR no live gamescope socket -> nothing runs
         (two-directional: fires in game mode, no-ops in desktop mode).
"""
import importlib.util
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location(
    "couchsided", os.path.join(ROOT, "agent", "couchsided.py"))
cs = importlib.util.module_from_spec(_spec)
sys.modules["couchsided"] = cs
_spec.loader.exec_module(cs)

FAILURES = []


def check(name, got, want):
    if got == want:
        print("  PASS  %s" % name)
    else:
        print("  FAIL  %s (got %r, want %r)" % (name, got, want))
        FAILURES.append(name)


# Save everything we monkeypatch so a failure can't leak into another test file
# (these are module globals on the shared couchsided module).
_saved = {
    "which": cs.shutil.which,
    "run": cs.subprocess.run,
    "socks": cs._wayland_display_sockets,
    "geom": cs._gamescope_geometry,
    "wsend_json": cs._wsend_json,
    "wsend_op": cs._wsend_op,
    "pointer": cs._gamescope_pointer,
}

try:
    # --- 1. DISPATCH: holder gate + coord validation + tolerance --------------
    print("1. {t:'gm'}: holder gate + coord validation")
    cs._wsend_json = lambda entry, obj: None
    cs._wsend_op = lambda entry, op, payload=b"": None
    PTR = []
    cs._gamescope_pointer = (
        lambda nx, ny, click=False, btn_key=None: PTR.append((nx, ny, click, btn_key)))

    class _Stub:
        mock = True
        _MOUSE_TYPES = cs.Handler._MOUSE_TYPES
        _KEYBOARD_TYPES = cs.Handler._KEYBOARD_TYPES
        _CONTROL_TYPES = cs.Handler._CONTROL_TYPES
        _PORTAL_BTNS = cs.Handler._PORTAL_BTNS
        _handle_portal_abs = cs.Handler._handle_portal_abs
        _handle_portal_btn = cs.Handler._handle_portal_btn
        _handle_gamemode_abs = cs.Handler._handle_gamemode_abs
        _handle_kt = cs.Handler._handle_kt
        _gamepad_message = cs.Handler._gamepad_message

    def feed(entry, msg):
        PTR.clear()
        return _Stub()._gamepad_message(None, entry, json.dumps(msg).encode())

    held = {"held": True}
    waiter = {"held": False}

    # holder gate: a non-holder's frame reaches xdotool never
    feed(waiter, {"t": "gm", "x": 0.5, "y": 0.5})
    check("non-holder {gm} dropped (nothing runs)", PTR, [])

    # good move-only forwards the coords, no click
    feed(held, {"t": "gm", "x": 0.25, "y": 0.75})
    check("holder {gm} forwards move", PTR, [(0.25, 0.75, False, None)])

    # good tap forwards click + looked-up button key
    feed(held, {"t": "gm", "x": 0.5, "y": 0.5, "click": True, "k": "l"})
    check("holder {gm} tap forwards click+key", PTR, [(0.5, 0.5, True, "l")])

    # out-of-range / non-numeric / missing coords are all dropped
    feed(held, {"t": "gm", "x": 1.5, "y": 0.5})
    check("out-of-range x dropped", PTR, [])
    feed(held, {"t": "gm", "x": "0.5", "y": 0.5})
    check("string x dropped", PTR, [])
    feed(held, {"t": "gm", "y": 0.5})
    check("missing x dropped", PTR, [])
    feed(held, {"t": "gm", "x": -0.1, "y": 0.5})
    check("negative x dropped", PTR, [])

    # the session stays alive across all of these (returns True, never closes)
    check("{gm} keeps the session alive",
          feed(held, {"t": "gm", "x": 0.1, "y": 0.1}), True)

    # --- 2. POINTER: the xdotool argv + degrade-closed ------------------------
    print()
    print("2. _gamescope_pointer: argv correctness + degrade closed")
    cs._gamescope_pointer = _saved["pointer"]   # section 1 stubbed it; use the real one
    RUN = []
    cs.subprocess.run = lambda argv, **kw: RUN.append(list(argv))
    cs.shutil.which = lambda name: "/usr/bin/xdotool"
    cs._wayland_display_sockets = lambda: ["gamescope-0", "gamescope-0-ei"]
    cs._gamescope_geometry = lambda: (1920, 1080)

    def run_ptr(*a, **k):
        RUN.clear()
        cs._gamescope_pointer(*a, **k)
        return RUN

    # happy path: exact argv, agent constants + pure-digit clamped coords
    check("move+click argv exact",
          run_ptr(0.5, 0.5, click=True, btn_key="l"),
          [["xdotool", "mousemove", "960", "540", "click", "1"]])

    # move-only: no click subcommand
    check("move-only argv (no click)",
          run_ptr(0.0, 1.0), [["xdotool", "mousemove", "0", "1079"]])

    # UNKNOWN button key never reaches argv — looked up, default '1'
    got = run_ptr(0.5, 0.5, click=True, btn_key="pwn; rm -rf /")
    check("unknown button -> default '1'", got, [["xdotool", "mousemove", "960", "540", "click", "1"]])
    check("client button string never in argv",
          any("pwn" in tok for tok in got[0]), False)

    # right/middle map to 3/2
    check("right button -> 3",
          run_ptr(0.5, 0.5, click=True, btn_key="r")[0][-1], "3")
    check("middle button -> 2",
          run_ptr(0.5, 0.5, click=True, btn_key="m")[0][-1], "2")

    # clamp control: an answer we already know — 0.999999*1920 = 1919.998 -> 1919,
    # never 1920 (off the display).
    check("clamp: 0.999999 x 1920 -> 1919, not 1920",
          run_ptr(0.999999, 0.0)[0][2], "1919")

    # degrade closed: absent xdotool -> nothing runs
    cs.shutil.which = lambda name: None
    check("absent xdotool -> nothing runs", run_ptr(0.5, 0.5, click=True), [])
    cs.shutil.which = lambda name: "/usr/bin/xdotool"

    # degrade closed: DESKTOP mode (no gamescope-* socket) -> nothing runs
    cs._wayland_display_sockets = lambda: ["wayland-0"]
    check("desktop mode (no gamescope socket) -> nothing runs",
          run_ptr(0.5, 0.5, click=True), [])
    cs._wayland_display_sockets = lambda: ["gamescope-0"]

    # degrade closed: unreadable geometry -> nothing runs
    cs._gamescope_geometry = lambda: None
    check("no geometry -> nothing runs", run_ptr(0.5, 0.5, click=True), [])

finally:
    cs.shutil.which = _saved["which"]
    cs.subprocess.run = _saved["run"]
    cs._wayland_display_sockets = _saved["socks"]
    cs._gamescope_geometry = _saved["geom"]
    cs._wsend_json = _saved["wsend_json"]
    cs._wsend_op = _saved["wsend_op"]
    cs._gamescope_pointer = _saved["pointer"]

print()
if FAILURES:
    print("FAILED: %s" % ", ".join(FAILURES))
    sys.exit(1)
print("all game-mode input tests passed")
