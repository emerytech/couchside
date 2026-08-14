/**
 * LAN box discovery. Two independent probes run in parallel and their results
 * merge by IP:
 *
 *  1. An HTTP sweep of the phone's /24 for the agent's unauthenticated
 *     GET /api/ping. This is the RELIABLE path — plain TCP/HTTP is the one
 *     thing iOS reliably allows on the local network once the Local Network
 *     permission is granted (proven on-device: the app reaches a box by IP and
 *     reads its version, while every UDP probe comes back empty).
 *  2. A UDP broadcast + unicast probe (agent >= 2.9.12 answers it). Fast — a
 *     couple of datagrams — and works on Android, so it's kept as a quick path.
 *     Silently contributes nothing where the platform blocks UDP.
 *
 * Reveals existence only — pairing still needs the PIN shown on the box's own
 * screen (see api.pairStart/pairFinish).
 */
import { Buffer } from 'buffer';
import * as Network from 'expo-network';

import { DEFAULT_PORT } from './settings';

// Native module; require in a try/catch so a build predating the dependency
// disables the UDP probe instead of crashing at startup. The HTTP sweep does
// not need it, so discovery still works without it.
// react-native-udp does `module.exports = UdpSockets` AND `export default`, so
// depending on interop `.default` may be undefined and the module itself is the
// dgram object — accept either.
let dgram: typeof import('react-native-udp').default | null = null;
try {
  const udp = require('react-native-udp');
  dgram = (udp && (udp.default ?? udp)) || null;
} catch {
  dgram = null;
}

/** Discovery no longer depends on the native UDP module — the HTTP sweep works
 * on any build — so scanning is always offered. */
export const scanAvailable = true;

const PROBE = 'COUCHSIDE_DISCOVER?';

export type FoundBox = {
  /** Short hostname the box reports (display label). */
  name: string;
  /** mDNS name (e.g. steamdeck.local) for the stored host. */
  host: string;
  /** The IP the box actually answered on (the direct-connect fallback). */
  ip: string;
  /** The box's HTTP/agent port. */
  port: number;
  /** Agent version (so the UI can flag a box too old to PIN-pair). */
  version: string;
  /**
   * TLS advert (agent >= P2): the HTTPS port + DER-cert SHA-256 the box announced
   * on /api/ping / the UDP reply. Present ONLY as a validated pair. Used to pin a
   * discovered box at pair time. NOTE the trust: unlike a QR fp (read off the box's
   * own screen), this fp arrives over the LAN — TOFU, i.e. it stops a PASSIVE
   * eavesdropper but not an active MITM present at first pairing.
   */
  tlsPort?: number;
  fp?: string;
};

/** Extract + validate a box's advertised TLS pin fields from a ping/UDP reply. */
export function readTlsAdvert(d: Record<string, unknown>): { tlsPort?: number; fp?: string } {
  const p = d.tls_port;
  const f = typeof d.tls_fp === 'string' ? d.tls_fp.toLowerCase() : '';
  if (typeof p === 'number' && Number.isInteger(p) && p >= 1 && p <= 65535 && /^[0-9a-f]{64}$/.test(f)) {
    return { tlsPort: p, fp: f };
  }
  return {};
}

/**
 * The device's own LAN IPv4, used to derive the /24 to sweep. Best-effort —
 * resolves undefined if expo-network can't read a usable address.
 */
export async function selfIp(): Promise<string | undefined> {
  try {
    const ip = await Network.getIpAddressAsync();
    return typeof ip === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(ip) && ip !== '0.0.0.0'
      ? ip
      : undefined;
  } catch {
    return undefined;
  }
}

/** The "x.y.z." prefix of `ip`'s /24, or null when unusable. */
function subnetBase(ip?: string): string | null {
  if (!ip) return null;
  const m = /^(\d+)\.(\d+)\.(\d+)\.\d+$/.exec(ip);
  return m ? `${m[1]}.${m[2]}.${m[3]}.` : null;
}

