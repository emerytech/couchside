import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { usePoll } from '@/hooks/usePoll';
import { api, hostKey, type ControllerReceivers } from '@/lib/api';
import { useSettings } from '@/lib/SettingsContext';
import { useTheme } from '@/lib/theme';

/** Receiver presence and Steam's pairing flow, separate from firmware flashing. */
export function ControllerReceiversPanel() {
  const t = useTheme();
  const { settings, ready } = useSettings();
  const key = hostKey(settings);
  const current = useRef<string | null>(key);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const poll = usePoll<ControllerReceivers | null>(
    () => api.controllerReceivers(settings), 10000,
    ready && settings.host.trim().length > 0, key,
  );
  useEffect(() => {
    current.current = key;
    setBusy(false);
    setNotice('');
    return () => { current.current = null; };
  }, [key]);

  async function pair() {
    const target = key;
    setBusy(true);
    setNotice('');
    try {
      const result = await api.pairControllerReceiver(settings);
      if (current.current === target) setNotice(result.message);
    } catch (error) {
      if (current.current === target) setNotice(error instanceof Error ? error.message : 'Could not open Steam.');
    } finally {
      if (current.current === target) { setBusy(false); poll.refresh(); }
    }
  }

  const state = poll.dataKey === key ? poll.data : null;
  // Old agents and hosts without USB receiver support omit this section.
  if (!state?.supported) return null;
  const stale = poll.error != null;
  return (
    <View style={styles.wrap} testID="controller-receivers">
      <Text style={[styles.heading, { color: t.text }]}>CONTROLLER RECEIVERS</Text>
      {stale || state.scan_status !== 'ok' ? (
        <Text style={{ color: t.textFaint }}>Receiver status is unavailable. Refresh to try again.</Text>
      ) : state.receivers.length === 0 ? (
        <Text style={{ color: t.textFaint }}>No supported receiver detected.</Text>
      ) : state.receivers.map(receiver => (
        <View key={receiver.id} style={styles.receiver}>
          <Text style={{ color: t.text }}>{receiver.label}</Text>
          <Text style={{ color: t.green }}>Detected</Text>
        </View>
      ))}
      <Text style={{ color: t.textFaint }}>
        Receiver detection does not confirm a controller is paired. Steam manages pairing and connection status.
      </Text>
      <Pressable accessibilityRole="button" testID="controller-receivers-refresh" onPress={poll.refresh}>
        <Text style={[styles.button, { color: t.blue }]}>Refresh status</Text>
      </Pressable>
      {state.receivers.length > 0 ? (
        <>
          <Pressable accessibilityRole="button" testID="controller-receivers-pair"
            disabled={busy || stale || !state.pairing_available} onPress={pair}>
            <Text style={[styles.button, { color: t.blue, opacity: busy || stale || !state.pairing_available ? 0.5 : 1 }]}>
              {busy ? 'Opening Steam…' : 'Pair / manage in Steam'}
            </Text>
          </Pressable>
          <Text style={{ color: t.textFaint }}>
            {state.pairing_available ? 'Opens Controller settings on the TV. Choose Add Controller there.' : 'Steam must be available to pair a controller.'}
          </Text>
        </>
      ) : null}
      {notice ? <Text style={{ color: t.text }} accessibilityLiveRegion="polite">{notice}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 10, paddingVertical: 12 },
  heading: { fontSize: 13, fontWeight: '700', letterSpacing: 1 },
  receiver: { gap: 4 },
  button: { paddingVertical: 10, fontWeight: '600' },
});
