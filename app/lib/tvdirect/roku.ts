/**
 * Roku ECP client, spoken by the PHONE directly. ZERO runtime imports.
 *
 * Roku is the one brand the app can drive with no native module and no box:
 * ECP is plain unauthenticated HTTP on port 8060, there is no pairing, and a
 * Roku stays reachable in standby (so power-on is a keypress, not Wake-on-LAN).
 * Every other brand needs a raw TLS socket the app does not have — see
 * docs/memory/project_remote-only-mode.md for that ladder.
 *
 * THE TABLES BELOW ARE COPIED VERBATIM from the agent's Roku backend
 * (agent/couchsided.py: _ROKU_OP_KEY :8752, _ROKU_KEYS :8759). They are
 * duplicated rather than derived because there is no agent in this mode to ask
 * — which makes them a divergence risk, so lib/__tests__/tvdirect.test.ts pins
 * both tables and CI fails if one drifts.
 *
 * Import-free so the bare-Node runner can exercise it against a stub server:
 * global fetch/AbortController exist in both RN 0.86 and Node 22.
 */

/** Roku's External Control Protocol port. Not configurable — it is fixed by Roku. */
export const ROKU_PORT = 8060;

/** Request timeout. Matches the agent's 4s (couchsided.py:8778-8796): long
 *  enough for a TV waking its network stack, short enough that a dead host does
 *  not freeze a held D-pad. */
const TIMEOUT_MS = 4000;

/** Unified TV ops -> ECP keys. VERBATIM from _ROKU_OP_KEY (couchsided.py:8752). */
export const ROKU_OP_KEY = {
  power_off: 'PowerOff',
  power_on: 'PowerOn',
  volume_up: 'VolumeUp',
  volume_down: 'VolumeDown',
  mute: 'VolumeMute',
} as const;
export type RokuOp = keyof typeof ROKU_OP_KEY;

/**
 * Remote keys -> ECP keys. VERBATIM from _ROKU_KEYS (couchsided.py:8759).
 *
 * The agent's own comment explains the collisions, and they are kept rather
 * than "fixed": Roku has no distinct pause/stop (Play toggles) and no menu key
 * (Info is the "*" options key). Inventing separate keys here would send
 * something the TV does not implement.
 */
export const ROKU_KEYS = {
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  ok: 'Select',
  menu: 'Info',
  home: 'Home',
  back: 'Back',
  exit: 'Home',
  info: 'Info',
  play: 'Play',
  pause: 'Play',
  stop: 'Play',
  rewind: 'Rev',
  fast_forward: 'Fwd',
} as const;
export type RokuKey = keyof typeof ROKU_KEYS;

export type RokuResult = {
  ok: boolean;
  /** Set when a reachable Roku REFUSED control (HTTP 403), so the UI can explain
   *  the "Control by mobile apps" setting instead of showing a silent failure.
   *  Same hint string the agent returns, so both remote surfaces share copy. */
  hint?: 'roku_control_disabled';
  /** Present on failure, for logs — never rendered raw. */
  error?: string;
};

function base(host: string): string {
  return `http://${host}:${ROKU_PORT}`;
}

/**
 * One ECP request. Never throws: a dead TV must return a failed result, not
 * reject a promise into a press handler (the repo's degrade-closed rule).
 */
async function ecp(
  host: string,
  path: string,
  method: 'GET' | 'POST',
  timeoutMs: number = TIMEOUT_MS,
): Promise<{ ok: boolean; status: number; body: string; error?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base(host)}${path}`, {
      method,
      // ECP wants a POST with an EMPTY body; some stacks omit Content-Length
      // without an explicit body and Roku then waits. Matches the agent's
      // data=b"" (couchsided.py:8778-8796).
      body: method === 'POST' ? '' : undefined,
      signal: ctrl.signal,
    });
    const body = res.ok ? await res.text() : '';
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: '', error: String(e) };
  } finally {
    clearTimeout(timer);
  }
}

function result(r: { ok: boolean; status: number; error?: string }): RokuResult {
  if (r.ok) return { ok: true };
  // 403 = the TV is up and deliberately refusing app control. Distinct from
  // unreachable, and the only failure with an action the user can take.
  if (r.status === 403) return { ok: false, hint: 'roku_control_disabled' };
  return { ok: false, error: r.error ?? `HTTP ${r.status}` };
}

/** Send a remote key. An id outside ROKU_KEYS is refused locally — the same
 *  lookup-never-interpolate rule the agent applies to /api/tv/key/<k>. */
export async function rokuKey(host: string, key: RokuKey): Promise<RokuResult> {
  const ecpKey = ROKU_KEYS[key];
  if (!ecpKey) return { ok: false, error: 'unknown key' };
  return result(await ecp(host, `/keypress/${ecpKey}`, 'POST'));
}

/** Send a unified TV op (power/volume/mute). */
export async function rokuOp(host: string, op: RokuOp): Promise<RokuResult> {
  const ecpKey = ROKU_OP_KEY[op];
  if (!ecpKey) return { ok: false, error: 'unknown op' };
  return result(await ecp(host, `/keypress/${ecpKey}`, 'POST'));
}

/**
 * Type a string on the TV, one Lit_ keypress per character (the only text
 * mechanism ECP has). Aborts on the first failure like the agent does — half a
 * search query landing is worse than none, because the user cannot see which
 * half made it.
 *
 * Characters are percent-encoded whole, including '/' and '?', so nothing in
 * the text can alter the request path. encodeURIComponent leaves !'()*~ alone,
 * which are literal-safe in a path segment, and Roku accepts them raw.
 */
export async function rokuText(host: string, text: string): Promise<RokuResult> {
  for (const ch of Array.from(text)) {
    const r = await rokuKey0(host, `Lit_${encodeURIComponent(ch)}`);
    if (!r.ok) return r;
  }
  return { ok: true };
}

/** Internal: send an already-resolved ECP key name. Not exported — callers go
 *  through the tables so a client-chosen string can never become a key. */
async function rokuKey0(host: string, ecpKey: string): Promise<RokuResult> {
  return result(await ecp(host, `/keypress/${ecpKey}`, 'POST'));
}

export type RokuInfo = {
  /** The TV's own friendly name, for the device list. */
  name: string;
  model: string;
};

/**
 * Identify a host as a Roku, for the ADD flow. Returns null when it is not one
 * — the caller shows "no Roku answered" rather than adding a device that will
 * never respond. Same probe the agent uses to register (GET /query/device-info).
 *
 * XML is matched with a tag regex rather than parsed: RN has no DOMParser, the
 * two fields wanted are flat text nodes, and a real parser for this would be a
 * dependency. A missing field falls back rather than failing the identify —
 * being a Roku is what this proves; the name is cosmetic.
 */
export async function rokuIdentify(
  host: string,
  // Overridable for the LAN sweep: 4s x 254 dead hosts is a minute of nothing,
  // while a live Roku answers in milliseconds. The ADD-by-IP flow keeps the
  // patient default (a TV waking its network stack deserves the wait).
  timeoutMs: number = TIMEOUT_MS,
): Promise<RokuInfo | null> {
  const r = await ecp(host, '/query/device-info', 'GET', timeoutMs);
  if (!r.ok || !r.body) return null;
  const tag = (name: string): string => {
    const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(r.body);
    return m ? m[1].trim() : '';
  };
  const model = tag('model-name') || tag('model-number');
  // A response that carries neither a Roku udn nor a model is not a Roku that
  // answered — it is something else on :8060. Refuse it.
  if (!model && !tag('udn')) return null;
  const name = tag('user-device-name') || tag('friendly-device-name') || model || host;
  return { name, model };
}
