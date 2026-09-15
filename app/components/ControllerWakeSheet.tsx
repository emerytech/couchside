/**
 * Controller-wake sheet (opened from the power menu, cap `usbwake`). Arm or
 * disarm a USB device as a wake source, so a controller (or its dongle) can wake
 * the box from sleep. The device list and armed state are read from the box
 * (api.usbWake), so a toggle reflects reality after the box's own helper makes
 * the change — we re-read rather than trust the POST's return.
 *
 * The `transient` flag is a WARNING, never a gate: a leaf device that powers
 * itself off (a controller after idle) counts its disconnect as a bus event and
 * can wake the box straight back up, so arming its persistent DONGLE is usually
 * what you want. The heuristic is unreliable (a wireless dongle is a leaf that
 * never leaves — measured), so it only phrases a caution; every armable device is
 * still armable. A row the box can't change at all (`writable: false`, no helper
 * reach) is shown disabled rather than hidden, so the reason is visible.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useCallback, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { api, ConnSettings, UsbWakeDevice } from '@/lib/api';
import { hapticError, hapticLight } from '@/lib/haptics';
import { mono, useTheme, useThemedStyles } from '@/lib/theme';
import type { Palette } from '@/lib/theme';

function deviceLabel(d: UsbWakeDevice): string {
  if (d.name) return d.name;
  if (d.root_hub) return `Root hub ${d.id}`;
  return `USB ${d.id} (${d.vendor}:${d.product_id})`;
}

export function ControllerWakeSheet({
  visible,
  settings,
  devices,
  onChanged,
  onClose,
}: {
  visible: boolean;
  settings: ConnSettings;
  devices: UsbWakeDevice[];
  onChanged: () => void;
  onClose: () => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [busy, setBusy] = useState<string | null>(null);

  const toggle = useCallback(
    async (d: UsbWakeDevice) => {
      if (busy) return;
      setBusy(d.id);
      hapticLight();
      try {
        const ok = await api.usbWakeArm(settings, d.id, !d.armed);
        if (!ok) hapticError();
        // Re-read either way — the box is the authority on the new state.
        onChanged();
      } finally {
        setBusy(null);
      }
    },
    [busy, settings, onChanged],
  );

  // Non-hubs first (the controllers/dongles people actually want), then hubs.
  const sorted = [...devices].sort(
    (a, b) => Number(a.hub) - Number(b.hub) || a.id.localeCompare(b.id),
  );

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <Text style={styles.title}>WAKE DEVICES</Text>
          <Text style={styles.blurb}>
            Let a device wake the box from sleep. If a controller powers itself off, arm the
            dongle it connects through — a device that disconnects can wake the box on its own.
          </Text>
          {sorted.length === 0 ? (
            <Text style={styles.empty}>No wake-capable USB devices found.</Text>
          ) : (
            <ScrollView style={styles.list} contentContainerStyle={{ gap: 8 }}>
              {sorted.map((d) => {
                const disabled = !d.writable || busy === d.id;
                return (
                  <View key={d.id} style={styles.row} testID={`wake-dev-${d.id}`}>
                    <View style={styles.rowText}>
                      <Text style={styles.devName} numberOfLines={1}>{deviceLabel(d)}</Text>
                      <Text style={styles.devSub} numberOfLines={1}>
                        {d.id}
                        {d.hub ? ' · hub' : d.transient ? ' · may sleep' : ''}
                        {!d.writable ? ' · not changeable' : ''}
                      </Text>
                    </View>
                    <Switch
                      value={d.armed}
                      disabled={disabled}
                      onValueChange={() => void toggle(d)}
                      trackColor={{ true: t.green, false: t.inset }}
                    />
                  </View>
                );
              })}
            </ScrollView>
          )}
          <Pressable onPress={onClose} style={styles.doneBtn}>
            <Ionicons name="checkmark" size={16} color={t.onGreen} />
            <Text style={styles.doneText}>Done</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
    sheet: {
      backgroundColor: t.card, borderTopLeftRadius: 18, borderTopRightRadius: 18,
      borderColor: t.cardBorder, borderWidth: StyleSheet.hairlineWidth,
      padding: 18, gap: 12, maxHeight: '80%',
    },
    title: { color: t.textFaint, fontSize: 11, fontWeight: '700', letterSpacing: 1.2, fontFamily: mono },
    blurb: { color: t.textDim, fontSize: 13, lineHeight: 18 },
    empty: { color: t.textFaint, fontSize: 14, paddingVertical: 16, textAlign: 'center' },
    list: { flexGrow: 0 },
    row: {
      flexDirection: 'row', alignItems: 'center', gap: 12,
      backgroundColor: t.inset, borderRadius: 12, padding: 12,
      borderColor: t.cardBorder, borderWidth: StyleSheet.hairlineWidth,
    },
    rowText: { flex: 1 },
    devName: { color: t.text, fontSize: 15, fontWeight: '600' },
    devSub: { color: t.textFaint, fontSize: 12, fontFamily: mono, marginTop: 2 },
    doneBtn: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
      backgroundColor: t.green, borderRadius: 999, paddingVertical: 11,
    },
    doneText: { color: t.onGreen, fontSize: 14, fontWeight: '700' },
  });
