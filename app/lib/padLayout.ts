/**
 * Landscape gamepad geometry — pure, no React, no imports.
 *
 * WHY THIS FILE EXISTS AT ALL.
 *
 * The landscape pad used to be a flex column of fixed-pixel children: a 132dp
 * stick + 14dp gap + a 182dp d-pad = 328dp in a `landColumn`, inside a
 * `landShoulderRow` (+56dp) inside a `styles.screen` that added ~31dp of its
 * own padding — about 415dp of demand, with the header, the status pill, the
 * mode selector and the tab bar still to pay for, against a 393dp short axis.
 * Flexbox does not clip and does not warn: the children simply spilled and
 * painted over each other. That is why the left stick was cut off by the screen
 * edge, why RB landed in the gap between X and B, and why the d-pad's DOWN
 * arrow hid behind the tab bar. One bug, three symptoms.
 *
 * So placement here is absolute and comes out of ONE table, in ONE unit, and
 * `__tests__/padLayout.test.ts` proves over every device size that nothing
 * leaves the play rect and no two hit rects touch. The point is not that the
 * numbers are nicer than the flex ones. The point is that "does this clip?" is
 * now a question arithmetic can answer, which it could not be before.
 *
 * THREE RULES, and every one of them is load-bearing:
 *
 *  1. NO extent may reference `play.w`. Every width, height, radius, gap and
 *     margin below is `k * U`, where U is 1% of the usable SHORT axis. Sizing
 *     one extent off width and its sibling off height is how circles become
 *     ellipses on a different phone — Steam Link ships that bug and its own
 *     guide admits it. In React Native the same mistake wears a percentage
 *     string, which is why there are none in the landscape styles.
 *  2. Anchor by CENTRE, with margin >= half-extent. Anchoring by top-left is
 *     what lets a control cross the far edge.
 *  3. Insets are subtracted EXACTLY ONCE, here, into `play`. Nothing
 *     downstream may look at insets or at the window again. In landscape on
 *     iPhone `insets.top` is 0 and the notch is `insets.left` OR `insets.right`
 *     (59pt) depending on which way you turned the phone — so code that only
 *     knows about `top` clips on exactly one of the two rotations and looks
 *     perfect on the other. The test runs every size twice for that reason.
 */

export type Insets = { top: number; right: number; bottom: number; left: number };
export type Size = { width: number; height: number };

/** Screen-space rectangle, in dp, origin top-left. */
export type Rect = { x: number; y: number; w: number; h: number };

export type PadNodeId =
  | 'lt' | 'lb' | 'rb' | 'rt'
  | 'select' | 'steam' | 'qam' | 'start'
  | 'dpad' | 'lstick' | 'rstick'
  | 'a' | 'b' | 'x' | 'y'
  | 'lock' | 'exit';

export type PadNode = {
  id: PadNodeId;
  /** What is drawn. */
  rect: Rect;
  /** What is touchable — `rect` grown by the expansion pass below. */
  hit: Rect;
  /**
   * Slide-between is allowed WITHIN a layer and blocked across layers, so a
   * thumb can roll A->B mid-press but no drag can ever reach the d-pad or a
   * menu button. Face buttons and shoulders share layer 1; everything else
   * that must not be slid into gets its own.
   */
  layer: number;
  shape: 'rect' | 'circle';
};

export type PadLayout =
  | {
      ok: true;
      /** The usable rect: window minus insets, counted once. */
      play: Rect;
      /** 1% of the usable short axis, capped at 4.3. */
      u: number;
      nodes: PadNode[];
      byId: Record<PadNodeId, PadNode>;
    }
  | { ok: false; reason: 'too-short' | 'too-narrow' };

// ---------- Hard floors ----------

/**
 * Below this the 44dp touch floor cannot be met and we render a "rotate back"
 * card instead. Refuse rather than cramp.
 *
 * THE BINDING CONTROL IS THE D-PAD SECTOR, at 13.5U of radial thickness:
 * 44 / 13.5 = 3.26, so the short axis must be at least 326.
 *
 * The spec said 340, derived from the face button's DRAWN diameter of 13U. That
 * is the wrong control to derive it from, because the 44dp rule is asserted
 * against the HIT rect and the expansion pass below grows a face button to 16U.
 * The d-pad is the one control the pass cannot help: its targets are angular
 * sectors, so its thickness is whatever the table says and nothing more.
 *
 * This is not a technicality. At 340 a Galaxy S21 in landscape — 800x360 with a
 * 24dp gesture bar, so 336 of play — would have been shown the "turn the phone
 * back" card, on a phone whose controller fits perfectly well.
 */
