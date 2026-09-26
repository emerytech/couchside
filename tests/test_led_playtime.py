#!/usr/bin/env python3
"""Tests for the PLAYTIME countdown LED mode (SignalBar-style): the strip starts
full and DRAINS as a personal timer runs down.

Run: python3 tests/test_led_playtime.py

Properties that matter:
  * ALLOWLIST — `playtime` is frozen (in _LED_EFFECTS & _STRIP_SEQ_EFFECTS) and is
    STRIP-ONLY (rejected on the single-LED / OpenRGB paths, §3.7). Config is
    REJECTED not sanitised.
  * OBSERVE ALL STAGES — a long bar early, amber under 15 min, red under 5 min, a
    whole-bar white FLASH under 8 s, and DARK at zero (§11).
  * The DEADLINE is a wall-clock epoch persisted with the effect, so a restore
    RESUMES the real remaining time (not a restart); junk drops to a fresh timer.

Pure stdlib, no pytest — same style as test_led_meters.py.
"""
import importlib.util
import os
import time

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


def _first(frame):
    return next((c for c in frame if c is not None), None)


_N = 8
_FAKE = {("valve-leds[%d]" % i): {"name": "valve-leds[%d]" % i,
    "desc": "valve-leds[%d]" % i, "rgb": True, "notable": True, "writable": True,
    "max_brightness": 255, "index": ["red", "green", "blue"],
    "maxint": [255, 255, 255], "brightness": 0, "color": {"r": 0, "g": 0, "b": 0}}
    for i in range(_N)}


def _install(writes):
    saved = {k: getattr(cs, k) for k in
             ("_list_led_names", "_read_led_raw", "_led_realpath_ok",
              "_led_read_attr", "_led_write", "_seq_ensure_thread")}
    cs._list_led_names = lambda: list(_FAKE)
    cs._read_led_raw = lambda n: dict(_FAKE[n]) if n in _FAKE else None
    cs._led_realpath_ok = lambda n: True
    cs._led_read_attr = lambda name, attr: "[none]" if attr == "trigger" else None
    cs._led_write = lambda name, attr, value: writes.append((name, attr, value))
    cs._seq_ensure_thread = lambda: None

    def restore():
        for k, v in saved.items():
            setattr(cs, k, v)
        with cs._SEQ_LOCK:
            cs._SEQ_ACTIVE.clear()
        with cs._FX_LOCK:
            cs._LED_PERSIST.clear()
    return restore


def test_playtime_length_shrinks():
    print("playtime bar LENGTH shrinks as the remaining time drops (observe both)")
    cfg = {"minutes": 60, "scale": 0}          # 60-minute timer, timer-scale bar
    full = cs._playtime_frame(cfg, 10, 60 * 60, now_s=1000.0)      # 60 min left -> full
    half = cs._playtime_frame(cfg, 10, 30 * 60, now_s=1000.0)      # 30 min left -> half
    near = cs._playtime_frame(cfg, 10, 20 * 60, now_s=1000.0)      # 20 min left
    check(_lit(full) == 10, "60/60 min -> whole bar lit")
    check(_lit(half) == 5, "30/60 min -> half lit")
    check(_lit(near) < _lit(half) < _lit(full),
          "the bar shrinks monotonically with remaining time (20<30<60 min)")
    # A long timer's final minutes still show >=1 LED (the warning stays visible).
    tiny = cs._playtime_frame(cfg, 10, 2 * 60, now_s=1000.0)   # 2 min of a 60-min timer
    check(_lit(tiny) == 1, "near-empty bar keeps >=1 LED lit (warning stays visible)")


