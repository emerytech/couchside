import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

import type { BoxCaps } from './api';

/**
 * Input style for the Pad tab:
 *  - gamepad:  full on-screen Xbox controller
 *  - swipe:    Apple-TV-style d-pad swipe surface
 *  - trackpad: relative mouse + scroll surface (protocol v2)
 *  - remote:   traditional TV-remote layout (D-pad/OK, TV keys, Steam/QAM)
 */
export type PadMode = 'gamepad' | 'swipe' | 'trackpad' | 'remote';

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
   * the .local hostname stops resolving. e.g. SteamOS Game Mode's WiFi
   * power-save breaks mDNS while plain HTTP to the IP keeps working.
   */
  lastIp?: string;
  /**
   * Box MAC address, learned from /api/status while the box is reachable and
   * kept so the app can send a Wake-on-LAN magic packet after the box suspends
   * and the agent is no longer answering.
   */
  mac?: string;
  /**
   * Which volume the header controls drive: 'box' (the box's own OS volume via
   * media keys, the default) or 'tv' (the panel/CEC backend). Per box.
   */
  volumeTarget?: 'box' | 'tv';
  /**
   * Optional-feature summary this box last reported on /api/status (agent >=
   * 2.8.2), learned + persisted like `mac`. Lets the tab bar hide gaming tabs
   * (Pad/Launch) on a server box immediately on launch, before the first live
   * poll. Undefined until first learned / on older agents.
   */
  caps?: BoxCaps;
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
  /** Cached MAC of the active box for Wake-on-LAN (see Box.mac). */
  mac?: string;
  /** Volume target of the active box (see Box.volumeTarget). */
  volumeTarget?: 'box' | 'tv';
  /** Capability summary of the active box (see Box.caps). */
  caps?: BoxCaps;
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
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (Tailscale lives here)
  return false;
}

/** A canonical "aa:bb:cc:dd:ee:ff" MAC, or null. Accepts ':' or '-' separators
 * and lowercases the result. Rejects the all-zero address, which no NIC uses
 * and which would broadcast a useless magic packet. */
export function normalizeMac(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = v.trim().toLowerCase();
  if (!/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/.test(m)) return null;
  const canon = m.replace(/-/g, ':');
  return canon === '00:00:00:00:00:00' ? null : canon;
}

function normalizeVolumeTarget(v: unknown): 'box' | 'tv' | undefined {
  return v === 'tv' ? 'tv' : v === 'box' ? 'box' : undefined;
}

function normalizePadMode(v: unknown): PadMode {
  if (v === 'gamepad') return 'gamepad';
  if (v === 'trackpad') return 'trackpad';
  if (v === 'remote') return 'remote';
  return 'swipe';
}

/** Coerce a parsed value into a BoxCaps, or undefined unless all six flags are
 *  present as booleans (a partial/garbage blob is dropped, not half-trusted). */
function normalizeCaps(raw: unknown): BoxCaps | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const bool = (k: string): boolean | undefined =>
    typeof o[k] === 'boolean' ? (o[k] as boolean) : undefined;
  const gamepad = bool('gamepad');
  const steam = bool('steam');
  const media = bool('media');
  const tv = bool('tv');
  const screen = bool('screen');
  const power_schedule = bool('power_schedule');
  if (
    gamepad === undefined || steam === undefined || media === undefined ||
    tv === undefined || screen === undefined || power_schedule === undefined
  ) {
    return undefined;
  }
  // screensaver arrived later (agent 2.8.4): optional, so caps persisted from
  // a 2.8.2/2.8.3 box still round-trip. undefined = unknown -> the app probes.
  const screensaver = bool('screensaver');
  return { gamepad, steam, media, tv, screen, power_schedule, screensaver };
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
  const mac = normalizeMac(o.mac) ?? undefined;
  const volumeTarget = normalizeVolumeTarget(o.volumeTarget);
  const caps = normalizeCaps(o.caps);
  return {
    id, name, host, port, token, padMode: normalizePadMode(o.padMode),
    lastIp, mac, volumeTarget, caps,
  };
}

// ---------- load / save ----------

const EMPTY_STATE: BoxesState = { boxes: [], activeBoxId: null };

/**
 * Load the fleet. Migrates a legacy single-settings user into one active box.
 * Never throws: malformed storage falls back to an empty fleet.
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
    mac: active.mac,
    volumeTarget: active.volumeTarget,
    caps: active.caps,
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
