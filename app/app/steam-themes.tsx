import { useLockOrientation } from '@/hooks/useLockOrientation';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { api, hostKey, type ConnSettings } from '@/lib/api';
import { useBoxes } from '@/lib/SettingsContext';
import { connFromBox } from '@/lib/boxConn';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { STEAM_THEME_ACCENTS, canApplySteamTheme, steamThemeBox, type SteamTheme, type SteamThemeSettings, type SteamThemesState } from '@/lib/steamThemes';
import { useTheme } from '@/lib/theme';

const PREVIEWS = {
  couchside: require('../assets/steamThemes/couchside.png'),
  orbit: require('../assets/steamThemes/orbit.png'),
  shelf: require('../assets/steamThemes/shelf.png'),
  wave: require('../assets/steamThemes/wave.png'),
  crossbar: require('../assets/steamThemes/crossbar.png'),
  horizon: require('../assets/steamThemes/horizon.png'),
  channels: require('../assets/steamThemes/channels.png'),
};
const SCREEN_OPTIONS = { title: 'Steam appearance', headerBackTitle: 'Settings' };
function LayoutPreview({ theme }: { theme: SteamTheme }) {
  return <View style={{ width: '100%', aspectRatio: 16 / 9, overflow: 'hidden', backgroundColor: '#0c1321' }}>
    <Image source={PREVIEWS[theme.id]} accessibilityLabel={`${theme.name} preview with a sample library`}
      style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }} resizeMode="contain" />
  </View>;
}

export default function SteamThemesScreen() {
  useLockOrientation('portrait');
  const { boxId } = useLocalSearchParams<{ boxId?: string }>();
  const { boxes, activeBox, ready } = useBoxes();
  const t = useTheme();
  const box = steamThemeBox(boxes, activeBox, boxId);
  if (!ready) return <><Stack.Screen options={SCREEN_OPTIONS} /><ActivityIndicator color={t.blue} /></>;
  if (!box) return <><Stack.Screen options={SCREEN_OPTIONS} /><View style={{ padding: 24 }}><Text style={{ color: t.text }}>This box is no longer saved. Return to Settings and choose a box.</Text></View></>;
  const settings = connFromBox(box);
  return <ThemePicker key={`${box.id}|${hostKey(settings)}`} settings={settings} boxName={box.name} boxId={box.id} />;
}

