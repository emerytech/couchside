/**
 * Deciding when a Steam download actually FINISHED.
 *
 * The agent lists an app only while an operation is running, so an entry
 * disappearing means one of two very different things: it completed, or it was
 * cancelled/removed. Announcing a cancellation as "finished downloading" sends
 * someone to the TV for a game that is not there — so disappearance alone is
 * never enough, and the last observed progress decides.
 *
 * ZERO imports, so the part that makes a claim to the user is testable in bare
 * Node. This logic lived inline in the Launch tab; it moved here so a single
 * watcher can run for the whole app rather than only while that tab happens to
 * be mounted.
 */

/** The subset of a Steam download this module needs. Structural, so tests need
 *  no api types. */
export type WatchedDownload = {
  appid: number;
  name: string;
  state: string;
  /** Absent on agents < 2.9.4 — treat undefined as active, unchanged behaviour. */
  active?: boolean;
  percent: number;
};

/** Genuinely transferring right now, as opposed to sitting in the queue. */
export function isActive(d: WatchedDownload): boolean {
  return d.active !== false && d.state !== 'queued';
}

/**
 * At what progress a vanished entry counts as finished.
 *
 * Steam stops reporting slightly before 100% on some titles, so an exact match
 * would miss real completions; 90% is high enough that a cancellation cannot
 * plausibly reach it. 'finalizing' counts regardless — that state IS the end.
 */
export const DONE_PERCENT = 90;

export type WatchState = {
  /** Last seen entry per appid. */
  seen: Record<number, WatchedDownload>;
  /** Appids observed genuinely ACTIVE at some point. A queued entry that
   *  vanishes was dequeued, never started, and must not be announced. */
  observed: number[];
};

export const EMPTY_WATCH: WatchState = { seen: {}, observed: [] };

export type WatchResult = {
  next: WatchState;
  /** Names to announce, in the order they vanished. Usually empty. */
  finished: string[];
  /** True when anything disappeared at all — finished OR cancelled. The caller
   *  refreshes its library either way, because both change what is installed. */
  changed: boolean;
};

/**
 * Fold the newest poll into the watch state.
 *
 * Pure and total: same inputs, same answer, no clock and no I/O. `current` may
 * be an empty list (nothing downloading) or the same list twice (no change).
 */
export function advanceWatch(prev: WatchState, current: WatchedDownload[]): WatchResult {
  const curIds = new Set(current.map((d) => d.appid));
  const observed = new Set(prev.observed);
  for (const d of current) {
    if (isActive(d)) observed.add(d.appid);
  }

  const finished: string[] = [];
  let changed = false;
  for (const [key, was] of Object.entries(prev.seen)) {
    const appid = Number(key);
    if (curIds.has(appid)) continue;
    changed = true;
    if (!observed.has(appid)) continue; // queued then dequeued: never started
    observed.delete(appid);
    if (was.percent >= DONE_PERCENT || was.state === 'finalizing') {
      finished.push(was.name);
    }
  }

  const seen: Record<number, WatchedDownload> = {};
  for (const d of current) seen[d.appid] = d;
  return { next: { seen, observed: [...observed] }, finished, changed };
}

/**
 * How often to ask. Fast only while bytes are genuinely moving — a static queue
 * of pending updates should not hammer the box every five seconds.
 */
export function pollInterval(current: WatchedDownload[]): number {
  return current.some(isActive) ? 5000 : 20000;
}
