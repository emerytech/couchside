/**
 * A custom, VERY TRANSLUCENT on-screen keyboard for the landscape desktop
 * Control. The iOS/Android system keyboard is opaque and un-restylable and it
 * walls off the remote screen — so in landscape we draw our own floating keys
 * instead: barely-there key chips over the live desktop, so you can see what
 * you are typing into. Each key rides the SAME uinput path everything else uses
 * (client.sendText for printable chars, client.sendKey for specials).
 *
 * Portrait keeps the real system keyboard (autocorrect, paste, dictation) — it
 * has the room. This is landscape-only.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { hapticLight } from '@/lib/haptics';
import type { SpecialKey } from '@/lib/gamepad';
import { mono, useTheme, type Palette } from '@/lib/theme';

const ROWS_ABC = [
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm'],
];
const ROWS_SYM = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['@', '#', '$', '_', '&', '-', '+', '(', ')', '/'],
  ['*', '"', "'", ':', ';', '!', '?'],
];

export function DesktopKeys({
  visible, onChar, onSpecial, onHide,
}: {
  visible: boolean;
  onChar: (ch: string) => void;
  onSpecial: (k: SpecialKey) => void;
  onHide: () => void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [shift, setShift] = useState(false);
  const [sym, setSym] = useState(false);
  if (!visible) return null;

  const rows = sym ? ROWS_SYM : ROWS_ABC;
  const styles = makeStyles(t);

  const tapChar = (ch: string) => onChar(shift && !sym ? ch.toUpperCase() : ch);
  const tapSpecial = (k: SpecialKey) => onSpecial(k);

  const Key = ({ label, onPress, flex = 1, active, wide }: {
    label: React.ReactNode; onPress: () => void; flex?: number;
    active?: boolean; wide?: boolean;
  }) => (
    <Pressable
      // Haptic on key-DOWN, not release — a real key ticks the instant you touch
      // it. Firing on onPress (release) felt laggy/absent while typing fast.
      onPressIn={hapticLight}
      onPress={onPress}
      style={({ pressed }) => [
        styles.key, { flexGrow: flex, flexBasis: 0 },
        wide && styles.keyWide, active && styles.keyActive,
        pressed && styles.keyPressed,
      ]}>
      {typeof label === 'string'
        ? <Text style={styles.keyLabel}>{label}</Text>
        : label}
    </Pressable>
  );

  return (
    <View
      style={[styles.wrap, { paddingBottom: insets.bottom + 6, right: insets.right + 6, left: insets.left + 6 }]}
      pointerEvents="box-none">
      {/* Row 1 */}
      <View style={styles.row}>
        {rows[0].map((c) => (
          <Key key={c} label={shift && !sym ? c.toUpperCase() : c} onPress={() => tapChar(c)} />
        ))}
      </View>
      {/* Row 2 (indented) */}
      <View style={[styles.row, styles.rowIndent]}>
        {rows[1].map((c) => (
          <Key key={c} label={shift && !sym ? c.toUpperCase() : c} onPress={() => tapChar(c)} />
        ))}
      </View>
      {/* Row 3: shift/layer + chars + backspace */}
      <View style={styles.row}>
        <Key flex={1.5}
          label={<Ionicons name={sym ? 'text' : 'arrow-up'} size={17}
            color={shift ? t.bg : 'rgba(255,255,255,0.9)'} />}
          active={shift && !sym}
          onPress={() => { sym ? setSym(false) : setShift((s) => !s); }} />
        {rows[2].map((c) => (
          <Key key={c} label={shift && !sym ? c.toUpperCase() : c} onPress={() => tapChar(c)} />
        ))}
        <Key flex={1.5}
          label={<Ionicons name="backspace-outline" size={18} color="rgba(255,255,255,0.9)" />}
          onPress={() => tapSpecial('backspace')} />
      </View>
      {/* Row 4: layer toggle · space · enter · hide */}
      <View style={styles.row}>
        <Key flex={1.4} label={sym ? 'ABC' : '?123'}
          onPress={() => { setSym((v) => !v); setShift(false); }} />
        <Key flex={4} wide label="space" onPress={() => tapSpecial('space')} />
        <Key flex={1.4}
          label={<Ionicons name="return-down-back-outline" size={18} color="rgba(255,255,255,0.9)" />}
          onPress={() => tapSpecial('enter')} />
        <Key flex={1.2}
          label={<Ionicons name="chevron-down" size={18} color="rgba(255,255,255,0.9)" />}
          onPress={onHide} />
      </View>
    </View>
  );
}

const makeStyles = (_t: Palette) => StyleSheet.create({
  wrap: {
    position: 'absolute', bottom: 0, zIndex: 70, gap: 5,
  },
  row: { flexDirection: 'row', gap: 5, justifyContent: 'center' },
  rowIndent: { paddingHorizontal: '3%' },
  key: {
    height: 40, borderRadius: 7,
    alignItems: 'center', justifyContent: 'center',
    // VERY translucent — the desktop reads through; a hairline + shadow keep the
    // chip and its glyph legible over any content behind it.
    backgroundColor: 'rgba(255,255,255,0.10)',
    borderColor: 'rgba(255,255,255,0.16)', borderWidth: 1,
  },
  keyWide: { backgroundColor: 'rgba(255,255,255,0.07)' },
  keyActive: { backgroundColor: 'rgba(120,180,255,0.85)', borderColor: 'rgba(120,180,255,0.9)' },
  keyPressed: { backgroundColor: 'rgba(255,255,255,0.28)' },
  keyLabel: {
    color: 'rgba(255,255,255,0.95)', fontSize: 15, fontFamily: mono,
    textShadowColor: 'rgba(0,0,0,0.85)', textShadowRadius: 3,
  },
});
