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


def test_manual_mode_preserves_colours():
    print("manual = effect=manual on every member, colours PRESERVED (no fill)")
    writes = []
    restore = _install(writes)
    try:
        res = cs.apply_strip_effect("valve-leds", "manual", None, 50, 90)
        check(res and res.get("ok"), "manual accepted")
        for i in range(_N):
            n = "valve-leds[%d]" % i
            check((n, "effect", "manual") in writes, "%s set effect=manual" % n)
        check(not any(w[1] == "multi_intensity" for w in writes),
              "manual does NOT repaint (colours kept so the phone can paint a pattern)")
    finally:
        restore()


def test_paint_auto_switches_to_manual():
    print("painting a strip node auto-sets effect=manual FIRST so the colour sticks")
    writes = []
    restore = _install(writes)
    try:
        res = cs.set_led("valve-leds[3]", 100, {"r": 255, "g": 0, "b": 0})
        check(res and res.get("ok"), "paint accepted")
        attrs = [w[1] for w in writes if w[0] == "valve-leds[3]"]
        check("effect" in attrs and "multi_intensity" in attrs
              and attrs.index("effect") < attrs.index("multi_intensity"),
              "effect=manual written before the colour (so a running effect can't override it)")
        check(("valve-leds[3]", "effect", "manual") in writes,
              "the effect written is 'manual' (the device lists it)")
    finally:
        restore()


def test_strips_in_payload():
    print("GET /api/leds advertises strips (mock)")
    st = cs.leds_state(True)
    strips = st.get("strips")
    check(isinstance(strips, list) and strips, "mock payload lists a strip")
    vs = next((s for s in strips if s["prefix"] == "valve-leds"), None)
    check(vs and vs["count"] >= 3 and vs["rgb"], "valve-leds strip with RGB members")
    check(vs and "patrol" in vs["hw_effects"], "hw_effects advertised (patrol)")


def test_reconcile_reapplies_only_on_drift():
    print("reconcile re-arms the strip ONLY when the hw effect drifted (Steam reset)")
    writes = []
    restore = _install(writes)
    saved_load = cs._led_state_load
    try:
        # persisted desired = scanner (which wants firmware `patrol`)
        cs._led_state_load = lambda: {"strip:valve-leds": {
            "effect": "scanner", "color": {"r": 255, "g": 0, "b": 0},
            "speed": 55, "brightness": 100}}
        base_read = cs._led_read_attr
        hw = {"effect": "patrol"}                 # the live hardware effect
        cs._led_read_attr = lambda n, a: (hw["effect"] if a == "effect"
                                          else base_read(n, a))
        # (a) steady: hw already patrol -> reconcile must write nothing
        writes.clear()
        cs._led_reconcile()
        check(not any(w[1] == "effect" for w in writes),
              "steady strip (already patrol) is NOT rewritten")
        # (b) drifted: Steam reset the strip to 'normal' -> reconcile re-arms patrol
        hw["effect"] = "normal"
        writes.clear()
        cs._led_reconcile()
        check(any(w == ("valve-leds[0]", "effect", "patrol") for w in writes),
              "drifted strip re-armed to patrol")
    finally:
        cs._led_state_load = saved_load
        restore()


def test_strip_effect_clears_stale_per_led_persist():
    print("a whole-strip effect drops stale per-LED persists (no conflicting restore)")
    writes = []
    restore = _install(writes)
    saved_save = cs._led_state_save
    try:
        cs._led_state_save = lambda: None         # don't touch disk
        with cs._FX_LOCK:
            cs._LED_PERSIST.clear()
            cs._LED_PERSIST["valve-leds[2]"] = {"effect": "solid",
                "color": {"r": 0, "g": 0, "b": 255}, "brightness": 90, "speed": 50}
        cs.apply_strip_effect("valve-leds", "scanner", {"r": 255, "g": 0, "b": 0}, 70, 100)
        check("valve-leds[2]" not in cs._LED_PERSIST,
              "stale per-LED persist cleared by the strip effect")
        check("strip:valve-leds" in cs._LED_PERSIST, "strip effect persisted")
    finally:
        cs._led_state_save = saved_save
        restore()


