#!/usr/bin/env python3
"""Tests for the LED strip STAND-DOWN under an external writer (valve-leds).

Run: python3 tests/test_led_standdown.py

On a Steam Deck / Machine, Steam grabs the front strip for its own use (download
progress, etc.) by writing multi_intensity in the SAME `manual` mode the agent's
sequence engine paints in. Our ~30fps repaint then FIGHTS Steam's writes and the
bar flickers between our frame and all-black (observed on hardware: ~half of a
fast sample read [0 0 0] on every node at once).

The fix: read back a canary node each frame; when our paint stops sticking, STOP
writing (let Steam own the bar) and probe a single node on a slow cadence,
resuming only once our paint holds again.

The properties that matter, and are proved here by OBSERVING BOTH STATES:
  * paint sticks  -> never stands down, keeps painting  (the control)
  * paint clobbered -> stands down after a few frames, then stops writing
  * strip freed   -> resumes after a clean-probe streak
  * an undeterminable readback (None) never trips it (degrade closed)
  * only the fixed-literal attrs are ever written (no new write surface, §3)

Pure stdlib, no pytest.
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


_N = 3


def _raw(name):
    return {"name": name, "desc": name, "rgb": True, "notable": True,
            "writable": True, "max_brightness": 255,
            "index": ["red", "green", "blue"], "maxint": [255, 255, 255],
            "brightness": 0, "color": {"r": 0, "g": 0, "b": 0}}


def _make_spec():
    """A 3-node strip playing a 2-frame all-red / all-blue sequence (both frames
    light node 0, so the canary is always verifiable)."""
    members = ["valve-leds[%d]" % i for i in range(_N)]
    R = [{"r": 255, "g": 0, "b": 0} for _ in range(_N)]
    B = [{"r": 0, "g": 0, "b": 255} for _ in range(_N)]
    return {"members": members, "effect": "sequence", "frames": [R, B],
            "hold_ms": 100, "holds": None, "loop": True, "brightness": 100,
            "color": {"r": 255, "g": 255, "b": 255}, "speed": 50,
            "t0": 0.0, "raws": {n: _raw(n) for n in members}}


def _install(steam):
    """Fake sysfs. `steam` is a mutable {"on": bool}: when on, every
    multi_intensity readback comes back [0 0 0] (Steam has blanked the strip),
    modelling the observed contention; when off, our last write reads back (our
    paint sticks). Returns (writes, restore)."""
    saved = {k: getattr(cs, k) for k in ("_led_write", "_led_read_attr")}
    writes = []
    hw = {}

    def _write(name, attr, value):
        writes.append((name, attr, value))
        if attr == "multi_intensity":
            hw[name] = value

    def _read(name, attr):
        if attr == "multi_intensity":
            return "0 0 0" if steam["on"] else hw.get(name)
        if attr == "trigger":
            return "[none]"
        return None

    cs._led_write = _write
    cs._led_read_attr = _read

    def restore():
        for k, v in saved.items():
            setattr(cs, k, v)
    return writes, restore


# --------------------------------------------------------------------------- #
# Pure decider: fires, ignores None, resumes -- all thresholds observed both ways
# --------------------------------------------------------------------------- #
def test_decider_fires_and_controls():
    print("decider: clobbered N times stands down; clean paint never does")
    # CONTROL: a paint that always sticks must NEVER stand down, however long.
    st = {}
    for _ in range(50):
        down = cs._seq_standdown_decide(st, True, 0.0)
        if down:
            break
    check(not st.get("_down"), "clean paint never stands down (control)")

    # FIRES: exactly _SEQ_STANDDOWN_MISS consecutive misses trip it, not fewer.
    st = {}
    for i in range(cs._SEQ_STANDDOWN_MISS - 1):
        cs._seq_standdown_decide(st, False, 0.0)
    check(not st.get("_down"),
          "not down at %d misses" % (cs._SEQ_STANDDOWN_MISS - 1))
    cs._seq_standdown_decide(st, False, 0.0)
    check(st.get("_down") is True,
          "down at %d misses" % cs._SEQ_STANDDOWN_MISS)


def test_decider_none_ignored():
    print("decider: an undeterminable readback (None) never trips it")
    st = {}
    for _ in range(cs._SEQ_STANDDOWN_MISS + 5):
        cs._seq_standdown_decide(st, None, 0.0)
    check(not st.get("_down"), "None readbacks never stand down (degrade closed)")


def test_decider_miss_streak_resets():
    print("decider: a single clean paint resets the miss streak")
    st = {}
    for _ in range(cs._SEQ_STANDDOWN_MISS - 1):
        cs._seq_standdown_decide(st, False, 0.0)
    cs._seq_standdown_decide(st, True, 0.0)      # clean -> reset
    for _ in range(cs._SEQ_STANDDOWN_MISS - 1):
        cs._seq_standdown_decide(st, False, 0.0)
    check(not st.get("_down"), "reset streak means still up after a near miss")


def test_decider_resume_needs_streak():
    print("decider: resume needs a full clean-probe streak (a miss resets it)")
    st = {"_down": True, "_hit": 0}
    for _ in range(cs._SEQ_STANDDOWN_HITS - 1):
        cs._seq_standdown_decide(st, True, 0.0)
    check(st.get("_down"), "still down before the streak completes")
    cs._seq_standdown_decide(st, False, 0.0)     # one dirty probe wipes progress
    for _ in range(cs._SEQ_STANDDOWN_HITS - 1):
        cs._seq_standdown_decide(st, True, 0.0)
    check(st.get("_down"), "a dirty probe reset the resume streak")
    cs._seq_standdown_decide(st, True, 0.0)
    check(not st.get("_down"), "resumes after a full clean streak")


# --------------------------------------------------------------------------- #
# Integration through _seq_render against a fake contended sysfs
# --------------------------------------------------------------------------- #
def test_render_control_keeps_painting():
    print("render CONTROL: when our paint sticks, it keeps painting, never down")
    steam = {"on": False}
    writes, restore = _install(steam)
    try:
        sp = _make_spec()
        for k in range(20):
            cs._seq_render(sp, k * 0.05)
        painted = [w for w in writes if w[1] == "multi_intensity"]
        check(not sp.get("_down"), "never stands down while paint sticks")
        check(len(painted) >= 20 * _N - _N,
              "keeps painting every node every frame (%d writes)" % len(painted))
    finally:
        restore()


def test_render_stands_down_and_stops_writing():
    print("render FIRES: Steam clobbering -> stand down -> stop writing the strip")
    steam = {"on": True}
    writes, restore = _install(steam)
    try:
        sp = _make_spec()
        # Detection is cross-frame (survival), so frame 0 has no prior canary and
        # counts no miss -> tripping takes MISS + 1 frames.
        for k in range(cs._SEQ_STANDDOWN_MISS + 1):
            cs._seq_render(sp, k * 0.01)
        check(sp.get("_down") is True, "stood down under sustained clobbering")
        probe_at = sp["_probe_at"]

        # Between probes it must write NOTHING (leave Steam's bar alone).
        del writes[:]
        cs._seq_render(sp, probe_at - 0.01)
        check(len(writes) == 0, "no writes between probes while stood down")

        # A probe touches ONLY the single canary node, not the whole strip.
        del writes[:]
        cs._seq_render(sp, probe_at + 0.01)
        touched = {w[0] for w in writes}
        check(len(touched) == 1, "a probe touches exactly one node, not all %d" % _N)
        check(sp.get("_down") is True, "still down (probe was clobbered too)")
    finally:
        restore()


def test_render_resumes_when_freed():
    print("render RESUME: strip freed -> clean probes -> full painting returns")
    steam = {"on": True}
    writes, restore = _install(steam)
    try:
        sp = _make_spec()
        for k in range(cs._SEQ_STANDDOWN_MISS + 1):
            cs._seq_render(sp, k * 0.01)
        check(sp.get("_down"), "stood down first")

        # Steam lets go; each probe (>= probe_at) now sticks. Walk enough probes.
        steam["on"] = False
        now = sp["_probe_at"]
        for _ in range(cs._SEQ_STANDDOWN_HITS + 1):
            cs._seq_render(sp, now + 0.01)
            now = sp.get("_probe_at", now) if sp.get("_down") else now
        check(not sp.get("_down"), "resumed after a clean-probe streak")

        # And a normal frame now paints the whole strip again.
        del writes[:]
        cs._seq_render(sp, now + 0.5)
        touched = {w[0] for w in writes if w[1] == "multi_intensity"}
        check(len(touched) == _N, "full painting resumed (all %d nodes)" % _N)
    finally:
        restore()


def test_render_only_touches_fixed_attrs():
    print("safety: stand-down never writes anything but the fixed-literal attrs")
    allowed = {"multi_intensity", "brightness"}
    for on in (False, True):
        steam = {"on": on}
        writes, restore = _install(steam)
        try:
            sp = _make_spec()
            now = 0.0
            for _ in range(cs._SEQ_STANDDOWN_MISS + 3):
                cs._seq_render(sp, now)
                now = (sp.get("_probe_at", now) + 0.01) if sp.get("_down") else now + 0.05
            bad = sorted({w[1] for w in writes} - allowed)
            check(not bad, "steam=%s: only %s written (saw extra: %s)"
                  % (on, sorted(allowed), bad))
        finally:
            restore()


if __name__ == "__main__":
    for fn in (test_decider_fires_and_controls, test_decider_none_ignored,
               test_decider_miss_streak_resets, test_decider_resume_needs_streak,
               test_render_control_keeps_painting,
               test_render_stands_down_and_stops_writing,
               test_render_resumes_when_freed,
               test_render_only_touches_fixed_attrs):
        fn()
    if _fail:
        print("\n\033[31m%d check(s) failed\033[0m" % len(_fail))
        raise SystemExit(1)
    print("\nall led stand-down tests passed")
