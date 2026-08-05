/**
 * One send surface for every directly-driven TV brand.
 *
 * DirectRemoteView presses buttons; it must not know whether the TV behind them
 * speaks Roku ECP (stateless HTTP) or Android TV Remote v2 (a persistent
 * mutually-authenticated TLS session). Routing lives here so adding the next
 * brand touches one file and no UI.
 *
 * Key names are the ROKU vocabulary, because that is what the remote's controls
 * were built against; the Android TV map below translates. A name absent from a
 * brand's map is refused locally rather than sent — the same
 * lookup-never-interpolate rule the tables themselves follow.
 */
import type { AtvKey, AtvOp } from './atvproto.ts';
import { AtvSession } from './androidtv.ts';
import type { DirectTv } from './model.ts';
import {
  type RokuKey,
  type RokuOp,
  type TvApp,
  rokuApps,
  rokuKey,
  rokuLaunch,
  rokuOp,
  rokuText,
} from './roku.ts';
import { WebosSession, type WebosDeps } from './webos.ts';

export type SendResult = { ok: boolean; hint?: string; error?: string };
export type { TvApp } from './roku.ts';

/**
 * Roku key name -> Android TV key name. Only keys BOTH sides implement appear;
 * the remote hides what a brand cannot do rather than sending a no-op.
 *
 * `menu` maps to Android's MENU. Roku's own "menu" is Info (the `*` key), which
 * is why the two tables disagree in name — each is faithful to its own remote.
 */
const ROKU_TO_ATV: Partial<Record<RokuKey, AtvKey>> = {
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  ok: 'ok',
  home: 'home',
  back: 'back',
  menu: 'menu',
  info: 'menu',
  play: 'play_pause',
  pause: 'play_pause',
  stop: 'stop',
  rewind: 'rewind',
  fast_forward: 'fast_forward',
  exit: 'home',
};

const ROKU_OP_TO_ATV: Partial<Record<RokuOp, AtvOp>> = {
  power_off: 'power_off',
  volume_up: 'volume_up',
  volume_down: 'volume_down',
  mute: 'mute',
};

/**
 * Live Android TV sessions, one per TV host.
 *
 * Cached because the remote channel is expensive to establish (a TLS handshake
 * plus a multi-frame handshake measured ~1s) and because the TV drops a channel
 * whose keepalive pings go unanswered — so the session must outlive a single
 * press. Keyed by host: a re-paired TV at the same address reuses the entry,
 * and `dropAtvSession` clears it when credentials change or the TV is removed.
 */
const atvSessions = new Map<string, AtvSession>();

/** Build (or reuse) the session for a paired Android TV. */
function atvSessionFor(tv: DirectTv, deps: AtvRuntime): AtvSession | null {
  if (!tv.atv) return null;
  const existing = atvSessions.get(tv.host);
  if (existing) return existing;
  const session = new AtvSession(
    tv.host,
    { certPem: tv.atv.certPem, keyPem: tv.atv.keyPem, modulusHex: tv.atv.modulusHex },
    { connect: deps.makeConnect(tv.atv.caPem), sha256: deps.sha256 },
  );
  atvSessions.set(tv.host, session);
  return session;
}

/** Live LG webOS sessions, one per host — same reasoning as atvSessions. */
const webosSessions = new Map<string, WebosSession>();

function webosSessionFor(tv: DirectTv, rt: AtvRuntime): WebosSession | null {
  if (!tv.webos) return null;
  const existing = webosSessions.get(tv.host);
  if (existing) return existing;
  const session = new WebosSession(
    tv.host,
    rt.webos,
    { caPem: tv.webos.caPem, clientKey: tv.webos.clientKey },
  );
  webosSessions.set(tv.host, session);
  return session;
}

/** Drop any cached session for a host (TV removed, or re-paired). Covers every
 *  brand — the name keeps its atv history but it is the tv-wide dropper. */
export function dropAtvSession(host: string): void {
  const a = atvSessions.get(host);
  atvSessions.delete(host);
  a?.close();
  const w = webosSessions.get(host);
  webosSessions.delete(host);
  w?.close();
}

/**
 * The platform pieces, injected so this module — and everything under it —
 * stays loadable by the bare-Node test runner. The app passes the
 * react-native-tcp-socket implementations from ./atvnative.ts.
 */
export type AtvRuntime = {
  makeConnect: (caPem: string) => import('./atvproto.ts').AtvConnect;
  sha256: (d: Uint8Array) => Promise<Uint8Array>;
  /** webOS transport deps (fetchPeerCert + raw TLS + ws crypto). */
  webos: WebosDeps;
};

