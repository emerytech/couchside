/**
 * Typed client for the Couchside agent API (contract v1).
 * Base URL: http://<host>:<port>  (default port 8787)
 */
import { Settings } from './settings';

/** The subset of Settings the API client actually needs. */
export type ConnSettings = Pick<Settings, 'host' | 'port' | 'token' | 'lastIp'>;

/**
 * A remote image source (uri + optional request headers). Structurally a subset
 * of React Native's ImageURISource, so it drops straight into <Image source>.
 */
export type ImageSource = { uri: string; headers?: Record<string, string> };

// ---------- Contract types ----------

export type Ping = {
  ok: boolean;
  app: string;
  version: string;
  /** The LAN IP the agent was reached on (agent >= 2.3); cached as Box.lastIp. */
  ip?: string | null;
  /** The agent's short hostname (agent >= 2.3); used to verify fallback identity. */
  host?: string | null;
};

/** Agent families this app will talk to (current + prior product names). */
const AGENT_APPS = /^(couchside|couchpilot|rescue)-agent$/;

/**
 * Does this ping body identify OUR box? Requires the agent family, and (when
 * both sides know a hostname (box.host is an mDNS name and the agent reports
 * host, >= 2.3)) a hostname match. Guards the cached-IP fallback: a DHCP
 * lease that wandered to a different machine must never receive this box's
 * bearer token or count as "reachable".
 */
export function pingMatchesBox(body: unknown, expectedHost: string): boolean {
  if (!body || typeof body !== 'object') return false;
  const p = body as Record<string, unknown>;
  if (p.ok !== true || typeof p.app !== 'string' || !AGENT_APPS.test(p.app)) return false;
  const expected = expectedHost.toLowerCase().replace(/\.local\.?$/, '');
  if (expected !== expectedHost.toLowerCase() && typeof p.host === 'string' && p.host) {
    return p.host.toLowerCase() === expected;
  }
  return true;
}

export type DiskInfo = {
  mount: string;
  total_gb: number;
  used_gb: number;
  free_gb: number;
  pct: number;
};

/**
 * Primary-interface facts the agent reports (>= 2.6) for the app's power path:
 * the box's MAC (for a Wake-on-LAN magic packet), whether the link is wired
 * (WoL rarely works over WiFi), and whether magic-packet wake is armed. Any
 * field is null when the agent could not read it.
 */
export type NetInfo = {
  iface: string | null;
  mac: string | null;
  wired: boolean | null;
  wol_armed: boolean | null;
};

/**
 * Optional-feature summary a box reports on /api/status (agent >= 2.8.2). Lets
 * the app hide UI a box can't back — and skip the per-feature probe requests it
 * otherwise fires on connect (GET /api/tv, /api/media, /api/screen, ...) — from
 * the status poll it already makes, instead of N separate probe-and-appear
 * round-trips. A hint, not authority: a live op still confirms (e.g. gamepad
 * true but the controller node's perms broke). Absent on older agents — when
 * `caps` is undefined the app falls back to probing each feature individually.
 */
export type BoxCaps = {
  /** Virtual game controller (/dev/uinput on Linux, ViGEmBus on Windows). Gates the Pad tab. */
  gamepad: boolean;
  /** A Steam install is present. Gates the Launch tab: games, launch, downloads, cover art. */
  steam: boolean;
  /** Now-playing / transport (MPRIS on Linux, SMTC on Windows). Gates the media card. */
  media: boolean;
  /** A TV / volume backend (RS-232 panel, HDMI-CEC, or box soft-volume). Gates the TV strip. */
  tv: boolean;
  /** A screen-capture path for the live preview. Gates the preview card. */
  screen: boolean;
  /** Scheduled wake can be armed (RTC alarm on Linux, waitable timer on Windows). Gates the sleep/wake rows. */
  power_schedule: boolean;
  /**
   * Aerial screensaver (Steam-shortcut launched, Linux/gamescope boxes only).
   * Optional: absent on agents < 2.8.4, so undefined must read as "unknown,
   * probe" — only an explicit false skips the probe.
   */
  screensaver?: boolean;
  /**
   * Couch Mode: desktop->TV Game Mode handoff (SteamOS/Bazzite desktop with a
   * TV wired in, 2+ outputs). Optional: absent on agents < 2.9, so undefined
   * reads as "unknown, probe"; only an explicit false skips the probe.
   */
  couchmode?: boolean;
  /**
   * Desktop nav: a SteamOS/Bazzite box currently in the Plasma DESKTOP session.
   * Gates the RemoteView desktop cluster (Start menu, pointer/trackpad, overview)
   * — session-aware, so it flips off once the box is in Game Mode. Optional:
   * absent on agents < 2.9, so undefined reads as "not a desktop box here".
   */
  desktop?: boolean;
};

