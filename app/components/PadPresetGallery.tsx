import { useEffect, useRef, useState } from 'react';
import { Image, Pressable, ScrollView, Text, View, type ImageSourcePropType } from 'react-native';
import { PadPresetPreview } from './PadPresetPreview';
import { backdropAssets } from '@/lib/gameThemeAssets';
import { adjacentPreset, PRESET_IDS, presetDraft, presetInfo } from '@/lib/padPresetGallery';
import { normalizePadPreset, type PadPreset } from '@/lib/padPresets';
import { useTheme } from '@/lib/theme';
import type { Box } from '@/lib/settings';

export function PadPresetGallery({ box, onApply, onClose, onExpandedChange, onSavingChange }: {
  box: Box | undefined; onApply(p: PadPreset): Promise<void>; onClose(): void;
  onExpandedChange(expanded: boolean): void; onSavingChange(saving: boolean): void;
}) {
  const t = useTheme();
  const [saved] = useState(() => normalizePadPreset(box?.controlPreset));
  const [drafts, setDrafts] = useState<Record<string, PadPreset>>(() => ({ [saved.id]: saved }));
  const [id, setId] = useState<PadPreset['id']>(saved.id);
  const [detail, setDetail] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [trying, setTrying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const savePending = useRef(false);
  const draft = drafts[id] ?? presetDraft(id), info = presetInfo(id);
  useEffect(() => { onExpandedChange(expanded); return () => onExpandedChange(false); }, [expanded, onExpandedChange]);
  const update = (patch: Partial<PadPreset>) => { setTrying(false); setDrafts(old => ({ ...old, [id]: { ...draft, ...patch } })); };
  const choose = (next: PadPreset['id']) => { setTrying(false); setError(''); setId(next); setDetail(true); };
  const button = (label: string, action: () => void, selected = false, disabled = false) =>
    <Pressable key={label} accessibilityRole="button" accessibilityLabel={label} disabled={disabled || saving}
      accessibilityState={{ selected, disabled: disabled || saving }} onPress={action}
      style={({ pressed }) => ({ minHeight: 44, paddingHorizontal: 14, paddingVertical: 11, borderRadius: 12,
        borderWidth: 1, borderColor: selected ? t.blue : t.cardBorder, backgroundColor: selected ? t.blue : t.card,
        opacity: disabled || saving ? 0.5 : pressed ? 0.7 : 1, alignItems: 'center', justifyContent: 'center' })}>
      <Text style={{ color: selected ? t.bg : t.text, fontWeight: '600', fontSize: 14 }}>{label}</Text>
    </Pressable>;
  const apply = async () => {
    if (!box || savePending.current) return;
    savePending.current = true; setSaving(true); onSavingChange(true); setError(''); setTrying(false);
    try { await onApply(draft); onClose(); }
    catch { setError('Could not save the preset. Please try again.'); }
    finally { savePending.current = false; setSaving(false); onSavingChange(false); }
  };
  const options = <View style={{ gap: 12 }}>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {info.handed && <>
        {button('Left hand', () => update({ hand: 'left' }), draft.hand === 'left')}
        {button('Right hand', () => update({ hand: 'right' }), draft.hand !== 'left')}
      </>}
      {id === 'stardew' && <>
        {button('Standard buttons', () => update({ size: 'standard' }), draft.size === 'standard')}
        {button('Larger buttons', () => update({ size: 'larger' }), draft.size === 'larger')}
      </>}
      {id !== 'current' && <>
        {button(info.art, () => update({ background: id === 'stardew' ? 'farm' : id === 'vampire' ? 'ruins' : 'themed' }), draft.background !== 'current')}
        {button('My usual background', () => update({ background: 'current' }), draft.background === 'current')}
      </>}
    </View>
  </View>;
  const footer = <View style={{ paddingHorizontal: 16, paddingTop: 12, gap: 8, borderTopWidth: 1, borderColor: t.cardBorder }}>
    {!!error && <Text accessibilityRole="alert" style={{ color: t.red }}>{error}</Text>}
    {!box && <Text style={{ color: t.textDim }}>Pair a box to save a preset. You can still preview every layout.</Text>}
    <View style={{ flexDirection: 'row', gap: 10 }}>
      {detail && <View style={{ flex: 1 }}>{button(saving ? 'Applying…' : 'Apply preset', () => { void apply(); }, true, !box)}</View>}
      {button('Close', onClose)}
    </View>
  </View>;
  if (!detail) return <View style={{ flex: 1 }}>
    <View style={{ padding: 20, gap: 6 }}>
      <Text accessibilityRole="header" style={{ color: t.text, fontSize: 25, fontWeight: '700' }}>Control presets</Text>
      <Text style={{ color: t.textDim, fontSize: 15, lineHeight: 21 }}>Find your layout. Preview it, try the controls, then Apply when it feels right.</Text>
    </View>
    <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 20, maxWidth: 960, width: '100%', alignSelf: 'center' }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
        {PRESET_IDS.map(presetId => {
          const item = presetInfo(presetId), art = backdropAssets(item.backdrop)?.landscape;
          return <Pressable key={presetId} accessibilityRole="button" accessibilityLabel={`Preview ${item.title}`}
            onPress={() => choose(presetId)} style={({ pressed }) => ({ width: '47.8%', flexGrow: 1, minWidth: 140,
              maxWidth: 440, borderWidth: 1, borderColor: saved.id === presetId ? t.blue : t.cardBorder,
              borderRadius: 16, overflow: 'hidden', backgroundColor: t.card, opacity: pressed ? 0.75 : 1 })}>
            <View style={{ aspectRatio: 1.9, backgroundColor: t.bg, justifyContent: 'center', alignItems: 'center' }}>
              {art ? <Image source={art as ImageSourcePropType} resizeMode="cover" style={{ width: '100%', height: '100%' }} />
                : <Text style={{ color: t.blue, fontSize: 38 }} accessibilityElementsHidden>✥  ◉</Text>}
              {saved.id === presetId && <View style={{ position: 'absolute', left: 8, top: 8, borderRadius: 8, padding: 5, backgroundColor: t.bg }}>
                <Text style={{ color: t.blue, fontSize: 11, fontWeight: '700' }}>CURRENT</Text></View>}
            </View>
            <View style={{ padding: 12, gap: 5 }}>
              <Text style={{ color: t.text, fontSize: 16, fontWeight: '700' }}>{item.title}</Text>
              <Text style={{ color: t.textDim, fontSize: 12 }}>{item.kind}{item.beta ? ' · Beta' : ''}</Text>
              <Text style={{ color: t.blue, fontSize: 13, marginTop: 4 }}>Preview →</Text>
            </View>
          </Pressable>;
        })}
      </View>
    </ScrollView>
    {footer}
  </View>;
  return <View style={{ flex: 1 }}>
    <View style={{ paddingHorizontal: 12, paddingVertical: expanded ? 4 : 12, flexDirection: 'row', gap: 8, alignItems: 'center' }}>
      {button('‹ Previous', () => choose(adjacentPreset(id, -1)))}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text accessibilityRole="header" style={{ textAlign: 'center', color: t.text, fontSize: expanded ? 16 : 20, fontWeight: '700' }}>{info.title}</Text>
        {!expanded && <Text style={{ textAlign: 'center', color: t.textDim, fontSize: 12 }}>{info.kind}{info.beta ? ' · Beta' : ''} · {PRESET_IDS.indexOf(id) + 1} / {PRESET_IDS.length}</Text>}
      </View>
      {button('Next ›', () => choose(adjacentPreset(id, 1)))}
    </View>
    {expanded ? <>
      <PadPresetPreview preset={draft} interactive={trying} expanded />
      <ScrollView horizontal style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 8, padding: 8, alignItems: 'center' }}>
        {button(trying ? 'Stop trying' : 'Try controls', () => setTrying(v => !v), trying)}
        <Text style={{ color: t.textDim, fontSize: 12 }}>Local preview only</Text>
        {button('Done previewing', () => { setTrying(false); setExpanded(false); })}
        {options}
      </ScrollView>
    </> : <ScrollView key={id} contentContainerStyle={{ padding: 16, gap: 16, maxWidth: 1000, width: '100%', alignSelf: 'center' }}>
      <PadPresetPreview preset={draft} interactive={trying} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {button('Full-screen preview', () => setExpanded(true))}
        {button(trying ? 'Stop trying' : 'Try controls', () => setTrying(v => !v), trying)}
        {button('All presets', () => { setTrying(false); setDetail(false); })}
      </View>
      <Text style={{ color: trying ? t.blue : t.textDim, fontSize: 14, lineHeight: 21 }}>
        {trying ? 'Touch buttons and move the sticks. Feedback stays on this phone—nothing is sent to your box.' : 'Preview before applying. Open full screen for a closer look, or try the controls here.'}
      </Text>
      {options}
      <Text style={{ color: t.textDim, fontSize: 14, lineHeight: 21 }}>{info.hint}</Text>
      {info.beta && <Text style={{ color: t.amber, fontSize: 13 }}>Beta · Gameplay testing is still in progress. Custom game bindings may change these actions.</Text>}
      <Text style={{ color: t.textDim, fontSize: 13, lineHeight: 19 }}>Applies to full-screen PAD for {box?.name ?? 'your box'} on this phone. Your portrait controls and saved app theme stay as they are.</Text>
    </ScrollView>}
    {footer}
  </View>;
}
