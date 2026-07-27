/**
 * "Boots into" — which session the box comes up in (Actions tab).
 *
 * WHY IT LIVES HERE, above the action list: the two actions directly below it
 * ("Switch to Desktop", "Return to Game Mode") are ONE-SHOT — they move you now
 * and leave the boot default alone. The agent's own source calls that out as a
 * trap. Putting the persistent counterpart next to them is what makes the
 * distinction legible; on Console it would be a setting on a monitoring
 * surface, and in Setup it would be a box setting among phone ones.
 *
 * Probe-and-appear: a 404 (agent too old) or available:false (no usable
 * backend — no SteamOS D-Bus interface AND no sudoers grant) renders nothing,
 * so the control never appears on a box that cannot honour it.
 */
import React, { useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { usePoll } from '@/hooks/usePoll';
import { api, hostKey, type SessionDefault, type SessionDefaultMode } from '@/lib/api';
import { hapticSelection, hapticError } from '@/lib/haptics';
import { useSettings } from '@/lib/SettingsContext';
import { mono, useThemedStyles, type Palette } from '@/lib/theme';

const OPTIONS: { key: SessionDefaultMode; label: string; sub: string }[] = [
  { key: 'game', label: 'Game Mode', sub: 'Always start in Steam' },
  { key: 'desktop', label: 'Desktop', sub: 'Always start on the desktop' },
  { key: 'last', label: 'Last used', sub: 'Whichever you were in last' },
];

export function BootSessionCard() {
  const styles = useThemedStyles(makeStyles);
  const { settings, ready } = useSettings();
  const configured = !!settings.host && !!settings.token;

  const poll = usePoll<SessionDefault | null>(
    () => api.sessionDefault(settings), 15000, ready && configured, hostKey(settings));

  const set = useCallback(
    async (mode: SessionDefaultMode) => {
      hapticSelection();
      try {
        await api.setSessionDefault(settings, mode);
      } catch {
        hapticError();
      }
      poll.refresh();
    },
    [settings, poll],
  );

  const d = poll.data;
  // Absent capability or old agent -> render nothing at all.
  if (!d || !d.available) return null;

  return (
    <View style={styles.card}>
      <Text style={styles.title}>BOOTS INTO</Text>
      <Text style={styles.sub}>
        Which mode this box starts in. The switches below only change it right now.
      </Text>
      <View style={styles.row}>
        {OPTIONS.map((o) => {
          // "last" is our own mode and the agent reports only the concrete
          // session it resolved to, so it can never read back as selected.
          // Highlighting by the reported mode alone would show the wrong chip;
          // this shows what the box will DO, which is the honest answer.
          const on = d.mode === o.key;
          return (
            <Pressable
              key={o.key}
              onPress={() => set(o.key)}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`${o.label}. ${o.sub}`}
              style={({ pressed }) => [
                styles.seg,
                on && styles.segOn,
                pressed && styles.pressed,
              ]}>
              <Text style={[styles.segText, on && styles.segTextOn]}>{o.label}</Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={styles.hint}>
        {d.mode === 'unknown'
          ? 'Current setting unknown — pick one to set it.'
          : OPTIONS.find((o) => o.key === d.mode)?.sub ?? ''}
      </Text>
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    card: {
      backgroundColor: t.card,
      borderColor: t.cardBorder,
      borderWidth: 1,
      borderRadius: 12,
      padding: 14,
      marginBottom: 12,
    },
    title: {
      color: t.textFaint,
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 1,
      fontFamily: mono,
    },
    sub: { color: t.textDim, fontSize: 12, lineHeight: 17, marginTop: 4 },
    row: { flexDirection: 'row', gap: 6, marginTop: 10 },
    seg: {
      flex: 1,
      paddingVertical: 9,
      alignItems: 'center',
      backgroundColor: t.inset,
      borderColor: t.cardBorder,
      borderWidth: 1,
      borderRadius: 9,
    },
    segOn: { borderColor: t.blue, backgroundColor: t.inset },
    pressed: { opacity: 0.7 },
    segText: { color: t.textDim, fontSize: 12, fontWeight: '700' },
    segTextOn: { color: t.blue },
    hint: { color: t.textFaint, fontSize: 11, marginTop: 8 },
  });