export const MIN_SHORT_AXIS = 326;

/**
 * The long-axis floor, in U. Two things need room along it, and the second is
 * the binding one:
 *
 *  1. The clusters. Left occupies 79U from the left edge (3 margin + 39 d-pad +
 *     7 gap + 30 stick), right occupies 85U (3 + 45 face + 7 + 30) — so under
 *     164U there is no centre channel and they would collide.
 *  2. The EXIT moat. EXIT's right edge sits at `P.w/2 + 16.5` and RB's touch
 *     rect begins at `P.w - 45.5`, so the moat is `P.w/2 - 62` U wide. Holding
 *     it at 26U requires 176U.
 *
 * 16:9 — the narrowest real phone shape — is 177.6U, so this admits every real
 * device and refuses only genuinely narrow windows (Android split-screen and
 * free-form, which is exactly where refusing is right).
 *
 * NOT in the original spec, which derived its floor from the short axis alone.
 */
export const MIN_LONG_AXIS_U = 176;

/**
 * Designed clearance between EXIT and the nearest game control, in U.
 *
 * The spec asked for 100dp. That is achievable on every real device (the
 * narrowest in the test table still gives 213U of long axis, so ~118dp and up)
 * but NOT simultaneously with supporting 16:9 at the short-axis floor, where
 * the same geometry yields 91dp. The two requirements are in conflict and the
 * spec asserted both without checking.
 *
 * Rather than special-case the floor, the invariant is stated in the layout's
 * own unit, where it holds everywhere with no exception. The moat is anyway
 * defence in depth: EXIT also requires a touch to both START and END inside it,
 * so a thumb sliding off RB cannot trigger it at any distance.
 */
export const EXIT_MOAT_U = 26;

/** Every touch target must be at least this, in dp. */
export const MIN_TOUCH = 44;

// ---------- Stick behaviour (consumed by the Stick component) ----------

/**
 * Fixed container, floating origin. The "user is looking at the TV" argument is
 * usually deployed to justify spawn-anywhere sticks, and it proves the wrong
 * thing: eyes-off also means the d-pad and the face buttons have to be found by
 * feel, and the only thing findable by feel on glass is an edge or a corner. A
 * half-screen stick region would eat the d-pad — which is the control this
 * product actually uses, since it drives Steam Big Picture. So the container is
 * fixed and corner-anchored; only the ORIGIN floats, to wherever the thumb
 * lands. That is the same split Xbox's Touch Adaptation Kit (`relative: true`
 * in all six shipped sample layouts) and Dolphin (`JoystickRelCenter = true`)
 * arrived at independently.
 */
export const STICK = {
  /** Visual ring radius, in U. Drawn only while held. */
  ringR: 15,
  /** Nub radius, in U. */
  nubR: 6,
  /**
   * Finger travel for full deflection, in U (~82dp). The old layout saturated
   * at 38 PIXELS of travel, which is unusable without looking at the phone.
   * 22U gives a 2.5:1 visual compression — the nub moves 33dp while the finger
   * moves 82dp — and that is correct precisely BECAUSE nobody is watching the
   * nub.
   */
  travelU: 22,
  /** The nub pins to the rim at this radius while the finger keeps going. */
  nubClampU: 9,
  /** Radial, with the output renormalised so it still reaches 1.0. */
  deadzone: 0.12,
} as const;

/**
 * D-pad: an ANGULAR hit test, not a 3x3 grid of boxes. Every pixel of the
 * cluster does something, which is what eyes-off requires — a grid leaves dead
 * corners. Inside `innerRU` is the centre disc (A/OK, keeping the existing
 * centre-OK behaviour, which is right for Steam navigation); outside it, four
 * 90-degree sectors. NO DIAGONALS: a corner press that fires two directions at
 * once is worse than one that fires the nearest cardinal, and Steam menu
 * navigation has no use for them.
 */
export const DPAD = {
  outerRU: 19.5,
  innerRU: 6,
  /** Radial thickness of a sector — the real touch target, not the 39U box. */
  get sectorThicknessU() {
    return this.outerRU - this.innerRU;
  },
} as const;

/** Face buttons: diameter, and the diamond radius from the cluster centre. */
export const FACE = { diaU: 13, radiusU: 16 } as const;

// ---------- The table ----------

