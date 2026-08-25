#!/usr/bin/env python3
"""Regression tests for the gamepad handoff device lifecycle.

Run: python3 tests/test_gamepad_handoff.py

Why this exists: _make_holder() used to assign a fresh virtual pad on EVERY
promotion. A session that passed control away and later took it back got a
second pad, orphaning the first with its uinput fd open — a phantom
"Microsoft X-Box 360 pad N" that lived until the agent exited. Three of them
were found on a real box after one afternoon of two-phone handoff testing, and
the resulting controller churn corrupted that box's Steam desktop controller
config (trackpad mapping lost, stick-mouse drift added). The fix is reuse:
a session keeps ONE pad for its whole life.

Pure stdlib, no pytest — same style as test_guide_hold.py so CI just runs it.
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

FAILURES = []


def check(name, got, want):
    if got == want:
        print("  PASS  %s" % name)
    else:
        print("  FAIL  %s (got %r, want %r)" % (name, got, want))
        FAILURES.append(name)


# _make_holder writes hello frames to the session's socket; stub the frame
# senders so the test needs no socket. Everything else runs for real (mock=True
# uses MockGamepad/MockMouse/MockKeyboard, which are plain objects).
_sent = []
cs._wsend_json = lambda entry, obj: _sent.append(obj)
cs._wsend_op = lambda entry, op, payload=b"": None


import json


class _NullLock:
    """entry["slock"] stand-in; _wsend_json is stubbed so it is never contended."""
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class _HandlerStub:
    """Just enough of Handler for _gamepad_message: it reads self.mock and the
    class-level type tables, and nothing else on the instance."""
    mock = True
    _MOUSE_TYPES = cs.Handler._MOUSE_TYPES
    _KEYBOARD_TYPES = cs.Handler._KEYBOARD_TYPES
    _CONTROL_TYPES = cs.Handler._CONTROL_TYPES


def test_repromotion_reuses_pad():
    print("re-promotion reuses the session's pad")
    entry = {"name": "test-phone"}
    ok = cs._make_holder(entry, mock=True)
    check("first promotion succeeds", ok, True)
    first_pad = entry.get("device")
    check("pad created on first promotion", first_pad is not None, True)
    first_mouse = entry.get("mouse")
    first_kbd = entry.get("keyboard")

    # Simulate demotion (control passed away): held drops, devices REMAIN.
    entry["held"] = False

    ok = cs._make_holder(entry, mock=True)
    check("second promotion succeeds", ok, True)
    # The regression: this used to be a NEW object, orphaning first_pad.
    check("same pad object reused (no orphan)",
          entry.get("device") is first_pad, True)
    check("mouse not recreated either", entry.get("mouse") is first_mouse, True)
    check("keyboard not recreated either",
          entry.get("keyboard") is first_kbd, True)
    check("session marked held again", entry.get("held"), True)


def test_nopad_session_never_creates_a_pad():
    """?nopad=1 -> keyboard and mouse, but NO virtual controller.

    The point is not saving ioctls. Creating a pad makes Steam announce
    "controller connected", and destroying it announces again — so a phone that
    foregrounds and backgrounds spams the TV, and a game already running sees a
    SECOND controller that can steal player 1. A client that only sends
    arrows/enter/esc asks not to have one."""
    print("nopad session gets no pad, but keeps mouse + keyboard")
    _sent.clear()
    entry = {"name": "kb-phone", "nopad": True}
    ok = cs._make_holder(entry, mock=True)
    check("promotion succeeds without a pad", ok, True)
    check("NO gamepad created", entry.get("device") is None, True)
    check("mouse still created", entry.get("mouse") is not None, True)
    check("keyboard still created", entry.get("keyboard") is not None, True)
    check("still marked holder", entry.get("held"), True)
    hello = [m for m in _sent if m.get("t") == "hello"]
    check("hello still sent (it IS the you-have-control signal)", len(hello), 1)
    check("hello reports no controller", hello[0].get("dev"), "keyboard only")


def test_nopad_gamepad_frame_is_dropped_not_lazily_created():
    """The load-bearing guard: a button frame must NOT materialise a pad.

    Without it, a nopad session could be tricked into creating the very
    controller it asked to avoid just by sending one button — putting back the
    Steam "controller connected" spam the flag exists to prevent."""
    print("gamepad frames on a nopad session drop instead of creating a pad")
    entry = {"name": "kb-phone", "nopad": True, "held": True,
             "slock": _NullLock()}
    cs._make_holder(entry, mock=True)
    check("no pad before", entry.get("device") is None, True)

    # Drive the REAL dispatch. Handler is a BaseHTTPRequestHandler subclass, so
    # it is never instantiated here — the method is called unbound with a stub
    # carrying only what it touches (self.mock and the type tables).
    stub = _HandlerStub()
    keep = cs.Handler._gamepad_message(
        stub, None, entry, json.dumps({"t": "b", "k": "a", "v": 1}).encode())
    check("frame accepted (session stays alive)", keep, True)
    check("STILL no pad after a button frame", entry.get("device") is None, True)


def test_normal_session_unaffected_by_the_opt_in():
    """An old app sends no nopad param and must be completely unchanged."""
    print("sessions without the flag still get a pad")
    entry = {"name": "old-phone"}          # no 'nopad' key at all
    ok = cs._make_holder(entry, mock=True)
    check("promotion succeeds", ok, True)
    check("pad created as before", entry.get("device") is not None, True)


def test_nopad_release_is_clean():
    """Demoting a pad-less session must not raise, and must keep mouse/kbd."""
    print("releasing a nopad session is clean")
    entry = {"name": "kb-phone", "nopad": True}
    cs._make_holder(entry, mock=True)
    mouse, kbd = entry.get("mouse"), entry.get("keyboard")
    cs._release_devices(entry)             # would raise if it assumed a pad
    check("no pad to release, no crash", entry.get("device") is None, True)
    check("mouse kept for instant re-promotion", entry.get("mouse") is mouse, True)
    check("keyboard kept too", entry.get("keyboard") is kbd, True)


def test_fresh_session_still_gets_devices():
    print("fresh session still gets a pad")
    entry = {"name": "fresh-phone"}
    ok = cs._make_holder(entry, mock=True)
    check("promotion succeeds", ok, True)
    check("pad present", entry.get("device") is not None, True)
    check("mouse pre-created", entry.get("mouse") is not None, True)
    check("keyboard pre-created", entry.get("keyboard") is not None, True)
    hello = [m for m in _sent if m.get("t") == "hello"]
    check("hello sent on promotion", len(hello) >= 1, True)


# --- shared process-lifetime keyboard (the uinput enumeration-settle fix) -----
# A fresh uinput keyboard is enumerated asynchronously by the compositor;
# events sent before that lands are dropped (~2s on gamescope, MEASURED). A
# per-session keyboard paid that settle on every connect, eating the first
# combo. The keyboard is now ONE process-lifetime device reused by every
# session (pad + mouse stay per-session). These lock that in.

def test_keyboard_is_a_shared_singleton_across_sessions():
    print("all sessions share ONE virtual keyboard (pad/mouse stay per-session)")
    cs._SHARED_KEYBOARD = None
    a = {"name": "phone-a"}
    b = {"name": "phone-b"}
    cs._make_holder(a, mock=True)
    cs._make_holder(b, mock=True)
    check("two sessions share one keyboard",
          a.get("keyboard") is b.get("keyboard"), True)
    check("it is the module singleton",
          a.get("keyboard") is cs._SHARED_KEYBOARD, True)
    check("but each session has its OWN pad",
          a.get("device") is not b.get("device"), True)
    check("and its OWN mouse", a.get("mouse") is not b.get("mouse"), True)


def test_cleanup_keeps_shared_keyboard_but_reaps_pad_and_mouse():
    """Teardown must reap this session's pad+mouse but NEVER the shared keyboard
    -- otherwise a waiter dropping off tears the keyboard from the live holder,
    and the next connect re-pays the enumeration settle."""
    print("teardown reaps pad+mouse, keeps the shared keyboard")
    cs._SHARED_KEYBOARD = None
    with cs.GAMEPAD_LOCK:
        cs.GAMEPAD_SESSIONS.clear()
        cs.GAMEPAD_HOLDER = None
    entry = {"name": "phone", "slock": _NullLock()}
    cs._make_holder(entry, mock=True)
    with cs.GAMEPAD_LOCK:
        cs.GAMEPAD_SESSIONS.append(entry)
        cs.GAMEPAD_HOLDER = entry
    pad, mouse, kbd = (entry.get("device"), entry.get("mouse"),
                       entry.get("keyboard"))
    cs.Handler._gamepad_cleanup(_HandlerStub(), entry)
    check("this session's pad destroyed", getattr(pad, "destroyed", False), True)
    check("this session's mouse destroyed",
          getattr(mouse, "destroyed", False), True)
    check("shared keyboard NOT destroyed",
          getattr(kbd, "destroyed", False), False)
    check("singleton still available", cs._SHARED_KEYBOARD is kbd, True)
    nxt = {"name": "phone-2"}
    cs._make_holder(nxt, mock=True)
    check("next session reuses the same keyboard",
          nxt.get("keyboard") is kbd, True)


def test_nopad_session_also_uses_the_shared_keyboard():
    """Keyboard-only (?nopad=1) sessions are the whole point of the fix -- combos
    land on the keyboard -- so they must get the shared singleton too."""
    print("nopad sessions get the shared keyboard")
    cs._SHARED_KEYBOARD = None
    entry = {"name": "kb-phone", "nopad": True}
    cs._make_holder(entry, mock=True)
    check("keyboard is the shared singleton",
          entry.get("keyboard") is cs._SHARED_KEYBOARD, True)
    check("still no pad", entry.get("device") is None, True)


if __name__ == "__main__":
    for fn in (test_repromotion_reuses_pad,
               test_fresh_session_still_gets_devices,
               test_nopad_session_never_creates_a_pad,
               test_nopad_gamepad_frame_is_dropped_not_lazily_created,
               test_normal_session_unaffected_by_the_opt_in,
               test_nopad_release_is_clean,
               test_keyboard_is_a_shared_singleton_across_sessions,
               test_cleanup_keeps_shared_keyboard_but_reaps_pad_and_mouse,
               test_nopad_session_also_uses_the_shared_keyboard):
        fn()
    print()
    if FAILURES:
        print("FAILED: %s" % ", ".join(FAILURES))
        sys.exit(1)
    print("all gamepad-handoff tests passed")
