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
 */
export function usePoll<T>(
  fn: () => Promise<T>,
  intervalMs: number,
  enabled = true,
): PollState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastSuccess, setLastSuccess] = useState<number | null>(null);

  const fnRef = useRef(fn);
  fnRef.current = fn;

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
    try {
      const result = await fnRef.current();
      if (!aliveRef.current) return;
      failingRef.current = false;
      setData(result);
      setError(null);
      setLastSuccess(Date.now());
    } catch (e: unknown) {
      if (!aliveRef.current) return;
      failingRef.current = true;
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      if (aliveRef.current) {
        setLoading(false);
        scheduleNext();
      }
    }
  }, [scheduleNext]);

  // Keep a stable ref to the latest tick so the scheduled timeout always calls
  // the current closure without re-arming timers on every render.
  const tickRef = useRef(tick);
  tickRef.current = tick;

  // Fire immediately (cancelling any pending timer) — used by focus, refresh,
  // and AppState 'active'.
  const fireNow = useCallback(() => {
    if (!aliveRef.current) return;
    clearTimer();
    void tickRef.current();
  }, [clearTimer]);

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

  return { data, error, loading, lastSuccess, refresh };
}
