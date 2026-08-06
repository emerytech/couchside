/**
 * The registry that lets the tour point at THINGS, not just tabs.
 *
 * A screen wraps something worth explaining in <TourAnchor id="console.cpu">;
 * that registers a measure function here. The tour — which is mounted in the
 * tabs layout, OUTSIDE every screen's tree — asks this module for a window-space
 * rect when it needs one.
 *
 * WHY WINDOW COORDINATES, not onLayout values: the overlay is a sibling of
 * <Tabs>, so a rect relative to some ScrollView's content is meaningless to it.
 * measureInWindow is the only shared coordinate space between the two.
 *
 * AN UNREGISTERED ANCHOR IS A FEATURE. Screens register only what they actually
 * rendered, and half this app is probe-and-appear — the library filter needs 8+
 * games, the ROUTINE action group needs a box that reports a harmless action,
 * the Pad mode selector disappears in large-pad mode. So "no anchor" means "this
 * user does not have this", and the tour skips the step instead of explaining a
 * control that is not on screen. That was a real shipped bug: the tour taught
 * the filter and the shuffle to someone whose library was too small to have
 * either.
 */
import { useEffect, useRef } from 'react';
import { View } from 'react-native';

import type { Rect } from '@/lib/tour';

type Measure = () => Promise<Rect | null>;

const anchors = new Map<string, Measure>();
const scrollers = new Map<string, (dy: number) => void>();

/** Register a measurable element. Returns the unregister function. */
export function registerAnchor(id: string, measure: Measure): () => void {
  anchors.set(id, measure);
  return () => {
    // Only remove OUR entry: two screens can briefly overlap during a tab
    // transition, and the newcomer must not be deleted by the leaver's cleanup.
    if (anchors.get(id) === measure) anchors.delete(id);
  };
}

/** Is this element on screen right now? */
export function hasAnchor(id: string): boolean {
  return anchors.has(id);
}

/**
 * Has the screen this anchor belongs to reported ANY anchor yet?
 *
 * Anchor ids are namespaced by screen ("launch.filter", "actions.routine"), so a
 * registered sibling means that screen is mounted and laid out — and therefore
 * that a missing anchor is genuinely missing rather than merely late.
 *
 * This is what lets the tour tell "not ready" from "not here". Without it both
 * look identical and every skipped step has to burn the full wait: a user
 * watching the tour saw a four-second dead pause between steps 7 and 8, and
 * again between 12 and 13 — exactly the steps skipped on their box.
 */
export function screenHasAnchors(id: string): boolean {
  const dot = id.indexOf('.');
  if (dot <= 0) return false;
  const prefix = id.slice(0, dot + 1);
  for (const key of anchors.keys()) {
    if (key !== id && key.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Where is it, in window coordinates? null when it is not mounted or has not
 * been laid out.
 *
 * DEGRADES CLOSED, like the agent does with an unreadable probe: a zero-sized or
 * non-finite rect returns null ("I do not know") rather than a plausible-looking
 * box at the origin, which would cut a spotlight hole in the top-left corner and
 * point confidently at nothing.
 */
export async function measureAnchor(id: string): Promise<Rect | null> {
  const m = anchors.get(id);
  if (!m) return null;
  try {
    const r = await m();
    if (!r) return null;
    const ok = [r.x, r.y, r.width, r.height].every((v) => typeof v === 'number' && Number.isFinite(v));
    return ok && r.width > 0 && r.height > 0 ? r : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Layout changes
//
// A measured rect goes STALE. Screens fill in asynchronously — the downloads
// card appears, the "Stream from PC" host list expands, cover art loads — and
// everything below shifts down. Measure once and the spotlight stays where the
// element USED to be: seen on Android against a real box, where the ring sat
// around the queued/stream sections while the card described the library.
// Pointing confidently at the wrong thing is the one failure this whole module
// exists to avoid, so anchors report their own movement.
// ---------------------------------------------------------------------------

const layoutListeners = new Set<(id: string) => void>();

/** Called by TourAnchor whenever its box moves or resizes. */
export function notifyAnchorLayout(id: string): void {
  for (const l of layoutListeners) l(id);
}

/** Subscribe to anchor movement. Returns the unsubscribe function. */
export function subscribeAnchorLayout(cb: (id: string) => void): () => void {
  layoutListeners.add(cb);
  return () => {
    layoutListeners.delete(cb);
  };
}

/** Register the scrollable container for a tab, so the tour can bring an
 *  off-screen anchor into view. `dy` is a DELTA, not an absolute offset. */
export function registerScroller(tab: string, scrollBy: (dy: number) => void): () => void {
  scrollers.set(tab, scrollBy);
  return () => {
    if (scrollers.get(tab) === scrollBy) scrollers.delete(tab);
  };
}

/** Scroll a tab's container by `dy`. No-op when that tab never registered one
 *  (Pad and Actions do not all scroll) — the tour then spotlights wherever the
 *  anchor already is, which is correct, just less tidy. */
export function scrollTabBy(tab: string, dy: number): boolean {
  const s = scrollers.get(tab);
  if (!s || dy === 0) return false;
  s(dy);
  return true;
}

/**
 * Attach to a plain View to make it spotlightable.
 *
 * DELIBERATELY NOT ON THE SKIN <Card>: Card is a plain function component in
 * both skins, so a ref passed to it is silently dropped, and its `style` prop
 * lands on a different box in each skin (the outer wrap in reactor, the padded
 * frame in classic) — the same anchor would measure two different rectangles
 * depending on the skin. A plain View at the call site measures the same thing
 * everywhere. It also keeps the measurement off reactor's Animated.View, whose
 * entrance animation moves the card 8px during its first 260ms.
 */
export function useTourAnchor(id: string) {
  const ref = useRef<View>(null);

  useEffect(() => {
    return registerAnchor(
      id,
      () =>
        new Promise<Rect | null>((resolve) => {
          const node = ref.current;
          if (!node) {
            resolve(null);
            return;
          }
          // measureInWindow never calls back if the view has no native peer.
          // Nothing here awaits forever because the tour races this against its
          // own retry budget, but resolving null on a missing node keeps the
          // common case cheap.
          node.measureInWindow((x, y, width, height) => {
            resolve({ x, y, width, height });
          });
        }),
    );
  }, [id]);

  return ref;
}
