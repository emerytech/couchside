#!/usr/bin/env python3
"""Tests for the LED effect engine + persistence (POST /api/leds/effect, the
`effects`/`active` fields on GET /api/leds, and reboot restore).

Run: python3 tests/test_led_effects.py

The properties that matter:
  * ALLOWLIST — an unknown effect id, or an unknown / traversal-shaped /
    non-writable LED name, starts NOTHING and writes NOTHING (same guarantee as
    /api/leds/set). Effect ids are looked up in the frozen _LED_EFFECTS.
  * params are REJECTED not sanitised (speed 1-100, brightness 0-100, colour
    {r,g,b} 0-255).
  * the render thread only ever writes the three fixed-literal attributes via
    the same writers set_led() uses.
  * persistence round-trips and is REVALIDATED on restore (a junk file never
    drives a write).
  * mock is observable: selecting an effect moves GET /api/leds `active`.

Pure stdlib, no pytest -- same style as test_led_control.py. Never touches real
/sys or the real ~/.config path (both are faked / redirected to a temp file).
"""
import importlib.util
import os
import tempfile
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


# A fake /sys/class/leds: one writable RGB LED (channel order blue,red,green to
# prove the writer reorders), one locked (non-writable) RGB LED.
_FAKE = {
    "multicolor:front": {"name": "multicolor:front", "desc": "multicolor:front",
        "rgb": True, "notable": True, "writable": True, "max_brightness": 255,
        "index": ["blue", "red", "green"], "maxint": [255, 255, 255],
        "brightness": 255, "color": {"r": 0, "g": 0, "b": 0}},
    "locked::led": {"name": "locked::led", "desc": "locked::led", "rgb": True,
        "notable": True, "writable": False, "max_brightness": 255,
        "index": ["red", "green", "blue"], "maxint": [255, 255, 255],
        "brightness": 0, "color": {"r": 0, "g": 0, "b": 0}},
    # A GATED HID RGB LED (Lenovo Legion Go S thumbstick rings): `enable_on` set +
    # a firmware `dev_effects` list -> the effect=monocolor / enabled-last path.
    "go_s:rgb:joystick_rings": {"name": "go_s:rgb:joystick_rings",
        "desc": "go_s:rgb:joystick_rings", "rgb": True, "notable": True,
        "writable": True, "max_brightness": 100, "index": ["red", "green", "blue"],
        "maxint": [100, 100, 100], "brightness": 100, "color": {"r": 0, "g": 0, "b": 0},
        "enable_on": "true", "dev_effects": ("monocolor", "breathe", "chroma", "rainbow")},
}


def _install_fake(writes):
    """Redirect the agent's LED FS + persistence at fakes. Returns a restore fn."""
    saved = {k: getattr(cs, k) for k in
             ("_list_led_names", "_read_led_raw", "_led_realpath_ok",
              "_led_read_attr", "_led_write", "_LED_STATE_CONF")}
    cs._list_led_names = lambda: list(_FAKE)
    cs._read_led_raw = lambda n: dict(_FAKE[n]) if n in _FAKE else None
    cs._led_realpath_ok = lambda n: True
    cs._led_read_attr = lambda name, attr: "[none]" if attr == "trigger" else None
    cs._led_write = lambda name, attr, value: writes.append((name, attr, value))
    fd, tmp = tempfile.mkstemp(prefix="test-leds-", suffix=".json")
    os.close(fd)
    os.unlink(tmp)
    cs._LED_STATE_CONF = tmp

    def restore():
        _reset_engine()
        for k, v in saved.items():
            setattr(cs, k, v)
        try:
            os.unlink(tmp)
        except OSError:
            pass
    return restore


