/**
 * WebSocket client for the Couchside FLUID screen stream (remote-desktop P4a,
 * the opt-in portal module). Endpoint: ws://<host>:<port>/ws/screen?token=<token>
 * &profile=<id>.
 *
 * Receive-only: the agent pushes whole JPEG frames as BINARY WS frames (the
 * portal helper's gstreamer MJPEG). This mirrors the essential machinery of
 * lib/gamepad.ts — IP/host resolution, a connect watchdog, backoff reconnect,
 * and a superseded-socket guard on every callback — but carries no senders and
 * no keepalive (the frames themselves are the liveness).
 *
 * Frames are decoded to a base64 `data:` URI for <Image> the same way the HTTP
 * still-frame path does (no raw <Image> URL: the token can't ride the src and a
 * frame may show a password prompt, so nothing lands in Fresco's disk cache).
 * Only the NEWEST frame is ever surfaced — base64 is CPU-heavy, so a slow phone
 * DROPS intermediate frames rather than queueing latency.
 *
 * A box WITHOUT the module: /ws/screen opens then immediately closes (the agent
 * degrades closed), so `onStatus('error')` fires and the caller falls back to
 * the P1 still-frame poller.
 */
import { base64FromArrayBuffer, resolveEffectiveHost, type ConnSettings } from './api';
import { openBoxSocket, type BoxSocketLike } from './boxTransport.ts';
import { isUsableBodySize } from './responseCap';

export type StreamStatus = 'connecting' | 'connected' | 'error' | 'closed';
export type StreamProfile = '540p25' | '720p20' | '1080p15';

// A dead target leaves the socket CONNECTING with no error; cut it short so the
// reconnect can retry. Same intent as GamepadClient's connect watchdog.
const CONNECT_TIMEOUT_MS = 8000;
const BACKOFF_MS = [500, 1000, 2000, 4000];

export class ScreenStreamClient {
  private ws: BoxSocketLike | null = null;
  private settings: ConnSettings | null = null;
  private profile: StreamProfile = '720p20';
  private active = false;
  private frameCb: ((uri: string) => void) | null = null;
  private statusCb: ((s: StreamStatus) => void) | null = null;
  private status: StreamStatus = 'closed';
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffIdx = 0;
  // Newest-only DECODE: onmessage stores the freshest raw frame here (cheap) and
  // a per-render-tick job base64-decodes just that one, dropping any that piled
  // up undecoded. Without this, the phone decodes every frame the native WS
  // hands it — and hardware jpeg on the box out-produces the JS decode on high
  // motion, so a backlog serializes into seconds of DISPLAY lag (input is on a
  // separate socket and stays instant).
  private pendingFrame: ArrayBuffer | null = null;
  private decodeScheduled = false;
  private rafId: ReturnType<typeof requestAnimationFrame> | null = null;

  onFrame(cb: ((uri: string) => void) | null): void {
    this.frameCb = cb;
  }

  onStatus(cb: ((s: StreamStatus) => void) | null): void {
    this.statusCb = cb;
    if (cb) cb(this.status);
  }

  start(settings: ConnSettings, profile: StreamProfile = '720p20'): void {
    this.settings = settings;
    this.profile = profile;
    this.active = true;
    this.backoffIdx = 0;
    this.open();
  }

  stop(): void {
    this.active = false;
    this.clearReconnect();
    this.teardownSocket();
    this.setStatus('closed');
  }

  private setStatus(s: StreamStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.statusCb?.(s);
  }

  private open(): void {
    if (!this.active || !this.settings) return;
    this.teardownSocket(); // drop any prior socket first
    this.setStatus('connecting');
    const host = resolveEffectiveHost(this.settings);
    const { port, token } = this.settings;
    if (!host || !port) {
      this.setStatus('error');
      this.scheduleReconnect();
      return;
    }
    // Path (token + profile) rides the ENCRYPTED handshake on a secure box; the
    // pinned transport picks its own tlsPort. Plaintext ws:// otherwise.
    const path =
      `/ws/screen?token=${encodeURIComponent(token)}&profile=${this.profile}`;
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
      this.setStatus('error');
      this.scheduleReconnect();
      return;
    }
    // RN defaults binaryType to 'blob'; we need ArrayBuffer to decode inline.
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (ws !== this.ws || ws.readyState !== 0 /* CONNECTING */) return;
      this.teardownSocket();
      if (this.active) {
        this.setStatus('error');
        this.scheduleReconnect();
      }
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      if (ws !== this.ws) return; // superseded
      this.clearConnectTimer();
      this.backoffIdx = 0;
      this.setStatus('connected');
    };
    ws.onmessage = (ev: { data: string | ArrayBuffer }) => {
      if (ws !== this.ws) return;
      const data = ev.data as unknown;
      if (typeof data === 'string') return; // this stream carries no text frames
      if (!(data instanceof ArrayBuffer)) return; // ignore stray frames
      if (!isUsableBodySize(data.byteLength)) return;
      // Store the newest raw frame and decode on the next tick — do NOT decode
      // here. Decoding every frame the native WS delivers serializes a backlog
      // into display lag; overwriting keeps only the freshest and the piled-up
      // older frames are dropped UNDECODED.
      this.pendingFrame = data;
      this.scheduleDecode();
    };
    ws.onerror = () => {
      if (ws !== this.ws) return;
      this.setStatus('error'); // onclose follows and schedules the reconnect
    };
    ws.onclose = () => {
      if (ws !== this.ws) return;
      this.ws = null;
      this.clearConnectTimer();
      if (this.active) {
        this.setStatus('error');
        this.scheduleReconnect();
      } else {
        this.setStatus('closed');
      }
    };
  }

  private scheduleReconnect(): void {
    if (!this.active || this.reconnectTimer != null) return;
    const wait = BACKOFF_MS[Math.min(this.backoffIdx, BACKOFF_MS.length - 1)];
    this.backoffIdx++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, wait);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer != null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  // Decode at most one frame per render tick — the freshest — and drop the rest.
  private scheduleDecode(): void {
    if (this.decodeScheduled) return;
    this.decodeScheduled = true;
    this.rafId = requestAnimationFrame(() => this.decodePending());
  }

  private decodePending(): void {
    this.decodeScheduled = false;
    this.rafId = null;
    const data = this.pendingFrame;
    this.pendingFrame = null;
    if (!data) return;
    const uri = `data:image/jpeg;base64,${base64FromArrayBuffer(data)}`;
    this.frameCb?.(uri);
    // Frames that arrived while decoding overwrote pendingFrame — take the
    // freshest on the next tick (again just one; anything between is dropped).
    if (this.pendingFrame) this.scheduleDecode();
  }

  private clearDecode(): void {
    if (this.rafId != null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.decodeScheduled = false;
    this.pendingFrame = null;
  }

  private teardownSocket(): void {
    this.clearConnectTimer();
    this.clearDecode();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
  }
}
