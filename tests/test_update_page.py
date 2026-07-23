#!/usr/bin/env python3
"""Tests for the on-box update progress page (render_update_page).

Run: python3 tests/test_update_page.py

WHY THIS EXISTS. The page is served ONCE and then keeps polling /api/ping across
the agent's own restart, watching for the version to change. The original page
had only ONE outcome — success (version changed) — and otherwise spun forever.

A real box (Legion Go S, system-service install, 2026-07-23) hit the failure the
page could not express: the detached installer copied the new agent file but
died at a password `sudo` before restarting the service, so the OLD agent kept
answering the SAME version. The page span its loader indefinitely, telling the
user it was "still working" when it had stalled. This asserts the three-outcome
logic is present so a refactor cannot silently regress to the one-outcome page.

The page is a JS string (no JS engine here), so these are STRUCTURAL assertions —
the same approach test_pair_page uses for the handoff. They pin the branches, not
the pixels; the on-box render itself is proven live.
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

FAILURES = []


def check(name, got, want):
    if got == want:
        print("  PASS  %s" % name)
    else:
        print("  FAIL  %s (got %r, want %r)" % (name, got, want))
        FAILURES.append(name)


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


def test_success_outcome_present():
    """Version changes -> Updated. This is the happy path and must survive."""
    print("test_success_outcome_present")
    html = cs.render_update_page()
    check("compares against first-seen version", "j.version!==was" in html, True)
    check("announces the new version", "Now running" in html, True)


def test_restart_outcome_present():
    """Unreachable for a while == the service is restarting (expected), and a
    failed poll must NOT be treated as an error immediately."""
    print("test_restart_outcome_present")
    html = cs.render_update_page()
    check("has a catch/miss branch", ".catch(" in html and "misses" in html, True)
    check("says 'Restarting'", "Restarting the service" in html, True)


def test_stall_outcome_present():
    """THE fix: reachable + SAME version for a long time == stalled, not working.
    Must stop the spinner, say the box is still on the old version, and give a
    recovery path — never spin forever."""
    print("test_stall_outcome_present")
    html = cs.render_update_page()
    check("tracks consecutive same-version polls", "same++" in html, True)
    check("has a stall threshold", "STALL" in html and "same>=STALL" in html, True)
    check("stall message present", "Update didn" in html, True)
    check("offers a recovery command", "install.sh | bash" in html, True)
    # A restart resets the stall clock — a genuine restart (unreachable) must not
    # be mistaken for a stall.
    check("restart resets the stall clock", "same=0" in html, True)


if __name__ == "__main__":
    for fn in (test_self_contained_and_polls_preauth_ping,
               test_success_outcome_present,
               test_restart_outcome_present,
               test_stall_outcome_present):
        fn()
    if FAILURES:
        print("\n%d FAILED: %s" % (len(FAILURES), ", ".join(FAILURES)))
        sys.exit(1)
    print("\nall good")
