#!/usr/bin/env python3
"""Couch Mode's degraded tier: Steam Big Picture on a gamescope-less box.

Run: python3 tests/test_bigpicture.py

The behaviours worth pinning are the ones that would ship a lie:
  * the cap is EXCLUSIVE with couchmode — a Deck must never be offered the
    lesser tier, and the app must never have to choose between two trues;
  * a non-allowlisted op runs NOTHING (asserted on a spawn counter);
  * the two steam:// URLs are exactly the measured ones, in an argv LIST;
  * close on a box with no Steam running is SUCCESS, not an error — it is a
    no-op and an error would render a failure for "already where you asked".

Both URLs were verified on real hardware (nobara-xps, Nobara 43 KDE,
2026-08-01) with screen captures each way; these tests pin the plumbing that
carries them, not the URLs' behaviour, which no unit test can check.
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
SPAWNS = []
POPENS = []


def check(name, got, want):
    if got == want:
        print("  PASS  %s" % name)
    else:
        print("  FAIL  %s (got %r, want %r)" % (name, got, want))
        FAILURES.append(name)


class _R:
    returncode = 0
    stdout = b""
    stderr = b""


def fake_run(argv, **kw):
    SPAWNS.append(list(argv))
    return _R()


def fake_popen(argv, **kw):
    POPENS.append(list(argv))
    return object()


cs.subprocess.run = fake_run
cs.subprocess.Popen = fake_popen

print("the capability is EXCLUSIVE with couchmode")
saved = {"couch": cs.couchmode_available, "root": cs._steam_root,
         "which": cs.shutil.which}
try:
    # A real Game Mode box: full tier wins, degraded tier absent.
    cs.couchmode_available = lambda: True
    cs._steam_root = lambda: "/home/x/.steam/steam"
    cs.shutil.which = lambda t: "/usr/bin/" + t
    check("gamescope box does NOT offer big picture",
          cs.bigpicture_available(), False)

    # A desktop box with Steam: degraded tier appears.
    cs.couchmode_available = lambda: False
    check("desktop box WITH steam offers it", cs.bigpicture_available(), True)

    # No Steam installed: nothing to open.
    cs._steam_root = lambda: None
    check("no steam root -> absent", cs.bigpicture_available(), False)

    # Steam data but no binary (a leftover ~/.steam): still absent.
    cs._steam_root = lambda: "/home/x/.steam/steam"
    cs.shutil.which = lambda t: None
    check("steam data but no binary -> absent", cs.bigpicture_available(), False)
finally:
    cs.couchmode_available = saved["couch"]
    cs._steam_root = saved["root"]
    cs.shutil.which = saved["which"]

print()
print("open/close fire exactly the measured URLs, as an argv list")
saved_avail = cs.bigpicture_available
saved_running = cs._steam_client_running
try:
    cs.bigpicture_available = lambda: True

    # Steam already up -> deep link, no cold start.
    cs._steam_client_running = lambda: True
    SPAWNS.clear(); POPENS.clear()
    r = cs.bigpicture_open()
    check("open succeeds", r["ok"], True)
    check("...via the deep link", SPAWNS, [["steam", "steam://open/bigpicture"]])
    check("...and did NOT cold-start", POPENS, [])
    check("...and says how", r["stdout"], "deep link")

    SPAWNS.clear()
    r = cs.bigpicture_close()
    check("close fires the close URL",
          SPAWNS, [["steam", "steam://close/bigpicture"]])
    check("close succeeds", r["ok"], True)

    # Steam down -> cold start, no deep link.
    cs._steam_client_running = lambda: False
    SPAWNS.clear(); POPENS.clear()
    r = cs.bigpicture_open()
    check("cold start when steam is down", POPENS, [["steam", "-gamepadui"]])
    check("...and no deep link was sent", SPAWNS, [])
    check("...and says how", r["stdout"], "cold start")

    # Close with nothing running is a SUCCESSFUL no-op.
    SPAWNS.clear(); POPENS.clear()
    r = cs.bigpicture_close()
    check("close with steam down is ok, not an error", r["ok"], True)
    check("...and ran nothing", SPAWNS + POPENS, [])
finally:
    cs.bigpicture_available = saved_avail
    cs._steam_client_running = saved_running

print()
print("an unavailable box refuses both ops and runs NOTHING")
saved_avail = cs.bigpicture_available
try:
    cs.bigpicture_available = lambda: False
    for fn in (cs.bigpicture_open, cs.bigpicture_close):
        SPAWNS.clear(); POPENS.clear()
        r = fn()
        check("%s refuses" % fn.__name__, r["ok"], False)
        check("...and nothing ran", SPAWNS + POPENS, [])
finally:
    cs.bigpicture_available = saved_avail

print()
print("the URLs are frozen constants, not built from anything")
check("open url", cs._BIGPICTURE_OPEN_URL, "steam://open/bigpicture")
check("close url", cs._BIGPICTURE_CLOSE_URL, "steam://close/bigpicture")

print()
print("the cap key exists at BOTH agent sites (CLAUDE.md §4)")
src = open(os.path.join(ROOT, "agent", "couchsided.py")).read()
check("in the mock tuple", '"bigpicture", "desktop"' in src, True)
check("in the real CAPS dict",
      '"bigpicture": safe(bigpicture_available)' in src, True)

print()
if FAILURES:
    print("FAILED: %s" % ", ".join(FAILURES))
    sys.exit(1)
print("all big-picture tests passed")
