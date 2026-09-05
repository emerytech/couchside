/**
 * One movable Console card. Wraps a card so the tab's hold-to-edit mode can
 * reorder + hide it:
 *   - LONG-PRESS (when not editing) enters edit mode.
 *   - In edit mode a control strip (↑ ↓ hide) overlays the card — but only when
 *     the card actually RENDERED something (measured height), so a
 *     probe-and-appear card that returned null shows no orphan controls.
 *   - Hidden + not editing → renders nothing. Hidden + editing → dimmed with an
 *     eye-off, so you can un-hide it.
 * Reorder/hide are TAPS (not a drag) — no drag-responder traps, and fully
 * exercisable in the web harness.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { useTheme, useThemedStyles, type Palette } from '@/lib/theme';

export function EditableSection({
  editing, hidden, isFirst, isLast,
  onEnterEdit, onUp, onDown, onToggleHide, onPresent, inertWhileEditing, children,
}: {
  editing: boolean;
  hidden: boolean;
  isFirst: boolean;
  isLast: boolean;
  onEnterEdit: () => void;
  onUp: () => void;
  onDown: () => void;
  onToggleHide: () => void;
  /** Reports whether the card actually rendered content (measured height > 0),
   *  so the parent's arrow bounds skip probe-and-appear cards that are null. */
  onPresent?: (present: boolean) => void;
  /** Make the card's OWN controls inert while editing, so a tap lands on the
   *  reorder/hide strip and not on the card. Console leaves this off — its cards
   *  are display-only and harmless to tap. Fleet (a tap switches box + navigates)
   *  and Actions (a tap arms an action) turn it ON so editing never fires the
   *  card. Layout measurement is unaffected (pointerEvents does not change it). */
  inertWhileEditing?: boolean;
  children: React.ReactNode;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [h, setH] = useState(0);
  const present = h > 8; // a null-rendering card measures ~0
  const presentRef = useRef<boolean | null>(null);
  const measure = (height: number) => {
    setH(height);
    const p = height > 8;
    if (p !== presentRef.current) { presentRef.current = p; onPresent?.(p); }
  };

  // Hidden and not editing: gone. (In edit mode it stays, dimmed, to un-hide.)
  if (hidden && !editing) return null;

  const content = (
    <View
      onLayout={(e) => measure(e.nativeEvent.layout.height)}
      // While editing, a card whose own taps have side effects (Fleet switches
      // box, Actions arms an action) is made non-interactive so the tap belongs
      // to the reorder/hide strip, not the card.
      pointerEvents={editing && inertWhileEditing ? 'none' : 'auto'}
      style={hidden && editing ? styles.dim : undefined}>
      {children}
    </View>
  );

  if (!editing) {
    // Long-press anywhere on the card enters edit mode; child taps still work
    // (RN hands a tap to whichever child claims it, the hold to us).
    return (
      <Pressable onLongPress={onEnterEdit} delayLongPress={450}>
        {content}
      </Pressable>
    );
  }

  return (
    <View>
      {content}
      {present && (
        <View style={styles.strip} pointerEvents="box-none">
          <Ctrl t={t} styles={styles} icon="chevron-up" disabled={isFirst}
            onPress={onUp} label="Move up" />
          <Ctrl t={t} styles={styles} icon="chevron-down" disabled={isLast}
            onPress={onDown} label="Move down" />
          <Ctrl t={t} styles={styles} icon={hidden ? 'eye-off' : 'eye'}
            onPress={onToggleHide} label={hidden ? 'Show' : 'Hide'} tint={hidden ? t.amber : t.blue} />
        </View>
      )}
    </View>
  );
}

function Ctrl({
  icon, onPress, disabled, label, tint, t, styles,
}: {
  icon: keyof typeof Ionicons.glyphMap; onPress: () => void; disabled?: boolean;
  label: string; tint?: string; t: Palette; styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      style={({ pressed }) => [styles.ctrl, disabled && styles.ctrlDisabled, pressed && styles.ctrlPressed]}>
      <Ionicons name={icon} size={18} color={disabled ? t.textFaint : (tint ?? t.text)} />
    </Pressable>
  );
}

const makeStyles = (t: Palette) => StyleSheet.create({
  dim: { opacity: 0.42 },
  strip: {
    position: 'absolute', top: 6, right: 6, flexDirection: 'row', gap: 6,
    backgroundColor: t.bg, borderColor: t.cardBorder, borderWidth: 1,
    borderRadius: 999, padding: 4,
    shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  ctrl: {
    width: 34, height: 30, alignItems: 'center', justifyContent: 'center',
    borderRadius: 999, backgroundColor: t.card,
  },
  ctrlDisabled: { opacity: 0.4 },
  ctrlPressed: { opacity: 0.6 },
});
