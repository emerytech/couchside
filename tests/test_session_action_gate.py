#!/usr/bin/env python3
"""The session-switch action you are already in must not be offered.

Run: python3 tests/test_session_action_gate.py

THE BUG (found 2026-07-28 against a real box). /api/actions listed BOTH
"Switch to Desktop" and "Return to Game Mode" regardless of the session, so a
box sitting in Game Mode offered "Return to Game Mode" under the heading
"CHANGES WHAT'S ON SCREEN", at danger "medium", behind one confirm whose wording
assumes the opposite session ("Switch back from the desktop...").

It is not a harmless no-op. READ off a Legion Go S (SteamOS, DMI 83N6), the
action's command expands to:

    steamos-session-select gamescope
      -> steamosctl set-default-login-mode game
      -> steamosctl switch-to-game-mode

so firing it while already in Game Mode silently rewrites the box's "Boots into"
preference to game — which the user never asked for, and which the BOOTS INTO
card at the top of that same screen then reports staler than reality. And
_couchmode_session_strict's own docstring already records that re-running the
switch "can restart the session under a running game".

WHAT IS PINNED HERE:
  1. The wrong-direction action is hidden in each known session.
  2. An UNKNOWN session hides nothing — the gate may only ever remove an action
     it is sure about, never strand a box whose pgrep timed out.
  3. The ids it hides are real entries in SESSION_ACTIONS. Without that control
     a typo would make the gate a silent no-op and every other assertion here
     would still pass — and writing it caught exactly that class of mistake:
     these actions are INJECTED, so they are absent from ACTIONS at import.
"""
import importlib.util
import os
import sys

_spec = importlib.util.spec_from_file_location(
    "couchsided",
    os.path.join(os.path.dirname(os.path.abspath(__file__)),
                 "..", "agent", "couchsided.py"))
cs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cs)

FAILURES = []


def check(name, got, want):
    if got == want:
        print("  PASS  %s" % name)
    else:
        print("  FAIL  %s (got %r, want %r)" % (name, got, want))
        FAILURES.append(name)


def main():
    real = cs._couchmode_session_strict
    try:
        print("hides the action for the session you are already in")
        cs._couchmode_session_strict = lambda: "gamescope"
        check("in Game Mode -> hide return-gamemode",
              cs._session_actions_to_hide(), frozenset(["return-gamemode"]))
        # CONTROL: the OTHER direction must still be offered, or a user in Game
        # Mode could not reach the desktop at all.
        check("in Game Mode -> switch-desktop still offered",
              "switch-desktop" in cs._session_actions_to_hide(), False)

        cs._couchmode_session_strict = lambda: "desktop"
        check("on the desktop -> hide switch-desktop",
              cs._session_actions_to_hide(), frozenset(["switch-desktop"]))
        check("on the desktop -> return-gamemode still offered",
              "return-gamemode" in cs._session_actions_to_hide(), False)

        print()
        print("degrade closed")
        # An unknown session must change nothing. Hiding both here would strand
        # a box with no way to switch sessions because a probe timed out.
        cs._couchmode_session_strict = lambda: None
        check("unknown session -> hide nothing",
              cs._session_actions_to_hide(), frozenset())

        # A session string we do not know about is also "hide nothing".
        cs._couchmode_session_strict = lambda: "weston"
        check("unrecognised session -> hide nothing",
              cs._session_actions_to_hide(), frozenset())
    finally:
        cs._couchmode_session_strict = real

    print()
    print("the gate points at real actions")
    # THE TYPO CONTROL. _session_actions_to_hide returning ids that no action
    # actually uses would filter nothing, and every check above would still
    # pass. Asserted against SESSION_ACTIONS, not ACTIONS: these two are
    # INJECTED by _inject_session_actions only on a box that has
    # steamos-session-select, so ACTIONS is empty of them at bare import. Both
    # the gate and the injector read this same table, which is the point.
    for aid in cs._WRONG_ACTION_IN_SESSION.values():
        check("%s is a real session action" % aid, aid in cs.SESSION_ACTIONS, True)

    # And the mapping must cover the whole table: a third session action added
    # later without a gate entry would silently reintroduce the footgun.
    check("every session action has a session it is wrong in",
          set(cs._WRONG_ACTION_IN_SESSION.values()), set(cs.SESSION_ACTIONS))

    print()
    if FAILURES:
        print("FAILED: %s" % ", ".join(FAILURES))
        return 1
    print("all session-action-gate tests passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
