/**
 * Native remote-video surface for the WebRTC H.264 screen stream (P4b P0).
 * Renders the box's sendonly track with <RTCView> — hardware decode. Metro picks
 * this on iOS/Android; the web build gets components/ScreenVideo.tsx (null), so
 * react-native-webrtc is never pulled into the web bundle.
 */
import type { StyleProp, ViewStyle } from 'react-native';
import { RTCView } from 'react-native-webrtc';

export function ScreenVideo({
  streamURL, style,
}: {
  streamURL: string;
  style?: StyleProp<ViewStyle>;
}) {
  // 16:9 source in a 16:9 stage -> 'contain' is exact (no letterbox math).
  return <RTCView streamURL={streamURL} objectFit="contain" style={style} />;
}
