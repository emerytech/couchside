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
 * Server -> client: {"t":"hello","dev":...,"text":"unicode"|"ascii"} |
 *   {"t":"pong"} | {"t":"err","msg":...}
 *   The hello `text` field advertises how much of a typed string the agent can
 *   deliver; sendText() strips non-typeable chars when it is not "unicode".
 */
import { Settings } from './settings';

export type GamepadStatus =
  | 'connecting'
  | 'connected'
  | 'error'
  | 'closed'
  /** Another device took the controller (old agent 2.9.1 sends code=replaced).
      Deliberately NOT auto-reconnected — that caused two paired phones to kick
      each other in an endless war. The user takes back control explicitly. */
  | 'replaced'
  /** Connected but WAITING for the current holder to pass control (agent >=
      2.9.2, our handoff pref = ask). Socket stays open; can force after a
      timeout. `dev` carries the holder's name. */
  | 'waiting'
  /** We held control and it was passed/taken (agent >= 2.9.2). Socket stays
      open; can request it back. `dev` carries the new holder's name. */
  | 'released';

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

/** Windows desktop system shortcuts (one-shot chords the agent expands). */
export type SystemChord = 'win' | 'alt-tab' | 'lock' | 'taskmgr';

/**
 * SteamOS/Bazzite (KDE Plasma) desktop actions the Linux agent maps on the
 * {t:'k'} channel: 'meta' taps Super (opens the Kickoff "start menu"),
 * 'overview' fires the KWin overview chord (Meta+W). Gated in the UI on
 * caps.desktop; an agent that doesn't know the name drops the frame.
 */
export type DesktopKey = 'meta' | 'overview';

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

/**
 * Keepalive ping cadence. 5s (was 20s) doubles as a radio-wake trickle for
 * SteamOS handhelds: their WiFi power-save lets the radio doze between sparse
 * packets, adding 20–90ms of jitter to the first inputs after an idle gap
 * (measured on a Legion Go — WS RTT p50 was LOWER under load than idle).
 * ~30 bytes every 5s is free; the phone's radio is already up (screen on).
 */
const PING_INTERVAL_MS = 5_000;

// ---------- d-pad input trace (diagnostic) ---------------------------------
/**
 * Rolling record of every BUTTON frame this app tried to send, and whether it
 * actually left the socket.
 *
 * Exists because the "swipe sticks and keeps going" bug is intermittent and
 * therefore not reproducible on demand. The agent's d-pad is a LATCHED
 * absolute axis, so ONE lost `v:0` pins it forever — and sendRaw() has two
 * paths that drop a frame with no error at all (socket not OPEN, and a throw
 * mid-send). Without this, a stuck episode leaves zero evidence.
 *
 * Reading a captured trace after an episode:
 *   last entry is `v:1`            -> the release was never even ATTEMPTED,
 *                                     i.e. the JS thread stalled and the timer
 *                                     never ran. (Look for a time gap.)
 *   last entry is `v:0 sent`       -> the client sent the release and it died
 *                                     downstream (wire or agent).
 *   last entry is `v:0 drop:...`   -> the release was attempted while the
 *                                     socket was not OPEN, and vanished here.
 *
 * MODULE level on purpose: a GamepadClient is recreated on reconnect, so
 * instance state would be wiped by the very disconnect worth investigating.
 */
export type InputTraceEntry = { at: number; k: string; v: number; how: string };
const TRACE_MAX = 60;
const inputTrace: InputTraceEntry[] = [];

function wsStateName(ws: { readyState?: number } | null | undefined): string {
  if (!ws) return 'none';
  return ['connecting', 'open', 'closing', 'closed'][ws.readyState ?? 3] ?? 'unknown';
}

function traceButton(k: string | undefined, v: number | undefined, how: string): void {
  if (!k) return;
  inputTrace.push({ at: Date.now(), k, v: v ?? -1, how });
  if (inputTrace.length > TRACE_MAX) inputTrace.shift();
}

/** Newest last. Copy, so callers can't mutate the buffer. */
export function getInputTrace(): InputTraceEntry[] {
  return inputTrace.slice();
}

export function clearInputTrace(): void {
  inputTrace.length = 0;
}
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
/**
 * Head start for Guide before A in the QAM chord. Sending both in the same tick
 * often reads as a bare Guide press (which opens the Steam menu, not the QAM),
 * so hold Guide alone briefly first.
 */
