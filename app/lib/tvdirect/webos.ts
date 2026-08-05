/**
 * LG webOS SSAP session, app-direct (no box). ZERO platform imports — the raw
 * TLS socket and the crypto are INJECTED (from atvnative), so the session logic
 * stays loadable by the bare-Node runner and driveable against a real LG.
 *
 * Composes lib/tvdirect/ws.ts (the WebSocket layer) over a pinned-cert TLS byte
 * stream, and speaks SSAP (lib/tvdirect/webosproto.ts) on top. The box already
 * proves this exact flow against the real LG in Python (_WebOSSession); this is
 * the JS port.
 *
 * NOT YET device-verified: the react-native-tcp-socket WS-over-TLS path to a
 * self-signed LG is untested on hardware (no LG was reachable when this was
 * built). Same device gate as Android TV. The pure layers under it (framing,
 * manifest, SSAP messages) ARE unit-tested.
 */
import {
  type WsCrypto,
  frameText,
  handshake,
  makeDecoder,
  encodeText,
  OPCODE,
  parseHandshakeResponse,
} from './ws.ts';
import {
  WEBOS_KEYS,
  WEBOS_LAUNCH_URI,
  WEBOS_LIST_APPS_URI,
  WEBOS_OP_URI,
  WEBOS_POINTER_URI,
  WEBOS_PORT,
  clientKeyOf,
  isPrompt,
  isRegistered,
  pointerButtonFrame,
  registerMessage,
  requestMessage,
  type WebosMsg,
} from './webosproto.ts';

/** A launchable TV app (shared with roku.ts's TvApp shape). */
export type TvApp = { id: string; name: string; iconUrl?: string };

/** A raw TLS byte stream (atvnative.RawTlsSocket), injected. */
export type ByteSocket = {
  write(bytes: Uint8Array): void;
  onData(cb: (bytes: Uint8Array) => void): void;
  onClose(cb: () => void): void;
  close(): void;
};

export type WebosDeps = {
  /** Fetch the LG's self-signed cert once (TOFU) for pinning. */
  fetchPeerCert(host: string, port: number): Promise<string | null>;
  /** Open a pinned-cert raw TLS byte stream. */
  rawConnect(caPem: string): (host: string, port: number) => Promise<ByteSocket>;
  crypto: WsCrypto;
};

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * One WebSocket connection carrying SSAP JSON messages, correlated by `id`. A
 * PROMPT message (no id) is delivered to the prompt callback; everything else
 * matches a pending request.
 */
class SsapConn {
  private sock: ByteSocket;
  private crypto: WsCrypto;
  private dec = makeDecoder();
  private waiters = new Map<string, { resolve: (m: WebosMsg) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private promptCb: (() => void) | null = null;
  private id = 0;
  private handshook = false;
  private hsBuf: Uint8Array = new Uint8Array(0);
  private hsSettle: ((ok: boolean) => void) | null = null;
  private expectAccept: string | null = null;

  constructor(sock: ByteSocket, crypto: WsCrypto) {
    this.sock = sock;
    this.crypto = crypto;
    this.sock.onData((b) => this.onBytes(b));
    this.sock.onClose(() => this.failAll(new Error('webos socket closed')));
  }

  /** WS upgrade for `path`. Resolves on the 101. */
  handshakeWs(host: string, path = '/'): Promise<void> {
    const hs = handshake(`${host}:${WEBOS_PORT}`, this.crypto, path);
    this.expectAccept = hs.expectAccept;
    this.sock.write(hs.request);
    return new Promise((resolve, reject) => {
      this.hsSettle = (ok) => (ok ? resolve() : reject(new Error('websocket handshake failed')));
    });
  }

  private onBytes(b: Uint8Array): void {
    if (!this.handshook) {
      this.hsBuf = concat(this.hsBuf, b);
      const r = parseHandshakeResponse(this.hsBuf, this.expectAccept);
      if (!r.done) return;
      this.handshook = true;
      const settle = this.hsSettle;
      this.hsSettle = null;
      settle?.(!!r.ok);
      if (r.ok && r.rest && r.rest.length) this.feed(r.rest);
      return;
    }
    this.feed(b);
  }

  private feed(b: Uint8Array): void {
    for (const f of this.dec.push(b)) {
      if (f.opcode === OPCODE.close) { this.failAll(new Error('server closed')); return; }
      if (f.opcode === OPCODE.ping || f.opcode === OPCODE.pong) continue;
      if (f.opcode !== OPCODE.text) continue;
      let msg: WebosMsg;
      try { msg = JSON.parse(frameText(f)); } catch { continue; }
      const w = msg.id ? this.waiters.get(msg.id) : undefined;
      if (w) {
        clearTimeout(w.timer);
        this.waiters.delete(msg.id!);
        w.resolve(msg);
      } else if (isPrompt(msg)) {
        this.promptCb?.();
      }
    }
  }

  private failAll(e: Error): void {
    for (const w of this.waiters.values()) { clearTimeout(w.timer); w.reject(e); }
    this.waiters.clear();
    const settle = this.hsSettle;
    this.hsSettle = null;
    settle?.(false);
  }

  send(text: string): void {
    this.sock.write(encodeText(text, this.crypto.randomBytes(4)));
  }
  nextId(): string {
    this.id += 1;
    return `cs_${this.id}`;
  }
  await_(id: string, timeoutMs: number): Promise<WebosMsg> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(id); reject(new Error('ssap timeout')); }, timeoutMs);
      this.waiters.set(id, { resolve, reject, timer });
    });
  }
  onPrompt(cb: () => void): void { this.promptCb = cb; }
  close(): void { this.sock.close(); }
}

export type WebosPairResult = { ok: boolean; clientKey?: string; caPem?: string; error?: string };

