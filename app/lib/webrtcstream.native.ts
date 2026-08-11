/**
 * Native WebRTC client for the Couchside H.264 screen stream (remote-desktop
 * P4b P0). Endpoint: ws://<host>:<port>/ws/webrtc?token=<token>&profile=<id>.
 *
 * The BOX offers (sendonly H.264); this side answers and renders the remote
 * track with <RTCView> (hardware decode — VideoToolbox on iOS, MediaCodec on
 * Android). The agent's /ws/webrtc is a dumb JSON relay to the portal helper's
 * webrtcbin; we exchange only offer/answer/ice/bye/error. LAN-only ICE: no STUN,
 * no TURN — host candidates + peer-reflexive (proven to pair with libnice over
 * WiFi in B0).
 *
 * ONE-SHOT, not the reconnect loop that lib/screenstream.ts runs: a WebRTC
 * session is expensive (it re-pops the box's consent), so on any hard failure we
 * report 'error' ONCE and stop — the desktop route then falls back to the MJPEG
 * stream (caps.screenstream), which owns its own reconnect. Two timeouts guard
 * that: a connect watchdog (WS stuck opening) and a post-answer negotiation
 * timeout. There is deliberately NO timeout while waiting for the offer, because
 * that window is the user walking to the box to click Approve.
 */
import { RTCIceCandidate, RTCPeerConnection, RTCSessionDescription } from 'react-native-webrtc';

import { resolveEffectiveHost, type ConnSettings } from './api';
import type {
  IWebRtcStreamClient, WebRtcProfile, WebRtcStatus,
} from './webrtcstreamTypes';

export const webrtcSupported: boolean = true;

// A dead target leaves the WS CONNECTING with no error; cut it short.
const CONNECT_TIMEOUT_MS = 8000;
// After we send the answer, how long to wait for ICE to actually connect before
// giving up and falling back to MJPEG. On a LAN this is a second or two; be
// generous for WiFi. This does NOT cover the consent wait (that is pre-offer).
const NEGOTIATE_TIMEOUT_MS = 12000;

export class WebRtcStreamClient implements IWebRtcStreamClient {
  private ws: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private settings: ConnSettings | null = null;
  private profile: WebRtcProfile = '720p60';
  private active = false;
  private streamCb: ((url: string | null) => void) | null = null;
  private statusCb: ((s: WebRtcStatus) => void) | null = null;
  private status: WebRtcStatus = 'closed';
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private negotiateTimer: ReturnType<typeof setTimeout> | null = null;

  onStream(cb: ((url: string | null) => void) | null): void {
    this.streamCb = cb;
  }

  onStatus(cb: ((s: WebRtcStatus) => void) | null): void {
    this.statusCb = cb;
    if (cb) cb(this.status);
  }

  start(settings: ConnSettings, profile: WebRtcProfile = '720p60'): void {
    this.settings = settings;
    this.profile = profile;
    this.active = true;
    this.open();
  }

  stop(): void {
    this.active = false;
    this.teardown();
    this.setStatus('closed');
  }

  private setStatus(s: WebRtcStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.statusCb?.(s);
  }

  private fail(reason?: string): void {
    // Hard, terminal failure -> report once and stop (no reconnect); the caller
    // falls back to MJPEG. Guarded by `active` so stop() stays quiet.
    if (!this.active) return;
    console.log('[webrtc] FAIL:', reason ?? '(unknown)');
    this.teardown();
    this.setStatus('error');
  }

