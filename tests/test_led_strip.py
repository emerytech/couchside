#!/usr/bin/env python3
"""Tests for the addressable LED STRIP + hardware effects (valve-leds).

Run: python3 tests/test_led_strip.py

A Steam Machine exposes its strip as N kernel nodes `valve-leds[0..16]` whose
driver runs animations IN FIRMWARE via an `effect` attr (patrol/breath/rainbow…).
The agent drives the strip as a whole: the client sends a PREFIX, the members come
from the live listdir filtered by `prefix[<n>]`, and the `effect` VALUE written
must be one the device itself lists in `effect_index`.

The property that matters is the allowlist: an unknown / traversal-shaped prefix,
or a firmware-effect name the device does not publish, must write NOTHING outside
the fixed-literal attrs on the strip's own live members. Pure stdlib, no pytest.
"""
import importlib.util
import os

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT = os.path.join(HERE, "..", "agent", "couchsided.py")
spec = importlib.util.spec_from_file_location("couchsided", AGENT)
cs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cs)

PASS = "  \033[32mPASS\033[0m"
FAIL = "  \033[31mFAIL\033[0m"
_fail = []


def check(cond, label):
    print((PASS if cond else FAIL) + "  " + label)
    if not cond:
        _fail.append(label)


# A fake /sys/class/leds: a 5-node valve-leds strip (RGB, firmware effects) + a
# mono status LED. multi_index proves the writer reorders into device order.
_N = 5
_EFFECT_INDEX = "patrol breath factory normal off rainbow demo manual"
_DELAY_RANGE = "0-20"


def _member(name):
    return {"name": name, "desc": name, "rgb": True, "notable": True,
            "writable": True, "max_brightness": 255,
            "index": ["red", "green", "blue"], "maxint": [255, 255, 255],
            "brightness": 0, "color": {"r": 0, "g": 0, "b": 0}}


_FAKE = {("valve-leds[%d]" % i): _member("valve-leds[%d]" % i) for i in range(_N)}
_FAKE["status:white"] = {"name": "status:white", "desc": "status:white",
    "rgb": False, "notable": True, "writable": True, "max_brightness": 100,
    "index": [], "maxint": [], "brightness": 0, "color": None}


def _install(writes, effect_index=_EFFECT_INDEX):
    saved = {k: getattr(cs, k) for k in
             ("_list_led_names", "_read_led_raw", "_led_realpath_ok",
              "_led_read_attr", "_led_write")}
    cs._list_led_names = lambda: list(_FAKE)
    cs._read_led_raw = lambda n: dict(_FAKE[n]) if n in _FAKE else None
    cs._led_realpath_ok = lambda n: True

    def _read_attr(name, attr):
        if attr == "effect_index":
            return effect_index
        if attr == "delay_range":
            return _DELAY_RANGE
        if attr == "trigger":
            return "[none]"
        return None
    cs._led_read_attr = _read_attr
    cs._led_write = lambda name, attr, value: writes.append((name, attr, value))

    def restore():
        for k, v in saved.items():
            setattr(cs, k, v)
        with cs._FX_LOCK:
            cs._LED_PERSIST.clear()
    return restore


def test_detect_strip():
    print("strip detection groups valve-leds[N] (>=3 members)")
    writes = []
    restore = _install(writes)
    try:
        strips = cs._led_strips()
        check("valve-leds" in strips, "valve-leds detected as a strip")
        check(len(strips["valve-leds"]) == _N, "all %d members grouped" % _N)
        check([int(n[n.index("[") + 1:-1]) for n in strips["valve-leds"]] == list(range(_N)),
              "members sorted by index")
        check("status:white" not in strips, "the lone status LED is not a strip")
    finally:
        restore()


def test_allowlist_unknown_prefix():
    print("allowlist: unknown / bad prefix writes NOTHING")
    writes = []
    restore = _install(writes)
    try:
        for bad in ("nope", "valve-leds[", "../x", "", None, 123):
            writes.clear()
            res = cs.apply_strip_effect(bad, "scanner", {"r": 255, "g": 0, "b": 0}, 70, 100)
            check(res is None, "refused prefix %r" % (bad,))
            check(not writes, "nothing written for %r" % (bad,))
    finally:
        restore()


