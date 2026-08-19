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
check("exactly four nav ops", sorted(cs.PLAYER_JS_NAV),
      ["navdown", "navleft", "navright", "navup"])

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
left, right = cs.PLAYER_JS_NAV["navleft"], cs.PLAYER_JS_NAV["navright"]
check("all four scripts differ",
      len({down, up, left, right}), 4)
check("down is +Y", "var DX = 0, DY = 1;" in down, True)
check("up is -Y", "var DX = 0, DY = -1;" in up, True)
check("left is -X", "var DX = -1, DY = 0;" in left, True)
check("right is +X", "var DX = 1, DY = 0;" in right, True)
for name, js in (("navdown", down), ("navup", up), ("navleft", left), ("navright", right)):
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
    check("nav_ops advertised", sorted(info.get("nav_ops") or []),
          ["navdown", "navleft", "navright", "navup"])
    check("advertised == frozen table", sorted(info.get("nav_ops") or []),
          sorted(cs.PLAYER_JS_NAV))
    # additive, not a shape change: the long-standing fields are still there
    for field in ("available", "running", "service", "path", "services", "seek_secs"):
        check("existing field %r still present" % field, field in info, True)
finally:
    cs.player_available = _saved_avail
    cs.PL_MOCK = _saved_mock

# --- 4b. the ROUTE gate covers every nav op ----------------------------------
# Found the hard way: PLAYER_JS_NAV grew navleft/navright and nav_ops
# advertised them, but the do_POST membership tuple still said only
# navup/navdown — so the box advertised ops it then refused with 400. The
# handler-level test above can't see that; check the dispatch source itself.
print("4b. route dispatch tuple covers every nav op")
import re
_src = open(os.path.join(ROOT, "agent", "couchsided.py")).read()
_m = re.search(r'elif op in \(([^)]*"navup"[^)]*)\):', _src)
_route_ops = set(re.findall(r'"(nav[a-z]+)"', _m.group(1))) if _m else set()
check("route tuple == PLAYER_JS_NAV keys", _route_ops, set(cs.PLAYER_JS_NAV))

# --- 4c. trusted CDP key ops (OK/Back) — the KI-066 focus-independence fix ----
print("4c. player_key: frozen key-op selection + dispatch")
_saved_run3 = cs._pl_cdp_key
_saved_running3 = cs._pl_running
_saved_mock3 = cs.PL_MOCK
try:
    cs.PL_MOCK = False
    dispatched = []
    cs._pl_cdp_key = lambda name: dispatched.append(name) or True
    cs._pl_running = lambda: True

    for bad in ("enter", "escape", "OK", "ok ", "activate", "", None, 1, {"a": 1}, ["ok"]):
        dispatched.clear()
        try:
            cs.player_key(bad)
            check("key refused %r" % (bad,), "ACCEPTED", "ValueError")
        except ValueError:
            check("key refused %r (nothing dispatched)" % (bad,), dispatched, [])
        except TypeError as e:
            check("key refused %r without TypeError" % (bad,), "TypeError: %s" % e, "ValueError")

    for op in ("ok", "back"):
        dispatched.clear()
        r = cs.player_key(op)
        check("%s dispatches itself" % op, dispatched, [op])
        check("%s reports ok" % op, (r["ok"], r["op"]), (True, op))

    # degrade closed
    cs._pl_running = lambda: False
    try:
        cs.player_key("ok")
        check("key not running -> refused", "RAN", "RuntimeError")
    except RuntimeError:
        check("key not running -> RuntimeError", True, True)
finally:
    cs._pl_cdp_key = _saved_run3
    cs._pl_running = _saved_running3
    cs.PL_MOCK = _saved_mock3

# the key specs are constants: exactly ok+back, each a trusted keycode
check("key ops are exactly ok+back", sorted(cs.PLAYER_CDP_KEYS), ["back", "ok"])
check("ok = Enter (vk 13)", cs.PLAYER_CDP_KEYS["ok"], ("Enter", "Enter", 13))
check("back = Escape (vk 27)", cs.PLAYER_CDP_KEYS["back"], ("Escape", "Escape", 27))

# route tuple covers every key op (same drift guard as nav)
_mk = re.search(r'elif op in \(([^)]*"ok"[^)]*)\):', _src)
_route_keys = set(re.findall(r'"(ok|back)"', _mk.group(1))) if _mk else set()
check("route tuple == PLAYER_CDP_KEYS", _route_keys, set(cs.PLAYER_CDP_KEYS))

