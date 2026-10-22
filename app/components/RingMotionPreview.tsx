import React, { useEffect, useRef, useState } from 'react';
import { Pressable, Switch, Text, View } from 'react-native';

import { usePoll } from '@/hooks/usePoll';
import {
  api, hostKey, type RingMotionPreview as MotionConfig, type RingMotionState,
} from '@/lib/api';
import { useSettings } from '@/lib/SettingsContext';
import { useTheme } from '@/lib/theme';

const DEFAULT: MotionConfig = {
  effect: 'comet', direction: 'clockwise', color: { r: 0, g: 220, b: 180 },
  colorShift: false, trail: 2, period: 4, brightness: 10,
};
const EFFECTS: { value: MotionConfig['effect']; label: string }[] = [
  { value: 'ball', label: 'Ball' }, { value: 'comet', label: 'Comet' },
  { value: 'bounce', label: 'Between sticks' },
];
const COLORS = [
  { label: 'Teal', value: { r: 0, g: 220, b: 180 } },
  { label: 'Blue', value: { r: 40, g: 100, b: 255 } },
  { label: 'Purple', value: { r: 180, g: 40, b: 255 } },
  { label: 'Orange', value: { r: 255, g: 100, b: 0 } },
];

/** Capability-gated experiment, never a saved effect or an automatic write.
 * The agent owns the ten-second lease, including restoration if the phone
 * disconnects. Unmounting cannot accidentally send a command to another box. */
