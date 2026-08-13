/**
 * LIGHT STRIP (Console tab) — an ADDRESSABLE kernel-LED strip (e.g. the Steam
 * Machine's `valve-leds[0..16]`), grouped into ONE target instead of a chip per
 * node. Owner ask 2026-08-13: per-LED addressable but easy; a night-rider that
 * actually sweeps AND keeps sweeping with the app closed.
 *
 * TWO drive modes:
 *  - AGENT (agent >= 2.9.85 reports the strip in `strips`): effects run in the
 *    box's FIRMWARE — one POST sets `scanner`→patrol / `rainbow` / `breathe`, and
 *    the strip animates on its own, surviving app-close / phone-off / reboot. This
 *    is the right architecture: the driver lives on the agent, the app controls it.
 *  - APP fallback (older agent): the app sweeps the dot itself via /api/leds/set
 *    (works, but throttles when backgrounded — the exact bug the agent path fixes).
 *
 * Solid/Off/paint go per-LED via /api/leds/set so a Solid strip is a paintable
 * customizer. Renders nothing unless a strip is detected (lib/ledStrip).
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { TrackSlider } from '@/components/TrackSlider';
import { usePoll } from '@/hooks/usePoll';
import { api, hostKey, type LedEffect, type LedsState, type Rgb } from '@/lib/api';
import { hapticLight } from '@/lib/haptics';
import { cssRgb, hexRgb, hueToRgb, rgbToHue, HUE_STOPS } from '@/lib/ledColor';
import { addPreset, removePreset, useLedPresets, type LedPreset } from '@/lib/ledPresets';
import { detectStrips, type LedStrip } from '@/lib/ledStrip';
import { useSkinKit } from '@/lib/skin';
import { useSettings } from '@/lib/SettingsContext';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

const POLL_MS = 15000;

type StripEffect = 'solid' | 'off' | 'scanner' | 'rainbow' | 'breathe';
const EFFECTS: { id: StripEffect; label: string }[] = [
  { id: 'solid', label: 'Solid' },
  { id: 'off', label: 'Off' },
  { id: 'scanner', label: 'Scanner' },
  { id: 'rainbow', label: 'Rainbow' },
  { id: 'breathe', label: 'Breathe' },
];
const SPEEDS = [
  { label: 'Slow', pct: 25, ms: 150 },
  { label: 'Med', pct: 55, ms: 90 },
  { label: 'Fast', pct: 90, ms: 55 },
];
const scale = (c: Rgb, f: number): Rgb => ({
  r: Math.round(c.r * f), g: Math.round(c.g * f), b: Math.round(c.b * f),
});

/** Friendly name for a known device so the customizer reads as "your box". */
function stripDeviceLabel(prefix: string): string {
  if (prefix.startsWith('valve-leds')) return 'Steam Machine strip';
  return prefix.replace(/[:_-]+$/, '');
}

/** One frame of the APP-driven fallback animation (only used on old agents). */
function computeFrame(effect: StripEffect, n: number, t: number, color: Rgb): (Rgb | null)[] {
  const period = (n - 1) * 2 || 1;
  const cyc = t % period;
  const pos = cyc < n - 1 ? cyc : period - cyc;
  return Array.from({ length: n }, (_, i) => {
    const f = Math.max(0, 1 - Math.abs(i - pos) / 1.7);
    return f > 0.06 ? scale(color, f) : null;
  });
}
const sameCell = (a: Rgb | null, b: Rgb | null) =>
  (!a && !b) || (!!a && !!b && a.r === b.r && a.g === b.g && a.b === b.b);

