/**
 * Pure geometry for the Playlog drag-to-reorder gesture. Kept out of the screen
 * so it can be unit-tested without a renderer — the gesture path is the kind of
 * code that ships broken when it is only ever eyeballed.
 *
 * The drag commits ONLY on release, against a layout snapshot frozen at the
 * moment the drag began (row centres in content-space, in the current order).
 * Because the data never mutates mid-drag, the snapshot stays valid and the
 * target slot is a deterministic function of how far the finger has moved.
 */

/** Move one item within an array, returning a NEW array. Indices are clamped, so
 *  an out-of-range from/to can never throw or drop the item. */
export function arrayMove<T>(arr: readonly T[], from: number, to: number): T[] {
  const out = arr.slice();
  if (out.length === 0) return out;
  const f = Math.max(0, Math.min(from, out.length - 1));
  const [item] = out.splice(f, 1);
  const insertAt = Math.max(0, Math.min(to, out.length));
  out.splice(insertAt, 0, item);
  return out;
}

/**
 * Where the dragged row should land.
 *
 * @param centers   y-centre of every row, in the ORIGINAL (pre-drag) order,
 *                  measured in the list's content space.
 * @param from      index of the row being dragged.
 * @param floatCenter  current centre of the floating (dragged) row =
 *                     centers[from] + gesture.dy.
 * @returns the target index to hand to arrayMove(keys, from, to). Equal to
 *          `from` when nothing should move (single row, or hasn't crossed a
 *          neighbour), so a stray tap on the grip is a no-op.
 */
export function computeDropIndex(
  centers: readonly number[], from: number, floatCenter: number,
): number {
  const n = centers.length;
  if (n <= 1) return from;
  // Count non-dragged rows whose centre sits above the floating point. That
  // count is exactly the insertion index in the array once the dragged row is
  // removed — which is what arrayMove expects as `to`.
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (i === from) continue;
    if (centers[i] < floatCenter) count++;
  }
  return Math.max(0, Math.min(count, n - 1));
}

/**
 * y-centre of every row from measured HEIGHTS, reconstructed as a running sum.
 *
 * Heights (not absolute y) are the durable signal: a cell's onLayout reports its
 * own height even when it sits inside a virtualized list, whereas a row the list
 * has not rendered has no layout at all. Such a row gets `defaultHeight` rather
 * than 0 — a 0 would collapse it to the top and make the drop index count it as
 * "above the finger", teleporting the dragged game to the wrong slot in any
 * queue longer than the render window. A positive default keeps the centres
 * strictly increasing, so the maths degrades to an estimate, never to a guess.
 */
export function rowCenters(
  order: readonly string[],
  heightByKey: Readonly<Record<string, number>>,
  gap: number,
  defaultHeight: number,
): number[] {
  const centers: number[] = [];
  let acc = 0;
  for (const k of order) {
    const h = heightByKey[k] ?? defaultHeight;
    centers.push(acc + h / 2);
    acc += h + gap;
  }
  return centers;
}

/**
 * Apply a reordering that only names a SUBSET of the full list, permuting just
 * the slots those keys occupy and leaving every other key exactly where it is.
 *
 * The Playlog queue holds both installed and owned-but-uninstalled games, and
 * the two arrive on different polls — so at any instant the screen may be showing
 * only some of the bookmarks. A reorder must never relocate the games that
 * happen to be off-screen (still loading, or absent on an older agent): dropping
 * them to the tail is silent, persisted order corruption. Keys in `orderedSubset`
 * that are not in `current` are ignored; keys in `current` but not named keep
 * their position.
 */
export function reorderWithinSubset(
  current: readonly string[], orderedSubset: readonly string[],
): string[] {
  const present = new Set(current);
  const seq: string[] = [];
  const inSeq = new Set<string>();
  for (const k of orderedSubset) {
    if (present.has(k) && !inSeq.has(k)) { seq.push(k); inSeq.add(k); }
  }
  let i = 0;
  return current.map((k) => (inSeq.has(k) ? seq[i++] : k));
}
