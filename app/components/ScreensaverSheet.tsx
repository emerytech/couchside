/**
 * Aerial screensaver sheet (opened from the power menu). Apple-TV-style theme
 * picker + quality toggle + start/stop. State is read from the box
 * (api.screensaver), so the running flag reflects reality: stopping it from
 * the TV side (Steam's Exit) shows up on the next poll.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { api, ConnSettings, Screensaver } from '@/lib/api';
import { hapticError, hapticLight, hapticSuccess } from '@/lib/haptics';
import { mono, useThemedStyles, type Palette } from '@/lib/theme';

/** Display labels for the agent's theme ids (order = display order). */
const THEME_LABELS: Record<string, string> = {
  all: 'All',
  landscapes: 'Landscapes',
  cities: 'Cities',
  space: 'Space',
  underwater: 'Underwater',
};

/** UI keeps the tier choice binary; the conf accepts more but these two are
 *  the ones that matter (H264 = every box decodes it; 4K SDR = the showcase). */
const TIER_CHOICES = [
  { id: '1080-H264', label: '1080p' },
  { id: '4K-SDR', label: '4K' },
] as const;

export function ScreensaverSheet({
  visible,
  settings,
  saver,
  onChanged,
  onClose,
}: {
  visible: boolean;
  settings: ConnSettings;
  saver: Screensaver | null;
  onChanged: () => void;
  onClose: () => void;
}) {
  // Selected themes as a set; "all" is exclusive with the rest.
  const [picked, setPicked] = useState<Set<string>>(new Set(['all']));
  const [tier, setTier] = useState<string>('1080-H264');
  const [busy, setBusy] = useState(false);

  // Seed the picker from the box's current conf when the sheet OPENS — and
  // only then. Keying on `saver` too would re-seed on every background poll
  // (new object identity each tick) and silently wipe a selection the user is
  // mid-way through making.
  const wasVisible = React.useRef(false);
  useEffect(() => {
    const opening = visible && !wasVisible.current;
    wasVisible.current = visible;
    if (!opening || !saver) return;
    const parts = saver.theme.split(',').map((t) => t.trim()).filter(Boolean);
    setPicked(new Set(parts.length ? parts : ['all']));
    setTier(saver.tier === '4K-SDR' ? '4K-SDR' : '1080-H264');
  }, [visible, saver]);

  const toggleTheme = useCallback((id: string) => {
    hapticLight();
    setPicked((prev) => {
      if (id === 'all') return new Set(['all']);
      const next = new Set(prev);
      next.delete('all');
      if (next.has(id)) next.delete(id);
      else next.add(id);
      // Nothing left selected reads as "all" — never an empty screensaver.
      return next.size ? next : new Set(['all']);
    });
  }, []);

  const start = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    hapticLight();
    try {
      const themeStr = picked.has('all') ? 'all' : [...picked].join(',');
      await api.screensaverOp(settings, 'start', { theme: themeStr, tier });
      hapticSuccess();
      onChanged();
      onClose();
    } catch {
      hapticError();
    } finally {
      setBusy(false);
    }
  }, [busy, picked, tier, settings, onChanged, onClose]);

  const stop = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    hapticLight();
    try {
      await api.screensaverOp(settings, 'stop');
      onChanged();
    } catch {
      hapticError();
    } finally {
      setBusy(false);
    }
  }, [busy, settings, onChanged]);

  const styles = useThemedStyles(makeStyles);

  const themes = saver?.themes?.length ? saver.themes : Object.keys(THEME_LABELS);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <Text style={styles.title}>AERIAL SCREENSAVER</Text>

          {saver?.running && (
            <View style={styles.armedRow}>
              <Text style={styles.armedText}>Playing on the TV</Text>
              <Pressable onPress={stop} style={styles.cancelBtn} disabled={busy}>
                <Text style={styles.cancelText}>STOP</Text>
              </Pressable>
            </View>
          )}

          <Text style={styles.sub}>THEMES</Text>
          <View style={styles.pills}>
            {themes.map((id) => {
              const on = picked.has(id);
              return (
                <Pressable
                  key={id}
                  onPress={() => toggleTheme(id)}
                  style={[styles.pill, on && styles.pillOn]}>
                  <Text style={[styles.pillText, on && styles.pillTextOn]}>
                    {THEME_LABELS[id] ?? id}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={styles.sub}>QUALITY</Text>
          <View style={styles.seg}>
            {TIER_CHOICES.map((t) => (
              <Pressable
                key={t.id}
                onPress={() => {
                  hapticLight();
                  setTier(t.id);
                }}
                style={[styles.segBtn, tier === t.id && styles.segOn]}>
                <Text style={[styles.segText, tier === t.id && styles.segTextOn]}>{t.label}</Text>
              </Pressable>
            ))}
          </View>

          <Pressable
            disabled={busy}
            onPress={start}
            style={({ pressed }) => [styles.startBtn, pressed && styles.pressed]}>
            <Text style={styles.startText}>
              {busy ? 'Starting…' : saver?.running ? 'Restart with these settings' : 'Start screensaver'}
            </Text>
          </Pressable>
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
  sub: { color: t.textFaint, fontSize: 10, fontWeight: '700', letterSpacing: 1, fontFamily: mono, marginTop: 6 },

  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  pill: {
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 999,
    backgroundColor: t.inset,
    borderColor: t.cardBorder,
    borderWidth: 1,
  },
  pillOn: { borderColor: t.blue, backgroundColor: 'rgba(80,150,255,0.12)' },
  pillText: { color: t.textDim, fontSize: 14, fontWeight: '600' },
  pillTextOn: { color: t.blue },
  pressed: { opacity: 0.7 },

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

  startBtn: {
    marginTop: 12,
    alignItems: 'center',
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: t.blue,
  },
  startText: { color: '#fff', fontSize: 15, fontWeight: '700' },

  armedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: t.inset,
    borderRadius: 10,
    padding: 12,
  },
  armedText: { color: t.text, fontSize: 15 },
  cancelBtn: {
    borderColor: t.red,
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 5,
    paddingHorizontal: 12,
  },
  cancelText: { color: t.red, fontSize: 12, fontWeight: '700', fontFamily: mono },
});