const QAM_GUIDE_LEAD_MS = 60;
/**
 * First retry is near-immediate: a WS drop is usually a WiFi blip or an agent
 * restart, and a 150ms retry against the cached IP reconnects before the user
 * notices. Later steps back off normally for a genuinely-down box.
 */
const BACKOFF_MS = [150, 1000, 2000, 4000];
/**
 * Abort a socket stuck in CONNECTING. React Native's WebSocket has no connect
 * timeout of its own: dialing a stale cached IP (DHCP moved the box) emits no
 * error until the OS gives up (30s+ of frozen "connecting…"). 4s comfortably
 * covers the slow path that actually works — mDNS resolution was measured at
 * ~1.6s on Android — while cutting dead-target hangs short so the reconnect
 * alternation can try the other address.
 */
const CONNECT_TIMEOUT_MS = 4000;

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
  /** Text capability from the hello frame ('unicode'|'ascii'); null until known. */
  private textCaps: 'unicode' | 'ascii' | null = null;
  private listener: GamepadStatusListener | null = null;

  // Input-injection paused state, signalled by the server (Windows agent):
  // input is refused while the box is locked / not the active desktop / an
  // elevated window has focus. The session stays connected; this just lets the
  // Pad tab hint at why nothing is moving.
  private inputBlocked = false;
  private blockedMsg: string | null = null;
  private blockedListener:
    | ((blocked: boolean, msg: string | null) => void)
    | null = null;

  // On-TV text-focus push (agent >= 2.9.12, webOS). The backend sends
  // input_focus{open,value} when a text field on the TV gains/loses focus, so
  // the app can auto-raise its keyboard. This is a transient EVENT, not a
  // persisted state — the listener fires only on receipt (no replay on
  // subscribe), so a freshly mounted view never re-pops a stale keyboard.
  private inputFocusListener:
    | ((open: boolean, value: string) => void)
    | null = null;

  // Controller handoff (agent >= 2.9.2). When this phone HOLDS control and
  // another asks for it, the agent sends control_request{name}; the UI prompts
  // Pass/Keep. controlRequest holds the pending requester name (or null).
  private controlRequest: string | null = null;
  private controlReqListener: ((name: string | null) => void) | null = null;
  /** Ask-to-pass vs grab-control, read from prefs at connect() time. */
  private handoffAsk = true;
  /** This device's label, sent so the holder's prompt can name the requester. */
  private deviceName = 'A device';

  /** True between connect() and close(): reconnect on failure while set. */
  private active = false;
  private conn: Conn | null = null;
  private attempt = 0;
  /**
   * When true, open() dials the ALTERNATE address (the mDNS hostname) instead
   * of the primary (the cached IP). The cached IP is primary because it was
   * measured ~9ms to connect where Android mDNS resolution takes ~1.6s — with
   * hostname-first, every reconnect stalled the remote for that long. Failed
   * attempts alternate this so a box whose IP moved (DHCP) is still reached
   * via its .local name on the next try. Sticky while the target stays the
   * same, so a working path keeps being used.
   */
  private useFallback = false;

  private pingTimer: ReturnType<typeof setInterval> | null = null;
  /** Timestamp of the last frame RECEIVED on the current socket — the liveness
   *  signal the ping watchdog checks. Any inbound frame counts (pong, hello,
   *  waiting…): each one proves the pipe is genuinely two-way. */
  private lastInbound = 0;
  /** Wall-clock of the last INPUT frame we sent (mouse/button/key/stick — not a
   *  ping). Lets the watchdog react faster while the user is actively driving:
   *  a half-dead socket mid-drag (a Game-Mode Wi-Fi blip during a Couch Mode
   *  switch) should reconnect in ~one ping interval, not the full idle window,
   *  so the trackpad doesn't freeze for 12s. */
  private lastInputAt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Aborts a socket stuck in CONNECTING (see CONNECT_TIMEOUT_MS). */
  private connectTimer: ReturnType<typeof setTimeout> | null = null;

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

  /** Register the (single) control-request listener; fires immediately. Gets
   *  the requesting device's name while a handoff is pending, else null. */
  onControlRequest(fn: ((name: string | null) => void) | null): void {
    this.controlReqListener = fn;
    if (fn) fn(this.controlRequest);
  }

  private setControlRequest(name: string | null): void {
    if (this.controlRequest === name) return;
    this.controlRequest = name;
    if (this.controlReqListener) this.controlReqListener(name);
  }

  /** Holder taps "Pass control": hand off to the waiting device. */
  grantControl(): void {
    this.sendRaw({ t: 'grant' });
    this.setControlRequest(null);
  }

  /** Holder taps "Keep control": refuse the pending request. */
  denyControl(): void {
    this.sendRaw({ t: 'deny' });
    this.setControlRequest(null);
  }

  /** Waiter/released device asks the current holder to pass control. */
  requestControl(): void {
    this.sendRaw({ t: 'request' });
  }

  /** Waiter takes control when the holder never answered (post-timeout). */
  forceControl(): void {
    this.sendRaw({ t: 'force' });
  }

  /**
   * Register the (single) input-blocked listener; fires immediately with the
   * current state. Fires with `true` when the server reports input injection
   * is paused (box locked / not the active desktop / elevated window focused)
   * and `false` when it resumes or the connection drops.
   */
  onInputBlocked(
    fn: ((blocked: boolean, msg: string | null) => void) | null,
  ): void {
    this.blockedListener = fn;
    if (fn) fn(this.inputBlocked, this.blockedMsg);
  }

  /**
   * Register the (single) on-TV text-focus listener. Unlike the state
   * listeners above it does NOT fire immediately: input_focus is an event, so
   * replaying a stale value on subscribe could pop the keyboard for a field the
   * user already left. Fires with (open, value) on each pushed transition.
   */
  onInputFocus(fn: ((open: boolean, value: string) => void) | null): void {
    this.inputFocusListener = fn;
  }

  private emitInputFocus(open: boolean, value: string): void {
    if (this.inputFocusListener) this.inputFocusListener(open, value);
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
  connect(conn: Conn, opts?: { handoffAsk?: boolean; deviceName?: string }): void {
    if (opts?.handoffAsk != null) this.handoffAsk = opts.handoffAsk;
    if (opts?.deviceName) this.deviceName = opts.deviceName;
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
    // Hold Guide alone first, then press A, so Steam reads a real Guide+A chord
    // (QAM) rather than a bare Guide press (Steam menu). Release A before Guide.
    setTimeout(() => {
      this.sendButton('a', 1);
      setTimeout(() => {
        this.sendButton('a', 0);
        this.sendButton('guide', 0);
      }, QAM_CHORD_HOLD_MS);
    }, QAM_GUIDE_LEAD_MS);
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

  /**
   * Type a string. Smart-quote / dash / ellipsis / NBSP autocorrect artifacts
   * are ALWAYS normalized to ASCII (they are never user intent, and this routes
   * the common case through the reliable per-key path on every agent version).
   * When the agent did not advertise unicode support, anything the ASCII keymap
   * cannot type is stripped, so an old agent never receives an unmappable char
   * (which previously dropped the whole WebSocket).
   */
  sendText(text: string): void {
    let s = text
      .replace(/[‘’]/g, "'") // smart single quotes
      .replace(/[“”]/g, '"') // smart double quotes
      .replace(/[–—]/g, '-') // en/em dash
      .replace(/…/g, '...') // ellipsis
      .replace(/\u00a0/g, ' '); // non-breaking space
    if (this.textCaps !== 'unicode') {
      // Keep printable ASCII plus tab/newline; drop everything else.
      s = s.replace(/[^\x20-\x7e\t\n]/g, '');
    }
    if (!s) return;
    this.sendRaw({ t: 'kt', text: s });
  }

  /** A single special key press+release (backspace, enter, arrows, …). */
  sendKey(key: SpecialKey): void {
    this.sendRaw({ t: 'k', key });
  }

  /**
   * Fire a SteamOS/Bazzite (KDE Plasma) desktop action — the Start menu (Meta)
   * or Overview (Meta+W). Rides the same {t:'k'} channel; the Linux agent maps
   * the name to a key/chord and presses/releases it. Linux-desktop-only (the
   * buttons that call this render only when caps.desktop is set); another agent
   * rejects the unknown name and drops the frame.
   */
  sendDesktopKey(key: DesktopKey): void {
    this.sendRaw({ t: 'k', key });
  }

  /**
   * Fire a one-shot Windows system shortcut (Start / Alt+Tab / Lock / Task
   * Manager). Rides the same {t:'k'} channel — the agent maps the name to a
   * key-chord and presses/releases it. Windows-only (the buttons that call this
   * only render for a ViGEm box); a Linux agent rejects the unknown name and
   * drops the frame.
   */
  sendSystemChord(name: SystemChord): void {
    this.sendRaw({ t: 'k', key: name });
  }

  // ---------- internals ----------

  private open(): void {
    if (!this.conn) return;
    this.teardownSocket(false);
    this.setStatus('connecting', null);

    const { host, port, token, lastIp } = this.conn;
    // Resolve to a NON-EMPTY host. `host` is blank when the box was paired by IP
    // before its mDNS name was learned (the settings default host is ''), and the
    // cached LAN IP is then the real address — the HTTP API falls back to it the
    // same way. This MUST never hand an empty host to the native WebSocket: okhttp
    // throws IllegalArgumentException("Invalid URL host: \"\"") on the native
    // modules thread (mqt_v_native), which the try/catch below CANNOT catch (it is
    // raised asynchronously, off the JS thread) and which crashes the whole app.
    const cleanHost = (host || '').trim();
    const cleanIp = (lastIp || '').trim();
    // IP-first: the cached LAN IP connects in ~9ms where Android mDNS takes
    // ~1.6s, so it is the primary; the hostname is the alternate for when the
    // IP goes stale. With a single known address there is nothing to alternate.
    const primary = cleanIp || cleanHost;
    const alternate = cleanIp && cleanHost && cleanHost !== cleanIp ? cleanHost : '';
    const target = this.useFallback && alternate ? alternate : primary;
    if (!target || !port) {
      // Nothing dialable yet (box not paired, no address). Stay quietly errored;
      // connect() re-runs when host/port/token change, so pairing recovers this.
      this.setStatus('error', null);
      return;
    }
    const url =
      `ws://${target}:${port}/ws/gamepad?token=${encodeURIComponent(token)}` +
      `&handoff=${this.handoffAsk ? 'ask' : 'takeover'}` +
      `&name=${encodeURIComponent(this.deviceName)}`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.setStatus('error', null);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    // Connect watchdog: a dead target (stale cached IP) leaves the socket in
    // CONNECTING with no error for 30s+. Cut it short so scheduleReconnect can
    // flip to the alternate address. Cleared on onopen / teardown.
    this.clearConnectWatchdog();
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (ws !== this.ws || ws.readyState !== 0 /* CONNECTING */) return;
      this.teardownSocket(false);
      if (this.active) {
        this.setStatus('error', null);
        this.scheduleReconnect();
      }
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      if (ws !== this.ws) return;
      this.clearConnectWatchdog();
    };

    ws.onmessage = (ev: WebSocketMessageEvent) => {
      // A reconnect can replace this.ws while this socket's callbacks are still
      // pending, so ignore events from a socket we have already superseded.
      // (Same guard in onerror/onclose below.)
      if (ws !== this.ws) return;
      this.lastInbound = Date.now();
      let msg: {
        t?: string; dev?: string; msg?: string; text?: string;
        code?: string; name?: string; holder?: string; by?: string;
        open?: boolean; value?: string;
      };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.t === 'hello') {
        this.attempt = 0;
        this.setControlRequest(null); // any pending prompt is moot now
        this.dev = typeof msg.dev === 'string' ? msg.dev : null;
        // Text capability: an explicit hello field wins; otherwise default by
        // device — old Windows agents (ViGEm) already type full unicode via
        // KEYEVENTF_UNICODE, old Linux agents are ASCII-only.
        this.textCaps =
          msg.text === 'unicode' || msg.text === 'ascii'
            ? msg.text
            : this.dev === 'ViGEm X360 pad'
              ? 'unicode'
              : 'ascii';
        this.setStatus('connected', this.dev);
        this.startPing();
      } else if (msg.t === 'waiting') {
        // Agent >= 2.9.2: connected but a WAITER — another phone holds control
        // and we asked to take over. Socket stays open; the UI shows a wait +
        // force-after-timeout affordance. Do NOT reconnect.
        this.dev = typeof msg.holder === 'string' ? msg.holder : null;
        this.setStatus('waiting', this.dev);
        this.startPing();
      } else if (msg.t === 'control_request') {
        // We HOLD control and another device wants it — prompt Pass/Keep.
        this.setControlRequest(typeof msg.name === 'string' ? msg.name : 'A device');
      } else if (msg.t === 'released') {
        // We were the holder; control passed/taken away. Socket stays open so
        // we can request it back without reconnecting.
        this.dev = typeof msg.by === 'string' ? msg.by : null;
        this.setControlRequest(null);
        this.setStatus('released', this.dev);
      } else if (msg.t === 'denied') {
        // Our request to take control was refused — still a connected waiter.
        this.setStatus('waiting', this.dev);
      } else if (msg.t === 'err') {
        if (msg.code === 'replaced') {
          // Old agent (2.9.1) forced-takeover path: it closes the socket. STOP
          // reconnecting; the UI offers an explicit take-over (connect()).
          this.active = false;
          this.setStatus('replaced', null);
          return;
        }
        // Other server failures close the socket; onclose handles reconnect.
        this.setStatus('error', null);
      } else if (msg.t === 'blocked') {
        this.setInputBlocked(true, typeof msg.msg === 'string' ? msg.msg : null);
      } else if (msg.t === 'resumed') {
        this.setInputBlocked(false, null);
      } else if (msg.t === 'input_focus') {
        // A text field on the TV opened/closed (webOS). Relay to the view so it
        // can raise/dismiss the phone keyboard; value carries any current text.
        this.emitInputFocus(
          msg.open === true,
          typeof msg.value === 'string' ? msg.value : '',
        );
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
      this.setControlRequest(null);
      if (this.active) {
        this.setStatus('error', null);
        this.scheduleReconnect();
      } else if (this.status !== 'replaced') {
        // 'replaced' must survive the close that follows it — it carries the
        // take-over affordance in the UI.
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

  private clearConnectWatchdog(): void {
    if (this.connectTimer != null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private startPing(): void {
    this.stopPing();
    this.lastInbound = Date.now();
    this.pingTimer = setInterval(() => {
      // Pong watchdog. A session-switch or Wi-Fi blip on the box can leave
      // this TCP half-dead: iOS keeps buffering our sends without erroring, so
      // pings AND input frames vanish silently while the socket still reports
      // OPEN — the user swipes a live-looking trackpad that moves nothing, and
      // the server reaps the mute session at its own 60s timeout. (Observed in
      // the field; HTTP kept working because every request is a fresh
      // connection.) The server answers every ping with a pong, so a healthy
      // pipe always has an inbound frame within one interval. Silence for
      // ~2.5 intervals means the pipe is gone: tear down and reconnect NOW
      // instead of waiting minutes for the OS to notice.
      // While the user is ACTIVELY driving (input sent within the last
      // interval), tighten that to ~1.4 intervals: a healthy socket still pongs
      // every interval, so >1.4 stale is genuinely dead — a frozen trackpad that
      // recovers in ~7s beats one frozen for ~13s. This is the Couch-Mode-switch
      // case: the mode change blips Wi-Fi, the socket half-dies mid-drag, and the
      // old 2.5-interval window left the pointer dead for 12s.
      const activelyDriving = Date.now() - this.lastInputAt < PING_INTERVAL_MS;
      const deadline = PING_INTERVAL_MS * (activelyDriving ? 1.4 : 2.5);
      if (Date.now() - this.lastInbound > deadline) {
        this.teardownSocket(false);
        if (this.active) {
          this.setStatus('error', null);
          this.scheduleReconnect();
        }
        return;
      }
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
    this.clearConnectWatchdog();
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
    const f = obj as { t?: string; k?: string; v?: number };
    if (!ws || ws.readyState !== 1 /* OPEN */) {
      // SILENT DROP #1: the socket is not OPEN. A d-pad release lost here pins
      // the agent's latched hat axis forever, with nothing anywhere recording
      // that it happened. Trace it.
      if (f.t === 'b') traceButton(f.k, f.v, 'drop:' + wsStateName(ws));
      return;
    }
    // Note real input (anything but our own keepalive ping) so the watchdog can
    // tighten its dead-socket deadline while the user is actively driving.
    if (f.t !== 'ping') this.lastInputAt = Date.now();
    try {
      ws.send(JSON.stringify(obj));
      if (f.t === 'b') traceButton(f.k, f.v, 'sent');
    } catch {
      // SILENT DROP #2: socket died mid-send; onclose will handle it.
      if (f.t === 'b') traceButton(f.k, f.v, 'throw');
    }
  }

  private setStatus(status: GamepadStatus, dev: string | null): void {
    this.status = status;
    this.dev = dev;
    // A blocked hint (and the negotiated text caps) only make sense while
    // connected; clear them otherwise so nothing stale outlives the connection.
    if (status !== 'connected') {
      this.setInputBlocked(false, null);
      this.textCaps = null;
    }
    if (this.listener) this.listener(status, dev);
  }

  private setInputBlocked(blocked: boolean, msg: string | null): void {
    const nextMsg = blocked ? msg : null;
    if (this.inputBlocked === blocked && this.blockedMsg === nextMsg) return;
    this.inputBlocked = blocked;
    this.blockedMsg = nextMsg;
    if (this.blockedListener) this.blockedListener(blocked, nextMsg);
  }
}
