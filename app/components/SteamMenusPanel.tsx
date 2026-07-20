/**
 * "Steam" sub-tab of the Actions screen — jump straight to one of Steam's
 * settings panels on the box.
 *
 * Deliberately its own sub-tab rather than ~19 injected Actions: as Actions
 * they would swamp the list and bury Reboot / Power Off, which are the entries
 * someone is usually hunting for in a hurry.
 *
 * Probe-and-appear (agent >= 2.9.31): the parent hides the whole sub-tab (and
 * the tab strip with it) on an older agent or a box without Steam, so those
 * boxes see exactly the screen they see today. Panels come from the AGENT,
 * never hardcoded here — the slug list was established by firing each URL at
 * real hardware and screen-capturing where it landed, because Steam builds its
 * settings route from the panel name and no slug appears in its JS bundle.
 * Keeping the list server-side means a correction ships as an agent update
 * alone, with no app release.
 */
import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { api, SteamMenu } from '@/lib/api';
import { hapticError, hapticLight, hapticSuccess } from '@/lib/haptics';
import { useSettings } from '@/lib/SettingsContext';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

export function SteamMenusPanel({ menus }: { menus: SteamMenu[] }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { settings } = useSettings();
  const [busy, setBusy] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const onTap = useCallback(
    async (m: SteamMenu) => {
      hapticLight();
      setBusy(m.id);
      setErr(null);
      try {
        await api.openSteamMenu(settings, m.id);
        hapticSuccess();
        // The result is on the TV, not the phone — say what happened, since
        // otherwise a successful tap looks identical to one that did nothing.
        setOpened(m.label);
      } catch (e) {
        hapticError();
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [settings],
  );

  if (!menus.length) return null;

  return (
    <View style={styles.wrap}>
      <Text style={styles.hint}>
        Opens the page on your box&rsquo;s screen — handy when the thing you need to
        configure is the controller itself.
      </Text>

      {err != null ? (
        <View style={styles.errBox}>
          <Text style={styles.errText}>{err}</Text>
        </View>
      ) : opened != null ? (
        <View style={styles.okBox}>
          <Ionicons name="tv-outline" size={14} color={t.green} />
          <Text style={styles.okText}>{opened} is open on the box</Text>
        </View>
      ) : null}

      <View style={styles.grid}>
        {menus.map((m) => (
          <Pressable
            key={m.id}
            onPress={() => onTap(m)}
            disabled={busy != null}
            style={({ pressed }) => [
              styles.chip,
              pressed && styles.pressed,
              busy === m.id && styles.chipBusy,
            ]}>
            <Text style={styles.chipText} numberOfLines={1}>
              {m.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    wrap: { gap: 12, paddingTop: 4 },
    hint: { color: t.textDim, fontSize: 12, lineHeight: 17 },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    chip: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.cardBorder,
      backgroundColor: t.card,
      borderRadius: 999,
      paddingVertical: 10,
      paddingHorizontal: 15,
    },
    chipBusy: { opacity: 0.5 },
    chipText: { color: t.text, fontSize: 13, fontFamily: mono },
    pressed: { opacity: 0.6 },
    okBox: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: t.inset,
      borderRadius: 10,
      paddingVertical: 9,
      paddingHorizontal: 12,
    },
    okText: { color: t.green, fontSize: 12, flex: 1 },
    errBox: {
      backgroundColor: t.inset,
      borderRadius: 10,
      paddingVertical: 9,
      paddingHorizontal: 12,
    },
    errText: { color: t.red, fontSize: 12 },
  });
