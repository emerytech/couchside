/**
 * Discover — search the Steam store from inside the app (engagement Phase 3).
 *
 * A dedicated route pushed from the Play tab. The search is KEYLESS and APP-SIDE
 * (lib/steamSearch → store.steampowered.com): it leaves the PHONE, never the box,
 * so the box's LAN-only promise is unchanged. Because a search TERM is more
 * revealing than an appid, it rides the SAME explicit opt-in the other store
 * lookups use (Prefs > "Look up game compatibility" / `compatLookups`) — and this
 * screen states plainly that searches go to Steam. Off, it offers a one-tap
 * enable that doubles as the disclosure. Tapping a result opens it in Steam.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, FlatList, Image, Pressable, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useLockOrientation } from '@/hooks/useLockOrientation';
import { hapticLight, hapticSelection } from '@/lib/haptics';
import { setPref, usePref } from '@/lib/prefs';
import { openInSteamStore } from '@/lib/steamLinks';
import { searchSteamStore } from '@/lib/steamSearch';
import { searchPriceLabel, type StoreSearchItem } from '@/lib/steamSearchParse';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

// Static: hoisting avoids re-firing <Stack.Screen>'s setOptions layout effect on
// each render (see the Decky crash fix). This screen isn't poll-heavy, but the
// module const is the house pattern now.
const SCREEN_OPTIONS = { headerShown: false };

export default function DiscoverScreen() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  useLockOrientation('portrait'); // like every screen but the Pad
  const lookups = usePref('compatLookups');

  const [term, setTerm] = useState('');
  const [items, setItems] = useState<StoreSearchItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  // Debounce the query; abort the in-flight request when the term changes so a
  // slow response never overwrites a newer one.
  useEffect(() => {
    if (!lookups) return;
    const q = term.trim();
    if (!q) { setItems([]); setSearched(false); setLoading(false); return; }
    let alive = true;
    const ctrl = new AbortController();
    setLoading(true);
    const timer = setTimeout(async () => {
      const res = await searchSteamStore(q, 'US', ctrl.signal);
      if (!alive) return;
      setItems(res);
      setSearched(true);
      setLoading(false);
    }, 350);
    return () => { alive = false; ctrl.abort(); clearTimeout(timer); };
  }, [term, lookups]);

  const open = (item: StoreSearchItem) => {
    hapticLight();
    void openInSteamStore(Number(item.appid));
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <Stack.Screen options={SCREEN_OPTIONS} />
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel="Back">
          <Ionicons name="chevron-back" size={24} color={t.text} />
        </Pressable>
        <Text style={styles.title}>Discover</Text>
        <View style={{ width: 24 }} />
      </View>

      {!lookups ? (
        <View style={styles.gate}>
          <Ionicons name="search" size={28} color={t.textDim} />
          <Text style={styles.gateH}>Search the Steam store</Text>
          <Text style={styles.gateP}>
            Discover searches Steam from your phone (not your box). Your search terms go to
            Steam; nothing about you or your box is sent. This shares the “game lookups”
            setting.
          </Text>
          <Pressable
            onPress={() => { hapticSelection(); void setPref('compatLookups', true); }}
            style={({ pressed }) => [styles.enable, pressed && styles.pressed]}
            accessibilityRole="button">
            <Text style={styles.enableTxt}>Enable & search</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <View style={styles.searchBar}>
            <Ionicons name="search" size={18} color={t.textDim} />
            <TextInput
              testID="discoverSearchInput"
              value={term}
              onChangeText={setTerm}
              placeholder="Search games on Steam"
              placeholderTextColor={t.textFaint}
              autoFocus
              autoCorrect={false}
              returnKeyType="search"
              style={styles.input}
            />
            {term.length > 0 && (
              <Pressable onPress={() => setTerm('')} hitSlop={10} accessibilityLabel="Clear">
                <Ionicons name="close-circle" size={18} color={t.textDim} />
              </Pressable>
            )}
          </View>

          <FlatList
            data={items}
            keyExtractor={(it) => it.appid}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.list}
            ListEmptyComponent={
              loading ? (
                <ActivityIndicator color={t.blue} style={{ marginTop: 24 }} />
              ) : searched ? (
                <Text style={styles.empty}>No games found for “{term.trim()}”.</Text>
              ) : (
                <Text style={styles.hint}>Type to search the Steam store.</Text>
              )
            }
            renderItem={({ item }) => {
              const price = searchPriceLabel(item);
              return (
                <Pressable
                  onPress={() => open(item)}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${item.name} in Steam`}
                  style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
                  {item.tinyImage ? (
                    <Image source={{ uri: item.tinyImage }} style={styles.cover} resizeMode="cover" />
                  ) : (
                    <View style={[styles.cover, styles.coverBlank]} />
                  )}
                  <View style={styles.rowBody}>
                    <Text style={styles.rowName} numberOfLines={1}>{item.name}</Text>
                    <View style={styles.rowMeta}>
                      {item.discountPct > 0 && (
                        <View style={styles.pct}><Text style={styles.pctTxt}>−{item.discountPct}%</Text></View>
                      )}
                      {price ? <Text style={styles.price}>{price}</Text> : null}
                    </View>
                  </View>
                  <Ionicons name="open-outline" size={16} color={t.textDim} />
                </Pressable>
              );
            }}
          />
          <Text style={styles.foot}>Searches go to Steam from your phone · opens in the Steam app</Text>
        </>
      )}
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.bg },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 10 },
    title: { color: t.text, fontSize: 17, fontWeight: '800', fontFamily: mono, letterSpacing: 0.5 },
    gate: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 10 },
    gateH: { color: t.text, fontSize: 16, fontWeight: '700' },
    gateP: { color: t.textDim, fontSize: 13, lineHeight: 19, textAlign: 'center' },
    enable: { marginTop: 8, backgroundColor: t.blue, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 22 },
    enableTxt: { color: '#04121f', fontSize: 14, fontWeight: '800' },
    searchBar: {
      flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 12, marginBottom: 8,
      backgroundColor: t.card, borderColor: t.cardBorder, borderWidth: 1, borderRadius: 12,
      paddingHorizontal: 12, paddingVertical: 10,
    },
    input: { flex: 1, color: t.text, fontSize: 15, padding: 0 },
    list: { paddingHorizontal: 12, paddingBottom: 12, gap: 8 },
    row: {
      flexDirection: 'row', alignItems: 'center', gap: 12,
      backgroundColor: t.card, borderColor: t.cardBorder, borderWidth: 1, borderRadius: 12, padding: 8,
    },
    cover: { width: 92, height: 34, borderRadius: 5, backgroundColor: t.inset },
    coverBlank: { alignItems: 'center', justifyContent: 'center' },
    rowBody: { flex: 1, gap: 4 },
    rowName: { color: t.text, fontSize: 14, fontWeight: '600' },
    rowMeta: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    pct: { backgroundColor: t.green, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
    pctTxt: { color: '#04121f', fontSize: 11, fontWeight: '800' },
    price: { color: t.textDim, fontSize: 12, fontFamily: mono },
    empty: { color: t.textDim, fontSize: 13, textAlign: 'center', marginTop: 24 },
    hint: { color: t.textFaint, fontSize: 13, textAlign: 'center', marginTop: 24 },
    foot: { color: t.textFaint, fontSize: 11, textAlign: 'center', paddingVertical: 10, paddingHorizontal: 16 },
    pressed: { opacity: 0.7 },
  });
