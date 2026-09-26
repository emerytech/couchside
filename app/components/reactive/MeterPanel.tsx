/**
 * Per-mode config PANEL for a reactive METER (meter_cpu / meter_battery). One of
 * the panels the ReactiveModeControls host swaps in when its mode is picked —
 * adding a new reactive mode is a new panel like this, not more StripLightCard.
 *
 * SMOOTHING + LAYOUT are taps; Cool/Hot (CPU) and low-battery (Battery) are the
 * shared PanResponder sliders (a tap sets them too, so the harness can press them,
 * §6). Cool is clamped below Hot so a commit can never send the inverted pair the
 * agent rejects (400). Every change POSTs then re-reads via `onApplied`.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { TrackSlider } from '@/components/TrackSlider';
import {
  api, type ConnSettings, type LedActive, type LedEffect,
  type MeterLayout, type MeterSmooth,
} from '@/lib/api';
import { hapticLight } from '@/lib/haptics';
import { useTheme } from '@/lib/theme';
import { reactiveStyles } from '@/components/reactive/styles';

const SMOOTHS: { id: MeterSmooth; label: string }[] = [
  { id: 'responsive', label: 'Responsive' },
  { id: 'balanced', label: 'Balanced' },
  { id: 'smooth', label: 'Smooth' },
];
const LAYOUTS: { id: MeterLayout; label: string }[] = [
  { id: 'linear', label: 'Linear' },
  { id: 'mirrored', label: 'Mirrored' },
];

export function MeterPanel(props: {
  settings: ConnSettings;
  strip: string;
  kind: 'meter_cpu' | 'meter_battery';
  active: LedActive | undefined;
  onApplied: () => void;
}) {
  const { settings, strip, kind, active, onApplied } = props;
  const t = useTheme();
  const styles = reactiveStyles(t);

  const [smooth, setSmooth] = useState<MeterSmooth>('balanced');
  const [layout, setLayout] = useState<MeterLayout>('linear');
  const [cool, setCool] = useState(45);
  const [hot, setHot] = useState(78);
  const [low, setLow] = useState(20);
  const [busy, setBusy] = useState(false);
  const seeded = useRef<string | null>(null);

  // Seed from the running meter's config, once per selected kind.
  useEffect(() => {
    if (seeded.current === kind) return;
    seeded.current = kind;
    const m = active && active.effect === kind ? active.meter : undefined;
    if (m?.smooth) setSmooth(m.smooth);
    if (m?.layout) setLayout(m.layout);
    if (typeof m?.cool === 'number') setCool(m.cool);
    if (typeof m?.hot === 'number') setHot(m.hot);
    if (typeof m?.low === 'number') setLow(m.low);
  }, [kind, active]);

  const apply = async (over: Partial<{
    smooth: MeterSmooth; layout: MeterLayout; cool: number; hot: number; low: number;
  }>) => {
    if (busy) return;
    let c = Math.round(over.cool ?? cool);
    let h = Math.round(over.hot ?? hot);
    if (c >= h) { if (over.cool !== undefined) c = h - 1; else h = c + 1; }
    hapticLight();
    setBusy(true);
    try {
      await api.setStripEffect(settings, strip, {
        effect: kind, brightness: 100,
        smooth: over.smooth ?? smooth, layout: over.layout ?? layout,
        ...(kind === 'meter_cpu' ? { cool: c, hot: h } : {}),
        ...(kind === 'meter_battery' ? { low: Math.round(over.low ?? low) } : {}),
      });
    } finally { onApplied(); setBusy(false); }
  };

  return (
    <View>
      <Text style={styles.sectionLabel}>SMOOTHING</Text>
      <View style={styles.chipRow}>
        {SMOOTHS.map((s) => {
          const on = smooth === s.id;
          return (
            <Pressable key={s.id} onPress={() => { setSmooth(s.id); void apply({ smooth: s.id }); }}
              disabled={busy} accessibilityRole="button" accessibilityState={{ selected: on, disabled: busy }}
              accessibilityLabel={`Smoothing ${s.label}`}
              style={({ pressed }) => [styles.chip, on && styles.chipOn, pressed && !busy && styles.pressed]}>
              <Text style={[styles.chipText, on && styles.chipTextOn]}>{s.label}</Text>
            </Pressable>
          );
        })}
      </View>

      <Text style={styles.sectionLabel}>LAYOUT</Text>
      <View style={styles.chipRow}>
        {LAYOUTS.map((l) => {
          const on = layout === l.id;
          return (
            <Pressable key={l.id} onPress={() => { setLayout(l.id); void apply({ layout: l.id }); }}
              disabled={busy} accessibilityRole="button" accessibilityState={{ selected: on, disabled: busy }}
              accessibilityLabel={`Layout ${l.label}`}
              style={({ pressed }) => [styles.chip, on && styles.chipOn, pressed && !busy && styles.pressed]}>
              <Text style={[styles.chipText, on && styles.chipTextOn]}>{l.label}</Text>
            </Pressable>
          );
        })}
      </View>

      {kind === 'meter_cpu' && (
        <>
          <View style={styles.sliderHeader}>
            <Text style={styles.sectionLabel}>COOL TEMP</Text>
            <Text style={styles.readout}>{Math.round(cool)}°C</Text>
          </View>
          <TrackSlider value={cool} min={0} max={110} disabled={busy}
            onChange={(v) => setCool(Math.min(v, hot - 1))}
            onCommit={(v) => void apply({ cool: Math.min(v, hot - 1) })}
            thumbColor={t.blue} accessibilityLabel="Cool temperature threshold"
            renderTrack={(pct) => (
              <View style={styles.track}><View style={[styles.fill, { width: `${pct * 100}%`, backgroundColor: t.blue }]} /></View>
            )} />
          <View style={styles.sliderHeader}>
            <Text style={styles.sectionLabel}>HOT TEMP</Text>
            <Text style={styles.readout}>{Math.round(hot)}°C</Text>
          </View>
          <TrackSlider value={hot} min={10} max={120} disabled={busy}
            onChange={(v) => setHot(Math.max(v, cool + 1))}
            onCommit={(v) => void apply({ hot: Math.max(v, cool + 1) })}
            thumbColor={t.red} accessibilityLabel="Hot temperature threshold"
            renderTrack={(pct) => (
              <View style={styles.track}><View style={[styles.fill, { width: `${pct * 100}%`, backgroundColor: t.red }]} /></View>
            )} />
        </>
      )}

      {kind === 'meter_battery' && (
        <>
          <View style={styles.sliderHeader}>
            <Text style={styles.sectionLabel}>LOW BATTERY</Text>
            <Text style={styles.readout}>{Math.round(low)}%</Text>
          </View>
          <TrackSlider value={low} min={5} max={50} disabled={busy}
            onChange={setLow} onCommit={(v) => void apply({ low: v })}
            thumbColor={t.red} accessibilityLabel="Low battery threshold"
            renderTrack={(pct) => (
              <View style={styles.track}><View style={[styles.fill, { width: `${pct * 100}%`, backgroundColor: t.red }]} /></View>
            )} />
        </>
      )}
    </View>
  );
}
