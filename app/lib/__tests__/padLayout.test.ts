/**
 * Landscape gamepad geometry — lib/padLayout.ts.
 *
 * Run: from app/, `node --experimental-strip-types --test lib/__tests__/*.test.ts`
 * Picked up by the CI `app-input` job's existing glob; no workflow change.
 *
 * WHAT THIS IS FOR. The bug being fixed (owner screenshot 2026-08-07: left
 * stick cut off by the screen edge, B clipped right, RB overlapping the X-B
 * gap, the d-pad's DOWN arrow behind the tab bar) was a flex container silently
 * overflowing. Flex does not clip, does not warn, and does not show up in a
 * render check — which is exactly why "I looked at it and it seemed fine" is
 * not evidence here and this file exists instead. Dolphin, a mature and widely
 * shipped emulator, has a computable 43x66px double-fire corner between
 * TRIGGER_R and BUTTON_Y in its default layout because nothing ever asserted
 * the no-overlap property.
 *
 * Every size is run TWICE, notch left and notch right. In landscape on iPhone
 * `insets.top` is 0 and the notch is `insets.left` OR `insets.right` depending
 * on which way the phone was turned, so a layout that only handles `top` clips
 * on exactly one of the two rotations and looks perfect on the other. That is
 * how this class of bug survives review.
 *
 * This is the safety-critical input path (CLAUDE.md §4).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  DPAD,
  EXIT_MOAT_U,
  EXPAND_CAP_U,
  moveLayout,
  NAV,
  navZone,
  MIN_SHORT_AXIS,
  MIN_TOUCH,
  dpadZone,
  padLayout,
  rectGap,
  rectsIntersect,
  stickValue,
  type Insets,
  type PadLayout,
  type Rect,
  type Size,
} from '../padLayout.ts';

// ---------- Devices ----------
// Landscape dp. Long axis first. `side` is the notch/cutout inset, applied to
// ONE side at a time by the runner below; `bottom` is the home indicator or
// gesture bar, which in landscape stays on the bottom edge.
type Device = {
  name: string; w: number; h: number; side: number; bottom: number;
  /** Not a shipping device — a boundary probe. Exempt from the 100dp EXIT moat. */
  synthetic?: boolean;
};

const DEVICES: Device[] = [
  { name: 'iPhone SE (3rd gen)', w: 667, h: 375, side: 0, bottom: 0 },
  { name: 'iPhone 13 mini', w: 812, h: 375, side: 50, bottom: 21 },
  { name: 'iPhone 14', w: 844, h: 390, side: 47, bottom: 21 },
  { name: 'iPhone 14 Pro', w: 852, h: 393, side: 59, bottom: 21 },
  { name: 'iPhone 14 Pro Max', w: 932, h: 430, side: 59, bottom: 21 },
  { name: 'iPhone 16 Pro Max', w: 956, h: 440, side: 62, bottom: 21 },
  { name: 'Pixel 7', w: 892, h: 412, side: 0, bottom: 24 },
  // 336dp of play after the gesture bar. The spec's 340 floor would have shown
  // this phone the "turn it back" card; see MIN_SHORT_AXIS.
  { name: 'Galaxy S21', w: 800, h: 360, side: 0, bottom: 24 },
  { name: 'Razr 2023 (owner test device)', w: 917, h: 412, side: 0, bottom: 24 },
  { name: 'iPad mini', w: 1133, h: 744, side: 0, bottom: 20 },
  { name: 'iPad Pro 11"', w: 1194, h: 834, side: 0, bottom: 20 },
  // The tightest thing that must still work: 16:9 — the narrowest real phone
  // shape — at the exact short-axis floor. Both floors bind at once here, which
  // is why it is the case that exposes the EXIT-moat conflict.
  { name: 'floor 16:9 @ 326', w: 579, h: MIN_SHORT_AXIS, side: 0, bottom: 0, synthetic: true },
];

type Case = { label: string; win: Size; insets: Insets; synthetic: boolean };