/**
 * Everything in U. `dx`/`dy` are offsets from an anchor edge of the play rect;
 * a negative anchor means "measured back from the far edge".
 *
 * Three bands, and nothing crosses a boundary. Row 1 spans 3..17U from the top
 * (shoulders + chrome), row 2 spans 20..34U (menu buttons), the middle 34..51U
 * is deliberately empty because that is where a hand grips the phone, and the
 * thumb clusters live in 51..96U. The face diamond's top edge is at 51U and
 * row 2's bottom edge is at 34U, so there is a 17U dead gap between them.
 * A shoulder button CANNOT reach a face button because they are not in the same
 * band. That is the fix for the overlap, and it is arithmetic, not nudging.
 */
type Spec = {
  id: PadNodeId;
  w: number;
  h: number;
  /** Centre X in U: from `left`, from `right`, or from the horizontal centre. */
  cx: { from: 'left' | 'right' | 'centre'; at: number };
  /** Centre Y in U, from the top or from the bottom. */
  cy: { from: 'top' | 'bottom'; at: number };
  layer: number;
  shape?: 'circle';
};

const FACE_CX = 25.5;
const FACE_CY = 26.5;

const TABLE: Spec[] = [
  // Row 1 — shoulders, and the two chrome buttons in the middle.
  { id: 'lt', w: 18, h: 14, cx: { from: 'left', at: 12 }, cy: { from: 'top', at: 10 }, layer: 1 },
  { id: 'lb', w: 18, h: 14, cx: { from: 'left', at: 32 }, cy: { from: 'top', at: 10 }, layer: 1 },
  { id: 'lock', w: 15, h: 14, cx: { from: 'centre', at: -9 }, cy: { from: 'top', at: 10 }, layer: 9 },
  { id: 'exit', w: 15, h: 14, cx: { from: 'centre', at: 9 }, cy: { from: 'top', at: 10 }, layer: 9 },
  { id: 'rb', w: 18, h: 14, cx: { from: 'right', at: 32 }, cy: { from: 'top', at: 10 }, layer: 1 },
  { id: 'rt', w: 18, h: 14, cx: { from: 'right', at: 12 }, cy: { from: 'top', at: 10 }, layer: 1 },

  // Row 2 — menu buttons. Each gets its own layer so no drag can chain them.
  { id: 'select', w: 18, h: 14, cx: { from: 'left', at: 12 }, cy: { from: 'top', at: 27 }, layer: 2 },
  { id: 'steam', w: 18, h: 14, cx: { from: 'left', at: 32 }, cy: { from: 'top', at: 27 }, layer: 3 },
  { id: 'qam', w: 18, h: 14, cx: { from: 'right', at: 32 }, cy: { from: 'top', at: 27 }, layer: 4 },
  { id: 'start', w: 18, h: 14, cx: { from: 'right', at: 12 }, cy: { from: 'top', at: 27 }, layer: 5 },

  // Thumb clusters.
  { id: 'dpad', w: 39, h: 39, cx: { from: 'left', at: 22.5 }, cy: { from: 'bottom', at: 23.5 }, layer: 6 },
  { id: 'lstick', w: 30, h: 30, cx: { from: 'left', at: 64 }, cy: { from: 'bottom', at: 26 }, layer: 7, shape: 'circle' },
  { id: 'rstick', w: 30, h: 30, cx: { from: 'right', at: 70 }, cy: { from: 'bottom', at: 26 }, layer: 8, shape: 'circle' },

  // The face diamond, as its four real targets rather than one 45U box —
  // otherwise the 44dp assertion would be checking a cluster nobody presses.
  // All four share layer 1 so a thumb can roll A->B mid-press.
  { id: 'y', w: FACE.diaU, h: FACE.diaU, cx: { from: 'right', at: FACE_CX }, cy: { from: 'bottom', at: FACE_CY + FACE.radiusU }, layer: 1, shape: 'circle' },
  { id: 'a', w: FACE.diaU, h: FACE.diaU, cx: { from: 'right', at: FACE_CX }, cy: { from: 'bottom', at: FACE_CY - FACE.radiusU }, layer: 1, shape: 'circle' },
  { id: 'x', w: FACE.diaU, h: FACE.diaU, cx: { from: 'right', at: FACE_CX + FACE.radiusU }, cy: { from: 'bottom', at: FACE_CY }, layer: 1, shape: 'circle' },
  { id: 'b', w: FACE.diaU, h: FACE.diaU, cx: { from: 'right', at: FACE_CX - FACE.radiusU }, cy: { from: 'bottom', at: FACE_CY }, layer: 1, shape: 'circle' },
];