def test_playtime_colour_stages():
    print("playtime COLOUR steps start -> amber(<15m) -> red(<5m) -> flash(<8s) -> dark")
    cfg = {"minutes": 60, "scale": 0, "color": {"r": 0, "g": 0, "b": 255}}
    start = _first(cs._playtime_frame(cfg, 8, 40 * 60, 1000.0))
    amber = _first(cs._playtime_frame(cfg, 8, 10 * 60, 1000.0))
    red = _first(cs._playtime_frame(cfg, 8, 3 * 60, 1000.0))
    check(start == {"r": 0, "g": 0, "b": 255}, "early -> the chosen start colour (blue)")
    check(amber == cs._PLAYTIME_AMBER, "under 15 min -> amber")
    check(red == cs._PLAYTIME_RED, "under 5 min -> red")
    # final 8 s: the WHOLE bar flashes white on the on-phase, all dark on the off-phase
    on = cs._playtime_frame(cfg, 8, 4.0, now_s=10.0)   # int(10*2)%2==0 -> on
    off = cs._playtime_frame(cfg, 8, 4.0, now_s=10.5)  # int(21)%2==1 -> off
    check(_lit(on) == 8 and _first(on) == cs._PLAYTIME_FLASH, "final 8 s: whole bar flashes white")
    check(_lit(off) == 0, "final-8 s off-phase: whole bar dark (a real blink)")
    check(_lit(cs._playtime_frame(cfg, 8, 0.0, 1000.0)) == 0, "expired -> dark")


def test_playtime_scale_fixed_hours():
    print("playtime bar-SCALE: fixed N-hour reference changes the visible drain rate")
    # scale=2 -> a full bar means 2 h. 60 min left -> half of a 2 h bar.
    cfg2 = {"minutes": 60, "scale": 2}
    half = cs._playtime_frame(cfg2, 10, 60 * 60, 1000.0)
    check(_lit(half) == 5, "scale=2h: 60 min left -> half a bar (not full)")
    # scale=0 (timer-length): 60 min left of a 60-min timer -> full.
    full = cs._playtime_frame({"minutes": 60, "scale": 0}, 10, 60 * 60, 1000.0)
    check(_lit(full) == 10, "scale=0 (timer): 60/60 -> full")


def test_validate_playtime_cfg():
    print("playtime config validation (reject, don't sanitise)")
    cfg, err = cs._validate_playtime_cfg({"minutes": 90, "scale": 3, "layout": "mirrored",
                                          "color": {"r": 1, "g": 2, "b": 3}})
    check(err is None and cfg == {"minutes": 90, "scale": 3, "layout": "mirrored",
                                  "color": {"r": 1, "g": 2, "b": 3}}, "accepts a full valid config")
    cfg, err = cs._validate_playtime_cfg({})
    check(err is None and cfg == {}, "empty -> empty (defaults)")
    bad = [{"minutes": 4}, {"minutes": 241}, {"minutes": True}, {"minutes": 60.0},
           {"scale": 5}, {"scale": -1}, {"scale": True},
           {"layout": "diagonal"}, {"color": {"r": 256, "g": 0, "b": 0}}, {"color": [1, 2, 3]}]
    for body in bad:
        cfg, err = cs._validate_playtime_cfg(body)
        check(err is not None and cfg is None, "rejects %s" % body)


def test_seq_playtime_frame_uses_deadline():
    print("_seq_playtime_frame reads the wall-clock DEADLINE (future=lit, past=dark)")
    future = {"members": ["valve-leds[%d]" % i for i in range(8)], "effect": "playtime",
              "playtime": {"minutes": 60, "scale": 0, "deadline": time.time() + 55 * 60}}
    past = {"members": ["valve-leds[%d]" % i for i in range(8)], "effect": "playtime",
            "playtime": {"minutes": 60, "scale": 0, "deadline": time.time() - 10}}
    nodl = {"members": ["valve-leds[%d]" % i for i in range(8)], "effect": "playtime",
            "playtime": {"minutes": 60}}
    check(_lit(cs._seq_playtime_frame(future, now=0.0)) > 0, "a future deadline lights the bar")
    check(_lit(cs._seq_playtime_frame(past, now=0.0)) == 0, "a past deadline -> dark (expired)")
    check(_lit(cs._seq_playtime_frame(nodl, now=0.0)) == 0, "no deadline -> dark (never fabricates)")