/** One connected display, from GET /api/displays. */
export type Display = {
  name: string;
  /** True for a built-in panel (eDP/LVDS/DSI); false = an external monitor/TV. */
  internal: boolean;
};

/** GET /api/displays state (agent >= 2.9): the box's outputs for Couch Mode. */
export type Displays = {
  available: boolean;
  outputs: Display[];
  /** External output names to offer as the game display (default = first). */
  game_outputs: string[];
  /** Current session: 'gamescope' when already in Game Mode, else 'desktop'. */
  session: 'gamescope' | 'desktop';
  /** Whether the box's session honors the chosen output (Bazzite: yes; SteamOS
      hardcodes its preference: no). false hides the picker — a dead control is
      worse than none. undefined (older agent) keeps the picker visible. */
  output_forcing?: boolean;
};

/** GET/POST /api/screensaver state (agent >= 2.8.4). */
export type Screensaver = {
  available: boolean;
  running: boolean;
  /** Current theme ("all" or comma list, e.g. "space,underwater"). */
  theme: string;
  tier: string;
  themes: string[];
  tiers: string[];
};

/**
 * Recent-vitals ring (agent >= 2.8.3): parallel arrays, oldest first, sampled
 * on the status poll itself (>=10s apart, ~30 samples ≈ 5 min). Entries may be
 * null when the box couldn't read a value — gap the sparkline, don't draw 0.
 */
export type StatusHistory = {
  t: number[];
  temp: (number | null)[];
  load: (number | null)[];
  mem_pct: (number | null)[];
};

export type Status = {
  hostname: string;
  time: number;
  uptime_s: number;
  load: [number, number, number];
  cpu_temp_c: number | null;
  mem: { total_mb: number; used_mb: number; available_mb: number };
  disks: DiskInfo[];
  /** Network facts for the power/Wake-on-LAN path (agent >= 2.6). */
  net?: NetInfo;
  agent_version: string;
  /** Optional-feature summary (agent >= 2.8.2); undefined on older agents. See BoxCaps. */
  caps?: BoxCaps;
  /** Recent-vitals ring for sparklines (agent >= 2.8.3); undefined on older agents. */
  history?: StatusHistory;
};

export type UnitScope = 'system' | 'user';

export type Unit = {
  name: string;
  scope: UnitScope;
  active: string;
  sub: string;
  description: string;
};

export type Danger = 'low' | 'medium' | 'high';

export type ActionInfo = {
  id: string;
  label: string;
  description: string;
  danger: Danger;
};

export type ActionResult = {
  ok: boolean;
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  /** New mute state, returned by the mute op (agent >= 2.6.5). */
  muted?: boolean | null;
};

export type Journal = {
  unit: string;
  scope: string;
  lines: string[];
};

/**
 * A launcher tile. Steam games are auto-discovered by the agent (kind
 * "steam", carrying the numeric appid used for cover art); "custom" launchers
 * are user-defined argv commands the app can add/delete.
 */
export type Launcher = {
  id: string;
  label: string;
  kind: 'steam' | 'custom';
  /** Steam appid, present for kind "steam": used for library cover art. */
  appid?: number;
};

/** State of an in-progress Steam operation. Unknown values render as 'updating'. */
export type SteamDownloadState =
  | 'downloading'
  | 'paused'
  | 'queued'
  | 'validating'
  | 'finalizing'
  | 'updating';

/** One Steam app with an active download/update/validation operation. */
export type SteamDownload = {
  appid: number;
  name: string;
  state: SteamDownloadState;
  bytes_total: number;
  bytes_downloaded: number;
  percent: number;
};

export type Downloads = { downloads: SteamDownload[] };

/** MPRIS transport op, POSTed as /api/media/<player>/<op>. */
export type MediaOp = 'play' | 'pause' | 'play_pause' | 'next' | 'previous' | 'stop' | 'seek';

/** One MPRIS media player's now-playing snapshot. */
export type MediaPlayer = {
  id: string;
  identity: string;
  status: 'Playing' | 'Paused' | 'Stopped';
  title: string;
  artist: string;
  album: string;
  position_ms: number;
  length_ms: number;
  rate: number;
  can_seek: boolean;
  can_go_next: boolean;
  can_go_previous: boolean;
  can_play: boolean;
  can_pause: boolean;
  /** True when the agent can serve the art bytes (a file:// the player advertised). */
  art: boolean;
  /** Cache-buster for the art fetch; changes when the track changes. */
  art_key: string;
};

export type Media = { available: boolean; players: MediaPlayer[] };

/** Screen-capture capability of the box (probe-and-appear). */
export type ScreenInfo = {
  available: boolean;
  session: 'gamescope' | 'desktop' | 'mock' | null;
  backends: string[];
  formats: string[];
};

