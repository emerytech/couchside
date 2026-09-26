/**
 * REACTIVE (LIGHT STRIP) — the strip renders LIVE telemetry instead of a static
 * look: `meter_cpu` = a CPU-load bar coloured by temperature; `meter_battery` = a
 * charge gauge. The box drives it on its own render thread, so it keeps going with
 * the app closed and survives a reboot — SignalBar's "the bar is useful" idea.
 *
 * Probe-and-appear: this whole section renders ONLY when the agent advertised a
 * `reactive.meters` list (see StripLightCard), so an older agent shows nothing.
 * The meters offered are exactly the ones the box said it can drive right now (a
 * box with no battery never offers meter_battery).
 *
 * Controls are all TAPS (meter / smoothing / layout chips) or the shared
 * PanResponder sliders (Cool/Hot temp, low-battery threshold) — a tap sets those
 * too, so the web harness can press every one (§6). Cool is clamped below Hot so a
 * commit can never send the inverted pair the agent rejects (400).
 */
import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { TrackSlider } from '@/components/TrackSlider';
import {
  api, type ConnSettings, type LedActive, type LedEffect,
  type MeterLayout, type MeterSmooth,
} from '@/lib/api';
import { hapticLight } from '@/lib/haptics';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

const METER_LABEL: Partial<Record<LedEffect, string>> = {
  meter_cpu: 'CPU', meter_battery: 'Battery',
};
const SMOOTHS: { id: MeterSmooth; label: string }[] = [
  { id: 'responsive', label: 'Responsive' },
  { id: 'balanced', label: 'Balanced' },
  { id: 'smooth', label: 'Smooth' },
];
const LAYOUTS: { id: MeterLayout; label: string }[] = [
  { id: 'linear', label: 'Linear' },
  { id: 'mirrored', label: 'Mirrored' },
];

const isMeter = (e?: LedEffect): e is 'meter_cpu' | 'meter_battery' =>
  e === 'meter_cpu' || e === 'meter_battery';