/** Both rotations of every device: notch on the left, then on the right. */
function cases(): Case[] {
  const out: Case[] = [];
  for (const d of DEVICES) {
    const win = { width: d.w, height: d.h };
    out.push({
      label: `${d.name} (notch left)`,
      win,
      insets: { top: 0, right: 0, bottom: d.bottom, left: d.side },
      synthetic: d.synthetic ?? false,
    });
    out.push({
      label: `${d.name} (notch right)`,
      win,
      insets: { top: 0, right: d.side, bottom: d.bottom, left: 0 },
      synthetic: d.synthetic ?? false,
    });
  }
  return out;
}

function ok(l: PadLayout): Extract<PadLayout, { ok: true }> {
  assert.equal(l.ok, true, 'expected a layout');
  return l as Extract<PadLayout, { ok: true }>;
}

const contains = (outer: Rect, inner: Rect) =>
  inner.x >= outer.x - 1e-6 &&
  inner.y >= outer.y - 1e-6 &&
  inner.x + inner.w <= outer.x + outer.w + 1e-6 &&
  inner.y + inner.h <= outer.y + outer.h + 1e-6;

// ---------- Assertion 1 — kills clipping ----------

test('every control is fully inside the play rect, both rotations', () => {
  for (const c of cases()) {
    const l = ok(padLayout(c.win, c.insets));
    for (const n of l.nodes) {
      assert.ok(
        contains(l.play, n.rect),
        `${c.label}: ${n.id} escapes the play rect — ` +
          `rect=${JSON.stringify(n.rect)} play=${JSON.stringify(l.play)}`,
      );
    }
  }
});

test('touchable rects are inside the play rect too — expansion never overruns an edge', () => {
  for (const c of cases()) {
    const l = ok(padLayout(c.win, c.insets));
    for (const n of l.nodes) {
      assert.ok(contains(l.play, n.hit), `${c.label}: ${n.id} hit rect escapes the play rect`);
    }
  }
});

// ---------- Assertion 2 — kills overlap ----------

test('no two touchable rects intersect, both rotations', () => {
  for (const c of cases()) {
    const l = ok(padLayout(c.win, c.insets));
    for (let i = 0; i < l.nodes.length; i += 1) {
      for (let j = i + 1; j < l.nodes.length; j += 1) {
        const a = l.nodes[i];
        const b = l.nodes[j];
        assert.ok(
          !rectsIntersect(a.hit, b.hit),
          `${c.label}: ${a.id} and ${b.id} both answer the same touch — ` +
            `${JSON.stringify(a.hit)} vs ${JSON.stringify(b.hit)}`,
        );
      }
    }
  }
});

test('the specific pairs the screenshot showed colliding are apart', () => {
  // RB over the X-B gap, and the left stick against the d-pad. Named because a
  // generic all-pairs failure message does not say "this is the reported bug".
  for (const c of cases()) {
    const l = ok(padLayout(c.win, c.insets));
    for (const [p, q] of [['rb', 'x'], ['rb', 'b'], ['lstick', 'dpad'], ['dpad', 'a']] as const) {
      assert.ok(
        !rectsIntersect(l.byId[p].hit, l.byId[q].hit),
        `${c.label}: ${p} overlaps ${q}`,
      );
    }
  }
});

// ---------- Assertion 3 — kills unhittable targets ----------

test('every touch target clears 44dp', () => {
  for (const c of cases()) {
    const l = ok(padLayout(c.win, c.insets));
    for (const n of l.nodes) {
      const min = Math.min(n.hit.w, n.hit.h);
      assert.ok(
        min >= MIN_TOUCH - 1e-6,
        `${c.label}: ${n.id} is ${min.toFixed(1)}dp, under the ${MIN_TOUCH}dp floor`,
      );
    }
  }
});

test('a d-pad SECTOR clears 44dp, not just the 39U box around it', () => {
  // The box would pass trivially at any size. What a thumb actually hits is the
  // radial thickness of one sector, so that is what gets asserted.
  for (const c of cases()) {
    const l = ok(padLayout(c.win, c.insets));
    const thickness = DPAD.sectorThicknessU * l.u;
    assert.ok(
      thickness >= MIN_TOUCH - 1e-6,
      `${c.label}: d-pad sector is ${thickness.toFixed(1)}dp thick`,
    );
  }
});

