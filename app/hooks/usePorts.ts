/** Shared Ports screen/card lifecycle. Each focused surface owns one polling
 * chain; backgrounding stops it and return immediately reconciles with the box. */
import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { api, hostKey, type ConnSettings } from '@/lib/api';
import { PortsPoller, type PortsPollState } from '@/lib/portsPoller';

export function usePorts(settings: ConnSettings) {
  const key = hostKey(settings);
  const configured = settings.host.trim().length > 0;
  const current = useRef(settings);
  current.current = settings;
  const [poller] = useState(() => new PortsPoller());
  const [snapshot, setSnapshot] = useState<PortsPollState & { key: string }>({
    key, data: null, error: null, loading: true,
  });
  useFocusEffect(useCallback(() => {
    if (!configured) return;
    const start = () => poller.start(key, () => api.ports(current.current),
      (state) => setSnapshot({ ...state, key }));
    if (AppState.currentState === 'active' || AppState.currentState == null) start();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') start();
      else poller.stop();
    });
    return () => { sub.remove(); poller.stop(); };
  }, [configured, key, poller]));
  const refresh = useCallback(() => poller.refresh(), [poller]);
  // A host switch must not paint the prior box even once, before focus cleanup.
  const state = configured && snapshot.key === key
    ? snapshot : { data: null, error: null, loading: configured };
  return { ...state, refresh };
}