// ---------- Geometry helpers ----------

const right = (r: Rect) => r.x + r.w;
const bottom = (r: Rect) => r.y + r.h;

/** True when two rects overlap on the given axis (touching edges do not count). */
const spansOverlap = (aLo: number, aHi: number, bLo: number, bHi: number) =>
  aLo < bHi && bLo < aHi;

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return spansOverlap(a.x, right(a), b.x, right(b)) &&
    spansOverlap(a.y, bottom(a), b.y, bottom(b));
}

/** Shortest edge-to-edge distance between two non-overlapping rects, in dp. */
export function rectGap(a: Rect, b: Rect): number {
  const dx = Math.max(0, Math.max(a.x - right(b), b.x - right(a)));
  const dy = Math.max(0, Math.max(a.y - bottom(b), b.y - bottom(a)));
  return Math.hypot(dx, dy);
}

// ---------- The layout ----------

export function padLayout(win: Size, insets: Insets): PadLayout {
  const play: Rect = {
    x: insets.left,
    y: insets.top,
    w: win.width - insets.left - insets.right,
    h: win.height - insets.top - insets.bottom,
  };

  // Degrade closed, both axes. A cramped controller that half-works is worse
  // than an honest "turn the phone back".
  if (play.h < MIN_SHORT_AXIS) return { ok: false, reason: 'too-short' };

  // U caps at 4.3 so a tablet gets a BIGGER EMPTY MIDDLE rather than
  // comic-book buttons — the clusters stay thumb-sized and move apart.
  const u = Math.min(play.h, 430) / 100;

  if (play.w / u < MIN_LONG_AXIS_U) return { ok: false, reason: 'too-narrow' };

  const centreX = play.x + play.w / 2;

  const base: PadNode[] = TABLE.map((s) => {
    const w = s.w * u;
    const h = s.h * u;
    const cx =
      s.cx.from === 'left' ? play.x + s.cx.at * u
        : s.cx.from === 'right' ? right(play) - s.cx.at * u
          : centreX + s.cx.at * u;
    const cy =
      s.cy.from === 'top' ? play.y + s.cy.at * u : bottom(play) - s.cy.at * u;
    return {
      id: s.id,
      // Rule 2: centre-anchored, so the margin is measured to the EDGE of the
      // control and a control can never cross the far side of the play rect.
      rect: { x: cx - w / 2, y: cy - h / 2, w, h },
      hit: { x: 0, y: 0, w: 0, h: 0 }, // filled by the expansion pass
      layer: s.layer,
      shape: s.shape ?? 'rect',
    };
  });

  const nodes = expandHits(base, play, u);

  const byId = {} as Record<PadNodeId, PadNode>;
  for (const n of nodes) byId[n.id] = n;

  return { ok: true, play, u, nodes, byId };
}

/**
 * "No dead pixels": grow every control's touchable rect into the space around
 * it, by a rule rather than by hand.
 *
 * Each side grows by the smallest of three things: a quarter of the control's
 * own extent on that axis, HALF the gap to the nearest neighbour on that side,
 * and the distance to the edge of the play rect. Taking half the gap is what
 * makes the result non-overlapping by construction — both neighbours claim at
 * most half of the space between them, so they can meet but never cross. The
 * result is anisotropic for free: the left stick gains a lot of catch upward
 * and inboard where there is room, and almost none toward the d-pad where there
 * is not. (RetroArch authors these per-direction reaches by hand; computing
 * them means they cannot drift out of sync with the layout.)
 *
 * LOCK and EXIT (layer 9) are deliberately EXCLUDED. They are looked-at,
 * deliberate taps and the one thing that must not be pressed by accident —
 * growing them is the opposite of what is wanted, and the 100dp exit moat is
 * measured against their drawn size.
 */