export function RingMotionPreview() {
  const t = useTheme();
  const { settings } = useSettings();
  const key = hostKey(settings);
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState<MotionConfig>(DEFAULT);
  const [busy, setBusy] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [response, setResponse] = useState<RingMotionState | null>(null);
  const [revision, setRevision] = useState(0);
  const mounted = useRef(false);
  const target = useRef(key);
  const writing = useRef(false);
  target.current = key;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // A successful mutation advances the poll generation: an earlier GET must
  // never replace the start/stop response with stale state.
  const poll = usePoll<RingMotionState>(
    () => api.ringMotion(settings), expanded ? 1000 : 5000, true, `${key}:${revision}`,
  );
  const state = poll.data ?? response;
  const active = state?.active === true;
  const editingDisabled = busy || active;
  const seconds = Math.max(0, Math.min(10, Math.ceil((state?.remaining_ms ?? 0) / 1000)));
  const error = operationError ?? state?.error
    ?? (poll.error ? 'Cannot check the rings. Check the box connection and try again.' : null);

  const send = async (stop: boolean) => {
    if (writing.current) return;
    writing.current = true;
    const sentTo = key;
    const connection = settings;
    setBusy(true);
    setOperationError(null);
    try {
      const result = await api.setRingMotion(connection, stop ? { stop: true } : { preview: draft });
      if (!mounted.current || target.current !== sentTo) return;
      setResponse(result);
      setRevision(value => value + 1);
    } catch {
      if (!mounted.current || target.current !== sentTo) return;
      setOperationError(stop
        ? 'Could not confirm Stop. The box still ends the preview automatically after 10 seconds.'
        : 'Could not confirm the preview. Check the box connection before trying again.');
      poll.refresh();
    } finally {
      if (mounted.current && target.current === sentTo) {
        writing.current = false;
        setBusy(false);
      }
    }
  };

  const choice = (label: string, selected: boolean, onPress: () => void, swatch?: string) => (
    <Pressable key={label} accessibilityRole="button" disabled={editingDisabled}
      accessibilityState={{ selected, disabled: editingDisabled }} onPress={onPress}
      style={{ paddingHorizontal: 12, paddingVertical: 11, borderRadius: 12, flexDirection: 'row', alignItems: 'center', gap: 8,
        backgroundColor: selected ? t.blue : t.bg, opacity: editingDisabled ? 0.5 : 1 }}>
      {swatch && <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: swatch,
        borderWidth: 1, borderColor: selected ? t.onAccent : t.textDim }} />}
      <Text style={{ color: selected ? t.onAccent : t.text }}>{label}</Text>
    </Pressable>
  );
  const heading = <Pressable accessibilityRole="button" accessibilityState={{ expanded }}
    onPress={() => setExpanded(value => !value)} style={{ paddingVertical: 8 }}>
    <Text style={{ color: t.blue, fontWeight: '700' }}>Ring motion preview {expanded ? '▴' : '▾'}</Text>
    {!expanded && <Text style={{ color: t.textDim }}>
      {active ? 'Preview running · restores after 10 seconds' : 'Try a spinning ball, comet, or a hop between sticks'}
    </Text>}
  </Pressable>;

  if (!expanded) return heading;
  return <View style={{ gap: 12, paddingVertical: 8 }}>
    {heading}
    <Text style={{ color: t.textDim }}>
      A dim, 10-second test at up to 20% brightness. Your previous lighting returns automatically. Nothing is saved.
    </Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {EFFECTS.map(({ value, label }) => choice(label, draft.effect === value,
        () => setDraft({ ...draft, effect: value, trail: value === 'ball' ? 0 : (draft.trail || 2) })))}
    </View>
    <Text style={{ color: t.textDim }}>Direction</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {choice('Clockwise', draft.direction === 'clockwise', () => setDraft({ ...draft, direction: 'clockwise' }))}
      {choice('Counterclockwise', draft.direction === 'counterclockwise', () => setDraft({ ...draft, direction: 'counterclockwise' }))}
    </View>
    {draft.effect !== 'ball' && <>
      <Text style={{ color: t.textDim }}>Trail · LEDs behind the light</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {[0, 1, 2, 3, 4].map(trail => choice(trail === 0 ? 'No trail' : String(trail), draft.trail === trail,
          () => setDraft({ ...draft, trail })))}
      </View>
    </>}
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <Text style={{ color: t.text }}>Shift through colors</Text>
      <Switch accessibilityLabel="Shift through colors" value={draft.colorShift} disabled={editingDisabled}
        onValueChange={colorShift => setDraft({ ...draft, colorShift })} />
    </View>
    {!draft.colorShift && <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {COLORS.map(({ label, value }) => choice(label,
        draft.color.r === value.r && draft.color.g === value.g && draft.color.b === value.b,
        () => setDraft({ ...draft, color: value }), `rgb(${value.r},${value.g},${value.b})`))}
    </View>}
    <Text style={{ color: t.textDim }}>Full motion cycle</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {[2, 4, 8].map(period => choice(`${period}s`, draft.period === period,
        () => setDraft({ ...draft, period })))}
    </View>
    <Text style={{ color: t.textDim }}>Preview brightness</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {[5, 10, 20].map(brightness => choice(`${brightness}%`, draft.brightness === brightness,
        () => setDraft({ ...draft, brightness })))}
    </View>
    <Text accessibilityLiveRegion="polite" style={{ color: error ? t.amber : t.textDim }}>
      {error ?? (active ? `Preview running · ${seconds > 0 ? `${seconds}s remaining` : 'restoring lighting…'}`
        : !state ? 'Checking ring controls…'
        : !state.available ? 'Ring preview is unavailable on this box right now.' : 'Ready for a 10-second preview.')}
    </Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      <Pressable accessibilityRole="button" disabled={busy || active || !state?.available || !!poll.error}
        accessibilityState={{ disabled: busy || active || !state?.available || !!poll.error }}
        onPress={() => { void send(false); }}
        style={{ padding: 14, borderRadius: 12, backgroundColor: t.blue,
          opacity: busy || active || !state?.available || poll.error ? 0.5 : 1 }}>
        <Text style={{ color: t.onAccent, fontWeight: '700' }}>{busy ? 'Sending…' : 'Try for 10 seconds'}</Text>
      </Pressable>
      <Pressable accessibilityRole="button" disabled={busy || (!active && !operationError)}
        accessibilityState={{ disabled: busy || (!active && !operationError) }}
        onPress={() => { void send(true); }}
        style={{ padding: 14, borderRadius: 12, backgroundColor: t.bg,
          opacity: busy || (!active && !operationError) ? 0.5 : 1 }}>
        <Text style={{ color: t.text }}>Stop &amp; restore</Text>
      </Pressable>
    </View>
  </View>;
}