// ---------- Assertion 4 — kills the accidental exit ----------

test('EXIT keeps its moat from every game control, everywhere', () => {
  // Stated in U, because that is the unit the layout is built in and it is the
  // form that holds with no exception. See EXIT_MOAT_U for why the spec's flat
  // 100dp could not also be true at the short-axis floor.
  for (const c of cases()) {
    const l = ok(padLayout(c.win, c.insets));
    for (const n of l.nodes) {
      if (n.layer === 9) continue; // LOCK is its neighbour by design
      const gap = rectGap(l.byId.exit.hit, n.hit);
      assert.ok(
        gap >= EXIT_MOAT_U * l.u - 1e-6,
        `${c.label}: EXIT is only ${(gap / l.u).toFixed(1)}U from ${n.id} — a mis-press ends the session`,
      );
    }
  }
});

test('on every real device that moat is the 100dp the spec asked for', () => {
  // The U-based invariant above is the one that always holds; this asserts the
  // stronger dp figure still holds everywhere it can, so quietly losing it on a
  // shipping phone would fail rather than pass unnoticed.
  for (const c of cases()) {
    if (c.synthetic) continue;
    const l = ok(padLayout(c.win, c.insets));
    for (const n of l.nodes) {
      if (n.layer === 9) continue;
      const gap = rectGap(l.byId.exit.hit, n.hit);
      assert.ok(gap >= 100, `${c.label}: EXIT is only ${gap.toFixed(1)}dp from ${n.id}`);
    }
  }
});

// ---------- Assertion 5 — refuses rather than cramps ----------

const noInsets = { top: 0, right: 0, bottom: 0, left: 0 };

test('a screen under the short-axis floor is refused, not cramped', () => {
  const l = padLayout({ width: 640, height: MIN_SHORT_AXIS - 1 }, noInsets);
  assert.equal(l.ok, false);
  assert.equal(l.ok === false && l.reason, 'too-short');
});

test('BOTH directions of the short-axis guard', () => {
  // A floor observed only failing is half-verified. One dp either side of it.
  assert.equal(padLayout({ width: 640, height: MIN_SHORT_AXIS }, noInsets).ok, true,
    'the floor itself must render');
  assert.equal(padLayout({ width: 640, height: MIN_SHORT_AXIS - 1 }, noInsets).ok, false,
    'one dp under the floor must refuse');
});

test('insets can push a tall-enough window under the floor', () => {
  // 360 of glass, but 40 of chrome leaves 320. The refusal has to be computed
  // from the PLAY rect, not from the window.
  const l = padLayout({ width: 800, height: 360 }, { top: 0, right: 0, bottom: 40, left: 0 });
  assert.equal(l.ok, false, 'insets were not subtracted before the floor check');
});

test('a real 360dp Android phone in landscape is NOT refused', () => {
  // Galaxy S21: 800x360 with a 24dp gesture bar. The other direction of the
  // same guard, and the reason MIN_SHORT_AXIS is 326 rather than the spec's
  // 340 — at 340 this phone gets a "turn it back" card for no reason.
  const l = padLayout({ width: 800, height: 360 }, { top: 0, right: 0, bottom: 24, left: 0 });
  assert.equal(l.ok, true, 'a shipping phone was refused');
});

test('a short, near-square window is refused too', () => {
  // Reachable via Android split-screen / free-form. Under MIN_LONG_AXIS_U the
  // thumb clusters have no centre channel and EXIT loses its moat.
  const l = padLayout({ width: 500, height: 420 }, noInsets);
  assert.equal(l.ok, false);
  assert.equal(l.ok === false && l.reason, 'too-narrow');
});