/** Delayed suspend/poweroff timer (in-process on the box; cleared by a restart). */
export type PowerSleep = { action: 'suspend' | 'poweroff'; fire_at: number; remaining_s: number };
/** Scheduled RTC wake alarm. */
export type PowerWake = { fire_at: number; remaining_s: number };
/** Sleep timer + wake schedule state (GET /api/power/schedule). */
export type PowerSchedule = {
  sleep: PowerSleep | null;
  wake: PowerWake | null;
  wake_available: boolean;
  limits: { sleep_min_s: number; sleep_max_s: number; wake_min_s: number; wake_max_s: number };
};

export type LaunchResult = {
  ok: boolean;
  /** Present when ok is false. */
  error?: string;
};

/**
 * Which TV-control backend the agent is using (agent >= 2.5). "panel" (RS-232)
 * and "cec" (HDMI-CEC) drive the TV; "soft" (agent >= 2.6) drives the box's own
 * audio sink and does volume/mute only, with no power.
 */
export type TvBackend = 'panel' | 'cec' | 'soft';

/** TV-control probe result. The route 404s when no backend is available. */
export type Tv = {
  available: boolean;
  /** The active backend: "panel" (RS-232), "cec" (HDMI-CEC), or "soft" (box audio). */
  backend: TvBackend;
  /** Human description, e.g. "Newline RS-232 (/dev/ttyUSB0 @ 19200)". */
  adapter: string;
  /**
   * The ops this backend supports (agent >= 2.6). The "soft" backend omits the
   * power ops, so the app hides the power button. Absent on older agents, which
   * the app treats as the full op set.
   */
  ops?: TvOp[];
  /** Box's own OS volume (media keys) is available (agent >= 2.6.2). */
  box_volume?: boolean;
  /** An external TV backend (panel/CEC) can drive volume (agent >= 2.6.2). */
  tv_volume?: boolean;
  /** An external TV backend (panel/CEC) can drive power (agent >= 2.6.2). */
  tv_power?: boolean;
  /** Current box mute state at probe time (agent >= 2.6.5), or null if unknown. */
  muted?: boolean | null;
  /**
   * The panel can jump its input to the box's OPS slot (agent >= 2.6.7). Only
   * the RS-232 panel backend reports this, so the "Switch to box" button is
   * hidden on CEC/soft boxes — it is an opt-in RS-232 feature.
   */
  source_box?: boolean;
  /**
   * The panel can blank/unblank the screen without cutting power (agent >=
   * 2.6.8), so the box keeps running when an OPS display would otherwise power
   * it off in standby. RS-232 panel only — CEC/soft boxes never report it.
   */
  screen_toggle?: boolean;
  /**
   * Display inputs the panel can switch to (agent >= 2.6.9): the app renders a
   * source picker and POSTs /api/tv/source/<id>. Panel (RS-232) only — empty or
   * absent on CEC/soft boxes, which can't route a display's input.
   */
  sources?: { id: string; label: string }[];
  /**
   * Factory-remote key emulation over RS-232 (agent >= 2.7.0): arrows / ok /
   * menu / home / back / settings via POST /api/tv/key/<k>. Panel only.
   */
  keys?: boolean;
  /** Current box OS volume 0-100 (agent >= 2.7.0), or null when unreadable. */
  box_volume_level?: number | null;
  /**
   * Current panel speaker volume 0-100 (agent >= 2.7.0), or null. NOTE: on
   * some panels this register stops tracking after source switches — treat as
   * advisory; the box level is the reliable one.
   */
  tv_volume_level?: number | null;
};

/** Factory-remote keys the agent accepts at POST /api/tv/key/<k>. */
export type TvKey =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'ok'
  | 'menu'
  | 'home'
  | 'back'
  | 'settings'
  | 'bright_up'
  | 'bright_down';

/** Where volume goes: the box's own OS volume, or the TV/panel over CEC/RS-232. */
export type VolumeTarget = 'box' | 'tv';

/** The unified TV ops the agent accepts at POST /api/tv/<op>. */
export type TvOp = 'power_on' | 'power_off' | 'volume_up' | 'volume_down' | 'mute';

// ---------- Errors ----------

export type ApiErrorKind = 'unreachable' | 'unauthorized' | 'http' | 'timeout';

export class ApiError extends Error {
  kind: ApiErrorKind;
  /**
   * HTTP status code, set only when kind === 'http'. Lets probe methods map an
   * exact 404 (route/feature absent on this agent) to "feature not present"
   * without also swallowing transient 5xx. See probeOrNull().
   */
  status?: number;

  constructor(kind: ApiErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
  }
}

