#!/usr/bin/env python3
"""Two places the agent used to report success it had not verified.

Run: python3 tests/test_verified_success.py

(1) couchmode_start() returned ok purely because the switch SUBPROCESS exited 0.
    steamos-session-select returns as soon as the switch is TRIGGERED, so a
    compositor that never comes up -- the proprietary NVIDIA driver, a bad
    output -- produced a green result on a black TV. Both live callers were
    affected: couchmode_enter (HTTP) and couchmode_try_enter (the guide-hold
    controller trigger). The staged ceremony already solved this for its own
    path; couchmode_start is a SECOND path that did not.

(2) real_screen_frame() served whatever the compositor handed back. _png_complete
    only proves the file has an IEND chunk, and an all-black readback is a
    perfectly well-formed PNG -- so the app rendered a black preview that looks
    exactly like a working one.

The inconclusive case in (2) matters as much as the positive one: when no image
tool exists to measure with, the frame MUST still be served. A measurement gap
that silently suppressed every frame would be a worse bug than the one being
fixed.

Pure stdlib, no pytest.
"""
import importlib.util
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location(
    "couchsided", os.path.join(ROOT, "agent", "couchsided.py"))
cs = importlib.util.module_from_spec(_spec)
sys.modules["couchsided"] = cs
_spec.loader.exec_module(cs)

PASS = "  \033[32mPASS\033[0m"
FAIL = "  \033[31mFAIL\033[0m"
_fail = []


def check(cond, label):
    print((PASS if cond else FAIL) + "  " + label)
    if not cond:
        _fail.append(label)


# ---- (1) couch mode: the switch exiting 0 is not Game Mode being up ---------

def _run_couchmode(switch_ok, gamescope_up):
    """Drive the REAL couchmode_start with only its environment stubbed."""
    cs._session_to_game = lambda: {"ok": switch_ok, "exit_code": 0 if switch_ok else 1,
                                   "stdout": "", "stderr": ""}
    cs._couchmode_session = lambda: ("gamescope" if gamescope_up else "desktop")
    cs._couch_verify_gamescope = lambda: gamescope_up
    cs.tv_send = lambda *a, **k: None
    cs._couch_run = lambda *a, **k: {"ok": True, "exit_code": 0, "stdout": "", "stderr": ""}
    cs._hdmi_sink = lambda: None
    cs._set_preferred_output = lambda o: {"skipped": True, "reason": "test"}
    return cs.couchmode_start("", False)


def test_switch_ok_but_gamescope_never_appears():
    print("the bug: switch exits 0, Game Mode never comes up")
    j = _run_couchmode(switch_ok=True, gamescope_up=False)
    check(j["ok"] is False, "NOT reported ok (this used to be a fake green)")
    check(j["session"] == "desktop", "reports the session actually observed")
    step = j["steps"].get("gamescope_up") or {}
    check(step.get("ok") is False, "the readback step is recorded as failed")
    check("did not appear" in (step.get("stderr") or ""),
          "and it explains itself rather than failing bare")


def test_switch_ok_and_gamescope_up():
    """CONTROL. Without this, always returning ok=False would pass the test
    above -- and would break Couch Mode for every user."""
    print("control: a switch that really works still succeeds")
    j = _run_couchmode(switch_ok=True, gamescope_up=True)
    check(j["ok"] is True, "reported ok")
    check(j["session"] == "gamescope", "session is gamescope")
    check((j["steps"].get("gamescope_up") or {}).get("ok") is True,
          "readback step passed")


def test_switch_tool_itself_failed():
    print("the switch command fails outright")
    j = _run_couchmode(switch_ok=False, gamescope_up=False)
    check(j["ok"] is False, "not ok")
    check("gamescope_up" not in j["steps"],
          "no readback step -- nothing to verify when the switch never ran")


# ---- (2) screen preview: an all-black PNG is a well-formed PNG --------------

def test_uniform_frame_rejected():
    print("a ~uniform (black) capture is rejected, not served")
    cs._frame_variance = lambda src, env: 0.0
    check(cs._reject_uniform_frame("/tmp/x.png", {}) is True, "black frame rejected")
    cs._frame_variance = lambda src, env: cs.SCREEN_MIN_STDDEV - 0.01
    check(cs._reject_uniform_frame("/tmp/x.png", {}) is True, "just under threshold rejected")


def test_real_frame_served():
    """CONTROL. A rejector that rejected everything would pass the test above and
    kill the preview entirely."""
    print("control: a real frame is served")
    cs._frame_variance = lambda src, env: 42.0
    check(cs._reject_uniform_frame("/tmp/x.png", {}) is False, "busy frame served")
    cs._frame_variance = lambda src, env: cs.SCREEN_MIN_STDDEV
    check(cs._reject_uniform_frame("/tmp/x.png", {}) is False,
          "exactly at threshold is served (reject is strictly below)")


def test_unmeasurable_frame_is_served():
    """The most important one. No image tool -> no measurement -> the frame MUST
    still be served. Treating "couldn't measure" as "black" would blank the
    preview on every box without magick/convert/ffmpeg."""
    print("a frame that CANNOT be measured is served, never rejected")
    cs._frame_variance = lambda src, env: None
    check(cs._reject_uniform_frame("/tmp/x.png", {}) is False,
          "inconclusive != black")


def test_stddev_math():
    print("the std-dev helper itself")
    check(cs._grayscale_stddev(b"") is None, "empty buffer -> None, not 0.0")
    check(cs._grayscale_stddev(bytes([7] * 64)) == 0.0, "uniform buffer -> 0.0")
    sd = cs._grayscale_stddev(bytes([0, 255] * 32))
    check(sd is not None and abs(sd - 127.5) < 0.01, "half black/half white -> 127.5")


if __name__ == "__main__":
    test_switch_ok_but_gamescope_never_appears()
    test_switch_ok_and_gamescope_up()
    test_switch_tool_itself_failed()
    test_uniform_frame_rejected()
    test_real_frame_served()
    test_unmeasurable_frame_is_served()
    test_stddev_math()
    print()
    if _fail:
        print("FAILED: %d" % len(_fail))
        for f in _fail:
            print("  - " + f)
        raise SystemExit(1)
    print("all verified-success tests passed")