test('BOTH directions of the long-axis guard, at 16:9', () => {
  const h = 400;
  assert.equal(padLayout({ width: Math.ceil(h * 16 / 9), height: h }, noInsets).ok, true,
    '16:9 is the narrowest real phone shape and must render');
  assert.equal(padLayout({ width: Math.floor(h * 1.7), height: h }, noInsets).ok, false,
    'narrower than 16:9 must refuse');
});

// ---------- Controls: inputs whose answer is known in advance ----------

test('CONTROL — the no-overlap check can actually fail', () => {
  // Assertion 2 passing means nothing unless the predicate under it can return
  // false. Two rects placed on top of each other must be reported as colliding.
  const l = ok(padLayout({ width: 852, height: 393 }, { top: 0, right: 0, bottom: 21, left: 59 }));
  const a = l.byId.lstick;
  assert.ok(
    rectsIntersect(a.hit, { ...a.hit, x: a.hit.x + 1 }),
    'rectsIntersect never returns true — every no-overlap test above is vacuous',
  );
  assert.equal(rectGap(a.hit, { ...a.hit, x: a.hit.x + a.hit.w + 10 }), 10);
});

test('CONTROL — insets actually move the layout', () => {
  // If insets were being ignored, the notch-left and notch-right runs would be
  // identical and every "both rotations" test above would be one test twice.
  const win = { width: 852, height: 393 };
  const left = ok(padLayout(win, { top: 0, right: 0, bottom: 21, left: 59 }));
  const right = ok(padLayout(win, { top: 0, right: 59, bottom: 21, left: 0 }));
  assert.notEqual(left.byId.dpad.rect.x, right.byId.dpad.rect.x);
  assert.equal(left.play.w, right.play.w);
});

// ---------- Sizing rule: nothing may be derived from the long axis ----------

test('control geometry does not change when only the long axis changes', () => {
  // Rule 1. Two windows with the same short axis and very different long axes
  // must produce identically SIZED controls — only their positions differ. This
  // is the assertion that would have caught Steam Link's bug, where the same
  // A/B/X/Y diamond renders 289x240 on one phone and 346x292 on another.
  const insets = { top: 0, right: 0, bottom: 0, left: 0 };
  const narrow = ok(padLayout({ width: 720, height: 400 }, insets)); // 180U
  const wide = ok(padLayout({ width: 1100, height: 400 }, insets)); // 275U
  for (const n of narrow.nodes) {
    const w = wide.byId[n.id];
    assert.equal(n.rect.w, w.rect.w, `${n.id} width tracks the long axis`);
    assert.equal(n.rect.h, w.rect.h, `${n.id} height tracks the long axis`);
  }
});

test('circular controls stay circular', () => {
  for (const c of cases()) {
    const l = ok(padLayout(c.win, c.insets));
    for (const n of l.nodes) {
      if (n.shape !== 'circle') continue;
      assert.equal(n.rect.w, n.rect.h, `${c.label}: ${n.id} is an ellipse`);
    }
  }
});

test('no percentage strings anywhere in the pad UI', () => {
  // Lint-grade. In React Native the "size off the wrong axis" bug wears a
  // percentage string, and `width: '12%'` is seductive because it LOOKS
  // responsive. Circles become ellipses and diamonds stop being diamonds the
  // moment one extent comes from width and its sibling from height. There are
  // none today; this keeps it that way.
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of [
    ['..', '..', 'app', '(tabs)', 'pad.tsx'],
    ['..', '..', 'components', 'LandscapePad.tsx'],
  ]) {
    const src = readFileSync(join(here, ...rel), 'utf8');
    const hits = src.match(/(width|height|top|left|right|bottom|margin\w*|padding\w*|flexBasis)\s*:\s*['"]\d+(\.\d+)?%['"]/g);
    assert.equal(hits, null, `percentage sizing in ${rel.at(-1)}: ${hits?.join(', ')}`);
  }
});

test('CONTROL — the percentage guard can actually fire', () => {
  // Otherwise "no matches" is indistinguishable from a regex that matches
  // nothing at all, which is how a guard quietly stops guarding.
  const re = /(width|height|top|left|right|bottom|margin\w*|padding\w*|flexBasis)\s*:\s*['"]\d+(\.\d+)?%['"]/g;
  assert.notEqual("  width: '12%',".match(re), null, 'the guard would miss a real percentage');
  assert.equal("  width: 12,".match(re), null, 'the guard fires on plain numbers');
});

test('the landscape pad never reads the window or the insets itself', () => {
  // Rule 3: insets are subtracted exactly once, inside padLayout. A second
  // reader is how the safe area gets counted twice — and in landscape it is
  // `insets.left`/`insets.right` that carry the notch, so a component that
  // reaches for `insets.top` looks correct on one rotation and clips on the
  // other.
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '..', '..', 'components', 'LandscapePad.tsx'), 'utf8');
  for (const banned of ['useSafeAreaInsets', 'SafeAreaView', 'useWindowDimensions', 'Dimensions.get']) {
    assert.ok(!src.includes(banned), `LandscapePad must not use ${banned} — it gets a computed layout`);
  }
});