def test_circle_starts_agent_animation():
    print("circle: agent-rendered -> registers a sequence, flips members to manual")
    writes = []
    restore = _install(writes)
    saved_thread, saved_save = cs._seq_ensure_thread, cs._led_state_save
    try:
        cs._seq_ensure_thread = lambda: None      # don't spawn the render thread
        cs._led_state_save = lambda: None
        with cs._SEQ_LOCK:
            cs._SEQ_ACTIVE.clear()
        with cs._FX_LOCK:
            cs._LED_PERSIST.clear()
        res = cs.apply_strip_effect("valve-leds", "circle",
                                    {"r": 0, "g": 200, "b": 255}, 70, 90)
        check(res and res.get("ok") and res["active"]["effect"] == "circle",
              "circle accepted, active reports it")
        check("valve-leds" in cs._SEQ_ACTIVE, "agent sequence registered for the strip")
        check(all((("valve-leds[%d]" % i), "effect", "manual") in writes
                  for i in range(_N)), "every member flipped to manual")
        check(cs._LED_PERSIST.get("strip:valve-leds", {}).get("effect") == "circle",
              "circle persisted so a reboot re-arms it")
        # a firmware effect supersedes the running agent animation
        cs.apply_strip_effect("valve-leds", "scanner", {"r": 255, "g": 0, "b": 0}, 70, 100)
        check("valve-leds" not in cs._SEQ_ACTIVE, "scanner stops the agent sequence")
    finally:
        cs._seq_ensure_thread, cs._led_state_save = saved_thread, saved_save
        with cs._SEQ_LOCK:
            cs._SEQ_ACTIVE.clear()
        restore()


def test_circle_frame_sweeps_and_wraps():
    print("circle frame: a head that advances one direction and wraps")
    n, period, col = 8, 4.0, {"r": 255, "g": 0, "b": 0}
    f0 = cs._seq_frame_circle(n, 0.0, period, col)
    check(f0[0] is not None and f0[0]["r"] == 255, "bright head at index 0 at t=0")
    check(sum(1 for c in f0 if c is not None) <= cs._SEQ_TAIL, "only head + tail lit")
    fq = cs._seq_frame_circle(n, period / n * 2, period, col)
    check(fq[2] is not None and fq[2]["r"] == 255, "head advanced to index 2")
    fw = cs._seq_frame_circle(n, period * (n - 0.01) / n, period, col)
    check(fw[n - 1] is not None, "head reaches the last LED before wrapping to 0")


def test_reconcile_skips_agent_effects():
    print("reconcile SKIPS agent-rendered effects (they self-heal each frame)")
    writes = []
    restore = _install(writes)
    saved_load = cs._led_state_load
    try:
        cs._led_state_load = lambda: {"strip:valve-leds": {
            "effect": "circle", "color": {"r": 255, "g": 0, "b": 0},
            "speed": 55, "brightness": 100}}
        base = cs._led_read_attr
        cs._led_read_attr = lambda nm, a: ("normal" if a == "effect" else base(nm, a))
        writes.clear()
        cs._led_reconcile()
        check(not any(w[1] == "effect" for w in writes),
              "circle is not re-armed by the reconciler (render thread owns it)")
    finally:
        cs._led_state_load = saved_load
        restore()


def test_sequence_validation():
    print("sequence body validation (reject, don't sanitise)")
    good = {"frames": [[{"r": 255, "g": 0, "b": 0}, None], [None, {"r": 0, "g": 0, "b": 255}]],
            "hold_ms": 400, "loop": True, "brightness": 90}
    frames, hold, holds, br, loop, err = cs._validate_sequence_body(good)
    check(err is None and len(frames) == 2 and hold == 400 and loop is True and br == 90
          and holds is None, "accepts a valid 2-frame sequence (no per-frame holds)")
    # per-frame holds: a valid list matching the frame count is accepted verbatim
    withholds = dict(good, holds=[200, 800])
    _, _, holds2, _, _, err = cs._validate_sequence_body(withholds)
    check(err is None and holds2 == [200, 800],
          "accepts per-frame holds matching the frame count")
    bad = [
        {"frames": []},                                  # empty
        {"frames": [[{"r": 256, "g": 0, "b": 0}]]},      # bad colour
        {"frames": [[{"r": 1, "g": 2, "b": 3}]], "hold_ms": 10},    # hold too small
        {"frames": [[{"r": 1, "g": 2, "b": 3}]], "hold_ms": 999999},  # hold too big
        {"frames": [[{"r": 1, "g": 2, "b": 3}]], "loop": "yes"},    # loop not bool
        {"frames": "nope"},                              # frames not a list
        {"frames": [["red"]]},                           # colour not {r,g,b}|null
        # per-frame holds: wrong length, out of range, wrong type -> rejected
        {"frames": [[{"r": 1, "g": 2, "b": 3}], [None]], "holds": [200]},  # len != frames
        {"frames": [[{"r": 1, "g": 2, "b": 3}]], "holds": [10]},           # hold too small
        {"frames": [[{"r": 1, "g": 2, "b": 3}]], "holds": [999999]},       # hold too big
        {"frames": [[{"r": 1, "g": 2, "b": 3}]], "holds": ["x"]},          # not an int
        {"frames": [[{"r": 1, "g": 2, "b": 3}]], "holds": [True]},         # bool not int
        {"frames": [[{"r": 1, "g": 2, "b": 3}]], "holds": "nope"},         # not a list
    ]
    for b in bad:
        _, _, _, _, _, err = cs._validate_sequence_body(b)
        check(err is not None, "rejects %s" % (list(b)[:1]))


