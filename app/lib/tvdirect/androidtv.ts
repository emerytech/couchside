/**
 * Android TV / Google TV client: pairing + a keepalive remote session.
 * ZERO runtime imports — the socket and the crypto are both INJECTED.
 *
 * Why both are injected: Node has `tls` and `crypto`; React Native has neither,
 * and react-native-tcp-socket cannot load in the bare-Node test runner. Keeping
 * this module dependency-free is what lets the SAME code that ships be driven
 * against the real TV from a test (see lib/__tests__/atv-live.mjs), so the only
 * app-specific surface is a thin adapter.
 *
 * Protocol details, keycodes and the wire format live in ./atvproto.ts.
 */

import {
  ATV_KEYS,
  ATV_OP_KEY,
  ATV_PAIR_PORT,
  ATV_REMOTE_PORT,
  type AtvConnect,
  type AtvKey,
  type AtvOp,
  type AtvSocket,
  checkByteMatches,
  isPairingConfigurationAck,
  isPairingRequestAck,
  isPairingOptionsAck,
  isPairingSecretAck,
  isRemoteConfigure,
  isRemotePing,
  isRemoteSetActive,
  isRemoteStart,
  isValidPairCode,
  keyInject,
  normalizeModulusHex,
  pairingConfiguration,
  pairingOptions,
  pairingRequest,
  pairingSecret,
  parse,
  pingValue,
  remoteConfigureReply,
  remotePingReply,
  remoteSetActiveReply,
  secretPreimage,
} from './atvproto.ts';

/** An RSA keypair + self-signed cert, PEM encoded. Minted by the caller. */
export type AtvIdentity = { certPem: string; keyPem: string; modulusHex: string };

/** Everything platform-specific, supplied by the caller. */
export type AtvDeps = {
  connect: AtvConnect;
  /** SHA-256. Node: crypto.createHash; RN: expo-crypto digest. */
  sha256(data: Uint8Array): Promise<Uint8Array>;
};

export type PairSession = {
  /** Send the code the TV is displaying. Resolves the identity to persist. */
  finish(code: string): Promise<AtvIdentity>;
  /** Abandon a pairing the user backed out of. */
  cancel(): void;
};

/**
 * Phase 1: open the pairing channel so the TV DISPLAYS its code, and return a
 * handle that completes once the user reads it.
 *
 * THE DIALOG EXPIRES, AND FAST. Measured 2026-08-05 on a real Hisense Google
 * TV: relaying the code took 39s and the TV never answered the secret — the
 * next connect was refused `certificate unknown`, i.e. never paired. The same
 * flow at 5.6s paired instantly. So the UI must show the code field the moment
 * this resolves, with nothing in between.
 */
export async function pairStart(
  host: string,
  identity: AtvIdentity,
  deps: AtvDeps,
  clientName = 'Couchside',
): Promise<PairSession> {
  const sock = await deps.connect(host, ATV_PAIR_PORT, identity.certPem, identity.keyPem);
  const serverModulusHex = normalizeModulusHex(sock.peerModulusHex());

  const step = async (msg: Uint8Array, ok: (f: ReturnType<typeof parse>) => boolean, what: string) => {
    sock.write(msg);
    if (!ok(parse(await sock.recv()))) throw new Error(`androidtv pairing: no ${what}`);
  };

  try {
    await step(pairingRequest(clientName), isPairingRequestAck, 'pairing_request_ack');
    await step(pairingOptions(), isPairingOptionsAck, 'options ack');
    await step(pairingConfiguration(), isPairingConfigurationAck, 'configuration_ack');
  } catch (e) {
    sock.close();
    throw e;
  }

  let done = false;
  return {
    cancel() {
      if (!done) {
        done = true;
        sock.close();
      }
    },
    async finish(code: string): Promise<AtvIdentity> {
      if (done) throw new Error('pairing session already finished');
      if (!isValidPairCode(code)) throw new Error('the code is 6 hex digits');
      const clean = code.trim().toLowerCase();
      const secret = await deps.sha256(
        secretPreimage(identity.modulusHex, serverModulusHex, clean),
      );
      // Catch a mistyped code locally: the TV answers a wrong secret with
      // SILENCE, which is indistinguishable from a dead link.
      if (!checkByteMatches(secret, clean)) {
        throw new Error('that code does not match — check the digits on the TV');
      }
      try {
        sock.write(pairingSecret(secret));
        if (!isPairingSecretAck(parse(await sock.recv(45000)))) {
          throw new Error('the TV rejected the pairing');
        }
      } catch (e) {
        throw new Error(
          `${(e as Error).message}. If the code had been on screen a while, the TV's own ` +
            `dialog may have expired — start pairing again and enter it promptly.`,
        );
      } finally {
        done = true;
        sock.close();
      }
      return identity;
    },
  };
}

