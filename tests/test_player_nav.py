#!/usr/bin/env python3
"""Spatial focus navigation for the Watch d-pad: the navup/navdown player ops.

Run: python3 tests/test_player_nav.py

WHY THIS SURFACE EXISTS: Tab walks a page's focus order LINEARLY — right along a
row of tiles, useless between rows — and the streaming sites ignore arrow keys
(measured: netflix.com/youtube.com left focus untouched, arrows only scrolled).
So vertical d-pad movement runs an agent-authored script that picks the nearest
focusable element above/below. That is JS reaching a live page, i.e. exactly the
kind of primitive CLAUDE.md §3 exists to fence in.

Pins the §6 requirements, pure-stdlib, no box, no browser:

  1. ALLOWLIST: the op id INDEXES a frozen dict of agent-authored scripts.
     An unknown id raises ValueError (-> 404) and NO script is produced.
     Includes near-misses, proving lookup rather than prefix/pattern matching.
  2. NO CLIENT BYTES IN THE JS: the two scripts differ only by an agent-chosen
     direction literal, and neither contains a placeholder a request could fill.
  3. DEGRADE CLOSED: with the player not running, nothing is dispatched to CDP
     (RuntimeError -> 409), and an unreachable browser is an error, not a
     pretend success.
  4. DISCOVERY IS HONEST: the GET payload advertises exactly the ops the
     dispatcher accepts — the field the app feature-detects on.
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


# --- 1. allowlist ------------------------------------------------------------
print("1. op id is looked up, never interpolated")
check("exactly two nav ops", sorted(cs.PLAYER_JS_NAV), ["navdown", "navup"])

_saved_running = cs._pl_running
_saved_run = cs._pl_cdp_run
_saved_mock = cs.PL_MOCK
try:
    cs.PL_MOCK = False
    ran = []
    cs._pl_running = lambda: True
    cs._pl_cdp_run = lambda script: ran.append(script) or True

    for bad in ("navsideways", "nav", "navdow", "navdownx", "NAVDOWN", "navdown ",
                "", None, 123, {"a": 1}, ["navdown"]):
        ran.clear()
        try:
            cs.player_nav(bad)
            check("refused %r" % (bad,), "ACCEPTED", "ValueError")
        except ValueError:
            check("refused %r (nothing ran)" % (bad,), ran, [])
        except TypeError as e:
            check("refused %r without TypeError" % (bad,), "TypeError: %s" % e, "ValueError")

    # happy path: the op runs EXACTLY the script the frozen dict holds
    for op in ("navdown", "navup"):
        ran.clear()
        r = cs.player_nav(op)
        check("%s dispatches its own script" % op, ran, [cs.PLAYER_JS_NAV[op]])
        check("%s reports ok" % op, (r["ok"], r["op"]), (True, op))

    # --- 3. degrade closed ---------------------------------------------------
    print("3. degrade closed")
    cs._pl_running = lambda: False
    ran.clear()
    try:
        cs.player_nav("navdown")
        check("not running -> refused", "RAN", "RuntimeError")
    except RuntimeError:
        check("not running -> RuntimeError, nothing dispatched", ran, [])

    cs._pl_running = lambda: True
    cs._pl_cdp_run = lambda script: None      # browser unreachable
    try:
        cs.player_nav("navdown")
        check("unreachable browser -> refused", "OK", "RuntimeError")
    except RuntimeError:
        check("unreachable browser -> RuntimeError (not a fake success)", True, True)
finally:
    cs._pl_running = _saved_running
    cs._pl_cdp_run = _saved_run
    cs.PL_MOCK = _saved_mock

# --- 2. the scripts carry no client-fillable holes ---------------------------
print("2. scripts are constants with an agent-chosen direction")
down, up = cs.PLAYER_JS_NAV["navdown"], cs.PLAYER_JS_NAV["navup"]
check("the two scripts differ", down != up, True)
check("down uses DIR = 1", "var DIR = 1;" in down, True)
check("up uses DIR = -1", "var DIR = -1;" in up, True)
for name, js in (("navdown", down), ("navup", up)):
    # A leftover %s/%d would mean a later edit could format a request value in.
    check("%s has no format placeholder" % name,
          ("%s" not in js) and ("%d" not in js), True)
    check("%s sets real focus (so a real Enter activates it)" % name,
          ".focus(" in js, True)

# --- 4. discovery matches the dispatcher -------------------------------------
print("4. advertised nav_ops == accepted ops")
_saved_avail = cs.player_available
try:
    cs.PL_MOCK = False
    cs.player_available = lambda: True
    info = cs.player_info()
    check("nav_ops advertised", sorted(info.get("nav_ops") or []), ["navdown", "navup"])
    check("advertised == frozen table", sorted(info.get("nav_ops") or []),
          sorted(cs.PLAYER_JS_NAV))
    # additive, not a shape change: the long-standing fields are still there
    for field in ("available", "running", "service", "path", "services", "seek_secs"):
        check("existing field %r still present" % field, field in info, True)
finally:
    cs.player_available = _saved_avail
    cs.PL_MOCK = _saved_mock

print()
if FAILURES:
    print("FAILED: %s" % ", ".join(FAILURES))
    sys.exit(1)
print("all player nav tests passed")
