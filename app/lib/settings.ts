import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

/**
 * Input style for the Pad tab:
 *  - gamepad:  full on-screen Xbox controller
 *  - swipe:    Apple-TV-style d-pad swipe surface
 *  - trackpad: relative mouse + scroll surface (protocol v2)
 */
export type PadMode = 'gamepad' | 'swipe' | 'trackpad';

/**
 * A single paired box (Bazzite media center, Steam Deck, ...). The app manages
 * a fleet of these and switches the "active" one like the Apple TV remote's
 * device picker.
 */
export type Box = {
  id: string;
  name: string;
  host: string;
  port: number;
  token: string;
  padMode: PadMode;
  /**
   * Last IP this box was actually reached on (learned from /api/ping's "ip"
   * field or the pairing QR's &ip= param). Used as an automatic fallback when
   * the .local hostname stops resolving — e.g. SteamOS Game Mode's WiFi
   * power-save breaks mDNS while plain HTTP to the IP keeps working.
   */
  lastIp?: string;
};

/**
 * Back-compat single-connection view of the active box. Consumers (api.ts,
 * gamepad.ts, the tab screens) still speak this shape via useSettings().
 */
export type Settings = {
  host: string;
  port: number;
  token: string;
  padMode: PadMode;
  /** Cached fallback IP of the active box (see Box.lastIp). */
  lastIp?: string;
};

/** Safe placeholder used when no box is active (nothing paired yet). */
export const EMPTY_SETTINGS: Settings = {
  host: '',
  port: 8787,
  token: '',
  padMode: 'swipe',
};

/** Kept for back-compat with older imports. */
export const DEFAULT_SETTINGS: Settings = EMPTY_SETTINGS;

/** Default padMode for a newly paired box: the swipe remote is the headline UX. */
export const DEFAULT_PAD_MODE: PadMode = 'swipe';
export const DEFAULT_PORT = 8787;

/** Persisted fleet shape (v2). */
export type BoxesState = {
  boxes: Box[];
  activeBoxId: string | null;
};

const BOXES_KEY = 'couchpilot.boxes.v1';
/** Legacy single-settings key, migrated on first load. */
const LEGACY_KEY = 'rescue-remote.settings.v1';

/**
 * Persistence wrapper: expo-secure-store on native, localStorage on web.
 */
async function storageGet(key: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    try {
      return typeof window !== 'undefined' && window.localStorage
        ? window.localStorage.getItem(key)
        : null;
    } catch {
      return null;
    }
  }
  return SecureStore.getItemAsync(key);
}

async function storageSet(key: string, value: string): Promise<void> {
  if (Platform.OS === 'web') {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(key, value);
      }
    } catch {
      // storage unavailable (private mode); state lives in memory only
    }
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

// ---------- id generation ----------

/**
 * Monotonic counter for box ids. Seeded from existing ids on load so a fresh
 * process never collides with persisted ids. Avoids Math.random()/Date.now()
 * at module scope; ids only need to be unique within the list.
 */
let idCounter = 0;

function seedCounterFrom(boxes: Box[]): void {
  for (const b of boxes) {
    const m = /^box-(\d+)$/.exec(b.id);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n >= idCounter) idCounter = n + 1;
    }
  }
}

/** Stable, crypto-free unique id within the fleet. */
export function nextBoxId(): string {
  const id = `box-${idCounter}`;
  idCounter += 1;
  return id;
}

// ---------- normalization ----------

/**
 * Conservative validator for cached fallback IPs (Box.lastIp): an IPv4
 * literal in private / loopback / link-local / CGNAT (Tailscale) space.
 * Rejects public addresses and hostnames so a value learned from an
 * UNAUTHENTICATED ping response can never redirect bearer-token traffic off
 * the LAN. (IPv6 fallback intentionally unsupported for now.)
 */
