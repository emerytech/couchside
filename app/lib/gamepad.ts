/**
 * WebSocket client for the Couchside agent virtual gamepad (protocol v1).
 *
 * Endpoint: ws://<host>:<port>/ws/gamepad?token=<token>
 * Client -> server (one JSON object per text frame):
 *   {"t":"b","k":K,"v":0|1}            button
 *   {"t":"t","k":"lt"|"rt","v":0..255} analog trigger
 *   {"t":"s","k":"l"|"r","x":F,"y":F}  stick, -1..1, +y DOWN
 *   {"t":"ping"}                       keepalive
 * Server -> client: {"t":"hello","dev":...} | {"t":"pong"} | {"t":"err","msg":...}
 */
import { Settings } from './settings';

export type GamepadStatus = 'connecting' | 'connected' | 'error' | 'closed';

export type ButtonKey =
  | 'a'
  | 'b'
  | 'x'
  | 'y'
  | 'lb'
  | 'rb'
  | 'l3'
  | 'r3'
  | 'start'
  | 'select'
  | 'guide'
  | 'dl'
  | 'dr'
  | 'du'
  | 'dd';

export type TriggerKey = 'lt' | 'rt';
export type StickKey = 'l' | 'r';

export const BUTTON_KEYS: ButtonKey[] = [
  'a',
  'b',
  'x',
  'y',
  'lb',
  'rb',
  'l3',
  'r3',
  'start',
  'select',
  'guide',
  'dl',
  'dr',
  'du',
  'dd',
];

const PING_INTERVAL_MS = 20_000;
/** Per-stick send throttle: ~50 Hz. */
const STICK_INTERVAL_MS = 20;
const BACKOFF_MS = [1000, 2000, 4000];

export type GamepadStatusListener = (status: GamepadStatus, dev: string | null) => void;

type Conn = Pick<Settings, 'host' | 'port' | 'token'>;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Round to 3 decimals to keep frames small; precision beyond this is noise. */
function q(v: number): number {
  return Math.round(clamp(v, -1, 1) * 1000) / 1000;
}

export class GamepadClient {
  private ws: WebSocket | null = null;
  private status: GamepadStatus = 'closed';
  private dev: string | null = null;
  private listener: GamepadStatusListener | null = null;

  /** True between connect() and close(): reconnect on failure while set. */
  private active = false;
  private conn: Conn | null = null;
  private attempt = 0;

  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private stickLastSent: Record<StickKey, number> = { l: 0, r: 0 };
  private stickPending: Record<StickKey, { x: number; y: number } | null> = {
    l: null,
    r: null,
  };
  private stickTimer: Record<StickKey, ReturnType<typeof setTimeout> | null> = {
    l: null,
    r: null,
  };

  /** Register the (single) status listener; fires immediately with current state. */
  onStatus(fn: GamepadStatusListener | null): void {
    this.listener = fn;
    if (fn) fn(this.status, this.dev);
  }

  getStatus(): GamepadStatus {
    return this.status;
  }

  /**
   * Open (or re-open) the connection. Idempotent: calling it again with the
   * same target while already connecting/connected is a no-op, so re-renders,
   * StrictMode double-invokes, and repeated focus events can't tear down a
   * healthy socket.
   */
  connect(conn: Conn): void {
    const same =
      this.conn != null &&
      this.conn.host === conn.host &&
      this.conn.port === conn.port &&
      this.conn.token === conn.token;
    if (
      same &&
      this.active &&
      (this.status === 'connected' || this.status === 'connecting')
    ) {
      return;
    }
    this.conn = conn;
    this.active = true;
    this.attempt = 0;
    this.clearReconnect();

    this.open();
  }

  /** Best-effort release of everything, then a clean close. Stops reconnecting. */
  close(): void {
    this.active = false;
    this.clearReconnect();
    this.releaseAll();
    this.teardownSocket(true);
    this.setStatus('closed', null);
  }

  sendButton(k: ButtonKey, v: 0 | 1): void {
    this.sendRaw({ t: 'b', k, v });
  }

  sendTrigger(k: TriggerKey, v: number): void {
    this.sendRaw({ t: 't', k, v: Math.round(clamp(v, 0, 255)) });
  }