  private open(): void {
    if (!this.active || !this.settings) return;
    this.setStatus('connecting');
    const host = resolveEffectiveHost(this.settings);
    const { port, token } = this.settings;
    if (!host || !port) {
      this.fail();
      return;
    }
    const url =
      `ws://${host}:${port}/ws/webrtc?token=${encodeURIComponent(token)}` +
      `&profile=${this.profile}`;
    console.log('[webrtc] connecting', host, port, this.profile);
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      this.fail('WebSocket ctor threw ' + String(e));
      return;
    }
    this.ws = ws;

    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (ws !== this.ws || ws.readyState !== 0 /* CONNECTING */) return;
      this.fail('connect watchdog (WS stuck CONNECTING)');
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      if (ws !== this.ws) return;
      console.log('[webrtc] ws open');
      this.clearTimer('connect');
      this.setupPeer();          // ready to answer once the offer arrives
    };
    ws.onmessage = (ev: WebSocketMessageEvent) => {
      if (ws !== this.ws) return;
      if (typeof ev.data !== 'string') return;
      this.onSignal(ev.data);
    };
    ws.onerror = (e: unknown) => {
      if (ws !== this.ws) return;
      this.fail('ws onerror ' + String((e as { message?: string })?.message ?? ''));
    };
    ws.onclose = (e: unknown) => {
      if (ws !== this.ws) return;
      // A box without a working H.264 path (or Game Mode) closes right away ->
      // fall back. If we were already connected+streaming, a close is also the end.
      this.fail('ws onclose code=' + String((e as { code?: number })?.code ?? '?'));
    };
  }

  private send(obj: unknown): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1 /* OPEN */) return;
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      this.fail();
    }
  }

  private setupPeer(): void {
    // LAN-only: no ICE servers (host candidates + peer-reflexive).
    const pc = new RTCPeerConnection({ iceServers: [] });
    this.pc = pc;
    // react-native-webrtc exposes events via on* setters over a vendored
    // event-target-shim; the payloads are loosely typed, so read them via `any`.
    pc.ontrack = (e: any) => {
      const stream = e?.streams?.[0] as { toURL?: () => string } | undefined;
      const toURL = stream?.toURL;
      console.log('[webrtc] ontrack, hasStream=', !!toURL);
      if (toURL) this.streamCb?.(toURL.call(stream));
    };
    (pc as any).oniceconnectionstatechange = () => {
      console.log('[webrtc] iceConnectionState=', (this.pc as any)?.iceConnectionState);
    };
    (pc as any).onicegatheringstatechange = () => {
      console.log('[webrtc] iceGatheringState=', (this.pc as any)?.iceGatheringState);
    };
    pc.onicecandidate = (e: any) => {
      const c = e?.candidate as
        { candidate?: string; sdpMLineIndex?: number | null } | null | undefined;
      if (c && typeof c.candidate === 'string' && c.candidate) {
        this.send({
          t: 'ice',
          candidate: c.candidate,
          sdpMLineIndex: typeof c.sdpMLineIndex === 'number' ? c.sdpMLineIndex : 0,
        });
      }
    };
    pc.onconnectionstatechange = () => {
      const st = this.pc?.connectionState;
      console.log('[webrtc] connectionState=', st);
      if (st === 'connected') {
        this.clearTimer('negotiate');
        this.setStatus('connected');
      } else if (st === 'failed' || st === 'closed') {
        this.fail('connectionState=' + st);
      }
    };
  }

  private async onSignal(text: string): Promise<void> {
    let msg: { t?: string; sdp?: string; candidate?: string; sdpMLineIndex?: number };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    const pc = this.pc;
    if (!pc) return;
    console.log('[webrtc] <-', msg.t, msg.t === 'offer' ? '(sdp ' + (msg.sdp?.length ?? 0) + ')' : '');
    try {
      if (msg.t === 'offer' && typeof msg.sdp === 'string') {
        await pc.setRemoteDescription(
          new RTCSessionDescription({ type: 'offer', sdp: msg.sdp }));
        console.log('[webrtc] setRemote done, creating answer');
        const answer = await pc.createAnswer();
        console.log('[webrtc] answer created, setting local');
        await pc.setLocalDescription(answer);
        this.send({ t: 'answer', sdp: answer.sdp });
        console.log('[webrtc] answer sent');
        // Media should flow within seconds now; arm the fallback timeout.
        this.armNegotiateTimeout();
      } else if (msg.t === 'ice' && typeof msg.candidate === 'string') {
        await pc.addIceCandidate(new RTCIceCandidate({
          candidate: msg.candidate,
          sdpMLineIndex: typeof msg.sdpMLineIndex === 'number' ? msg.sdpMLineIndex : 0,
        }));
      } else if (msg.t === 'bye' || msg.t === 'error') {
        this.fail('box sent ' + msg.t);
      }
    } catch (e) {
      this.fail('onSignal ' + msg.t + ' threw ' + String(e));
    }
  }

  private armNegotiateTimeout(): void {
    this.clearTimer('negotiate');
    this.negotiateTimer = setTimeout(() => {
      this.negotiateTimer = null;
      if (this.status !== 'connected') this.fail('negotiate timeout (ICE never connected)');
    }, NEGOTIATE_TIMEOUT_MS);
  }

  private clearTimer(which: 'connect' | 'negotiate'): void {
    const ref = which === 'connect' ? this.connectTimer : this.negotiateTimer;
    if (ref != null) {
      clearTimeout(ref);
      if (which === 'connect') this.connectTimer = null;
      else this.negotiateTimer = null;
    }
  }

  private teardown(): void {
    this.clearTimer('connect');
    this.clearTimer('negotiate');
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try { ws.close(); } catch { /* already closed */ }
    }
    const pc = this.pc;
    this.pc = null;
    if (pc) {
      try { pc.close(); } catch { /* already closed */ }
    }
    this.streamCb?.(null);
  }
}
