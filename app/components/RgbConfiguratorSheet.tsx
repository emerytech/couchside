/**
 * RGB CONFIGURATOR (bottom sheet) — the full lighting controls, one tap from the
 * Console's compact RgbConsoleCard.
 *
 * Console used to stack the three lighting cards inline, which "took over" the
 * tab (owner, 2026-09-27). The fix RELOCATES those cards here without changing
 * any of them: this sheet just renders the EXISTING StripLightCard,
 * RgbLedCard and OpenRgbCard inside a scrolling Modal. Everything they carry —
 * effects, brightness, reactive meters (meter_cpu/meter_battery), the playtime
 * countdown, box themes, Game Aura, per-LED paint, sequence frames — is reached
 * here, unchanged.
 *
 * Ergonomics match the app's other bottom sheets (LibraryFilterSheet): a
 * slide-up Modal, tap the dimmed area or the ✕ to close, and a ScrollView body
 * because StripLightCard is TALL. Each card self-gates (probe-and-appear), so an
 * absent surface simply renders nothing inside the scroll.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { OpenRgbCard } from '@/components/OpenRgbCard';
import { RgbLedCard } from '@/components/RgbLedCard';
import { StripLightCard } from '@/components/StripLightCard';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

export function RgbConfiguratorSheet({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        {/* Tap the dimmed area above the sheet to dismiss (the sheet itself does
            not, so a control tap never closes it). */}
        <Pressable
          style={styles.backdropTap}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close RGB configurator"
        />
        <View style={styles.sheet}>
          <View style={styles.head}>
            <Pressable
              onPress={onClose}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Close"
              style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}>
              <Ionicons name="close" size={18} color={t.textDim} />
            </Pressable>
            <Text style={styles.headTitle}>RGB &amp; LIGHTING</Text>
            {/* Spacer to keep the title centred against the ✕. */}
            <View style={styles.iconBtn} />
          </View>

          <ScrollView
            contentContainerStyle={styles.body}
            showsVerticalScrollIndicator
            keyboardShouldPersistTaps="handled">
            {/* The existing cards, RELOCATED verbatim — do not reimplement. Each
                renders null on a box that lacks that surface, so the sheet only
                ever shows what the box actually has. */}
            <StripLightCard />
            <RgbLedCard />
            <OpenRgbCard />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: '#000a', justifyContent: 'flex-end' },
    backdropTap: { flex: 1 },
    sheet: {
      backgroundColor: t.bg,
      borderTopLeftRadius: 18,
      borderTopRightRadius: 18,
      borderTopWidth: 1,
      borderColor: t.cardBorder,
      maxHeight: '88%',
      paddingBottom: 28,
    },
    head: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 14,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: t.cardBorder,
    },
    headTitle: { color: t.text, fontSize: 14, fontWeight: '800', fontFamily: mono },
    iconBtn: { padding: 6, minWidth: 30 },
    pressed: { opacity: 0.6 },
    body: { padding: 14, gap: 12 },
  });
