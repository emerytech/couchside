# Movement mode — landscape, one big thumb-zone, for twin-stick-ish games (owner ask 2026-08-07)

> **Status: SPEC ONLY, nothing built.** Roadmap entry is 📋 Planned.
>
> Owner, after playing on the new landscape pad: *"is there a way to add a pad in
> between the joystick buttons that acts like a pad for moving around like a left
> joystick… using the phone is a perfect way to play games like Vampire Survivors
> that just require you to move around the screen and only require menu navigation
> and selecting upgrades occasionally. Or build a horizontal-rotate-activated swipe
> mode similar to the pad horizontal mode but for swipe, optimised for games like
> Vampire Survivors and Megabonk."*

## What is actually being asked for

Two proposals, one need. The need is a **play posture**, not a control:

| Game phase | Input needed |
|---|---|
| ~95% of play | continuous 2D movement, nothing else |
| level-up / chest | menu nav (4-way) + confirm |
| pause / quit | START, occasionally B |

That is a *much* smaller surface than the full controller, which is why the full
controller feels like overkill for it. Nothing here needs triggers, bumpers,
face-diamond rolls, or a right stick — Vampire Survivors auto-attacks and
auto-aims. (**Megabonk is UNVERIFIED**: if it has manual aim it needs a right
stick and the layout below is wrong for it. Check before building — one game
with manual aim changes the whole shape. See §Open questions.)

## The primitive already exists

`FloatingStick` in `components/LandscapePad.tsx` is already fixed-container /
floating-origin / capture-until-release with a radial clamp — exactly the right
behaviour for eyes-down movement. **The only thing missing is size.** Today the
container is a 30U circle because it is one of fourteen controls sharing a
screen. Movement mode is the same component with a container ten times the area
and almost nothing competing for the space.

Likewise `lib/padLayout.ts` is a pure table + unit system with no assumption that
there is exactly one table. A second table is the natural extension, and every
existing assertion in `__tests__/padLayout.test.ts` should run against it
unchanged (inside play rect, no hit-rect intersections, ≥44dp, EXIT moat, refuse
below the floors).

## A. The grip problem — and why "in between the sticks" is probably not it

The owner's literal ask is a movement pad **in the centre channel**. That channel
is deliberately empty in the current layout, and the reason is written into
`padLayout.ts`: *"the middle 34..51U is deliberately empty because that is where
a hand grips the phone."*

**In a normal two-handed landscape grip the centre of the screen is reachable by
neither thumb.** A thumb pivots from the bottom corner; its comfortable arc
covers roughly the outer third of each side. So a control placed dead centre
would need the user to either re-grip (losing the bezel anchor that makes
everything else findable by feel) or reach across, which is exactly the fatigue
this kind of game punishes over a 30-minute run.

**Recommendation: do NOT put the movement surface in the centre.** Make the
LEFT-THUMB zone enormous instead — that is what the ask is actually reaching for
("acts like a left joystick"), and it costs nothing because in this mode there
is no d-pad to protect.