/**
 * House pattern for probe-and-appear methods added from v2.8 on (downloads,
 * screenInfo, media, power, powerSchedule): a 404 means the agent is too old
 * or the feature is absent, so resolve `null` and let the UI stay hidden while
 * usePoll keeps its slow cadence. EXACTLY 404 — a transient 500 still throws,
 * so a momentarily unhealthy agent does NOT read as "feature vanished".
 * Deliberately NOT retrofitted onto api.tv() (its throw-on-404 is shipped).
 */
async function probeOrNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (e: unknown) {
    if (e instanceof ApiError && e.kind === 'http' && e.status === 404) return null;
    throw e;
  }
}

/**
 * Gate an optional-feature probe on the box's advertised caps (Status.caps).
 * When `cap` is explicitly false the feature is absent, so resolve null WITHOUT
 * a request — the round-trip the caps summary exists to save. When `cap` is
 * undefined (older agent that doesn't report caps) we still run the probe, so
 * behaviour is unchanged against agents < 2.8.2. A 404 from the probe itself is
 * handled by probeOrNull, so this stays correct even if caps disagrees.
 */
function probeGated<T>(
  cap: boolean | undefined,
  probe: () => Promise<T | null>,
): Promise<T | null> {
  if (cap === false) return Promise.resolve(null);
  return probe();
}

// ---------- Client ----------

const TIMEOUT_MS = 4000;

function baseUrl(settings: Pick<Settings, 'host' | 'port'>): string {
  return `http://${settings.host}:${settings.port}`;
}

// §3b resolved-host: the host that last served each box (keyed host:port).
// Binary fetches (album art, later screen frames) must hit the SAME host the
// JSON API proved reachable, not a blind settings.host that mDNS may have
// stopped resolving under SteamOS Game Mode WiFi power-save.
const lastGoodHost = new Map<string, string>();
/** Stable identity of a poll/connection target ("host:port"). Exported as the
 *  canonical `resetKey` for usePoll: every active-box poll passes it so a box
 *  switch clears stale data instead of briefly showing the previous box's. */
export function hostKey(s: Pick<Settings, 'host' | 'port'>): string {
  return `${s.host}:${s.port}`;
}
export function resolveEffectiveHost(settings: ConnSettings): string {
  return lastGoodHost.get(hostKey(settings)) ?? settings.host;
}

// Latest capability summary each box reported on /api/status (keyed host:port),
// so the optional-feature probes can skip a request the box has said it can't
// answer without every caller threading caps down. Populated by api.status();
// empty until the first status poll of a box returns (and always empty for
// agents < 2.8.2 that don't report caps), in which case the probes fall back to
// probing — never a false skip. Mirrors the lastGoodHost cache above.
const lastCaps = new Map<string, BoxCaps>();
function cachedCaps(settings: Pick<Settings, 'host' | 'port'>): BoxCaps | undefined {
  return lastCaps.get(hostKey(settings));
}

/** Value-equality for BoxCaps (either may be undefined). Lets callers persist
 *  caps onto a box only when it actually changed, avoiding write churn. */
export function capsEqual(a?: BoxCaps, b?: BoxCaps): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.gamepad === b.gamepad &&
    a.steam === b.steam &&
    a.media === b.media &&
    a.tv === b.tv &&
    a.screen === b.screen &&
    a.power_schedule === b.power_schedule &&
    a.screensaver === b.screensaver &&
    a.couchmode === b.couchmode &&
    a.desktop === b.desktop
  );
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** base64-encode raw bytes (no reliance on btoa/Buffer, which RN may lack). */
function base64FromArrayBuffer(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const len = bytes.length;
  let out = '';
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < len ? bytes[i + 1] : 0;
    const b2 = i + 2 < len ? bytes[i + 2] : 0;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < len ? B64_ALPHABET[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < len ? B64_ALPHABET[b2 & 63] : '=';
  }
  return out;
}

/**
 * Album art for a player's current track, as a base64 `data:` URI for <Image>.
 * Fetches from the resolved host (§3b) with the bearer token (an <Image> URL
 * can't carry Authorization) and inlines the bytes, so nothing sensitive lands
 * in Fresco's disk cache. Resolves null on any failure / 404 (no art).
 */
