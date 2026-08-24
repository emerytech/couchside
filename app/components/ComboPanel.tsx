/**
 * A panel of one-tap key COMBINATIONS + media shortcuts — the reviewer ask:
 * "a way to send button/key combinations would be fire."
 *
 * Two groups:
 *   - DESKTOP: true chords (Ctrl+C, Alt+F4, …) sent via client.sendCombo(), which
 *     is GATED on the agent advertising the name (an unknown key closes the
 *     session, so a combo an old agent doesn't know is simply hidden).
 *   - KODI / MEDIA: single keys Kodi already understands (Space=play/pause,
 *     c=context, i=info, x=stop, ,/.=prev/next, m=OSD, \=fullscreen, Esc=back),
 *     sent via the long-standing sendKey()/sendText() path — no agent gating
 *     needed, they are the original protocol keys.
 *
 * Everything rides the SAME uinput path the pad already uses; nothing here can
 * become a command (§3): a chord is a NAME the agent looks up, a media key is a
 * fixed literal.
 */
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { hapticLight } from '@/lib/haptics';
import type { GamepadClient, KeyCombo } from '@/lib/gamepad';
import { mono, useThemedStyles, type Palette } from '@/lib/theme';

type ComboItem = { label: string; combo: KeyCombo };
type MediaItem = { label: string; run: (c: GamepadClient) => void };

const DESKTOP: ComboItem[] = [
  { label: 'COPY', combo: 'copy' },
  { label: 'PASTE', combo: 'paste' },
  { label: 'CUT', combo: 'cut' },
  { label: 'UNDO', combo: 'undo' },
  { label: 'SELECT ALL', combo: 'selectall' },
  { label: 'FIND', combo: 'find' },
  { label: 'CLOSE TAB', combo: 'closetab' },
  { label: 'CLOSE WIN', combo: 'closewin' },
];

// Kodi keyboard shortcuts (single keys) — universal to a Kodi/Big-Picture rig.
const MEDIA: MediaItem[] = [
  { label: '⏯  PLAY/PAUSE', run: (c) => c.sendKey('space') },
  { label: '⏹  STOP', run: (c) => c.sendText('x') },
  { label: '⏮  PREV', run: (c) => c.sendText(',') },
  { label: '⏭  NEXT', run: (c) => c.sendText('.') },
  { label: '☰  CONTEXT', run: (c) => c.sendText('c') },
  { label: 'ℹ  INFO', run: (c) => c.sendText('i') },
  { label: 'OSD', run: (c) => c.sendText('m') },
  { label: '⛶  FULLSCREEN', run: (c) => c.sendText('\\') },
  { label: '⎋  BACK', run: (c) => c.sendKey('esc') },
];

function Chip({
  label,
  disabled,
  onPress,
  styles,
}: {
  label: string;
  disabled?: boolean;
  onPress: () => void;
  styles: ReturnType<typeof useThemedStyles<ReturnType<typeof makeStyles>>>;
}) {
  return (
    <Pressable
      disabled={disabled}
      onPress={() => {
        hapticLight();
        onPress();
      }}
      style={({ pressed }) => [
        styles.chip,
        disabled && styles.chipDisabled,
        pressed && !disabled && styles.chipPressed,
      ]}>
      <Text style={[styles.chipText, disabled && styles.chipTextDisabled]}>{label}</Text>
    </Pressable>
  );
}

export function ComboPanel({ client }: { client: GamepadClient }) {
  const styles = useThemedStyles(makeStyles);
  const [open, setOpen] = React.useState(false);

  // Collapsed by default: it is an occasional tool, not the primary pad surface.
  // The header toggles it, so the panel owns its own show/hide (no pad state).
  return (
    <View style={styles.outer}>
      <Pressable
        onPress={() => {
          hapticLight();
          setOpen((v) => !v);
        }}
        style={({ pressed }) => [styles.toggle, (pressed || open) && styles.toggleOn]}>
        <Text style={styles.toggleText}>{open ? '⌘  COMBOS  ▾' : '⌘  COMBOS  ▸'}</Text>
      </Pressable>
      {!open ? null : (
    <ScrollView
      style={styles.wrap}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled">
      <Text style={styles.group}>KODI / MEDIA</Text>
      <View style={styles.row}>
        {MEDIA.map((m) => (
          <Chip key={m.label} label={m.label} styles={styles} onPress={() => m.run(client)} />
        ))}
      </View>

      <Text style={styles.group}>DESKTOP</Text>
      <View style={styles.row}>
        {DESKTOP.map((d) => {
          // Hide on an agent too old to accept the chord (it would close the
          // session). supportsCombo answers false until hello.keys arrives.
          const ok = client.supportsCombo(d.combo);
          return (
            <Chip
              key={d.combo}
              label={d.label}
              disabled={!ok}
              styles={styles}
              onPress={() => client.sendCombo(d.combo)}
            />
          );
        })}
      </View>
      <Text style={styles.note}>
        Media keys are Kodi shortcuts; combos need a box on agent 2.9.100+.
      </Text>
    </ScrollView>
      )}
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    outer: { alignSelf: 'stretch' },
    toggle: {
      alignSelf: 'flex-start',
      backgroundColor: t.inset,
      borderColor: t.cardBorder,
      borderWidth: 1,
      borderRadius: 9,
      paddingVertical: 8,
      paddingHorizontal: 14,
      marginTop: 4,
    },
    toggleOn: { borderColor: t.blue },
    toggleText: { color: t.textDim, fontSize: 12, fontWeight: '800', fontFamily: mono, letterSpacing: 1 },
    wrap: { alignSelf: 'stretch', maxHeight: 260 },
    content: { paddingVertical: 6, paddingHorizontal: 4, gap: 6 },
    group: {
      color: t.textFaint,
      fontSize: 11,
      fontWeight: '800',
      fontFamily: mono,
      letterSpacing: 2,
      marginTop: 6,
      marginBottom: 2,
    },
    row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    chip: {
      backgroundColor: t.inset,
      borderColor: t.cardBorder,
      borderWidth: 1,
      borderRadius: 9,
      paddingVertical: 11,
      paddingHorizontal: 14,
      minWidth: 92,
      alignItems: 'center',
    },
    chipPressed: { opacity: 0.6, borderColor: t.blue },
    chipDisabled: { opacity: 0.3 },
    chipText: { color: t.text, fontSize: 12, fontWeight: '700', fontFamily: mono, letterSpacing: 1 },
    chipTextDisabled: { color: t.textFaint },
    note: { color: t.textFaint, fontSize: 10, marginTop: 8, fontStyle: 'italic' },
  });
