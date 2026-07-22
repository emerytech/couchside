#!/usr/bin/env python3
"""Tests for on-screen-keyboard detection (the {"t":"osk"} push).

Run: python3 tests/test_osk_watch.py

When Steam raises its keyboard on the TV, the phone should raise its own, so you
can type or paste instead of thumb-picking letters off a grid with a d-pad.

There is no general "a text field took focus" signal on this platform — Wayland
exposes none and gamescope has no client API for it. But Steam writes the
narrower event to its own UI log, and reading a Steam log for a signal is
already how stream_host_online() works.

MEASURED on a live Bazzite box in Game Mode, 2026-07-21, and every number below
is from that session rather than from documentation:

  - Opening the keyboard emits EXACTLY TWO identical lines each time, across ten
    observed events. Hence the dedupe window.
  - NEGATIVE CONTROL: navigating the library, opening a game page and changing
    tabs produced "Trying to change focus to already selected tab", "updating
    PluginView after changes" and store page loads -- and ZERO keyboard markers.
    The signal is specific to the keyboard, not to focus in general. That test
    is what made this feature worth building, so it is asserted below.
  - Twenty idle minutes produced zero markers.
  - Sub-second write latency; Steam does not buffer this log.

The marker is UNDOCUMENTED and Valve can rename it in any update, so every path
degrades closed: no log, no marker, or a renamed marker means the feature
silently never fires.
"""
import importlib.util
import os
import shutil
import sys
import tempfile
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


# VERBATIM lines off the live box. The keyboard markers are the two that fired
# when the keyboard opened; everything else is what NAVIGATION produced in the
# same window and must not trigger anything.
OPEN_EVENT = [
    "[2026-07-21 23:31:16] SteamUI: INFO: giving focus to keyboard 2",
    "[2026-07-21 23:31:16] SteamUI: INFO: giving focus to keyboard 2",
]
NAVIGATION_NOISE = [
    "[2026-07-21 23:38:46] SteamUI: INFO: RegisterOnActionDescriptionsChangedCallback",
    "[2026-07-21 23:38:50] SteamUI: INFO: Trying to change focus to already selected tab",
    "[2026-07-21 23:38:52] SteamUI: INFO: updating PluginView after changes",
    "[2026-07-21 23:38:54] SteamUI: INFO: Chat: f1912293206 friend trying to load 100 messages",
    "[2026-07-21 23:31:16] SteamUI: INFO: ~~ Search result sets:  ~~",
    "[2026-07-21 23:10:35] SteamUI: WARNING: MultiSourceImage created with no image src",
]


class Harness:
    """Drive the REAL _osk_watch against a temp log, counting notifies."""

    def __init__(self):
        self.dir = tempfile.mkdtemp(prefix="osk-")
        self.path = os.path.join(self.dir, "webhelper_js.txt")
        with open(self.path, "w") as f:
            f.write("[start] pre-existing content the watcher must NOT replay\n")
        self.fired = 0
        self._old_log = cs._OSK_LOG
        self._old_poll = cs._OSK_POLL_S
        self._old_notify = cs._osk_notify
        cs._OSK_LOG = self.path
        cs._OSK_POLL_S = 0.02          # keep the suite fast
        cs._osk_notify = self._count

    def _count(self):
        self.fired += 1

    def append(self, lines):
        with open(self.path, "a") as f:
            f.write("\n".join(lines) + "\n")

    def settle(self, s=0.25):
        time.sleep(s)

    def close(self):
        cs._OSK_LOG = self._old_log
        cs._OSK_POLL_S = self._old_poll
        cs._osk_notify = self._old_notify
        with cs._OSK_LOCK:
            cs._OSK_GEN += 1           # retire the watcher thread
        time.sleep(0.1)
        shutil.rmtree(self.dir, ignore_errors=True)


def start(h):
    cs.osk_arm(mock=False)
    time.sleep(0.1)


def test_keyboard_open_fires_once():
    """Two identical lines are ONE keyboard, not two."""
    print("test_keyboard_open_fires_once")
    h = Harness()
    try:
        start(h)
        h.append(OPEN_EVENT)
        h.settle()
        check("one open -> one notify (deduped)", h.fired, 1)
    finally:
        h.close()


def test_navigation_fires_nothing():
    """THE control. Moving around Steam must never pop the phone keyboard."""
    print("test_navigation_fires_nothing")
    h = Harness()
    try:
        start(h)
        h.append(NAVIGATION_NOISE)
        h.settle()
        check("navigation noise -> no notify", h.fired, 0)
    finally:
        h.close()


def test_two_opens_fire_twice():
    """Deduping must not swallow a genuine second open."""
    print("test_two_opens_fire_twice")
    h = Harness()
    try:
        start(h)
        h.append(OPEN_EVENT)
        h.settle()
        time.sleep(cs._OSK_DEDUPE_S)
        h.append(OPEN_EVENT)
        h.settle()
        check("two separate opens -> two notifies", h.fired, 2)
    finally:
        h.close()


def test_existing_content_not_replayed():
    """An agent restart must not fire for a keyboard opened an hour ago."""
    print("test_existing_content_not_replayed")
    h = Harness()
    try:
        with open(h.path, "a") as f:
            f.write("\n".join(OPEN_EVENT) + "\n")   # BEFORE the watcher starts
        start(h)
        h.settle()
        check("pre-existing markers ignored", h.fired, 0)
    finally:
        h.close()


def test_truncation_does_not_wedge():
    """Steam rotating its log must not blind the watcher forever."""
    print("test_truncation_does_not_wedge")
    h = Harness()
    try:
        start(h)
        h.append(["filler"] * 50)
        h.settle()
        with open(h.path, "w") as f:      # rotate: file shrinks
            f.write("")
        h.settle()
        h.append(OPEN_EVENT)
        h.settle()
        check("still fires after truncation", h.fired, 1)
    finally:
        h.close()


def test_missing_log_degrades_closed():
    """No Steam (a server box, Windows, a fresh install) must not raise."""
    print("test_missing_log_degrades_closed")
    old = cs._OSK_LOG
    cs._OSK_LOG = "/nonexistent/steam/logs/webhelper_js.txt"
    try:
        check("osk_available() is False", cs.osk_available(), False)
        cs.osk_arm(mock=False)       # must be a silent no-op, not a crash
        check("arming without a log does not raise", True, True)
    finally:
        cs._OSK_LOG = old


def test_mock_never_arms():
    """--mock must not tail a real user's Steam log."""
    print("test_mock_never_arms")
    h = Harness()
    try:
        cs.osk_arm(mock=True)
        h.append(OPEN_EVENT)
        h.settle()
        check("mock mode fires nothing", h.fired, 0)
    finally:
        h.close()


if __name__ == "__main__":
    for fn in (test_keyboard_open_fires_once,
               test_navigation_fires_nothing,
               test_two_opens_fire_twice,
               test_existing_content_not_replayed,
               test_truncation_does_not_wedge,
               test_missing_log_degrades_closed,
               test_mock_never_arms):
        fn()
    if FAILURES:
        print("\n%d FAILED: %s" % (len(FAILURES), ", ".join(FAILURES)))
        sys.exit(1)
    print("\nall good")
