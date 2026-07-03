/**
 * Apple-TV-remote-style device picker, rendered as a persistent header pill on
 * every tab. Shows the active box (name + a live reachability dot) and, on tap,
 * drops a card listing the whole fleet with per-box online dots — tap one to
 * switch, or "+ Add a box" to jump to Setup.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import React, { useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { hapticSelection } from '@/lib/haptics';
import {
  BoxReachability,
  useBoxes,
  useBoxOnlineStatus,
} from '@/lib/SettingsContext';
import { mono, theme } from '@/lib/theme';

/** Reachability -> dot color. Unknown (not yet probed) is amber. */
function dotColor(status: BoxReachability | undefined): string {
  if (status === 'reachable') return theme.green;
  if (status === 'offline') return theme.slate;
  return theme.amber; // 'unknown' / not yet probed
}

function Dot({ status }: { status: BoxReachability | undefined }) {
  return <View style={[styles.dot, { backgroundColor: dotColor(status) }]} />;
}

export function BoxSwitcher() {
  const insets = useSafeAreaInsets();
  const { boxes, activeBox, activeBoxId, switchBox } = useBoxes();
  const [open, setOpen] = useState(false);

  // Poll each box while the sheet is open (fast feedback), plus a shared slow
  // baseline poll so the header dot is warm the moment you open the sheet.
  const status = useBoxOnlineStatus(boxes, {
    active: true,
    intervalMs: open ? 5000 : 10000,
  });

  const activeStatus = activeBoxId ? status[activeBoxId] : undefined;

  const pillLabel = activeBox?.name ?? 'No box — tap to add';

  const goToSetup = () => {
    hapticSelection();
    setOpen(false);
    router.navigate('/(tabs)/setup');
  };

  const onPickBox = (id: string) => {
    hapticSelection();
    switchBox(id);
    setOpen(false);
  };

  const sortedBoxes = useMemo(() => boxes, [boxes]);

  return (
    <View style={[styles.headerWrap, { paddingTop: insets.top + 8 }]}>
      <Pressable
        onPress={() =>
          boxes.length === 0 ? goToSetup() : (hapticSelection(), setOpen(true))
        }
        style={({ pressed }) => [styles.pill, pressed && styles.pressed]}
        hitSlop={6}>
        {boxes.length > 0 && <Dot status={activeStatus} />}
        <Text style={styles.pillLabel} numberOfLines={1}>
          {pillLabel}
        </Text>
        {boxes.length > 0 && (
          <Ionicons
            name={open ? 'chevron-up' : 'chevron-down'}
            size={16}
            color={theme.textDim}
          />
        )}
      </Pressable>

      {/* Dropdown sheet: a Modal so it floats above tab content without any
          position:fixed / z-index fights with the navigator. */}
      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          {/* Drop the card just under where the pill sits. */}
          <View style={[styles.dropWrap, { paddingTop: insets.top + 8 }]}>
            {/* Stop propagation: taps inside the card shouldn't dismiss it. */}
            <Pressable style={styles.card} onPress={() => {}}>
              {sortedBoxes.map((box) => {
                const isActive = box.id === activeBoxId;
                return (
                  <Pressable
                    key={box.id}
                    onPress={() => onPickBox(box.id)}
                    style={({ pressed }) => [
                      styles.row,
                      pressed && styles.rowPressed,
                    ]}>
                    <Dot status={status[box.id]} />
                    <View style={styles.rowBody}>
                      <Text style={styles.rowName} numberOfLines={1}>
                        {box.name}
                      </Text>
                      <Text style={styles.rowHost} numberOfLines={1}>
                        {box.host}:{box.port}
                      </Text>
                    </View>
                    {isActive && (
                      <Ionicons name="checkmark" size={18} color={theme.blue} />
                    )}
                  </Pressable>
                );
              })}

              <Pressable
                onPress={goToSetup}
                style={({ pressed }) => [
                  styles.addRow,
                  pressed && styles.rowPressed,
                ]}>
                <Ionicons name="add" size={18} color={theme.blue} />
                <Text style={styles.addText}>Add a box</Text>
              </Pressable>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  headerWrap: {
    paddingHorizontal: 14,
    paddingBottom: 8,
    backgroundColor: theme.bg,
    borderBottomWidth: 1,
    borderBottomColor: theme.cardBorder,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 8,
    maxWidth: '100%',
    backgroundColor: theme.card,
    borderColor: theme.cardBorder,
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  pressed: { opacity: 0.7 },
  pillLabel: {
    color: theme.text,
    fontFamily: mono,
    fontSize: 14,
    fontWeight: '700',
    flexShrink: 1,
  },
  dot: { width: 9, height: 9, borderRadius: 5 },

  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  dropWrap: {
    paddingHorizontal: 14,
  },
  card: {
    backgroundColor: theme.card,
    borderColor: theme.cardBorder,
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 6,
    // Subtle lift so it reads as a floating dropdown.
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  rowPressed: { backgroundColor: theme.inset },
  rowBody: { flex: 1, minWidth: 0 },
  rowName: { color: theme.text, fontSize: 15, fontWeight: '700', fontFamily: mono },
  rowHost: { color: theme.textFaint, fontSize: 12, fontFamily: mono, marginTop: 2 },
  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderTopWidth: 1,
    borderTopColor: theme.cardBorder,
    marginTop: 4,
  },
  addText: { color: theme.blue, fontSize: 14, fontWeight: '700', fontFamily: mono },
});
