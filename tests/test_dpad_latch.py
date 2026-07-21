#!/usr/bin/env python3
"""The d-pad must never be left LATCHED when a session loses its pad.

Run: python3 tests/test_dpad_latch.py

Why this exists: the d-pad is not an edge-triggered key. DPAD_MAP maps each
direction to an ABSOLUTE axis (ABS_HAT0X/ABS_HAT0Y) with a non-zero value, so
"pressed" is a LATCHED state that persists until something writes 0. Nothing
re-zeroes it on its own -- there is no stuck-button watchdog, and the 12s idle
reap never fires while the app pings every 5s. Exactly one missing release
therefore pins the axis and the consumer (Steam/SDL) auto-repeats it forever.
That is the "swipe sticks and keeps going that direction" bug.

_release_devices() demotes a session by destroying its pad. It carefully zeroes
the MOUSE buttons two lines later and its docstring reasons about precisely
this hazard for the mouse and the keyboard -- the pad case was simply never
considered, so a demote mid-swipe tore the device down with a direction still
asserted.

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

FAILURES = []


def check(cond, name):
    print(("  PASS  " if cond else "  FAIL  ") + name)
    if not cond:
        FAILURES.append(name)


cs._wsend_json = lambda entry, obj: None
cs._wsend_op = lambda entry, op, payload=b"": None


class RecordingPad:
    """Stands in for the virtual pad, remembering every event and the ORDER of
    the destroy relative to them (zeroing after destroy would be useless)."""

    def __init__(self):
        self.events = []
        self.destroyed = False
        self.events_after_destroy = 0

    def emit(self, events):
        if self.destroyed:
            self.events_after_destroy += len(events)
        self.events.extend(events)

    def destroy(self):
        self.destroyed = True


def _hat_writes(pad):
    return [(c, v) for (t, c, v) in pad.events
            if t == cs.EV_ABS and c in (cs.ABS_HAT0X, cs.ABS_HAT0Y)]


def test_demote_zeroes_the_hat():
    print("a session demoted mid-swipe does not leave its d-pad latched")
    pad = RecordingPad()
    # Mid-swipe: the phone pressed 'du' and its release never arrived.
    code, val = cs.DPAD_MAP["du"]
    pad.emit([(cs.EV_ABS, code, val)])

    entry = {"name": "phone", "device": pad, "mouse": None, "keyboard": None}
    cs._release_devices(entry)

    check(pad.destroyed, "the pad is still destroyed")
    check(pad.events_after_destroy == 0, "and it was zeroed BEFORE the destroy")
    check(entry["device"] is None, "the entry's device reference is cleared")

    hats = _hat_writes(pad)
    check(hats[0] == (cs.ABS_HAT0Y, val), "the swipe's latch was recorded")
    check((cs.ABS_HAT0Y, 0) in hats, "the held axis was zeroed")
    # BOTH axes, not just the one we know about: the demote path has no idea
    # which direction was in flight.
    check((cs.ABS_HAT0X, 0) in hats, "the other axis was zeroed too")
    check(hats[-1][1] == 0, "the LAST hat write is a zero, so nothing stays latched")


def test_demote_zeroes_buttons():
    print("and face/shoulder buttons are released too")
    pad = RecordingPad()
    pad.emit([(cs.EV_KEY, cs.BTN_CODES["a"], 1)])
    entry = {"name": "phone", "device": pad, "mouse": None, "keyboard": None}
    cs._release_devices(entry)
    zeroed = {c for (t, c, v) in pad.events if t == cs.EV_KEY and v == 0}
    check(set(cs.BTN_CODES.values()) <= zeroed, "every declared button was zeroed")


def test_missing_device_is_safe():
    """CONTROL. A session with no pad must not explode -- and this also proves
    the assertions above are not passing merely because the code no-ops."""
    print("control: demoting a session that has no pad is a no-op, not a crash")
    entry = {"name": "phone", "device": None, "mouse": None, "keyboard": None}
    try:
        cs._release_devices(entry)
        check(True, "no exception")
    except Exception as e:
        check(False, "no exception (raised %r)" % (e,))


if __name__ == "__main__":
    test_demote_zeroes_the_hat()
    test_demote_zeroes_buttons()
    test_missing_device_is_safe()
    print()
    if FAILURES:
        print("FAILED: %d" % len(FAILURES))
        for f in FAILURES:
            print("  - " + f)
        raise SystemExit(1)
    print("all dpad-latch tests passed")