def test_sequence_starts_and_persists():
    print("apply_strip_sequence: registers a sequence, normalizes frames, persists")
    writes = []
    restore = _install(writes)
    saved_thread, saved_save = cs._seq_ensure_thread, cs._led_state_save
    try:
        cs._seq_ensure_thread = lambda: None
        cs._led_state_save = lambda: None
        with cs._SEQ_LOCK:
            cs._SEQ_ACTIVE.clear()
        with cs._FX_LOCK:
            cs._LED_PERSIST.clear()
        # frames SHORTER than the 5-member strip -> normalized (padded with off)
        A = [{"r": 255, "g": 0, "b": 0}, {"r": 255, "g": 0, "b": 0}]
        B = [None, None, {"r": 0, "g": 0, "b": 255}]
        res = cs.apply_strip_sequence("valve-leds", [A, B], 400, 90, True)
        check(res and res.get("ok") and res["active"]["frames"] == 2,
              "sequence accepted")
        spec = cs._SEQ_ACTIVE.get("valve-leds")
        check(spec and spec["effect"] == "sequence" and len(spec["frames"]) == 2,
              "registered as a 2-frame sequence")
        check(spec and all(len(fr) == _N for fr in spec["frames"]),
              "every frame normalized to the member count (%d)" % _N)
        check(all((("valve-leds[%d]" % i), "effect", "manual") in writes for i in range(_N)),
              "members flipped to manual")
        p = cs._LED_PERSIST.get("strip:valve-leds", {})
        check(p.get("effect") == "sequence" and p.get("hold_ms") == 400,
              "sequence persisted for reboot re-arm")
        check(p.get("holds") is None,
              "no per-frame holds persisted when none supplied")
        # now with per-frame holds -> stored on the spec AND persisted for re-arm
        res = cs.apply_strip_sequence("valve-leds", [A, B], 500, 90, True, [150, 850])
        check(res["active"].get("holds") == [150, 850], "per-frame holds echoed")
        check(cs._SEQ_ACTIVE["valve-leds"].get("holds") == [150, 850],
              "per-frame holds on the live spec")
        check(cs._LED_PERSIST["strip:valve-leds"].get("holds") == [150, 850],
              "per-frame holds persisted for reboot re-arm")
        # a holds list that does NOT match the frame count is dropped (uniform hold)
        res = cs.apply_strip_sequence("valve-leds", [A, B], 500, 90, True, [150])
        check(res["active"].get("holds") is None and "holds" not in res["active"],
              "mismatched holds length dropped -> uniform hold")
    finally:
        cs._seq_ensure_thread, cs._led_state_save = saved_thread, saved_save
        with cs._SEQ_LOCK:
            cs._SEQ_ACTIVE.clear()
        restore()