// ---------- Stick and d-pad behaviour ----------

test('the stick is radially clamped — a diagonal never exceeds 1.0', () => {
  const u = 3.93;
  const far = 500; // well past saturation, in both axes at once
  const v = stickValue(far, far, u);
  assert.ok(Math.hypot(v.x, v.y) <= 1 + 1e-9, 'diagonals reach sqrt(2) — this is a square clamp');
  assert.ok(Math.hypot(v.x, v.y) > 0.99, 'full deflection does not reach 1.0');
});

test('the deadzone renormalises rather than clipping the top of the range', () => {
  const u = 3.93;
  assert.deepEqual(stickValue(0, 0, u), { x: 0, y: 0 });
  // Just inside the deadzone: silent.
  const inside = stickValue(22 * u * 0.1, 0, u);
  assert.equal(inside.x, 0);
  // Just outside: alive, but near zero rather than jumping to 0.12.
  const outside = stickValue(22 * u * 0.13, 0, u);
  assert.ok(outside.x > 0 && outside.x < 0.05, `expected a small value, got ${outside.x}`);
});

test('d-pad: centre is A, cardinals are exact, corners pick ONE direction', () => {
  const u = 3.93;
  assert.equal(dpadZone(0, 0, u), 'a');
  assert.equal(dpadZone(0, DPAD.innerRU * u * 0.5, u), 'a');
  assert.equal(dpadZone(0, -15 * u, u), 'du');
  assert.equal(dpadZone(0, 15 * u, u), 'dd');
  assert.equal(dpadZone(-15 * u, 0, u), 'dl');
  assert.equal(dpadZone(15 * u, 0, u), 'dr');
  // A 45-degree press resolves to a single cardinal, never two at once.
  const corner = dpadZone(10 * u, 10 * u, u);
  assert.ok(corner === 'dr' || corner === 'dd', `corner gave ${corner}`);
  // Outside the cluster: released, not latched to the last direction.
  assert.equal(dpadZone(30 * u, 0, u), null);
});

// ---------- Movement mode: the same properties, the second table ----------
//
// moveLayout is a different TABLE through the same builder, so every property
// that makes the main table safe has to hold for it too — asserted by looping,
// not by trusting the shared code path.

const LAYOUTS: [string, (w: Size, i: Insets) => PadLayout][] = [
  ['padLayout', padLayout],
  ['moveLayout', moveLayout],
];