def _reset_engine():
    """Stop the render thread and clear all engine state between tests."""
    cs._FX_STOP.set()
    th = cs._FX_THREAD[0]
    if th is not None:
        th.join(timeout=1.0)
    with cs._FX_LOCK:
        cs._FX_ACTIVE.clear()
        cs._FX_RAW.clear()
        cs._LED_PERSIST.clear()
        cs._FX_THREAD[0] = None
    cs._FX_STOP.clear()
    cs._MOCK_FX.clear()


def test_validate_effect_body():
    print("effect body validation (reject, don't sanitise)")
    e, c, s, b, rev, err = cs._validate_effect_body({"effect": "breathe"})
    check(err is None and e == "breathe" and rev is False,
          "accepts a bare known effect (reverse defaults False)")
    e, c, s, b, rev, err = cs._validate_effect_body(
        {"effect": "circle", "speed": 80, "brightness": 40,
         "color": {"r": 1, "g": 2, "b": 3}, "reverse": True})
    check(err is None and s == 80 and b == 40 and c == {"r": 1, "g": 2, "b": 3}
          and rev is True, "accepts full valid params incl. reverse")
    bad = [{"effect": "nope"}, {"effect": "breathe", "speed": 0},
           {"effect": "breathe", "speed": 101}, {"effect": "breathe", "speed": True},
           {"effect": "breathe", "brightness": -1}, {"effect": "breathe", "brightness": 101},
           {"effect": "breathe", "color": {"r": 256, "g": 0, "b": 0}},
           {"effect": "breathe", "color": [1, 2, 3]},
           {"effect": "breathe", "reverse": "yes"}, {}]
    for body in bad:
        _, _, _, _, _, err = cs._validate_effect_body(body)
        check(err is not None, "rejects %s" % body)


def test_frame_bounds():
    print("every effect frame stays in range (brightness 0..target, colour valid)")
    for eff in ("breathe", "pulse", "strobe", "rainbow", "scanner"):
        params = {"color": {"r": 255, "g": 0, "b": 0}, "speed": 50, "brightness": 80}
        oob = False
        badcol = False
        for i in range(200):
            col, b = cs._fx_frame(eff, params, i * 0.05)
            if b is not None and not (0 <= b <= 80):
                oob = True
            if col is not None and not cs._is_rgb_triple(col):
                badcol = True
        check(not oob, "%s brightness within 0..target" % eff)
        check(not badcol, "%s colour is always a valid {r,g,b}" % eff)


def test_allowlist_effect():
    print("allowlist: unknown effect / bad LED starts + writes NOTHING")
    writes = []
    restore = _install_fake(writes)
    try:
        # unknown effect -> 400, nothing active, nothing written
        res = cs.apply_led_effect("multicolor:front", "kitt-o-matic", None, 50, 80)
        check(isinstance(res, dict) and res.get("status") == 400, "unknown effect -> 400")
        check(not cs._FX_ACTIVE and not writes, "unknown effect: no active, no write")

        # bad LED names -> None, nothing active, nothing written
        for bad in ("nope", "", "../../etc/passwd", "multicolor:front/../x",
                    "locked::led", None, 123):
            writes.clear()
            res = cs.apply_led_effect(bad, "breathe", None, 50, 80)
            check(res is None, "refused LED %r" % (bad,))
            check(not cs._FX_ACTIVE, "no effect registered for %r" % (bad,))
            check(not writes, "nothing written for %r" % (bad,))
    finally:
        restore()


