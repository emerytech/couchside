#!/usr/bin/env python3
"""Regression test for the box-driven gamepad keepalive.

Run: python3 tests/test_gamepad_keepalive.py

Why this exists: on iOS the app's own {"t":"ping"} keepalive rides a JS
setInterval that the OS FREEZES whenever the app idles. The phone then sits on a
live socket sending nothing, and the agent idle-reaps the holder at
GAMEPAD_IDLE_TIMEOUT_S (12s) -- dead trackpad, "controller disconnected", then a
reconnect that mutes again (an endless churn only a force-quit cleared).
Field-diagnosed on iPhone -> bazzite.local, 2026-07-24, at the packet level: box
WS PING out, phone OS auto-PONG back in ~4ms, holder alive 4.5 min idle where it
previously died at 12s. The OS-level auto-PONG rides no JS timer, so it lands
even while the app is frozen -- that is the fix.

This locks the box side of it: _gamepad_keepalive_tick() must PING EVERY live
session (holder AND waiters), with a PING frame (not TEXT/CLOSE), and cadence
kept well under the reap window. The end-to-end "survives the idle window"
behaviour was verified on hardware; a pure-stdlib unit test cannot exercise the
real recv-loop timer plus the OS auto-PONG, so that half is proven on a box and
cited above, not faked here.

Pure stdlib, no pytest -- same style as test_gamepad_handoff.py so CI just runs it.
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


# Capture (session-name, opcode) for every raw frame a tick sends, instead of
# touching a real socket. _gamepad_keepalive_tick looks _wsend_op up as a module
# global at call time, so replacing it here is enough (same trick as
# test_gamepad_handoff.py).
_pings = []
cs._wsend_op = lambda entry, op, payload=b"": _pings.append((entry["name"], op))


def _reset(sessions):
    _pings.clear()
    cs.GAMEPAD_SESSIONS[:] = sessions


def _entry(name):
    # slock is never contended here (_wsend_op is stubbed); include it so the
    # shape matches a real session entry.
    return {"name": name, "slock": None}


def test_pings_every_session():
    """Holder + every waiter gets exactly one PING per tick."""
    _reset([_entry("holder"), _entry("waiterA"), _entry("waiterB")])
    cs._gamepad_keepalive_tick()
    check("one frame per live session", len(_pings), 3)
    check("every frame is a WS PING",
          all(op == cs.WS_OP_PING for _, op in _pings), True)
    check("the holder was pinged", ("holder", cs.WS_OP_PING) in _pings, True)
    check("a waiter was pinged", ("waiterB", cs.WS_OP_PING) in _pings, True)


def test_no_sessions_is_a_noop():
    """No live sessions -> nothing sent, no crash (the common idle case)."""
    _reset([])
    cs._gamepad_keepalive_tick()
    check("no sessions -> no pings", _pings, [])


def test_cadence_stays_under_the_reap_window():
    """The box ping must be frequent enough that a single lost PONG can't trip a
    false reap: at least 3 pings inside GAMEPAD_IDLE_TIMEOUT_S. This is the
    invariant the whole fix rests on, so assert it rather than trust the literal."""
    check("ping interval <= 1/3 of the idle-reap window",
          cs.GAMEPAD_PING_INTERVAL_S <= cs.GAMEPAD_IDLE_TIMEOUT_S / 3.0, True)


if __name__ == "__main__":
    test_pings_every_session()
    test_no_sessions_is_a_noop()
    test_cadence_stays_under_the_reap_window()
    if FAILURES:
        print("\n%d FAILED: %s" % (len(FAILURES), ", ".join(FAILURES)))
        sys.exit(1)
    print("\nAll gamepad-keepalive tests passed.")