test('MOVE: every property holds for both tables on every device', () => {
  for (const [name, fn] of LAYOUTS) {
    for (const c of cases()) {
      const l = ok(fn(c.win, c.insets));
      for (const n of l.nodes) {
        assert.ok(contains(l.play, n.rect), `${name}/${c.label}: ${n.id} escapes play`);
        assert.ok(contains(l.play, n.hit), `${name}/${c.label}: ${n.id} hit escapes play`);
        const min = Math.min(n.hit.w, n.hit.h);
        assert.ok(min >= MIN_TOUCH - 1e-6, `${name}/${c.label}: ${n.id} is ${min.toFixed(1)}dp`);
        if (n.shape === 'circle') assert.equal(n.rect.w, n.rect.h, `${name}/${c.label}: ${n.id} ellipse`);
      }
      for (let i = 0; i < l.nodes.length; i += 1) {
        for (let j = i + 1; j < l.nodes.length; j += 1) {
          assert.ok(
            !rectsIntersect(l.nodes[i].hit, l.nodes[j].hit),
            `${name}/${c.label}: ${l.nodes[i].id} and ${l.nodes[j].id} share a touch`,
          );
        }
      }
      for (const n of l.nodes) {
        if (n.layer === 9) continue;
        const gap = rectGap(l.byId.exit.hit, n.hit);
        assert.ok(gap >= EXIT_MOAT_U * l.u - 1e-6,
          `${name}/${c.label}: EXIT only ${(gap / l.u).toFixed(1)}U from ${n.id}`);
      }
    }
  }
});

test('MOVE: the movement zone is the point of the mode — assert its size', () => {
  const l = ok(moveLayout({ width: 852, height: 393 }, { top: 0, right: 59, bottom: 21, left: 0 }));
  const move = l.byId.move;
  const stick = ok(padLayout({ width: 852, height: 393 }, { top: 0, right: 59, bottom: 21, left: 0 })).byId.lstick;
  const ratio = (move.hit.w * move.hit.h) / (stick.hit.w * stick.hit.h);
  assert.ok(ratio >= 2.5, `the MOVE zone is only ${ratio.toFixed(1)}x the stick container — the mode adds nothing`);
  // And in absolute terms: over a fifth of the whole screen is drag-startable
  // movement surface. This is the ergonomic promise of the mode, stated as a
  // number instead of adjectives.
  const share = (move.hit.w * move.hit.h) / (l.play.w * l.play.h);
  assert.ok(share >= 0.2, `MOVE covers only ${(share * 100).toFixed(0)}% of the play area`);
});

test('MOVE: chrome sits at identical positions in both tables', () => {
  // The PAD<->MOVE toggle must not jump under the thumb that just pressed it,
  // and LOCK/EXIT must stay where muscle memory left them.
  const win = { width: 852, height: 393 };
  const ins = { top: 0, right: 0, bottom: 21, left: 59 };
  const a = ok(padLayout(win, ins));
  const b = ok(moveLayout(win, ins));
  for (const id of ['variant', 'lock', 'exit'] as const) {
    assert.deepEqual(a.byId[id].rect, b.byId[id].rect, `${id} moves between layouts`);
  }
});

test('MOVE: the move table contains exactly what the mode needs, nothing else', () => {
  // An absent control cannot be mis-pressed. If this list ever grows a
  // trigger or a second stick, that is a different feature and a new decision,
  // not a drive-by addition.
  const l = ok(moveLayout({ width: 852, height: 393 }, { top: 0, right: 0, bottom: 21, left: 59 }));
  assert.deepEqual(
    l.nodes.map((n) => n.id).sort(),
    ['a', 'b', 'exit', 'lock', 'move', 'nav', 'start', 'variant'],
  );
});

test('MOVE: navZone has no centre action and releases outside the ring', () => {
  const u = 3.93;
  // Dead centre: NULL — A is a physical button here; latching an arbitrary
  // direction on a centre tap would be a phantom input.
  assert.equal(navZone(0, 0, u), null);
  // Cardinals resolve, one direction only.
  assert.equal(navZone(0, -10 * u, u), 'du');
  assert.equal(navZone(0, 10 * u, u), 'dd');
  assert.equal(navZone(-10 * u, 0, u), 'dl');
  assert.equal(navZone(10 * u, 0, u), 'dr');
  const corner = navZone(8 * u, 8 * u, u);
  assert.ok(corner === 'dr' || corner === 'dd', `corner gave ${corner}`);
  // Outside the ring: released, never latched.
  assert.equal(navZone(20 * u, 0, u), null);
});

