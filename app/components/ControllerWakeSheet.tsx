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
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { api, hostKey, ConnSettings, UsbWakeDevice } from '@/lib/api';
import { hapticError, hapticLight } from '@/lib/haptics';
import { mono, useTheme, useThemedStyles } from '@/lib/theme';
import { useReducedMotion } from '@/lib/skin/motion';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [verified, setVerified] = useState<Record<string, boolean>>({});
  const generation = useRef(0);
  const pending = useRef(false);
  const reducedMotion = useReducedMotion();
  const insets = useSafeAreaInsets();
  const key = hostKey(settings);
  useEffect(() => {
    generation.current++;
    pending.current = false;
    setBusy(null); setMessage(''); setVerified({}); setAdvanced(false);
    return () => { generation.current++; pending.current = false; };
  }, [key, visible]);
  useEffect(() => {
    setVerified(old => {
      const next = { ...old };
      for (const d of devices) if (next[d.id] === d.armed) delete next[d.id];
      return Object.keys(next).length === Object.keys(old).length ? old : next;
    });
  }, [devices]);

  const toggle = useCallback(async (d: UsbWakeDevice) => {
    if (pending.current) return;
    pending.current = true;
    const run = generation.current;
    const on = !(verified[d.id] ?? d.armed);
    setBusy(d.id); setMessage(''); setFailed(false); hapticLight();
    try {
      const result = await api.usbWakeArm(settings, d.id, on);
      if (generation.current !== run) return;
      if (!result.ok) throw new Error('The box could not change this device.');
      const fresh = await api.usbWake(settings);
      if (generation.current !== run) return;
      if (fresh?.devices.find(item => item.id === d.id)?.armed !== on)
        throw new Error('The box did not confirm the change. Refresh and try again.');
      setVerified(old => ({ ...old, [d.id]: on }));
      setMessage(`${deviceLabel(d)}: ${on ? 'enabled' : 'disabled'}. ${result.persistent ? 'Saved for this USB port, including reboot and reconnect.' : 'Applied for now. Update the box service/helper to save across reboot.'}`);
      onChanged();
    } catch {
      if (generation.current !== run) return;
      hapticError(); setFailed(true);
      setMessage('Could not save and verify this setting. Check the box connection and helper, then try again.');
      onChanged();
    } finally {
      if (generation.current === run) { pending.current = false; setBusy(null); }
    }
  }, [settings, onChanged, verified]);

  const sorted = [...devices].filter(d => advanced || !d.hub).sort(
    (a, b) => Number(a.hub) - Number(b.hub) || a.id.localeCompare(b.id),
  );
  const hubs = devices.filter(d => d.hub).length;

  return (
    <Modal visible={visible} transparent animationType={reducedMotion ? "none" : "fade"} onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close controller wake settings" />
        <View style={[styles.sheet, { paddingBottom: Math.max(18, insets.bottom + 12) }]}>
          <Text style={styles.title}>CONTROLLER & USB WAKE</Text>
          <Text style={styles.blurb}>
            Choose which USB controllers or receivers can wake this box from sleep.
            This is separate from the phone’s Wake Box button. Some devices can also
            wake the box when they disconnect or power off.
          </Text>
          {!!message && <Text accessibilityLiveRegion="polite" style={[styles.blurb, { color: failed ? t.red : t.green }]}>{message}</Text>}
          {hubs > 0 && <Pressable accessibilityRole="button" accessibilityState={{ expanded: advanced }} onPress={() => setAdvanced(v => !v)} style={styles.advanced}>
            <Text style={styles.blurb}>{advanced ? 'Hide' : 'Show'} advanced USB hubs ({hubs})</Text>
          </Pressable>}

          {sorted.length === 0 ? (
            <Text style={styles.empty}>No controllers or receivers found. Check Advanced for USB hubs.</Text>
          ) : (
            <ScrollView nestedScrollEnabled style={styles.list} contentContainerStyle={{ gap: 8 }}>
              {sorted.map((d) => {
                const disabled = !d.writable || busy !== null;
                return (
                  <View key={d.id} style={styles.row} testID={`wake-dev-${d.id}`}>
                    <View style={styles.rowText}>
                      <Text style={styles.devName} >{deviceLabel(d)}</Text>
                      <Text style={styles.devSub}>
                        {d.id}
                        {d.hub ? ' · USB hub' : ' · USB device'}
                        {!d.writable ? ' · helper unavailable' : ''}
                      </Text>
                    </View>
                    {busy === d.id && <ActivityIndicator size="small" color={t.green} />}
                    <Switch
                      accessibilityLabel={`Allow ${deviceLabel(d)} to wake the box`}
                      value={verified[d.id] ?? d.armed}
                      disabled={disabled}
                      onValueChange={() => void toggle(d)}
                      trackColor={{ true: t.green, false: t.inset }}
                    />
                  </View>
                );
              })}
            </ScrollView>
          )}
          <Pressable onPress={onClose} accessibilityRole="button" style={styles.doneBtn}>
            <Ionicons name="checkmark" size={16} color={t.onGreen} />
            <Text style={styles.doneText}>Done</Text>
          </Pressable>
        </View>
      </View>
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
    list: { flexGrow: 0, flexShrink: 1 },
    advanced: { minHeight: 44, justifyContent: 'center' },
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
