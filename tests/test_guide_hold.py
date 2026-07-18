#!/usr/bin/env python3
"""Unit tests for the guide-button hold trigger (controller -> Couch Mode).

Run: python3 tests/test_guide_hold.py

No pytest, no deps — the agent is pure stdlib and so is this, so CI can run it
straight after py_compile.

Why these tests exist: the trigger fires a SESSION SWITCH, which tears down the
user's desktop and any unsaved work. The two ways that goes wrong are (a) firing
when it shouldn't and (b) matching an emulated pad. Both are covered here
against the real functions, because neither is observable in a --mock smoke test
and both need real hardware to catch otherwise.
"""
import importlib.util
import os
import struct
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


def _press(state, fd, value, t):
    """Apply one BTN_MODE event exactly as _guide_read would."""
    if value == 1:
        state[fd]["down_at"] = t
    elif value == 0:
        state[fd]["down_at"] = None


def _state(n=1):
    return {i: {"event": "event%d" % i, "uniq": "", "name": "pad%d" % i,
                "down_at": None}
            for i in range(n)}


# --------------------------------------------------------------------------
# Real-vs-emulated discrimination. The catastrophic failure mode: the agent
# creates its OWN pad named "Microsoft X-Box 360 pad" on every phone WebSocket
# connect, so a filter that matches it would tear down the desktop session every
# time someone opens the app. Sample below is real hardware output.
# --------------------------------------------------------------------------
REAL_DUMP = '''\
I: Bus=0003 Vendor=1a86 Product=e310 Version=0043
N: Name="Legion Go S"
P: Phys=usb-0000:c3:00.4-1/input0
S: Sysfs=/devices/pci0000:00/0000:c3:00.4/usb3/3-1/3-1:1.1/input/input12
U: Uniq=
H: Handlers=event2 js0
B: EV=20000b
B: KEY=7cdb000000000000 0 0 0 0

I: Bus=0003 Vendor=28de Product=11ff Version=0001
N: Name="Microsoft X-Box 360 pad 0"
P: Phys=
S: Sysfs=/devices/virtual/input/input958
U: Uniq=
H: Handlers=event17 js1
B: EV=20000b
B: KEY=7cdb000000000000 0 0 0 0

I: Bus=0005 Vendor=045e Product=0b22 Version=0522
N: Name="Xbox Wireless Controller"
P: Phys=ac:f2:3c:8b:64:fe
S: Sysfs=/devices/virtual/misc/uhid/0005:045E:0B22.000A/input/input962
U: Uniq=44:16:22:1f:74:5d
H: Handlers=sysrq kbd event20 js2
B: EV=30001b
B: KEY=7fff000000000000 1000000000000 8000000000 e080ffdf01cfffff fffffffffffffffe

I: Bus=0003 Vendor=054c Product=0ce6 Version=8111
N: Name="Sony Interactive Entertainment DualSense Wireless Controller"
P: Phys=
S: Sysfs=/devices/pci0000:00/0000:c3:00.3/usb5/5-2/5-2:1.0/0003:054C:0CE6.000D/input/input980
U: Uniq=14:3a:9a:1b:e9:01
H: Handlers=event24 js4
B: EV=20000b
B: KEY=7fdb000000000000 0 0 0 0

I: Bus=0003 Vendor=054c Product=0ce6 Version=8111
N: Name="Sony Interactive Entertainment DualSense Wireless Controller Motion Sensors"
P: Phys=
S: Sysfs=/devices/pci0000:00/0000:c3:00.3/usb5/5-2/5-2:1.0/0003:054C:0CE6.000D/input/input981
U: Uniq=14:3a:9a:1b:e9:01
H: Handlers=event25 js5
B: EV=9

I: Bus=0019 Vendor=0000 Product=0005 Version=0000
N: Name="Lid Switch"
P: Phys=PNP0C0D/button/input0
S: Sysfs=/devices/LNXSYSTM:00/button/input0
U: Uniq=
H: Handlers=event1
B: EV=21
'''


