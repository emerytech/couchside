import type { ConnSettings } from './api';

/**
 * The fields `connFromBox` reads off a stored box. A structural subset so this
 * module stays free of react-native / expo imports and runs in the bare-Node
 * strip-types test glob (a type-only import of ConnSettings is erased at build).
 */
export type BoxConnFields = ConnSettings;

/**
 * Turn a stored box into the ConnSettings the API layer expects, ALWAYS carrying
 * the TLS pin fields (secure / tlsPort / pinModulus).
 *
 * Hand-rolling `{ host, port, token, lastIp }` at a call site drops those three,
 * and `attempt()` (api.ts) gates the pinned transport on all three being present
 * — so an authed request to a securely-paired box silently falls to the plaintext
 * `fetch` path and puts `Authorization: Bearer <token>` on the wire in cleartext
 * (KI-096; found leaking on the Fleet tab's status poll and RemotePowerBar's
 * wol-relay). Every UI path that turns a box into a conn MUST use this, so the
 * pin fields can never be forgotten again. `fp` is intentionally omitted: it is
 * not in ConnSettings and `pinModulus` is the load-bearing pin (see boxTls.ts).
 */
export function connFromBox(box: BoxConnFields): ConnSettings {
  return {
    host: box.host,
    port: box.port,
    token: box.token,
    lastIp: box.lastIp,
    secure: box.secure,
    tlsPort: box.tlsPort,
    pinModulus: box.pinModulus,
  };
}

/**
 * True when this conn will drive the pinned TLS transport (bearer token stays off
 * the wire). The exact gate `attempt()` uses; exported so a test can assert a
 * securely-paired box never produces a conn that would send the token in the
 * clear.
 */
export function connIsPinned(conn: ConnSettings): boolean {
  return !!(conn.secure && conn.pinModulus && conn.tlsPort);
}
