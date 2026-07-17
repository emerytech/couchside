/**
 * Sleep timer + wake schedule sheet (opened from the power menu). Arm a delayed
 * suspend/poweroff, and — when the box exposes a writable RTC — a scheduled wake.
 * The armed state is read from the box (api.powerSchedule), so it reflects reality
 * (an agent restart clears the sleep timer; the row disappears on the next poll).
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useCallback, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { api, ConnSettings, PowerSchedule } from '@/lib/api';
import { hapticError, hapticLight, hapticWarning } from '@/lib/haptics';
import { mono, numeric, useTheme, useThemedStyles } from '@/lib/theme';
import type { Palette } from '@/lib/theme';

const PRESETS_MIN = [15, 30, 45, 60, 90, 120];

function fmtCountdown(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`
    : `${m}:${sec.toString().padStart(2, '0')}`;
}

function fmtClock(epoch: number): string {
  return new Date(epoch * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function SleepTimerSheet({
  visible,
  settings,
  schedule,
  onChanged,
  onClose,
}: {
  visible: boolean;
  settings: ConnSettings;
  schedule: PowerSchedule | null;
  onChanged: () => void;
  onClose: () => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [action, setAction] = useState<'suspend' | 'poweroff'>('suspend');
  const [busy, setBusy] = useState(false);

  const armSleep = useCallback(
    async (minutes: number) => {
      if (busy) return;
      const doArm = async () => {
        setBusy(true);
        hapticLight();
        try {
          await api.powerSleep(settings, minutes * 60, action);
          onChanged();
        } catch {
          hapticError();
        } finally {
          setBusy(false);
        }
      };
      if (action === 'poweroff') {
        // Power off is not cancelable from the app once asleep; confirm.
        hapticWarning();
        // eslint-disable-next-line no-alert
        const { Alert, Platform } = require('react-native') as typeof import('react-native');
        if (Platform.OS === 'web') {
          if (typeof window !== 'undefined' && window.confirm(`Power off in ${minutes} min?`)) void doArm();
          return;
        }
        Alert.alert('Power off', `Power the box off in ${minutes} minutes?`, [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Power off', style: 'destructive', onPress: () => void doArm() },
        ]);
        return;
      }
      void doArm();
    },
    [action, busy, settings, onChanged],
  );

  const cancelSleep = useCallback(async () => {
    hapticLight();
    try {
      await api.powerSleepCancel(settings);
      onChanged();
    } catch {
      /* ignore */
    }
  }, [settings, onChanged]);

  const setWake = useCallback(
    async (hours: number) => {
      hapticLight();
      try {
        await api.powerWake(settings, Math.floor(Date.now() / 1000) + hours * 3600);
        onChanged();
      } catch {
        hapticError();
      }
    },
    [settings, onChanged],
  );

  const cancelWake = useCallback(async () => {
    hapticLight();
    try {
      await api.powerWakeCancel(settings);
      onChanged();
    } catch {
      /* ignore */
    }
  }, [settings, onChanged]);

  const sleep = schedule?.sleep ?? null;
  const wake = schedule?.wake ?? null;
  const wakeAvailable = schedule?.wake_available ?? false;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <Text style={styles.title}>SLEEP TIMER</Text>

          {sleep ? (
            <View style={styles.armedRow}>
              <Text style={styles.armedText}>
                {sleep.action === 'poweroff' ? 'Powers off' : 'Suspends'} in{' '}
                <Text style={styles.armedCount}>{fmtCountdown(sleep.remaining_s)}</Text>
              </Text>
              <Pressable onPress={cancelSleep} style={styles.cancelBtn}>
                <Text style={styles.cancelText}>CANCEL</Text>
              </Pressable>
            </View>
          ) : (
            <>
              <View style={styles.seg}>
                {(['suspend', 'poweroff'] as const).map((a) => (
                  <Pressable
                    key={a}
                    onPress={() => {
                      hapticLight();
                      setAction(a);
                    }}
                    style={[styles.segBtn, action === a && styles.segOn]}>
                    <Text
                      style={[
                        styles.segText,
                        action === a && styles.segTextOn,
                        a === 'poweroff' && action === a && { color: t.red },
                      ]}>
                      {a === 'suspend' ? 'Suspend' : 'Power off'}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <View style={styles.pills}>
                {PRESETS_MIN.map((m) => (
                  <Pressable
                    key={m}
                    disabled={busy}
                    onPress={() => armSleep(m)}
                    style={({ pressed }) => [styles.pill, pressed && styles.pressed]}>
                    <Text style={styles.pillText}>{m >= 60 ? `${m / 60}h` : `${m}m`}</Text>
                  </Pressable>
                ))}
              </View>
            </>
          )}

          {wakeAvailable && (
            <>
              <Text style={[styles.title, { marginTop: 16 }]}>WAKE SCHEDULE</Text>
              {wake ? (
                <View style={styles.armedRow}>
                  <Text style={styles.armedText}>
                    Wakes at <Text style={styles.armedCount}>{fmtClock(wake.fire_at)}</Text>
                  </Text>
                  <Pressable onPress={cancelWake} style={styles.cancelBtn}>
                    <Text style={styles.cancelText}>CANCEL</Text>
                  </Pressable>
                </View>
              ) : (
                <View style={styles.pills}>
                  {[1, 2, 4, 8, 12].map((h) => (
                    <Pressable
                      key={h}
                      onPress={() => setWake(h)}
                      style={({ pressed }) => [styles.pill, pressed && styles.pressed]}>
                      <Text style={styles.pillText}>+{h}h</Text>
                    </Pressable>
                  ))}
                </View>
              )}
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (t: Palette) => StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: t.card,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderColor: t.cardBorder,
    borderWidth: 1,
    padding: 20,
    paddingBottom: 32,
    gap: 10,
  },
  title: { color: t.textFaint, fontSize: 11, fontWeight: '700', letterSpacing: 1.2, fontFamily: mono },

  seg: { flexDirection: 'row', gap: 6, marginTop: 4 },
  segBtn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
    borderRadius: 10,
    borderColor: t.cardBorder,
    borderWidth: 1,
  },
  segOn: { backgroundColor: t.inset, borderColor: t.textDim },
  segText: { color: t.textDim, fontSize: 14, fontWeight: '600' },
  segTextOn: { color: t.text },

  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  pill: {
    minWidth: 54,
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 999,
    backgroundColor: t.inset,
    borderColor: t.cardBorder,
    borderWidth: 1,
  },
  pillText: { color: t.text, fontSize: 15, fontWeight: '700', ...numeric },
  pressed: { opacity: 0.7 },

  armedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: t.inset,
    borderRadius: 10,
    padding: 12,
  },
  armedText: { color: t.text, fontSize: 15 },
  armedCount: { color: t.amber, fontWeight: '700', ...numeric },
  cancelBtn: {
    borderColor: t.red,
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 5,
    paddingHorizontal: 12,
  },
  cancelText: { color: t.red, fontSize: 12, fontWeight: '700', fontFamily: mono },
});
