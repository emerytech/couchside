/**
 * The Preferences tab's foldable sections. Zero runtime imports, so it is
 * unit-testable on bare Node like lib/flatpakUpdate.ts and lib/cardOrder.ts.
 *
 * WHY THIS EXISTS (roadmap "Make Preferences findable", the two pieces left
 * after the filter shipped in #224): ~28 controls in one scrolling tab is past
 * the point where scanning works, and the fix the roadmap chose — and its
 * superseded "category sub-tabs" idea explicitly rejected — is folding whole
 * sections with the state REMEMBERED (the Stream from PC card's mechanism),
 * plus splitting the overloaded PAD LAYOUT card along its seam: what appears on
 * screen vs how input behaves. Folding is not hiding: a folded section still
 * shows its header and reopens in one tap, and a live search query overrides
 * every fold so a match can never be hidden behind one.
 *
 * The id list is FROZEN so the persisted set can be validated on load: an id
 * that no longer exists (a renamed section, a hand-edited blob) is dropped,
 * never carried along as junk.
 */

export const PREF_SECTIONS = [
  'general',
  'diagnostics',
  'appearance',
  'media',
  'input',
  'padLayout',
  'padBehavior',
  'stream',
  'touch',
] as const;

export type PrefSectionId = (typeof PREF_SECTIONS)[number];

export function isPrefSectionId(x: unknown): x is PrefSectionId {
  return typeof x === 'string' && (PREF_SECTIONS as readonly string[]).includes(x);
}

/**
 * Coerce a persisted blob field into a valid fold set: only known ids, each at
 * most once, in first-seen order. Anything that is not an array is "nothing
 * folded" — the default that changes nothing for a user who never folded.
 */
export function normalizeCollapsed(raw: unknown): readonly PrefSectionId[] {
  if (!Array.isArray(raw)) return [];
  const out: PrefSectionId[] = [];
  for (const x of raw) {
    if (isPrefSectionId(x) && !out.includes(x)) out.push(x);
  }
  return out;
}

/** The set after tapping a section header: folded ↔ open. Never duplicates. */
export function toggleCollapsed(
  current: readonly PrefSectionId[],
  id: PrefSectionId,
): readonly PrefSectionId[] {
  return current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
}

/**
 * Should a section's rows render? A folded section hides them — EXCEPT while a
 * search query is active: the filter dissolves the section chrome into one
 * flat result list, and a hit that a fold could hide would read as "not found".
 */
export function sectionOpen(
  collapsed: readonly PrefSectionId[],
  id: PrefSectionId,
  query: string,
): boolean {
  if (query.trim().length > 0) return true;
  return !collapsed.includes(id);
}
