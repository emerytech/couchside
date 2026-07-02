import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

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

/**
 * Generic polling hook.
 * - Fires immediately, then every `intervalMs`.
 * - Pauses while the screen is unfocused (useFocusEffect).
 * - Never calls setState after unmount/blur.
 * - `enabled: false` stops polling entirely.
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
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Bumping this restarts the focus effect (used by refresh()).
  const [epoch, setEpoch] = useState(0);

  const tick = useCallback(async () => {
    try {
      const result = await fnRef.current();
      if (!aliveRef.current) return;
      setData(result);
      setError(null);
      setLastSuccess(Date.now());
    } catch (e: unknown) {
      if (!aliveRef.current) return;
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (!enabled) return;
      aliveRef.current = true;
      tick();
      timerRef.current = setInterval(tick, intervalMs);
      return () => {
        aliveRef.current = false;
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
      };
    }, [tick, intervalMs, enabled, epoch]),
  );

  // Ensure no leaks if the component unmounts without a blur event.
  useEffect(() => {
    return () => {
      aliveRef.current = false;
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const refresh = useCallback(() => {
    setEpoch((n) => n + 1);
  }, []);

  return { data, error, loading, lastSuccess, refresh };
}
