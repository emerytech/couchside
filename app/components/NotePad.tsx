/**
 * NOTE mode's surface — a phone-side text scratchpad for jotting a clue while a
 * game runs. Renders in place of the swipe/trackpad surface when the Pad is on
 * the NOTE segment. The note itself drives NOTHING on the box: it is a local
 * TextInput bound to lib/note (autosave + persist). No responder ownership, no
 * d-pad path — so it carries none of the swipe surface's stuck-direction risk.
 *
 * ONE box read, opt-in per press: "Paste from box" pulls the box's current
 * clipboard back onto the phone (GET /api/clipboard, cap `wlclipboard`) and
 * appends it here — for a link/code/path copied on the box. It never writes the
 * box, and only appears when the box advertises the cap (desktop Wayland; hidden
 * in Game Mode where the clipboard isn't reachable).
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useCallback, useState } from 'react';
import {
  Alert, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View,
} from 'react-native';

import { api } from '@/lib/api';
import { hapticLight } from '@/lib/haptics';
import { clearNote, getNoteText, NOTE_MAX, setNoteText, useNoteText } from '@/lib/note';
import type { Settings } from '@/lib/settings';
import { useTheme, useThemedStyles, type Palette } from '@/lib/theme';

/** Web has no usable RN Alert; native uses it. A one-line notice either way. */
function notify(msg: string): void {
  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-alert
    if (typeof window !== 'undefined') window.alert(msg);
    return;
  }
  Alert.alert(msg);
}

export function NotePad({ settings }: { settings?: Settings }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const text = useNoteText();
  const [pasting, setPasting] = useState(false);

  // The box advertises it can hand its clipboard back. undefined/false (older
  // agent, Windows, Game Mode, no wl-paste) hides the control entirely.
  const canPaste = settings?.caps?.wlclipboard === true;

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

  const onPasteFromBox = useCallback(async () => {
    if (!settings || pasting) return;
    hapticLight();
    setPasting(true);
    try {
      const clip = await api.clipboard(settings);
      if (!clip || !clip.available) {
        notify("Couldn't read the box's clipboard right now.");
        return;
      }
      if (!clip.text) {
        notify('The box clipboard is empty.');
        return;
      }
      // Append, so a pull never clobbers what's already jotted. A blank line
      // between the existing note and the pulled text keeps them legible.
      const cur = getNoteText();
      const joined = cur ? `${cur}${cur.endsWith('\n') ? '' : '\n'}${clip.text}` : clip.text;
      void setNoteText(joined);
    } finally {
      setPasting(false);
    }
  }, [settings, pasting]);

  return (
    <KeyboardAvoidingView
      style={styles.wrap}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.head}>
        <Text style={styles.title}>Notes</Text>
        <Text style={styles.count}>{text.length}/{NOTE_MAX}</Text>
        {canPaste && (
          <Pressable
            onPress={onPasteFromBox}
            disabled={pasting}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Paste from box clipboard"
            style={({ pressed }) => [styles.paste, pressed && { opacity: 0.6 }]}>
            <Ionicons
              name="clipboard-outline"
              size={16}
              color={pasting ? t.textFaint : t.accent}
            />
            <Text style={[styles.pasteLabel, { color: pasting ? t.textFaint : t.accent }]}>
              Paste from box
            </Text>
          </Pressable>
        )}
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
    paste: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 6, paddingHorizontal: 4 },
    pasteLabel: { fontSize: 12, fontWeight: '700' },
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
