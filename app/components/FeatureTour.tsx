/**
 * Spotlight tour, shown once after the first box is paired.
 *
 * Dims the screen, cuts a hole over the thing being described, and says what it
 * is. The geometry lives in lib/tour.ts and is tested there — a hole over the
 * wrong thing points confidently at the wrong thing, which is worse than no tour
 * at all.
 *
 * TWO KINDS OF TARGET. A step with an `anchor` spotlights a real element inside
 * the screen (the CPU temp card, the filter button) by measuring it; a step
 * without one falls back to spotlighting the tab-bar icon, which is all this
 * tour could originally do.
 *
 * A STEP WHOSE ANCHOR IS NOT ON SCREEN IS SKIPPED, not shown. Screens register
 * anchors only for what they actually rendered, and most of this app is
 * probe-and-appear, so "not registered" means "this box/library/build does not
 * have it". The tour used to explain the library filter to people whose library
 * was too small to show one. See hooks/useTourAnchor.ts.
 *
 * NO MASKING LIBRARY: React Native has no cross-platform cutout, so the dim is
 * four Views around the target. No dependency, no SVG, and it behaves the same
 * on both platforms.
 *
 * THE SPOTLIT ELEMENT STAYS TAPPABLE. The dim panels swallow touches so a stray
 * tap cannot fire something behind the overlay, but the hole itself is left
 * alone — a tour that says "your games live here" and then blocks the tab is a
 * lecture, not a tour.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import React from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { measureAnchor, screenHasAnchors, scrollTabBy, subscribeAnchorLayout } from '@/hooks/useTourAnchor';
import { hapticLight } from '@/lib/haptics';
import {
  anchorHole,
  cardSlot,
  currentStep,
  dimRects,
  scrollDeltaFor,
  spotlightRect,
  stepLabel,
  type Rect,
  type TourState,
} from '@/lib/tour';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

/** Tab-bar height without the safe-area inset; matches the router's default. */
const TAB_BAR_H = 49;
/** Roughly the sticky header (box picker row) — the top of the usable band. */
const HEADER_H = 52;
/** Breathing room around a measured element. */
const ANCHOR_PAD = 6;
/** Gap between the hole and the explanation card. */
const CARD_GAP = 14;

/** How long to keep asking for an anchor before giving up on the step.
 *  A tab mounts lazily on first focus and the default skin runs a 260ms
 *  staggered entrance, so the target genuinely is not measurable for the first
 *  few hundred milliseconds after the tour navigates to it. */
const RETRY_EVERY_MS = 100;
/** 4s, not 1.6s. Measured on a real box: a tour that starts right after pairing
 *  reaches Console BEFORE the first status poll answers, and the vitals cards
 *  are gated on that payload — so the three best steps in the tour skipped
 *  themselves and the walkthrough opened on step 4. The budget has to outlast a
 *  first poll, not just a layout pass. The cost of being generous is that a
 *  genuinely absent element takes this long to skip, which nobody sees as
 *  anything but a slightly late card. */
const RETRY_FOR_MS = 4000;
/** Budget once the target's SCREEN is up and other anchors on it have reported.
 *  At that point a missing anchor is missing, not late, so waiting the full
 *  budget just makes a skipped step look like the app froze — a user watching
 *  the tour reported a dead pause between steps 7 and 8, and 12 and 13, which
 *  were precisely the two steps skipped on their box. */