export async function sendKey(tv: DirectTv, k: RokuKey, rt: AtvRuntime): Promise<SendResult> {
  if (tv.brand === 'roku') return rokuKey(tv.host, k);
  if (tv.brand === 'webos') {
    // The webOS key table uses the SAME roku/panel vocabulary (up/ok/menu/...),
    // so the name passes straight through; the session maps it to the pointer
    // button name. A key webOS lacks is refused inside session.key().
    const s = webosSessionFor(tv, rt);
    if (!s) return { ok: false, error: 'this TV is not paired' };
    const r = await s.key(k);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }
  const mapped = ROKU_TO_ATV[k];
  if (!mapped) return { ok: false, error: `key ${k} is not available on this TV` };
  const session = atvSessionFor(tv, rt);
  if (!session) return { ok: false, error: 'this TV is not paired' };
  try {
    await session.sendKey(mapped);
    // NOTE: fire-and-forget. Android TV acknowledges nothing, so ok:true means
    // "the frame was written", never "the TV acted" — KI-031's exact trap.
    return { ok: true };
  } catch (e) {
    dropAtvSession(tv.host); // force a fresh handshake on the next press
    return { ok: false, error: String(e) };
  }
}

export async function sendOp(tv: DirectTv, o: RokuOp, rt: AtvRuntime): Promise<SendResult> {
  if (tv.brand === 'roku') return rokuOp(tv.host, o);
  // Neither Android TV nor webOS has a discrete power-ON over this channel (the
  // service is not listening while the set is off; webOS wakes only via WoL,
  // which needs a box relay). Reported honestly rather than sent into the void.
  if (o === 'power_on') {
    return { ok: false, error: 'this TV cannot be powered on from the app' };
  }
  if (tv.brand === 'webos') {
    // WEBOS_OP_URI covers power_off/volume_up/volume_down; mute is not ported
    // (the agent tracks mute state, deferred). session.op refuses the rest.
    const s = webosSessionFor(tv, rt);
    if (!s) return { ok: false, error: 'this TV is not paired' };
    const r = await s.op(o);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }
  const mapped = ROKU_OP_TO_ATV[o];
  if (!mapped) return { ok: false, error: `${o} is not available on this TV` };
  const session = atvSessionFor(tv, rt);
  if (!session) return { ok: false, error: 'this TV is not paired' };
  try {
    await session.sendOp(mapped);
    return { ok: true };
  } catch (e) {
    dropAtvSession(tv.host);
    return { ok: false, error: String(e) };
  }
}

export async function sendText(tv: DirectTv, text: string, _rt: AtvRuntime): Promise<SendResult> {
  if (tv.brand === 'roku') return rokuText(tv.host, text);
  // Android TV text entry is a separate IME message the agent also leaves
  // unimplemented; the remote hides the keyboard button for this brand rather
  // than offering one that silently does nothing.
  return { ok: false, error: 'text entry is not supported on this TV yet' };
}

/** Whether the on-TV keyboard button should be offered for this TV. */
export function supportsText(tv: DirectTv): boolean {
  return tv.brand === 'roku';
}

/** Whether a power-ON control should be offered. */
export function supportsPowerOn(tv: DirectTv): boolean {
  return tv.brand === 'roku';
}

/**
 * Whether this TV can list its OWN installed apps. Roku (ECP /query/apps) and LG
 * webOS (SSAP listLaunchPoints) can; Google TV's Remote v2 protocol has no app
 * enumeration, so it gets no grid (a curated catalog would be a separate,
 * clearly-labelled feature, not "the TV's apps").
 */
export function supportsApps(tv: DirectTv): boolean {
  return tv.brand === 'roku' || tv.brand === 'webos';
}

/** The TV's installed apps. Never throws; an unreachable/unsupported TV -> []. */
export async function listApps(tv: DirectTv, rt: AtvRuntime): Promise<TvApp[]> {
  if (tv.brand === 'roku') return rokuApps(tv.host);
  if (tv.brand === 'webos') {
    const s = webosSessionFor(tv, rt);
    return s ? s.listApps() : [];
  }
  return [];
}

/** Launch an installed app by the id from listApps (never a client string). */
export async function launchApp(tv: DirectTv, id: string, rt: AtvRuntime): Promise<SendResult> {
  if (tv.brand === 'roku') return rokuLaunch(tv.host, id);
  if (tv.brand === 'webos') {
    const s = webosSessionFor(tv, rt);
    if (!s) return { ok: false, error: 'this TV is not paired' };
    const r = await s.launchApp(id);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }
  return { ok: false, error: 'this TV cannot launch apps from the app' };
}
