/**
 * Fluid H.264 screen video from the opt-in portal module's /ws/webrtc stream
 * (remote-desktop P4b P0). Returns { streamURL, failed, connected }: streamURL
 * feeds <ScreenVideo> (RTCView); `failed` goes true on a hard WebRTC failure so
 * the desktop route can demote to the MJPEG stream (caps.screenstream).
 *
 * Mirror of useScreenStream, but the payload is a native RTCView stream URL
 * rather than a base64 <Image> data URI. On web / a build without
 * react-native-webrtc, the underlying client is the no-op stub and this never
 * activates (the desktop route gates it on webrtcSupported).
 */
import { useEffect, useState } from 'react';

import type { ConnSettings } from '@/lib/api';
import { WebRtcStreamClient } from '@/lib/webrtcstream';
import type { WebRtcProfile } from '@/lib/webrtcstreamTypes';

export function useWebRtcStream(
  settings: ConnSettings,
  active: boolean,
  profile: WebRtcProfile = '720p60',
) {
  const [streamURL, setStreamURL] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!active) return undefined;
    setStreamURL(null);
    setFailed(false);
    setConnected(false);
    const client = new WebRtcStreamClient();
    client.onStream((url) => setStreamURL(url));
    client.onStatus((s) => {
      if (s === 'error') setFailed(true);
      if (s === 'connected') setConnected(true);
    });
    client.start(settings, profile);
    return () => {
      client.onStream(null);
      client.onStatus(null);
      client.stop();
    };
  }, [active, profile, settings]);

  return { streamURL, failed, connected };
}
