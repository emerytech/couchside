import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState, AppStateStatus } from 'react-native';

import { pingMatchesBox } from './api';
import {
  Box,
  BoxesState,
  EMPTY_SETTINGS,
  DEFAULT_PAD_MODE,
  DEFAULT_PORT,
  Settings,
  isValidLanIp,
  loadBoxes,
  nextBoxId,
  saveBoxes,
} from './settings';

// ---------- Boxes context ----------

/** Fields accepted when adding/pairing a box. */
export type AddBoxInput = {
  host: string;
  port?: number;
  token?: string;
  name?: string;
  padMode?: Box['padMode'];
  /** Fallback IP (e.g. from the pairing QR's &ip= param). */
  lastIp?: string;
};

type BoxesContextValue = {
  boxes: Box[];
  activeBox: Box | null;
  activeBoxId: string | null;
  /** True once persisted fleet has been loaded. */
  ready: boolean;
  switchBox: (id: string) => void;
  /**
   * Add a box, or (dedupe by host+port) update the existing match's token/name.
   * Makes the resulting box active. Returns the resulting box.
   */
  addBox: (input: AddBoxInput) => Promise<Box>;
  updateBox: (id: string, patch: Partial<Omit<Box, 'id'>>) => Promise<void>;
  removeBox: (id: string) => Promise<void>;
  renameBox: (id: string, name: string) => Promise<void>;
};

const BoxesContext = createContext<BoxesContextValue>({
  boxes: [],
  activeBox: null,
  activeBoxId: null,
  ready: false,
  switchBox: () => {},
  addBox: async () => ({
    id: '',
    name: '',
    host: '',
    port: DEFAULT_PORT,
    token: '',
    padMode: DEFAULT_PAD_MODE,
  }),
  updateBox: async () => {},
  removeBox: async () => {},
  renameBox: async () => {},
});

