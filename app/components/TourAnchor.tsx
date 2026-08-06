/**
 * Marks something the feature tour can spotlight.
 *
 * Wrap a card, a button, a row — anything worth explaining — and give it a
 * stable id that a step in lib/tour.ts names. Registration is what makes the
 * step eligible; see hooks/useTourAnchor.ts for why an absent anchor is how a
 * step gets skipped rather than shown against an empty screen.
 *
 * LAYOUT-NEUTRAL BY CONSTRUCTION. It renders exactly one plain View and passes
 * `style` straight through, so it can either wrap a card (no style, takes its
 * content's size in a column) or REPLACE an existing layout View by inheriting
 * its style — which is how the CPU TEMP and UPTIME halves are anchored without
 * disturbing the flex row they share.
 */
import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { notifyAnchorLayout, useTourAnchor } from '@/hooks/useTourAnchor';

export function TourAnchor({
  id,
  style,
  hitSlop,
  children,
}: {
  id: string;
  style?: StyleProp<ViewStyle>;
  /** Mirror the child's own hitSlop when wrapping a small Pressable.
   *  A parent clips hit-testing to its own bounds, so wrapping a button that
   *  relies on hitSlop to be thumb-sized would quietly shrink its touch target
   *  back to the drawn icon — a tour anchor is not allowed to make a control
   *  harder to press. */
  hitSlop?: number;
  children: React.ReactNode;
}) {
  const ref = useTourAnchor(id);
  return (
    // collapsable={false} is LOAD-BEARING on Android: a View with no background
    // and no handlers is optimised out of the native hierarchy, and a view that
    // does not exist natively cannot be measured — measureInWindow would either
    // never fire or hand back zeros. iOS does not collapse, so this is the kind
    // of bug that ships green from a simulator and is broken on half the users'
    // phones.
    <View
      ref={ref}
      style={style}
      hitSlop={hitSlop}
      // Tell the tour when this box moves. Screens fill in asynchronously and
      // push their contents around; without this the spotlight keeps the rect
      // it measured on arrival. onLayout fires for a change of POSITION as well
      // as size, which is the case that matters — the anchor itself is usually
      // the same size, just further down the page than it was a moment ago.
      onLayout={() => notifyAnchorLayout(id)}
      collapsable={false}>
      {children}
    </View>
  );
}
