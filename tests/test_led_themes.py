#!/usr/bin/env python3
"""Agent-served LED theme catalog + generators.

Run: python3 tests/test_led_themes.py

WHY THIS EXISTS: built-in strip themes live in the AGENT (not the app), so a new
theme ships with an agent update and appears in the app with no app-store
resubmit. GET /api/leds/themes serves the catalog; POST /api/leds/theme
generates a strip-SIZED sequence and plays it. This pins:

  1. ALLOWLIST: a theme id is looked up in the frozen LED_THEMES; an unknown /
     non-string / unhashable id yields None (-> 404), never a crash, never a
     generated frame.
  2. GENERATORS ARE WELL-FORMED at any strip length: every frame is exactly n
     cells of valid RGB-or-None, and holds is one in-range int per frame.
  3. DETERMINISM: the same theme renders identically twice (flicker is a hash,
     not random) -> unit-testable and reproducible on the strip.
  4. CATALOG matches the generators (discovery == what apply accepts).
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


def is_cell(c):
    return c is None or (isinstance(c, tuple) and len(c) == 3
                         and all(isinstance(v, int) and 0 <= v <= 255 for v in c))


# --- 2. generators well-formed at any length --------------------------------
print("2. generators produce n-sized, valid frames at every strip length")
for n in (1, 2, 8, 30, 60, 144):
    for tid, (label, gen) in cs.LED_THEMES.items():
        frames, holds = gen(n)
        ok_frames = len(frames) >= 1 and all(len(f) == n for f in frames)
        ok_cells = all(is_cell(c) for f in frames for c in f)
        ok_holds = (len(holds) == len(frames)
                    and all(isinstance(h, int) and 30 <= h <= 60000 for h in holds))
        check("%s n=%d frames sized to n" % (tid, n), ok_frames, True)
        check("%s n=%d cells valid RGB/None" % (tid, n), ok_cells, True)
        check("%s n=%d holds one int per frame in range" % (tid, n), ok_holds, True)

# --- 3. deterministic -------------------------------------------------------
print("3. same theme renders identically (flicker is a hash, not random)")
for tid, (_l, gen) in cs.LED_THEMES.items():
    a = gen(24)
    b = gen(24)
    check("%s deterministic" % tid, a, b)

# --- 4. catalog matches generators ------------------------------------------
print("4. catalog == generators")
cat = cs.leds_theme_catalog()
check("catalog ids == LED_THEMES keys",
      [c["id"] for c in cat], list(cs.LED_THEMES))
check("every catalog row has a label",
      all(isinstance(c.get("label"), str) and c["label"] for c in cat), True)

# --- 1. allowlist + degrade-closed on apply ---------------------------------
print("1. apply_led_theme: frozen id lookup, degrade closed")
_saved_strips = cs._led_strips
_saved_apply = cs.apply_strip_sequence
try:
    applied = []
    cs._led_strips = lambda names=None: {"rgb": ["rgb0", "rgb1", "rgb2", "rgb3"]}
    cs.apply_strip_sequence = (lambda prefix, frames, hold_ms, brightness, loop=True,
                               holds=None: applied.append((prefix, len(frames), len(frames[0]))) or
                               {"ok": True, "strip": prefix})

    # unknown / bad theme ids -> None, nothing applied
    for bad in ("nope", "PORTAL", "portal ", "", None, 5, {"a": 1}, ["portal"]):
        applied.clear()
        r = cs.apply_led_theme(bad, "rgb", 100)
        check("theme %r -> None, nothing applied" % (bad,), (r, applied), (None, []))

    # unknown strip -> None
    applied.clear()
    check("unknown strip -> None",
          cs.apply_led_theme("portal", "nosuch", 100), None)
    check("  and nothing applied", applied, [])

    # valid -> applies a 4-cell sequence (matches the mock strip length)
    for tid in cs.LED_THEMES:
        applied.clear()
        r = cs.apply_led_theme(tid, "rgb", 100)
        check("%s applies to the 4-LED strip" % tid,
              (r is not None and applied and applied[0][2] == 4), True)
finally:
    cs._led_strips = _saved_strips
    cs.apply_strip_sequence = _saved_apply

print()
if FAILURES:
    print("FAILED: %s" % ", ".join(FAILURES))
    sys.exit(1)
print("all LED theme tests passed")