export async function mediaArtSource(
  settings: ConnSettings,
  player: string,
  artKey: string,
): Promise<string | null> {
  const host = resolveEffectiveHost(settings);
  const url = `http://${host}:${settings.port}/api/media/art?player=${encodeURIComponent(
    player,
  )}&k=${encodeURIComponent(artKey)}`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${settings.token}` } });
    if (!res.ok) return null;
    const type = res.headers.get('Content-Type') || 'image/jpeg';
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0) return null;
    return `data:${type};base64,${base64FromArrayBuffer(buf)}`;
  } catch {
    return null;
  }
}

/**
 * Fetch one live screen-preview frame from the resolved host (§3b) with bearer
 * auth, as a base64 data: URI for <Image>. Inlined (never a raw <Image> URL)
 * because the URL can't carry the token and frames are no-store — a frame may
 * show a password prompt, so nothing is written to Fresco's disk cache. null on
 * failure or 503 (capture failed). `t` cache-busts each frame.
 */
export async function screenFrameSource(settings: ConnSettings): Promise<string | null> {
  const host = resolveEffectiveHost(settings);
  const url = `http://${host}:${settings.port}/api/screen/frame?t=${Date.now()}`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${settings.token}` } });
    if (!res.ok) return null;
    const type = res.headers.get('Content-Type') || 'image/jpeg';
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0) return null;
    return `data:${type};base64,${base64FromArrayBuffer(buf)}`;
  } catch {
    return null;
  }
}

/** One fetch attempt against a specific host. Throws ApiError on transport failure. */
async function attempt(
  host: string,
  settings: ConnSettings,
  path: string,
  opts: {
    method?: 'GET' | 'POST' | 'DELETE';
    auth?: boolean;
    timeoutMs?: number;
    body?: unknown;
  },
): Promise<Response> {
  const { method = 'GET', auth = true, timeoutMs = TIMEOUT_MS, body } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {};
    if (auth) headers.Authorization = `Bearer ${settings.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return await fetch(`${baseUrl({ host, port: settings.port })}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (e: unknown) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new ApiError('timeout', `Timed out after ${timeoutMs / 1000}s`);
    }
    throw new ApiError('unreachable', 'Box unreachable: network error');
  } finally {
    clearTimeout(timer);
  }
}

const PROBE_TIMEOUT_MS = 2500;

/**
 * Head start given to the cached-IP path before the hostname attempt joins the
 * race (see raceGet). Android mDNS resolution was measured at ~1.6s, the
 * probe + request on a live cached IP at ~40ms — so when the IP is good the
 * hostname fetch never even starts.
 */
const GET_RACE_STAGGER_MS = 250;

/**
 * Happy-Eyeballs for idempotent GETs: race the cached IP (identity-probed
 * first, so the bearer token still never goes to an unproven address) against
 * the configured hostname, staggered so the fast path usually wins alone.
 * Safe only for GETs — a double-send of a POST could run an action twice.
 * Returns the first success; if both fail, throws the hostname path's error
 * (it matches what the single-attempt flow would have reported).
 */
async function raceGet(
  settings: ConnSettings,
  path: string,
  opts: { method?: 'GET' | 'POST' | 'DELETE'; auth?: boolean; timeoutMs?: number; body?: unknown },
  fallbackIp: string,
): Promise<{ res: Response; usedHost: string }> {
  let settled = false;
  const ipPath = (async () => {
    if (!(await probeTarget(fallbackIp, settings))) {
      throw new ApiError('unreachable', 'cached IP did not answer as this box');
    }
    const res = await attempt(fallbackIp, settings, path, opts);
    return { res, usedHost: fallbackIp };
  })();
  const hostPath = (async () => {
    await new Promise((r) => setTimeout(r, GET_RACE_STAGGER_MS));
    if (settled) {
      // The IP already won; don't fire a redundant fetch.
      throw new ApiError('unreachable', 'cached IP path won');
    }
    const res = await attempt(settings.host, settings, path, opts);
    return { res, usedHost: settings.host };
  })();
  // Swallow the loser's eventual rejection so it can't surface as unhandled.
  ipPath.catch(() => {});
  hostPath.catch(() => {});
  try {
    const winner = await Promise.any([ipPath, hostPath]);
    settled = true;
    return winner;
  } catch {
    settled = true;
    // Both paths failed. Re-throw the hostname error for a familiar message.
    return await hostPath;
  }
}

/**
 * Unauthenticated identity probe: does `host` answer /api/ping AS this box
 * (see pingMatchesBox)? Never sends the bearer token. False on any failure.
 */
