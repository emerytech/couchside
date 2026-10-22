import { useLockOrientation } from '@/hooks/useLockOrientation';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Share, Platform, Switch, Text, TextInput, View } from 'react-native';
const draftStorage = {
  async getItem(key: string): Promise<string | null> {
    if (Platform.OS === 'web') return localStorage.getItem(key);
    const { File, Paths } = await import('expo-file-system');
    const file = new File(Paths.document, key + '.json');
    return file.exists ? await file.text() : null;
  },
  async setItem(key: string, value: string) {
    if (Platform.OS === 'web') { localStorage.setItem(key, value); return; }
    const { File, Paths } = await import('expo-file-system');
    const file = new File(Paths.document, key + '.json');
    file.write(value);
  },
};
import { useBoxes } from '@/lib/SettingsContext';
import { useTheme } from '@/lib/theme';
import { api } from '@/lib/api';
import { connFromBox } from '@/lib/boxConn';
import { STEAM_THEME_ACCENTS, steamThemeBox } from '@/lib/steamThemes';
import { THEME_LAYOUTS, THEME_WALLPAPERS, newTheme, parseThemeDocument, type ThemeDocument } from '@/lib/themeFormat';

const STORAGE = 'couchside.theme-studio.drafts.v1';
type Draft = { id: string; theme: ThemeDocument };
const backgrounds = { original: '#142438', midnight: '#171730', ocean: '#125661', forest: '#234132', sunset: '#704151' };
export default function ThemeStudio() {
  useLockOrientation('portrait');
  const t = useTheme();
  const { boxId } = useLocalSearchParams<{ boxId?: string }>();
  const { boxes, activeBox } = useBoxes();
  const box = steamThemeBox(boxes, activeBox, boxId);
  const [theme, setTheme] = useState(newTheme);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [id, setId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [canSave, setCanSave] = useState(false);
  const [studioReady, setStudioReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const live = useRef(true);
  const color = STEAM_THEME_ACCENTS[theme.accent];
  const update = (patch: Partial<ThemeDocument>) => setTheme(v => ({ ...v, ...patch }));
  useEffect(() => {
    let current = true; live.current = true;
    draftStorage.getItem(STORAGE).then(raw => {
      const values: unknown = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(values) || values.length > 20) throw Error('Invalid drafts');
      const valid = values.map(v => { if (!v || typeof v.id !== 'string' || v.id.length > 80) throw Error('Invalid draft'); return { id: v.id, theme: parseThemeDocument(v.theme) }; });
      if (current) { setDrafts(valid); setCanSave(true); }
    }).catch(() => { if (current) setMessage('Could not read saved drafts. They have been left untouched.'); }).finally(() => { if (current) setLoaded(true); });
    if (box) api.steamThemes(connFromBox(box)).then(state => { if (current) setStudioReady(!!state?.studio_ready); }).catch(() => {});
    return () => { current = false; live.current = false; };
  }, [box?.id]);
  async function saveDraft() {
    if (lock.current || !canSave) return;
    lock.current = true; setBusy(true);
    try {
      const value = parseThemeDocument(theme);
      if (!id && drafts.length >= 20) throw Error('You have 20 drafts. Edit an existing theme.');
      const nextId = id || String(Date.now());
      const next = [...drafts.filter(d => d.id !== nextId), { id: nextId, theme: value }];
      await draftStorage.setItem(STORAGE, JSON.stringify(next));
      if (live.current) { setDrafts(next); setId(nextId); setMessage('Draft saved on this device. Your TV is unchanged.'); }
    } catch (e) { if (live.current) setMessage(e instanceof Error ? e.message : 'Could not save draft.'); }
    finally { lock.current = false; if (live.current) setBusy(false); }
  }
  async function apply(enabled: boolean) {
    if (lock.current || !box || (enabled && !studioReady)) return;
    lock.current = true; setBusy(true);
    try {
      const value = enabled ? parseThemeDocument(theme) : newTheme();
      await api.saveSteamTheme(connFromBox(box), enabled ? { installed: true, enabled: true, theme: value.layout, accent: value.accent, motion: value.motion, studio: value } : { enabled: false });
      if (live.current) setMessage(enabled ? `Applied ${value.name} to ${box.name}.` : 'Steam default restored. Your drafts are saved.');
    } catch (e) { if (live.current) setMessage(e instanceof Error ? e.message : 'Could not apply.'); }
    finally { lock.current = false; if (live.current) setBusy(false); }
  }
  const button = (label: string, action: () => void, selected = false, disabled = false) => <Pressable key={label} disabled={disabled || busy} accessibilityRole="button" accessibilityState={{ selected, disabled: disabled || busy }} onPress={action} style={{ padding: 12, borderRadius: 12, borderWidth: 1, borderColor: selected ? color : t.cardBorder, backgroundColor: t.card, opacity: disabled || busy ? .45 : 1 }}><Text style={{ color: selected ? color : t.text, fontWeight: '600' }}>{label}</Text></Pressable>;
  return <><Stack.Screen options={{ title: 'Theme Studio · Beta', headerBackTitle: 'Themes' }} /><ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: 20, gap: 16, paddingBottom: 48 }}>
    <Text style={{ color: t.text, fontSize: 26, fontWeight: '800' }}>Create your own theme</Text>
    <Text style={{ color: t.textDim }}>Save a draft here, export it, or apply it to {box?.name || 'a connected box'}. Nothing changes on the TV until you choose Apply.</Text>
    {!!message && <Text accessibilityLiveRegion="polite" style={{ color: t.text }}>{message}</Text>}
    <Text style={{ color: t.text, fontWeight: '700' }}>Your drafts</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{button('New theme', () => { setTheme(newTheme()); setId(null); setMessage(''); })}{drafts.map(d => button(d.theme.name, () => { setId(d.id); setTheme(d.theme); }, id === d.id))}</View>
    <TextInput accessibilityLabel="Theme name" placeholder="Theme name" value={theme.name} maxLength={60} editable={!busy} onChangeText={name => update({ name })} style={{ color: t.text, backgroundColor: t.card, padding: 14, borderRadius: 12 }} />
    <TextInput accessibilityLabel="Theme author" placeholder="Your name (optional)" placeholderTextColor={t.textDim} value={theme.author} maxLength={80} editable={!busy} onChangeText={author => update({ author })} style={{ color: t.text, backgroundColor: t.card, padding: 14, borderRadius: 12 }} />
    <Text style={{ color: t.text, fontWeight: '700' }}>Layout</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{THEME_LAYOUTS.map(layout => button(layout[0].toUpperCase() + layout.slice(1), () => update({ layout }), theme.layout === layout))}</View>
    <Text style={{ color: t.text, fontWeight: '700' }}>Accent</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{Object.keys(STEAM_THEME_ACCENTS).map(accent => button(accent, () => update({ accent: accent as ThemeDocument['accent'] }), theme.accent === accent))}</View>
    <Text style={{ color: t.text, fontWeight: '700' }}>Wallpaper style</Text>
    <Text style={{ color: t.textDim }}>Built-in backgrounds for now. Personal image imports come in the asset-import phase.</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{Object.entries(THEME_WALLPAPERS).map(([wallpaper, label]) => button(label, () => update({ wallpaper: wallpaper as ThemeDocument['wallpaper'] }), theme.wallpaper === wallpaper))}</View>
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}><Text style={{ color: t.text }}>Animations</Text><Switch accessibilityLabel="Theme animations" disabled={busy} value={theme.motion} onValueChange={motion => update({ motion })} /></View>
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}><Text style={{ color: t.text }}>Game stats</Text><Switch accessibilityLabel="Show game stats" disabled={busy} value={theme.stats} onValueChange={stats => update({ stats })} /></View>
    <View accessibilityLabel="Theme layout sketch" style={{ backgroundColor: backgrounds[theme.wallpaper], padding: 18, borderRadius: 16, borderWidth: 2, borderColor: color, gap: 12 }}>
      <Text style={{ color: '#fff', fontWeight: '700' }}>{theme.name || 'My theme'}</Text><Text style={{ color: '#ccd7e5' }}>{theme.layout} · layout sketch</Text>
      <View style={{ flexDirection: theme.layout === 'crossbar' || theme.layout === 'wave' ? 'column' : 'row', flexWrap: 'wrap', gap: 8 }}>{[0,1,2,3].map(i => <View key={i} style={{ width: theme.layout === 'wave' || theme.layout === 'crossbar' ? '70%' : 52, height: 40, backgroundColor: i ? '#ffffff20' : color, borderRadius: theme.layout === 'channels' ? 12 : 2 }} />)}</View>
      {theme.stats && <Text style={{ color: '#ccd7e5' }}>Sample · 12 h played · Achievements 8 / 24</Text>}
    </View>
    {button('Save draft', () => void saveDraft(), false, !loaded || !canSave)}
    {button('Export theme', () => { try { void Share.share({ message: JSON.stringify(parseThemeDocument(theme), null, 2) }).catch(() => setMessage('Could not open sharing.')); } catch (e) { setMessage(e instanceof Error ? e.message : 'Invalid theme'); } })}
    {!studioReady && <Text style={{ color: t.textDim }}>Update this box’s Couchside service and Decky companion for Theme Studio support. Drafts and export still work.</Text>}
    {button(`Apply to ${box?.name || 'TV'}`, () => void apply(true), true, !studioReady || !box)}
    {button('Restore Steam default', () => void apply(false), false, !box)}
  </ScrollView></>;
}
