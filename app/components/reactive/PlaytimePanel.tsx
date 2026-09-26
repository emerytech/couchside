/**
 * Per-mode config PANEL for the PLAYTIME countdown. The bar starts full and drains
 * as a personal timer runs down (amber under 15 min, red under 5, a final flash).
 *
 * Unlike a meter, playtime is not applied on every tweak — a config change would
 * restart the timer. Instead you set MINUTES / SCALE / LAYOUT / start colour, then
 * press START (which stamps a fresh deadline on the box). A running countdown shows
 * the live remaining time and a STOP. All controls are taps or tap-settable sliders
 * (harness-pressable, §6).
 */
import React, { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { TrackSlider } from '@/components/TrackSlider';
import {
  api, type ConnSettings, type LedActive, type MeterLayout, type Rgb,
} from '@/lib/api';
import { hapticLight } from '@/lib/haptics';
import { cssRgb, hueToRgb, rgbToHue, HUE_STOPS } from '@/lib/ledColor';
import { useTheme } from '@/lib/theme';
import { reactiveStyles } from '@/components/reactive/styles';

const SCALES: { v: number; label: string }[] = [
  { v: 0, label: 'Timer' }, { v: 1, label: '1h' }, { v: 2, label: '2h' },
  { v: 3, label: '3h' }, { v: 4, label: '4h' },
];
const LAYOUTS: { id: MeterLayout; label: string }[] = [
  { id: 'linear', label: 'Linear' }, { id: 'mirrored', label: 'Mirrored' },
];

const fmt = (s: number) => {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${sec < 10 ? '0' : ''}${sec}`;
};

export function PlaytimePanel(props: {
  settings: ConnSettings;
  strip: string;
  active: LedActive | undefined;
  onApplied: () => void;
}) {
  const { settings, strip, active, onApplied } = props;
  const t = useTheme();
  const styles = reactiveStyles(t);

  const running = active && active.effect === 'playtime' ? active.playtime : undefined;
  const [minutes, setMinutes] = useState(60);
  const [scale, setScale] = useState(0);
  const [layout, setLayout] = useState<MeterLayout>('linear');
  const [hue, setHue] = useState(210);          // a calm start colour by default
  const [busy, setBusy] = useState(false);
  const [nowS, setNowS] = useState(() => Date.now() / 1000);
  const seeded = useRef(false);

  // Seed once from a running countdown.
  useEffect(() => {
    if (seeded.current || !running) return;
    seeded.current = true;
    if (typeof running.minutes === 'number') setMinutes(running.minutes);
    if (typeof running.scale === 'number') setScale(running.scale);
    if (running.layout) setLayout(running.layout);
    if (running.color) setHue(rgbToHue(running.color));
  }, [running]);

  // Tick the live remaining readout once a second while a countdown is running.
  const remaining = running?.deadline ? Math.max(0, running.deadline - nowS) : null;
  useEffect(() => {
    if (remaining === null) return;
    const id = setInterval(() => setNowS(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, [remaining === null]);

  const color: Rgb = hueToRgb(hue);

  const start = async () => {
    if (busy) return;
    hapticLight();
    setBusy(true);
    try {
      await api.setStripEffect(settings, strip, {
        effect: 'playtime', brightness: 100,
        minutes: Math.round(minutes), scale, layout, color,
      });
    } finally { onApplied(); setBusy(false); }
  };

  const stop = async () => {
    if (busy) return;
    hapticLight();
    setBusy(true);
    try {
      await api.setStripEffect(settings, strip, { effect: 'off' });
    } finally { onApplied(); setBusy(false); }
  };

  return (
    <View>
      {remaining !== null && (
        <View style={styles.sliderHeader}>
          <Text style={styles.sectionLabel}>
            {remaining > 0 ? 'RUNNING' : 'DONE'}
          </Text>
          <Text style={[styles.readout, remaining > 0 && remaining <= 300 ? { color: t.red } : null]}>
            {remaining > 0 ? `${fmt(remaining)} left` : 'time up'}
          </Text>
        </View>
      )}

      <View style={styles.sliderHeader}>
        <Text style={styles.sectionLabel}>TIMER</Text>
        <Text style={styles.readout}>{Math.round(minutes)} min</Text>
      </View>
      <TrackSlider value={minutes} min={5} max={240} disabled={busy}
        onChange={setMinutes} onCommit={setMinutes}
        thumbColor={t.blue} accessibilityLabel="Timer minutes"
        renderTrack={(pct) => (
          <View style={styles.track}><View style={[styles.fill, { width: `${pct * 100}%`, backgroundColor: t.blue }]} /></View>
        )} />

      <Text style={styles.sectionLabel}>FULL BAR = </Text>
      <View style={styles.chipRow}>
        {SCALES.map((s) => {
          const on = scale === s.v;
          return (
            <Pressable key={s.v} onPress={() => { hapticLight(); setScale(s.v); }}
              disabled={busy} accessibilityRole="button" accessibilityState={{ selected: on }}
              accessibilityLabel={`Bar scale ${s.label}`}
              style={({ pressed }) => [styles.chip, on && styles.chipOn, pressed && styles.pressed]}>
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
            <Pressable key={l.id} onPress={() => { hapticLight(); setLayout(l.id); }}
              disabled={busy} accessibilityRole="button" accessibilityState={{ selected: on }}
              accessibilityLabel={`Layout ${l.label}`}
              style={({ pressed }) => [styles.chip, on && styles.chipOn, pressed && styles.pressed]}>
              <Text style={[styles.chipText, on && styles.chipTextOn]}>{l.label}</Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.sliderHeader}>
        <Text style={styles.sectionLabel}>START COLOUR</Text>
        <View style={[styles.swatch, { backgroundColor: cssRgb(color) }]} />
      </View>
      <TrackSlider value={hue} min={0} max={360} disabled={busy}
        onChange={setHue} onCommit={setHue}
        thumbColor={cssRgb(color)} accessibilityLabel="Countdown start colour"
        renderTrack={() => (
          <View style={[styles.track, { flexDirection: 'row', padding: 0 }]}>
            {HUE_STOPS.map((c, i) => (<View key={i} style={{ flex: 1, backgroundColor: c }} />))}
          </View>
        )} />

      <View style={[styles.chipRow, { marginTop: 14 }]}>
        <Pressable onPress={start} disabled={busy}
          accessibilityRole="button" accessibilityLabel={remaining !== null ? 'Restart timer' : 'Start timer'}
          style={({ pressed }) => [styles.chip, styles.chipOn, pressed && !busy && styles.pressed]}>
          <Text style={[styles.chipText, styles.chipTextOn]}>
            {remaining !== null ? 'Restart' : 'Start timer'}
          </Text>
        </Pressable>
        {remaining !== null && (
          <Pressable onPress={stop} disabled={busy}
            accessibilityRole="button" accessibilityLabel="Stop timer"
            style={({ pressed }) => [styles.chip, pressed && !busy && styles.pressed]}>
            <Text style={styles.chipText}>Stop</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}
