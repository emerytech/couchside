/**
 * Demo mode: canned data behind the exact same contract types as the live
 * agent, so App Review (and curious users without a Linux box) can exercise
 * every screen. Active when the configured host is exactly "demo"
 * (trimmed, case-insensitive) — see isDemoHost().
 */
import type {
  ActionInfo,
  ActionResult,
  Journal,
  Ping,
  Status,
  Unit,
  UnitScope,
} from './api';

/** True when a host string selects demo mode. */
export function isDemoHost(host: string): boolean {
  return host.trim().toLowerCase() === 'demo';
}

/** True when the given settings select demo mode. */
export function isDemo(settings: { host: string }): boolean {
  return isDemoHost(settings.host);
}

const AGENT_VERSION = '2.0.0';

// Fixed boot instant so uptime counts up across polls (starts at ~3d 4h).
const BOOT_MS = Date.now() - (3 * 86400 + 4 * 3600 + 27 * 60) * 1000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function demoPing(): Promise<Ping> {
  return Promise.resolve({ ok: true, app: 'couchpilot-agent (demo)', version: AGENT_VERSION });
}

export function demoStatus(): Promise<Status> {
  const now = Date.now();
  // CPU temp wanders smoothly between 50 and 60 °C.
  const t = now / 1000;
  const cpuTemp = 55 + 4 * Math.sin(t / 45) + Math.sin(t / 7);
  return Promise.resolve({
    hostname: 'demo-box',
    time: Math.floor(now / 1000),
    uptime_s: Math.floor((now - BOOT_MS) / 1000),
    load: [0.42, 0.51, 0.48],
    cpu_temp_c: Math.round(cpuTemp * 10) / 10,
    mem: { total_mb: 15872, used_mb: 6240, available_mb: 9632 },
    disks: [
      { mount: '/', total_gb: 237.5, used_gb: 96.4, free_gb: 141.1, pct: 41 },
      { mount: '/home', total_gb: 931.5, used_gb: 512.3, free_gb: 419.2, pct: 55 },
    ],
    agent_version: AGENT_VERSION,
  });
}

const DEMO_UNITS: Unit[] = [
  {
    name: 'sddm.service',
    scope: 'system',
    active: 'active',
    sub: 'running',
    description: 'Simple Desktop Display Manager',
  },
  {
    name: 'couchpilot.service',
    scope: 'system',
    active: 'active',
    sub: 'running',
    description: 'CouchPilot agent',
  },
  {
    name: 'media-scraper.service',
    scope: 'user',
    active: 'inactive',
    sub: 'dead',
    description: 'Nightly media metadata scraper',
  },
];

export function demoUnits(): Promise<{ units: Unit[] }> {
  return Promise.resolve({ units: DEMO_UNITS.map((u) => ({ ...u })) });
}

function journalLines(unit: string): string[] {
  const short = unit.replace(/\.service$/, '');
  if (short === 'sddm') {
    return [
      'Starting Simple Desktop Display Manager...',
      'Initializing X11 display server on :0',
      'Loading theme "breeze"',
      'Greeter session started for seat0',
      'Session opened for user deck',
      'Started Simple Desktop Display Manager.',
      'DisplayServer started on vt1',
      'Socket server started at /tmp/sddm-auth',
      'Authentication for user deck successful',
      'Session "gamescope-session" starting',
      'Running display setup script',
      'Greeter stopped, handing off to session',
      'Session worker started',
      'Compositor handoff complete',
      'Watching seat0 for session changes',
      'User session healthy (heartbeat ok)',
      'VT switch request handled (vt1 -> vt1)',
      'Idle watchdog armed (no-op, session active)',
      'Periodic session check: OK',
      'Periodic session check: OK',
    ];
  }
  if (short === 'couchpilot') {
    return [
      'couchpilot-agent 2.0.0 starting',
      'Loaded config from /etc/couchpilot/config.json',
      'Token loaded from /etc/couchpilot/token',
      'Listening on 0.0.0.0:8787',
      'GET /api/ping 200 (0.4 ms)',
      'GET /api/status 200 (3.1 ms)',
      'GET /api/units 200 (7.8 ms)',
      'Gamepad websocket client connected',
      'Virtual gamepad created: CouchPilot Pad',
      'GET /api/status 200 (2.9 ms)',
      'GET /api/journal?unit=sddm.service 200 (11.2 ms)',
      'GET /api/status 200 (3.0 ms)',
      'Gamepad websocket client disconnected',
      'Virtual gamepad released',
      'GET /api/status 200 (2.8 ms)',
      'GET /api/units 200 (7.5 ms)',
      'GET /api/status 200 (3.2 ms)',
      'GET /api/actions 200 (0.6 ms)',
      'GET /api/status 200 (2.7 ms)',
      'GET /api/status 200 (3.0 ms)',
    ];
  }
  return [
    `Starting ${short}...`,
    'Scanning library directories',
    'Found 148 items to inspect',
    'Fetching metadata batch 1/8',
    'Fetching metadata batch 2/8',
    'Rate limit reached, backing off 30s',
    'Fetching metadata batch 3/8',
    'Fetching metadata batch 4/8',
    'Artwork cache hit ratio: 92%',
    'Fetching metadata batch 5/8',
    'Fetching metadata batch 6/8',
    'Fetching metadata batch 7/8',
    'Fetching metadata batch 8/8',
    'Wrote 12 updated entries',
    'Pruned 3 stale cache files',
    'Library scan complete in 4m12s',
    `${short}.service: Deactivated successfully.`,
    `Finished ${short}.`,
    `${short}.service: Consumed 18.2s CPU time.`,
    'Next scheduled run: 03:00',
  ];
}

export function demoJournal(unit: string, scope: UnitScope, lines = 100): Promise<Journal> {
  const now = new Date();
  const all = journalLines(unit).map((msg, i, arr) => {
    const ts = new Date(now.getTime() - (arr.length - 1 - i) * 47_000);
    const hh = String(ts.getHours()).padStart(2, '0');
    const mm = String(ts.getMinutes()).padStart(2, '0');
    const ss = String(ts.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss} demo-box ${unit.replace(/\.service$/, '')}[512]: ${msg}`;
  });
  return Promise.resolve({ unit, scope, lines: all.slice(-lines) });
}

const DEMO_ACTIONS: { info: ActionInfo; cmd: string }[] = [
  {
    info: {
      id: 'restart-sddm',
      label: 'Restart Session',
      description: 'Restart display session — fixes a wedged compositor (black screen)',
      danger: 'high',
    },
    cmd: 'sudo systemctl restart sddm',
  },
  {
    info: {
      id: 'reboot',
      label: 'Reboot',
      description: 'Reboot the box',
      danger: 'high',
    },
    cmd: 'sudo systemctl reboot',
  },
  {
    info: {
      id: 'poweroff',
      label: 'Power Off',
      description: 'Power off the box',
      danger: 'high',
    },
    cmd: 'sudo systemctl poweroff',
  },
];

export function demoActions(): Promise<{ actions: ActionInfo[] }> {
  return Promise.resolve({ actions: DEMO_ACTIONS.map((a) => ({ ...a.info })) });
}

export async function demoRunAction(id: string): Promise<ActionResult> {
  await delay(300);
  const action = DEMO_ACTIONS.find((a) => a.info.id === id);
  const cmd = action ? action.cmd : id;
  return {
    ok: true,
    exit_code: 0,
    stdout: `[demo] ${cmd}\n`,
    stderr: '',
    duration_ms: 300,
  };
}
