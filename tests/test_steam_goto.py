#!/usr/bin/env python3
"""Tests for steam_goto() — the allowlisted Steam UI destination.

Run: python3 tests/test_steam_goto.py

WHY THIS EXISTS: the app's search button walks a FIXED key path (up, up, left
x10) to reach Steam's global search. MEASURED on a Legion Go S: that path only
works from a known starting screen — fired from the wrong one it opens the
sidebar menu instead. So the button first anchors the UI here.

`steam://` can install games and run programs. That is exactly why the id is
looked up in a frozen dict and the URL is chosen HERE, never supplied by the
caller. The refusal tests below are the point of this file; if anything gets
trimmed, keep those.
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


class SpyPopen:
    """Capture the argv instead of launching Steam."""

    def __init__(self):
        self.calls = []
        self._real = cs.subprocess.Popen

    def __enter__(self):
        outer = self

        def fake(argv, **kw):
            outer.calls.append(argv)

            class P:
                pid = 1234
            return P()
        cs.subprocess.Popen = fake
        return self

    def __exit__(self, *a):
        cs.subprocess.Popen = self._real


def test_known_place_dispatches_a_literal_url():
    """The URL comes from the table, not from the caller."""
    print("test_known_place_dispatches_a_literal_url")
    with SpyPopen() as spy:
        check("returns True", cs.steam_goto("home"), True)
        check("one launch", len(spy.calls), 1)
        check("argv is a LIST (never a shell string)",
              isinstance(spy.calls[0], list), True)
        check("argv", spy.calls[0], ["steam", "steam://open/games"])


def test_unknown_id_is_refused_and_launches_NOTHING():
    """THE test. A non-allowlisted id must not reach steam://."""
    print("test_unknown_id_is_refused_and_launches_NOTHING")
    for bad in ("install", "rungameid/570", "../home", "", "HOME",
                "home; rm -rf /", None, 5, ["home"]):
        with SpyPopen() as spy:
            check("id %r refused" % (bad,), cs.steam_goto(bad), False)
            check("id %r launched nothing" % (bad,), len(spy.calls), 0)


def test_no_client_string_can_reach_the_url():
    """Every table value is a literal steam:// URL with no format slot, so no
    caller input can be interpolated into one."""
    print("test_no_client_string_can_reach_the_url")
    for pid, url in cs.STEAM_PLACES.items():
        check("%r has no format slot" % pid, "%" in url, False)
        check("%r is a steam:// url" % pid, url.startswith("steam://"), True)
        check("%r has no shell metacharacters" % pid,
              any(ch in url for ch in ";|&$`<>"), False)


def test_table_is_not_a_pattern():
    """No globs / prefixes (CLAUDE.md 3.3) — ids are exact keys."""
    print("test_table_is_not_a_pattern")
    for pid in cs.STEAM_PLACES:
        check("%r has no wildcard" % pid,
              any(ch in pid for ch in "*?["), False)


if __name__ == "__main__":
    for fn in (test_known_place_dispatches_a_literal_url,
               test_unknown_id_is_refused_and_launches_NOTHING,
               test_no_client_string_can_reach_the_url,
               test_table_is_not_a_pattern):
        fn()
    if FAILURES:
        print("\n%d FAILED: %s" % (len(FAILURES), ", ".join(FAILURES)))
        sys.exit(1)
    print("\nall good")
