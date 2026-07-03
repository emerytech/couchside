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

import {
  Box,
  BoxesState,
  EMPTY_SETTINGS,
  DEFAULT_PAD_MODE,
  DEFAULT_PORT,
  Settings,
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

      const existing = cur.boxes.find((b) => sameTarget(b, host, port));
      if (existing) {
        // Update the match's token/name in place; make it active. No duplicate.
        const updated: Box = {
          ...existing,
          token: token || existing.token,
          name: input.name?.trim() ? input.name.trim() : existing.name,
          padMode: input.padMode ?? existing.padMode,
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

/** Unauthenticated /api/ping probe with a hard timeout. */
async function pingBox(host: string, port: number, timeoutMs: number): Promise<boolean> {
  if (!host) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${host}:${port}/api/ping`, {
      method: 'GET',
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
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
        void pingBox(box.host, box.port, timeoutMs)
          .then((ok) => {
            if (!mounted.current) return;
            setStatus((prev) => {
              const nextVal: BoxReachability = ok ? 'reachable' : 'offline';
              if (prev[box.id] === nextVal) return prev;
              return { ...prev, [box.id]: nextVal };
            });
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
  }, [active, intervalMs, timeoutMs]);

  return status;
}
