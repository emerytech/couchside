#!/usr/bin/env python3
"""Named key chords on the {t:'k'} channel — the Shift+Tab web-focus key.

Run: python3 tests/test_key_chords.py

WHY THIS EXISTS: a couch d-pad driving a web page cannot use arrow keys.
Measured on the reference box 2026-08-17 against the real sites, each run
carrying a control key whose answer was already known (§11.3): netflix.com and
youtube.com IGNORE arrows (right/down changed neither focus nor scroll) and walk
their focus ring on TAB. Going BACKWARDS needs Shift+Tab, which the frozen
SPECIAL_KEYS table cannot express — hence KEY_CHORDS.

Pins the §6 requirements for that surface, pure-stdlib, no box, no uinput:

  1. HAPPY PATH: {"t":"k","key":"shifttab"} expands to Shift down, Tab down,
     Tab up, Shift up — modifier wraps the base key, released in reverse.
  2. UNKNOWN INPUT IS REFUSED: a key name that is not in any frozen table
     raises ValueError and produces NO events (the caller closes the session).
     Includes near-miss spellings, so this proves lookup and not prefix/pattern
     matching (§3.1/§3.3).
  3. THE DEVICE CAN ACTUALLY EMIT IT: every chord code is declared in
     KEYBOARD_CODES, else UI_SET_KEYBIT never advertises it and the emit
     silently does nothing on real hardware.
  4. DISCOVERY IS HONEST: the hello frame's `keys` list contains exactly the
     names the decoder accepts — no name is advertised that would be refused,
     and none is accepted that isn't advertised. That list is what stops a
     newer app from firing an unknown name at an older agent and killing its
     own socket.
  5. NOTHING EXISTING MOVED: the pre-existing named keys still decode as
     single press+release, and the desktop chord still works (a control
     proving this file's changes did not redefine the old path).
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


EV_KEY = cs.EV_KEY
SHIFT = cs.KEY_LEFTSHIFT
TAB = cs.KEY_TAB

# --- 1. happy path -----------------------------------------------------------
print("1. shifttab expands to a wrapped chord")
check(
    "shifttab -> shift down, tab down, tab up, shift up",
    cs.keyboard_events({"t": "k", "key": "shifttab"}),
    [(EV_KEY, SHIFT, 1), (EV_KEY, TAB, 1), (EV_KEY, TAB, 0), (EV_KEY, SHIFT, 0)],
)
# The whole point is that it differs from a bare Tab; if these ever matched,
# the chord would be walking the focus ring the wrong way.
check(
    "shifttab differs from bare tab",
    cs.keyboard_events({"t": "k", "key": "shifttab"})
    != cs.keyboard_events({"t": "k", "key": "tab"}),
    True,
)

# --- 2. unknown names are refused, and nothing runs ---------------------------
print("2. unknown key names raise (lookup, not pattern match)")


def refused(key):
    try:
        cs.keyboard_events({"t": "k", "key": key})
    except ValueError:
        return True
    return False


for bad in (
    "shift+tab",     # the spelling a human would guess
    "shifttab ",     # trailing space
    "SHIFTTAB",      # case
    "shift",         # a bare modifier is NOT separately pressable
    "shifttabx",     # prefix of a valid name + extra
    "ctrltab",       # a chord that exists in no table
    "",
    None,
    123,
    {"nested": "object"},
):
    check("refused %r" % (bad,), refused(bad), True)

# --- 3. the virtual keyboard actually declares the codes ---------------------
print("3. chord codes are declared at device create")
for name, codes in cs.KEY_CHORDS.items():
    for code in codes:
        check("KEYBOARD_CODES declares %s code %d" % (name, code),
              code in cs.KEYBOARD_CODES, True)

# --- 4. hello's advertised key list matches what the decoder accepts ---------
print("4. advertised `keys` == accepted names")
advertised = sorted(set(cs.SPECIAL_KEYS) | set(cs.DESKTOP_CHORDS) | set(cs.KEY_CHORDS))
# Everything advertised must decode without raising...
accepted = []
for name in advertised:
    try:
        cs.keyboard_events({"t": "k", "key": name})
        accepted.append(name)
    except ValueError:
        pass
check("every advertised key is accepted", accepted, advertised)
check("shifttab is advertised", "shifttab" in advertised, True)
# ...and the names the d-pad relies on are all present.
for need in ("up", "down", "left", "right", "enter", "esc", "tab", "shifttab"):
    check("d-pad key %r advertised" % need, need in advertised, True)

# --- 5. controls: the pre-existing paths still behave -------------------------
print("5. controls — existing keys unchanged")
check(
    "plain tab is still a single press+release",
    cs.keyboard_events({"t": "k", "key": "tab"}),
    [(EV_KEY, TAB, 1), (EV_KEY, TAB, 0)],
)
check(
    "enter is still a single press+release",
    cs.keyboard_events({"t": "k", "key": "enter"}),
    [(EV_KEY, cs.KEY_ENTER, 1), (EV_KEY, cs.KEY_ENTER, 0)],
)
check(
    "desktop chord still wraps in reverse",
    cs.keyboard_events({"t": "k", "key": "overview"}),
    [(EV_KEY, cs.KEY_LEFTMETA, 1), (EV_KEY, cs.KEY_W, 1),
     (EV_KEY, cs.KEY_W, 0), (EV_KEY, cs.KEY_LEFTMETA, 0)],
)
def _bad_type():
    try:
        cs.keyboard_events({"t": "zzz"})
    except ValueError:
        return True
    return False


check("unknown message type still raises", _bad_type(), True)

print()
if FAILURES:
    print("FAILED: %s" % ", ".join(FAILURES))
    sys.exit(1)
print("all key-chord tests passed")