  /**
   * Throttled to ~50 Hz per stick. The rest position (0,0) bypasses the
   * throttle and cancels any pending frame so release always lands last.
   */
  sendStick(k: StickKey, x: number, y: number): void {
    if (x === 0 && y === 0) {
      const timer = this.stickTimer[k];
      if (timer) {
        clearTimeout(timer);
        this.stickTimer[k] = null;
      }
      this.stickPending[k] = null;
      this.stickLastSent[k] = Date.now();
      this.sendRaw({ t: 's', k, x: 0, y: 0 });
      return;
    }

    const now = Date.now();
    const elapsed = now - this.stickLastSent[k];
    if (elapsed >= STICK_INTERVAL_MS && this.stickTimer[k] == null) {
      this.stickLastSent[k] = now;
      this.sendRaw({ t: 's', k, x: q(x), y: q(y) });
      return;
    }

    // Too soon: keep only the latest value and flush it on a trailing timer.
    this.stickPending[k] = { x, y };
    if (this.stickTimer[k] == null) {
      this.stickTimer[k] = setTimeout(
        () => {
          this.stickTimer[k] = null;
          const p = this.stickPending[k];
          this.stickPending[k] = null;
          if (p) {
            this.stickLastSent[k] = Date.now();
            this.sendRaw({ t: 's', k, x: q(p.x), y: q(p.y) });
          }
        },
        Math.max(1, STICK_INTERVAL_MS - elapsed),
      );
    }
  }

  /** All buttons up, triggers zeroed, sticks centered. Best-effort. */
  releaseAll(): void {
    for (const k of BUTTON_KEYS) this.sendButton(k, 0);
    this.sendTrigger('lt', 0);
    this.sendTrigger('rt', 0);
    this.sendStick('l', 0, 0);
    this.sendStick('r', 0, 0);
  }

  // ---------- internals ----------

  private open(): void {
    if (!this.conn) return;
    this.teardownSocket(false);
    this.setStatus('connecting', null);

    const { host, port, token } = this.conn;
    const url = `ws://${host}:${port}/ws/gamepad?token=${encodeURIComponent(token)}`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.setStatus('error', null);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onmessage = (ev: WebSocketMessageEvent) => {
      if (ws !== this.ws) return;
      let msg: { t?: string; dev?: string; msg?: string };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.t === 'hello') {
        this.attempt = 0;
        this.dev = typeof msg.dev === 'string' ? msg.dev : null;
        this.setStatus('connected', this.dev);
        this.startPing();
      } else if (msg.t === 'err') {
        // Server reports the failure then closes; onclose handles reconnect.
        this.setStatus('error', null);
      }
      // {"t":"pong"} needs no handling.
    };

    ws.onerror = () => {
      if (ws !== this.ws) return;
      this.setStatus('error', null);
    };

    ws.onclose = () => {
      if (ws !== this.ws) return;
      this.ws = null;
      this.stopPing();
      if (this.active) {
        this.setStatus('error', null);
        this.scheduleReconnect();
      } else {
        this.setStatus('closed', null);
      }
    };
  }

  private scheduleReconnect(): void {
    if (!this.active || this.reconnectTimer != null) return;
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.active) this.open();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.sendRaw({ t: 'ping' });
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer != null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private teardownSocket(sendClose: boolean): void {
    this.stopPing();
    for (const k of ['l', 'r'] as StickKey[]) {
      const timer = this.stickTimer[k];
      if (timer) {
        clearTimeout(timer);
        this.stickTimer[k] = null;
      }
      this.stickPending[k] = null;
    }
    const ws = this.ws;
    if (ws) {
      this.ws = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try {
        if (sendClose) ws.close();
        else if (ws.readyState === 0 || ws.readyState === 1) ws.close();
      } catch {
        // already dead
      }
    }
  }

  private sendRaw(obj: object): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1 /* OPEN */) return;
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      // socket died mid-send; onclose will handle it
    }
  }

  private setStatus(status: GamepadStatus, dev: string | null): void {
    this.status = status;
    this.dev = dev;
    if (this.listener) this.listener(status, dev);
  }
}
