#!/usr/bin/env python3
"""Tests for the reactive LED meters (SignalBar-style): the strip renders LIVE
telemetry — meter_cpu (load length + temperature colour) and meter_battery.

Run: python3 tests/test_led_meters.py

Properties that matter:
  * ALLOWLIST — meter ids are frozen (_LED_METERS ⊂ _LED_EFFECTS & _STRIP_SEQ_EFFECTS);
    an unknown effect starts nothing. Config params are REJECTED not sanitised.
  * DEGRADE CLOSED — an unreadable signal renders DARK (all-None frame), NEVER a
    fabricated fill (§3.7).
  * OBSERVE BOTH STATES — a short bar vs a long bar; a cool colour vs a hot one;
    a full battery green vs a low battery red (§11).
  * PERSISTENCE round-trips and is REVALIDATED on restore (junk meter cfg dropped).
  * The meter rides the existing _seq_* engine, so it inherits the Steam stand-down.

Pure stdlib, no pytest — same style as test_led_strip.py. Never touches real /sys;
telemetry reads are stubbed so the render is deterministic.
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


def _lit(frame):
    return sum(1 for c in frame if c is not None)


# A fake 8-node valve-leds strip so apply_strip_effect has real members.
_N = 8
_FAKE = {("valve-leds[%d]" % i): {"name": "valve-leds[%d]" % i,
    "desc": "valve-leds[%d]" % i, "rgb": True, "notable": True, "writable": True,
    "max_brightness": 255, "index": ["red", "green", "blue"],
    "maxint": [255, 255, 255], "brightness": 0, "color": {"r": 0, "g": 0, "b": 0}}
    for i in range(_N)}


def _install(writes):
    saved = {k: getattr(cs, k) for k in
             ("_list_led_names", "_read_led_raw", "_led_realpath_ok",
              "_led_read_attr", "_led_write", "_seq_ensure_thread", "_meter_read")}
    cs._list_led_names = lambda: list(_FAKE)
    cs._read_led_raw = lambda n: dict(_FAKE[n]) if n in _FAKE else None
    cs._led_realpath_ok = lambda n: True
    cs._led_read_attr = lambda name, attr: "[none]" if attr == "trigger" else None
    cs._led_write = lambda name, attr, value: writes.append((name, attr, value))
    # Do NOT spin the real render thread in a unit test; assert the registered spec.
    cs._seq_ensure_thread = lambda: None
    # Deterministic telemetry unless a test overrides it.
    cs._meter_read = lambda kind, cpu_prev=None: (55.0, 60.0, None)

    def restore():
        for k, v in saved.items():
            setattr(cs, k, v)
        with cs._SEQ_LOCK:
            cs._SEQ_ACTIVE.clear()
        with cs._FX_LOCK:
            cs._LED_PERSIST.clear()
    return restore


def test_meter_frame_length():
    print("meter_frame: bar LENGTH tracks the value (observe short vs long)")
    cfg = {}
    n = 10
    f0 = cs._meter_frame("meter_cpu", cfg, n, 0, 50)
    f50 = cs._meter_frame("meter_cpu", cfg, n, 50, 50)
    f100 = cs._meter_frame("meter_cpu", cfg, n, 100, 50)
    check(_lit(f0) == 0, "value 0 -> no LED lit")
    check(_lit(f50) == 5, "value 50 -> half the strip lit")
    check(_lit(f100) == 10, "value 100 -> every LED lit")
    check(_lit(f50) < _lit(f100), "a bigger value lights MORE LEDs (both states seen)")


def test_meter_frame_degrade_closed():
    print("meter_frame: value None -> ALL DARK (never a fabricated fill)")
    f = cs._meter_frame("meter_cpu", {}, 8, None, 50)
    check(len(f) == 8 and _lit(f) == 0, "None value renders 8 dark cells, nothing lit")


def test_meter_temp_color():
    print("meter_cpu colour: cool temp is blue-ish, hot is red-ish (observe both)")
    cool = cs._meter_temp_color(30, 45, 78)     # below cool -> full cool stop
    hot = cs._meter_temp_color(90, 45, 78)      # above hot  -> full hot stop
    mid = cs._meter_temp_color(45 + (78 - 45) / 2, 45, 78)
    check(cool["b"] > cool["r"], "cool temperature leans blue")
    check(hot["r"] > hot["b"], "hot temperature leans red")
    check(mid["g"] >= mid["r"] and mid["g"] >= mid["b"], "mid temperature leans green")
    none = cs._meter_temp_color(None, 45, 78)
    check(none == cs._METER_TEMP_STOPS[1], "no temp sensor -> neutral mid colour, not dark")


def test_meter_battery_colour():
    print("meter_battery colour: low=red, high=green (observe both)")
    low = cs._meter_frame("meter_battery", {"low": 20}, 10, 10, None)
    full = cs._meter_frame("meter_battery", {"low": 20}, 10, 95, None)
    lc = next(c for c in low if c is not None)
    fc = next(c for c in full if c is not None)
    check(lc["r"] > lc["g"], "10%% battery is red-dominant")
    check(fc["g"] > fc["r"], "95%% battery is green-dominant")
    check(_lit(low) == 1 and _lit(full) > _lit(low), "battery length tracks charge too")


def test_meter_frame_mirrored():
    print("meter_frame mirrored: fills from the CENTRE outward")
    n = 10
    f = cs._meter_frame("meter_cpu", {"layout": "mirrored"}, n, 40, 50)  # 4 lit
    lit_idx = [i for i, c in enumerate(f) if c is not None]
    check(_lit(f) == 4, "value 40 lights 4 of 10")
    centre = [3, 4, 5, 6]  # the 4 closest to centre 5.0
    check(set(lit_idx) == set(centre), "the lit LEDs are the 4 nearest the centre")
    check(_lit(cs._meter_frame("meter_cpu", {"layout": "mirrored"}, n, 0, 50)) == 0,
          "mirrored value 0 lights nothing (no centre-lit-at-zero bug)")


def test_validate_meter_cfg():
    print("meter config validation (reject, don't sanitise)")
    cfg, err = cs._validate_meter_cfg({"layout": "mirrored", "smooth": "smooth",
                                       "cool": 40, "hot": 80, "low": 15})
    check(err is None and cfg == {"layout": "mirrored", "smooth": "smooth",
                                  "cool": 40, "hot": 80, "low": 15}, "accepts a full valid config")
    cfg, err = cs._validate_meter_cfg({})
    check(err is None and cfg == {}, "empty body -> empty config (all defaults)")
    bad = [{"layout": "sideways"}, {"smooth": "instant"},
           {"cool": -1}, {"hot": 200}, {"low": 4}, {"low": 51},
           {"cool": True}, {"cool": 80, "hot": 40},  # cool must be below hot
           # SINGLE-SIDED bounds whose EFFECTIVE pair (default-filled) is inverted:
           # {"hot":30} -> cool defaults 45 >= 30; {"cool":90} -> hot defaults 78 <= 90.
           {"hot": 30}, {"cool": 90}]
    for body in bad:
        cfg, err = cs._validate_meter_cfg(body)
        check(err is not None and cfg is None, "rejects %s" % body)
    # ...but a valid single-sided bound whose effective pair is still ordered passes.
    cfg, err = cs._validate_meter_cfg({"hot": 90})
    check(err is None and cfg == {"hot": 90}, "accepts {hot:90} (effective 45<90)")


def test_seq_meter_frame_live_and_smoothing():
    print("_seq_meter_frame: samples telemetry, EMA-smooths, degrades closed")
    # Low reading -> short bar; high reading -> long bar (observe both), via stub.
    spec = {"members": ["valve-leds[%d]" % i for i in range(10)],
            "effect": "meter_cpu", "meter": {"smooth": "responsive"}, "t0": 0}
    saved = cs._meter_read
    try:
        cs._meter_read = lambda kind, cpu_prev=None: (10.0, 50.0, None)
        # First frame seeds the EMA to the sample (no lag on frame 1).
        f_lo = cs._seq_meter_frame(spec, now=100.0)
        cs._meter_read = lambda kind, cpu_prev=None: (90.0, 50.0, None)
        # A new sample only after _METER_SAMPLE_S; jump time forward so it re-reads.
        f_hi = cs._seq_meter_frame(spec, now=100.0 + cs._METER_SAMPLE_S + 0.01)
        check(_lit(f_lo) < _lit(f_hi), "low reading -> shorter bar than a high reading")
        # Degrade closed: telemetry returns None -> dark, and EMA resets.
        cs._meter_read = lambda kind, cpu_prev=None: (None, None, None)
        f_none = cs._seq_meter_frame(spec, now=100.0 + 5.0)
        check(_lit(f_none) == 0 and spec.get("_ema") is None,
              "unreadable signal -> dark frame + EMA cleared")
    finally:
        cs._meter_read = saved


def test_allowlist_meters_registered():
    print("allowlist: meter ids are frozen + wired into both effect sets")
    check(set(cs._LED_METERS) == {"meter_cpu", "meter_battery"}, "_LED_METERS is the two meters")
    check(all(m in cs._LED_EFFECTS for m in cs._LED_METERS), "meters are in _LED_EFFECTS")
    check(all(m in cs._STRIP_SEQ_EFFECTS for m in cs._LED_METERS),
          "meters are in _STRIP_SEQ_EFFECTS (agent-rendered)")


def test_apply_strip_meter_registers_and_persists():
    print("apply_strip_effect(meter): registers spec + persists cfg + echoes active")
    writes = []
    restore = _install(writes)
    try:
        res = cs.apply_strip_effect("valve-leds", "meter_cpu", None, 50, 100, False,
                                    {"layout": "mirrored", "cool": 40, "hot": 80})
        check(res and res.get("ok") and res["active"]["effect"] == "meter_cpu",
              "meter accepted, active reports it")
        check(res["active"].get("meter") == {"layout": "mirrored", "cool": 40, "hot": 80},
              "active echoes the meter config")
        sp = cs._SEQ_ACTIVE.get("valve-leds")
        check(sp is not None and sp["effect"] == "meter_cpu" and sp["meter"]["cool"] == 40,
              "render spec registered with the meter cfg")
        per = cs._LED_PERSIST.get("strip:valve-leds")
        check(per and per.get("meter", {}).get("layout") == "mirrored",
              "meter cfg persisted for reboot-restore")
        # An unknown effect on the strip writes nothing / 400s.
        bad = cs.apply_strip_effect("valve-leds", "meter_nonsense", None, 50, 100)
        check(isinstance(bad, dict) and bad.get("status") == 400, "unknown meter id -> 400")
    finally:
        restore()


def test_restore_revalidates_meter_cfg():
    print("restore: good meter cfg re-armed; junk cfg dropped to defaults")
    writes = []
    restore = _install(writes)
    try:
        import json, tempfile
        saved_conf = cs._LED_STATE_CONF
        fd, tmp = tempfile.mkstemp(prefix="test-meter-", suffix=".json")
        os.close(fd)
        cs._LED_STATE_CONF = tmp
        try:
            # A persisted meter with a JUNK cool (out of range) -> must drop, not write.
            json.dump({"version": 1, "leds": {"strip:valve-leds": {
                "effect": "meter_cpu", "color": {"r": 0, "g": 0, "b": 0},
                "speed": 50, "brightness": 100,
                "meter": {"layout": "mirrored", "cool": 999}}}}, open(tmp, "w"))
            cs._led_restore()
            sp = cs._SEQ_ACTIVE.get("valve-leds")
            check(sp is not None and sp["effect"] == "meter_cpu", "meter re-armed on restore")
            # A junk field invalidates the whole persisted cfg -> the meter still
            # runs, but with DEFAULTS (never trusts / sanitises the file, §3.6).
            check(sp["meter"] == {}, "corrupt meter cfg drops to defaults, meter still runs")
        finally:
            cs._LED_STATE_CONF = saved_conf
            try:
                os.unlink(tmp)
            except OSError:
                pass
    finally:
        restore()


def test_mock_reactive_observable():
    print("mock: GET /api/leds advertises reactive meters + POST is observable")
    saved = dict(cs._MOCK_FX)
    try:
        cs._MOCK_FX.clear()
        st = cs.leds_state(True)
        check(st.get("reactive", {}).get("meters") == ["meter_cpu", "meter_battery"],
              "mock payload advertises both meters (probe-and-appear)")
        # simulate the POST /api/leds/effect strip+meter mock branch
        cs._MOCK_FX["strip:valve-leds"] = {"effect": "meter_cpu",
            "color": {"r": 255, "g": 0, "b": 0}, "speed": 50, "brightness": 100,
            "meter": {"smooth": "balanced"}}
        st = cs.leds_state(True)
        a = st["active"].get("strip:valve-leds", {})
        check(a.get("effect") == "meter_cpu" and a.get("meter", {}).get("smooth") == "balanced",
              "GET reflects the switched-on meter + its config")
    finally:
        cs._MOCK_FX.clear()
        cs._MOCK_FX.update(saved)


def test_cpu_busy_pct_per_caller():
    print("_cpu_busy_pct: per-caller snapshot (no shared global); first read None")
    first, snap = cs._cpu_busy_pct(None)
    # /proc/stat is Linux-only: on a box with it, the first call returns None + a
    # (total, idle) snapshot; on a host without it, degrade closed to (None, None).
    check(first is None and (snap is None or len(snap) == 2),
          "first call (prev None) -> None, plus a snapshot to carry forward on Linux")
    total = 0
    for _ in range(200000):
        total += 1
    r, snap2 = cs._cpu_busy_pct(snap)
    check(r is None or (0.0 <= r <= 100.0), "a subsequent read is None or a valid 0..100 %%")
    # Two independent callers each keep their OWN window -> neither returns None
    # because the other stole its baseline (the shared-global bug this replaces).
    a1, sa = cs._cpu_busy_pct(None)
    b1, sb = cs._cpu_busy_pct(None)
    a2, _ = cs._cpu_busy_pct(sa)
    b2, _ = cs._cpu_busy_pct(sb)
    check(a1 is None and b1 is None, "two fresh callers both start at None")
    check((a2 is None or 0 <= a2 <= 100) and (b2 is None or 0 <= b2 <= 100),
          "two callers sample independently, neither corrupts the other")


def test_meter_rejected_on_single_led():
    print("§3.7: a meter id on the single-LED / OpenRGB path is REJECTED (400), not a solid fill")
    writes = []
    restore = _install(writes)
    try:
        res = cs.apply_led_effect("valve-leds[0]", "meter_cpu", None, 50, 100)
        check(isinstance(res, dict) and res.get("status") == 400,
              "meter_cpu on a single LED -> 400 (never the fabricated fallthrough fill)")
        check(not writes, "nothing written for a rejected single-LED meter")
        res2 = cs.apply_led_effect("valve-leds[0]", "meter_battery", None, 50, 100)
        check(isinstance(res2, dict) and res2.get("status") == 400, "meter_battery too -> 400")
    finally:
        restore()


if __name__ == "__main__":
    test_meter_frame_length()
    test_meter_frame_degrade_closed()
    test_meter_temp_color()
    test_meter_battery_colour()
    test_meter_frame_mirrored()
    test_validate_meter_cfg()
    test_seq_meter_frame_live_and_smoothing()
    test_allowlist_meters_registered()
    test_meter_rejected_on_single_led()
    test_apply_strip_meter_registers_and_persists()
    test_restore_revalidates_meter_cfg()
    test_mock_reactive_observable()
    test_cpu_busy_pct_per_caller()
    print()
    if _fail:
        print("FAILED: %d" % len(_fail))
        for f in _fail:
            print("  - " + f)
        raise SystemExit(1)
    print("all led-meter tests passed")
