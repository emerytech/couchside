# Note mode — jot a clue on the phone while the game runs

**Status:** 📋 Planned. Spec only; nothing built.
**Origin:** owner, 2026-07-22, watching the drag stroke land on a real device:
"the drag lines could even be a note tool in the swipe menu — a toggle to switch to note
mode for when you are gaming and want to jot down a clue."

## Why this is cheap

The hard part already exists and shipped in the same session. `app/lib/touchTrail.ts` turns
a stream of touch coordinates into contiguous, correctly-rotated runs of line
(`trailPoints` → `strokeRuns` → `segmentBox`), and `TouchIndicatorLayer.tsx` already renders
those runs as glowing segments over an arbitrary subtree. Note mode is that machinery with
**the fade removed and the cap lifted**.

What is genuinely new: persistence, a surface that owns the ink instead of overlaying it,
and the entry point.

## Scope, as stated by the owner

1. **A toggle in the swipe menu** switches the Pad's swipe surface into note mode. While it
   is on, drags draw instead of driving the box.
2. **The toggle itself is hideable** via a Pref, "for those who don't want it". Same shape as
   the existing `hideStreamFromPc` / `hideTvVolume` / `hideDownloads` prefs — `hide*`
   polarity, default visible.
3. **Turning note mode off CLEARS the note from view but does not delete it.** Coming back
   to note mode brings the ink back. Deleting is a separate, deliberate act.
4. **Optionally clear on exit** — a preference for people who want note mode to start clean
   every time.

## The decisions that are NOT made yet

- **Where the ink lives.** In memory only (lost on app restart), in the prefs blob, or in its
  own AsyncStorage key. Requirement 3 means it must at minimum survive a mode toggle; whether
  it survives an app restart is unstated and should be asked, not assumed.
- **How much ink.** The stroke path caps at `MAX_MARKS = 48` runs precisely so a drag cannot
  grow the tree without bound. A note has no such natural bound. Needs either a cap with
  honest behaviour at the limit, or a different representation (one path element per stroke
  rather than one View per 20px run — 48 Views is fine, 2000 is not).
- **Whether it is per-box or global.** A clue is about the game, and the box is what runs the
  game, but the note lives on the phone.
- **Undo.** Not requested. Do not add it uninvited.

## Traps carried over from the stroke work

- **The web harness cannot drive this at all.** React Native Web emits mouse events, never
  touch events, so `onTouchMove` never fires there — this is how a version of the drag trail
  shipped drawing nothing on a real iPhone. Verify on a device with
  `adb shell input swipe x1 y1 x2 y2 <ms>` in the background plus `adb exec-out screencap`
  mid-gesture. See [[wireless-adb-razr]].
- **`TapCapture` must stay an ANCESTOR and every responder handler must keep returning
  false.** Note mode is the first feature that would legitimately want to *consume* the
  gesture rather than observe it, so it must not do that by loosening the shared overlay —
  the swipe pad and trackpad refuse to yield the responder, and a gesture stolen mid-swipe
  leaves the agent's latched d-pad axis asserted (`tests/test_dpad_latch.py`).
- Segments must **abut**, not overlap: square ends and length == true distance. Rounded caps
  double-paint every joint and a semi-transparent stroke beads at exactly the run interval.

## Build order

1. Pref + hidden-by-preference toggle in the swipe menu (no drawing yet) — proves the entry
   point and the gating.
2. Ink surface that owns its own gesture, reusing `strokeRuns`, no fade, no cap yet.
3. Persistence across the mode toggle, then the clear-on-exit preference.
4. Whatever bound the representation needs, decided from a measured node count.
