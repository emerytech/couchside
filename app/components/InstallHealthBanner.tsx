/**
 * "Box installation is damaged" — shown on the Console when the agent reports
 * root-owned install pieces missing (install_health, agent >= 2.9.115).
 *
 * Renders NOTHING unless the box positively said pieces are missing: older
 * agents omit the field, and a piece the agent merely could not check is not
 * damage (the decision lives in lib/installHealth.ts, where it is tested). The
 * remedy is always the same one-liner, run in a terminal ON THE BOX — the
 * phone's own update path has no password and cannot write /etc — so the
 * banner shows the command and a Copy button, and no action that would pretend
 * the phone can fix it. Not dismissable: it clears itself once the installer
 * has put the pieces back (the agent restarts and reports ok).
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { hapticLight } from '@/lib/haptics';
import {
  damagedHeadline,
  damagedPieces,
  pieceLabel,
  REPAIR_COMMAND,
  REPAIR_HINT,
  uncheckedPieces,
} from '@/lib/installHealth';
import { mono, useTheme, useThemedStyles } from '@/lib/theme';
import type { Palette } from '@/lib/theme';

export function InstallHealthBanner({ health }: { health: unknown }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const missing = damagedPieces(health);
  if (!missing) return null;
  const unchecked = uncheckedPieces(health);

  const copy = async () => {
    hapticLight();
    try {
      await Clipboard.setStringAsync(REPAIR_COMMAND);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable: the command is on screen and selectable anyway.
    }
  };

  return (
    <View style={styles.card} accessibilityRole="alert">
      <View style={styles.header}>
        <Ionicons name="warning-outline" size={18} color={t.amber} />
        <Text style={styles.title}>{damagedHeadline(missing)}</Text>
      </View>
      <Text style={styles.hint}>{REPAIR_HINT}</Text>
      <View style={styles.cmdRow}>
        <Text style={styles.cmd} selectable>
          {REPAIR_COMMAND}
        </Text>
      </View>
      <Pressable
        onPress={() => void copy()}
        accessibilityRole="button"
        accessibilityLabel="Copy the installer command"
        hitSlop={8}
        style={({ pressed }) => [styles.copyBtn, pressed && styles.pressed]}>
        <Ionicons name={copied ? 'checkmark' : 'copy-outline'} size={14} color={t.blue} />
        <Text style={styles.copyText}>{copied ? 'Copied' : 'Copy command'}</Text>
      </Pressable>
      {unchecked.length > 0 && (
        <Text style={styles.unchecked}>
          Could not check: {unchecked.map(pieceLabel).join(', ')}
        </Text>
      )}
    </View>
  );
}

const makeStyles = (t: Palette) => StyleSheet.create({
  card: {
    backgroundColor: t.card,
    borderColor: t.amber,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    gap: 8,
  },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  // flex:1 so a long list of pieces WRAPS on native instead of shoving the icon
  // off the row (web flex-shrinks for free; native does not).
  title: { color: t.text, fontSize: 14, fontWeight: '700', lineHeight: 20, flex: 1 },
  hint: { color: t.textDim, fontSize: 12, lineHeight: 18 },
  cmdRow: {
    backgroundColor: t.inset,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  cmd: { color: t.text, fontSize: 12, fontFamily: mono },
  copyBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start' },
  copyText: { color: t.blue, fontSize: 13, fontWeight: '700' },
  pressed: { opacity: 0.7 },
  unchecked: { color: t.textFaint, fontSize: 11, lineHeight: 16 },
});
