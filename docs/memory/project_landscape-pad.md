# Landscape gamepad — full-screen controller (owner ask 2026-08-07)

> **Status: SPEC ONLY, nothing built.** Roadmap entry is P1.
>
> Sources: Steam Link, Xbox Cloud (Touch Adaptation Kit), Moonlight
> (moonlight-android / moonlight-ios source), Dolphin and RetroArch overlays,
> and GameHub. GameHub turned out to be the WEAKEST citation — closed source, no
> design docs, and its stick and button geometry could not be verified at all.
> The one thing it did prove: during play its only chrome is a thin right-edge
> drawer with an isolated Exit, and the top, bottom and left edges are empty.
> Every number below comes from the open-source clients and Microsoft's
> published schema, not from GameHub.
>
> Owner's ask: rotating the phone on the Pad tab gives a full-screen controller
> with no app chrome; rotating back exits; plus a LOCK toggle to pin orientation.

# Landscape Gamepad — Buildable Spec

**Target file:** `app/app/(tabs)/pad.tsx` (landscape branch at L1951–2049 + `landRoot`/`landShoulderRow`/`landMain`/`landColumn`/`landCenter` in `makeStyles`, L2759–2792). New pure module `app/lib/padLayout.ts`, new test `app/lib/__tests__/padLayout.test.ts`. Touches `app/components/TabScreen.tsx`, `app/app/(tabs)/_layout.tsx`, `app/hooks/useLockOrientation.ts`.

## Why it breaks today (the arithmetic, so the fix is checkable)

`landColumn` is a flex column of fixed-pixel children: `Stick` (`STICK_SIZE = 132`) + `gap: 14` + d-pad (`58×3 + 4×2 = 182`) = **328dp**. Add `landShoulderRow` (`shoulderBtn.height = 48` + `marginBottom: 8`) = **384dp**. Add `styles.screen`'s `paddingTop: 10` + `paddingBottom: Math.max(insets.bottom, 10)` ≈ **415dp**. Above that sits `TabScreen`'s `BoxSwitcher` (`insets.top + 8` + content), the status pill, the `pad.modes` selector; below it the tab bar. Total demand ≈ **575dp against a 393dp short axis.**

Flexbox does not clip and does not warn — children just spill and paint over each other. That is the overlap. The clipping is the same overflow on the horizontal axis plus `paddingHorizontal: 12` being the only edge allowance on a screen where the notch inset is 59pt.

Both symptoms are one bug: **fixed pixel sizes in a flex container, with the safe area handled by a portrait-era padding rule.**

---

## A. Fixed vs floating sticks

**Decision: fixed container, floating origin, capture-until-release. Not spawn-anywhere floating.**

The "user is looking at the TV" argument is usually deployed for floating sticks — you can't see the ring, so let the stick come to the thumb. That argument is half right and it proves the wrong thing.

