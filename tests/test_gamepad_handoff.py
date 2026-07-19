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


if __name__ == "__main__":
    for fn in (test_repromotion_reuses_pad, test_fresh_session_still_gets_devices):
        fn()
    print()
    if FAILURES:
        print("FAILED: %s" % ", ".join(FAILURES))
        sys.exit(1)
    print("all gamepad-handoff tests passed")
