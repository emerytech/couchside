/**
 * "Steam" sub-tab of the Actions screen — jump straight to one of Steam's
 * settings panels on the box.
 *
 * Layout: Bluetooth is pulled out as a hero row, because "pair a controller" is
 * the reason this surface exists — it is the one job you cannot do WITH a
 * controller. The rest are grouped so 19 chips read as a menu rather than a
 * wall of pills.
 *
 * Grouping is CLIENT-SIDE on purpose. Labels still come from the agent (the
 * slug list was established by firing each URL at real hardware and screen-
 * capturing where it landed, so it must stay server-owned), but grouping is
 * presentation. An id this app has never heard of still renders — it lands in
 * MORE — so an agent that learns new panels is never blocked on an app release.
 *
 * Probe-and-appear (agent >= 2.9.31): the parent hides the whole sub-tab, and
 * the tab strip with it, when the box returns no menus.
 */
import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { api, SteamMenu } from '@/lib/api';
import { hapticError, hapticLight, hapticSuccess } from '@/lib/haptics';
import { useSettings } from '@/lib/SettingsContext';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

const HERO_ID = 'bluetooth';

/** Presentation only — an unlisted id falls into MORE rather than vanishing. */
const GROUPS: { title: string; ids: string[] }[] = [
  { title: 'INPUT', ids: ['controller', 'keyboard'] },
  { title: 'DISPLAY & SOUND', ids: ['display', 'audio', 'power'] },
  {
    title: 'LIBRARY & STORAGE',
    ids: ['home', 'library', 'store', 'downloads', 'storage', 'gamerecording'],
  },
  {
    title: 'SYSTEM',
    ids: [
      'network',
      'cloud',
      'security',
      'family',
      'friends',
      'accessibility',
      'customization',
    ],
  },
];

export function SteamMenusPanel({ menus }: { menus: SteamMenu[] }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { settings } = useSettings();
  const [busy, setBusy] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const { hero, sections } = useMemo(() => {
    const byId = new Map(menus.map((m) => [m.id, m]));
    const heroMenu = byId.get(HERO_ID) ?? null;
    const claimed = new Set<string>(heroMenu ? [HERO_ID] : []);
    const out: { title: string; items: SteamMenu[] }[] = [];
    for (const g of GROUPS) {
      const items: SteamMenu[] = [];
      for (const id of g.ids) {
        const m = byId.get(id);
        if (m) {
          items.push(m);
          claimed.add(id);
        }
      }
      if (items.length) out.push({ title: g.title, items });
    }
    const rest = menus.filter((m) => !claimed.has(m.id));
    if (rest.length) out.push({ title: 'MORE', items: rest });
    return { hero: heroMenu, sections: out };
  }, [menus]);

  const open = useCallback(
    async (m: SteamMenu) => {
      hapticLight();
      setBusy(m.id);
      setErr(null);
      setOpened(null);
      try {
        await api.openSteamMenu(settings, m.id);
        hapticSuccess();
        // The result lands on the TV, not the phone — without saying so, a
        // successful tap and a no-op look identical.
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
      {hero && (
        <Pressable
          onPress={() => open(hero)}
          disabled={busy != null}
          style={({ pressed }) => [styles.hero, pressed && styles.pressed]}>
          <View style={styles.heroIcon}>
            {busy === hero.id ? (
              <ActivityIndicator size="small" color={t.blue} />
            ) : (
              <Ionicons name="bluetooth" size={20} color={t.blue} />
            )}
          </View>
          <View style={styles.heroText}>
            <Text style={styles.heroTitle}>{hero.label}</Text>
            <Text style={styles.heroSub}>Pair a controller, headset or keyboard</Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={t.textFaint} />
        </Pressable>
      )}

      {err != null ? (
        <View style={styles.banner}>
          <Ionicons name="alert-circle-outline" size={14} color={t.red} />
          <Text style={styles.bannerErrText}>{err}</Text>
        </View>
      ) : opened != null ? (
        <View style={styles.banner}>
          <Ionicons name="tv-outline" size={14} color={t.green} />
          <Text style={styles.bannerOkText}>
            <Text style={styles.bannerStrong}>{opened}</Text> is open on the box
          </Text>
        </View>
      ) : (
        <Text style={styles.hint}>Opens the page on your box&rsquo;s screen.</Text>
      )}

      {sections.map((sec) => (
        <View key={sec.title} style={styles.section}>
          <Text style={styles.sectionTitle}>{sec.title}</Text>
          <View style={styles.grid}>
            {sec.items.map((m) => (
              <Pressable
                key={m.id}
                onPress={() => open(m)}
                disabled={busy != null}
                style={({ pressed }) => [
                  styles.chip,
                  pressed && styles.pressed,
                  busy === m.id && styles.chipBusy,
                ]}>
                {busy === m.id && (
                  <ActivityIndicator size="small" color={t.textDim} style={styles.chipSpin} />
                )}
                <Text style={styles.chipText} numberOfLines={1}>
                  {m.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    wrap: { gap: 14, paddingTop: 2 },

    hero: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      backgroundColor: t.card,
      borderWidth: 1,
      borderColor: t.blue,
      borderRadius: 14,
      paddingVertical: 14,
      paddingHorizontal: 14,
    },
    heroIcon: {
      width: 34,
      height: 34,
      borderRadius: 17,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: t.inset,
    },
    heroText: { flex: 1, gap: 2 },
    heroTitle: { color: t.text, fontSize: 16, fontWeight: '700', fontFamily: mono },
    heroSub: { color: t.textDim, fontSize: 12 },

    hint: { color: t.textFaint, fontSize: 12 },
    banner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: t.inset,
      borderRadius: 10,
      paddingVertical: 9,
      paddingHorizontal: 12,
    },
    bannerOkText: { color: t.textDim, fontSize: 12, flex: 1 },
    bannerStrong: { color: t.green, fontWeight: '700' },
    bannerErrText: { color: t.red, fontSize: 12, flex: 1 },

    section: { gap: 8 },
    sectionTitle: {
      color: t.textFaint,
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 1.1,
      fontFamily: mono,
    },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.cardBorder,
      backgroundColor: t.card,
      borderRadius: 10,
      paddingVertical: 10,
      paddingHorizontal: 14,
    },
    chipBusy: { opacity: 0.6 },
    chipSpin: { marginRight: 2 },
    chipText: { color: t.text, fontSize: 13, fontFamily: mono },
    pressed: { opacity: 0.6 },
  });