Eyes-off cuts both ways. Yes, the thumb lands imprecisely, which kills *origin*-fixed sticks. But eyes-off also means the thumb has to **find the d-pad, the face buttons, and the guide button by feel** — and the only thing findable by feel on a slab of glass is a screen **edge or corner**. A spawn-anywhere stick (Steam Link's dynamic mode: left half = LS, right half = RS) consumes an entire half-screen and makes every other control unreachable. This product's most-used control is not the analog stick; it is the d-pad driving Steam Big Picture. Trading the d-pad away for stick convenience is the wrong trade for a TV remote.

So take the split that Xbox's Touch Adaptation Kit and Dolphin both landed on independently:

| Property | Value | Rationale |
|---|---|---|
| Container | **Fixed**, corner-anchored | Findable by feel; leaves the rest of the pad hittable |
| Origin | **Floating** — touch-down point becomes zero | Thumb lands where it lands; no visual acquisition needed |
| Capture | **On grant, held until release** | Finger may leave the ring, the screen, the bezel |
| Value clamp | **Radial**, magnitude only | Never square-clamp per axis (moonlight-ios does; diagonals reach √2) |
| Visual ring | Drawn only while held | Nothing to look at when nothing is happening |

TAK's schema default is `relative: true` and all six of Microsoft's shipped sample layouts take it. Dolphin ships `JoystickRelCenter = true`. Steam Link ships fixed-origin by default and offers floating as an opt-in escape hatch. The consensus is: fixed *place*, floating *origin*.

**Stick math (replaces `Stick` at pad.tsx L130–182):**

```
ring radius        R  = 15U          (visual, drawn on touch only)
nub radius            = 6U
capture region        = the node's hit rect (see §B expansion rule), NOT a radius test on move
value saturation   T  = 22U          full deflection at 22U of finger travel
nub visual clamp      = R - 6U = 9U  nub pins to the rim; finger keeps going
deadzone              = 0.12 * T, radial, output renormalised: mag' = (mag - dz) / (1 - dz)
stick click           = release with travel < TAP_SLOP (12) and duration < TAP_MS (450) -> L3/R3
```

Two things the current `Stick` gets wrong beyond size:

1. **Full deflection at 38px.** `STICK_RADIUS = (132 − 56)/2 = 38`. Thirty-eight pixels of travel from rest to max is unusable without looking. `T = 22U` ≈ 82dp gives a 2.5:1 visual compression (nub moves 33dp, finger moves 82dp) — correct precisely *because* nobody is watching the nub.
2. **No `onPanResponderTerminationRequest`.** The trackpad responder in the same file (L282) returns `false`; `Stick` doesn't, so a competing responder can steal the stick mid-drag and strand the axis at its last value. Add `onPanResponderTerminationRequest: () => false`. Keep `g.dx/g.dy` — gestureState deltas are already relative to touch-down, which is the floating origin, for free.

L3/R3 become the stick tap. That removes `landThumbRow` entirely and reclaims two 44dp targets.

---

## B. Layout

### Coordinate system — one rect, one unit, no exceptions

```ts
// app/lib/padLayout.ts — pure, no React, no imports
const play = {
  x: insets.left,
  y: insets.top,
  w: win.width  - insets.left - insets.right,
  h: win.height - insets.top  - insets.bottom,
};
const U = Math.min(play.h, 430) / 100;   // ONE unit = 1% of the usable SHORT axis
if (play.h < 340) return { ok: false, reason: 'too-short' };
```

Three rules that make clipping unrepresentable rather than fixed:

1. **No control's extent may reference `play.w`.** Every width, height, radius, gap and margin is `k * U`. `U` caps at 4.3 so a tablet gets a bigger empty middle, not comic-book buttons.
2. **Anchor by centre, with margin ≥ half-extent:** `cx = play.x + m + halfW`, `cx = play.x + play.w − m − halfW`. Anchoring by top-left is what lets a control cross the far edge (moonlight-android's `moveElement()` clamps `> 0` and nothing else — a shipped, real bug).
3. **Insets are subtracted exactly once, into `play`.** In landscape on iPhone, `insets.top` is **0**, the notch is `insets.left` **or** `insets.right` (59pt, depending on rotation direction) and the home indicator is `insets.bottom` (21pt). The pad is therefore *not* mirror-symmetric in physical pixels, and that is correct. Nothing downstream ever sees `win.width`.

### The table

`P` = play rect, `C` = `P.x + P.w/2`. All values in `U`. `↔` = width × height or ⌀diameter.

| Node | Size | Centre | Layer |
|---|---|---|---|
| **LT** | 18 × 14 | `P.left + 12`, `P.top + 10` | 1 |
| **LB** | 18 × 14 | `P.left + 32`, `P.top + 10` | 1 |
| **LOCK** | 15 × 14 | `C − 9`, `P.top + 10` | 9 |
| **EXIT ✕** | 15 × 14 | `C + 9`, `P.top + 10` | 9 |
| **RB** | 18 × 14 | `P.right − 32`, `P.top + 10` | 1 |
| **RT** | 18 × 14 | `P.right − 12`, `P.top + 10` | 1 |
| **SELECT** | 18 × 14 | `P.left + 12`, `P.top + 27` | 2 |
| **STEAM** | 18 × 14 | `P.left + 32`, `P.top + 27` | 3 |
| **⋯ QAM** | 18 × 14 | `P.right − 32`, `P.top + 27` | 4 |
| **START** | 18 × 14 | `P.right − 12`, `P.top + 27` | 5 |
| **D-PAD** | 39 × 39 | `P.left + 22.5`, `P.bottom − 23.5` | 6 |
| **LEFT STICK** | ⌀30 | `P.left + 64`, `P.bottom − 26` | 7 |
| **RIGHT STICK** | ⌀30 | `P.right − 70`, `P.bottom − 26` | 8 |
| **FACE DIAMOND** | 45 × 45 | `P.right − 25.5`, `P.bottom − 26.5` | 1 |

**Three bands, nothing crosses a boundary.** Row 1 (`3..17U` from top) = shoulders + chrome. Row 2 (`20..34U`) = menu buttons. Middle (`34..51U`) = deliberately empty; this is where a hand grips the phone. Bottom (`51..96U`) = thumb clusters. The face diamond's top edge sits at `51U` from the top and Row 2's bottom edge at `34U` — a **17U ≈ 63dp** dead gap. Shoulders can never touch face buttons because they are not in the same band. That is the fix for the overlap, and it is arithmetic, not nudging.

**Long-axis check at both extremes.** Left group `3 + 39 + 7 + 30 = 79U`; right group `3 + 45 + 7 + 30 = 85U`. On 20:9 (`P.w = 212U`) the centre channel is **48U**; on 16:9 (iPhone SE landscape, `P.w = 178U`) it is **14U ≈ 52dp**. Positive on both — one table, no responsive tier. Chrome moat: Row-1 left group ends at `P.left + 41U`, LOCK's left edge is at `C − 16.5U` = `P.left + 72U` on the worst case — a **31U ≈ 118dp** moat around the exit.

### Face diamond and d-pad internals

- **Face buttons:** ⌀13U, centre-to-centre 16U, so a **3U ≈ 11dp edge-to-edge gap**. If space ever gets tight, shrink the *diameter*, never the gap — the gap is what prevents mis-presses. Span `2 × 16 + 13 = 45U`. All four share layer 1 so a thumb can roll A→B mid-press.
- **D-pad:** **angular hit test**, not a 3×3 grid of boxes. Centre disc of 6U = `A/OK` (keep the existing centre-OK behaviour; it is right for Steam nav). Outside the disc, four 90° sectors. This means every pixel of the 39U cluster does something — no dead corners, which is what eyes-off requires. **No diagonals.** A corner press that fires two directions at once is worse than one that fires the nearest cardinal.
- **Slide-between:** allowed within a layer, blocked across layers (moonlight-android's `checkMovement()` gate). Face buttons and shoulders are layer 1; d-pad, sticks, SELECT, START, STEAM, ⋯ each get their own layer so no drag can ever fire them. LOCK and EXIT share layer 9 and additionally require the touch to start *and* end inside them.

### Hit-rect expansion — "no dead pixels"

Visual rects come from the table. Hit rects are computed by one deterministic pass: **expand each node's rect on each of its four sides by `min(0.25 × its own extent on that axis, half the gap to the nearest neighbour's hit rect on that side, the distance to the play-rect edge)`.** Anisotropic by construction — the left stick gains 14U of catch upward and inboard where there is room, and only 3.5U toward the d-pad where there isn't. This is RetroArch's per-direction `reach_*` idea, computed instead of authored.

### Minimum touch targets (hard floor, 44dp)

Binding constraint is the face button at 13U ⟹ `S ≥ 338.5`. Row buttons at 14U ⟹ `S ≥ 314`. D-pad sector inradius `19.5 − 6 = 13.5U` ⟹ `S ≥ 326`. **Minimum supported short axis: 340dp.** Below that, render a "rotate back — screen too short" card. Refuse rather than cramp; that is Microsoft's answer for the same situation and it is the honest one.

---

## C. Chrome, exit, and lock

`const immersive = landscape && mode === 'gamepad'` — the existing gate at L899 already computes both halves.

**Single source of truth, not `setOptions`.** Add `app/lib/immersive.ts` (module-level store + `useSyncExternalStore`, no new dependency) or a context provider in `app/app/(tabs)/_layout.tsx` around `<Tabs>`. Everything reads it:

| Chrome | Mechanism |
|---|---|
| Tab bar | `_layout.tsx` L211: `tabBarStyle: immersive ? { display: 'none' } : { backgroundColor: t.tabBar, borderTopColor: t.tabBarBorder }` |
| `BoxSwitcher` + `TrialNudge` | `TabScreen.tsx` reads `useImmersive()` and skips both |
| Status pill + `pad.modes` selector | extend the existing `!largePad` gates (L1674, L1806) to `!largePad && !immersive` |
| `styles.screen` padding | the immersive path renders a bare `<View style={{flex:1}}>`, **not** `styles.screen` — its `paddingHorizontal: 12` / `paddingBottom: Math.max(insets.bottom, 10)` (L1670) is the existing double-count |
| iOS status bar | `<StatusBar hidden={immersive} />` (expo-status-bar, already a dep) |
| Android nav bar | `expo-navigation-bar` → `setVisibilityAsync('hidden')` + `setBehaviorAsync('overlay-swipe')`. **One new dependency; log it in DEPENDENCIES.md.** Optional — without it `insets.bottom` already accounts for the bar and the layout stays correct, just 16–24dp shorter |
| Re-assert on focus | inside `useFocusEffect`, not `useEffect` — bars come back on every focus change and one call at mount is not enough |

**Do not move landscape play to its own route.** The generic advice from every reference is "render it as a fullscreen route outside the tab navigator." Do not follow it here. A route change unmounts `PadScreen`, tears down the gamepad WebSocket, and destroys/recreates the agent's uinput device on every rotation — the exact lifecycle this project's known issues live in (KI-053). Same component, chrome suppressed by state. The WS never notices the rotation.

### Exit

**Primary exit is rotating the phone.** Portrait restores everything, because `immersive` is derived from `width > height`. The ✕ exists for when rotation won't work.

Tapping ✕: clear `lock`, set an `exited` flag → orientation policy `'portrait'` → force `lockAsync(PORTRAIT_UP)`. The subtlety: the device is still *physically* landscape, so without the forced lock it flips straight back. Clear `exited` once `!landscape` is observed in `useWindowDimensions`, so a later deliberate rotation re-enters play. No confirmation dialog — leaving is not destructive.

### Lock

`useLockOrientation` gains a third policy:

```ts
export type OrientationPolicy = 'portrait' | 'allow-landscape' | 'landscape-locked';
// 'landscape-locked' -> ScreenOrientation.lockAsync(OrientationLock.LANDSCAPE)
```

`LANDSCAPE` (not `LANDSCAPE_LEFT`) permits both directions, so the lock doesn't fight the user's grip or which side the notch is on.

Policy at the call site (L899):
```ts
useLockOrientation(
  mode !== 'gamepad' || exited ? 'portrait'
  : lock                       ? 'landscape-locked'
  :                              'allow-landscape'
);
```

Two non-negotiables:

1. **The OS lock is released on blur and on unmount.** `useLockOrientation`'s current cleanup (L40–44) does nothing but flip a dead `cancelled` flag. It must `unlockAsync()` so the next focused screen can apply its own policy — otherwise the entire app is pinned landscape after the user leaves the Pad tab.
2. **The `lock` preference persists, the OS lock does not.** Re-entering landscape gamepad mode re-applies it.

Button reads `🔒 LOCKED` / `🔓 AUTO` — state *and* consequence, because when it is on, ✕ is the only way out.

**No auto-hide.** Steam Link fades its controls after 10s; do not copy that. The chrome here is two 48dp buttons in a band that is otherwise empty, costing zero of the scarce short axis. Fading the only exit on a screen the user is not looking at is a bad trade at any timeout.

**Haptics are the confirmation channel.** Every button-down fires `haptic()`; d-pad steps fire `hapticLight()` on each sector change so held-direction repeat is audible-by-feel. Eyes-off, this replaces the pressed state nobody can see.

---

## D. The three mistakes that will be made rebuilding this

**1. Sizing off the wrong axis — in RN, `width: '12%'`.**

Steam Link stores positions as independent fractions of width and height while sizing off height alone. Measured consequence: the same A/B/X/Y diamond is 289×240px on one phone and 346×292 on another, a horizontal stretch tracking `screen aspect ÷ 16:9` to within 2%. Valve's own guide admits it. In React Native the identical bug wears a percentage string, and it is seductive because `width: '12%'` *looks* responsive.

Guard: `padLayout.ts` never receives `play.w` in any size expression. Add a lint-grade test that greps the pad's `StyleSheet.create` for `%` and fails. Circles become ellipses and diamonds stop being diamonds the moment one extent comes from width and its sibling from height.

**2. Counting the safe area twice, or counting it on the wrong edge.**

`pad.tsx` today applies `paddingHorizontal: 12` and `paddingBottom: Math.max(insets.bottom, 10)` in `styles.screen`. If `padLayout` also subtracts insets and the immersive branch still renders inside `styles.screen`, every control drifts inboard by 12dp and the bottom margin is applied twice. The nastier half: portrait-era code handles `insets.top`, but **in landscape `insets.top` is 0** — the notch is `insets.left` *or* `insets.right` at 59pt depending on rotation direction. Code that only knows about `top` clips on exactly one of the two landscape rotations and looks fine on the other, which is how a bug like this survives a review.

Guard: no `<SafeAreaView>` anywhere on this screen. `useSafeAreaInsets()` is read once, fed into `play`, and nothing downstream touches insets again. The unit test runs every device size **twice** — notch left, notch right.

**3. Rebuilding it in flexbox, and forgetting to restore the chrome.**

Flex silently overflows. It does not clip, it does not warn, and it does not appear in a render check. `landColumn` at 328dp inside a `landMain` of ~200dp draws right over the shoulder row and off the bottom of the screen with no error anywhere — which is precisely the ticket being fixed. Absolute positioning from one pure table is the only version of this whose correctness can be *proven*:

```
app/lib/__tests__/padLayout.test.ts
  for each of ~12 device sizes × {notch left, notch right}:
    1. every node.rect is fully inside play                  <- kills clipping
    2. no two node.hit rects intersect                       <- kills overlap
    3. min(hit.w, hit.h) >= 44 for every node                <- kills unhittable targets
    4. EXIT.hit is >= 100dp from every layer 1-8 node        <- kills accidental exit
    5. play.h < 340 returns { ok: false }                    <- refuses rather than cramps
```

Pure arithmetic over a pure function, no renderer, one CI step. Dolphin — a mature, widely shipped emulator — has a computable **43×66px double-fire corner** between `TRIGGER_R` and `BUTTON_Y` in its default layout because nothing ever asserted assertion 2.

The cousin mistake, and it will happen: hiding the tab bar via `navigation.setOptions` inside pad.tsx with no cleanup, or with cleanup that restores `undefined`. The user leaves the Pad tab and the tab bar is gone app-wide. That is why the immersive flag belongs in `_layout.tsx`'s `screenOptions` as a derived value, not in an imperative call that has to remember to undo itself. Same for the orientation lock.

**Per CLAUDE.md §6:** a render is not a test. Verification of this work must include *pressing* every control in the web harness at ≥2 aspect ratios, plus one round-trip of rotate-in → lock → exit → rotate-out with the chrome confirmed restored.

---

## What I would NOT do

- **Not spawn-anywhere floating sticks.** A half-screen stick region eats the d-pad, which is the control this product actually uses.
- **Not a separate expo-router route for landscape play.** It remounts the screen and churns the gamepad WS + uinput device on every rotation. This directly contradicts the standard advice; the standard advice does not know about this agent.
- **Not `<SafeAreaView>`.** `useSafeAreaInsets()` once, into `play`, never again.
- **Not flexbox for control placement.** It cannot express "margin ≥ half-extent from the edge" and it overflows silently. Keep flex for the *portrait* branch, which is unchanged.
- **Not auto-hiding the chrome on a timer.** Never hide the only exit from a screen nobody is looking at.
- **Not a drag-to-customise layout editor in v1.** Every reference that ships one also ships users who drag controls off-screen and file it as your clipping bug. Ship the fixed layout, prove it with the test, then consider an editor — and when you do, clamp the editor to the same `[edge + margin + halfExtent]` bounds the default table uses.
- **Not a confirm dialog on exit.** Leaving landscape is non-destructive; the moat is the safety mechanism.
- **Not d-pad diagonals.** Steam menu navigation has no use for them and a two-direction corner press is worse than a nearest-cardinal one.
- **Not keeping `STICK_RADIUS = 38`.** Thirty-eight pixels from rest to full deflection is unusable without looking at the phone.
- **Not shrinking gaps to make something fit.** Shrink diameters first; the edge-to-edge gap is what prevents mis-presses, not the diameter.
- **Not any percentage string in the landscape styles.** If a number in the source says where a control goes, that number can be wrong. Make it underivable.