async function probeTarget(host: string, settings: ConnSettings): Promise<boolean> {
  try {
    const res = await attempt(host, settings, '/api/ping', {
      auth: false,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (!res.ok) return false;
    return pingMatchesBox(await res.json(), settings.host);
  } catch {
    return false;
  }
}

async function request<T>(
  settings: ConnSettings,
  path: string,
  opts: {
    method?: 'GET' | 'POST' | 'DELETE';
    auth?: boolean;
    timeoutMs?: number;
    body?: unknown;
  } = {},
): Promise<T> {
  // Cached-IP fallback: keeps the app working when mDNS breaks (SteamOS Game
  // Mode) but the box is still up. The fallback target must first prove via
  // an unauthenticated ping that it IS this box (pingMatchesBox). A DHCP
  // lease that wandered to another machine gets neither the bearer token nor
  // a misleading 401.
  const method = opts.method ?? 'GET';
  const fallback =
    settings.lastIp && settings.lastIp !== settings.host ? settings.lastIp : undefined;

  let res: Response;
  let usedHost = settings.host;
  if (method === 'GET' && fallback) {
    // Idempotent + a cached IP known: race both addresses (IP-first, see
    // raceGet). Double-delivery is harmless for a GET, and this removes the
    // ~1.6s mDNS resolution from every status poll / list fetch.
    ({ res, usedHost } = await raceGet(settings, path, opts, fallback));
  } else if (method === 'GET' || !fallback) {
    // Single known address (or non-GET without a fallback): one plain attempt.
    // No retry here: React Native's fetch reports "connection lost after the
    // request was delivered" identically to "never connected", so a re-sent
    // POST could run an action (reboot!) twice.
    res = await attempt(settings.host, settings, path, opts);
  } else {
    // Non-idempotent (POST/DELETE): pick the working target FIRST with cheap
    // ping probes, then send the request EXACTLY ONCE, never retried.
    let target = settings.host;
    if (!(await probeTarget(settings.host, settings))) {
      if (await probeTarget(fallback, settings)) target = fallback;
      // else: send to the configured host anyway and surface its real error.
    }
    usedHost = target;
    res = await attempt(target, settings, path, opts);
  }

  // Remember which host actually answered (any HTTP status proves it IS this
  // box and is reachable), so binary fetches — Steam cover art, album art, later
  // screen frames — can target the SAME host instead of a blind settings.host
  // that mDNS may have stopped resolving. (§3b resolved-host.)
  lastGoodHost.set(hostKey(settings), usedHost);

  if (res.status === 401) {
    throw new ApiError('unauthorized', 'Unauthorized: check token');
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body && typeof body.error === 'string') detail = `${detail}: ${body.error}`;
    } catch {
      // non-JSON body; keep the status line
    }
    throw new ApiError('http', detail, res.status);
  }

  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError('http', 'Invalid JSON in response');
  }
}