/** The /24 directed broadcast for a LAN IP, plus the global broadcast. */
function broadcastTargets(ip?: string): string[] {
  const t: string[] = [];
  const base = subnetBase(ip);
  if (base) t.push(`${base}255`);
  t.push('255.255.255.255');
  return Array.from(new Set(t));
}

/**
 * Ask one host whether it's a Couchside agent via the unauthenticated
 * GET /api/ping. Resolves the box or null. Never throws.
 */
async function pingHost(ip: string, port: number, timeoutMs: number): Promise<FoundBox | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${ip}:${port}/api/ping`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const d = await res.json();
    if (!d || d.app !== 'couchside-agent') return null;
    const short = typeof d.host === 'string' && d.host ? d.host : ip;
    return {
      name: short,
      // Prefer the mDNS name for the stored host (survives DHCP changes), but
      // fall back to the IP we actually reached it on.
      host: typeof d.host === 'string' && d.host ? `${d.host}.local` : ip,
      ip,
      port,
      version: typeof d.version === 'string' ? d.version : '',
      ...readTlsAdvert(d),
    };
  } catch {
    return null; // unreachable / not an agent / timed out
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One-shot-per-IP reporter for `onFound`. Dedupe lives HERE, not in callers.
 *
 * Two duplicate sources, both real:
 *  1. udpProbe sends the same probe to the DIRECTED broadcast AND to
 *     255.255.255.255 (see broadcastTargets + the send loop below). A box on
 *     this /24 receives both datagrams and answers TWICE. The Map keyed by IP
 *     silently swallowed that; reporting per datagram without a guard would
 *     double-fire for every same-subnet box — the common case, not an edge one.
 *  2. The HTTP sweep and the UDP probe can both see the same box, arriving down
 *     two independent code paths.
 * Every caller would have to reimplement exactly this to avoid rendering one box
 * twice, so it belongs next to the merge policy it mirrors (scanForBoxes).
 *
 * It also swallows anything the callback throws: onFound runs INSIDE a sweep
 * worker, so a throwing callback would reject the Promise.all and destroy the
 * whole scan — including results already in hand.
 */
function makeReporter(
  onFound?: (box: FoundBox) => void,
  signal?: { aborted: boolean },
): (box: FoundBox) => void {
  if (!onFound) return () => {};
  const seen = new Set<string>();
  return (box) => {
    if (signal?.aborted) return; // torn down: never call back
    if (seen.has(box.ip)) return; // first sighting wins
    seen.add(box.ip);
    try {
      onFound(box);
    } catch {
      // A caller's render error must not abort discovery.
    }
  };
}

/**
 * HTTP-sweep every host in `base`'s /24 for the agent's /api/ping, `conc` at a
 * time. Dead IPs just time out; live agents answer in milliseconds.
 *
 * `report` fires from the worker the INSTANT a host answers. Without it the
 * caller waits for the whole sweep to drain (254 IPs / 64 workers x 1500 ms
 * per-host timeout), so a box that answered in ~1 ms is withheld for seconds
 * with the answer already in hand.
 */
async function httpSweep(
  base: string,
  port: number,
  perHostTimeoutMs: number,
  report: (box: FoundBox) => void,
  signal?: { aborted: boolean },
): Promise<FoundBox[]> {
  const ips: string[] = [];
  for (let h = 1; h <= 254; h++) ips.push(base + h);
  const found: FoundBox[] = [];
  const CONC = 64;
  let next = 0;
  const worker = async () => {
    for (;;) {
      // Checked here, not only before the await: abort() is synchronous, so a
      // worker suspended in pingHost resumes, sees it, and exits — every worker
      // is gone within one per-host timeout instead of running all 254 probes.
      if (signal?.aborted) return;
      const i = next++;
      if (i >= ips.length) return;
      const box = await pingHost(ips[i], port, perHostTimeoutMs);
      if (box) {
        found.push(box);
        report(box);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONC, ips.length) }, worker));
  return found;
}

/**
 * UDP probe: broadcast (directed + global) and collect replies for `timeoutMs`.
 * Resolves an empty list on any failure — the HTTP sweep is the reliable path.
 */
function udpProbe(
  myIp: string | undefined,
  port: number,
  timeoutMs: number,
  report: (box: FoundBox) => void,
): Promise<FoundBox[]> {
  if (!dgram) return Promise.resolve([]);
  const probe = Buffer.from(PROBE);
  const targets = broadcastTargets(myIp);

  return new Promise<FoundBox[]>((resolve) => {
    let socket: ReturnType<NonNullable<typeof dgram>['createSocket']>;
    try {
      socket = dgram!.createSocket({ type: 'udp4' });
    } catch {
      resolve([]);
      return;
    }
    const found = new Map<string, FoundBox>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      timer = null;
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve(Array.from(found.values()));
    };

    socket.once('error', finish);
    socket.on('message', (msg: Buffer, rinfo: { address: string }) => {
      try {
        const d = JSON.parse(msg.toString());
        if (d && d.couchside) {
          const box: FoundBox = {
            name: typeof d.name === 'string' ? d.name : rinfo.address,
            host: typeof d.host === 'string' ? d.host : rinfo.address,
            ip: rinfo.address,
            port: typeof d.port === 'number' ? d.port : port,
            version: typeof d.version === 'string' ? d.version : '',
            ...readTlsAdvert(d),
          };
          found.set(rinfo.address, box);
          // Same drain fix as the HTTP sweep: replies land in milliseconds but
          // were held until the timer fired. The reporter dedupes the
          // directed+global double reply.
          report(box);
        }
      } catch {
        // not our reply; ignore
      }
    });

    try {
      socket.bind(0, (bindErr?: Error) => {
        if (bindErr) {
          finish();
          return;
        }
        try {
          socket.setBroadcast(true);
        } catch {
          // some platforms reject this before the first send
        }
        for (const addr of targets) {
          try {
            socket.send(probe, 0, probe.length, port, addr, () => {});
          } catch {
            // a blocked target must not abort the rest
          }
        }
        timer = setTimeout(finish, timeoutMs);
      });
    } catch {
      finish();
    }
  });
}

/** Options for {@link scanForBoxes}. The first three are the pre-existing ones,
 *  unchanged, so `scanForBoxes({ timeoutMs: 3000 })` keeps working verbatim. */
export type ScanOpts = {
  ip?: string;
  port?: number;
  timeoutMs?: number;
  /**
   * Fired ONCE per distinct box, the instant it answers — mid-sweep, seconds
   * before the returned promise resolves. The resolved array still contains
   * every box, so a caller may use either or both. Treat the resolved array as
   * authoritative on completion and reconcile by `ip`: onFound carries the
   * FIRST sighting, the array carries the HTTP one (see the merge below).
   */
  onFound?: (box: FoundBox) => void;
  /**
   * Abort an in-flight scan (component unmount, screen blur). Stops dispatching
   * new probes and silences `onFound`; the promise still resolves with whatever
   * was found, so a caller must ALSO guard its own `.then`.
   */
  signal?: AbortSignal;
};

/**
 * Discover Couchside boxes on the LAN. Runs the HTTP sweep and the UDP probe
 * together and merges by IP (HTTP wins, since it proves the agent answered).
 * Throws only when no usable local IP could be determined AND UDP is absent.
 */
export async function scanForBoxes(opts: ScanOpts = {}): Promise<FoundBox[]> {
  const port = opts.port ?? DEFAULT_PORT;
  const timeoutMs = opts.timeoutMs ?? 3000;
  const myIp = opts.ip ?? (await selfIp());
  if (opts.signal?.aborted) return []; // torn down while selfIp() was in flight
  const base = subnetBase(myIp);
  // ONE reporter shared by both probes: a box seen by UDP and by HTTP is a
  // single sighting to the caller.
  const report = makeReporter(opts.onFound, opts.signal);

  const [sweep, udp] = await Promise.all([
    base ? httpSweep(base, port, 1500, report, opts.signal) : Promise.resolve([]),
    udpProbe(myIp, port, Math.min(timeoutMs, 2500), report),
  ]);

  const found = new Map<string, FoundBox>();
  for (const b of udp) found.set(b.ip, b);
  for (const b of sweep) found.set(b.ip, b); // HTTP result wins
  return Array.from(found.values());
}
