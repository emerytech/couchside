/**
 * WebSocket client for the live volume OSD. Endpoint:
 * ws://<host>:<port>/ws/volume?token=<token>.
 *
 * Receive-only: the agent pushes a relative nudge `{t:'vol',dir:'up'|'down'|
 * 'mute'}` whenever Couchside itself runs a volume op, so the phone can flash a
 * volume overlay without the user looking at the TV. (An absolute level can't be
 * read on a passthrough-audio box / a TV that won't report it — see the agent's
 * /ws/volume note.)
 *
 * Mirrors the essential lib/screenstream.ts machinery — host resolution, a
 * connect watchdog, backoff reconnect, a superseded-socket guard — but is tiny:
 * JSON frames, no decode. It DOES send a periodic keepalive so the agent's idle
 * reaper (65s) doesn't drop a healthy but quiet connection; a backgrounded phone
 * stops pinging, is reaped, and reconnects on foreground (fine — nobody's
 * looking at a volume OSD while the app is backgrounded).
 *
 * A box on an OLD agent (no /ws/volume) closes the socket on upgrade; that just
 * means no OSD — the reconnect backs off and the app is otherwise unaffected.
 */
import { resolveEffectiveHost, type ConnSettings } from './api';
import { openBoxSocket, type BoxSocketLike } from './boxTransport.ts';

export type VolumeDir = 'up' | 'down' | 'mute';

const CONNECT_TIMEOUT_MS = 8000;
const BACKOFF_MS = [1000, 2000, 4000, 8000];
const KEEPALIVE_MS = 25000; // < the agent's VOLUME_IDLE_TIMEOUT_S (65s)

export class VolumeStreamClient {
  private ws: BoxSocketLike | null = null;
  private settings: ConnSettings | null = null;
  private active = false;
  private nudgeCb: ((dir: VolumeDir) => void) | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private backoffIdx = 0;

  onNudge(cb: ((dir: VolumeDir) => void) | null): void {
    this.nudgeCb = cb;
  }

  start(settings: ConnSettings): void {
    this.settings = settings;
    this.active = true;
    this.backoffIdx = 0;
    this.open();
  }

  stop(): void {
    this.active = false;
    this.settings = null;
    this.clearTimers();
    this.teardownSocket();
  }

  private open(): void {
    if (!this.active || !this.settings) return;
    this.teardownSocket();
    const host = resolveEffectiveHost(this.settings);
    const { port, token } = this.settings;
    if (!host || !port) {
      this.scheduleReconnect();
      return;
    }
    const path = `/ws/volume?token=${encodeURIComponent(token)}`;
    let ws: BoxSocketLike;
    try {
      ws = openBoxSocket(
        {
          host,
          port,
          secure: this.settings.secure,
          tlsPort: this.settings.tlsPort,
          pinModulus: this.settings.pinModulus,
        },
        path,
      );
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    // A dead target can leave the socket CONNECTING with no error; cut it short.
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (ws !== this.ws || ws.readyState !== 0 /* CONNECTING */) return;
      this.teardownSocket();
      if (this.active) this.scheduleReconnect();
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      if (ws !== this.ws) return;
      if (this.connectTimer) {
        clearTimeout(this.connectTimer);
        this.connectTimer = null;
      }
      this.backoffIdx = 0;
      this.startKeepalive();
    };
    ws.onmessage = (ev: { data: string | ArrayBuffer }) => {
      if (ws !== this.ws || typeof ev.data !== 'string') return;
      let msg: { t?: string; dir?: string } | null = null;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg?.t === 'vol' && (msg.dir === 'up' || msg.dir === 'down' || msg.dir === 'mute')) {
        this.nudgeCb?.(msg.dir);
      }
    };
    ws.onerror = () => {
      /* onclose follows and schedules the reconnect */
    };
    ws.onclose = () => {
      if (ws !== this.ws) return;
      this.teardownSocket();
      if (this.active) this.scheduleReconnect();
    };
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== 1 /* OPEN */) return;
      try {
        ws.send('{"t":"ping"}'); // the agent ignores it; the byte resets its idle clock
      } catch {
        /* a failed send surfaces via onclose */
      }
    }, KEEPALIVE_MS);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.active || this.reconnectTimer) return;
    const delay = BACKOFF_MS[Math.min(this.backoffIdx, BACKOFF_MS.length - 1)];
    this.backoffIdx += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private clearTimers(): void {
    for (const t of [this.connectTimer, this.reconnectTimer]) {
      if (t) clearTimeout(t);
    }
    this.connectTimer = null;
    this.reconnectTimer = null;
    this.stopKeepalive();
  }

  private teardownSocket(): void {
    this.stopKeepalive();
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try {
      ws.close();
    } catch {
      /* already gone */
    }
  }
}
