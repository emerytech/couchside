/**
 * Typed client for the CouchPilot agent API (contract v1).
 * Base URL: http://<host>:<port>  (default port 8787)
 *
 * Demo mode: when the configured host is "demo" (see lib/demo.ts), every
 * method returns canned data without touching the network.
 */
import {
  demoActions,
  demoJournal,
  demoPing,
  demoRunAction,
  demoStatus,
  demoUnits,
  isDemo,
} from './demo';
import { Settings } from './settings';

/** The subset of Settings the API client actually needs. */
export type ConnSettings = Pick<Settings, 'host' | 'port' | 'token'>;

// ---------- Contract types ----------

export type Ping = {
  ok: boolean;
  app: string;
  version: string;
};

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

async function request<T>(
  settings: ConnSettings,
  path: string,
  opts: { method?: 'GET' | 'POST'; auth?: boolean; timeoutMs?: number } = {},
): Promise<T> {
  const { method = 'GET', auth = true, timeoutMs = TIMEOUT_MS } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    const headers: Record<string, string> = {};
    if (auth) headers.Authorization = `Bearer ${settings.token}`;
    res = await fetch(`${baseUrl(settings)}${path}`, {
      method,
      headers,
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
    if (isDemo(settings)) return demoPing();
    return request<Ping>(settings, '/api/ping', { auth: false });
  },

  status(settings: ConnSettings): Promise<Status> {
    if (isDemo(settings)) return demoStatus();
    return request<Status>(settings, '/api/status');
  },

  units(settings: ConnSettings): Promise<{ units: Unit[] }> {
    if (isDemo(settings)) return demoUnits();
    return request<{ units: Unit[] }>(settings, '/api/units');
  },

  journal(settings: ConnSettings, unit: string, scope: UnitScope, lines = 100): Promise<Journal> {
    if (isDemo(settings)) return demoJournal(unit, scope, lines);
    const q = new URLSearchParams({
      unit,
      lines: String(lines),
      scope,
    });
    return request<Journal>(settings, `/api/journal?${q.toString()}`);
  },

  actions(settings: ConnSettings): Promise<{ actions: ActionInfo[] }> {
    if (isDemo(settings)) return demoActions();
    return request<{ actions: ActionInfo[] }>(settings, '/api/actions');
  },

  runAction(settings: ConnSettings, id: string): Promise<ActionResult> {
    if (isDemo(settings)) return demoRunAction(id);
    // Actions block server-side for up to 15s (e.g. `systemctl restart sddm`);
    // outlive that so a slow-but-successful action isn't reported as a timeout.
    return request<ActionResult>(settings, `/api/actions/${encodeURIComponent(id)}`, {
      method: 'POST',
      timeoutMs: 20000,
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
