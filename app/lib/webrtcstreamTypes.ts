/**
 * Shared, PLATFORM-AGNOSTIC types for the WebRTC H.264 screen stream (P4b P0).
 * Kept in their own file (no react-native-webrtc import) so both the native
 * client (lib/webrtcstream.native.ts) and the web stub (lib/webrtcstream.ts)
 * implement the same interface, and consumers type against one source.
 */
import type { ConnSettings } from './api';

export type WebRtcStatus = 'connecting' | 'connected' | 'error' | 'closed';

// Must mirror the agent's _WEBRTC_PROFILES / helper _H264_PROFILES.
export type WebRtcProfile = '720p30' | '720p60' | '1080p30' | '1080p60';

export interface IWebRtcStreamClient {
  /** The RTCView streamURL for the remote video, or null when there is none. */
  onStream(cb: ((url: string | null) => void) | null): void;
  onStatus(cb: ((s: WebRtcStatus) => void) | null): void;
  start(settings: ConnSettings, profile?: WebRtcProfile): void;
  stop(): void;
}
