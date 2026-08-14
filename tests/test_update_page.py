#!/usr/bin/env python3
"""Tests for the on-box update progress page (render_update_page).

Run: python3 tests/test_update_page.py

WHY THIS EXISTS. The page is served ONCE and then keeps polling /api/ping across
the agent's own restart, watching for the version to change.

Two real bugs shaped it:

  1. Legion Go S (system-service install, 2026-07-23): the detached installer
     copied the new agent file but died at a password `sudo` before restarting,
     so the OLD agent kept answering the SAME version. The page span its loader
     forever, telling the user it was "still working" when it had stalled.

  2. SteamOS Steam Machine (2026-08-13): the OPPOSITE false report. The update
     SUCCEEDED (2.9.83 -> 2.9.86) but the page said "Update didn't finish". The
     fix for (1) had made the reachable-but-unchanged branch declare a HARD
     FAILURE after ~3 min and then STOP polling -- so a box whose new agent was
     merely slow to restart (a ~6s CEC probe + log watchers) tripped it, and the
     page never saw the new version come up moments later.

So the detector has to observe BOTH states without ever lying: success stops the
poll; a long unchanged wait shows a SOFT, non-terminal hint and KEEPS polling, so
a late success still flips the page to "Updated". This test pins that.

The decision lives in a pure `updDecide(was, ver, same, miss)` function inside the
page's JS, fenced by // --UPD-DECIDE-START / --UPD-DECIDE-END. When `node` is on
PATH (it is on the CI runner) we extract and EXECUTE it against a table that
exercises both states -- an actual behavioural test, not just a grep. Structural
assertions back it up and run everywhere. (Pure stdlib, no pytest.)
"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location(
    "couchsided", os.path.join(ROOT, "agent", "couchsided.py"))
cs = importlib.util.module_from_spec(_spec)
sys.modules["couchsided"] = cs
_spec.loader.exec_module(cs)

FAILURES = []

START = "// --UPD-DECIDE-START"
END = "// --UPD-DECIDE-END"


def check(name, got, want):
    if got == want:
        print("  PASS  %s" % name)
    else:
        print("  FAIL  %s (got %r, want %r)" % (name, got, want))
        FAILURES.append(name)


def _decide_block(html):
    """The self-contained thresholds + updDecide() source, ready for node."""
    i = html.index(START)
    j = html.index(END)
    return html[i:j]


def _run_decide(block, was, ver, same, miss):
    """Execute updDecide() under node and return its object. `ver=None` -> JS
    null (unreachable). Raises if node disagrees, so the caller can assert."""
    def js(v):
        return "null" if v is None else json.dumps(v)
    harness = (block + "\nprocess.stdout.write(JSON.stringify(updDecide(%s,%s,%d,%d)));"
               % (js(was), js(ver), same, miss))
    p = subprocess.run(["node", "-"], input=harness,
                       capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError("node failed: %s" % p.stderr.strip())
    return json.loads(p.stdout)


def test_self_contained_and_polls_preauth_ping():
    print("test_self_contained_and_polls_preauth_ping")
    html = cs.render_update_page()
    # No external assets: the box may have no network route mid-update, so a
    # spinner that 404s is worse than none.
    check("no external src/href", "src=\"http" not in html and "href=\"http" not in html, True)
    # It watches the ONE pre-auth endpoint (it cannot send the token across a
    # restart), cache-busted.
    check("polls /api/ping", "/api/ping" in html, True)
    check("cache-busted", "no-store" in html, True)


def test_success_is_the_only_terminal_state():
    """Version changed -> Updated, and it is the ONLY state that stops the poll.
    Structurally: exactly one `DONE=true`, and the reschedule is guarded by it."""
    print("test_success_is_the_only_terminal_state")
    html = cs.render_update_page()
    check("announces the new version", "Now running" in html, True)
    check("marks done on success only", html.count("DONE=true") == 1, True)
    # The poll reschedules on EVERY tick unless DONE -- so nothing but success
    # can end it (the 2026-08-13 regression was a failure branch that returned
    # out of the loop and stopped watching).
    check("reschedule guarded by DONE", "if(!DONE) setTimeout(tick,2000)" in html, True)
    # No hard-failure HEADLINE and no scary-orange flip -- the 2026-08-13
    # regression set the title to a failure string. (A comment may still mention
    # the history, so we target the UI assignment + the orange color, not the
    # words anywhere on the page.)
    check("no failure headline assignment", ".textContent='Update didn" not in html, True)
    check("no scary-orange title flip", "#f0b232" not in html, True)


def test_restart_is_never_a_failure():
    """Unreachable == restarting (expected); it escalates wording but never fails
    and never stops the poll."""
    print("test_restart_is_never_a_failure")
    html = cs.render_update_page()
    check("has a catch/miss branch", ".catch(" in html and "miss++" in html, True)
    check("says 'Restarting'", "Restarting the service" in html, True)
    # A restart resets the same-version clock so it is not mistaken for a stall.
    check("restart resets the same clock", "same=0; miss++" in html, True)


def test_stall_hint_is_soft_and_non_terminal():
    """Long unchanged wait -> a recovery hint, but NOT a failure and NOT the end
    of polling, so a late success still wins."""
    print("test_stall_hint_is_soft_and_non_terminal")
    html = cs.render_update_page()
    check("has a generous same threshold", "STUCK" in html and "same>=STUCK" in html, True)
    check("offers a recovery command", "install.sh | bash" in html, True)
    check("maybe_stuck is not a terminal/done state", "state:'maybe_stuck'" in html
          and "done:false, state:'maybe_stuck'" in html, True)
    # Generosity: the old 90-tick (~3 min) window is what misfired; the new one
    # must be materially larger. Parse it rather than trust a comment.
    try:
        val = int(html.split("var STUCK=", 1)[1].split(";", 1)[0].strip())
    except Exception:
        val = -1
    check("STUCK window >= 240 ticks (~8 min)", val >= 240, True)


def test_decide_observes_both_states():
    """The heart of it: run updDecide() for real and prove it fires BOTH ways --
    success on a version change, and NEVER a terminal failure otherwise, even
    after a very long unchanged wait. Skips only if node is unavailable."""
    print("test_decide_observes_both_states")
    if not shutil.which("node"):
        print("  SKIP  node not on PATH (behavioural check skipped)")
        return
    block = _decide_block(cs.render_update_page())

    # --- success half: the version changed. This is the case the 2026-08-13
    #     box hit AFTER a long wait, and it must resolve to done:true. ---
    d = _run_decide(block, "2.9.83", "2.9.86", 5, 0)
    check("version change -> updated/done", d.get("state") == "updated" and d.get("done") is True, True)
    check("updated reports new version", d.get("version") == "2.9.86", True)
    # Even after sitting on the old version for ages, the very next tick that sees
    # the new version succeeds -- the exact false-negative that shipped.
    d = _run_decide(block, "2.9.83", "2.9.86", 999, 0)
    check("late success still wins", d.get("state") == "updated" and d.get("done") is True, True)

    # --- not-yet half: still the old version / unreachable. NONE of these may be
    #     terminal (done:false), so the poll keeps looking for success. ---
    for name, ver, same, miss in [
        ("fresh install (same, early)", "2.9.83", 1, 0),
        ("slow (same, 40s)", "2.9.83", 20, 0),
        ("very long same wait", "2.9.83", 999, 0),
        ("restarting (unreachable)", None, 0, 10),
        ("long restart (unreachable)", None, 0, 200),
    ]:
        d = _run_decide(block, "2.9.83", ver, same, miss)
        check("%s is non-terminal" % name, d.get("done") is False, True)

    # State names are distinct so the UI can distinguish "still old" from "not
    # answering" (the fix direction: restarting != stuck).
    installing = _run_decide(block, "2.9.83", "2.9.83", 1, 0)["state"]
    slow = _run_decide(block, "2.9.83", "2.9.83", 20, 0)["state"]
    stuck = _run_decide(block, "2.9.83", "2.9.83", 999, 0)["state"]
    restarting = _run_decide(block, "2.9.83", None, 0, 10)["state"]
    longr = _run_decide(block, "2.9.83", None, 0, 200)["state"]
    check("reachable-same escalates installing->slow->maybe_stuck",
          (installing, slow, stuck) == ("installing", "slow", "maybe_stuck"), True)
    check("unreachable escalates restarting->long_restart",
          (restarting, longr) == ("restarting", "long_restart"), True)


if __name__ == "__main__":
    for fn in (test_self_contained_and_polls_preauth_ping,
               test_success_is_the_only_terminal_state,
               test_restart_is_never_a_failure,
               test_stall_hint_is_soft_and_non_terminal,
               test_decide_observes_both_states):
        fn()
    if FAILURES:
        print("\n%d FAILED: %s" % (len(FAILURES), ", ".join(FAILURES)))
        sys.exit(1)
    print("\nall good")
