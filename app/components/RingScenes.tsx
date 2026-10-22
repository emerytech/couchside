import React, { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, Switch, Text, TextInput, View } from 'react-native';
import { api, hostKey, type RingProgram, type RingProgramState } from '@/lib/api';
import { useSettings } from '@/lib/SettingsContext';
import { usePoll } from '@/hooks/usePoll';
import { useTheme } from '@/lib/theme';
import { addPreset, removePreset, useLedPresets } from '@/lib/ledPresets';
import { PresetNameModal } from './PresetNameModal';

const DEFAULT: RingProgram = { scene: 'aurora', brightness: 50, period: 20,
  night: { enabled: false, start: 22 * 60, end: 7 * 60, brightness: 10 } };
const SCENES: RingProgram['scene'][] = ['aurora', 'ember', 'ocean', 'cyberpunk'];
const clock = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const minutes = (s: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s)
  ? Number(s.slice(0, 2)) * 60 + Number(s.slice(3)) : null;

export function RingScenes() {
  const t = useTheme();
  const { settings } = useSettings();
  const key = hostKey(settings);
  const poll = usePoll<RingProgramState>(() => api.ringProgram(settings), 4000, true, key);
  const [draft, setDraft] = useState<RingProgram>(DEFAULT);
  const [start, setStart] = useState(clock(DEFAULT.night.start));
  const [end, setEnd] = useState(clock(DEFAULT.night.end));
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [naming, setNaming] = useState(false);
  const seeded = useRef('');
  const favorites = useLedPresets().filter(p => p.ringProgram);
  const load = (p: RingProgram) => { setDraft(p); setStart(clock(p.night.start)); setEnd(clock(p.night.end)); };
  useEffect(() => {
    if (!poll.data || seeded.current === key) return;
    seeded.current = key;
    load(poll.data.program ?? DEFAULT);
  }, [poll.data, key]);
  const config = (): RingProgram | null => {
    const a = minutes(start), b = minutes(end);
    if (a === null || b === null || a === b) {
      Alert.alert('Check night hours', 'Use two different times in 24-hour HH:MM format.'); return null;
    }
    return { ...draft, night: { ...draft.night, start: a, end: b } };
  };
  const apply = async (p: RingProgram | null) => {
    setBusy(true);
    try { await api.setRingProgram(settings, p); if (p) load(p); await poll.refresh(); }
    catch { Alert.alert('Lighting not applied', 'Check the connection and try again.'); }
    finally { setBusy(false); }
  };
  const button = (label: string, action: () => void, selected = false) => (
    <Pressable key={label} disabled={busy} onPress={action} accessibilityRole="button"
      accessibilityState={{ selected, disabled: busy }}
      style={{ padding: 12, borderRadius: 12, backgroundColor: selected ? t.blue : t.bg,
        opacity: busy ? 0.5 : 1 }}>
      <Text style={{ color: selected ? t.bg : t.text }}>{label}</Text>
    </Pressable>
  );
  if (!expanded) return <Pressable accessibilityRole="button" accessibilityState={{ expanded: false }}
    onPress={() => setExpanded(true)} style={{ paddingVertical: 14 }}>
    <Text style={{ color: t.blue, fontWeight: '700' }}>Scenes &amp; night mode ▾</Text>
    <Text style={{ color: t.textDim }}>{poll.data?.error ?? (poll.data?.program ? `Running: ${poll.data.program.scene}` : 'Color scenes, favorites, and overnight dimming')}</Text>
  </Pressable>;
  return <View style={{ gap: 12, paddingVertical: 14 }}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: true }} onPress={() => setExpanded(false)}>
      <Text style={{ color: t.blue }}>Scenes &amp; night mode ▴</Text>
    </Pressable>
    <Text style={{ color: t.text, fontWeight: '700' }}>Color scenes</Text>
    <Text style={{ color: t.textDim }}>Smooth color shifts across both rings. Runs on your box after you close Couchside.</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {SCENES.map(scene => button(scene[0].toUpperCase() + scene.slice(1), () => setDraft({ ...draft, scene }), draft.scene === scene))}
    </View>
    <Text style={{ color: t.textDim }}>Full color cycle</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {[10, 20, 60].map(period => button(`${period}s`, () => setDraft({ ...draft, period }), draft.period === period))}
    </View>
    <Text style={{ color: t.textDim }}>Brightness</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {[25, 50, 75, 100].map(brightness => button(`${brightness}%`, () => setDraft({ ...draft, brightness }), draft.brightness === brightness))}
    </View>
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
      <Text style={{ color: t.text }}>Night mode for this scene</Text>
      <Switch accessibilityLabel="Night mode for this scene" value={draft.night.enabled} disabled={busy}
        onValueChange={enabled => setDraft({ ...draft, night: { ...draft.night, enabled } })} />
    </View>
    {draft.night.enabled && <>
      <Text style={{ color: t.textDim }}>Box time ({poll.data?.timezone ?? 'local'}), 24-hour format</Text>
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <TextInput accessibilityLabel="Night start HH:MM" value={start} onChangeText={setStart} maxLength={5}
          style={{ color: t.text, borderColor: t.textDim, borderWidth: 1, borderRadius: 8, padding: 12, flex: 1 }} />
        <TextInput accessibilityLabel="Night end HH:MM" value={end} onChangeText={setEnd} maxLength={5}
          style={{ color: t.text, borderColor: t.textDim, borderWidth: 1, borderRadius: 8, padding: 12, flex: 1 }} />
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {[0, 5, 10, 25].map(brightness => button(brightness === 0 ? 'Off at night' : `Night ${brightness}%`,
          () => setDraft({ ...draft, night: { ...draft.night, brightness } }), draft.night.brightness === brightness))}
      </View>
    </>}
    <Text style={{ color: t.textDim }}>{poll.data?.error ?? (poll.data?.program
      ? `Running: ${poll.data.program.scene}. Manual effects below stop the scene and its night schedule.`
      : 'No scene running. Choose Apply to start.')}</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {button(busy ? 'Applying…' : 'Apply scene', () => { const p = config(); if (p) void apply(p); })}
      {button('Stop & turn off', () => { void apply(null); })}
      {button('Save favorite', () => { if (config()) setNaming(true); })}
    </View>
    {favorites.length > 0 && <Text style={{ color: t.text }}>Favorites on this phone · hold to remove</Text>}
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {favorites.map(p => <Pressable key={p.id} disabled={busy} accessibilityRole="button"
        accessibilityLabel={`Apply ${p.label}`} onPress={() => { void apply(p.ringProgram!); }}
        onLongPress={() => Alert.alert('Remove favorite?', p.label, [
          { text: 'Cancel', style: 'cancel' }, { text: 'Remove', style: 'destructive', onPress: () => { void removePreset(p.id); } },
        ])} style={{ padding: 12, backgroundColor: t.bg, borderRadius: 12 }}>
        <Text style={{ color: t.text }}>{p.label}</Text>
      </Pressable>)}
    </View>
    <PresetNameModal visible={naming} defaultName={draft.scene} onClose={() => setNaming(false)}
      onSubmit={name => { const p = config(); if (!p) return;
        void addPreset({ label: name, effect: 'solid', color: null, speed: 50,
          brightness: p.brightness, ringProgram: p }).then(saved => {
            if (!saved) Alert.alert('Favorites full', 'Remove a saved preset before adding another.');
          }).catch(() => Alert.alert('Could not save favorite', 'Please try again.')); setNaming(false); }} />
  </View>;
}