def test_animate_then_solid_lifecycle():
    print("animate -> thread renders -> solid stops it (lifecycle + persistence)")
    writes = []
    restore = _install_fake(writes)
    try:
        res = cs.apply_led_effect("multicolor:front", "breathe",
                                  {"r": 255, "g": 0, "b": 0}, 100, 100)
        check(res and res.get("ok") and res["active"]["effect"] == "breathe",
              "breathe accepted, active reports it")
        check("multicolor:front" in cs._FX_ACTIVE, "effect registered as active")
        th = cs._FX_THREAD[0]
        check(th is not None and th.is_alive(), "render thread running")

        # let it render a few frames, then assert only the fixed-literal attrs
        # were written (via the same writers set_led uses).
        time.sleep(0.15)
        check(writes, "render thread wrote frames")
        check(all(w[1] in ("trigger", "multi_intensity", "brightness")
                  for w in writes), "only the three fixed-literal attrs written")

        # persisted as an animated effect
        saved = cs._led_state_load()
        check(saved.get("multicolor:front", {}).get("effect") == "breathe",
              "breathe persisted to disk")
        # GET active reflects the animation
        act = cs._led_active_map()
        check(act.get("multicolor:front", {}).get("effect") == "breathe",
              "GET active map shows the animation")

        # now a solid stops the animation and re-persists as solid
        res = cs.apply_led_effect("multicolor:front", "solid",
                                  {"r": 0, "g": 200, "b": 0}, None, 50)
        check(res and res.get("ok") and res["active"] is None,
              "solid accepted, active cleared")
        # thread should drain (no active) and exit
        deadline = time.time() + 1.5
        while cs._FX_THREAD[0] is not None and time.time() < deadline:
            time.sleep(0.02)
        check("multicolor:front" not in cs._FX_ACTIVE, "animation removed on solid")
        check(cs._FX_THREAD[0] is None, "render thread exited when nothing active")
        check(cs._led_state_load().get("multicolor:front", {}).get("effect") == "solid",
              "solid persisted (reboot will restore a solid, not the animation)")
        check("multicolor:front" not in cs._led_active_map(),
              "GET active omits a solid (reflected by led colour/brightness instead)")
    finally:
        restore()


def test_persistence_restore_revalidates():
    print("restore re-applies good records and IGNORES junk (never trusts the file)")
    writes = []
    restore = _install_fake(writes)
    try:
        # hand-write a persistence file: one good animation, plus junk records
        # (missing led, bad effect, out-of-range params, wrong colour shape).
        import json
        blob = {"version": 1, "leds": {
            "multicolor:front": {"effect": "rainbow", "speed": 60, "brightness": 70},
            "ghost::led": {"effect": "breathe"},               # LED not present
            "multicolor:front-BAD": {"effect": "breathe"},     # not present either
            "locked::led": {"effect": "breathe"},              # present but non-writable
        }}
        with open(cs._LED_STATE_CONF, "w") as f:
            json.dump(blob, f)
        cs._led_restore()
        check("multicolor:front" in cs._FX_ACTIVE
              and cs._FX_ACTIVE["multicolor:front"]["effect"] == "rainbow",
              "good record restored (rainbow re-applied)")
        check("ghost::led" not in cs._FX_ACTIVE and "locked::led" not in cs._FX_ACTIVE,
              "absent / non-writable LEDs skipped, not written")

        # a totally junk file must not throw and must drive nothing
        _reset_engine()
        with open(cs._LED_STATE_CONF, "w") as f:
            f.write("}{ not json")
        cs._led_restore()
        check(not cs._FX_ACTIVE, "corrupt persistence file -> nothing restored")
    finally:
        restore()


