/**
 * Typed client for the Rescue Agent API (contract v1).
 * Base URL: http://<host>:<port>  (default bazzite.local:8787)
 */
import { Settings } from './settings';

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

// The agent-side watchlist allowlist for /api/journal.
export const WATCHLIST: { unit: string; scope: UnitScope; short: string }[] = [
  { unit: 'sddm.service', scope: 'system', short: 'sddm' },
  { unit: 'htpc-nosleep.service', scope: 'system', short: 'nosleep' },
  { unit: 'greenboot-healthcheck.service', scope: 'system', short: 'greenboot' },
  { unit: 'rescue-agent.service', scope: 'system', short: 'agent' },
  { unit: 'skyscrape.service', scope: 'user', short: 'skyscrape' },
];

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
  settings: Settings,
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
  ping(settings: Settings): Promise<Ping> {
    return request<Ping>(settings, '/api/ping', { auth: false });
  },

  status(settings: Settings): Promise<Status> {
    return request<Status>(settings, '/api/status');
  },

  units(settings: Settings): Promise<{ units: Unit[] }> {
    return request<{ units: Unit[] }>(settings, '/api/units');
  },

  journal(settings: Settings, unit: string, scope: UnitScope, lines = 100): Promise<Journal> {
    const q = new URLSearchParams({
      unit,
      lines: String(lines),
      scope,
    });
    return request<Journal>(settings, `/api/journal?${q.toString()}`);
  },

  actions(settings: Settings): Promise<{ actions: ActionInfo[] }> {
    return request<{ actions: ActionInfo[] }>(settings, '/api/actions');
  },

  runAction(settings: Settings, id: string): Promise<ActionResult> {
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