export function isValidLanIp(v: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if (a > 255 || b > 255 || c > 255 || d > 255) return false;
  if (a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true; // link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT — Tailscale lives here
  return false;
}

function normalizePadMode(v: unknown): PadMode {
  if (v === 'gamepad') return 'gamepad';
  if (v === 'trackpad') return 'trackpad';
  return 'swipe';
}

/** Coerce an arbitrary parsed value into a valid Box, or null if unusable. */
function normalizeBox(raw: unknown): Box | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const host = typeof o.host === 'string' ? o.host : '';
  if (!host) return null;
  const port =
    typeof o.port === 'number' && Number.isFinite(o.port) ? o.port : DEFAULT_PORT;
  const token = typeof o.token === 'string' ? o.token : '';
  const id = typeof o.id === 'string' && o.id ? o.id : nextBoxId();
  const name =
    typeof o.name === 'string' && o.name.trim() ? o.name.trim() : host;
  const lastIp =
    typeof o.lastIp === 'string' && isValidLanIp(o.lastIp) ? o.lastIp : undefined;
  return { id, name, host, port, token, padMode: normalizePadMode(o.padMode), lastIp };
}

// ---------- load / save ----------

const EMPTY_STATE: BoxesState = { boxes: [], activeBoxId: null };

/**
 * Load the fleet. Migrates a legacy single-settings user into one active box.
 * Never throws — malformed storage falls back to an empty fleet.
 */
export async function loadBoxes(): Promise<BoxesState> {
  // Preferred: the v2 fleet key.
  try {
    const raw = await storageGet(BOXES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object') {
        const o = parsed as Record<string, unknown>;
        const boxesRaw = Array.isArray(o.boxes) ? o.boxes : [];
        const boxes: Box[] = [];
        for (const b of boxesRaw) {
          const nb = normalizeBox(b);
          if (nb) boxes.push(nb);
        }
        seedCounterFrom(boxes);
        let activeBoxId =
          typeof o.activeBoxId === 'string' ? o.activeBoxId : null;
        if (activeBoxId && !boxes.some((b) => b.id === activeBoxId)) {
          activeBoxId = boxes.length ? boxes[0].id : null;
        }
        if (!activeBoxId && boxes.length) activeBoxId = boxes[0].id;
        return { boxes, activeBoxId };
      }
    }
  } catch {
    // fall through to migration / empty
  }

  // Migration: wrap a legacy single-settings blob into one box.
  try {
    const legacy = await storageGet(LEGACY_KEY);
    if (legacy) {
      const parsed = JSON.parse(legacy) as Record<string, unknown>;
      const host = typeof parsed.host === 'string' ? parsed.host : '';
      if (host) {
        const box: Box = {
          id: nextBoxId(),
          name: host || 'My box',
          host,
          port:
            typeof parsed.port === 'number' && Number.isFinite(parsed.port)
              ? parsed.port
              : DEFAULT_PORT,
          token: typeof parsed.token === 'string' ? parsed.token : '',
          // Preserve the migrated user's saved padMode (default gamepad legacy).
          padMode: parsed.padMode === 'swipe' ? 'swipe' : 'gamepad',
        };
        const state: BoxesState = { boxes: [box], activeBoxId: box.id };
        // Persist under the new key so migration runs once.
        await saveBoxes(state).catch(() => {});
        return state;
      }
    }
  } catch {
    // malformed legacy blob; fall through to empty
  }

  return { boxes: [], activeBoxId: null };
}

export async function saveBoxes(state: BoxesState): Promise<void> {
  await storageSet(BOXES_KEY, JSON.stringify(state));
}

// ---------- back-compat single-settings loaders (legacy callers) ----------

/** Back-compat: the active box projected as flat Settings, or EMPTY_SETTINGS. */
export function activeSettings(state: BoxesState): Settings {
  const active = state.boxes.find((b) => b.id === state.activeBoxId);
  if (!active) return { ...EMPTY_SETTINGS };
  return {
    host: active.host,
    port: active.port,
    token: active.token,
    padMode: active.padMode,
    lastIp: active.lastIp,
  };
}

/**
 * Legacy async loader retained for any code that imported it directly.
 * Returns the active box as flat Settings.
 */
export async function loadSettings(): Promise<Settings> {
  const state = await loadBoxes();
  return activeSettings(state);
}

const _EMPTY = EMPTY_STATE;
export { _EMPTY as EMPTY_BOXES_STATE };
