/**
 * Per-box "last seen" — persist the last time a box answered, and format an
 * elapsed-time label. Shared by the Console unreachable banner and the Fleet
 * tiles.
 *
 * WHY THIS EXISTS: usePoll's in-memory `lastSuccess` is null on a cold launch to
 * an already-offline box and is CLEARED on every box switch (usePoll.ts:71), so
 * the banner showed "last seen: never" for a box that had answered hundreds of
 * times. Persisting a per-box timestamp (Box.lastSeen) and falling back to it
 * gives an honest "last seen: 2h 4m ago" that survives app restarts and box
 * switches.
 */

/**
 * Only persist this often per box. A healthy box polls every few seconds and
 * must not write storage on each tick; the banner reads this value only while
 * the box is OFFLINE, so a value up to a minute stale is fine.
 */
const PERSIST_EVERY_MS = 60_000;

/**
 * Per-key timestamp of the value we last actually persisted. Module-level so the
 * Console and Fleet writers share one throttle. Both write a MONOTONICALLY
 * increasing timestamp and the guard below makes the write idempotent, so this
 * cannot become the two-writer feedback loop that a mutable snapshot (e.g. caps)
 * would — there is one right answer (now), and it only goes up.
 */
const lastPersisted = new Map<string, number>();

/**
 * Persist a box's last-reachable time, throttled per `key`. `persist` performs
 * the actual box-scoped write (e.g. `update({ lastSeen: ts })`); it runs only
 * when the value has advanced by at least PERSIST_EVERY_MS. A falsy/zero `ts` is
 * ignored (there is no contact to record).
 */
export function noteBoxSeen(
  key: string,
  ts: number,
  persist: (ts: number) => void,
): void {
  if (!ts) return;
  const prev = lastPersisted.get(key) ?? 0;
  if (ts - prev < PERSIST_EVERY_MS) return;
  lastPersisted.set(key, ts);
  persist(ts);
}

/** Clear the throttle memory. Test-only. */
export function __resetLastSeenThrottle(): void {
  lastPersisted.clear();
}

/**
 * "never" / "40s ago" / "12m ago" / "3h 4m ago" — elapsed since `ts` (unix ms),
 * or "never" when there is no known contact (null / undefined / 0). A `ts` in
 * the future (clock skew) reads as "just now" rather than a negative age.
 */
export function fmtLastSeen(ts: number | null | undefined): string {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 0) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
}