**This directly reverses a decision recorded 2026-08-07** in
`project_landscape-pad.md` §A ("Not spawn-anywhere floating sticks — a
half-screen stick region eats the d-pad, which is the control this product
actually uses"). That reasoning was for the general controller, where the d-pad
drives Steam Big Picture and is the most-used control on the screen. In a mode
built for one game phase, the d-pad is *not* in use during play, so the trade
flips. **The resolution is a separate MODE, not a change to the default pad** —
if the default pad ever grows a half-screen stick, the reasoning above says that
is a regression.

## B. Layout sketch (a second table in `padLayout.ts`)

Same `U` (1% of usable short axis), same play rect, same floors.

| Node | Size | Centre | Notes |
|---|---|---|---|
| **MOVE** | 46 × 62 | `P.left + 26`, `P.bottom − 34` | The whole left thumb-arc. Floating origin, ring drawn on touch only. |
| **A** | ⌀15 | `P.right − 16`, `P.bottom − 20` | Confirm / pick upgrade. Thumb-rest position. |
| **B** | ⌀15 | `P.right − 34`, `P.bottom − 28` | Back / cancel. Up-left of A, same arc. |
| **NAV** | 30 × 30 | `P.right − 25`, `P.bottom − 62` | 4-way angular, for upgrade menus. Same `dpadZone` as today, no centre disc. |
| **START** | 18 × 14 | `P.right − 12`, `P.top + 10` | Pause. Out of the way on purpose. |
| **LOCK / EXIT** | as today | row 1 centre | Unchanged, same 26U moat rule. |

Everything else the controller has is **absent**, not hidden — an absent control
cannot be mis-pressed, and the whole point of the mode is that the surface is
small enough to use without looking.

Open geometry question: whether MOVE should be a rect (any touch in the zone
starts a drag) or keep a visible resting ring. Lean rect + faint ring only while
held — the mode is for eyes-on-TV play.

## C. How it is entered — the part that needs a decision

The owner suggested "horizontal-rotate-activated". Three options, and they are
not equivalent:

1. **A fifth pad mode** (`PAD / SWIPE / MOUSE / REMOTE / MOVE`) that goes
   immersive in landscape exactly like gamepad does. Discoverable, explicit,
   reuses the `immersive = landscape && mode === 'gamepad'` gate by widening it
   to a set. **Cost:** the mode selector row is already five segments wide on a
   phone and a sixth may not fit — measure before committing.
2. **A toggle inside landscape gamepad mode** — a button in row 1 next to LOCK
   that swaps the layout table in place. No new mode, no selector pressure, and
   the WS/uinput session is untouched because it is the same component and the
   same protocol keys. **Cheapest, and probably right.**
3. **Auto-detect from the running game** — the agent already reports what is
   running. Rejected for v1: guessing wrong mid-run takes controls away from
   someone who is holding a boss fight, and the failure is silent.

**Recommendation: option 2 for v1**, with option 1 reconsidered only if the mode
proves it deserves top-level billing.

Note the owner's second framing ("a swipe mode… but horizontal") is a different
thing from what they need: `SwipeSurface` emits **discrete d-pad steps**, which is
right for menu navigation and wrong for continuous movement — stepped input in
Vampire Survivors would be jerky and unplayable. The mode wants analog stick
output (`{t:'s'}`), not stepped buttons (`{t:'b'}`). Worth saying out loud so
nobody builds the swipe version by following the words instead of the goal.

## D. Phases

1. **Verify the premise on hardware.** Run Vampire Survivors on bazzite, drive it
   from the existing landscape pad, and confirm the left stick alone is
   sufficient — and find out what Megabonk actually needs (manual aim or not).
   Do not build the layout before this; the whole shape depends on whether a
   right stick is required. Per house rule: get the number off a real box.
2. **Second table + tests.** Add the table to `padLayout.ts`, run every existing
   assertion against it, add the mode toggle to the landscape chrome row.
3. **Device pass.** Actually play a run. The success criterion is not "the
   controls work", it is "a 20-minute run is comfortable" — which only a real run
   can answer, and which is the only reason this mode exists.

## Open questions

- **Megabonk's input requirements are unverified.** It is named in the ask and it
  may need manual aim. If it does, MOVE + a right-stick zone is a different and
  tighter layout, and the mode may need two variants.
- Does the mode need haptics on movement? Probably not — continuous input has no
  discrete events to confirm, and constant haptics drain battery over a long run.
- Should the mode persist per-box or per-game? Per-box is consistent with
  `padMode` today; per-game would need launch integration and is v2 at best.
- 44dp floor still applies, but MOVE is enormous and the four right-hand controls
  are the binding ones — re-derive `MIN_SHORT_AXIS` for this table rather than
  assuming 326 carries over.