def test_scanner_writes_firmware_patrol():
    print("scanner -> firmware effect=patrol on EVERY member + delay + colour")
    writes = []
    restore = _install(writes)
    try:
        res = cs.apply_strip_effect("valve-leds", "scanner", {"r": 255, "g": 0, "b": 0}, 70, 100)
        check(res and res.get("ok") and res["active"]["effect"] == "scanner",
              "scanner accepted, active reports it")
        for i in range(_N):
            n = "valve-leds[%d]" % i
            check((n, "effect", "patrol") in writes, "%s set effect=patrol" % n)
            check(any(w[0] == n and w[1] == "delay" for w in writes), "%s got a delay" % n)
            check(any(w[0] == n and w[1] == "multi_intensity" for w in writes),
                  "%s got the base colour" % n)
        # only ever the fixed-literal attrs, only on strip members
        allowed_attr = {"effect", "enabled", "delay", "brightness", "multi_intensity", "trigger"}
        members = {"valve-leds[%d]" % i for i in range(_N)}
        check(all(w[1] in allowed_attr for w in writes), "only fixed-literal attrs written")
        check(all(w[0] in members for w in writes), "only strip members written")
    finally:
        restore()


def test_effect_value_must_be_published():
    print("a firmware effect the device does NOT list is never written as `effect`")
    writes = []
    # this device only publishes 'normal off manual' -- NOT patrol/breath/rainbow
    restore = _install(writes, effect_index="normal off manual")
    try:
        res = cs.apply_strip_effect("valve-leds", "scanner", {"r": 255, "g": 0, "b": 0}, 70, 100)
        check(res and res.get("ok"), "still accepted (falls back to manual paint)")
        check(not any(w[1] == "effect" and w[2] == "patrol" for w in writes),
              "patrol NEVER written when the device doesn't list it")
        check(any(w[1] == "effect" and w[2] == "manual" for w in writes)
              or all(w[1] != "effect" for w in writes),
              "fell back to manual (or wrote no effect), not an unlisted value")
    finally:
        restore()


def test_solid_and_off():
    print("solid = manual paint; off = brightness 0")
    writes = []
    restore = _install(writes)
    try:
        cs.apply_strip_effect("valve-leds", "solid", {"r": 0, "g": 200, "b": 0}, 50, 80)
        check(any(w[1] == "effect" and w[2] == "manual" for w in writes),
              "solid puts the strip in manual mode")
        check(any(w[1] == "multi_intensity" for w in writes), "solid paints the colour")
        writes.clear()
        cs.apply_strip_effect("valve-leds", "off", None, 50, 100)
        check(all(w[2] == "0" for w in writes if w[1] == "brightness"),
              "off writes brightness 0")
        check(not any(w[1] == "effect" and w[2] == "patrol" for w in writes),
              "off never leaves a running firmware effect")
    finally:
        restore()


def test_delay_maps_speed():
    print("speed -> device delay (higher speed = smaller delay), clamped to range")
    d_fast = cs._strip_delay("valve-leds[0]", 100)   # need real read; fake it
    # use a fake read for delay_range
    saved = cs._led_read_attr
    cs._led_read_attr = lambda name, attr: _DELAY_RANGE if attr == "delay_range" else None
    try:
        check(cs._strip_delay("x", 100) == 0, "speed 100 -> delay 0 (fastest)")
        check(cs._strip_delay("x", 1) == 20, "speed 1 -> delay 20 (slowest)")
        mid = cs._strip_delay("x", 50)
        check(9 <= mid <= 11, "speed 50 -> mid delay (%s)" % mid)
    finally:
        cs._led_read_attr = saved


def test_strips_in_payload():
    print("GET /api/leds advertises strips (mock)")
    st = cs.leds_state(True)
    strips = st.get("strips")
    check(isinstance(strips, list) and strips, "mock payload lists a strip")
    vs = next((s for s in strips if s["prefix"] == "valve-leds"), None)
    check(vs and vs["count"] >= 3 and vs["rgb"], "valve-leds strip with RGB members")
    check(vs and "patrol" in vs["hw_effects"], "hw_effects advertised (patrol)")


if __name__ == "__main__":
    test_detect_strip()
    test_allowlist_unknown_prefix()
    test_scanner_writes_firmware_patrol()
    test_effect_value_must_be_published()
    test_solid_and_off()
    test_delay_maps_speed()
    test_strips_in_payload()
    print()
    if _fail:
        print("FAILED: %d" % len(_fail))
        for f in _fail:
            print("  - " + f)
        raise SystemExit(1)
    print("all led-strip tests passed")