export const api = {
  /** Unauthenticated reachability probe. */
  ping(settings: ConnSettings): Promise<Ping> {
    return request<Ping>(settings, '/api/ping', { auth: false });
  },

  async status(settings: ConnSettings): Promise<Status> {
    const s = await request<Status>(settings, '/api/status');
    // Cache caps so the optional-feature probes can skip dead requests (see
    // lastCaps). Only overwrite when present, so a momentary old-agent reply
    // never clears a good entry.
    if (s.caps) lastCaps.set(hostKey(settings), s.caps);
    return s;
  },

  units(settings: ConnSettings): Promise<{ units: Unit[] }> {
    return request<{ units: Unit[] }>(settings, '/api/units');
  },

  journal(settings: ConnSettings, unit: string, scope: UnitScope, lines = 100): Promise<Journal> {
    const q = new URLSearchParams({
      unit,
      lines: String(lines),
      scope,
    });
    return request<Journal>(settings, `/api/journal?${q.toString()}`);
  },

  actions(settings: ConnSettings): Promise<{ actions: ActionInfo[] }> {
    return request<{ actions: ActionInfo[] }>(settings, '/api/actions');
  },

  runAction(settings: ConnSettings, id: string): Promise<ActionResult> {
    // Actions block server-side for up to 15s (e.g. `systemctl restart sddm`);
    // outlive that so a slow-but-successful action isn't reported as a timeout.
    return request<ActionResult>(settings, `/api/actions/${encodeURIComponent(id)}`, {
      method: 'POST',
      timeoutMs: 20000,
    });
  },

  // ---------- launchers ----------

  /** List discovered Steam games + user-defined custom launchers. */
  launchers(settings: ConnSettings): Promise<{ launchers: Launcher[] }> {
    return request<{ launchers: Launcher[] }>(settings, '/api/launchers');
  },

  /**
   * In-progress Steam downloads/updates. Probe-and-appear: resolves null on a
   * 404 (agent < 2.8 or no route) so the Launch tab hides the section; a 200
   * with an empty list also means "nothing pending".
   */
  downloads(
    settings: ConnSettings,
    caps: BoxCaps | undefined = cachedCaps(settings),
  ): Promise<Downloads | null> {
    return probeGated(caps?.steam, () =>
      probeOrNull(request<Downloads>(settings, '/api/downloads')));
  },

  /**
   * Image source for a Steam game's library cover art (agent >= 2.7.1). The
   * agent serves the art from the box's OWN local Steam cache, so the phone
   * never contacts Steam or any CDN — the app stays LAN-only (see PRIVACY.md).
   *
   * Auth rides as a Bearer header, which React Native's Image sends on native;
   * web <img> can't carry it, so covers fall back to the text card there. Reuses
   * the address request() last reached this box on (§3b resolved-host) so covers
   * follow the cached-IP fallback in SteamOS Game Mode instead of a dead .local
   * name; if that target is unreachable, the agent is older, or the art isn't
   * cached yet, the request fails and the tile's onError shows the text card.
   */
  steamCoverSource(settings: ConnSettings, appid: number): ImageSource {
    const host = resolveEffectiveHost(settings);
    return {
      uri: `${baseUrl({ host, port: settings.port })}/api/steam/${appid}/cover`,
      headers: { Authorization: `Bearer ${settings.token}` },
    };
  },

  /** Launch a game/app by launcher id. */
  launch(settings: ConnSettings, id: string): Promise<LaunchResult> {
    return request<LaunchResult>(settings, `/api/launchers/${encodeURIComponent(id)}`, {
      method: 'POST',
      timeoutMs: 15000,
    });
  },

  /** Add a custom launcher (a label + argv command). Returns the created row. */
  addLauncher(
    settings: ConnSettings,
    input: { label: string; cmd: string[] },
  ): Promise<Launcher> {
    return request<Launcher>(settings, '/api/launchers', {
      method: 'POST',
      body: input,
    });
  },

  /** Delete a custom launcher by id. */
  deleteLauncher(settings: ConnSettings, id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(settings, `/api/launchers/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  // ---------- TV control (probe-and-appear) ----------

  /**
   * Probe for TV control. Resolves to the active backend + adapter when the
   * agent has one (RS-232 panel or HDMI-CEC); the route 404s (ApiError kind
   * "http") on boxes without any, which the caller treats as "no TV strip".
   */
  tv(settings: ConnSettings): Promise<Tv> {
    return request<Tv>(settings, '/api/tv');
  },

  /**
   * Send a one-shot TV command. Volume ops take an optional target: "box" (the
   * box's own OS volume, the default) or "tv" (the panel/CEC backend). Power
   * ops ignore it.
   */
  tvSend(settings: ConnSettings, op: TvOp, target?: VolumeTarget): Promise<ActionResult> {
    const q = target ? `?target=${target}` : '';
    return request<ActionResult>(settings, `/api/tv/${op}${q}`, {
      method: 'POST',
      timeoutMs: 12000,
    });
  },

  /**
   * Switch the panel's input to the box's OPS slot (RS-232 panel backend only;
   * gated behind Tv.source_box). Pulls the display back to the box from any
   * other source in one tap.
   */
  tvSource(settings: ConnSettings): Promise<ActionResult> {
    return request<ActionResult>(settings, '/api/tv/source_box', {
      method: 'POST',
      timeoutMs: 12000,
    });
  },

  /**
   * Toggle the panel backlight (screen dark / lit) without touching power, so
   * the box stays running (RS-232 panel backend only; gated behind
   * Tv.screen_toggle). Toggle-only — the panel reports no readable state.
   */
  tvScreenToggle(settings: ConnSettings): Promise<ActionResult> {
    return request<ActionResult>(settings, '/api/tv/screen_toggle', {
      method: 'POST',
      timeoutMs: 12000,
    });
  },

  /**
   * Switch the display to input `id` (one of Tv.sources; RS-232 panel only).
   */
  tvSelectSource(settings: ConnSettings, id: string): Promise<ActionResult> {
    return request<ActionResult>(settings, `/api/tv/source/${encodeURIComponent(id)}`, {
      method: 'POST',
      timeoutMs: 12000,
    });
  },

  /**
   * Set the absolute volume level (0-100). Box target converges via media-key
   * steps (Game Mode OSD shows); TV target uses the RS-232 closed loop. The
   * result carries the final `level` the agent landed on.
   */
  tvSetVolume(
    settings: ConnSettings,
    level: number,
    target: VolumeTarget,
  ): Promise<ActionResult & { level?: number | null }> {
    return request<ActionResult & { level?: number | null }>(settings, '/api/tv/volume', {
      method: 'POST',
      timeoutMs: 20000,
      body: { level, target },
    });
  },

  /** Send one factory-remote key to the panel (RS-232 only; see Tv.keys). */
  tvKey(settings: ConnSettings, key: TvKey): Promise<ActionResult> {
    return request<ActionResult>(settings, `/api/tv/key/${key}`, {
      method: 'POST',
      timeoutMs: 12000,
    });
  },

  /**
   * Now-playing / transport across MPRIS players. Probe-and-appear: resolves
   * null on 404 (agent < 2.8 or no session bus) so the card hides; 200 with an
   * empty list means "nothing playing". 8 s budget matches the agent's ceiling.
   */
  media(
    settings: ConnSettings,
    caps: BoxCaps | undefined = cachedCaps(settings),
  ): Promise<Media | null> {
    return probeGated(caps?.media, () =>
      probeOrNull(request<Media>(settings, '/api/media', { timeoutMs: 8000 })));
  },

  /** One transport op on a player; `seek` carries { position_ms }. */
  mediaOp(
    settings: ConnSettings,
    player: string,
    op: MediaOp,
    body?: { position_ms: number },
  ): Promise<ActionResult> {
    return request<ActionResult>(settings, `/api/media/${encodeURIComponent(player)}/${op}`, {
      method: 'POST',
      timeoutMs: 8000,
      body,
    });
  },

  /**
   * Screen-capture capability. Probe-and-appear: resolves null on 404 (agent
   * < 2.8 or no capture path) so the preview card hides. Frames come from
   * screenFrameSource(), not this method.
   */
  screenInfo(
    settings: ConnSettings,
    caps: BoxCaps | undefined = cachedCaps(settings),
  ): Promise<ScreenInfo | null> {
    return probeGated(caps?.screen, () =>
      probeOrNull(request<ScreenInfo>(settings, '/api/screen', { timeoutMs: 8000 })));
  },

  /**
   * Sleep timer + wake schedule. Probe-and-appear: resolves null ONLY on 404
   * (agent < 2.8.1) so the rows hide; a transient 500 still throws, never
   * reading as "timer vanished".
   */
  powerSchedule(
    settings: ConnSettings,
    caps: BoxCaps | undefined = cachedCaps(settings),
  ): Promise<PowerSchedule | null> {
    return probeGated(caps?.power_schedule, () =>
      probeOrNull(request<PowerSchedule>(settings, '/api/power/schedule')));
  },

  /**
   * Aerial screensaver state. Probe-and-appear: null on 404 (agent < 2.8.4 or
   * script not installed) so the row hides. caps.screensaver === false skips
   * the request outright; undefined (older agent) still probes.
   */
  screensaver(
    settings: ConnSettings,
    caps: BoxCaps | undefined = cachedCaps(settings),
  ): Promise<Screensaver | null> {
    return probeGated(caps?.screensaver, () =>
      probeOrNull(request<Screensaver>(settings, '/api/screensaver')));
  },

  /** Start the screensaver (optionally switching theme/tier) or stop it. */
  screensaverOp(
    settings: ConnSettings,
    op: 'start' | 'stop',
    opts: { theme?: string; tier?: string } = {},
  ): Promise<{ ok: boolean; running?: boolean; starting?: boolean }> {
    return request(settings, '/api/screensaver', {
      method: 'POST',
      body: { op, ...opts },
    });
  },

  /**
   * Couch Mode displays. Probe-and-appear: null on 404 (agent < 2.9 or box
   * can't do the handoff) so the control hides. caps.couchmode === false skips
   * the request outright; undefined (older agent) still probes.
   */
  displays(
    settings: ConnSettings,
    caps: BoxCaps | undefined = cachedCaps(settings),
  ): Promise<Displays | null> {
    return probeGated(caps?.couchmode, () =>
      probeOrNull(request<Displays>(settings, '/api/displays')));
  },

  /** Enter Couch Mode: fling Game Mode onto `output` (HDR optional). */
  couchModeStart(
    settings: ConnSettings,
    output: string,
    hdr = false,
  ): Promise<{ ok: boolean }> {
    return request(settings, '/api/couch-mode', {
      method: 'POST',
      body: { output, hdr },
    });
  },

  /** Exit Couch Mode: return the box to its desktop session. */
  desktopMode(settings: ConnSettings): Promise<{ ok: boolean }> {
    return request(settings, '/api/desktop-mode', { method: 'POST' });
  },

  /** Arm a delayed suspend/poweroff. */
  powerSleep(
    settings: ConnSettings,
    delay_s: number,
    action: 'suspend' | 'poweroff',
  ): Promise<{ sleep: PowerSleep | null }> {
    return request(settings, '/api/power/sleep', { method: 'POST', body: { delay_s, action } });
  },
  /** Cancel the armed sleep timer (idempotent). */
  powerSleepCancel(settings: ConnSettings): Promise<{ sleep: null }> {
    return request(settings, '/api/power/sleep', { method: 'DELETE' });
  },

  /** Set the RTC wake alarm to an absolute epoch. */
  powerWake(settings: ConnSettings, at: number): Promise<{ wake: PowerWake | null }> {
    return request(settings, '/api/power/wake', { method: 'POST', body: { at } });
  },
  /** Clear the RTC wake alarm (idempotent). */
  powerWakeCancel(settings: ConnSettings): Promise<{ wake: null }> {
    return request(settings, '/api/power/wake', { method: 'DELETE' });
  },
};

// ---------- Formatting helpers ----------

export function humanizeUptime(s: number): string {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