export function ReactiveMeterControls(props: {
  settings: ConnSettings;
  strip: string;
  meters: LedEffect[];
  active: LedActive | undefined;
  onApplied: () => void;
}) {
  const { settings, strip, meters, active, onApplied } = props;
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);

  const running = active && isMeter(active.effect) ? active.effect : null;
  const [meter, setMeter] = useState<LedEffect | null>(running);
  const [smooth, setSmooth] = useState<MeterSmooth>('balanced');
  const [layout, setLayout] = useState<MeterLayout>('linear');
  const [cool, setCool] = useState(45);
  const [hot, setHot] = useState(78);
  const [low, setLow] = useState(20);
  const [busy, setBusy] = useState(false);
  const seeded = useRef(false);

  // Seed the controls once from the meter the box already runs (if any).
  useEffect(() => {
    if (seeded.current || !running) return;
    seeded.current = true;
    setMeter(running);
    const m = active?.meter;
    if (m?.smooth) setSmooth(m.smooth);
    if (m?.layout) setLayout(m.layout);
    if (typeof m?.cool === 'number') setCool(m.cool);
    if (typeof m?.hot === 'number') setHot(m.hot);
    if (typeof m?.low === 'number') setLow(m.low);
  }, [running, active]);

  /** Apply the current meter + config to the strip, then re-read. `over` lets a
   *  control apply its brand-new value in the same tick (setState is async). */
  const apply = async (over: Partial<{
    meter: LedEffect; smooth: MeterSmooth; layout: MeterLayout;
    cool: number; hot: number; low: number;
  }>) => {
    const m = over.meter ?? meter;
    if (!m || busy) return;
    // Keep cool strictly below hot so the agent never 400s on an inverted pair.
    let c = Math.round(over.cool ?? cool);
    let h = Math.round(over.hot ?? hot);
    if (c >= h) {
      if (over.cool !== undefined) c = h - 1;
      else h = c + 1;
    }
    hapticLight();
    setBusy(true);
    try {
      await api.setStripEffect(settings, strip, {
        effect: m, brightness: 100,
        smooth: over.smooth ?? smooth, layout: over.layout ?? layout,
        ...(m === 'meter_cpu' ? { cool: c, hot: h } : {}),
        ...(m === 'meter_battery' ? { low: Math.round(over.low ?? low) } : {}),
      });
    } finally {
      onApplied();
      setBusy(false);
    }
  };

  const cpu = meter === 'meter_cpu';
  const batt = meter === 'meter_battery';

  return (
    <View>
      <Text style={styles.sectionLabel}>REACTIVE</Text>
      <Text style={styles.hint}>The bar shows live box stats — keeps going with the app closed.</Text>

      {/* METER picker — only the meters the box offered. */}
      <View style={styles.chipRow}>
        {meters.map((id) => {
          const on = meter === id;
          return (
            <Pressable
              key={id}
              onPress={() => { setMeter(id); void apply({ meter: id }); }}
              disabled={busy}
              accessibilityRole="button"
              accessibilityState={{ selected: on, disabled: busy }}
              accessibilityLabel={`Meter ${METER_LABEL[id] ?? id}`}
              style={({ pressed }) => [styles.chip, on && styles.chipOn, pressed && !busy && styles.pressed]}>
              <Text style={[styles.chipText, on && styles.chipTextOn]}>{METER_LABEL[id] ?? id}</Text>
            </Pressable>
          );
        })}
      </View>

      {meter && (
        <>
          {/* SMOOTHING — how quickly the bar reacts. */}
          <Text style={styles.sectionLabel}>SMOOTHING</Text>
          <View style={styles.chipRow}>
            {SMOOTHS.map((s) => {
              const on = smooth === s.id;
              return (
                <Pressable
                  key={s.id}
                  onPress={() => { setSmooth(s.id); void apply({ smooth: s.id }); }}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on, disabled: busy }}
                  accessibilityLabel={`Smoothing ${s.label}`}
                  style={({ pressed }) => [styles.chip, on && styles.chipOn, pressed && !busy && styles.pressed]}>
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>{s.label}</Text>
                </Pressable>
              );
            })}
          </View>

          {/* LAYOUT — fill from one end, or mirrored from the centre. */}
          <Text style={styles.sectionLabel}>LAYOUT</Text>
          <View style={styles.chipRow}>
            {LAYOUTS.map((l) => {
              const on = layout === l.id;
              return (
                <Pressable
                  key={l.id}
                  onPress={() => { setLayout(l.id); void apply({ layout: l.id }); }}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on, disabled: busy }}
                  accessibilityLabel={`Layout ${l.label}`}
                  style={({ pressed }) => [styles.chip, on && styles.chipOn, pressed && !busy && styles.pressed]}>
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>{l.label}</Text>
                </Pressable>
              );
            })}
          </View>

          {/* CPU meter: the temperature colour range (Cool → Hot, °C). */}
          {cpu && (
            <>
              <View style={styles.sliderHeader}>
                <Text style={styles.sectionLabel}>COOL TEMP</Text>
                <Text style={styles.readout}>{Math.round(cool)}°C</Text>
              </View>
              <TrackSlider
                value={cool} min={0} max={110} disabled={busy}
                onChange={(v) => setCool(Math.min(v, hot - 1))}
                onCommit={(v) => void apply({ cool: Math.min(v, hot - 1) })}
                thumbColor={t.blue} accessibilityLabel="Cool temperature threshold"
                renderTrack={(pct) => (
                  <View style={styles.track}><View style={[styles.fill, { width: `${pct * 100}%`, backgroundColor: t.blue }]} /></View>
                )}
              />
              <View style={styles.sliderHeader}>
                <Text style={styles.sectionLabel}>HOT TEMP</Text>
                <Text style={styles.readout}>{Math.round(hot)}°C</Text>
              </View>
              <TrackSlider
                value={hot} min={10} max={120} disabled={busy}
                onChange={(v) => setHot(Math.max(v, cool + 1))}
                onCommit={(v) => void apply({ hot: Math.max(v, cool + 1) })}
                thumbColor={t.red} accessibilityLabel="Hot temperature threshold"
                renderTrack={(pct) => (
                  <View style={styles.track}><View style={[styles.fill, { width: `${pct * 100}%`, backgroundColor: t.red }]} /></View>
                )}
              />
            </>
          )}

          {/* Battery meter: the low-battery warning threshold. */}
          {batt && (
            <>
              <View style={styles.sliderHeader}>
                <Text style={styles.sectionLabel}>LOW BATTERY</Text>
                <Text style={styles.readout}>{Math.round(low)}%</Text>
              </View>
              <TrackSlider
                value={low} min={5} max={50} disabled={busy}
                onChange={setLow}
                onCommit={(v) => void apply({ low: v })}
                thumbColor={t.red} accessibilityLabel="Low battery threshold"
                renderTrack={(pct) => (
                  <View style={styles.track}><View style={[styles.fill, { width: `${pct * 100}%`, backgroundColor: t.red }]} /></View>
                )}
              />
            </>
          )}
        </>
      )}
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    sectionLabel: {
      color: t.textFaint, fontSize: 10, fontWeight: '700', letterSpacing: 1.2,
      fontFamily: mono, marginTop: 14, marginBottom: 8,
    },
    hint: { color: t.textFaint, fontSize: 11, fontFamily: mono, marginBottom: 4 },
    sliderHeader: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
    readout: { color: t.textDim, fontSize: 11, fontFamily: mono, marginBottom: 2 },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    chip: {
      borderColor: t.cardBorder, borderWidth: 1, borderRadius: 999,
      paddingVertical: 6, paddingHorizontal: 12,
    },
    chipOn: { borderColor: t.blue, backgroundColor: t.card },
    chipText: { color: t.textDim, fontSize: 12, fontFamily: mono },
    chipTextOn: { color: t.text, fontWeight: '700' },
    pressed: { opacity: 0.6 },
    track: {
      height: 18, borderRadius: 9, backgroundColor: t.card, overflow: 'hidden',
      borderWidth: StyleSheet.hairlineWidth, borderColor: t.cardBorder,
    },
    fill: { height: '100%', borderRadius: 9 },
  });