def test_gated_go_s_led():
    print("gated go_s rings: effect=monocolor for solid, firmware effect for rainbow/breathe")
    G = "go_s:rgb:joystick_rings"
    writes = []
    restore = _install_fake(writes)
    try:
        # SOLID colour: mode=custom + effect=monocolor BEFORE the colour (or the
        # factory rainbow keeps running), enabled=true is the LAST write.
        writes.clear()
        res = cs.set_led(G, 80, {"r": 255, "g": 0, "b": 0})
        check(res and res.get("ok"), "gated set_led accepted")
        gw = [w for w in writes if w[0] == G]
        attrs = [w[1] for w in gw]
        check((G, "effect", "monocolor") in writes, "solid writes effect=monocolor")
        check("effect" in attrs and "multi_intensity" in attrs
              and attrs.index("effect") < attrs.index("multi_intensity"),
              "effect=monocolor written before the colour")
        check(gw and gw[-1] == (G, "enabled", "true"), "enabled=true is the LAST write")
        check(not any(w == (G, "mode", "dynamic") for w in writes),
              "solid never writes the unsafe mode=dynamic")

        # FIRMWARE effects: rainbow / breathe drive the device's own `effect` (looked
        # up in effect_index), NOT the software render thread, NOT mode=dynamic.
        for eff, fw, wants_color in (("rainbow", "rainbow", False),
                                     ("breathe", "breathe", True),
                                     ("pulse", "breathe", True)):
            _reset_engine()
            writes.clear()
            res = cs.apply_led_effect(G, eff, {"r": 0, "g": 255, "b": 0}, 60, 100)
            check(res and res.get("ok") and res["active"]["effect"] == eff,
                  "gated %s accepted as a live effect" % eff)
            check((G, "effect", fw) in writes,
                  "%s -> firmware effect=%s (looked up in effect_index)" % (eff, fw))
            check(not any(w == (G, "mode", "dynamic") for w in writes),
                  "%s never writes mode=dynamic" % eff)
            check(any(w[0] == G and w[1] == "multi_intensity" for w in writes) == wants_color,
                  "%s writes a colour only when it uses one" % eff)
            check([w[1] for w in writes if w[0] == G][-1] == "enabled",
                  "%s arms enabled LAST" % eff)
            check(G not in cs._FX_ACTIVE, "%s does not start the software render thread" % eff)

        # No firmware analogue (scanner) -> solid colour via effect=monocolor
        _reset_engine()
        writes.clear()
        res = cs.apply_led_effect(G, "scanner", {"r": 255, "g": 0, "b": 0}, 50, 90)
        check(res and res.get("ok") and res.get("active") is None,
              "gated scanner falls back to a solid")
        check((G, "effect", "monocolor") in writes
              and not any(w in ((G, "effect", "rainbow"), (G, "effect", "breathe")) for w in writes),
              "scanner -> effect=monocolor, not a firmware animation")
    finally:
        restore()


def test_normal_led_not_gated():
    print("a plain LED is untouched by the gated path (no mode/enabled writes)")
    writes = []
    restore = _install_fake(writes)
    try:
        cs.set_led("multicolor:front", 50, {"r": 10, "g": 20, "b": 30})
        check(not any(w[1] in ("mode", "enabled") for w in writes),
              "no mode/enabled written for a plain LED")
    finally:
        restore()


def test_mock_effect_observable():
    print("mock: selecting an effect moves GET /api/leds `active` (observe both)")
    saved = dict(cs._MOCK_FX)
    try:
        cs._MOCK_FX.clear()
        st = cs.leds_state(True)
        check("effects" in st and "breathe" in st["effects"],
              "mock payload advertises the effect list")
        check(st.get("active") == {}, "no effect active initially")
        # simulate the POST /api/leds/effect mock branch
        cs._MOCK_FX["multicolor:chassis"] = {"effect": "scanner",
            "color": {"r": 255, "g": 0, "b": 0}, "speed": 80, "brightness": 100}
        st = cs.leds_state(True)
        check(st["active"].get("multicolor:chassis", {}).get("effect") == "scanner",
              "GET reflects the switched-on scanner effect")
    finally:
        cs._MOCK_FX.clear()
        cs._MOCK_FX.update(saved)


if __name__ == "__main__":
    test_validate_effect_body()
    test_frame_bounds()
    test_allowlist_effect()
    test_animate_then_solid_lifecycle()
    test_persistence_restore_revalidates()
    test_gated_go_s_led()
    test_normal_led_not_gated()
    test_mock_effect_observable()
    print()
    if _fail:
        print("FAILED: %d" % len(_fail))
        for f in _fail:
            print("  - " + f)
        raise SystemExit(1)
    print("all led-effect tests passed")
