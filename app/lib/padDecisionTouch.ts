import type { Rect } from './padLayout.ts';
import type { PadTouch } from './padTouches.ts';

/** A PAD decision follows its own finger, independent of fingers holding gameplay.
 * Never choose a decision on touch-down, drag-in, cancellation or a stale end.
 */
export function createPadDecisionTouch() {
  let owner: number | null = null;
  let bounds: Rect | null = null;
  const inside = (p: PadTouch) => bounds != null && Number.isFinite(p.x) && Number.isFinite(p.y)
    && p.x >= bounds.x && p.x < bounds.x + bounds.w && p.y >= bounds.y && p.y < bounds.y + bounds.h;
  const cancel = () => { owner = null; };
  return {
    layout(rect: Rect | null) { cancel(); bounds = rect; },
    start(points: readonly PadTouch[]) {
      if (owner == null) owner = points.find(p => Number.isFinite(p.identifier) && inside(p))?.identifier ?? null;
    },
    move(points: readonly PadTouch[]) {
      const p = points.find(p => p.identifier === owner);
      if (p && !inside(p)) cancel();
    },
    end(points: readonly PadTouch[]) {
      const p = points.find(p => p.identifier === owner);
      if (!p) return false;
      const activate = inside(p); cancel(); return activate;
    },
    cancel,
    pressed: () => owner != null,
  };
}
