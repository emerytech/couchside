#!/usr/bin/env python3
"""Key COMBINATIONS the combo panel sends (COMBO_CHORDS) — reviewer ask:
"a way to send button/key combinations would be fire".

Run: python3 tests/test_combo_chords.py

A combo is one {t:'k','key':<name>} frame; the agent expands the NAME (indexed
in a frozen table, never interpolated) into a press-in-order / release-in-reverse
uinput sequence — the same mechanism as DESKTOP_CHORDS/KEY_CHORDS.

Pins the §3 requirements, pure-stdlib:
  1. ALLOWLIST: every combo name INDEXES COMBO_CHORDS; an unknown name raises
     ValueError (-> the WS decoder rejects it) and produces NO events. Includes
     near-misses (a bare modifier, a chord we did NOT define).
  2. EXPANSION is exact: modifiers press first and release LAST (wrap the base
     key), so the OS sees a real chord, not two stray keystrokes.
  3. CAPABILITY: every code a combo uses is declared in KEYBOARD_CODES, else the
     uinput device can't emit it (the Ctrl-inclusion bug the header warns about).
  4. No crash on a non-string key (the KI-065 class of session-killers).
"""
import importlib.util, os, sys

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

EV = cs.EV_KEY

# 1. every defined combo expands press-in-order + release-in-reverse
print("1. COMBO_CHORDS expand exactly (press in order, release reversed)")
for comboname, codes in cs.COMBO_CHORDS.items():
    want = [(EV, c, 1) for c in codes] + [(EV, c, 0) for c in reversed(codes)]
    got = cs.keyboard_events({"t": "k", "key": comboname})
    check("expand %-10s" % comboname, got, want)

# concrete anchor: copy = Ctrl down, C down, C up, Ctrl up
check("copy = Ctrl+C wrap order",
      cs.keyboard_events({"t": "k", "key": "copy"}),
      [(EV, cs.KEY_LEFTCTRL, 1), (EV, cs.KEY_C, 1),
       (EV, cs.KEY_C, 0), (EV, cs.KEY_LEFTCTRL, 0)])
check("closewin = Alt+F4",
      cs.keyboard_events({"t": "k", "key": "closewin"}),
      [(EV, cs.KEY_LEFTALT, 1), (EV, cs.KEY_F4, 1),
       (EV, cs.KEY_F4, 0), (EV, cs.KEY_LEFTALT, 0)])

# 2. ALLOWLIST — unknown / near-miss names are refused, nothing emitted
print()
print("2. unknown combo names are refused (allowlist, not a pass-through)")
for bad in ("ctrl", "copypaste", "ctrl+c", "delete-everything", "closeall", ""):
    try:
        cs.keyboard_events({"t": "k", "key": bad})
        check("refuse %r" % bad, "NO RAISE", "ValueError")
    except ValueError:
        check("refuse %r" % bad, "ValueError", "ValueError")

# non-string key must not crash the decoder (KI-065 class)
try:
    cs.keyboard_events({"t": "k", "key": {"x": 1}})
    check("non-string key -> ValueError", "NO RAISE", "ValueError")
except ValueError:
    check("non-string key -> ValueError", "ValueError", "ValueError")

# 3. CAPABILITY — every combo code is declared in KEYBOARD_CODES
print()
print("3. every combo code is declared in KEYBOARD_CODES")
missing = sorted({c for codes in cs.COMBO_CHORDS.values() for c in codes}
                 - set(cs.KEYBOARD_CODES))
check("all combo codes declared", missing, [])

# 4. combo names don't collide with the single-key / other chord tables
print()
print("4. combo names are distinct from SPECIAL_KEYS / DESKTOP_CHORDS / KEY_CHORDS")
overlap = (set(cs.COMBO_CHORDS)
           & (set(cs.SPECIAL_KEYS) | set(cs.DESKTOP_CHORDS) | set(cs.KEY_CHORDS)))
check("no name collision", sorted(overlap), [])

print()
if FAILURES:
    print("FAILED: %s" % ", ".join(FAILURES))
    sys.exit(1)
print("all combo-chord tests passed")