function ThemePicker({ settings, boxName, boxId }: { settings: ConnSettings; boxName: string; boxId: string }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const live = useRef(true);
  const saving = useRef(false);
  const [state, setState] = useState<SteamThemesState | null>(null);
  const [selected, setSelected] = useState<SteamThemeSettings['theme']>('couchside');
  const [accent, setAccent] = useState<SteamThemeSettings['accent']>('teal');
  const [motion, setMotion] = useState(true);
  const [search, setSearch] = useState('');
  const [customize, setCustomize] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    live.current = true;
    let current = true;
    api.steamThemes(settings).then(value => {
      if (!current) return;
      setState(value);
      if (value) { setSelected(value.settings.theme); setAccent(value.settings.accent); setMotion(value.settings.motion); }
      else setMessage('Update this box’s Couchside service to use SteamOS themes.');
    }).catch(() => { if (current) setMessage('Could not reach this box. Check the connection and reopen Themes.'); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; live.current = false; };
  }, []);
  async function save(enabled: boolean) {
    if (saving.current || (enabled && !canApplySteamTheme(state, selected, search, false))) return;
    saving.current = true; setBusy(true); setMessage('');
    try {
      const result = await api.saveSteamTheme(settings, { installed: enabled || !!state?.settings.installed, enabled, theme: selected, accent, motion });
      if (live.current) {
        setState(result);
        setMessage(enabled ? 'Saved. The TV will switch themes shortly.' : 'Steam default saved. The TV will switch back shortly.');
      }
    } catch (e) { if (live.current) setMessage(e instanceof Error ? e.message : 'Could not save theme. Try again.'); }
    finally { saving.current = false; if (live.current) setBusy(false); }
  }
  const color = STEAM_THEME_ACCENTS[accent];
  const canApply = canApplySteamTheme(state, selected, search, busy);
  const selectedName = state?.themes.find(theme => theme.id === selected)?.name ?? 'theme';
  const themes = state?.themes.filter(theme => `${theme.name} ${theme.description} ${theme.layout}`.toLowerCase().includes(search.trim().toLowerCase())) ?? [];
  return <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={insets.top + 44}>
    <Stack.Screen options={SCREEN_OPTIONS} />
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={styles.content}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}><Text style={[styles.heading, { color: t.text }]}>Make this box yours</Text><Text accessibilityLabel="Themes beta" style={{ color: t.blue, borderColor: t.blue, borderWidth: 1, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3, fontSize: 11, fontWeight: '700' }}>BETA</Text></View>
      <Text style={{ color: t.textDim }}>Choose how Steam looks on {boxName}. Themes are optional and in beta; you can restore Steam default at any time.</Text>
      <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: '/theme-studio', params: { boxId } })} style={[styles.notice, { backgroundColor: t.card }]}><Text style={{ color: t.blue, fontWeight: '700' }}>Create a theme →</Text><Text style={{ color: t.textDim }}>Theme Studio · drafts, colors and backgrounds</Text></Pressable>
      {loading && <ActivityIndicator color={t.blue} />}
      {!!message && !state && <Text accessibilityLiveRegion="polite" style={{ color: t.text }}>{message}</Text>}
      {state && <>
        {!state.companion_ready && <View style={[styles.notice, { backgroundColor: t.card }]}><Text style={{ color: t.text }}>Install Decky Loader and update the Couchside companion before applying themes. Previews are available below.</Text></View>}
        <TextInput accessibilityLabel="Search SteamOS themes" placeholder="Search themes…" placeholderTextColor={t.textFaint}
          value={search} onChangeText={setSearch} style={[styles.search, { color: t.text, backgroundColor: t.card, borderColor: t.cardBorder }]} />
        <Pressable disabled={busy} onPress={() => save(false)} accessibilityRole="button" style={[styles.notice, { backgroundColor: t.card, borderColor: !state.settings.enabled ? color : t.cardBorder, borderWidth: 1 }]}>
          <Text style={{ color: t.text, fontWeight: '700' }}>Steam default {!state.settings.enabled ? '· Active' : ''}</Text>
          <Text style={{ color: t.textDim }}>Restore Steam’s normal home screen</Text>
        </Pressable>
        {themes.map(theme => <Pressable key={theme.id} onPress={() => setSelected(theme.id)} disabled={busy} accessibilityRole="button"
          accessibilityState={{ selected: selected === theme.id }} accessibilityLabel={`${theme.name}. ${theme.description}`}
          style={[styles.card, { backgroundColor: t.card, borderColor: selected === theme.id ? color : t.cardBorder }]}>
          <LayoutPreview theme={theme} />
          <Text style={{ color: t.textDim, fontSize: 11, paddingHorizontal: 16, paddingTop: 8 }}>Sample library · accent colors can be customized</Text>
          <View style={{ padding: 16, gap: 5 }}><Text style={{ color: t.text, fontWeight: '800', fontSize: 18 }}>{theme.name}</Text>
            <Text style={{ color: t.textDim }}>{theme.description}</Text>
            {state.settings.enabled && state.settings.theme === theme.id && <Text style={{ color }}>Active on this box</Text>}
            {selected === theme.id && <Text style={{ color: t.text, fontWeight: '600' }}>Selected{!state.settings.enabled || state.settings.theme !== theme.id || state.settings.accent !== accent || state.settings.motion !== motion ? ' · not applied yet' : ''}</Text>}
          </View>
        </Pressable>)}
        {!themes.length && <Text style={{ color: t.textDim }}>No themes match your search.</Text>}
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: customize }} onPress={() => setCustomize(!customize)} style={styles.notice}>
          <Text style={{ color: t.text, fontWeight: '700' }}>Customize {customize ? '⌃' : '⌄'}</Text>
        </Pressable>
        {customize && <View style={[styles.notice, { backgroundColor: t.card, gap: 18 }]}>
          <Text style={{ color: t.text }}>Accent color</Text>
          <View style={{ flexDirection: 'row', gap: 12 }}>{(Object.keys(STEAM_THEME_ACCENTS) as SteamThemeSettings['accent'][]).map(name =>
            <Pressable key={name} disabled={busy} onPress={() => setAccent(name)} accessibilityRole="button" accessibilityLabel={name} accessibilityState={{ selected: accent === name }}
              style={{ backgroundColor: STEAM_THEME_ACCENTS[name], width: 42, height: 42, borderRadius: 21, borderWidth: 3, borderColor: accent === name ? t.text : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
              {accent === name && <Text style={{ color: '#0c1321', fontWeight: '900' }}>✓</Text>}
            </Pressable>)}</View>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}><Text style={{ color: t.text }}>Animations</Text><Switch disabled={busy} accessibilityLabel="Theme animations" value={motion} onValueChange={setMotion} /></View>
          <Text style={{ color: t.textDim }}>System reduced-motion settings also apply.</Text>
        </View>}
        <Text style={{ color: t.textDim, fontSize: 12 }}>Themes run on the box. Restore Steam default here or from the Couchside Decky panel.</Text>
      </>}
    </ScrollView>
    {state && <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.cardBorder,
      backgroundColor: t.bg, paddingHorizontal: 20, paddingTop: 12, paddingBottom: Math.max(insets.bottom, 14), gap: 8 }}>
      {!!message && <Text accessibilityLiveRegion="polite" style={{ color: t.text, fontSize: 12 }}>{message}</Text>}
      {!canApply && !!search.trim() && !busy && state.companion_ready && <Text style={{ color: t.textDim, fontSize: 12 }}>Select a theme in these results, or clear your search.</Text>}
      <Pressable disabled={!canApply} onPress={() => save(true)} accessibilityRole="button"
        accessibilityState={{ disabled: !canApply, busy }}
        style={[styles.apply, { backgroundColor: color, opacity: canApply ? 1 : 0.45 }]}>
        <Text style={{ color: '#0c1321', fontWeight: '800' }}>{busy ? 'Saving…' : !state.companion_ready ? 'Companion update required' : !canApply ? 'Select a theme' : `Apply ${selectedName}`} </Text>
      </Pressable>
    </View>}
  </KeyboardAvoidingView>;
}
const styles = StyleSheet.create({ content: { padding: 20, paddingBottom: 24, gap: 16, maxWidth: 720, width: '100%', alignSelf: 'center' }, heading: { fontSize: 26, fontWeight: '800' }, search: { borderWidth: 1, padding: 14, borderRadius: 12, fontSize: 16 }, notice: { padding: 16, borderRadius: 12, gap: 6 }, card: { borderWidth: 2, borderRadius: 18, overflow: 'hidden' }, apply: { padding: 17, borderRadius: 14, alignItems: 'center' } });