def test_allowlist_and_strip_only():
    print("allowlist: playtime is frozen + STRIP-ONLY (rejected on a single LED, §3.7)")
    check("playtime" in cs._LED_EFFECTS and "playtime" in cs._STRIP_SEQ_EFFECTS,
          "playtime is in both effect sets")
    writes = []
    restore = _install(writes)
    try:
        res = cs.apply_led_effect("valve-leds[0]", "playtime", None, 50, 100)
        check(isinstance(res, dict) and res.get("status") == 400,
              "playtime on a single LED -> 400 (never the fabricated fallthrough fill)")
        check(not writes, "nothing written for a rejected single-LED playtime")
    finally:
        restore()


def test_apply_and_restore_resumes_deadline():
    print("apply stamps a deadline; restore RESUMES it (not a restart); junk -> fresh")
    writes = []
    restore = _install(writes)
    try:
        t0 = time.time()
        res = cs.apply_strip_effect("valve-leds", "playtime", None, 50, 100, False, None,
                                    {"minutes": 30, "scale": 1})
        check(res and res.get("ok") and res["active"]["effect"] == "playtime",
              "playtime accepted, active reports it")
        pt = res["active"].get("playtime", {})
        check(pt.get("minutes") == 30 and abs(pt.get("deadline", 0) - (t0 + 30 * 60)) < 5,
              "a FRESH timer stamps deadline ~= now + minutes")
        per = cs._LED_PERSIST.get("strip:valve-leds", {}).get("playtime", {})
        check("deadline" in per, "the deadline is persisted for reboot-resume")

        # RESTORE from a persisted record whose deadline is a fixed point in the future:
        import json, tempfile
        saved_conf = cs._LED_STATE_CONF
        fd, tmp = tempfile.mkstemp(prefix="test-playtime-", suffix=".json")
        os.close(fd)
        cs._LED_STATE_CONF = tmp
        fixed = time.time() + 12 * 60
        try:
            with cs._SEQ_LOCK:
                cs._SEQ_ACTIVE.clear()
            json.dump({"version": 1, "leds": {"strip:valve-leds": {
                "effect": "playtime", "color": {"r": 0, "g": 0, "b": 0},
                "speed": 50, "brightness": 100,
                "playtime": {"minutes": 30, "scale": 1, "deadline": fixed}}}}, open(tmp, "w"))
            cs._led_restore()
            sp = cs._SEQ_ACTIVE.get("valve-leds")
            check(sp and sp["effect"] == "playtime"
                  and abs(sp["playtime"]["deadline"] - fixed) < 0.001,
                  "restore RESUMES the stored deadline (not a fresh now+minutes)")
        finally:
            cs._LED_STATE_CONF = saved_conf
            try:
                os.unlink(tmp)
            except OSError:
                pass
    finally:
        restore()


def test_mock_reactive_playtime_observable():
    print("mock: reactive advertises playtime + a POST is observable")
    saved = dict(cs._MOCK_FX)
    try:
        cs._MOCK_FX.clear()
        st = cs.leds_state(True)
        check(st.get("reactive", {}).get("playtime") is True,
              "mock payload advertises playtime (probe-and-appear)")
        cs._MOCK_FX["strip:valve-leds"] = {"effect": "playtime",
            "color": {"r": 255, "g": 0, "b": 0}, "speed": 50, "brightness": 100,
            "playtime": {"minutes": 45, "scale": 0, "deadline": time.time() + 45 * 60}}
        st = cs.leds_state(True)
        a = st["active"].get("strip:valve-leds", {})
        check(a.get("effect") == "playtime" and a.get("playtime", {}).get("minutes") == 45,
              "GET reflects the running countdown + its config")
    finally:
        cs._MOCK_FX.clear()
        cs._MOCK_FX.update(saved)


if __name__ == "__main__":
    test_playtime_length_shrinks()
    test_playtime_colour_stages()
    test_playtime_scale_fixed_hours()
    test_validate_playtime_cfg()
    test_seq_playtime_frame_uses_deadline()
    test_allowlist_and_strip_only()
    test_apply_and_restore_resumes_deadline()
    test_mock_reactive_playtime_observable()
    print()
    if _fail:
        print("FAILED: %d" % len(_fail))
        for f in _fail:
            print("  - " + f)
        raise SystemExit(1)
    print("all led-playtime tests passed")
