# Vertical movement mode — one-handed, a real pad MODE (owner ask 2026-08-07)

> **Status: SPEC ONLY.** Owner, after playing movement mode on TestFlight 141
> ("controller mode works great, the vampire survivor input"): *"could we make a
> one handed vertical version of this that can be clicked into from the pad
> swipe panel."*

## What it is

The landscape movement mode's idea — one big floating-origin zone driving the
left stick, plus the four things Vampire-Survivors-likes actually need — but
PORTRAIT, designed for one thumb, and entered from the Pad tab's mode selector
like any other mode. Phone in one hand on the couch arm; the whole interaction
is the thumb.

## Design shape (owner refined 2026-08-07 evening)

Owner: *"basically move gamepad as an alternative to swipe and you click a
button to open it and then once inside you can lock it and have the exit
buttons like it currently has inside the gamepad move horizontal view."*

1. **Entered by a BUTTON from the pad mode panel, alongside SWIPE — and once
   open it is IMMERSIVE, portrait included.** Same interaction contract as the
   landscape controller: full screen, no tab bar, no pill, no selector; a
   chrome row with 🔒 LOCK and ✕ EXIT exactly like the landscape layouts. EXIT
   returns to the mode panel you came from. This extends the immersive store
   to portrait for the first time — the gate stops being landscape-only and
   becomes "a full-screen surface is open".
2. **One mode, two tables.** Inside MOVE, orientation picks the table:
   portrait → the vertical one-handed layout below; landscape → the existing
   MovePad. LOCK pins whichever orientation you are in (the orientation policy
   gains 'portrait-locked' as the mirror of 'landscape-locked'). The
   `landscapePadVariant` chrome toggle should then be reconciled — two sources
   of truth for "movement vs controller" must not survive the build.
3. **The entry button.** A segment or chip in the mode panel next to SWIPE.
   The row already carries up to five segments with STEAM; measure in the
   harness before committing (shorter labels / icon segment are the fallback).
4. **Layout sketch (third table, PORTRAIT floors).** One-thumb reach on a
   6.9" phone is the bottom ~55% and the right ~70% (assume right thumb;
   mirror later if asked). Zone: full-width-ish, bottom half. Above it, one
   row within thumb stretch: NAV (4-way, same navZone), A, B. START top-right
   corner (deliberate reach). `buildLayout` needs orientation-aware floors —
   the current MIN_LONG_AXIS_U assumes landscape; a portrait table binds on
   WIDTH ≥ ~140U instead. Same builder, same expansion pass, same property
   tests parameterised over a third table.
4. **All existing invariants carry:** 44dp on real targets (sector thickness
   and disc diameters, not boxes — the review findings), EXPAND_CAP_U, every
   press has a guaranteed release (the mode joins the padMounted releaseAll
   predicate), protocol keys unchanged (agent never knows).

## What it reuses

`FloatingStick` (zoneOutline), `NavPad`, `PadKey`, `navZone`, the builder and
the whole test harness. The new work is one table, portrait floors, and the
mode-selector plumbing (`PadMode` union + settings + keyboardMode fallback +
selector row + the useLockOrientation call site: mode `move` is
portrait-allowed AND landscape-allowed — the one mode with layouts in both).

## Verification plan

Property tests over the third table (both notch sides — portrait notch is
`insets.top`, so the table finally exercises a nonzero top inset); harness
press-through of the selector entry + zone drag + NAV; device pass one-handed
on the Razr and an iPhone. The success criterion is the same as landscape
MOVE's: a 20-minute run is comfortable with one hand.
