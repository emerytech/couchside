#!/usr/bin/env python3
"""Pins the adversarial-review fixes cut into agent 2.9.117 (reactive LED meters +
playtime countdown + recommendations). Each test names the failure it prevents.

Run: python3 tests/test_led_review_2917.py

  A  `effects` in GET /api/leds lists ONLY the single-LED menu ids shipped apps know.
     Apps up to 2.9.62 look up a label for every id and CRASH on an unknown one, so
     meter_cpu / meter_battery / playtime are advertised through `reactive` only.
  B  An all-dark strip frame is painted ONCE, then the strip is left alone. A dark
     frame has no canary, so repainting it every tick blanked Steam's own bar.
  C  A countdown that reaches zero is FORGOTTEN (render stops, persisted entry
     dropped); one that expired while the box was off is not re-armed at boot.
  D  The strip route refuses a meter this box cannot read (no battery -> no
     battery meter) instead of rendering a dark bar forever. Nothing is written.
  E  Non-scalar config values (lists/objects) are a 400, never a 500 TypeError.
  F  Steam runtimes / Proton / redistributables are never recommended.
  Delta review of the fix itself:
  G  A stood-down strip whose effect has all-dark frames (wipe once per period, an
     idle CPU meter) still RESUMES once Steam lets go. The first cut dropped the
     probe canary on every dark frame and those strips stayed stood down forever.
  H  Finishing an old countdown never forgets a countdown restarted after it
     (identity in the render set AND the persisted deadline must both match).

Pure stdlib, no pytest -- same style as test_led_playtime.py.
"""
import http.client
import importlib.util
import json
import os
import tempfile
import threading
import time
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT = os.path.join(HERE, "..", "agent", "couchsided.py")
spec = importlib.util.spec_from_file_location("couchsided", AGENT)
cs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cs)

PASS = "  \033[32mPASS\033[0m"
FAIL = "  \033[31mFAIL\033[0m"
_fail = []
TOKEN = "t" * 32


def check(cond, label):
    print((PASS if cond else FAIL) + "  " + label)
    if not cond:
        _fail.append(label)


# The single-LED effect ids every shipped app (<= 2.9.62) has a label for
# (RgbLedCard EFFECT_META). Adding an id here is fine only once no supported app
# would crash on it -- that is the whole point of fix A.
_SHIPPED_APP_EFFECTS = ["solid", "off", "breathe", "pulse", "rainbow", "strobe",
                        "scanner", "manual", "circle", "comet", "wipe", "twinkle"]

_N = 8
_FAKE = {("valve-leds[%d]" % i): {"name": "valve-leds[%d]" % i,
    "desc": "valve-leds[%d]" % i, "rgb": True, "notable": True, "writable": True,
    "max_brightness": 255, "index": ["red", "green", "blue"],
    "maxint": [255, 255, 255], "brightness": 0, "color": {"r": 0, "g": 0, "b": 0}}
    for i in range(_N)}


def _install(writes, readback=None):
    """Fake 8-node valve-leds strip. `readback(name, attr)` answers reads."""
    saved = {k: getattr(cs, k) for k in
             ("_list_led_names", "_read_led_raw", "_led_realpath_ok",
              "_led_read_attr", "_led_write", "_seq_ensure_thread", "_LED_STATE_CONF")}
    fd, tmp = tempfile.mkstemp(prefix="test-2917-", suffix=".json")
    os.close(fd)
    cs._LED_STATE_CONF = tmp
    cs._list_led_names = lambda: list(_FAKE)
    cs._read_led_raw = lambda n: dict(_FAKE[n]) if n in _FAKE else None
    cs._led_realpath_ok = lambda n: True
    cs._led_read_attr = readback or (lambda name, attr: "[none]" if attr == "trigger" else None)
    cs._led_write = lambda name, attr, value: writes.append((name, attr, value))
    cs._seq_ensure_thread = lambda: None

    def restore():
        for k, v in saved.items():
            setattr(cs, k, v)
        with cs._SEQ_LOCK:
            cs._SEQ_ACTIVE.clear()
        with cs._FX_LOCK:
            cs._LED_PERSIST.clear()
        try:
            os.unlink(tmp)
        except OSError:
            pass
    return restore, tmp


