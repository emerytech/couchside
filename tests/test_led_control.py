#!/usr/bin/env python3
"""Tests for front light-bar / status-LED control (GET /api/leds, POST
/api/leds/set).

Run: python3 tests/test_led_control.py

The property that matters is the allowlist one: the LED a client names is LOOKED
UP in the live os.listdir(/sys/class/leds) set (and must be writable) -- else
NOTHING is written -- and it only ever reaches the filesystem as a bare directory
name joined with FIXED literal attribute file names ('brightness',
'multi_intensity', 'trigger'). A hole here would let a LAN client aim a sysfs
write at an arbitrary path, so the regression below proves an unknown /
traversal-shaped / non-writable id writes nothing, that the trigger write is only
ever the literal 'none', and that colour is written in the device's own channel
order.

NOTE: the notable-vs-noise classifier is tested against SYNTHETIC LED names only
-- we do not yet have /sys/class/leds fixtures copied verbatim from real hardware
(CLAUDE.md §6). That, and the fact the write path has never lit a real LED, are
called out in the PR.

Pure stdlib, no pytest -- same style as the other agent tests.
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


def test_state_payload_mock():
    print("mock state payload")
    st = cs.leds_state(True)
    check(st.get("available") is True, "available: true in mock")
    leds = st.get("leds")
    fields = {"name", "desc", "rgb", "notable", "writable",
              "max_brightness", "brightness", "brightness_pct", "color"}
    check(isinstance(leds, list) and leds, "non-empty leds list")
    check(all(set(l) == fields for l in leds),
          "every led carries exactly the public field set")
    rgb = [l for l in leds if l["rgb"]]
    check(rgb and all(isinstance(l["color"], dict) for l in rgb),
          "rgb leds report a {r,g,b} color")
    check(any(l["notable"] for l in leds) and any(not l["notable"] for l in leds),
          "payload includes both a notable light and a filtered-out noise led")


def test_notable_classifier():
    print("notable classifier (SYNTHETIC names -- no hw fixtures yet)")
    notable = ["multicolor:chassis", "asus::rgb:logo", "phys0:rgb:joystick_rings",
               "steamdeck::status"]
    noise = ["input3::capslock", "input5::numlock", "mmc1::", "phy0-led",
             "input0::scrolllock"]
    check(all(cs._led_notable(n, "rgb" in n or "multicolor" in n) for n in notable),
          "front/status/rgb names are notable")
    check(all(not cs._led_notable(n, False) for n in noise),
          "keyboard/storage/wifi indicator names are filtered out")
    check(cs._led_notable("some_obscure_led", True) is True,
          "ANY rgb led is notable regardless of name")


def test_validate_body():
    print("body validation (reject, don't sanitise)")
    ok = [({"brightness": 0}, (0, None)), ({"brightness": 100}, (100, None)),
          ({"color": {"r": 1, "g": 2, "b": 3}}, (None, {"r": 1, "g": 2, "b": 3}))]
    for body, want in ok:
        b, c, err = cs._validate_led_body(body)
        check(err is None and (b, c) == want, "accepts %s" % body)
    bad = [{}, {"brightness": 150}, {"brightness": -1}, {"brightness": 1.0},
           {"brightness": True}, {"color": {"r": 256, "g": 0, "b": 0}},
           {"color": {"r": -1, "g": 0, "b": 0}}, {"color": {"r": 1, "g": 2}},
           {"color": {"r": 1, "g": 2, "b": 3, "w": 4}}, {"color": [1, 2, 3]},
           {"color": {"r": True, "g": 0, "b": 0}}]
    for body in bad:
        b, c, err = cs._validate_led_body(body)
        check(err is not None, "rejects %s" % body)


# A fake /sys/class/leds. `blue red green` channel order on the RGB LED proves
# the writer reorders client r,g,b into the DEVICE order, not a hard-coded one.
_FAKE = {
    "multicolor:front": {"name": "multicolor:front", "desc": "multicolor:front",
        "rgb": True, "notable": True, "writable": True, "max_brightness": 255,
        "index": ["blue", "red", "green"], "maxint": [255, 255, 255],
        "brightness": 255, "color": {"r": 0, "g": 0, "b": 0}},
    "steamdeck::status": {"name": "steamdeck::status", "desc": "steamdeck::status",
        "rgb": False, "notable": True, "writable": True, "max_brightness": 100,
        "index": [], "maxint": [], "brightness": 60, "color": None},
    "input3::capslock": {"name": "input3::capslock", "desc": "input3::capslock",
        "rgb": False, "notable": False, "writable": True, "max_brightness": 1,
        "index": [], "maxint": [], "brightness": 0, "color": None},
    "locked::led": {"name": "locked::led", "desc": "locked::led", "rgb": True,
        "notable": True, "writable": False, "max_brightness": 255,
        "index": ["red", "green", "blue"], "maxint": [255, 255, 255],
        "brightness": 0, "color": {"r": 0, "g": 0, "b": 0}},
}


def _install_fake(writes, trigger="[heartbeat] none"):
    cs._list_led_names = lambda: list(_FAKE)
    cs._read_led_raw = lambda n: dict(_FAKE[n]) if n in _FAKE else None
    cs._led_realpath_ok = lambda n: True
    cs._led_read_attr = lambda name, attr: trigger if attr == "trigger" else None
    cs._led_write = lambda name, attr, value: writes.append((name, attr, value))


def test_allowlist_write():
    print("allowlist + write path (the regression that matters)")
    saved = {k: getattr(cs, k) for k in
             ("_list_led_names", "_read_led_raw", "_led_realpath_ok",
              "_led_read_attr", "_led_write")}
    writes = []
    _install_fake(writes)
    try:
        for bad in ("not-a-real-led", "", "../../etc/passwd",
                    "multicolor:front/../x", "locked::led", None, 123):
            writes.clear()
            res = cs.set_led(bad, 50, None)
            check(res is None, "refused: %r" % (bad,))
            check(not writes, "nothing written for %r" % (bad,))

        # colour on a mono LED -> 400, nothing written
        writes.clear()
        res = cs.set_led("steamdeck::status", None, {"r": 1, "g": 2, "b": 3})
        check(isinstance(res, dict) and res.get("status") == 400,
              "colour on a mono led -> 400")
        check(not writes, "nothing written when colour rejected on mono led")

        # known rgb led: colour reordered into device order (blue,red,green),
        # trigger cleared to 'none' first, then brightness mapped pct->device.
        writes.clear()
        res = cs.set_led("multicolor:front", 50, {"r": 10, "g": 20, "b": 30})
        check(res and res.get("ok") is True, "known writable rgb led accepted")
        check(("multicolor:front", "trigger", "none") in writes,
              "trigger written exactly 'none' (never any other trigger)")
        check(("multicolor:front", "multi_intensity", "30 10 20") in writes,
              "colour written in DEVICE channel order blue,red,green -> '30 10 20'")
        check(("multicolor:front", "brightness", "128") in writes,
              "brightness 50%% of 255 -> 128")
        check(all(w[1] in ("trigger", "multi_intensity", "brightness")
                  for w in writes),
              "only ever wrote the three fixed-literal attributes")

        # mono led brightness maps against ITS max (100), no colour write
        writes.clear()
        cs.set_led("steamdeck::status", 25, None)
        check(("steamdeck::status", "brightness", "25") in writes,
              "mono brightness 25%% of 100 -> 25")
        check(not any(w[1] == "multi_intensity" for w in writes),
              "no colour write for a mono led")
    finally:
        for k, v in saved.items():
            setattr(cs, k, v)


def test_color_roundtrip_scaling():
    print("colour round-trip is consistent across max_brightness (fallback asymmetry)")
    # rgb LED, max_brightness=64, NO multi_max_intensity — the mainline ABI path
    # where the read and write fallbacks used to disagree and corrupt the colour.
    raw = {"index": ["red", "green", "blue"], "maxint": [], "max_brightness": 64}
    writes = []
    saved = cs._led_write
    cs._led_write = lambda name, attr, value: writes.append((attr, value))
    try:
        cs._led_write_color("x", raw, {"r": 0, "g": 200, "b": 0})
    finally:
        cs._led_write = saved
    mi = dict(writes)["multi_intensity"]
    back = cs._led_color_from_intensity(mi, raw["index"], raw["maxint"], raw["max_brightness"])
    check(back["r"] == 0 and back["b"] == 0 and abs(back["g"] - 200) <= 3,
          "green 200 on a max_brightness=64 LED round-trips within tolerance "
          "(wrote '%s', read back %s)" % (mi, back))


def test_non_rgb_multicolor_is_not_rgb():
    print("amber/white multicolor LED is brightness-only, not colour")
    saved = cs._led_read_attr
    cs._led_read_attr = lambda name, attr: {
        "max_brightness": "255", "brightness": "200",
        "multi_intensity": "128 64", "multi_index": "amber white"}.get(attr)
    try:
        raw = cs._read_led_raw("amber:led")
        check(raw is not None and raw["rgb"] is False,
              "amber/white channels -> rgb False (no colour swatches to darken it)")
        check(raw["color"] is None, "no colour reported for a non-rgb multicolor LED")
    finally:
        cs._led_read_attr = saved


def test_brightness_round_half_up():
    print("50%% of a 2-state (max_brightness=1) LED turns it ON, not off")
    raw = {"name": "on-off", "desc": "on-off", "rgb": False, "notable": True,
           "writable": True, "max_brightness": 1, "brightness": 0,
           "index": [], "maxint": [], "color": None}
    writes = []
    saved = {k: getattr(cs, k) for k in
             ("_list_led_names", "_read_led_raw", "_led_realpath_ok",
              "_led_read_attr", "_led_write")}
    cs._list_led_names = lambda: ["on-off"]
    cs._read_led_raw = lambda n: dict(raw) if n == "on-off" else None
    cs._led_realpath_ok = lambda n: True
    cs._led_read_attr = lambda name, attr: None
    cs._led_write = lambda name, attr, value: writes.append((attr, value))
    try:
        cs.set_led("on-off", 50, None)
        check(("brightness", "1") in writes,
              "brightness 50%% of max 1 -> '1' (ON), not '0'")
        writes.clear()
        cs.set_led("on-off", 25, None)
        check(("brightness", "0") in writes,
              "brightness 25%% of max 1 -> '0' (still OFF below the midpoint)")
    finally:
        for k, v in saved.items():
            setattr(cs, k, v)


def test_mock_switch_is_observable():
    print("mock switch moves state (observe both states)")
    saved = dict(cs._MOCK_LED_STATE)
    try:
        cs._MOCK_LED_STATE.clear()
        cs.set_mock_led("multicolor:chassis", None, {"r": 255, "g": 0, "b": 0})
        cs.set_mock_led("steamdeck::status", 25, None)
        st = {l["name"]: l for l in cs.leds_state(True)["leds"]}
        check(st["multicolor:chassis"]["color"] == {"r": 255, "g": 0, "b": 0},
              "GET reflects the switched-to colour")
        check(st["steamdeck::status"]["brightness_pct"] == 25,
              "GET reflects the dimmed brightness")
    finally:
        cs._MOCK_LED_STATE.clear()
        cs._MOCK_LED_STATE.update(saved)


def test_caps_key_registered():
    print("caps key (six-edit-site rule, agent half)")
    src = open(AGENT).read()
    check('"ledcontrol")' in src or '"ledcontrol",' in src,
          "ledcontrol present in the mock all-true caps tuple")
    check('"ledcontrol": safe(ledcontrol_available)' in src,
          "ledcontrol wired into the real CAPS dict")


if __name__ == "__main__":
    test_state_payload_mock()
    test_notable_classifier()
    test_validate_body()
    test_allowlist_write()
    test_color_roundtrip_scaling()
    test_non_rgb_multicolor_is_not_rgb()
    test_brightness_round_half_up()
    test_mock_switch_is_observable()
    test_caps_key_registered()
    print()
    if _fail:
        print("FAILED: %d" % len(_fail))
        for f in _fail:
            print("  - " + f)
        raise SystemExit(1)
    print("all led-control tests passed")