const READY_GIVE_UP_MS = 700;
/** Let a scroll settle before trusting the second measurement. */
const SCROLL_SETTLE_MS = 380;
/** How many times one step may chase a moving anchor before giving up. */
const MAX_SCROLL_CORRECTIONS = 3;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function FeatureTour({
  state,
  tabOrder,
  onNext,
  onSkip,
}: {
  state: TourState;
  /** Route names in the order the tab bar renders them — the tour asks this
   *  rather than assuming, because caps and remote-only mode change both the
   *  count and the positions. */
  tabOrder: string[];
  onNext: () => void;
  onSkip: () => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  const step = currentStep(state);
  const idx = step ? tabOrder.indexOf(step.tab) : -1;

  const [hole, setHole] = React.useState<Rect | null>(null);
  const [cardH, setCardH] = React.useState(150);
  /** Bumped on every step change so a slow measurement from the PREVIOUS step
   *  cannot land after the user has already moved on and draw a hole over the
   *  wrong element. */
  const runId = React.useRef(0);
  /** Scroll corrections spent on the CURRENT step; reset when the step changes.
   *  Bounds the chase-the-anchor loop below. */
  const corrections = React.useRef(0);

  const bandTop = insets.top + HEADER_H;
  const bandBottom = height - insets.bottom - TAB_BAR_H;
  const anchor = step?.anchor;
  const tab = step?.tab;
  const order = tabOrder.join(',');

  React.useEffect(() => {
    const mine = ++runId.current;
    const live = () => runId.current === mine;
    corrections.current = 0;
    setHole(null);

    if (!step) return;

    // A tab this build does not show — remote-only mode, or a box whose caps
    // say it has no gamepad. Rendering nothing here USED TO WEDGE THE TOUR: no
    // card meant no way to press GOT IT, so it stayed "visible" forever,
    // resumed at the same dead step every launch, and (because the landing
    // redirect is guarded on tour.visible) quietly disabled that too. Skip it,
    // for the same reason a missing anchor skips.
    if (idx < 0) {
      void (async () => {
        // Caps arrive after the first render, so a tab can be legitimately
        // missing for a moment. Give it the same grace as a slow anchor rather
        // than skipping steps on a cold start.
        await delay(RETRY_FOR_MS);
        if (live()) onNext();
      })();
      return;
    }

    // No anchor: the tab-bar icon, computed arithmetically, no measuring.
    if (!anchor) {
      setHole(spotlightRect(width, height, TAB_BAR_H, tabOrder.length, idx, insets.bottom));
      return;
    }

    void (async () => {
      let rect: Rect | null = null;
      for (let waited = 0; ; waited += RETRY_EVERY_MS) {
        if (!live()) return;
        rect = await measureAnchor(anchor);
        if (rect) break;
        // Stop early once the screen itself is clearly up: a sibling anchor on
        // the same screen has registered, so this one is absent by design (a
        // filter that needs 8+ games, an action group this box does not report)
        // and no amount of waiting will conjure it.
        const budget = screenHasAnchors(anchor) ? READY_GIVE_UP_MS : RETRY_FOR_MS;
        if (waited >= budget) break;
        await delay(RETRY_EVERY_MS);
      }
      if (!live()) return;

      // Nothing to point at: this build, box or library does not have it.
      if (!rect) {
        onNext();
        return;
      }

      const dy = scrollDeltaFor(rect, bandTop, bandBottom);
      if (dy !== 0 && scrollTabBy(tab as string, dy)) {
        await delay(SCROLL_SETTLE_MS);
        if (!live()) return;
        const settled = await measureAnchor(anchor);
        if (settled) rect = settled;
      }
      if (!live()) return;
      setHole(anchorHole(rect, ANCHOR_PAD, width, height));
    })();
    // `order` covers a tab-bar reshuffle (caps arriving, remote-only flipping).
  }, [state.step, anchor, tab, idx, order, width, height, insets.bottom]);

  // Follow the anchor if it MOVES after we measured it. The screen keeps
  // filling in — downloads appear, a host list expands, art loads — and
  // everything below slides down. Without this the ring stays where the element
  // was when the step opened; on Android that put it around the queued and
  // stream sections while the card talked about the library.
  //
  // Deliberately only updates the hole: it must never re-run the skip logic, or
  // a transient zero-height layout mid-reflow would advance the step.
  React.useEffect(() => {
    if (!anchor || !hole) return;
    return subscribeAnchorLayout((movedId) => {
      if (movedId !== anchor) return;
      void (async () => {
        let r = await measureAnchor(anchor);
        if (!r) return;
        // If the shift pushed it out of the visible band, chase it — measuring
        // alone would leave the hole off-screen and the user staring at a fully
        // dimmed page with no spotlight anywhere. Seen on Android, where a long
        // "Stream from PC" list pushed the library grid below the fold after the
        // step had already scrolled to it.
        //
        // BOUNDED. Each correction can trigger another layout, and an unbounded
        // chase would be a scroll loop the user cannot escape.
        if (corrections.current < MAX_SCROLL_CORRECTIONS) {
          const dy = scrollDeltaFor(r, bandTop, bandBottom);
          if (dy !== 0 && scrollTabBy(tab as string, dy)) {
            corrections.current += 1;
            await delay(SCROLL_SETTLE_MS);
            const settled = await measureAnchor(anchor);
            if (settled) r = settled;
          }
        }
        setHole((prev) => {
          const next = anchorHole(r, ANCHOR_PAD, width, height);
          // Ignore sub-pixel churn so a settling layout cannot cause a render
          // loop; onLayout can fire repeatedly with effectively the same box.
          if (
            prev &&
            Math.abs(prev.x - next.x) < 1 &&
            Math.abs(prev.y - next.y) < 1 &&
            Math.abs(prev.width - next.width) < 1 &&
            Math.abs(prev.height - next.height) < 1
          ) {
            return prev;
          }
          return next;
        });
      })();
    });
  }, [anchor, hole, width, height]);

  if (!step) return null;
  // A tab this build does not show (remote-only hides the box tabs) has nothing
  // to point at.
  if (idx < 0) return null;
  // Still measuring, or skipping: draw nothing rather than flash a hole in the
  // wrong place for a frame.
  if (!hole) return null;

  const panels = dimRects(width, height, hole);
  const slot = cardSlot(hole, height, cardH, CARD_GAP, insets.top + 8, insets.bottom + 8);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {panels.map((r, i) => (
        <Pressable
          key={i}
          // Swallow taps on the dimmed area, but do not advance: an accidental
          // tap while reading should not skip the step.
          onPress={() => {}}
          style={[styles.dim, { left: r.x, top: r.y, width: r.width, height: r.height }]}
        />
      ))}

      {/* Ring around the live element. pointerEvents none so what is underneath
          stays tappable — see the header note. */}
      <View
        pointerEvents="none"
        style={[
          styles.ring,
          {
            // Clamped so a ring on the first or last tab stays fully on screen —
            // at x=0 a negative inset clipped it against the bezel.
            left: Math.max(3, hole.x + 4),
            top: hole.y + 2,
            width: Math.min(hole.width - 8, width - Math.max(3, hole.x + 4) - 3),
            height: Math.max(0, hole.height - 4),
          },
        ]}
      />

      <View
        style={[styles.card, { top: slot.top }]}
        onLayout={(e) => setCardH(e.nativeEvent.layout.height)}
        pointerEvents="box-none">
        <Text style={styles.count}>{stepLabel(state)}</Text>
        <Text style={styles.title}>{step.title}</Text>
        <Text style={styles.body}>{step.body}</Text>
        {/* Skip sits BESIDE Next, not as small print in a corner: a tour with a
            dozen steps needs an obvious way out, or it is a hostage situation. */}
        <View style={styles.actions}>
          <Pressable
            onPress={() => {
              hapticLight();
              onSkip();
            }}
            accessibilityRole="button"
            accessibilityLabel="Skip the tour"
            style={({ pressed }) => [styles.skipBtn, pressed && styles.pressed]}>
            <Text style={styles.skipText}>SKIP TOUR</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              hapticLight();
              onNext();
            }}
            accessibilityRole="button"
            style={({ pressed }) => [styles.next, pressed && styles.pressed]}>
            <Text style={styles.nextText}>{isLast(state) ? 'DONE' : 'GOT IT'}</Text>
            {isLast(state) ? null : <Ionicons name="arrow-forward" size={14} color="#04140c" />}
          </Pressable>
        </View>
      </View>
    </View>
  );
}

