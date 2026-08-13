/**
 * A small themed dialog to NAME a preset before saving it. Used by the LED cards
 * (RgbLedCard, StripLightCard). Cross-platform (a plain RN Modal + TextInput, not
 * iOS-only Alert.prompt) so it works on Android too. Pre-filled with the card's
 * auto-generated label; blank falls back to that label.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  Modal, Pressable, StyleSheet, Text, TextInput, View,
} from 'react-native';

import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

export function PresetNameModal(props: {
  visible: boolean;
  defaultName: string;
  onSubmit: (name: string) => void;
  onClose: () => void;
}) {
  const { visible, defaultName, onSubmit, onClose } = props;
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [name, setName] = useState(defaultName);
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (visible) {
      setName(defaultName);
      // let the modal mount before focusing so the keyboard opens reliably
      const id = setTimeout(() => inputRef.current?.focus(), 120);
      return () => clearTimeout(id);
    }
  }, [visible, defaultName]);

  const submit = () => onSubmit(name.trim() || defaultName);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose} accessibilityLabel="Dismiss">
        {/* Inner press swallows taps so tapping the card doesn't dismiss. */}
        <Pressable style={styles.card} onPress={() => {}}>
          <Text style={styles.title}>NAME THIS PRESET</Text>
          <TextInput
            ref={inputRef}
            value={name}
            onChangeText={setName}
            selectTextOnFocus
            maxLength={40}
            placeholder="Preset name"
            placeholderTextColor={t.textFaint}
            returnKeyType="done"
            onSubmitEditing={submit}
            accessibilityLabel="Preset name"
            style={styles.input}
          />
          <View style={styles.row}>
            <Pressable
              onPress={onClose} accessibilityRole="button" accessibilityLabel="Cancel"
              style={({ pressed }) => [styles.btn, pressed && styles.pressed]}>
              <Text style={styles.btnText}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={submit} accessibilityRole="button" accessibilityLabel="Save preset"
              style={({ pressed }) => [styles.btn, styles.btnPrimary, pressed && styles.pressed]}>
              <Text style={[styles.btnText, styles.btnTextPrimary]}>Save</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    overlay: {
      flex: 1, backgroundColor: 'rgba(0,0,0,0.6)',
      alignItems: 'center', justifyContent: 'center', padding: 28,
    },
    card: {
      width: '100%', maxWidth: 360, backgroundColor: t.card,
      borderRadius: 16, borderWidth: 1, borderColor: t.cardBorder, padding: 18,
    },
    title: {
      color: t.textDim, fontSize: 11, fontWeight: '700', letterSpacing: 1.2,
      fontFamily: mono, marginBottom: 12,
    },
    input: {
      color: t.text, fontSize: 16, fontFamily: mono,
      borderWidth: 1, borderColor: t.cardBorder, borderRadius: 10,
      paddingVertical: 10, paddingHorizontal: 12, backgroundColor: t.bg,
    },
    row: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 16 },
    btn: {
      borderRadius: 999, borderWidth: 1, borderColor: t.cardBorder,
      paddingVertical: 8, paddingHorizontal: 18,
    },
    btnPrimary: { borderColor: t.blue, backgroundColor: t.blue },
    pressed: { opacity: 0.6 },
    btnText: { color: t.textDim, fontSize: 14, fontFamily: mono, fontWeight: '700' },
    btnTextPrimary: { color: '#fff' },
  });