/**
 * A managed webOS remote: pairs (on-TV Accept prompt), persists the client-key,
 * and reconnects silently for later commands.
 */
export class WebosSession {
  private host: string;
  private deps: WebosDeps;
  private caPem: string | null;
  private clientKey: string | null;
  private conn: SsapConn | null = null;
  private connecting: Promise<void> | null = null;
  private pointerPath: string | null = null;

  constructor(host: string, deps: WebosDeps, creds?: { caPem: string; clientKey: string }) {
    this.host = host;
    this.deps = deps;
    this.caPem = creds?.caPem ?? null;
    this.clientKey = creds?.clientKey ?? null;
  }

  /** First-time pairing: register → on-TV Accept prompt → client-key to persist. */
  async pair(onPrompt?: () => void, timeoutMs = 60000): Promise<WebosPairResult> {
    try {
      const ca = this.caPem ?? (await this.deps.fetchPeerCert(this.host, WEBOS_PORT));
      if (!ca) {
        return { ok: false, error: 'Could not read this TV’s certificate. Check the IP and that the TV is on.' };
      }
      this.caPem = ca;
      const conn = await this.open(ca);
      if (onPrompt) conn.onPrompt(onPrompt);
      const id = conn.nextId();
      conn.send(registerMessage(id, this.clientKey ?? undefined));
      const msg = await conn.await_(id, timeoutMs);
      if (!isRegistered(msg)) return { ok: false, error: msg.error ?? 'Pairing was refused by the TV.' };
      const key = clientKeyOf(msg) ?? this.clientKey ?? undefined;
      if (!key) return { ok: false, error: 'The TV did not return a pairing key.' };
      this.clientKey = key;
      return { ok: true, clientKey: key, caPem: ca };
    } catch (e) {
      this.drop();
      return { ok: false, error: (e as Error).message };
    }
  }

  private async open(ca: string, path = '/'): Promise<SsapConn> {
    const raw = await this.deps.rawConnect(ca)(this.host, WEBOS_PORT);
    const conn = new SsapConn(raw, this.deps.crypto);
    await conn.handshakeWs(this.host, path);
    if (path === '/') this.conn = conn;
    return conn;
  }

  /** Registered connection, reconnecting silently with the stored key. */
  private async ensure(): Promise<SsapConn> {
    if (this.conn) return this.conn;
    if (!this.caPem || !this.clientKey) throw new Error('webos not paired');
    if (!this.connecting) {
      this.connecting = (async () => {
        const conn = await this.open(this.caPem!);
        const id = conn.nextId();
        conn.send(registerMessage(id, this.clientKey!));
        const msg = await conn.await_(id, 15000);
        if (!isRegistered(msg)) throw new Error('silent re-register failed');
      })().finally(() => { this.connecting = null; });
    }
    await this.connecting;
    if (!this.conn) throw new Error('webos: not connected');
    return this.conn;
  }

  private async request(uri: string, payload?: unknown): Promise<WebosMsg> {
    const conn = await this.ensure();
    const id = conn.nextId();
    conn.send(requestMessage(id, uri, payload));
    return conn.await_(id, 6000);
  }

  async op(name: string): Promise<{ ok: boolean; error?: string }> {
    const uri = WEBOS_OP_URI[name];
    if (!uri) return { ok: false, error: `unsupported op ${name}` };
    try { await this.request(uri); return { ok: true }; }
    catch (e) { this.drop(); return { ok: false, error: (e as Error).message }; }
  }

  /** The TV's installed apps, with icon URLs the TV serves itself. */
  async listApps(): Promise<TvApp[]> {
    try {
      const r = await this.request(WEBOS_LIST_APPS_URI);
      const points = r.payload?.launchPoints;
      if (!Array.isArray(points)) return [];
      const apps: TvApp[] = [];
      for (const p of points) {
        if (!p || typeof p !== 'object') continue;
        const o = p as Record<string, unknown>;
        const id = typeof o.id === 'string' ? o.id : null;
        if (!id) continue;
        const name = typeof o.title === 'string' && o.title ? o.title : id;
        const iconUrl = typeof o.icon === 'string' && o.icon ? o.icon : undefined;
        apps.push({ id, name, iconUrl });
      }
      return apps;
    } catch {
      this.drop();
      return [];
    }
  }

  /** Launch an installed app by its webOS id (from listApps — never a client string). */
  async launchApp(id: string): Promise<{ ok: boolean; error?: string }> {
    try { await this.request(WEBOS_LAUNCH_URI, { id }); return { ok: true }; }
    catch (e) { this.drop(); return { ok: false, error: (e as Error).message }; }
  }

  async key(name: string): Promise<{ ok: boolean; error?: string }> {
    const button = WEBOS_KEYS[name];
    if (!button) return { ok: false, error: `unknown key ${name}` };
    try {
      if (!this.pointerPath) {
        const r = await this.request(WEBOS_POINTER_URI);
        const path = r.payload?.socketPath;
        if (typeof path !== 'string') throw new Error('no pointer socket path');
        this.pointerPath = path;
      }
      // The pointer socket is a SECOND wss the TV returns. A persistent pointer
      // connection is device-work for the hardware pass; for now open-and-send
      // (correctness over latency).
      const wsPath = this.pointerPath.replace(/^wss?:\/\/[^/]+/, '') || '/';
      const ptr = await this.open(this.caPem!, wsPath);
      ptr.send(pointerButtonFrame(button));
      ptr.close();
      return { ok: true };
    } catch (e) {
      this.pointerPath = null;
      this.drop();
      return { ok: false, error: (e as Error).message };
    }
  }

  private drop(): void {
    try { this.conn?.close(); } catch {}
    this.conn = null;
    this.pointerPath = null;
  }
  close(): void { this.drop(); }
}
