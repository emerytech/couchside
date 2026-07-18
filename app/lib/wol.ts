/**
 * Wake-on-LAN: wake a suspended or powered-off box by broadcasting a magic
 * packet to its NIC. Used by the Console power control once the box is asleep
 * and the agent is no longer answering, so this never talks to the agent; it
 * puts a UDP broadcast on the LAN and the box's network card does the rest.
 *
 * Wake only works when the box is on wired Ethernet with WoL armed in firmware.
 * The app learns whether that is the case from /api/status.net while the box is
 * still awake and guides the user accordingly.
 */
import { Buffer } from 'buffer';

// react-native-udp is a native module. Requiring it in a try/catch means a
// build that predates the dependency disables wake instead of crashing at
// startup; wolAvailable reports which case we are in.
// The lib does `module.exports = UdpSockets` AND `export default`, so depending
// on interop `.default` can be undefined and the module itself is the dgram
// object — accept either. (A bare `.default` left wolAvailable always false.)
let dgram: typeof import('react-native-udp').default | null = null;
try {
  const udp = require('react-native-udp');
  dgram = (udp && (udp.default ?? udp)) || null;
} catch {
  dgram = null;
}

/** True when the UDP native module is present, so wake can actually be sent. */
export const wolAvailable = dgram != null;

const MAC_RE = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;

/** Six MAC bytes from "aa:bb:cc:dd:ee:ff" (or with '-'), or null if malformed. */
function macBytes(mac: string): number[] | null {
  if (!MAC_RE.test(mac)) return null;
  return mac.split(/[:-]/).map((h) => parseInt(h, 16));
}

/** The 102-byte magic packet: 0xFF six times, then the MAC repeated 16 times. */
function buildMagicPacket(mac: string): Buffer | null {
  const bytes = macBytes(mac);
  if (!bytes) return null;
  const payload = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
  for (let i = 0; i < 16; i++) payload.push(...bytes);
  return Buffer.from(payload);
}

/** The /24 directed broadcast for a LAN IP (more reliable than the global one,
 * which iOS often blocks), falling back to the global broadcast. */
function broadcastFor(ip?: string): string {
  if (ip) {
    const m = /^(\d+)\.(\d+)\.(\d+)\.\d+$/.exec(ip);
    if (m) return `${m[1]}.${m[2]}.${m[3]}.255`;
  }
  return '255.255.255.255';
}

/**
 * Broadcast a Wake-on-LAN magic packet for `mac`. It goes to the box's /24
 * directed broadcast (derived from its last-known IP) and the global broadcast,
 * on both standard WoL ports (9 and 7), since setups differ on which they wake
 * from. Resolves true when at least one send succeeded. Throws when the native
 * UDP module is missing or the MAC is malformed.
 */
export async function sendWol(mac: string, opts: { ip?: string } = {}): Promise<boolean> {
  if (!dgram) throw new Error('Wake-on-LAN needs a fresh native build of the app');
  const packet = buildMagicPacket(mac);
  if (!packet) throw new Error(`Malformed MAC address: ${mac}`);

  const targets = Array.from(new Set([broadcastFor(opts.ip), '255.255.255.255']));
  const ports = [9, 7];

  return new Promise<boolean>((resolve) => {
    const socket = dgram!.createSocket({ type: 'udp4' });
    let sent = 0;
    let pending = targets.length * ports.length;

    const finish = () => {
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve(sent > 0);
    };

    socket.once('error', finish);
    socket.bind(0, (bindErr?: Error) => {
      // On a bind failure react-native-udp leaves the socket UNBOUND, so a send
      // would throw synchronously and pre-empt the library's own 'error' emit,
      // hanging this promise. Settle here instead of sending.
      if (bindErr) {
        finish();
        return;
      }
      try {
        socket.setBroadcast(true);
      } catch {
        // some platforms reject this before the first send; the send still works
      }
      try {
        for (const addr of targets) {
          for (const port of ports) {
            socket.send(packet, 0, packet.length, port, addr, (err?: Error) => {
              if (!err) sent += 1;
              pending -= 1;
              if (pending === 0) finish();
            });
          }
        }
      } catch {
        // A synchronous send throw must still settle the promise, not leave the
        // caller's WAKING state stuck on.
        finish();
      }
    });
  });
}
