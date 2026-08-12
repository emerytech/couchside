#!/usr/bin/env python3
"""Tests for the audio output switcher (GET /api/audio, POST /api/audio/default).

Run: python3 tests/test_audio_switch.py

The property that matters is the allowlist one: the sink a client names is
LOOKED UP in the set pactl itself just reported and refused otherwise, and it
only ever reaches subprocess as a single argv element of a fixed command. A hole
here would let a LAN client point `pactl set-default-sink` at an arbitrary
string, so the regression below proves an unknown / empty / injection-shaped name
runs NOTHING.

Pure stdlib, no pytest — same style as the other agent tests.
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
    p = cs.audio_state(True)
    check(p.get("available") is True, "available: true in mock")
    sinks = p.get("sinks")
    check(isinstance(sinks, list) and sinks, "returns a non-empty sinks list")
    check(all(set(s) == {"name", "desc", "hdmi", "available", "default"} for s in sinks),
          "every sink is exactly {name,desc,hdmi,available,default}")
    defaults = [s for s in sinks if s["default"]]
    check(len(defaults) == 1, "exactly one sink is marked default")
    check(p["default"] == defaults[0]["name"],
          "top-level default matches the flagged sink")


def test_available_gate():
    print("caps gate")
    orig = cs.shutil.which
    try:
        cs.shutil.which = lambda _b: None
        check(cs.audioswitch_available() is False, "no pactl -> unavailable")
        cs.shutil.which = lambda _b: "/usr/bin/pactl"
        check(cs.audioswitch_available() is True, "pactl present -> available")
    finally:
        cs.shutil.which = orig


# A live sink set the box "reported", for the allowlist test. Only these names
# are legal targets; anything else must be refused.
_LIVE = [
    {"name": "alsa_output.hdmi-stereo", "desc": "TV", "hdmi": True, "available": True},
    {"name": "bluez_output.AA_BB.1", "desc": "Speaker", "hdmi": False, "available": True},
]


def test_allowlist_is_enforced():
    print("allowlist (the regression that matters)")
    calls = []
    orig_sinks = cs._pactl_sinks
    orig_run = cs._couch_run
    cs._pactl_sinks = lambda: list(_LIVE)
    cs._couch_run = lambda cmd, **k: calls.append(cmd) or {
        "ok": True, "exit_code": 0, "stdout": "", "stderr": ""}
    try:
        for bad in ("not-a-real-sink", "", "../../etc/passwd",
                    "hdmi-stereo; rm -rf /", None, 123):
            check(cs.set_audio_default(bad) is None,
                  "refused: %r" % (bad,))
        check(not calls, "nothing was run for any refused sink")

        res = cs.set_audio_default("bluez_output.AA_BB.1")
        check(isinstance(res, dict) and res.get("ok") is True, "known sink accepted")
        check(calls and calls[0] == ["pactl", "set-default-sink", "bluez_output.AA_BB.1"],
              "first call is a set-default-sink argv LIST built from the allowlisted name")
        check(all(isinstance(c, list) for c in calls),
              "every subprocess call is an argv list (no shell string)")
    finally:
        cs._pactl_sinks = orig_sinks
        cs._couch_run = orig_run


def test_mock_switch_is_observable():
    print("mock switch moves the default (observe both states)")
    orig = cs._MOCK_DEFAULT_SINK
    try:
        cs.set_mock_default_sink(None)
        first = cs.audio_state(True)["default"]
        target = next(s["name"] for s in cs.MOCK_SINKS if s["name"] != first)
        cs.set_mock_default_sink(target)
        moved = cs.audio_state(True)
        check(moved["default"] == target, "GET reflects the switched-to sink")
        check(sum(1 for s in moved["sinks"] if s["default"]) == 1,
              "still exactly one default after the switch")
    finally:
        cs.set_mock_default_sink(orig)


def test_caps_key_registered():
    print("caps key (six-edit-site rule, agent half)")
    src = open(AGENT).read()
    check('"audioswitch")' in src or '"audioswitch",' in src,
          "audioswitch present in the mock all-true caps tuple")
    check('"audioswitch": safe(audioswitch_available)' in src,
          "audioswitch wired into the real CAPS dict")


if __name__ == "__main__":
    test_state_payload_mock()
    test_available_gate()
    test_allowlist_is_enforced()
    test_mock_switch_is_observable()
    test_caps_key_registered()
    print()
    if _fail:
        print("FAILED: %d" % len(_fail))
        for f in _fail:
            print("  - " + f)
        raise SystemExit(1)
    print("all audio-switch tests passed")
