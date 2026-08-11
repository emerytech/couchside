/**
 * WEB / no-native-module fallback for the WebRTC screen stream (P4b P0).
 *
 * react-native-webrtc is native-only. Metro resolves this `.ts` on web (and any
 * build without the native module); the real client lives in
 * `webrtcstream.native.ts`, which Metro picks on iOS/Android. Because the native
 * dep is referenced ONLY from the `.native` file, it is never pulled into the web
 * bundle. `webrtcSupported` is the runtime feature flag the desktop route gates
 * on, so an unsupported build cleanly falls back to MJPEG (caps.screenstream)
 * then the still-frame poller.
 */
import type { ConnSettings } from './api';
import type {
  IWebRtcStreamClient, WebRtcProfile, WebRtcStatus,
} from './webrtcstreamTypes';

// Typed `boolean` (not the literal `false`) so consumers don't dead-code the
// WebRTC branch at compile time — the native override flips it to true.
export const webrtcSupported: boolean = false;

export class WebRtcStreamClient implements IWebRtcStreamClient {
  onStream(_cb: ((url: string | null) => void) | null): void {}
  onStatus(cb: ((s: WebRtcStatus) => void) | null): void {
    // Report closed immediately so a caller that somehow reaches here (it never
    // should — webrtcSupported is false) falls back rather than hanging.
    if (cb) cb('closed');
  }
  start(_settings: ConnSettings, _profile?: WebRtcProfile): void {}
  stop(): void {}
}