export function StripLightCard() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { Card } = useSkinKit();
  const { settings, ready } = useSettings();
  const configured = !!settings.host && !!settings.token;
  const presets = useLedPresets();

  const [selKey, setSelKey] = useState<string | null>(null);
  const [effect, setEffect] = useState<StripEffect>('solid');
  const [hue, setHue] = useState(0);
  const [bright, setBright] = useState(100);
  const [speedPct, setSpeedPct] = useState(55);
  const [frame, setFrame] = useState<(Rgb | null)[]>([]);
  const [busy, setBusy] = useState(false);

  const poll = usePoll<LedsState | null>(
    () => api.leds(settings), POLL_MS, ready && configured, hostKey(settings));

  const leds = (poll.data?.leds ?? []).filter((l) => l.notable && l.writable);
  const { strips } = detectStrips(leds);
  const strip: LedStrip | undefined = strips.find((s) => s.key === selKey) ?? strips[0];
  // Does the AGENT own this strip (firmware effects)? Match by prefix.
  const agentStrip = strip
    ? (poll.data?.strips ?? []).find((s) => strip.key === `strip:${s.prefix}`)
    : undefined;
  const agentMode = !!agentStrip;

  const colorRef = useRef<Rgb>({ r: 255, g: 0, b: 0 });
  const brightRef = useRef(100);
  colorRef.current = hueToRgb(hue);
  brightRef.current = bright;

  const seeded = useRef<string | null>(null);
  useEffect(() => {
    if (!strip) return;
    if (seeded.current === strip.key) return;
    seeded.current = strip.key;
    setFrame(strip.leds.map((l) => (l.brightness_pct > 0 ? l.color : null)));
    const a = strip && poll.data?.active?.[`strip:${agentStrip?.prefix}`];
    if (a) { setEffect(a.effect as StripEffect); setBright(a.brightness); if (a.color) setHue(rgbToHue(a.color)); }
    else {
      const lit = strip.leds.find((l) => l.color && l.brightness_pct > 0);
      if (lit?.color) setHue(rgbToHue(lit.color));
    }
  }, [strip, agentStrip, poll.data]);

  // APP-driven fallback animation (old agents only). No-op in agent mode.
  useEffect(() => {
    if (agentMode || !strip || (effect !== 'scanner')) return;
    const n = strip.leds.length;
    let tick = 0;
    let first = true;
    let last: (Rgb | null)[] = new Array(n).fill(null);
    const ms = SPEEDS.find((s) => s.pct === speedPct)?.ms ?? 90;
    const timer = setInterval(() => {
      const next = computeFrame(effect, n, tick, colorRef.current);
      const b = Math.round(brightRef.current);
      for (let i = 0; i < n; i++) {
        if (first || !sameCell(next[i], last[i])) {
          const cell = next[i];
          void api.setLed(settings, strip.leds[i].name, cell ? { color: cell, brightness: b } : { brightness: 0 });
        }
      }
      setFrame(next); last = next; first = false; tick++;
    }, ms);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentMode, effect, strip?.key, speedPct]);

  if (!poll.data || strips.length === 0 || !strip) return null;

  const color = hueToRgb(hue);
  const animated = effect === 'scanner' || effect === 'rainbow' || effect === 'breathe';
  const shown = agentMode
    ? EFFECTS
    : EFFECTS.filter((e) => e.id === 'solid' || e.id === 'off' || e.id === 'scanner');

  /** Apply an effect. Agent mode = one POST, the box animates. */
  const applyEffect = async (e: StripEffect) => {
    hapticLight();
    setEffect(e);
    if (agentMode && agentStrip) {
      setBusy(true);
      try {
        await api.setStripEffect(settings, agentStrip.prefix, {
          effect: e as LedEffect, brightness: Math.round(bright),
          ...(animated || e !== 'off' ? { speed: Math.round(speedPct) } : {}),
          ...(e === 'rainbow' ? {} : { color }),
        });
      } finally { await poll.refresh(); setBusy(false); }
      return;
    }
    // App fallback: solid/off fill immediately; scanner runs the loop above.
    if (e === 'solid' || e === 'off') {
      const b = Math.round(bright);
      strip.leds.forEach((l) => void api.setLed(settings, l.name, e === 'off' ? { brightness: 0 } : { color, brightness: b }));
      setFrame(strip.leds.map(() => (e === 'off' ? null : color)));
    }
  };

  /** Re-apply the current colour/brightness — for a solid strip, or to re-arm an
   *  agent effect with the tweaked colour/speed (slider/speed commit). */
  const reapply = () => {
    if (agentMode && agentStrip && effect !== 'off') {
      void api.setStripEffect(settings, agentStrip.prefix, {
        effect: effect as LedEffect, brightness: Math.round(bright),
        speed: Math.round(speedPct), ...(effect === 'rainbow' ? {} : { color }),
      });
      return;
    }
    if (effect === 'solid') {
      const b = Math.round(bright);
      strip.leds.forEach((l) => void api.setLed(settings, l.name, { color, brightness: b }));
      setFrame(strip.leds.map(() => color));
    }
  };

  /** Paint one cell — a per-LED customizer (best in Solid). */
  const paintCell = (i: number) => {
    hapticLight();
    void api.setLed(settings, strip.leds[i].name, { color, brightness: Math.round(bright) });
    setFrame((f) => { const c = f.slice(); c[i] = color; return c; });
  };

  /** Coerce any saved preset effect to one the strip runs. */
  const toStripEffect = (e: LedEffect): StripEffect =>
    (EFFECTS.some((x) => x.id === e) ? e : 'breathe') as StripEffect;
  const nearestSpeed = (p: number) =>
    SPEEDS.reduce((b, s) => (Math.abs(s.pct - p) < Math.abs(b - p) ? s.pct : b), 55);

  const applyPreset = (p: LedPreset) => {
    hapticLight();
    const e = toStripEffect(p.effect);
    const h = p.color ? rgbToHue(p.color) : hue;
    setEffect(e); setHue(h); setBright(p.brightness); setSpeedPct(nearestSpeed(p.speed));
    if (agentMode && agentStrip) {
      void api.setStripEffect(settings, agentStrip.prefix, {
        effect: e as LedEffect, brightness: p.brightness, speed: p.speed,
        ...(e === 'rainbow' ? {} : { color: p.color ?? hueToRgb(h) }),
      }).then(() => poll.refresh());
    } else {
      void applyEffect(e);
    }
  };

  const saveCurrent = () => {
    hapticLight();
    const label = EFFECTS.find((x) => x.id === effect)?.label ?? 'Look';
    const usesColor = effect !== 'rainbow' && effect !== 'off';
    void addPreset({
      label: label + (usesColor ? ` ${hexRgb(color)}` : ''),
      effect: effect as LedEffect, color: usesColor ? color : null,
      speed: Math.round(speedPct), brightness: Math.round(bright),
    });
  };

  const confirmDelete = (p: LedPreset) =>
    Alert.alert('Delete preset', `Remove "${p.label}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => void removePreset(p.id) },
    ]);

  return (
    <Card index={7}>
      <View style={styles.header}>
        <Text style={styles.cardTitle}>LIGHT STRIP</Text>
        <View style={styles.headerRight}>
          <Text style={styles.count}>{stripDeviceLabel(agentStrip?.prefix ?? strip.key)} · {strip.leds.length}</Text>
          <Pressable
            onPress={() => { hapticLight(); poll.refresh(); }}
            hitSlop={10} accessibilityRole="button" accessibilityLabel="Refresh strip"
            style={({ pressed }) => [styles.refreshBtn, pressed && styles.pressed]}>
            <Ionicons name="refresh" size={13} color={t.textDim} />
          </Pressable>
        </View>
      </View>

      {/* The strip as ONE row (matches the single physical line) — tap a cell to
          paint it. Cells flex to share the width so 17 fit without wrapping. */}
      <View style={styles.strip}>
        {strip.leds.map((l, i) => {
          const c = frame[i] ?? null;
          return (
            <Pressable
              key={l.name} onPress={() => paintCell(i)} style={styles.cellWrap}
              accessibilityRole="button" accessibilityLabel={`Paint LED ${i}`}>
              {({ pressed }) => (
                <View style={[styles.cell, { backgroundColor: c ? cssRgb(c) : t.card },
                  pressed && styles.pressed]} />
              )}
            </Pressable>
          );
        })}
      </View>

      {/* EFFECT chips. */}
      <Text style={styles.sectionLabel}>EFFECT</Text>
      <View style={styles.chipRow}>
        {shown.map((e) => {
          const on = effect === e.id;
          return (
            <Pressable
              key={e.id} onPress={() => void applyEffect(e.id)} disabled={busy}
              accessibilityRole="button" accessibilityState={{ selected: on, disabled: busy }}
              accessibilityLabel={`Effect ${e.label}`}
              style={({ pressed }) => [styles.chip, on && styles.chipOn, pressed && !busy && styles.pressed]}>
              <Text style={[styles.chipText, on && styles.chipTextOn]}>{e.label}</Text>
            </Pressable>
          );
        })}
      </View>

      {/* SPEED — animated effects only. */}
      {animated && (
        <>
          <Text style={styles.sectionLabel}>SPEED</Text>
          <View style={styles.chipRow}>
            {SPEEDS.map((s) => {
              const on = speedPct === s.pct;
              return (
                <Pressable
                  key={s.label} onPress={() => { hapticLight(); setSpeedPct(s.pct); if (agentMode) reapply(); }}
                  accessibilityRole="button" accessibilityState={{ selected: on }}
                  accessibilityLabel={`Speed ${s.label}`}
                  style={({ pressed }) => [styles.chip, on && styles.chipOn, pressed && styles.pressed]}>
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>{s.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </>
      )}

      {/* COLOUR — hidden for rainbow (its own hues) and off. */}
      {strip.rgb && effect !== 'rainbow' && effect !== 'off' && (
        <>
          <View style={styles.sliderHeader}>
            <Text style={styles.sectionLabel}>COLOUR</Text>
            <View style={[styles.swatchPreview, { backgroundColor: cssRgb(color) }]} />
          </View>
          <TrackSlider
            value={hue} min={0} max={360} onChange={setHue} onCommit={reapply}
            thumbColor={cssRgb(color)} accessibilityLabel="Strip colour hue"
            renderTrack={() => (
              <View style={styles.hueFill}>
                {HUE_STOPS.map((c, i) => (<View key={i} style={{ flex: 1, backgroundColor: c }} />))}
              </View>
            )}
          />
        </>
      )}

      {/* BRIGHTNESS — unless off. */}
      {effect !== 'off' && (
        <>
          <Text style={styles.sectionLabel}>BRIGHTNESS</Text>
          <TrackSlider
            value={bright} min={0} max={100} onChange={setBright} onCommit={reapply}
            thumbColor={t.text} accessibilityLabel="Strip brightness"
            renderTrack={(pct) => (
              <View style={styles.brightTrack}>
                <View style={[styles.brightFill, { width: `${pct * 100}%`, backgroundColor: cssRgb(color) }]} />
              </View>
            )}
          />
        </>
      )}

      {/* PRESETS — saved profiles, applied to the whole strip. */}
      <Text style={styles.sectionLabel}>PRESETS</Text>
      <View style={styles.chipRow}>
        {presets.map((p) => (
          <Pressable
            key={p.id} onPress={() => applyPreset(p)} onLongPress={() => confirmDelete(p)}
            accessibilityRole="button" accessibilityLabel={`Apply preset ${p.label}`}
            style={({ pressed }) => [styles.presetChip, pressed && styles.pressed]}>
            <View style={[styles.presetDot, { backgroundColor: p.color ? cssRgb(p.color) : t.textDim }]} />
            <Text style={styles.chipText} numberOfLines={1}>{p.label}</Text>
          </Pressable>
        ))}
        <Pressable
          onPress={saveCurrent} accessibilityRole="button"
          accessibilityLabel="Save current look as a preset"
          style={({ pressed }) => [styles.savePreset, pressed && styles.pressed]}>
          <Ionicons name="add" size={14} color={t.blue} />
          <Text style={[styles.chipText, { color: t.blue }]}>Save</Text>
        </Pressable>
      </View>

      <Text style={styles.hint}>
        {agentMode
          ? 'Effects run on the box — they keep going with the app closed. Long-press a preset to delete.'
          : 'Tap a cell to paint it. Scanner sweeps a dot across the strip.'}
      </Text>
    </Card>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
    headerRight: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    cardTitle: { color: t.textDim, fontSize: 11, fontWeight: '700', letterSpacing: 1, fontFamily: mono },
    count: { color: t.textFaint, fontSize: 11, fontFamily: mono },
    refreshBtn: { borderColor: t.cardBorder, borderWidth: 1, borderRadius: 999, paddingVertical: 4, paddingHorizontal: 9 },
    pressed: { opacity: 0.6 },

    // One row: cells flex to share the width so all 17 fit on a single line.
    strip: { flexDirection: 'row', gap: 3, marginBottom: 8, marginTop: 2 },
    cellWrap: { flex: 1 },
    cell: { width: '100%', height: 40, borderRadius: 4, borderWidth: StyleSheet.hairlineWidth, borderColor: t.cardBorder },

    sectionLabel: {
      color: t.textFaint, fontSize: 10, fontWeight: '700', letterSpacing: 1.2, fontFamily: mono,
      marginTop: 14, marginBottom: 8,
    },
    sliderHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    swatchPreview: { width: 22, height: 22, borderRadius: 6, borderWidth: 1, borderColor: t.cardBorder, marginTop: 10 },

    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    chip: { borderColor: t.cardBorder, borderWidth: 1, borderRadius: 999, paddingVertical: 6, paddingHorizontal: 12 },
    chipOn: { borderColor: t.blue, backgroundColor: t.card },
    chipText: { color: t.textDim, fontSize: 12, fontFamily: mono },
    chipTextOn: { color: t.text, fontWeight: '700' },

    hueFill: {
      flexDirection: 'row', height: 18, borderRadius: 9, overflow: 'hidden',
      borderWidth: StyleSheet.hairlineWidth, borderColor: t.cardBorder,
    },
    brightTrack: {
      height: 18, borderRadius: 9, backgroundColor: t.card, overflow: 'hidden',
      borderWidth: StyleSheet.hairlineWidth, borderColor: t.cardBorder,
    },
    brightFill: { height: '100%', borderRadius: 9 },

    presetChip: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      borderColor: t.cardBorder, borderWidth: 1, borderRadius: 999,
      paddingVertical: 6, paddingHorizontal: 10,
    },
    presetDot: { width: 12, height: 12, borderRadius: 6 },
    savePreset: {
      flexDirection: 'row', alignItems: 'center', gap: 4,
      borderColor: t.blue, borderWidth: 1, borderRadius: 999,
      paddingVertical: 6, paddingHorizontal: 10,
    },

    hint: { color: t.textFaint, fontSize: 11, fontFamily: mono, marginTop: 10 },
  });
