/**
 * Compatibility ratings for the visible library, when the user has opted in.
 *
 * Loads incrementally so the grid is never blocked on the network: tiles render
 * immediately and badges appear as answers arrive. A game with no rating simply
 * never gets a badge — silence, not a "no data" chip on every tile.
 *
 * Off unless the pref is on, and it stops fetching the moment it is turned off.
 */
import { useEffect, useRef, useState } from 'react';

import type { Compat } from '@/lib/compat';
import { fetchCompatMany } from '@/lib/compatFetch';

export function useCompat(appids: number[], enabled: boolean): Record<number, Compat> {
  const [map, setMap] = useState<Record<number, Compat>>({});
  // Stable key so re-renders with the same library do not restart the sweep.
  const key = enabled ? appids.slice().sort((a, b) => a - b).join(',') : '';
  const abortRef = useRef<{ aborted: boolean }>({ aborted: false });

  useEffect(() => {
    abortRef.current.aborted = true; // stop any previous sweep
    if (!enabled || !key) return;
    const signal = { aborted: false };
    abortRef.current = signal;
    const ids = key.split(',').map(Number).filter((n) => Number.isFinite(n));
    void fetchCompatMany(
      ids,
      (appid, c) => {
        if (signal.aborted) return;
        setMap((prev) => (prev[appid] ? prev : { ...prev, [appid]: c }));
      },
      signal,
    );
    return () => {
      signal.aborted = true;
    };
  }, [key, enabled]);

  return map;
}
