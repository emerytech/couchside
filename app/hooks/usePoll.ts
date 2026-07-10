import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, AppStateStatus } from 'react-native';

export type PollState<T> = {
  data: T | null;
  error: Error | null;
  /** True while the very first request is in flight (no data yet). */
  loading: boolean;
  /** Unix ms of the last successful fetch. */
  lastSuccess: number | null;
  /** Fire a fetch right now (also restarts the interval). */
  refresh: () => void;
  /**
   * The resetKey `data` was fetched under (undefined until first data / after
   * a key change). Render-time consumers that MUTATE REFS from `data` must
   * check `dataKey === <current key>` first: when resetKey changes, React
   * discards the in-progress render pass but still finishes executing it, and
   * that doomed pass sees the PREVIOUS key's `data` (state swaps only apply to
   * the re-render) while its ref writes persist. Effects are safe (they only
   * run after commit); bare `if (data) someRef.current = ...` is not.
   */
  dataKey: string | undefined;
};

/** While a box is unreachable, retry this fast until it recovers. */
const ERROR_RETRY_MS = 2000;

/**
 * Generic polling hook.
 * - Fires immediately, then reschedules itself after each tick.
 * - Normal cadence is `intervalMs`; after a failed fetch it retries every
 *   ~2s (ERROR_RETRY_MS) until the box recovers, then resumes normal cadence.
 * - On AppState 'active' it refetches immediately (no waiting out the timer).
 * - Pauses while the screen is unfocused (useFocusEffect).
 * - Never calls setState after unmount/blur. `enabled: false` stops polling.
 * - `resetKey` identifies the poll target (e.g. the active box's host:port).
 *   When it changes, data/error clear in the SAME render (no stale frame from
 *   the previous target) and any in-flight fetch that was started for the old
 *   key is discarded when it lands — a response can never be attributed to a
 *   target it wasn't fetched for. Omit for polls whose target never changes.
 */
export function usePoll<T>(
  fn: () => Promise<T>,
  intervalMs: number,
  enabled = true,
  resetKey?: string,
): PollState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastSuccess, setLastSuccess] = useState<number | null>(null);
  const [dataKey, setDataKey] = useState<string | undefined>(undefined);

  const fnRef = useRef(fn);
  fnRef.current = fn;

  // Poll-target generation: bumped on resetKey change; in-flight ticks carry
  // the generation they started under and drop their result if it moved.
  const genRef = useRef(0);
  const keyRef = useRef(resetKey);
  if (keyRef.current !== resetKey) {
    // Adjust-state-during-render (the sanctioned React pattern): clearing here
    // instead of in an effect means the target switch never paints one frame
    // of the previous target's data.
    keyRef.current = resetKey;
    genRef.current++;
    setData(null);
    setError(null);
    setLoading(true);
    setLastSuccess(null);
    setDataKey(undefined);
  }

  const aliveRef = useRef(false);
  // Self-scheduling timeout (not a fixed interval) so success and failure can
  // use different cadences.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks whether the last tick failed, to pick the next delay.
  const failingRef = useRef(false);
  // Bumping this restarts the focus effect (used by refresh()).
  const [epoch, setEpoch] = useState(0);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const scheduleNext = useCallback(() => {
    if (!aliveRef.current) return;
    const delay = failingRef.current ? Math.min(ERROR_RETRY_MS, intervalMs) : intervalMs;
    clearTimer();
    timerRef.current = setTimeout(() => {
      void tickRef.current();
    }, delay);
  }, [intervalMs, clearTimer]);

  const tick = useCallback(async () => {
    // Snapshot the generation this fetch is FOR; a resetKey change mid-flight
    // moves it, and the late result must be dropped, not shown as the new
    // target's data.
    const gen = genRef.current;
    const keyAtStart = keyRef.current;
    try {
      const result = await fnRef.current();
      if (!aliveRef.current || gen !== genRef.current) return;
      failingRef.current = false;
      setData(result);
      setDataKey(keyAtStart);
      setError(null);
      setLastSuccess(Date.now());
    } catch (e: unknown) {
      if (!aliveRef.current || gen !== genRef.current) return;
      failingRef.current = true;
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      // A stale-generation tick schedules nothing: the key-change effect has
      // already fired a fresh tick for the new target.
      if (aliveRef.current && gen === genRef.current) {
        setLoading(false);
        scheduleNext();
      }
    }
  }, [scheduleNext]);

  // Keep a stable ref to the latest tick so the scheduled timeout always calls
  // the current closure without re-arming timers on every render.
  const tickRef = useRef(tick);
  tickRef.current = tick;

  // Fire immediately (cancelling any pending timer): used by focus, refresh,
  // and AppState 'active'.
  const fireNow = useCallback(() => {
    if (!aliveRef.current) return;
    clearTimer();
    void tickRef.current();
  }, [clearTimer]);

  // Refetch immediately when the poll target changes (state already cleared
  // during this render). Skips the mount render — the focus effect below owns
  // the first fetch, and double-firing it would race two initial requests.
  const mountedForKey = useRef(false);
  useEffect(() => {
    if (!mountedForKey.current) {
      mountedForKey.current = true;
      return;
    }
    failingRef.current = false;
    fireNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately key-only
  }, [resetKey]);

  useFocusEffect(
    useCallback(() => {
      if (!enabled) return undefined;
      aliveRef.current = true;
      failingRef.current = false;
      fireNow();

      // Refetch the moment the app comes back to the foreground.
      const sub = AppState.addEventListener('change', (s: AppStateStatus) => {
        if (s === 'active') fireNow();
      });

      return () => {
        aliveRef.current = false;
        clearTimer();
        sub.remove();
      };
    }, [enabled, epoch, fireNow, clearTimer]),
  );

  // Ensure no leaks if the component unmounts without a blur event.
  useEffect(() => {
    return () => {
      aliveRef.current = false;
      clearTimer();
    };
  }, [clearTimer]);

  const refresh = useCallback(() => {
    setEpoch((n) => n + 1);
  }, []);

  return { data, error, loading, lastSuccess, refresh, dataKey };
}