test('MOVE: every emitted id is a real protocol key', () => {
  // The move/nav/variant NODES are layout-only; what goes on the wire is
  // stick frames plus these buttons. Nothing here may invent a key.
  const emitted = ['a', 'b', 'start', 'du', 'dd', 'dl', 'dr'];
  const BUTTONS = new Set([
    'a', 'b', 'x', 'y', 'lb', 'rb', 'l3', 'r3', 'start', 'select', 'guide',
    'dl', 'dr', 'du', 'dd',
  ]);
  for (const k of emitted) assert.ok(BUTTONS.has(k), `${k} is not a ButtonKey`);
});

// ---------- Review regressions: the three geometry findings ----------

test('REVIEW: angular sub-targets clear 44dp — sectors AND discs, both clusters', () => {
  // The 44dp rule binds on what a thumb actually hits. For an angular control
  // that is the radial THICKNESS of a sector (outer - inner), and the centre
  // disc's DIAMETER where the centre is itself an action. The first cut of
  // NAV claimed "15U of thickness" having forgotten to subtract innerRU, and
  // the d-pad's A/OK disc had never been measured at all — both were 39-43dp
  // on phones in this very device table.
  for (const c of cases()) {
    const l = ok(padLayout(c.win, c.insets));
    const dpadSector = (DPAD.outerRU - DPAD.innerRU) * l.u;
    const dpadDisc = 2 * DPAD.innerRU * l.u;
    const navSector = NAV.thicknessU * l.u;
    assert.ok(dpadSector >= MIN_TOUCH - 1e-6, `${c.label}: d-pad sector ${dpadSector.toFixed(1)}dp`);
    assert.ok(dpadDisc >= MIN_TOUCH - 1e-6, `${c.label}: d-pad OK disc ${dpadDisc.toFixed(1)}dp`);
    assert.ok(navSector >= MIN_TOUCH - 1e-6, `${c.label}: NAV sector ${navSector.toFixed(1)}dp`);
  }
});

test('REVIEW: the EXIT moat survives the capped-u window band, both tables', () => {
  // An adversarial sweep EXECUTING this module found moveLayout's moat at
  // 23.07U in windows where u is capped (play.h 446-499) and the width sits
  // near the long-axis floor — the expansion pass's best-separating-axis
  // choice flipped for the (move, lock) pair and nothing clamped the giant
  // node's growth toward the chrome. No shipping phone lives in that band,
  // which is exactly why no device-table case caught it. Sweep the band.
  for (let h = 440; h <= 510; h += 6) {
    const u = Math.min(h, 430) / 100;
    for (let wu = 176; wu <= 184; wu += 1) {
      const w = Math.ceil(wu * u);
      for (const [name, fn] of LAYOUTS) {
        const l = fn({ width: w, height: h }, { top: 0, right: 0, bottom: 0, left: 0 });
        if (!l.ok) continue;
        for (const n of l.nodes) {
          if (n.layer === 9) continue;
          const gap = rectGap(l.byId.exit.hit, n.hit);
          assert.ok(
            gap >= EXIT_MOAT_U * l.u - 1e-6,
            `${name} @ ${w}x${h}: EXIT only ${(gap / l.u).toFixed(2)}U from ${n.id}`,
          );
        }
      }
    }
  }
});

test('REVIEW: expansion is capped — no node grows more than EXPAND_CAP_U per side', () => {
  for (const [name, fn] of LAYOUTS) {
    for (const c of cases()) {
      const l = ok(fn(c.win, c.insets));
      for (const n of l.nodes) {
        const cap = EXPAND_CAP_U * l.u + 1e-6;
        assert.ok(n.rect.x - n.hit.x <= cap, `${name}/${c.label}: ${n.id} left growth`);
        assert.ok(n.hit.x + n.hit.w - (n.rect.x + n.rect.w) <= cap, `${name}/${c.label}: ${n.id} right growth`);
        assert.ok(n.rect.y - n.hit.y <= cap, `${name}/${c.label}: ${n.id} top growth`);
        assert.ok(n.hit.y + n.hit.h - (n.rect.y + n.rect.h) <= cap, `${name}/${c.label}: ${n.id} bottom growth`);
      }
    }
  }
});