def _server(mock):
    cs.Handler.token = TOKEN
    cs.Handler.token_file = None
    cs.Handler.mock = mock
    cs.Handler.port = 0
    srv = ThreadingHTTPServer(("127.0.0.1", 0), cs.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


def _req(port, method, path, body=None, token=TOKEN):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    headers = {"Authorization": "Bearer " + token} if token is not None else {}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    conn.request(method, path, body=data, headers=headers)
    resp = conn.getresponse()
    raw = resp.read()
    conn.close()
    try:
        return resp.status, json.loads(raw or b"{}")
    except ValueError:
        return resp.status, {}


# --------------------------------------------------------------------------- A
def test_a_effects_list_is_what_shipped_apps_know():
    print("A: GET /api/leds `effects` keeps strip-only ids out; `reactive` carries them")
    st = cs.leds_state(True)
    check(st["effects"] == _SHIPPED_APP_EFFECTS,
          "mock `effects` == the 12 ids apps <= 2.9.62 can label")
    check(st["reactive"]["meters"] == ["meter_cpu", "meter_battery"]
          and st["reactive"]["playtime"] is True,
          "mock `reactive` still advertises both meters + playtime")
    writes = []
    restore, _ = _install(writes)
    saved = (cs.read_cpu_temp_c, cs.read_box_battery)
    try:
        cs.read_cpu_temp_c = lambda: 50.0
        cs.read_box_battery = lambda: {"pct": 80}
        st = cs.leds_state(False)
        check(st["effects"] == _SHIPPED_APP_EFFECTS,
              "real `effects` == the 12 ids apps <= 2.9.62 can label")
        check(not (set(st["effects"]) & {"meter_cpu", "meter_battery", "playtime"}),
              "no strip-only id leaks into `effects`")
        check(st["reactive"]["meters"] == ["meter_cpu", "meter_battery"],
              "real `reactive` offers both meters when both signals read")
    finally:
        cs.read_cpu_temp_c, cs.read_box_battery = saved
        restore()
    # The allowlist itself is unchanged: the ids are still accepted on a strip.
    check(all(e in cs._LED_EFFECTS for e in ("meter_cpu", "meter_battery", "playtime")),
          "strip-only ids are still in the frozen accept-list")


# --------------------------------------------------------------------------- B
def _dark_spec():
    return {"prefix": "valve-leds", "members": ["valve-leds[%d]" % i for i in range(_N)],
            "effect": "playtime", "color": {"r": 0, "g": 0, "b": 0}, "speed": 50,
            "brightness": 100, "reverse": False, "t0": 0.0,
            "raws": {n: dict(_FAKE[n]) for n in _FAKE},
            "playtime": {"minutes": 30, "scale": 0, "deadline": time.time() - 5}}


def test_b_dark_frame_painted_once():
    print("B: a dark frame is painted ONCE, then the strip is left alone")
    writes = []
    restore, _ = _install(writes)
    try:
        sp = _dark_spec()
        cs._seq_render(sp, 1.0)
        first = len(writes)
        check(first > 0, "first dark frame is written (the bar goes dark once)")
        for t in range(2, 40):
            cs._seq_render(sp, float(t))
        check(len(writes) == first,
              "38 further dark ticks write NOTHING (no 30fps blanking of Steam's bar)")
        check(not sp.get("_down"), "going dark is not scored as a Steam takeover")
        # The frame lights again (a new countdown): painting resumes at once.
        sp["playtime"]["deadline"] = time.time() + 20 * 60
        sp.pop("_expired", None)
        cs._seq_render(sp, 50.0)
        check(len(writes) > first, "a lit frame after dark paints again")
        check(sp.get("_dark") is False, "dark latch clears on a lit frame")
    finally:
        restore()


def test_b_control_lit_frames_repaint_every_tick():
    print("B control: LIT frames still repaint every tick (the guard is dark-only)")
    writes = []
    restore, _ = _install(writes)
    try:
        sp = _dark_spec()
        sp["playtime"]["deadline"] = time.time() + 20 * 60
        cs._seq_render(sp, 1.0)
        a = len(writes)
        cs._seq_render(sp, 2.0)
        check(a > 0 and len(writes) > a, "each lit tick writes (animation not frozen)")
    finally:
        restore()


# --------------------------------------------------------------------------- C
def test_c_expired_countdown_is_forgotten():
    print("C: a countdown at zero stops rendering and is dropped from persistence")
    writes = []
    restore, tmp = _install(writes)
    try:
        res = cs.apply_strip_effect("valve-leds", "playtime", None, 50, 100, False, None,
                                    {"minutes": 30, "scale": 0})
        check(res and res.get("ok"), "playtime starts")
        sp = cs._SEQ_ACTIVE.get("valve-leds")
        check(sp is not None and sp.get("prefix") == "valve-leds", "spec carries its prefix")
        check("strip:valve-leds" in cs._LED_PERSIST, "countdown is persisted while running")
        # Not expired yet: finishing must not be triggered by a live frame.
        cs._seq_playtime_frame(sp, 0.0)
        check(not sp.get("_expired"), "a running countdown is not marked expired")
        # The same timer, now past its deadline (spec + persisted copy agree).
        cs.apply_strip_effect("valve-leds", "playtime", None, 50, 100, False, None,
                              {"minutes": 30, "scale": 0, "deadline": time.time() - 1})
        sp = cs._SEQ_ACTIVE.get("valve-leds")
        cs._seq_playtime_frame(sp, 0.0)
        check(sp.get("_expired") is True, "a countdown past its deadline is marked expired")
        cs._playtime_finish(sp)
        check("valve-leds" not in cs._SEQ_ACTIVE, "render loop no longer holds the strip")
        check("strip:valve-leds" not in cs._LED_PERSIST, "persisted entry dropped")
        on_disk = json.load(open(tmp)).get("leds", {})
        check("strip:valve-leds" not in on_disk, "dropped from the state FILE too (no boot re-arm)")
    finally:
        restore()


def test_c_render_loop_finishes_expired():
    print("C: the render loop itself retires an expired countdown and exits")
    writes = []
    restore, _ = _install(writes)
    try:
        cs.apply_strip_effect("valve-leds", "playtime", None, 50, 100, False, None,
                              {"minutes": 30, "deadline": time.time() - 1})
        th = threading.Thread(target=cs._seq_loop, daemon=True)
        th.start()
        th.join(3.0)
        alive = th.is_alive()
        if alive:                                  # unfixed: loops forever on a dark bar
            cs._FX_STOP.set()
            th.join(2.0)
            cs._FX_STOP.clear()
        check(not alive, "loop exits on its own once the only countdown expires")
        check("valve-leds" not in cs._SEQ_ACTIVE and "strip:valve-leds" not in cs._LED_PERSIST,
              "strip released + forgotten by the loop")
    finally:
        restore()


def test_c_finish_leaves_a_newer_effect_alone():
    print("C: finishing an old countdown never removes an effect set after it")
    writes = []
    restore, _ = _install(writes)
    try:
        cs.apply_strip_effect("valve-leds", "playtime", None, 50, 100, False, None,
                              {"minutes": 30})
        old = cs._SEQ_ACTIVE.get("valve-leds")
        cs.apply_strip_effect("valve-leds", "comet", {"r": 0, "g": 0, "b": 255}, 50, 100,
                              False, None, None)
        cs._playtime_finish(old)
        check(cs._SEQ_ACTIVE.get("valve-leds") is not None
              and cs._SEQ_ACTIVE["valve-leds"].get("effect") == "comet",
              "the newer comet keeps rendering")
        check(cs._LED_PERSIST.get("strip:valve-leds", {}).get("effect") == "comet",
              "the newer comet stays persisted")
    finally:
        restore()


def test_h_finish_keeps_a_restarted_countdown():
    print("H: finishing an old countdown never forgets one restarted after it")
    writes = []
    restore, tmp = _install(writes)
    try:
        cs.apply_strip_effect("valve-leds", "playtime", None, 50, 100, False, None,
                              {"minutes": 30, "deadline": time.time() - 1})
        old = cs._SEQ_ACTIVE.get("valve-leds")
        cs._seq_playtime_frame(old, 0.0)
        check(old.get("_expired") is True, "old countdown marked expired by the render thread")
        # The user restarts the timer before the loop gets to finish the old one.
        cs.apply_strip_effect("valve-leds", "playtime", None, 50, 100, False, None,
                              {"minutes": 20})
        new_dl = cs._SEQ_ACTIVE["valve-leds"]["playtime"]["deadline"]
        cs._playtime_finish(old)
        check(cs._SEQ_ACTIVE.get("valve-leds") is not None
              and cs._SEQ_ACTIVE["valve-leds"] is not old, "the new countdown keeps rendering")
        per = cs._LED_PERSIST.get("strip:valve-leds", {})
        check(per.get("effect") == "playtime" and per.get("playtime", {}).get("deadline") == new_dl,
              "the new countdown stays persisted (GET active + reboot keep it)")
        # Between-locks race: the render set still holds the old spec, but a newer
        # countdown already replaced the persisted entry. Only OUR deadline is dropped.
        with cs._SEQ_LOCK:
            cs._SEQ_ACTIVE["valve-leds"] = old
        cs._playtime_finish(old)
        check("valve-leds" not in cs._SEQ_ACTIVE, "old spec leaves the render set")
        check(cs._LED_PERSIST.get("strip:valve-leds", {}).get("playtime", {}).get("deadline") == new_dl,
              "a persisted countdown with a different deadline is left alone")
        # The other half of the window: a POST has already put a NEW spec in the
        # render set but not yet rewritten the saved entry (still the old deadline).
        # The strip belongs to the new effect now, so finishing the old spec is a no-op.
        cs.apply_strip_effect("valve-leds", "playtime", None, 50, 100, False, None,
                              {"minutes": 30, "deadline": time.time() - 1})
        old2 = cs._SEQ_ACTIVE["valve-leds"]
        newer = dict(old2, effect="comet", playtime=None)
        with cs._SEQ_LOCK:
            cs._SEQ_ACTIVE["valve-leds"] = newer
        cs._playtime_finish(old2)
        check(cs._SEQ_ACTIVE.get("valve-leds") is newer
              and "strip:valve-leds" in cs._LED_PERSIST,
              "once the strip belongs to a newer spec, finishing the old one touches nothing")
    finally:
        restore()


def _resume_after_release(effect, speed=50, meter_seq=None):
    """Steam owns the bar for 5 s (reads back black), then lets go. Returns
    (stood_down, seconds_to_resume or None within 60 s simulated)."""
    import itertools
    hw, steam = {}, {"on": True}
    saved = (cs._led_write, cs._led_read_attr, getattr(cs, "_meter_read", None))
    cs._led_write = lambda name, attr, v: hw.__setitem__(name, v) if attr == "multi_intensity" else None
    cs._led_read_attr = lambda name, attr: (("0 0 0" if steam["on"] else hw.get(name))
                                            if attr == "multi_intensity" else None)
    if meter_seq is not None:
        vals = itertools.cycle(meter_seq)
        cs._meter_read = lambda kind, prev=None: (next(vals), 50.0, None)
    try:
        n = 17
        members = ["valve-leds[%d]" % i for i in range(n)]
        sp = {"members": members, "effect": effect, "color": {"r": 255, "g": 0, "b": 0},
              "speed": speed, "brightness": 100, "reverse": False, "t0": 0.0,
              "raws": {m: dict(_FAKE["valve-leds[0]"], name=m) for m in members},
              "meter": {}, "prefix": "valve-leds"}
        t = 0.0
        while t < 5.0:
            cs._seq_render(sp, t)
            t += 0.033
        down = bool(sp.get("_down"))
        steam["on"] = False
        freed = t
        while t < freed + 60.0:
            cs._seq_render(sp, t)
            t += 0.033
            if not sp.get("_down"):
                return down, round(t - freed, 1)
        return down, None
    finally:
        cs._led_write, cs._led_read_attr = saved[0], saved[1]
        if saved[2] is not None:
            cs._meter_read = saved[2]


def test_g_dark_frames_still_resume():
    print("G: a stood-down strip with all-dark frames still resumes when Steam lets go")
    for label, kw in (("circle (control, never all dark)", {"effect": "circle", "speed": 100}),
                      ("meter_cpu busy (control)", {"effect": "meter_cpu", "meter_seq": (30.0, 40.0)}),
                      ("wipe speed 100", {"effect": "wipe", "speed": 100}),
                      ("wipe speed 55 (app default)", {"effect": "wipe", "speed": 55}),
                      ("meter_cpu idle 1%/5%", {"effect": "meter_cpu", "meter_seq": (1.0, 5.0)})):
        down, resumed = _resume_after_release(**kw)
        check(down and resumed is not None and resumed < 15.0,
              "%s: stood down under Steam, resumed %ss after release" % (label, resumed))


def _resume_ticks(effect, speed=50, meter_seq=None):
    down, secs = _resume_after_release(effect, speed=speed, meter_seq=meter_seq)
    return down, secs


def test_g2_dark_frame_effects_resume_promptly():
    print("G2: a dark-frame effect resumes SOON after release (no stale-canary delay)")
    for label, kw in (("wipe speed 55 (app default)", {"effect": "wipe", "speed": 55}),
                      ("wipe speed 100", {"effect": "wipe", "speed": 100}),
                      ("meter_cpu flapping 1/5%", {"effect": "meter_cpu", "meter_seq": (1.0, 5.0)})):
        down, secs = _resume_ticks(**kw)
        # 04a7315 never resumed; the first 2.9.117 cut resumed but as slow as ~13 s on
        # a dark-tick collision. The fix keeps it well under the old worst case.
        check(down and secs is not None and secs < 9.0,
              "%s resumes %ss after release (< 9 s, no dark-tick delay)" % (label, secs))


def test_fixc_dark_tick_does_not_burn_the_probe_slot():
    print("fixC: a stood-down dark tick neither advances the probe clock nor repaints")
    saved = (cs._led_write, cs._led_read_attr, getattr(cs, "_meter_read", None))
    writes = []
    cs._led_write = lambda name, attr, v: writes.append((name, attr, v))
    cs._led_read_attr = lambda name, attr: None            # canary unreadable -> matched None
    cs._meter_read = lambda kind, prev=None: (0.0, 50.0, None)   # 0% -> a fully DARK frame
    try:
        members = ["valve-leds[%d]" % i for i in range(17)]
        sp = {"members": members, "effect": "meter_cpu", "color": {"r": 255, "g": 0, "b": 0},
              "speed": 50, "brightness": 100, "reverse": False, "t0": 0.0,
              "raws": {m: dict(_FAKE["valve-leds[0]"], name=m) for m in members},
              "meter": {}, "prefix": "valve-leds",
              # Already stood down, probe due now, one clean hit banked, a lit canary
              # from before it went dark (so the mutant has something to mis-score).
              "_down": True, "_dark": False, "_hit": 1, "_miss": 0,
              "_probe_at": 5.0, "_canary": ("valve-leds[0]", "0 147 205")}
        cs._seq_render(sp, 10.0)
        check(sp.get("_probe_at") == 5.0,
              "dark tick does NOT push _probe_at forward (the slot waits for a lit frame)")
        check(not any(w[1] == "multi_intensity" for w in writes),
              "dark tick writes no colour (never repaints the whole dark strip over Steam)")
    finally:
        cs._led_write, cs._led_read_attr = saved[0], saved[1]
        if saved[2] is not None:
            cs._meter_read = saved[2]


def test_stray_probe_led_cleared_when_frame_goes_dark():
    print("stray LED: a stood-down probe is dimmed once the frame goes fully dark")
    # Drive _seq_render directly: stand the strip down under Steam, then feed a
    # permanently-dark frame (an ended countdown / flat-idle meter). The one member
    # our probe lit must be written brightness 0, and only if Steam left it alone.
    import itertools
    hw, steam = {}, {"on": True}
    saved = (cs._led_write, cs._led_read_attr)
    writes = []
    def w(name, attr, v):
        if attr == "multi_intensity":
            hw[name] = v
        if attr == "brightness":
            writes.append((name, v))
    cs._led_write = lambda name, attr, v: w(name, attr, v)
    cs._led_read_attr = lambda name, attr: (("0 0 0" if steam["on"] else hw.get(name))
                                            if attr == "multi_intensity" else None)
    try:
        n = 17
        members = ["valve-leds[%d]" % i for i in range(n)]
        sp = {"members": members, "effect": "meter_cpu", "color": {"r": 255, "g": 0, "b": 0},
              "speed": 50, "brightness": 100, "reverse": False, "t0": 0.0,
              "raws": {m: dict(_FAKE["valve-leds[0]"], name=m) for m in members},
              "meter": {}, "prefix": "valve-leds"}
        cs._meter_read = lambda kind, prev=None: (30.0, 50.0, None)     # busy: lights the bar
        tt = 0.0
        while tt < 5.0:                             # Steam owns the bar -> we stand down
            cs._seq_render(sp, tt); tt += 0.033
        check(sp.get("_down"), "strip stood down under Steam")
        steam["on"] = False                         # Steam lets go; a lit probe lands
        while tt < 9.0:
            cs._seq_render(sp, tt); tt += 0.033     # resumes/probes on lit frames; canary is ours
        cn = sp.get("_canary", (None, None))
        # Now the box goes flat idle: the smoothed meter decays to 0 lit LEDs.
        cs._meter_read = lambda kind, prev=None: (0.0, 50.0, None)
        writes.clear()
        while tt < 20.0:
            cs._seq_render(sp, tt); tt += 0.033
        cleared = [wr for wr in writes if wr[1] == "0"]
        check(len(cleared) >= 1, "the stray probe LED is written brightness 0 once the frame goes dark")
        # Control: if Steam owns the node (canary reads back NOT ours) we must not write it.
        steam["on"] = True                          # Steam clobbers every node
        cs._meter_read = lambda kind, prev=None: (30.0, 50.0, None)
        while tt < 26.0:
            cs._seq_render(sp, tt); tt += 0.033     # re-arm: a lit tick then decay, Steam owning
        cs._meter_read = lambda kind, prev=None: (0.0, 50.0, None)
        writes.clear()
        while tt < 34.0:
            cs._seq_render(sp, tt); tt += 0.033
        check(not any(wr[1] == "0" for wr in writes),
              "control: nothing written to clear when Steam owns the node (canary not ours)")
    finally:
        cs._led_write, cs._led_read_attr = saved
        if hasattr(cs, "_meter_read"):
            pass


def test_mock_forgets_finished_countdown():
    print("mock: GET forgets a countdown that has finished (same as a real box)")
    saved = dict(cs._MOCK_FX)
    try:
        cs._MOCK_FX.clear()
        cs._MOCK_FX["strip:valve-leds"] = {"effect": "playtime", "brightness": 100,
            "playtime": {"minutes": 5, "deadline": time.time() - 1}}
        check("strip:valve-leds" not in cs.leds_state(True)["active"],
              "expired mock countdown is gone from active")
        cs._MOCK_FX["strip:valve-leds"] = {"effect": "playtime", "brightness": 100,
            "playtime": {"minutes": 5, "deadline": time.time() + 120}}
        check("strip:valve-leds" in cs.leds_state(True)["active"],
              "control: a running mock countdown stays in active")
    finally:
        cs._MOCK_FX.clear()
        cs._MOCK_FX.update(saved)


def _restore_with_deadline(deadline):
    writes = []
    restore, tmp = _install(writes)
    try:
        json.dump({"version": 1, "leds": {"strip:valve-leds": {
            "effect": "playtime", "color": {"r": 0, "g": 0, "b": 0}, "speed": 50,
            "brightness": 100, "playtime": {"minutes": 30, "scale": 0,
                                            "deadline": deadline}}}}, open(tmp, "w"))
        with cs._FX_LOCK:
            cs._LED_PERSIST.clear()
            cs._LED_PERSIST.update(json.load(open(tmp))["leds"])
        cs._led_restore()
        sp = cs._SEQ_ACTIVE.get("valve-leds")
        dl = (sp or {}).get("playtime", {}).get("deadline")
        return (sp is not None,
                "strip:valve-leds" in json.load(open(tmp)).get("leds", {}), dl)
    finally:
        restore()


def test_c_boot_restore_skips_expired():
    print("C: boot restore drops a countdown that ended while the box was off")
    armed, kept, _ = _restore_with_deadline(time.time() - 60)
    check(not armed, "expired countdown is NOT re-armed at boot")
    check(not kept, "expired countdown is dropped from the state file")
    armed, kept, _ = _restore_with_deadline(time.time() + 10 * 60)
    check(armed, "control: a countdown still running IS resumed at boot")
    import math
    armed, _, dl = _restore_with_deadline(float("nan"))
    check(armed and isinstance(dl, (int, float)) and math.isfinite(dl) and dl > time.time(),
          "a NaN deadline in a corrupted state file -> a fresh finite timer (never NaN)")


# --------------------------------------------------------------------------- D/E
def test_d_e_route_rejections():
    print("D/E: strip route refuses unreadable meters + non-scalar config, writes nothing")
    writes = []
    restore, _ = _install(writes)
    saved = (cs.read_cpu_temp_c, cs.read_box_battery)
    srv, port = _server(mock=False)
    try:
        cs.read_cpu_temp_c = lambda: 50.0
        cs.read_box_battery = lambda: None          # this box has no battery
        st, _ = _req(port, "POST", "/api/leds/effect",
                     {"strip": "valve-leds", "effect": "meter_battery"}, token=None)
        check(st == 401, "no token -> 401")
        st, body = _req(port, "POST", "/api/leds/effect",
                        {"strip": "valve-leds", "effect": "meter_battery"})
        check(st == 400 and "not available" in body.get("error", ""),
              "battery meter on a battery-less box -> 400")
        check(not writes and "valve-leds" not in cs._SEQ_ACTIVE,
              "nothing written, nothing started for the refused meter")
        st, _ = _req(port, "POST", "/api/leds/effect",
                     {"strip": "valve-leds", "effect": "meter_cpu"})
        check(st == 200 and "valve-leds" in cs._SEQ_ACTIVE,
              "control: CPU meter (readable) -> 200 and starts")
        for body in ({"strip": "valve-leds", "effect": "meter_cpu", "layout": []},
                     {"strip": "valve-leds", "effect": "meter_cpu", "layout": {}},
                     {"strip": "valve-leds", "effect": "meter_cpu", "smooth": ["balanced"]},
                     {"strip": "valve-leds", "effect": "playtime", "layout": ["linear"]},
                     {"strip": "valve-leds", "effect": "playtime", "scale": [1]},
                     {"strip": "valve-leds", "effect": "playtime", "scale": {}},
                     {"strip": "valve-leds", "effect": "playtime", "scale": 1.0}):
            st, _ = _req(port, "POST", "/api/leds/effect", body)
            check(st == 400, "rejects %s -> 400 (not a 500)" % {k: body[k] for k in body if k != "strip"})
        st, _ = _req(port, "POST", "/api/leds/effect",
                     {"strip": "valve-leds", "effect": "playtime", "scale": 2, "layout": "mirrored"})
        check(st == 200, "control: valid playtime config -> 200")
    finally:
        srv.shutdown()
        cs.read_cpu_temp_c, cs.read_box_battery = saved
        restore()


def test_mock_single_led_refuses_strip_only():
    print("mock: a strip-only effect on a single LED is a 400, like the real path")
    srv, port = _server(mock=True)
    saved = dict(cs._MOCK_FX)
    saved_orgb = dict(cs._MOCK_ORGB_FX)
    try:
        led = next(l["name"] for l in cs.MOCK_LEDS if l["writable"] and l["rgb"])
        for eff in ("meter_cpu", "meter_battery", "playtime"):
            st, _ = _req(port, "POST", "/api/leds/effect", {"led": led, "effect": eff})
            check(st == 400 and led not in cs._MOCK_FX, "%s on %s -> 400, nothing stored" % (eff, led))
        st, _ = _req(port, "POST", "/api/leds/effect", {"led": led, "effect": "breathe"})
        check(st == 200, "control: breathe on the same LED -> 200")
        dev = cs.MOCK_ORGB[0]["index"]
        for eff in ("meter_cpu", "playtime"):
            st, _ = _req(port, "POST", "/api/openrgb/set", {"device": dev, "effect": eff})
            check(st == 400 and dev not in cs._MOCK_ORGB_FX,
                  "%s on mock OpenRGB device -> 400, nothing stored" % eff)
        st, _ = _req(port, "POST", "/api/openrgb/set", {"device": dev, "effect": "rainbow"})
        check(st == 200, "control: rainbow on the same OpenRGB device -> 200")
    finally:
        srv.shutdown()
        cs._MOCK_FX.clear()
        cs._MOCK_FX.update(saved)
        cs._MOCK_ORGB_FX.clear()
        cs._MOCK_ORGB_FX.update(saved_orgb)


# --------------------------------------------------------------------------- F
def test_f_reco_skips_steam_tools():
    print("F: Steam runtimes / Proton / redistributables are never recommended")
    DAY = 86400
    now = time.time()
    installed = {"1145360", "228980", "1628350", "1070560", "4242420"}
    ranked = cs._reco_rank({"1145360": {"playtime_min": 600, "last_played": int(now) - 3 * DAY},
                            "228980": {"playtime_min": 900, "last_played": int(now) - DAY}},
                           installed, now, 5)
    picks = [p["appid"] for p in [ranked["primary"]] + ranked["alternates"] if p]
    check(not (set(picks) & set(cs.STEAM_TOOL_APPIDS)),
          "_reco_rank never returns a STEAM_TOOL_APPIDS id (even with playtime)")
    check("1145360" in picks and "4242420" in picks,
          "control: the real game and the never-played game are still offered")
    saved = {k: getattr(cs, k) for k in ("_steam_root", "_steam_playtime",
                                         "_installed_appids", "_steam_appinfo_names")}
    srv, port = _server(mock=False)
    try:
        cs._steam_root = lambda: "/fake/steam"
        cs._steam_playtime = lambda root: {}
        cs._installed_appids = lambda root: {"1145360", "3658110", "228980"}
        cs._steam_appinfo_names = lambda: {1145360: "Hades", 3658110: "Proton 10.0",
                                           228980: "Steamworks Common Redistributables"}
        p = cs._recommend_payload()
        picks = [q["appid"] for q in [p["primary"]] + p["alternates"] if q]
        check(picks == ["1145360"], "only the game is offered (tool by id AND by name dropped)")
        st, _ = _req(port, "GET", "/api/recommend", token=None)
        check(st == 401, "GET /api/recommend without a token -> 401")
        st, body = _req(port, "GET", "/api/recommend")
        check(st == 200 and body.get("primary", {}).get("name") == "Hades",
              "GET /api/recommend -> 200 with the game as the pick")
    finally:
        srv.shutdown()
        for k, v in saved.items():
            setattr(cs, k, v)


if __name__ == "__main__":
    test_a_effects_list_is_what_shipped_apps_know()
    test_b_dark_frame_painted_once()
    test_b_control_lit_frames_repaint_every_tick()
    test_c_expired_countdown_is_forgotten()
    test_c_render_loop_finishes_expired()
    test_c_finish_leaves_a_newer_effect_alone()
    test_c_boot_restore_skips_expired()
    test_h_finish_keeps_a_restarted_countdown()
    test_g_dark_frames_still_resume()
    test_g2_dark_frame_effects_resume_promptly()
    test_fixc_dark_tick_does_not_burn_the_probe_slot()
    test_stray_probe_led_cleared_when_frame_goes_dark()
    test_mock_forgets_finished_countdown()
    test_d_e_route_rejections()
    test_mock_single_led_refuses_strip_only()
    test_f_reco_skips_steam_tools()
    print()
    if _fail:
        print("FAILED: %d" % len(_fail))
        for f in _fail:
            print("  - " + f)
        raise SystemExit(1)
    print("all 2.9.117 review-fix tests passed")
