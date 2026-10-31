import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { CUSTOM_OUTPUTS, type CustomOutput } from '@/lib/customPad';
import { GAME_PADS, isGamePadId } from '@/lib/gamePadCatalog';
import { STARDEW_ACTIONS, VAMPIRE_ACTIONS, type PadPreset } from '@/lib/padPresets';
import { useTheme } from '@/lib/theme';

export function CustomPadEditor({ preset, onChange, disabled }: { preset: PadPreset; onChange(p: PadPreset): void; disabled: boolean }) {
  const t = useTheme();
  const [selected, setSelected] = useState<CustomOutput | null>(null);
  const custom = preset.custom!;
  const actions = isGamePadId(preset.id) ? GAME_PADS[preset.id].actions : preset.id === 'stardew' ? STARDEW_ACTIONS : preset.id === 'vampire' ? VAMPIRE_ACTIONS
    : ['a','b','x','y','lt','rt','lb','rb','select','start'].map(key => ({ key, label: key.toUpperCase() }));
  const action = actions.find(a => a.key === selected);
  const binding = selected ? custom.bindings[selected] ?? { output: selected, label: action?.label ?? '' } : null;
  const update = (patch: Partial<typeof custom>) => onChange({ ...preset, custom: { ...custom, ...patch } });
  const button = (title: string, press: () => void, active = false) => <Pressable key={title} accessibilityRole="button" disabled={disabled} onPress={press}
    accessibilityState={{ selected: active, disabled }} style={{ padding: 12, minHeight: 44, borderRadius: 12, borderWidth: 1, borderColor: active ? t.blue : t.cardBorder, backgroundColor: t.card }}>
    <Text style={{ color: active ? t.blue : t.text }}>{title}</Text></Pressable>;
  const inputStyle = { color: t.text, borderColor: t.cardBorder, borderWidth: 1, borderRadius: 12, padding: 14, minHeight: 44, backgroundColor: t.card };
  return <View style={{ gap: 12 }}>
    <Text style={{ color: t.text, fontSize: 20, fontWeight: '700' }}>Customize buttons</Text>
    <TextInput accessibilityLabel="Custom preset name" value={custom.name} maxLength={40} editable={!disabled} onChangeText={name => update({ name })} style={inputStyle} />
    <Text style={{ color: t.textDim }}>Tap a button below to change its controller output and label. Movement, system shortcuts and portrait controls keep their usual behavior. Game bindings still apply. On Current controls, center OK follows the A mapping.</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{actions.map(a => {
      const k = a.key as CustomOutput, b = custom.bindings[k];
      return button(`${a.key.toUpperCase()} → ${(b?.output ?? a.key).toUpperCase()} · ${b?.label ?? a.label}`, () => setSelected(k), selected === k);
    })}</View>
    {selected && binding && <View style={{ padding: 14, gap: 12, backgroundColor: t.card, borderRadius: 16, borderWidth: 1, borderColor: t.blue }}>
      <Text style={{ color: t.text }}>Button position: {selected.toUpperCase()}</Text>
      <TextInput accessibilityLabel="Button label" value={binding.label} maxLength={28} editable={!disabled} style={inputStyle}
        onChangeText={label => update({ bindings: { ...custom.bindings, [selected]: { ...binding, label } } })} />
      <Text style={{ color: t.textDim }}>Sends controller input</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{CUSTOM_OUTPUTS.map(output => button(output.toUpperCase(),
        () => update({ bindings: { ...custom.bindings, [selected]: { ...binding, output } } }), binding.output === output))}</View>
      {button('Restore this button', () => { const bindings = { ...custom.bindings }; delete bindings[selected]; update({ bindings }); })}
    </View>}
    {button('Reset all button mappings', () => update({ bindings: {} }))}
  </View>;
}