/** The final step says DONE, not "GOT IT →". An arrow promising a next step that
 *  does not exist is a small lie the user notices at exactly the moment they are
 *  deciding whether the app is careful. */
function isLast(state: TourState): boolean {
  return currentStep({ step: state.step + 1, done: false }) === null;
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    // 55%, not 85%. The tour describes the screen behind it — dimming it into
    // an unreadable slab defeats the point of pointing at it.
    dim: { position: 'absolute', backgroundColor: '#0000008c' },
    ring: {
      position: 'absolute',
      borderRadius: 12,
      borderWidth: 2,
      borderColor: t.green,
    },
    card: {
      position: 'absolute',
      left: 16,
      right: 16,
      backgroundColor: t.card,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: t.cardBorder,
      padding: 16,
      gap: 8,
    },
    count: { color: t.textDim, fontSize: 11, letterSpacing: 1, fontFamily: mono },
    actions: { flexDirection: 'row', gap: 10, marginTop: 4 },
    skipBtn: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 11,
      paddingVertical: 12,
      backgroundColor: t.inset,
      borderWidth: 1,
      borderColor: t.cardBorder,
    },
    skipText: { color: t.textDim, fontSize: 13, fontWeight: '800', letterSpacing: 1, fontFamily: mono },
    title: { color: t.text, fontSize: 17, fontWeight: '800' },
    body: { color: t.textDim, fontSize: 13, lineHeight: 19 },
    next: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 7,
      backgroundColor: t.green,
      borderRadius: 11,
      paddingVertical: 12,
    },
    nextText: { color: '#04140c', fontSize: 13, fontWeight: '900', letterSpacing: 1, fontFamily: mono },
    pressed: { opacity: 0.7 },
  });
