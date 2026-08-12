/**
 * AUDIO OUTPUT (Console tab) — pick which device the box plays through: the TV
 * over HDMI, a Bluetooth speaker, the built-in analog out. The read-only sibling
 * DisplayAudioCard SHOWS the current default; this one CHANGES it.
 *
 * Probe-and-appear, the DisplayAudioCard shape exactly: a 404 (agent too old),
 * `available: false` (no pactl on this box), or an empty sink list renders
 * NOTHING — no placeholder, so a box that can't switch audio shows no dead card.
 *
 * Tapping a row asks the box to switch, then RE-READS /api/audio rather than
 * trusting the POST's echo (CLAUDE.md §11: observe the real state). The radio
 * that moves is the box telling us it moved, not the app assuming it did.
 *
 * The sink `name` sent back is one the box itself listed; the agent looks it up
 * in its live set and refuses anything else, so this control can only ever point
 * audio at a device the box offered.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { usePoll } from '@/hooks/usePoll';
import { api, hostKey, type AudioSink, type AudioState } from '@/lib/api';
import { hapticLight } from '@/lib/haptics';
import { useSkinKit } from '@/lib/skin';
import { useSettings } from '@/lib/SettingsContext';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

/** Audio devices come and go (a Bluetooth speaker connects) but not second by
 *  second; the switch itself refreshes immediately, so this is just a backstop. */
const POLL_MS = 15000;

/** A short, dim kind tag from what we can tell about the sink, or null. Derived
 *  from the pactl node name, which is stable ("bluez_output…", "…hdmi…"). */
function kindTag(s: AudioSink): string | null {
  if (s.hdmi) return 'HDMI';
  if (s.name.startsWith('bluez')) return 'BLUETOOTH';
  if (s.name.includes('usb')) return 'USB';
  if (s.name.includes('analog')) return 'ANALOG';
  return null;
}

export function AudioOutputCard() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { Card } = useSkinKit();
  const { settings, ready } = useSettings();
  const configured = !!settings.host && !!settings.token;

  // The sink name currently being switched to (disables the list + shows a
  // spinner on that row) so a double-tap can't fire two switches at once.
  const [busy, setBusy] = useState<string | null>(null);

  const poll = usePoll<AudioState | null>(
    () => api.audio(settings), POLL_MS, ready && configured, hostKey(settings));

  const d = poll.data;
  // Old agent, no pactl, or nothing to switch between -> render nothing at all.
  if (!d || !d.available || d.sinks.length === 0) return null;

  const onPick = async (s: AudioSink) => {
    if (busy || s.default) return; // already the default, or a switch in flight
    hapticLight();
    setBusy(s.name);
    try {
      await api.setAudioDefault(settings, s.name);
    } finally {
      // Re-read the box's real default whether or not the POST claimed success.
      await poll.refresh();
      setBusy(null);
    }
  };

  return (
    <Card index={6}>
      <View style={styles.header}>
        <Text style={styles.cardTitle}>AUDIO OUTPUT</Text>
        <Pressable
          onPress={() => {
            hapticLight();
            poll.refresh();
          }}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Refresh audio outputs"
          style={({ pressed }) => [styles.refreshBtn, pressed && styles.pressed]}>
          <Ionicons name="refresh" size={13} color={t.textDim} />
        </Pressable>
      </View>

      <View style={styles.list}>
        {d.sinks.map((s) => {
          const tag = kindTag(s);
          const switching = busy === s.name;
          return (
            <Pressable
              key={s.name}
              onPress={() => onPick(s)}
              disabled={!!busy}
              accessibilityRole="radio"
              accessibilityState={{ selected: s.default, disabled: !!busy }}
              accessibilityLabel={`${s.desc || s.name}${s.default ? ', current output' : ''}`}
              style={({ pressed }) => [styles.row, pressed && !busy && styles.rowPressed]}>
              {switching ? (
                <ActivityIndicator size="small" color={t.blue} style={styles.icon} />
              ) : (
                <Ionicons
                  name={s.default ? 'radio-button-on' : 'radio-button-off'}
                  size={18}
                  color={s.default ? t.blue : t.textFaint}
                  style={styles.icon}
                />
              )}
              <Text
                style={[styles.rowLabel, s.default && styles.rowLabelOn]}
                numberOfLines={1}>
                {s.desc || s.name}
              </Text>
              {tag ? <Text style={styles.tag}>{tag}</Text> : null}
            </Pressable>
          );
        })}
      </View>

      <Text style={styles.hint}>Tap a device to send the box’s audio there.</Text>
    </Card>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 10,
    },
    cardTitle: {
      color: t.textDim,
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 1,
      fontFamily: mono,
    },
    refreshBtn: {
      borderColor: t.cardBorder,
      borderWidth: 1,
      borderRadius: 999,
      paddingVertical: 4,
      paddingHorizontal: 9,
    },
    pressed: { opacity: 0.7 },

    list: { gap: 2 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingVertical: 9,
    },
    rowPressed: { opacity: 0.6 },
    icon: { width: 20, textAlign: 'center' },
    // flex so a long device name shrinks inside the row instead of shoving the
    // kind tag off the right edge.
    rowLabel: {
      color: t.text,
      fontSize: 14,
      fontFamily: mono,
      flex: 1,
    },
    rowLabelOn: { color: t.text, fontWeight: '700' },
    tag: {
      color: t.textFaint,
      fontSize: 10,
      fontWeight: '700',
      letterSpacing: 1,
      fontFamily: mono,
    },
    hint: {
      color: t.textFaint,
      fontSize: 11,
      fontFamily: mono,
      marginTop: 8,
    },
  });