def test_pad_discrimination():
    print("real vs emulated pad discrimination")
    recs = cs._parse_input_devices(REAL_DUMP)
    check("parses all 6 records", len(recs), 6)

    # Drive the REAL list_real_pads() by pointing it at a fixture file, rather
    # than reimplementing its filter here — a local copy of the logic passes
    # even when the shipped filter has changed underneath it.
    import tempfile
    fd, path = tempfile.mkstemp()
    with os.fdopen(fd, "w") as f:
        f.write(REAL_DUMP)
    orig = cs._PROC_INPUT_DEVICES
    try:
        cs._PROC_INPUT_DEVICES = path
        names = [p["name"] for p in cs.list_real_pads()]
    finally:
        cs._PROC_INPUT_DEVICES = orig
        os.unlink(path)
    check("real wired pad accepted (Phys set, Uniq EMPTY)",
          "Legion Go S" in names, True)
    check("real Bluetooth pad accepted (under /devices/virtual via uhid)",
          "Xbox Wireless Controller" in names, True)
    # The one that matters most.
    check("emulated pad REJECTED (no Phys, no Uniq)",
          "Microsoft X-Box 360 pad 0" in names, False)
    check("non-joystick (Lid Switch) rejected", "Lid Switch" in names, False)
    # A USB DualSense registers TWO js devices sharing one Uniq. Only the pad
    # declares BTN_MODE; the Motion Sensors node declares no keys at all. Without
    # the key-bitmask test the same controller is listed twice in the app.
    check("DualSense pad accepted (empty Phys, Uniq set)",
          "Sony Interactive Entertainment DualSense Wireless Controller" in names,
          True)
    check("DualSense Motion Sensors sibling REJECTED",
          any("Motion Sensors" in n for n in names), False)
    check("exactly 3 real pads accepted", len(names), 3)


def test_declares_key():
    print("BTN_MODE capability filter")
    recs = {r["name"]: r for r in cs._parse_input_devices(REAL_DUMP)}
    # /proc prints 64-bit words most-significant FIRST, so bit 316 lives in the
    # first of five words (316 // 64 == 4 -> index 4 from the end).
    check("Xbox pad declares BTN_MODE",
          cs._declares_key(recs["Xbox Wireless Controller"], cs.BTN_MODE), True)
    check("DualSense declares BTN_MODE",
          cs._declares_key(
              recs["Sony Interactive Entertainment DualSense Wireless Controller"],
              cs.BTN_MODE), True)
    check("Motion Sensors (no KEY line) declares nothing",
          cs._declares_key(
              recs["Sony Interactive Entertainment DualSense Wireless Controller "
                   "Motion Sensors"], cs.BTN_MODE), False)
    check("Lid Switch does not declare BTN_MODE",
          cs._declares_key(recs["Lid Switch"], cs.BTN_MODE), False)
    # A device whose bitmask is too short must not index out of range.
    check("short bitmask is handled, not crashed",
          cs._declares_key({"keybits": ["7fff000000000000"]}, cs.BTN_MODE), False)
    check("garbage bitmask is handled, not crashed",
          cs._declares_key({"keybits": ["zz", "0", "0", "0", "0"]}, cs.BTN_MODE),
          False)

    lg = recs["Legion Go S"]
    check("Phys containing colons survives parsing",
          lg["phys"], "usb-0000:c3:00.4-1/input0")
    xb = recs["Xbox Wireless Controller"]
    check("Uniq (pad MAC, stable across BT reconnect) parsed",
          xb["uniq"], "44:16:22:1f:74:5d")
    check("js token matched by prefix, not equality ('js2' not 'js')",
          any(t.startswith("js") for t in xb["handlers"]), True)
    ds = recs["Sony Interactive Entertainment DualSense Wireless Controller"]
    check("DualSense over USB has EMPTY Phys (Phys-only rule would reject it)",
          ds["phys"], "")


def test_favourite_filter():
    print("favourite-pad filter")
    pad = {"uniq": "44:16:22:1F:74:5D", "phys": "x", "name": "p", "event": "event20"}
    other = {"uniq": "aa:bb:cc:dd:ee:ff", "phys": "x", "name": "q", "event": "event21"}
    check("empty uniq matches any real pad", cs._guide_pad_matches(pad, ""), True)
    check("favourite matches case-insensitively",
          cs._guide_pad_matches(pad, "44:16:22:1f:74:5d"), True)
    # Fail CLOSED: the user sets uniq to EXCLUDE another pad, so falling back to
    # "any pad" would re-admit exactly what they excluded.
    check("non-favourite pad excluded",
          cs._guide_pad_matches(other, "44:16:22:1f:74:5d"), False)


