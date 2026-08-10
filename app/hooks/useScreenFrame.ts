/**
 * Poll the box's screen as a stream of JPEG data-URIs. Extracted from
 * ScreenPreview so the fullscreen desktop-control route can reuse the exact
 * same self-rescheduling loop (a fixed setInterval would stack fetches when a
 * capture runs long — the box floor is ~2/s and a capture can take ~1.4s).
 *
 * A generation token cancels the in-flight chain on unmount / dep change, and
 * a fetch that resolves after being superseded is dropped. Degrades to
 * `failed=true` (never a stale-but-confident frame) — the caller decides how
 * loud to be about it.
 */
import { useEffect, useRef, useState } from 'react';

import { screenFrameSource, type ConnSettings } from '@/lib/api';

/** Hard deadline per frame fetch. A capture can take ~1.4s; this only fires on a
 *  genuinely wedged request (e.g. Android hanging on a `.local` mDNS lookup,
 *  which can even ignore abort — hence the race below, mirroring api.ts attempt()). */
const FRAME_TIMEOUT_MS = 5000;

export function useScreenFrame(settings: ConnSettings, active: boolean, intervalMs: number) {
  const [frame, setFrame] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [lastGood, setLastGood] = useState<number | null>(null);
  const genRef = useRef(0);

  useEffect(() => {
    if (!active) {
      genRef.current++; // stop any running chain
      return undefined;
    }
    const myGen = ++genRef.current;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = async () => {
      if (genRef.current !== myGen) return;
      // Abort AND race a hard deadline: a wedged fetch (Android `.local` mDNS)
      // can ignore abort and never settle, which would stall the whole poll and
      // leave a frozen frame reading as live forever. The race guarantees the
      // loop always moves on and re-schedules.
      const ctrl = new AbortController();
      const killer = setTimeout(() => ctrl.abort(), FRAME_TIMEOUT_MS);
      let uri: string | null = null;
      try {
        uri = await Promise.race([
          screenFrameSource(settings, ctrl.signal),
          new Promise<null>((res) => setTimeout(() => res(null), FRAME_TIMEOUT_MS + 500)),
        ]);
      } catch {
        uri = null;
      }
      clearTimeout(killer);
      if (genRef.current !== myGen) return; // superseded / stopped mid-fetch
      if (uri) {
        setFrame(uri);
        setFailed(false);
        setLastGood(Date.now());
      } else {
        setFailed(true);
      }
      if (genRef.current === myGen) timer = setTimeout(run, intervalMs);
    };
    void run();
    return () => {
      genRef.current++;
      if (timer) clearTimeout(timer);
    };
  }, [active, intervalMs, settings]);

  return { frame, failed, lastGood };
}
