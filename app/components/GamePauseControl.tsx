/** Experimental process suspension, deliberately separate from Close Game. */
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { api, GamePauseStatus, hostKey } from '@/lib/api';
import { useSettings } from '@/lib/SettingsContext';
import { mono, useTheme } from '@/lib/theme';
import { useConfirm } from './ConfirmDialog';

export function GamePauseControl({ state, refresh, demo = false }: {
  state?: GamePauseStatus; refresh: () => void; demo?: boolean;
}) {
  const { settings } = useSettings();
  const confirm = useConfirm();
  const t = useTheme();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const key = hostKey(settings);
  const current = useRef(key); current.current = key;
  useEffect(() => { setBusy(false); setMessage(''); }, [key]);
  if (!state || (!state.available && !state.has_record)) return null;
  const resume = state.has_record;
  return <View style={styles.wrap}>
    <Pressable testID="game-pause-control" accessibilityRole="button"
      accessibilityLabel={resume ? 'Resume recorded game' : 'Pause running game, experimental'}
      disabled={busy || demo || !state.available}
      style={({ pressed }) => [styles.button, { borderColor: t.amber, opacity: pressed || busy ? 0.65 : 1 }]}
      onPress={async () => {
        if (busy || demo || current.current !== key) return;
        setBusy(true); setMessage('');
        try {
          if (!resume && !await confirm({ title: 'Pause game · experimental',
            message: 'For offline single-player games only. This freezes the game in memory; online sessions continue and some games may disconnect or fail to resume. It does not save progress or survive a reboot.',
            confirmText: 'Pause game' })) return;
          if (current.current !== key) return;
          const result = await api.gamePause(settings, resume ? 'resume' : 'pause');
          if (current.current !== key) return;
          setMessage(result.ok ? (result.paused ? 'Game paused in memory. Resume here when ready.' : 'Resume requested; check the game on screen.')
            : result.reason || 'Game could not change pause state. Refresh and retry.');
          refresh();
        } catch {
          if (current.current === key) { setMessage('Could not reach the box. Reconnect and check its pause state.'); refresh(); }
        } finally { if (current.current === key) setBusy(false); }
      }}>
      <Ionicons name={resume ? 'play-circle-outline' : 'pause-circle-outline'} size={18} color={t.amber} />
      <Text style={[styles.label, { color: t.amber }]}>{busy ? 'PLEASE WAIT…' : resume ? 'RESUME GAME' : 'PAUSE GAME · EXPERIMENTAL'}</Text>
    </Pressable>
    {(message || resume) && <Text accessibilityLiveRegion="polite" style={[styles.note, { color: t.textDim }]}>{message || state.reason || 'Recorded pause session · resume before closing the game.'}</Text>}
  </View>;
}
const styles = StyleSheet.create({ wrap: { marginTop: 10, gap: 6 }, button: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 8 }, label: { fontFamily: mono, fontSize: 12, flexShrink: 1 }, note: { fontSize: 12, flexShrink: 1 } });