def test_hold_timing():
    print("hold timing")
    cs.CONFIG_GUIDE = {"enabled": True, "hold_ms": 1200, "uniq": ""}
    check("threshold reads from config", cs._guide_hold_s(), 1.2)

    s = _state()
    _press(s, 0, 1, 100.0)
    _press(s, 0, 0, 100.2)
    check("quick TAP does not fire (Steam keeps the tap)",
          cs._guide_due(s, 101.5), False)

    s = _state()
    _press(s, 0, 1, 100.0)
    check("hold past threshold fires", cs._guide_due(s, 101.3), True)

    s = _state()
    _press(s, 0, 1, 100.0)
    check("hold under threshold does not fire yet",
          cs._guide_due(s, 101.1), False)

    s = _state(2)
    _press(s, 0, 1, 100.0)
    _press(s, 1, 1, 100.1)
    check("two pads held -> exactly one fire", cs._guide_due(s, 101.4), True)
    check("...and no re-fire on the next tick", cs._guide_due(s, 101.5), False)

    s = _state()
    _press(s, 0, 1, 100.0)
    cs._guide_due(s, 100.0 + cs._GUIDE_STALE_HOLD_S + 1)
    check("stale press (lost release) expires rather than firing",
          s[0]["down_at"], None)

    # Clamping: a config outside the sane range must not produce a hair trigger.
    cs.CONFIG_GUIDE = {"enabled": True, "hold_ms": 1, "uniq": ""}
    check("hold_ms clamped up to the minimum",
          cs._guide_hold_s(), cs.GUIDE_MIN_HOLD_MS / 1000.0)
    cs.CONFIG_GUIDE = {"enabled": True, "hold_ms": 999999, "uniq": ""}
    check("hold_ms clamped down to the maximum",
          cs._guide_hold_s(), cs.GUIDE_MAX_HOLD_MS / 1000.0)
    cs.CONFIG_GUIDE = {"enabled": True, "hold_ms": "nonsense", "uniq": ""}
    check("non-numeric hold_ms falls back to the default",
          cs._guide_hold_s(), cs.GUIDE_DEFAULTS["hold_ms"] / 1000.0)


def test_event_decoding():
    print("evdev event decoding")
    check("input_event struct is 24 bytes on this arch",
          struct.calcsize(cs._INPUT_EVENT), 24)
    check("BTN_MODE is the guide button (316 / 0x13C)", cs.BTN_MODE, 316)
    # A non-guide keypress must never arm the trigger.
    s = _state()
    packed = struct.pack(cs._INPUT_EVENT, 0, 0, cs.EV_KEY, 0x130, 1)  # BTN_SOUTH
    _s, _us, etype, code, value = struct.unpack(cs._INPUT_EVENT, packed)
    if etype == cs.EV_KEY and code == cs.BTN_MODE:
        _press(s, 0, value, 100.0)
    check("A button does not arm the trigger", cs._guide_due(s, 102.0), False)


def test_config_defaults():
    print("config validation")
    check("trigger is OFF by default (opt-in)",
          cs.GUIDE_DEFAULTS["enabled"], False)
    # A config the agent cannot parse must leave the trigger OFF, not "on".
    for bad in ({"guide": {"enabled": "yes"}},
                {"guide": {"hold_ms": 10}},
                {"guide": {"hold_ms": True}},
                {"guide": {"uniq": 5}},
                {"guide": "not-an-object"}):
        try:
            cs._parse_config(dict(bad, units=[], actions={}))
            check("rejects bad config %r" % (bad,), "accepted", "ConfigError")
        except cs.ConfigError:
            check("rejects bad config %r" % (bad,), "ConfigError", "ConfigError")
        except Exception as e:  # noqa: BLE001
            check("rejects bad config %r" % (bad,), type(e).__name__, "ConfigError")


if __name__ == "__main__":
    for fn in (test_pad_discrimination, test_declares_key,
               test_favourite_filter, test_hold_timing,
               test_event_decoding, test_config_defaults):
        fn()
    print()
    if FAILURES:
        print("FAILED: %s" % ", ".join(FAILURES))
        sys.exit(1)
    print("all guide-hold tests passed")