/**
 * A live remote channel. The TV pings every ~5s and drops the channel if the
 * pings go unanswered, so this owns a reader loop for the socket's lifetime
 * rather than reconnecting per key (a fresh TLS handshake per press measured
 * ~1s on the agent side — far too slow for a held D-pad).
 */
export class AtvSession {
  private sock: AtvSocket | null = null;
  private connecting: Promise<void> | null = null;
  private host: string;
  private identity: AtvIdentity;
  private deps: AtvDeps;

  // Fields are declared and assigned explicitly rather than via constructor
  // parameter properties: those GENERATE code, and Node's
  // --experimental-strip-types only ERASES types, so the shorthand makes this
  // module unloadable by the bare-Node runner that drives it against real
  // hardware. Same constraint as the rest of lib/__tests__.
  constructor(host: string, identity: AtvIdentity, deps: AtvDeps) {
    this.host = host;
    this.identity = identity;
    this.deps = deps;
  }

  /** Connect + handshake if needed. Safe to call concurrently. */
  private async ensure(): Promise<AtvSocket> {
    if (this.sock) return this.sock;
    if (!this.connecting) {
      this.connecting = this.open().finally(() => {
        this.connecting = null;
      });
    }
    await this.connecting;
    if (!this.sock) throw new Error('androidtv: not connected');
    return this.sock;
  }

  private async open(): Promise<void> {
    const sock = await this.deps.connect(
      this.host,
      ATV_REMOTE_PORT,
      this.identity.certPem,
      this.identity.keyPem,
    );
    // Handshake: the TV drives it, we answer until remote_start arrives.
    const deadline = Date.now() + 12000;
    for (;;) {
      if (Date.now() > deadline) {
        sock.close();
        throw new Error('androidtv remote handshake timed out');
      }
      const f = parse(await sock.recv(12000));
      if (isRemoteConfigure(f)) sock.write(remoteConfigureReply());
      else if (isRemoteSetActive(f)) sock.write(remoteSetActiveReply());
      else if (isRemotePing(f)) sock.write(remotePingReply(pingValue(f)));
      else if (isRemoteStart(f)) break;
    }
    this.sock = sock;
    void this.readerLoop(sock);
  }

  /** Answer pings for as long as this socket is the live one. */
  private async readerLoop(sock: AtvSocket): Promise<void> {
    for (;;) {
      let f;
      try {
        f = parse(await sock.recv(600000));
      } catch {
        break; // closed or idle past the ceiling: drop and reconnect on demand
      }
      if (this.sock !== sock) break;
      if (isRemotePing(f)) {
        try {
          sock.write(remotePingReply(pingValue(f)));
        } catch {
          break;
        }
      }
    }
    if (this.sock === sock) this.sock = null;
  }

  /**
   * Send a key. Reconnects once if the channel died since the last press —
   * a TV that slept mid-session should not need the user to re-pair.
   *
   * NOTE: key inject is FIRE AND FORGET. The TV acknowledges nothing, so a
   * resolved promise means "the frame was written", never "the TV acted".
   * KI-031 is the scar: the agent reported ok for a source key Google TV
   * silently drops. Do not surface this as confirmation.
   */
  async sendKey(key: AtvKey): Promise<void> {
    const code = ATV_KEYS[key];
    if (code === undefined) throw new Error(`unknown key ${key}`);
    await this.send(keyInject(code));
  }

  async sendOp(op: AtvOp): Promise<void> {
    const code = ATV_OP_KEY[op];
    if (code === undefined) throw new Error(`unknown op ${op}`);
    await this.send(keyInject(code));
  }

  private async send(msg: Uint8Array): Promise<void> {
    let sock = await this.ensure();
    try {
      sock.write(msg);
    } catch {
      this.sock = null;
      sock = await this.ensure();
      sock.write(msg);
    }
  }

  close(): void {
    const s = this.sock;
    this.sock = null;
    s?.close();
  }
}