def test_sequence_per_frame_holds_timeline():
    print("per-frame holds: render walks a cumulative timeline (loop wraps)")
    writes = []
    restore = _install(writes)
    saved_wc = cs._led_write_color
    painted = {}
    cs._led_write_color = lambda name, raw, c: painted.__setitem__(name, dict(c))
    saved_thread, saved_save = cs._seq_ensure_thread, cs._led_state_save
    try:
        cs._seq_ensure_thread = lambda: None
        cs._led_state_save = lambda: None
        with cs._SEQ_LOCK:
            cs._SEQ_ACTIVE.clear()
        R = [{"r": 255, "g": 0, "b": 0}] * _N
        G = [{"r": 0, "g": 255, "b": 0}] * _N
        B = [{"r": 0, "g": 0, "b": 255}] * _N
        # red 100ms, green 200ms, blue 300ms -> total 600ms, looping
        cs.apply_strip_sequence("valve-leds", [R, G, B], 500, 100, True, [100, 200, 300])
        spec = cs._SEQ_ACTIVE["valve-leds"]
        m0 = spec["members"][0]

        def frame_at(elapsed):
            painted.clear()
            spec["t0"] = 0.0            # so t == elapsed selects the frame at that time
            cs._seq_render(spec, elapsed)
            return painted.get(m0)

        check(frame_at(0.05) == {"r": 255, "g": 0, "b": 0}, "t=50ms  -> frame 0 (red)")
        check(frame_at(0.25) == {"r": 0, "g": 255, "b": 0}, "t=250ms -> frame 1 (green)")
        check(frame_at(0.55) == {"r": 0, "g": 0, "b": 255}, "t=550ms -> frame 2 (blue)")
        # loop wraps: 650ms == 50ms into the next cycle -> back to frame 0
        check(frame_at(0.65) == {"r": 255, "g": 0, "b": 0}, "t=650ms -> wraps to frame 0")

        # NON-LOOP: same holds, loop=False -> advances through, then HOLDS the last
        # frame forever (never wraps). Observe both states at the SAME time points.
        cs.apply_strip_sequence("valve-leds", [R, G, B], 500, 100, False, [100, 200, 300])
        spec = cs._SEQ_ACTIVE["valve-leds"]
        m0 = spec["members"][0]
        check(frame_at(0.05) == {"r": 255, "g": 0, "b": 0}, "non-loop t=50ms  -> frame 0")
        check(frame_at(0.25) == {"r": 0, "g": 255, "b": 0}, "non-loop t=250ms -> frame 1")
        check(frame_at(0.55) == {"r": 0, "g": 0, "b": 255}, "non-loop t=550ms -> frame 2")
        # past the 600ms total: clamps to the LAST frame (blue), does NOT wrap to red
        check(frame_at(0.65) == {"r": 0, "g": 0, "b": 255}, "non-loop t=650ms -> clamps to last (blue)")
        check(frame_at(5.0) == {"r": 0, "g": 0, "b": 255}, "non-loop far past end -> still last (blue)")
    finally:
        cs._led_write_color = saved_wc
        cs._seq_ensure_thread, cs._led_state_save = saved_thread, saved_save
        with cs._SEQ_LOCK:
            cs._SEQ_ACTIVE.clear()
        restore()


def test_led_restore_rearms_per_frame_holds():
    print("restore: a persisted sequence re-arms with its per-frame holds (revalidated)")
    writes = []
    restore = _install(writes)
    saved_load = cs._led_state_load
    saved_thread, saved_save = cs._seq_ensure_thread, cs._led_state_save
    try:
        cs._seq_ensure_thread = lambda: None
        cs._led_state_save = lambda: None
        R = [{"r": 255, "g": 0, "b": 0}] * _N
        B = [{"r": 0, "g": 0, "b": 255}] * _N
        with cs._SEQ_LOCK:
            cs._SEQ_ACTIVE.clear()
        cs._led_state_load = lambda: {"strip:valve-leds": {
            "effect": "sequence", "frames": [R, B], "hold_ms": 500,
            "holds": [120, 880], "loop": True, "brightness": 100}}
        cs._led_restore()
        spec = cs._SEQ_ACTIVE.get("valve-leds")
        check(spec and spec["effect"] == "sequence" and spec.get("holds") == [120, 880],
              "sequence re-armed WITH its per-frame holds")
        # a junk holds list (wrong length) is ignored -> uniform hold, still re-arms
        with cs._SEQ_LOCK:
            cs._SEQ_ACTIVE.clear()
        cs._led_state_load = lambda: {"strip:valve-leds": {
            "effect": "sequence", "frames": [R, B], "hold_ms": 500,
            "holds": [120], "loop": True, "brightness": 100}}
        cs._led_restore()
        spec = cs._SEQ_ACTIVE.get("valve-leds")
        check(spec and spec.get("holds") is None,
              "mismatched persisted holds dropped -> uniform hold (still re-arms)")
    finally:
        cs._led_state_load = saved_load
        cs._seq_ensure_thread, cs._led_state_save = saved_thread, saved_save
        with cs._SEQ_LOCK:
            cs._SEQ_ACTIVE.clear()
        restore()


if __name__ == "__main__":
    test_detect_strip()
    test_allowlist_unknown_prefix()
    test_scanner_writes_firmware_patrol()
    test_effect_value_must_be_published()
    test_solid_and_off()
    test_manual_mode_preserves_colours()
    test_paint_auto_switches_to_manual()
    test_delay_maps_speed()
    test_strips_in_payload()
    test_reconcile_reapplies_only_on_drift()
    test_strip_effect_clears_stale_per_led_persist()
    test_circle_starts_agent_animation()
    test_circle_frame_sweeps_and_wraps()
    test_reconcile_skips_agent_effects()
    test_sequence_validation()
    test_sequence_starts_and_persists()
    test_sequence_per_frame_holds_timeline()
    test_led_restore_rearms_per_frame_holds()
    print()
    if _fail:
        print("FAILED: %d" % len(_fail))
        for f in _fail:
            print("  - " + f)
        raise SystemExit(1)
    print("all led-strip tests passed")
