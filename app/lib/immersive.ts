/**
 * "Immersive" = the landscape gamepad is on screen and owns the whole display.
 *
 * WHY A STORE AND NOT `navigation.setOptions`.
 *
 * Three separate places have to stop drawing: the tab bar (owned by
 * `app/(tabs)/_layout.tsx`), the BoxSwitcher and trial nudge (owned by
 * `components/TabScreen.tsx`), and the Pad's own status pill and mode selector.
 * The obvious way to do that from inside pad.tsx is an imperative
 * `navigation.setOptions({ tabBarStyle: { display: 'none' } })` — and the
 * obvious way is a trap, because it has to remember to undo itself. Cleanup
 * that never runs, or that restores `undefined` instead of the real style,
 * leaves the user on the Console tab with no tab bar and no way back. That is a
 * shipped bug in a lot of apps and it would be a total failure here, where the
 * promise is that the app works when the TV is black.
 *
 * So the flag is state, `_layout.tsx` derives `tabBarStyle` from it, and there
 * is nothing to undo. The worst a bug can do is show chrome that should be
 * hidden, which is visible and harmless, rather than hide chrome that should be
 * shown.
 *
 * Module-level rather than a context provider so the tab layout can read it
 * without wrapping `<Tabs>` in another component — and `useSyncExternalStore`
 * rather than a hand-rolled subscription so React never tears between the tab
 * bar and the screen inside it. No new dependency.
 */
import { useSyncExternalStore } from 'react';

let immersive = false;
const listeners = new Set<() => void>();

/**
 * Called from the Pad screen's render path as the derived value changes.
 * Idempotent: setting the value it already has notifies nobody, which matters
 * because this is driven from a render and a notify-on-every-render would loop.
 */
export function setImmersive(next: boolean): void {
  if (next === immersive) return;
  immersive = next;
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

const getSnapshot = () => immersive;

export function useImmersive(): boolean {
  // Third argument is the server snapshot — the web harness renders this on the
  // server side of expo-router and would otherwise throw.
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Test seam: drop back to chrome-visible without a render. */
export function __resetImmersive(): void {
  immersive = false;
  for (const l of listeners) l();
}
