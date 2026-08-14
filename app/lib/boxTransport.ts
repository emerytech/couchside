/**
 * Fast-glob-SAFE boundary to the pinned-TLS transport (TLS P5).
 *
 * `api.ts`, `gamepad.ts` and `screenstream.ts` are exercised in CI's install-free
 * unit-test glob, so they must NOT statically import the native transport
 * (boxTls -> react-native-tcp-socket, boxWs -> react-native-get-random-values):
 * those packages don't resolve without node_modules and would break every test
 * that imports these files (see ci.yml — the same reason atvnative is isolated).
 *
 * So the native modules are loaded LAZILY here, ONLY on the secure branch (a box
 * the user paired with TLS). Plaintext callers — and the unit tests, which only
 * ever exercise plaintext — never touch `require`, keeping the import graph clean.
 * In Metro (the real app) `require('./boxTls')` is a static string it bundles
 * normally; in a Node test the secure branch is never reached, so it never runs.
 */
import type { PinnedResponse } from './boxTlsCodec';

export type { PinnedResponse } from './boxTlsCodec';

/** The WHATWG-WebSocket subset both a real WebSocket and PinnedWebSocket satisfy. */
export type BoxSocketLike = {
  binaryType: string;
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: string | ArrayBuffer }) => void) | null;
  onerror: ((e?: unknown) => void) | null;
  onclose: (() => void) | null;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(): void;
};

// The require string MUST be a literal so Metro statically bundles the native
// module. A Node unit test never reaches these (secure branch only), so `require`
// being undefined in ESM there is harmless. eslint-disable: this indirection is
// the whole point — keep the native package out of the static import graph.
function nativeTls(): typeof import('./boxTls') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('./boxTls');
}
function nativeWs(): typeof import('./boxWs') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('./boxWs');
}

export type PinnedRequestOpts = {
  method?: string;
  path: string;
  token?: string;
  body?: string;
  timeoutMs?: number;
};

/** One pinned HTTP/1.1 request (JSON) to a secure box. */
export function pinnedRequest(
  host: string,
  port: number,
  pinModulus: string,
  req: PinnedRequestOpts,
): Promise<PinnedResponse> {
  return nativeTls().pinnedRequest(host, port, pinModulus, req);
}

/** True if `e` is the pin-mismatch error (without statically importing its class). */
export function isPinMismatchError(e: unknown): boolean {
  return e instanceof Error && e.name === 'PinMismatchError';
}

/**
 * Open a box WebSocket — pinned when the box is `secure` (token rides the
 * encrypted, cert-pinned handshake path), plaintext `ws://` otherwise. `path`
 * includes the leading slash + any `?token=` query. Plaintext is never removed.
 */
export function openBoxSocket(
  conn: { host: string; port: number; secure?: boolean; tlsPort?: number; pinModulus?: string },
  path: string,
): BoxSocketLike {
  if (conn.secure && conn.pinModulus && conn.tlsPort) {
    const Ctor = nativeWs().PinnedWebSocket;
    return new Ctor(conn.host, conn.tlsPort, conn.pinModulus, path);
  }
  return new WebSocket(`ws://${conn.host}:${conn.port}${path}`) as unknown as BoxSocketLike;
}
