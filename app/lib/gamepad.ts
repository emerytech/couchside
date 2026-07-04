/**
 * WebSocket client for the Couchside agent virtual gamepad (protocol v2).
 *
 * Endpoint: ws://<host>:<port>/ws/gamepad?token=<token>
 * The session creates a virtual Xbox 360 pad on connect; mouse + keyboard
 * uinput devices are created lazily on the server on first use and torn down
 * with the pad on disconnect.
 *
 * Client -> server (one JSON object per text frame):
 *   -- gamepad (v1) --
 *   {"t":"b","k":K,"v":0|1}            button
 *   {"t":"t","k":"lt"|"rt","v":0..255} analog trigger
 *   {"t":"s","k":"l"|"r","x":F,"y":F}  stick, -1..1, +y DOWN
 *   {"t":"ping"}                       keepalive
 *   -- mouse (v2) --
 *   {"t":"m","dx":I,"dy":I}            relative move (REL_X/REL_Y)
 *   {"t":"mb","k":"l"|"r"|"m","v":0|1} button (BTN_LEFT/RIGHT/MIDDLE)
 *   {"t":"mw","dy":I}                  vertical wheel (dy>0 = scroll up)
 *   -- keyboard (v2) --
 *   {"t":"kt","text":S}                type a string
 *   {"t":"k","key":NAME}              a single special key
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

/** Mouse button keys (BTN_LEFT/RIGHT/MIDDLE). */
export type MouseButton = 'l' | 'r' | 'm';

/** Special keys the server maps to KEY_* codes (see protocol v2). */
export type SpecialKey =
  | 'backspace'
  | 'enter'
  | 'tab'
  | 'esc'
  | 'space'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'home'
  | 'end';

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
/**
 * Mouse-move send throttle: ~90 Hz. Deltas that arrive between sends are
 * accumulated (coalesced) and flushed as one {"t":"m"} frame, so a burst of
 * PanResponder callbacks never floods the socket yet no motion is lost.
 */
const MOUSE_MOVE_INTERVAL_MS = 11;
/**
 * Guide+A "Quick Access Menu" chord hold. Steam needs A to register while Guide
 * is still held; 120ms sits in the reliable 80-150ms window for SteamOS.
 */
const QAM_CHORD_HOLD_MS = 120;
const BACKOFF_MS = [1000, 2000, 4000];

export type GamepadStatusListener = (status: GamepadStatus, dev: string | null) => void;

type Conn = Pick<Settings, 'host' | 'port' | 'token' | 'lastIp'>;

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
  /**
   * When true, open() dials conn.lastIp instead of conn.host. Failed attempts
   * alternate this so a box whose .local name has gone dark (SteamOS Game
   * Mode mDNS) is reached via its cached IP on the next try. Sticky while the
   * target stays the same, so a working fallback keeps being used.
   */
  private useFallback = false;

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

  // Mouse-move coalescing: accumulate sub-throttle deltas and flush on a
  // trailing timer so fast drags don't storm the socket.
  private mouseLastSent = 0;
  private mousePending: { dx: number; dy: number } = { dx: 0, dy: 0 };
  private mouseTimer: ReturnType<typeof setTimeout> | null = null;

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
    // Always take the latest conn (a refreshed lastIp must be visible to
    // future reconnects), but never tear down a healthy socket for it.
    this.conn = conn;
    if (
      same &&
      this.active &&
      (this.status === 'connected' || this.status === 'connecting')
    ) {
      return;
    }
    if (!same) this.useFallback = false;
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

  /**
   * Fire the Steam Deck "Quick Access Menu" (⋯) chord. Steam maps Guide + A on
   * an Xbox pad to the QAM (the right-side panel where Decky and other plugins
   * live), while Guide alone opens the Steam menu. So press Guide, then A (Guide
   * first, so it is already held when A registers), hold briefly, then release A
   * before Guide. Auto-releases: one call = one momentary ⋯ press. A no-op while
   * disconnected (sendRaw drops frames when the socket is down), and releaseAll()
   * on blur/close covers a chord interrupted mid-hold.
   */
  qamChord(): void {
    this.sendButton('guide', 1);
    this.sendButton('a', 1);
    setTimeout(() => {
      this.sendButton('a', 0);
      this.sendButton('guide', 0);
    }, QAM_CHORD_HOLD_MS);
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

  // ---------- mouse (v2) ----------

  /**
   * Relative pointer move. Deltas are accumulated and sent at ~90 Hz; the
   * server creates the virtual mouse on the first frame. Zero-delta calls are
   * dropped so idle drags emit nothing.
   */
  sendMouseMove(dx: number, dy: number): void {
    const idx = Math.round(dx);
    const idy = Math.round(dy);
    if (idx === 0 && idy === 0) return;

    this.mousePending.dx += idx;
    this.mousePending.dy += idy;

    const now = Date.now();
    if (now - this.mouseLastSent >= MOUSE_MOVE_INTERVAL_MS && this.mouseTimer == null) {
      this.flushMouseMove();
      return;
    }
    if (this.mouseTimer == null) {
      const wait = Math.max(1, MOUSE_MOVE_INTERVAL_MS - (now - this.mouseLastSent));
      this.mouseTimer = setTimeout(() => {
        this.mouseTimer = null;
        this.flushMouseMove();
      }, wait);
    }
  }

  private flushMouseMove(): void {
    const { dx, dy } = this.mousePending;
    this.mousePending = { dx: 0, dy: 0 };
    this.mouseLastSent = Date.now();
    if (dx === 0 && dy === 0) return;
    this.sendRaw({ t: 'm', dx, dy });
  }

  /** Mouse button press/release (BTN_LEFT/RIGHT/MIDDLE). */
  sendMouseButton(k: MouseButton, v: 0 | 1): void {
    this.sendRaw({ t: 'mb', k, v });
  }

  /** Vertical wheel scroll; dy>0 scrolls up. */
  sendWheel(dy: number): void {
    const idy = Math.round(dy);
    if (idy === 0) return;
    this.sendRaw({ t: 'mw', dy: idy });
  }

  // ---------- keyboard (v2) ----------

  /** Type a string (printable ASCII). Server maps each char to KEY_* codes. */
  sendText(text: string): void {
    if (!text) return;
    this.sendRaw({ t: 'kt', text });
  }

  /** A single special key press+release (backspace, enter, arrows, …). */
  sendKey(key: SpecialKey): void {
    this.sendRaw({ t: 'k', key });
  }

  // ---------- internals ----------

  private open(): void {
    if (!this.conn) return;
    this.teardownSocket(false);
    this.setStatus('connecting', null);

    const { host, port, token, lastIp } = this.conn;
    const target = this.useFallback && lastIp ? lastIp : host;
    const url = `ws://${target}:${port}/ws/gamepad?token=${encodeURIComponent(token)}`;

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
      // A reconnect can replace this.ws while this socket's callbacks are still
      // pending, so ignore events from a socket we have already superseded.
      // (Same guard in onerror/onclose below.)
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
    // Alternate hostname <-> cached IP between attempts so whichever path is
    // alive gets tried within one backoff step.
    const c = this.conn;
    if (c?.lastIp && c.lastIp !== c.host) {
      this.useFallback = !this.useFallback;
    }
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
    if (this.mouseTimer != null) {
      clearTimeout(this.mouseTimer);
      this.mouseTimer = null;
    }
    this.mousePending = { dx: 0, dy: 0 };
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
