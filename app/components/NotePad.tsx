/**
 * NOTE mode's surface — a phone-side text scratchpad for jotting a clue while a
 * game runs. Renders in place of the swipe/trackpad surface when the Pad is on
 * the NOTE segment. It drives NOTHING on the box: it is a local TextInput bound
 * to lib/note (autosave + persist). No responder ownership, no d-pad path — so
 * it carries none of the swipe surface's stuck-direction risk.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useCallback } from 'react';
import {
  Alert, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View,
} from 'react-native';

import { hapticLight } from '@/lib/haptics';
import { clearNote, NOTE_MAX, setNoteText, useNoteText } from '@/lib/note';
import { useTheme, useThemedStyles, type Palette } from '@/lib/theme';

export function NotePad() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const text = useNoteText();

  const onClear = useCallback(() => {
    const go = () => { hapticLight(); void clearNote(); };
    if (Platform.OS === 'web') {
      // eslint-disable-next-line no-alert
      if (typeof window !== 'undefined' && window.confirm('Clear this note?')) go();
      return;
    }
    Alert.alert('Clear note', 'Erase everything in this note?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: go },
    ]);
  }, []);

  return (
    <KeyboardAvoidingView
      style={styles.wrap}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.head}>
        <Text style={styles.title}>Notes</Text>
        <Text style={styles.count}>{text.length}/{NOTE_MAX}</Text>
        <Pressable
          onPress={onClear}
          disabled={text.length === 0}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Clear note"
          style={({ pressed }) => [styles.clear, pressed && { opacity: 0.6 }]}>
          <Ionicons name="trash-outline" size={18} color={text.length ? t.red : t.textFaint} />
        </Pressable>
      </View>
      <TextInput
        style={styles.input}
        value={text}
        onChangeText={(v) => { void setNoteText(v); }}
        multiline
        maxLength={NOTE_MAX}
        placeholder="Jot a clue, a code, where you left off… saved automatically."
        placeholderTextColor={t.textFaint}
        textAlignVertical="top"
        keyboardAppearance="dark"
        accessibilityLabel="Note text"
      />
    </KeyboardAvoidingView>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    wrap: { flex: 1, padding: 12, gap: 8 },
    head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    title: { color: t.text, fontSize: 16, fontWeight: '800', flex: 1 },
    count: { color: t.textFaint, fontSize: 12, fontVariant: ['tabular-nums'] },
    clear: { padding: 6, alignItems: 'center', justifyContent: 'center' },
    input: {
      flex: 1,
      backgroundColor: t.card,
      borderColor: t.cardBorder,
      borderWidth: 1,
      borderRadius: 12,
      padding: 14,
      color: t.text,
      fontSize: 16,
      lineHeight: 22,
    },
  });