# --- 5. TV zoom (op "scale") — a client value can only SELECT a member -------
print("5. scale op: frozen-membership selector")
_saved_mock2 = cs.PL_MOCK
try:
    cs.PL_MOCK = True
    for bad in ("3", "0.5", "1.6", "2.0", " 1.5", "1.5 ", "", None, 1.5, 2,
                {"v": "2"}, ["2"]):
        try:
            cs.player_scale(bad)
            check("scale refused %r" % (bad,), "ACCEPTED", "ValueError")
        except ValueError:
            check("scale refused %r" % (bad,), True, True)
        except TypeError as e:
            check("scale refused %r without TypeError" % (bad,),
                  "TypeError: %s" % e, "ValueError")
    for good in cs._PL_UI_SCALES:
        r = cs.player_scale(good)
        check("scale accepts %r" % good, (r["ok"], r["scale"]), (True, good))
    # discovery matches the acceptor
    _saved_avail2 = cs.player_available
    cs.player_available = lambda: True
    info = cs.player_info()
    cs.player_available = _saved_avail2
    check("ui_scales advertised == frozen tuple",
          info.get("ui_scales"), list(cs._PL_UI_SCALES))
    check("ui_scale is a member or empty",
          (info.get("ui_scale") or "2") in cs._PL_UI_SCALES, True)
finally:
    cs.PL_MOCK = _saved_mock2

# stale/garbage override file is ignored, never interpreted
import tempfile
_saved_file = cs.PLAYER_SCALE_FILE
try:
    with tempfile.NamedTemporaryFile("w", suffix=".scale", delete=False) as tf:
        tf.write("2; rm -rf /\n")
        cs.PLAYER_SCALE_FILE = tf.name
    check("garbage override file ignored", cs._pl_scale_override(), "")
    with open(cs.PLAYER_SCALE_FILE, "w") as f:
        f.write("1.5\n")
    check("valid override file honoured", cs._pl_scale_override(), "1.5")
finally:
    os.unlink(cs.PLAYER_SCALE_FILE)
    cs.PLAYER_SCALE_FILE = _saved_file

# --- 6. per-service seek strategy (the Netflix M7375 fix) --------------------
# Measured on real playback: currentTime writes kill Netflix's player (M7375);
# its own ArrowRight seeks cleanly. So seek presses keys for services in
# _PL_KEY_SEEK_SERVICES and keeps the JS path for everything else.
print("6. seek-by-key selection + press derivation")
import tempfile as _tf

_saved_conf = cs.PLAYER_CONF
try:
    fd = _tf.NamedTemporaryFile("w", suffix=".conf", delete=False)
    cs.PLAYER_CONF = fd.name

    fd.write("service=netflix\npath=\n")
    fd.flush()
    check("netflix page -> key seek", cs._pl_seek_wants_keys(), True)

    with open(cs.PLAYER_CONF, "w") as f:
        f.write("service=youtube\n")
    check("youtube page -> JS seek", cs._pl_seek_wants_keys(), False)

    # A free-URL open forces service=netflix into the conf, but carries url= —
    # that page is a plain <video>, so it must NOT key-seek.
    with open(cs.PLAYER_CONF, "w") as f:
        f.write("service=netflix\nurl=https://example.com/x\n")
    check("free-URL page -> JS seek even with service=netflix",
          cs._pl_seek_wants_keys(), False)
finally:
    os.unlink(cs.PLAYER_CONF)
    cs.PLAYER_CONF = _saved_conf

check("absent conf -> JS seek (degrade to generic)", cs._pl_seek_wants_keys()
      if not os.path.exists(cs.PLAYER_CONF) else False, False)


class _RecKB:
    """Records emitted key events instead of opening /dev/uinput."""
    made = []

    def __init__(self):
        self.events = []
        _RecKB.made.append(self)

    def emit(self, events):
        self.events.extend(events)

    def destroy(self):
        self.destroyed = True


_saved_kb = cs.UInputKeyboard
_saved_sleep = cs.time.sleep
try:
    cs.UInputKeyboard = _RecKB
    cs.time.sleep = lambda s: None
    _RecKB.made = []
    r = cs._pl_seek_by_key(10)
    kb = _RecKB.made[-1]
    check("+10s = one Right press+release",
          kb.events, [(cs.EV_KEY, cs.KEY_RIGHT, 1), (cs.EV_KEY, cs.KEY_RIGHT, 0)])
    check("+10s reports via=key", (r["ok"], r["via"]), (True, "key"))
    check("keyboard destroyed", getattr(kb, "destroyed", False), True)

    _RecKB.made = []
    cs._pl_seek_by_key(-30)
    kb = _RecKB.made[-1]
    lefts = [e for e in kb.events if e[1] == cs.KEY_LEFT and e[2] == 1]
    check("-30s = three Left presses", len(lefts), 3)
    check("-30s uses no Right", any(e[1] == cs.KEY_RIGHT for e in kb.events), False)
finally:
    cs.UInputKeyboard = _saved_kb
    cs.time.sleep = _saved_sleep

print()
if FAILURES:
    print("FAILED: %s" % ", ".join(FAILURES))
    sys.exit(1)
print("all player nav tests passed")
