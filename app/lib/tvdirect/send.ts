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
import { type RokuKey, type RokuOp, rokuKey, rokuOp, rokuText } from './roku.ts';

export type SendResult = { ok: boolean; hint?: string; error?: string };

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

/** Drop a cached session (TV removed, or re-paired with new credentials). */
export function dropAtvSession(host: string): void {
  const s = atvSessions.get(host);
  atvSessions.delete(host);
  s?.close();
}

/**
 * The platform pieces, injected so this module — and everything under it —
 * stays loadable by the bare-Node test runner. The app passes the
 * react-native-tcp-socket implementations from ./atvnative.ts.
 */
export type AtvRuntime = {
  makeConnect: (caPem: string) => import('./atvproto.ts').AtvConnect;
  sha256: (d: Uint8Array) => Promise<Uint8Array>;
};

export async function sendKey(tv: DirectTv, k: RokuKey, rt: AtvRuntime): Promise<SendResult> {
  if (tv.brand === 'roku') return rokuKey(tv.host, k);
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
  // Android TV has no discrete power-ON over this channel: the remote service
  // is not listening while the set is off. Reported honestly rather than sent
  // into the void.
  if (o === 'power_on') {
    return { ok: false, error: 'this TV cannot be powered on from the app' };
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
