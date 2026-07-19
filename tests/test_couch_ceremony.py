#!/usr/bin/env python3
"""Tests for the Couch Mode ceremony job engine.

Run: python3 tests/test_couch_ceremony.py

The ceremony turns the fire-and-forget desktop->TV switch into a staged job the
phone polls, and its whole reason for existing is to stop TWO lies the old path
told:
  (a) "Ready" was just "a subprocess exited 0" — nothing verified Game Mode
      actually came up. A wrong green node is worse than no ceremony.
  (b) audio silently "skipped" when the just-woken TV's HDMI sink hadn't
      enumerated yet, leaving you in Game Mode with sound on the wrong device.

These tests drive the REAL worker (_couch_ceremony_worker via couch_ceremony_start)
with only the environment I/O primitives stubbed, so the stage sequencing,
verify loop, audio retry, fatal-vs-nonfatal, and reason strings are all exercised
for real. Pure stdlib, no pytest — same style as the other agent tests.
"""
import importlib.util
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location(
    "couchsided", os.path.join(ROOT, "agent", "couchsided.py"))
cs = importlib.util.module_from_spec(_spec)
sys.modules["couchsided"] = cs
_spec.loader.exec_module(cs)

FAILURES = []


def check(name, got, want):
    if got == want:
        print("  PASS  %s" % name)
    else:
        print("  FAIL  %s (got %r, want %r)" % (name, got, want))
        FAILURES.append(name)


def _run(*, tv_backend, external, switch_ok, gamescope_up, sink, output="DP-1"):
    """Stub the environment primitives, run the real ceremony, return the
    terminal job snapshot."""
    cs.tv_send = lambda op, hdr: ({"ok": True} if tv_backend else None)
    cs._connected_outputs = lambda: (
        [{"name": "DP-1", "internal": False}] if external
        else [{"name": "eDP-1", "internal": True}])
    cs._output_forcing_supported = lambda: True
    cs._session_to_game = lambda: (
        {"ok": True, "stderr": ""} if switch_ok
        else {"ok": False, "stderr": "select failed"})
    cs._couchmode_session = lambda: ("gamescope" if gamescope_up else "desktop")
    cs._tv_audio_sink = lambda: sink
    cs._couch_run = lambda cmd: {"ok": True, "exit_code": 0, "stdout": "",
                                 "stderr": ""}
    # keep the test fast: 1s verify budget, 2 audio retries
    cs.SESSION_VERIFY_TIMEOUT_S = 1.0
    cs.SESSION_VERIFY_INTERVAL_S = 0.1
    cs.AUDIO_SINK_RETRIES = 2
    cs.AUDIO_SINK_DELAY_S = 0.05
    cs.couch_ceremony_start(output)
    for _ in range(100):
        j = cs.couchmode_job_info()
        if j["state"] in ("done", "failed"):
            break
        time.sleep(0.05)
    return cs.couchmode_job_info()


def _stage(job, key):
    return next(s for s in job["stages"] if s["key"] == key)


def test_happy():
    print("happy path (Bazzite + TV)")
    j = _run(tv_backend=True, external=True, switch_ok=True,
             gamescope_up=True, sink="hdmi")
    check("state done", j["state"], "done")
    check("session verified gamescope", j["session"], "gamescope")
    check("legacy ok true", j["ok"], True)
    for k in ("tv_power_on", "tv_input", "output", "session", "audio"):
        check("%s ok" % k, _stage(j, k)["state"], "ok")


def test_no_tv_backend():
    print("no TV control backend")
    j = _run(tv_backend=False, external=True, switch_ok=True,
             gamescope_up=True, sink="hdmi")
    check("ceremony still completes", j["state"], "done")
    check("tv_power skipped honestly", _stage(j, "tv_power_on")["state"], "skipped")
    check("tv_power has a reason", bool(_stage(j, "tv_power_on").get("reason")), True)
    check("audio still routes", _stage(j, "audio")["state"], "ok")


def test_audio_sink_missing_bug_b():
    print("bug (b): TV woke but its HDMI sink never enumerated")
    j = _run(tv_backend=True, external=True, switch_ok=True,
             gamescope_up=True, sink=None)
    # The whole point: this used to silently report "skipped" and look fine.
    check("audio FAILED, not skipped", _stage(j, "audio")["state"], "failed")
    check("audio failure names the cause",
          "sink" in (_stage(j, "audio").get("reason") or "").lower(), True)
    # Audio is non-fatal: Game Mode is up, so the ceremony still succeeds.
    check("ceremony still done (audio non-fatal)", j["state"], "done")


def test_gamescope_never_up_bug_a():
    print("bug (a): switch exits 0 but Game Mode never appears")
    j = _run(tv_backend=True, external=True, switch_ok=True,
             gamescope_up=False, sink="hdmi")
    # The whole point: this used to falsely report ok/gamescope.
    check("session FAILED (not a fake green)", _stage(j, "session")["state"], "failed")
    check("session failure explains the timeout",
          "did not" in (_stage(j, "session").get("reason") or "").lower(), True)
    check("ceremony FAILED (session is fatal)", j["state"], "failed")
    check("reported session is the real one, not a lie", j["session"], "desktop")


def test_switch_tool_failed():
    print("switch tool itself fails")
    j = _run(tv_backend=True, external=True, switch_ok=False,
             gamescope_up=False, sink="hdmi")
    check("session failed", _stage(j, "session")["state"], "failed")
    check("ceremony failed", j["state"], "failed")


def test_internal_only():
    print("internal-only handheld (no external display, output='')")
    j = _run(tv_backend=False, external=False, switch_ok=True,
             gamescope_up=True, sink=None, output="")
    check("output skipped with reason",
          _stage(j, "output")["state"], "skipped")
    check("audio skipped (built-in is correct)",
          _stage(j, "audio")["state"], "skipped")
    check("ceremony done", j["state"], "done")


def test_start_is_immediate_and_joins():
    print("start returns immediately; a second start joins")
    # slow the switch so the first job is still running when we call again
    cs.tv_send = lambda op, hdr: (time.sleep(0.4) or {"ok": True})
    cs._connected_outputs = lambda: [{"name": "DP-1", "internal": False}]
    cs._output_forcing_supported = lambda: True
    cs._session_to_game = lambda: {"ok": True, "stderr": ""}
    cs._couchmode_session = lambda: "gamescope"
    cs._tv_audio_sink = lambda: "hdmi"
    cs._couch_run = lambda cmd: {"ok": True, "exit_code": 0, "stdout": "", "stderr": ""}
    cs.SESSION_VERIFY_TIMEOUT_S = 1.0
    first = cs.couch_ceremony_start("DP-1")
    check("start returns running immediately", first["state"], "running")
    check("all stages pending at start",
          all(s["state"] == "pending" for s in first["stages"]), True)
    second = cs.couch_ceremony_start("DP-1")
    check("second start joins the same job id", second["id"], first["id"])
    for _ in range(100):
        if cs.couchmode_job_info()["state"] in ("done", "failed"):
            break
        time.sleep(0.05)
    check("job completed once", cs.couchmode_job_info()["state"], "done")


if __name__ == "__main__":
    for fn in (test_happy, test_no_tv_backend, test_audio_sink_missing_bug_b,
               test_gamescope_never_up_bug_a, test_switch_tool_failed,
               test_internal_only, test_start_is_immediate_and_joins):
        fn()
    print()
    if FAILURES:
        print("FAILED: %s" % ", ".join(FAILURES))
        sys.exit(1)
    print("all couch-ceremony tests passed")
