/** No wrapping, no diagonal scrolling, and no navigation from control surfaces. */
export function swipeDestination(order: string[], current: string, dx: number, dy: number, touches = 1) {
  if (touches !== 1 || Math.abs(dx) < 80 || Math.abs(dy) > 24 || Math.abs(dx) < Math.abs(dy) * 3) return null;
  const index = order.indexOf(current);
  if (index < 0 || current === 'pad' || current === 'remote') return null;
  return order[index + (dx < 0 ? 1 : -1)] ?? null;
}
// One touch stream on the shared tab surface. Interactive children opt out on
// touch start; the parent resets before that event bubbles through children.
let blocked = false;
export function blockTabSwipe() { blocked = true; }
export function resetTabSwipe() { blocked = false; }
export function isTabSwipeBlocked() { return blocked; }
