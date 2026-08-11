/**
 * Fluid screen frames from the opt-in portal module's /ws/screen stream, as a
 * drop-in for useScreenFrame: it returns the SAME { frame, failed, lastGood }
 * shape, so the desktop route swaps poll -> stream by choosing which hook feeds
 * its <Image>, changing nothing downstream.
 *
 * `failed` goes true when the socket errors/closes — for a box in Game Mode (no
 * portal desktop session) the agent degrades /ws/screen closed, so the caller
 * can fall back to the still-frame poller.
 */
import { useEffect, useRef, useState } from 'react';

import { resolveEffectiveHost, type ConnSettings } from '@/lib/api';
import { ScreenStreamClient, type StreamProfile } from '@/lib/screenstream';

export function useScreenStream(
  settings: ConnSettings,
  active: boolean,
  profile: StreamProfile = '720p20',
) {
  const [frame, setFrame] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [lastGood, setLastGood] = useState<number | null>(null);

  // Connect with the freshest settings without making them a dep: `settings` is
  // a new object on every reachability poll (lastSeen/lastIp/caps), so a
  // `[settings]` dep reconnected the stream every few seconds. Key ONLY on the
  // connection identity (effective host, port, token).
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const effHost = resolveEffectiveHost(settings);
  const { port, token } = settings;

  useEffect(() => {
    if (!active) return undefined;
    const client = new ScreenStreamClient();
    client.onFrame((uri) => {
      setFrame(uri);
      setFailed(false);
      setLastGood(Date.now());
    });
    client.onStatus((s) => {
      if (s === 'error') setFailed(true);
    });
    client.start(settingsRef.current, profile);
    return () => {
      client.onFrame(null);
      client.onStatus(null);
      client.stop();
    };
  }, [active, profile, effHost, port, token]);

  return { frame, failed, lastGood };
}
