/**
 * Pure reorder/hide reconciliation for the hold-to-edit card layouts (Console,
 * Fleet, Actions). IMPORT-FREE ON PURPOSE: the storage/React glue lives in
 * lib/cardLayout, so this logic — the part worth testing — loads under
 * `node --test` without pulling in expo-secure-store / react-native. See
 * lib/__tests__/cardLayout.test.ts and the same split in lib/streak.ts.
 */

export type CardLayout = { order: string[]; hidden: string[] };

/**
 * The order to actually render: the stored order filtered to ids that still
 * exist, then any canonical id the user has never ordered appended in its
 * canonical position (so a new card shows near where it was added, not lost).
 */
export function effectiveOrder(stored: string[], canonical: string[]): string[] {
  const known = new Set(canonical);
  const out = stored.filter((id) => known.has(id));
  const seen = new Set(out);
  for (let i = 0; i < canonical.length; i += 1) {
    const id = canonical[i];
    if (seen.has(id)) continue;
    // insert at the canonical index, clamped to the current length
    out.splice(Math.min(i, out.length), 0, id);
    seen.add(id);
  }
  return out;
}

/** Move `id` one step up/down among the CURRENTLY-VISIBLE ids (skips absent). */
export function moveSection(
  order: string[], visible: string[], id: string, dir: -1 | 1,
): string[] {
  const vis = order.filter((x) => visible.includes(x));
  const vi = vis.indexOf(id);
  const target = vis[vi + dir];
  if (vi < 0 || target == null) return order; // at an end
  // swap id and target in the FULL order array
  const out = [...order];
  const a = out.indexOf(id);
  const b = out.indexOf(target);
  [out[a], out[b]] = [out[b], out[a]];
  return out;
}
