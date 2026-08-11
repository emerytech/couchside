/**
 * WEB / no-native-module fallback for the WebRTC remote-video surface (P4b P0).
 * react-native-webrtc is native-only; the web build never reaches the WebRTC
 * tier (webrtcSupported is false there), so this renders nothing. Keeping the
 * RTCView reference out of this file is what keeps it out of the web bundle.
 */
import type { StyleProp, ViewStyle } from 'react-native';

export function ScreenVideo(_props: {
  streamURL: string;
  style?: StyleProp<ViewStyle>;
}) {
  return null;
}
