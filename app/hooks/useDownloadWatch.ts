/**
 * ONE watcher for Steam downloads, for the whole app.
 *
 * WHY IT LEFT THE LAUNCH TAB. This logic used to live inside app/(tabs)/launch.tsx,
 * which meant it only ran while that tab was mounted — and tabs mount LAZILY on
 * first focus. Open the app, stay on Console, and downloads were never polled,
 * so the "finished downloading" toast could not fire at all. The one moment the
 * feature exists for is the one where you are not staring at the library.
 *
 * It owns the poll, so the Launch tab reads the result from here instead of
 * asking the box a second time.
 *
 * WHAT IT STILL CANNOT DO: fire while the app is closed or backgrounded. That
 * needs an OS notification, which needs a native dependency and a permission
 * prompt this app does not currently have — and a true push would need a server
 * this product deliberately does not run. Nothing here pretends otherwise.
 *
 * The decision of what counts as "finished" is in lib/downloadWatch.ts, tested
 * in bare Node — announcing a cancellation as a completion sends someone to the
 * TV for a game that is not there.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { api, type Downloads, type SteamDownload } from '@/lib/api';
import type { Settings } from '@/lib/settings';
import { advanceWatch, EMPTY_WATCH, pollInterval, type WatchState } from '@/lib/downloadWatch';
import { showToast } from '@/lib/toast';

type Snapshot = {
  downloads: SteamDownload[];
  /** Bumps whenever anything left the list — finished OR cancelled. Both change
   *  what is installed, so a library view should refresh on either. */
  changeTick: number;
  /** False until the box has answered once, or when it 404s (older agent). */
  supported: boolean;
};

let snap: Snapshot = { downloads: [], changeTick: 0, supported: false };
const listeners = new Set<() => void>();

function commit(next: Snapshot): void {
  snap = next;
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

const getSnapshot = () => snap;

/** Read the shared download state. Any screen may call this; only the layout
 *  runs the watcher itself. */
export function useDownloads(): Snapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Run the watcher. Mount this EXACTLY ONCE, in the tabs layout — two watchers
 * would announce every completion twice.
 */
export function useDownloadWatcher(settings: Settings, enabled: boolean): void {
  const watch = useRef<WatchState>(EMPTY_WATCH);
  const [tick, setTick] = useState(0);
  const boxKey = `${settings.host}:${settings.port}`;
  const lastBox = useRef(boxKey);

  useEffect(() => {
    // A different box has a different library and a different set of downloads;
    // carrying the old state over would announce a completion that belongs to
    // another machine.
    if (lastBox.current !== boxKey) {
      lastBox.current = boxKey;
      watch.current = EMPTY_WATCH;
      commit({ downloads: [], changeTick: snap.changeTick, supported: false });
    }
  }, [boxKey]);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const run = async () => {
      let res: Downloads | null = null;
      try {
        res = await api.downloads(settings);
      } catch {
        res = null; // unreachable box: say nothing, claim nothing
      }
      if (!alive) return;
      // 404 = agent too old for this endpoint (probe-and-appear). Leave the
      // state alone rather than reporting an empty list, which would look like
      // every in-flight download had just vanished.
      if (res) {
        const current = res.downloads ?? [];
        const out = advanceWatch(watch.current, current);
        watch.current = out.next;
        for (const name of out.finished) showToast(`${name} finished downloading`);
        commit({
          downloads: current,
          changeTick: snap.changeTick + (out.changed ? 1 : 0),
          supported: true,
        });
      }
      if (!alive) return;
      timer = setTimeout(run, pollInterval(res?.downloads ?? []));
    };

    void run();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
    // `tick` is unused inside; it exists so a caller could force a restart.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, boxKey, tick]);

  useEffect(() => {
    if (!enabled) setTick((n) => n + 1);
  }, [enabled]);
}
