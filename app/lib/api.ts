/**
 * Typed client for the Couchside agent API (contract v1).
 * Base URL: http://<host>:<port>  (default port 8787)
 */
import { Settings } from './settings';

/** The subset of Settings the API client actually needs. */
export type ConnSettings = Pick<Settings, 'host' | 'port' | 'token' | 'lastIp'>;

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
 * Does this ping body identify OUR box? Requires the agent family, and — when
 * both sides know a hostname (box.host is an mDNS name and the agent reports
 * host, >= 2.3) — a hostname match. Guards the cached-IP fallback: a DHCP
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

export type Status = {
  hostname: string;
  time: number;
  uptime_s: number;
  load: [number, number, number];
  cpu_temp_c: number | null;
  mem: { total_mb: number; used_mb: number; available_mb: number };
  disks: DiskInfo[];
  agent_version: string;
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
  /** Steam appid, present for kind "steam" — used for library cover art. */
  appid?: number;
};

export type LaunchResult = {
  ok: boolean;
  /** Present when ok is false. */
  error?: string;
};

// ---------- Errors ----------

export type ApiErrorKind = 'unreachable' | 'unauthorized' | 'http' | 'timeout';

export class ApiError extends Error {
  kind: ApiErrorKind;

  constructor(kind: ApiErrorKind, message: string) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
  }
}

// ---------- Client ----------

const TIMEOUT_MS = 4000;

function baseUrl(settings: Pick<Settings, 'host' | 'port'>): string {
  return `http://${settings.host}:${settings.port}`;
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
    throw new ApiError('unreachable', 'Box unreachable — network error');
  } finally {
    clearTimeout(timer);
  }
}

const PROBE_TIMEOUT_MS = 2500;

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
  // an unauthenticated ping that it IS this box (pingMatchesBox) — a DHCP
  // lease that wandered to another machine gets neither the bearer token nor
  // a misleading 401.
  const method = opts.method ?? 'GET';
  const fallback =
    settings.lastIp && settings.lastIp !== settings.host ? settings.lastIp : undefined;

  let res: Response;
  if (method === 'GET' || !fallback) {
    try {
      res = await attempt(settings.host, settings, path, opts);
    } catch (e: unknown) {
      // Only idempotent GETs may re-send after a transport failure — React
      // Native's fetch reports "connection lost after the request was
      // delivered" identically to "never connected", so a re-sent POST could
      // run an action (reboot!) twice.
      const retriable =
        e instanceof ApiError && (e.kind === 'unreachable' || e.kind === 'timeout');
      if (retriable && fallback && method === 'GET' && (await probeTarget(fallback, settings))) {
        res = await attempt(fallback, settings, path, opts);
      } else {
        throw e;
      }
    }
  } else {
    // Non-idempotent (POST/DELETE): pick the working target FIRST with cheap
    // ping probes, then send the request EXACTLY ONCE — never retried.
    let target = settings.host;
    if (!(await probeTarget(settings.host, settings))) {
      if (await probeTarget(fallback, settings)) target = fallback;
      // else: send to the configured host anyway and surface its real error.
    }
    res = await attempt(target, settings, path, opts);
  }

  if (res.status === 401) {
    throw new ApiError('unauthorized', 'Unauthorized — check token');
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body && typeof body.error === 'string') detail = `${detail}: ${body.error}`;
    } catch {
      // non-JSON body; keep the status line
    }
    throw new ApiError('http', detail);
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

  status(settings: ConnSettings): Promise<Status> {
    return request<Status>(settings, '/api/status');
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