function sameTarget(box: Box, host: string, port: number): boolean {
  return box.host === host && box.port === port;
}

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<BoxesState>({ boxes: [], activeBoxId: null });
  const [ready, setReady] = useState(false);
  // Authoritative copy for read-modify-write across rapid updates.
  const current = useRef<BoxesState>({ boxes: [], activeBoxId: null });

  const commit = useCallback(async (next: BoxesState): Promise<void> => {
    current.current = next;
    setState(next);
    await saveBoxes(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadBoxes().then((s) => {
      if (!cancelled) {
        current.current = s;
        setState(s);
        setReady(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const switchBox = useCallback((id: string) => {
    const cur = current.current;
    if (!cur.boxes.some((b) => b.id === id)) return;
    if (cur.activeBoxId === id) return;
    const next: BoxesState = { ...cur, activeBoxId: id };
    // fire-and-forget persist; state update is synchronous-enough for UX
    void commit(next);
  }, [commit]);

  const addBox = useCallback(
    async (input: AddBoxInput): Promise<Box> => {
      const cur = current.current;
      const host = input.host.trim();
      const port =
        typeof input.port === 'number' && Number.isFinite(input.port)
          ? input.port
          : DEFAULT_PORT;
      const token = input.token ?? '';
      // Same validation as the ping learner: a QR/deep-link ip param must be
      // a plausible LAN address before it becomes a token destination.
      const inputIp =
        input.lastIp && isValidLanIp(input.lastIp) ? input.lastIp : undefined;

      const existing = cur.boxes.find((b) => sameTarget(b, host, port));
      if (existing) {
        // Update the match's token/name in place; make it active. No duplicate.
        const updated: Box = {
          ...existing,
          token: token || existing.token,
          name: input.name?.trim() ? input.name.trim() : existing.name,
          padMode: input.padMode ?? existing.padMode,
          // A fresh pairing's IP is newer than whatever was cached.
          lastIp: inputIp || existing.lastIp,
        };
        const boxes = cur.boxes.map((b) => (b.id === existing.id ? updated : b));
        await commit({ boxes, activeBoxId: existing.id });
        return updated;
      }

      const box: Box = {
        id: nextBoxId(),
        name: input.name?.trim() ? input.name.trim() : host || 'New box',
        host,
        port,
        token,
        padMode: input.padMode ?? DEFAULT_PAD_MODE,
        lastIp: inputIp,
      };
      await commit({
        boxes: [...cur.boxes, box],
        activeBoxId: box.id,
      });
      return box;
    },
    [commit],
  );

  const updateBox = useCallback(
    async (id: string, patch: Partial<Omit<Box, 'id'>>): Promise<void> => {
      const cur = current.current;
      if (!cur.boxes.some((b) => b.id === id)) return;
      const boxes = cur.boxes.map((b) => (b.id === id ? { ...b, ...patch } : b));
      await commit({ ...cur, boxes });
    },
    [commit],
  );

  const removeBox = useCallback(
    async (id: string): Promise<void> => {
      const cur = current.current;
      const boxes = cur.boxes.filter((b) => b.id !== id);
      let activeBoxId = cur.activeBoxId;
      if (activeBoxId === id) {
        activeBoxId = boxes.length ? boxes[0].id : null;
      }
      await commit({ boxes, activeBoxId });
    },
    [commit],
  );

  const renameBox = useCallback(
    async (id: string, name: string): Promise<void> => {
      const trimmed = name.trim();
      if (!trimmed) return;
      await updateBox(id, { name: trimmed });
    },
    [updateBox],
  );

  const activeBox = useMemo(
    () => state.boxes.find((b) => b.id === state.activeBoxId) ?? null,
    [state.boxes, state.activeBoxId],
  );

  const value = useMemo<BoxesContextValue>(
    () => ({
      boxes: state.boxes,
      activeBox,
      activeBoxId: state.activeBoxId,
      ready,
      switchBox,
      addBox,
      updateBox,
      removeBox,
      renameBox,
    }),
    [state.boxes, state.activeBoxId, activeBox, ready, switchBox, addBox, updateBox, removeBox, renameBox],
  );

  return <BoxesContext.Provider value={value}>{children}</BoxesContext.Provider>;
}

export function useBoxes(): BoxesContextValue {
  return useContext(BoxesContext);
}

// ---------- Back-compat single-settings hook ----------

type SettingsContextValue = {
  /** The active box projected as flat Settings, or a safe empty shape. */
  settings: Settings;
  ready: boolean;
  /** Apply a patch (e.g. padMode) to the active box. No-op if none active. */
  update: (patch: Partial<Settings>) => Promise<void>;
};

/**
 * Back-compat shim so existing tabs / api.ts / gamepad.ts keep working with the
 * flat Settings shape. Reads the active box; writes patch it.
 */
export function useSettings(): SettingsContextValue {
  const { activeBox, ready, updateBox } = useBoxes();

  const settings: Settings = useMemo(() => {
    if (!activeBox) return { ...EMPTY_SETTINGS };
    return {
      host: activeBox.host,
      port: activeBox.port,
      token: activeBox.token,
      padMode: activeBox.padMode,
      lastIp: activeBox.lastIp,
      mac: activeBox.mac,
    };
  }, [activeBox]);

  const activeId = activeBox?.id ?? null;
  const update = useCallback(
    async (patch: Partial<Settings>): Promise<void> => {
      if (!activeId) return;
      await updateBox(activeId, patch);
    },
    [activeId, updateBox],
  );

  return { settings, ready, update };
}

// ---------- Per-box online status (ping) ----------

export type BoxReachability = 'reachable' | 'offline' | 'unknown';

type OnlineStatusMap = Record<string, BoxReachability>;

type PingProbe = {
  ok: boolean;
  /** LAN IP reported by the agent (>= 2.3), for the Box.lastIp cache. */
  ip: string | null;
};

/**
 * One unauthenticated /api/ping probe against a specific host, hard timeout.
 * `expectedHost` enables the identity check (pingMatchesBox). Pass it on the
 * cached-IP fallback leg so a DHCP lease that wandered to a different machine
 * doesn't count as "this box is reachable".
 */
async function pingHost(
  host: string,
  port: number,
  timeoutMs: number,
  expectedHost?: string,
): Promise<PingProbe> {
  if (!host) return { ok: false, ip: null };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${host}:${port}/api/ping`, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, ip: null };
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // pre-2.3 agent with a non-JSON body: reachable is all we learn
    }
    if (expectedHost != null && !pingMatchesBox(body, expectedHost)) {
      return { ok: false, ip: null };
    }
    const ip = body && typeof (body as { ip?: unknown }).ip === 'string'
      ? ((body as { ip: string }).ip || null)
      : null;
    return { ok: true, ip };
  } catch {
    return { ok: false, ip: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe a box: its hostname first, then the cached lastIp fallback. This is
 * the same fallback the API client uses: a box whose .local name has gone
 * dark (SteamOS Game Mode mDNS) still reports reachable via its cached IP,
 * but only if the responder proves it IS this box.
 */
async function pingBox(box: Box, timeoutMs: number): Promise<PingProbe> {
  const primary = await pingHost(box.host, box.port, timeoutMs);
  if (primary.ok) return primary;
  if (box.lastIp && box.lastIp !== box.host) {
    return pingHost(box.lastIp, box.port, timeoutMs, box.host);
  }
  return primary;
}

/**
 * Periodically pings every box's /api/ping and reports reachable per id.
 *
 * - `active` gates polling (e.g. only while a switcher is open). When false,
 *   the interval is torn down (statuses retain their last value).
 * - One in-flight ping per box (a slow box never stacks requests).
 * - Pauses while the app is backgrounded (AppState) and resumes on foreground.
 * - Cleans up interval + AppState subscription on unmount.
 */
export function useBoxOnlineStatus(
  boxes: Box[],
  opts: { active?: boolean; intervalMs?: number; timeoutMs?: number } = {},
): OnlineStatusMap {
  const { active = true, intervalMs = 10_000, timeoutMs = 3000 } = opts;
  const [status, setStatus] = useState<OnlineStatusMap>({});
  // For persisting freshly-learned box IPs (Box.lastIp) from ping responses.
  const { updateBox } = useBoxes();

  // Keep a stable, current view of the boxes for the interval closure.
  const boxesRef = useRef<Box[]>(boxes);
  boxesRef.current = boxes;

  // Per-id in-flight guard so a slow box doesn't stack pings.
  const inFlight = useRef<Set<string>>(new Set());
  const mounted = useRef(true);

  // Prune status entries for boxes that no longer exist.
  const idsKey = boxes.map((b) => b.id).join(',');
  useEffect(() => {
    setStatus((prev) => {
      const ids = new Set(boxesRef.current.map((b) => b.id));
      let changed = false;
      const next: OnlineStatusMap = {};
      for (const [id, v] of Object.entries(prev)) {
        if (ids.has(id)) next[id] = v;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [idsKey]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!active) return;

    let appActive = AppState.currentState === 'active' || AppState.currentState == null;
    let interval: ReturnType<typeof setInterval> | null = null;

    const tick = () => {
      if (!appActive) return;
      for (const box of boxesRef.current) {
        if (inFlight.current.has(box.id)) continue;
        inFlight.current.add(box.id);
        void pingBox(box, timeoutMs)
          .then((probe) => {
            if (!mounted.current) return;
            setStatus((prev) => {
              const nextVal: BoxReachability = probe.ok ? 'reachable' : 'offline';
              if (prev[box.id] === nextVal) return prev;
              return { ...prev, [box.id]: nextVal };
            });
            // Cache the IP the box was actually reached on so the app can
            // fall back to it when the hostname stops resolving.
            //  - isValidLanIp: never persist a non-LAN string from an
            //    unauthenticated response as a future token destination.
            //  - re-read the CURRENT box: if the user re-targeted it (host/
            //    port edit) while this probe was in flight, the old
            //    machine's IP must not be written onto the new target.
            if (probe.ok && probe.ip && isValidLanIp(probe.ip)) {
              const cur = boxesRef.current.find((b) => b.id === box.id);
              if (
                cur &&
                cur.host === box.host &&
                cur.port === box.port &&
                cur.lastIp !== probe.ip
              ) {
                void updateBox(box.id, { lastIp: probe.ip });
              }
            }
          })
          .finally(() => {
            inFlight.current.delete(box.id);
          });
      }
    };

    const start = () => {
      if (interval != null) return;
      tick(); // immediate probe on (re)start
      interval = setInterval(tick, intervalMs);
    };
    const stop = () => {
      if (interval != null) {
        clearInterval(interval);
        interval = null;
      }
    };

    const onAppState = (s: AppStateStatus) => {
      const nowActive = s === 'active';
      if (nowActive === appActive) return;
      appActive = nowActive;
      if (appActive) start();
      else stop();
    };

    const sub = AppState.addEventListener('change', onAppState);
    if (appActive) start();

    return () => {
      stop();
      sub.remove();
    };
  }, [active, intervalMs, timeoutMs, updateBox]);

  return status;
}
