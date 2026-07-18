/**
 * LAN box discovery: broadcast a probe and collect replies from Couchside
 * agents, so the user can pick a box to pair instead of typing an IP. Pairs
 * with the agent's UDP responder (agent >= 2.9.12): the box replies with its
 * identity + HTTP port. Reveals existence only — pairing still needs the PIN
 * shown on the box's own screen (see api.pairStart/pairFinish).
 *
 * UDP broadcast (not mDNS) is deliberate: Android multicast RX needs a
 * MulticastLock and is flaky, while a directed/global broadcast + unicast reply
 * is reliable. Mirrors lib/wol.ts's use of the same native module.
 */
import { Buffer } from 'buffer';
import * as Network from 'expo-network';

import { DEFAULT_PORT } from './settings';

// Native module; require in a try/catch so a build predating the dependency
// disables scanning instead of crashing at startup (see scanAvailable).
// react-native-udp does `module.exports = UdpSockets` AND `export default`, so
// depending on interop `.default` may be undefined and the module itself is the
// dgram object — accept either (a bare `.default` silently disabled this).
let dgram: typeof import('react-native-udp').default | null = null;
try {
  const udp = require('react-native-udp');
  dgram = (udp && (udp.default ?? udp)) || null;
} catch {
  dgram = null;
}

/** True when the UDP native module is present, so a scan can run. */
export const scanAvailable = dgram != null;

const PROBE = 'COUCHSIDE_DISCOVER?';

export type FoundBox = {
  /** Short hostname the box reports (display label). */
  name: string;
  /** mDNS name (e.g. steamdeck.local) for the stored host. */
  host: string;
  /** The IP the reply actually came from (the direct-connect fallback). */
  ip: string;
  /** The box's HTTP/agent port. */
  port: number;
  /** Agent version (so the UI can flag a box too old to PIN-pair). */
  version: string;
};

/** The /24 directed broadcast for a LAN IP, plus the global broadcast. */
function broadcastTargets(ip?: string): string[] {
  const t: string[] = [];
  if (ip) {
    const m = /^(\d+)\.(\d+)\.(\d+)\.\d+$/.exec(ip);
    if (m) t.push(`${m[1]}.${m[2]}.${m[3]}.255`);
  }
  t.push('255.255.255.255');
  return Array.from(new Set(t));
}

/**
 * Broadcast the discovery probe on `port` (the agent port) and collect box
 * replies for `timeoutMs`. Resolves the deduped list (by IP). Throws only when
 * the native UDP module is missing; a bind/send failure resolves an empty list.
 */
/**
 * The device's own LAN IPv4, so a scan can derive the /24 DIRECTED broadcast.
 * iOS silently drops the global 255.255.255.255 broadcast, so with only the
 * global target a scan finds nothing on iOS (Android is permissive). Best-effort
 * — resolves undefined if expo-network can't read a usable address.
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

/**
 * Every host address in `ip`'s /24 (x.y.z.1 … x.y.z.254). iOS drops UDP
 * broadcast — BOTH the global 255.255.255.255 AND the subnet-directed x.y.z.255
 * — so a broadcast-only scan finds nothing there even on the right subnet.
 * Unicasting the probe to each host is the reliable LAN sweep on iOS (the same
 * path add-by-IP uses); 254 tiny datagrams is cheap. Empty if `ip` is unusable.
 */
function sweepTargets(ip?: string): string[] {
  if (!ip) return [];
  const m = /^(\d+)\.(\d+)\.(\d+)\.\d+$/.exec(ip);
  if (!m) return [];
  const base = `${m[1]}.${m[2]}.${m[3]}.`;
  const out: string[] = [];
  for (let h = 1; h <= 254; h++) out.push(base + h);
  return out;
}

export async function scanForBoxes(
  opts: { ip?: string; port?: number; timeoutMs?: number } = {},
): Promise<FoundBox[]> {
  if (!dgram) throw new Error('Box discovery needs a fresh native build of the app');
  const port = opts.port ?? DEFAULT_PORT;
  const timeoutMs = opts.timeoutMs ?? 3000;
  const probe = Buffer.from(PROBE);
  const myIp = opts.ip ?? (await selfIp());
  // iOS drops UDP broadcast (global AND directed), so a broadcast-only scan
  // finds nothing there. Unicast-sweep the phone's /24 (reliable on iOS), and
  // keep the broadcasts for Android where they're one fast packet.
  const targets = [...broadcastTargets(myIp), ...sweepTargets(myIp)];

  return new Promise<FoundBox[]>((resolve) => {
    const socket = dgram!.createSocket({ type: 'udp4' });
    const found = new Map<string, FoundBox>(); // by IP
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = () => {
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
          found.set(rinfo.address, {
            name: typeof d.name === 'string' ? d.name : rinfo.address,
            host: typeof d.host === 'string' ? d.host : rinfo.address,
            ip: rinfo.address,
            port: typeof d.port === 'number' ? d.port : port,
            version: typeof d.version === 'string' ? d.version : '',
          });
        }
      } catch {
        // not our reply; ignore
      }
    });

    socket.bind(0, (bindErr?: Error) => {
      if (bindErr) {
        finish();
        return;
      }
      try {
        socket.setBroadcast(true);
      } catch {
        // some platforms reject before the first send; the send still works
      }
      try {
        for (const addr of targets) {
          socket.send(probe, 0, probe.length, port, addr, () => {});
        }
      } catch {
        finish();
        return;
      }
      timer = setTimeout(finish, timeoutMs);
    });
  });
}
