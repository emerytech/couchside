#!/usr/bin/env python3
"""Tests for player transport over CDP (play/pause/seek).

Run: python3 tests/test_player_transport.py

THE PROPERTY THIS EXISTS TO PROVE: nothing a client sends is ever executed.

CDP's Runtime.evaluate runs arbitrary JavaScript in a browser that is signed
into the user's streaming accounts, and a Page.navigate to file:// plus a DOM
read is local file exfiltration. So the transport is built as lookup-only: an op
id selects a script CONSTANT defined in the agent, and where an op needs a
number the number is taken out of a frozen tuple by index — the request's bytes
are used to find the index and then discarded.

These tests do not take that on faith. `_pl_cdp_run` is replaced with a spy, so
every script that would have executed is captured and compared against the
frozen set. A refused request must leave that spy untouched: "returned 404" and
"executed nothing" are separate observations, and only the second one is the
security claim.

Pure stdlib, no pytest.
"""
import importlib.util
import json
import os
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT = os.path.join(HERE, "..", "agent", "couchsided.py")
spec = importlib.util.spec_from_file_location("couchsided", AGENT)
cs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cs)

PASS = "  \033[32mPASS\033[0m"
FAIL = "  \033[31mFAIL\033[0m"
_fail = []


def check(cond, label, detail=""):
    print((PASS if cond else FAIL) + "  " + label +
          ("" if cond else "  <- %s" % (detail,)))
    if not cond:
        _fail.append(label)


# --- harness: capture every script that would reach the browser -------------
RAN = []


def spy(expression):
    RAN.append(expression)
    return True


tmp = tempfile.mkdtemp(prefix="couchtransport_")
cs.PLAYER_CONF = os.path.join(tmp, "player.conf")
cs.PL_MOCK = False
cs._pl_cdp_run = spy
cs._pl_running = lambda: True

# Every script the agent is capable of running, by construction.
FROZEN = set(cs.PLAYER_JS_OPS.values()) | set(cs.PLAYER_JS_SEEK.values())


def run(op, **kw):
    RAN.clear()
    try:
        return cs.player_transport(op, **kw), None
    except (ValueError, RuntimeError) as e:
        return None, e


# ---------------------------------------------------------------------------
print("\nallowed ops run exactly the frozen script for that op")
# ---------------------------------------------------------------------------
for op in ("play", "pause", "playpause", "mute"):
    res, err = run(op)
    check(err is None and len(RAN) == 1 and RAN[0] == cs.PLAYER_JS_OPS[op],
          "%s runs its own constant, once" % op, (err, len(RAN)))

for secs in cs.PLAYER_SEEK_SECS:
    res, err = run("seek", secs=secs)
    ok = err is None and len(RAN) == 1 and RAN[0] == cs.PLAYER_JS_SEEK[secs]
    check(ok, "seek %+ds runs its pre-built constant" % secs, (err, RAN[:1]))
    # The offset must appear as a literal, and nothing else may.
    if ok:
        check("(%d)" % secs in RAN[0],
              "    seek %+ds embeds the literal offset" % secs)

# ---------------------------------------------------------------------------
print("\nrefused input: 404-worthy AND nothing executes")
# ---------------------------------------------------------------------------
BAD_SEEK = [
    0, 5, 11, -11, 3600, -3600, 1e9, 0.5,
    "10", "10; alert(1)", None, True, [10], {"secs": 10},
    # The shape an attacker actually wants: valid-looking, but not a member.
    9.999999, -0.0000001,
]
for bad in BAD_SEEK:
    res, err = run("seek", secs=bad)
    check(isinstance(err, ValueError) and not RAN,
          "seek %r refused, nothing ran" % (bad,), (err, RAN))

for op in ("", "eval", "navigate", "Runtime.evaluate", "open", "close",
           "play;pause", "PLAY", None, 42):
    res, err = run(op)
    check(isinstance(err, ValueError) and not RAN,
          "op %r refused, nothing ran" % (op,), (err, RAN))

# ---------------------------------------------------------------------------
print("\nno script outside the frozen set is reachable")
# ---------------------------------------------------------------------------
RAN.clear()
for op in ("play", "pause", "playpause", "mute"):
    cs.player_transport(op)
for secs in cs.PLAYER_SEEK_SECS:
    cs.player_transport("seek", secs=secs)
strays = [s for s in RAN if s not in FROZEN]
check(not strays, "every executed script is a module constant", strays[:2])

# Degrade closed: not running -> RuntimeError, and still nothing executed.
cs._pl_running = lambda: False
RAN.clear()
res, err = run("play")
check(isinstance(err, RuntimeError) and not RAN,
      "player not running -> refused, nothing ran", (err, RAN))
cs._pl_running = lambda: True

# ---------------------------------------------------------------------------
print("\nplayback state degrades closed")
# ---------------------------------------------------------------------------
cs._pl_cdp_run = lambda expr: None          # browser unreachable
check(cs.player_playback() is None,
      "unreachable browser -> None, never a guessed state")
cs._pl_cdp_run = lambda expr: "not-a-dict"
check(cs.player_playback() is None, "garbage from the page -> None")
cs._pl_cdp_run = lambda expr: {"playing": True, "position": 12.0,
                               "duration": 100.0, "muted": False, "title": "x"}
state = cs.player_playback()
check(isinstance(state, dict) and state.get("playing") is True,
      "a real reading comes back", state)

print("\n%d checks failed" % len(_fail))
raise SystemExit(1 if _fail else 0)