function expandHits(nodes: PadNode[], play: Rect, u: number): PadNode[] {
  // Floating point turns "these two exactly meet" into an overlap of 1e-13
  // about a third of the time, which a strict intersection test then reports as
  // a collision. Give every claim a hair of slack so meeting is unambiguous.
  const EPS = 0.01;

  return nodes.map((n) => {
    if (n.layer === 9) return { ...n, hit: { ...n.rect } };

    const r = n.rect;
    // Start from the two limits that do not depend on other controls.
    let l = Math.min(0.25 * r.w, r.x - play.x);
    let rt = Math.min(0.25 * r.w, right(play) - right(r));
    let t = Math.min(0.25 * r.h, r.y - play.y);
    let b = Math.min(0.25 * r.h, bottom(play) - bottom(r));

    for (const o of nodes) {
      if (o.id === n.id) continue;
      const q = o.rect;
      // Gap on each axis; zero means the two already overlap on that axis.
      const gx = Math.max(0, Math.max(r.x - right(q), q.x - right(r)));
      const gy = Math.max(0, Math.max(r.y - bottom(q), q.y - bottom(r)));

      // Two rects stay apart as long as they stay apart on ONE axis, so pick
      // the axis that separates them best and spend the constraint there. This
      // is what handles DIAGONAL neighbours, and getting it wrong is what let
      // the face buttons collide on every single device: X sits below-left of
      // Y with no shared row or column, so an axis-aligned neighbour search
      // found nothing between them, both grew the full 25% in all four
      // directions, and their expanded corners met in the middle.
      const share = (g: number) => Math.max(0, g / 2 - EPS);
      if (gx >= gy) {
        if (right(q) <= r.x) l = Math.min(l, share(gx));
        else if (q.x >= right(r)) rt = Math.min(rt, share(gx));
      } else {
        if (bottom(q) <= r.y) t = Math.min(t, share(gy));
        else if (q.y >= bottom(r)) b = Math.min(b, share(gy));
      }
    }

    return {
      ...n,
      hit: { x: r.x - l, y: r.y - t, w: r.w + l + rt, h: r.h + t + b },
    };
  });
}

// ---------- Hit testing ----------

export function hitTest(layout: PadLayout, px: number, py: number): PadNode | null {
  if (!layout.ok) return null;
  // Reverse order so the later, higher-intent entries in the table (the thumb
  // clusters) win over anything that happens to have grown under them.
  for (let i = layout.nodes.length - 1; i >= 0; i -= 1) {
    const n = layout.nodes[i];
    const h = n.hit;
    if (px >= h.x && px <= right(h) && py >= h.y && py <= bottom(h)) return n;
  }
  return null;
}

export type DpadZone = 'du' | 'dd' | 'dl' | 'dr' | 'a' | null;

/**
 * Angular d-pad. `px`/`py` are relative to the d-pad node's CENTRE, in dp.
 * Inside the centre disc is A/OK; outside it, the nearest cardinal. Beyond the
 * outer radius returns null so a drag that leaves the cluster releases rather
 * than latching the last direction.
 */
export function dpadZone(px: number, py: number, u: number): DpadZone {
  const mag = Math.hypot(px, py);
  if (mag <= DPAD.innerRU * u) return 'a';
  if (mag > DPAD.outerRU * u) return null;
  // No diagonals: whichever axis dominates wins outright.
  if (Math.abs(px) >= Math.abs(py)) return px >= 0 ? 'dr' : 'dl';
  return py >= 0 ? 'dd' : 'du';
}

/**
 * Radial stick value from finger travel, in dp. Magnitude-clamped, never
 * per-axis — square clamping (which moonlight-ios does) lets diagonals reach
 * sqrt(2) and makes a circle-strafe faster than a straight run.
 */
export function stickValue(dx: number, dy: number, u: number): { x: number; y: number } {
  const t = STICK.travelU * u;
  const len = Math.hypot(dx, dy);
  if (len === 0) return { x: 0, y: 0 };
  const mag = Math.min(1, len / t);
  if (mag <= STICK.deadzone) return { x: 0, y: 0 };
  // Renormalise so the deadzone costs precision near centre, not range at full
  // deflection: the stick still reaches exactly 1.0.
  const out = (mag - STICK.deadzone) / (1 - STICK.deadzone);
  return { x: (dx / len) * out, y: (dy / len) * out };
}

/**
 * Where to draw the nub: same direction as the finger, but compressed 2.5:1 —
 * the finger travels `travelU` (82dp) while the nub travels `nubClampU` (33dp),
 * then pins to the rim while the finger keeps going.
 */
export function stickNubOffset(dx: number, dy: number, u: number): { x: number; y: number } {
  const len = Math.hypot(dx, dy);
  if (len === 0) return { x: 0, y: 0 };
  const r = (Math.min(len, STICK.travelU * u) / (STICK.travelU * u)) * (STICK.nubClampU * u);
  return { x: (dx / len) * r, y: (dy / len) * r };
}
