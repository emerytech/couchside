/**
 * LIGHT (Console tab) — the box's front RGB / status LED editor: colour, effects,
 * and saved presets, from the phone. The read-only siblings show state; this one
 * changes it. Owner ask 2026-08-13: "easier editor … save presets … automation
 * (night rider) … survive reboot".
 *
 * Probe-and-appear (the AudioOutputCard shape): a 404 (agent too old),
 * `available: false`, or zero *notable* LEDs renders NOTHING — no dead card. On a
 * stock box the LED sysfs files are root-owned, so nothing is writable until an
 * install-time udev grant lands, and the card correctly stays hidden until then.
 *
 * Controls, and why each is testable:
 *  - EFFECT chips + SPEED chips + PRESET chips are TAPS → verifiable in the web
 *    harness (§6: press the control, don't just render it).
 *  - HUE / BRIGHTNESS are PanResponder sliders. A drag feels native; a single TAP
 *    on the track also sets the value (grant fires with the tap position), so the
 *    harness can press them too. The *drag* itself is on-device-only proof.
 *
 * Every change fires one POST then RE-READS /api/leds rather than trusting the
 * echo (§11: observe the real state). Effects/presets persist on the box, so a
 * reboot restores them (agent >= 2.9.84); the preset *library* is per-phone
 * (lib/ledPresets.ts) — applying one is just another setLedEffect call.
 *
 * The LED `name` sent back is one the box itself listed; the agent looks it up in
 * its live /sys/class/leds set and refuses anything else.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { TrackSlider } from '@/components/TrackSlider';
import { usePoll } from '@/hooks/usePoll';
import {
  api, hostKey, type LedEffect, type LedInfo, type LedsState, type Rgb,
} from '@/lib/api';
import { hapticLight } from '@/lib/haptics';
import { PresetNameModal } from '@/components/PresetNameModal';
import { cssRgb, hexRgb, hueToRgb, rgbToHue, HUE_STOPS } from '@/lib/ledColor';
import { detectStrips } from '@/lib/ledStrip';
import {
  addPreset, isBuiltinPreset, removePreset, useLedPresets, type LedPreset,
} from '@/lib/ledPresets';
import { useSkinKit } from '@/lib/skin';
import { useSettings } from '@/lib/SettingsContext';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

/** LEDs don't change on their own second-by-second; taps refresh immediately, so
 *  this is just a backstop (e.g. another app changed the colour). */
const POLL_MS = 15000;

/** Effect id → label + whether it drives a colour. `rainbow` cycles its own hue,
 *  so we never send it a colour; the rest use the picked colour. */
const EFFECT_META: Record<LedEffect, { label: string; usesColor: boolean }> = {
  solid: { label: 'Solid', usesColor: true },
  off: { label: 'Off', usesColor: false },
  breathe: { label: 'Breathe', usesColor: true },
  pulse: { label: 'Pulse', usesColor: true },
  rainbow: { label: 'Rainbow', usesColor: false },
  strobe: { label: 'Strobe', usesColor: true },
  scanner: { label: 'Scanner', usesColor: true },
  // `manual` is a strip-only concept; filtered out of this single-LED card below.
  manual: { label: 'Manual', usesColor: true },
  // Strip-only agent animations; filtered out of this mono card (not in MONO_EFFECTS).
  circle: { label: 'Circle', usesColor: true },
  comet: { label: 'Comet', usesColor: true },
  wipe: { label: 'Wipe', usesColor: true },
  twinkle: { label: 'Twinkle', usesColor: true },
};
/** A mono LED can't show colour, so only these effects make sense on one. */
const MONO_EFFECTS: LedEffect[] = ['solid', 'off', 'breathe', 'pulse', 'strobe'];

const SPEEDS: { label: string; value: number }[] = [
  { label: 'Slow', value: 25 },
  { label: 'Med', value: 55 },
  { label: 'Fast', value: 90 },
];

export function RgbLedCard() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { Card } = useSkinKit();
  const { settings, ready } = useSettings();
  const configured = !!settings.host && !!settings.token;
  const presets = useLedPresets();

  const [busy, setBusy] = useState(false);
  const [selName, setSelName] = useState<string | null>(null);
  const [namePrompt, setNamePrompt] = useState<
    { label: string; build: (name: string) => Omit<LedPreset, 'id'> } | null>(null);

  // Local editor state; seeded from the box once per selected LED, then the
  // user's edits drive the UI (poll is a backstop, not the source of truth).
  const [effect, setEffect] = useState<LedEffect>('solid');
  const [hue, setHue] = useState(0);
  const [bright, setBright] = useState(100);
  const [speed, setSpeed] = useState(55);
  const seeded = useRef<string | null>(null);

  const poll = usePoll<LedsState | null>(
    () => api.leds(settings), POLL_MS, ready && configured, hostKey(settings));

  const d = poll.data;
  // Addressable strips (valve-leds[0..N]) are owned by StripLightCard; this card
  // keeps only the SINGLE lights (status LED, a lone front bar) so it isn't a
  // wall of per-node chips.
  const notable = (d?.leds ?? []).filter((l) => l.notable && l.writable);
  const { strips, singles } = detectStrips(notable);
  const leds = singles;
  const led: LedInfo | undefined = leds.find((l) => l.name === selName) ?? leds[0];

  useEffect(() => {
    if (!led || seeded.current === led.name) return;
    seeded.current = led.name;
    const a = d?.active?.[led.name];
    setEffect(a?.effect ?? 'solid');
    setSpeed(a?.speed ?? 55);
    setBright(a?.brightness ?? led.brightness_pct ?? 100);
    const c = a?.color ?? led.color;
    setHue(c ? rgbToHue(c) : 0);
  }, [led, d]);

  // Render nothing when: old agent / no writable LED / nothing notable — OR when
  // an addressable strip owns the box's lights and the only singles left are mono
  // status LEDs (a lone status light isn't worth a card next to the STRIP card,
  // which now carries the presets). Keep this card for a real RGB single (a
  // chassis bar on non-strip hardware) or when there's no strip.
  const onlyMonoSingles = leds.length > 0 && leds.every((l) => !l.rgb);
  if (!d || !d.available || !led || leds.length === 0
      || (strips.length > 0 && onlyMonoSingles)) return null;

  const supported: LedEffect[] = (d.effects ?? ['solid', 'off'])
    .filter((e) => e !== 'manual') // `manual` is a strip painter, not a single-LED effect
    .filter((e) => (led.rgb ? true : MONO_EFFECTS.includes(e)));
  const animated = effect !== 'solid' && effect !== 'off';
  const color = hueToRgb(hue);

  /** One place that turns the current editor state into a box write, then
   *  re-reads. `over` lets a control apply its brand-new value in the same tick
   *  (setState is async). Editing colour/brightness while 'off' switches to solid. */
  const send = async (over: Partial<{ effect: LedEffect; hue: number; bright: number; speed: number }>) => {
    if (busy || !led) return;
    let eff = over.effect ?? effect;
    if (over.effect === undefined && (over.hue !== undefined || over.bright !== undefined) && eff === 'off') {
      eff = 'solid';
      setEffect('solid');
    }
    const h = over.hue ?? hue;
    const b = Math.round(over.bright ?? bright);
    const sp = Math.round(over.speed ?? speed);
    const col = hueToRgb(h);
    hapticLight();
    setBusy(true);
    try {
      if (eff === 'off') {
        await api.setLedEffect(settings, led.name, { effect: 'off' });
      } else if (eff === 'solid') {
        await api.setLed(settings, led.name,
          led.rgb ? { color: col, brightness: b } : { brightness: b });
      } else {
        await api.setLedEffect(settings, led.name, {
          effect: eff, speed: sp, brightness: b,
          ...(led.rgb && EFFECT_META[eff].usesColor ? { color: col } : {}),
        });
      }
    } finally {
      await poll.refresh();
      setBusy(false);
    }
  };

  const applyPreset = (p: LedPreset) => {
    const h = p.color ? rgbToHue(p.color) : hue;
    setEffect(p.effect); setHue(h); setBright(p.brightness); setSpeed(p.speed);
    void send({ effect: p.effect, hue: h, bright: p.brightness, speed: p.speed });
  };

  const saveCurrent = () => {
    hapticLight();
    const usesColor = led.rgb && EFFECT_META[effect].usesColor;
    setNamePrompt({
      label: EFFECT_META[effect].label + (usesColor ? ` ${hexRgb(color)}` : ''),
      build: (name) => ({
        label: name, effect, color: usesColor ? color : null,
        speed: Math.round(speed), brightness: Math.round(bright),
      }),
    });
  };

  const confirmDelete = (p: LedPreset) => {
    if (isBuiltinPreset(p.id)) {
      Alert.alert('Built-in preset', `"${p.label}" is preinstalled and can't be deleted.`);
      return;
    }
    Alert.alert('Delete preset', `Remove "${p.label}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => void removePreset(p.id) },
    ]);
  };

  return (
    <Card index={6}>
      <View style={styles.header}>
        <Text style={styles.cardTitle}>LIGHT</Text>
        <View style={styles.headerRight}>
          {busy ? <ActivityIndicator size="small" color={t.blue} /> : null}
          <Pressable
            onPress={() => { hapticLight(); poll.refresh(); }}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Refresh lights"
            style={({ pressed }) => [styles.refreshBtn, pressed && styles.pressed]}>
            <Ionicons name="refresh" size={13} color={t.textDim} />
          </Pressable>
        </View>
      </View>

      {/* LED picker — only when the box exposes more than one controllable light. */}
      {leds.length > 1 && (
        <View style={styles.chipRow}>
          {leds.map((l) => {
            const on = l.name === led.name;
            return (
              <Pressable
                key={l.name}
                onPress={() => { hapticLight(); setSelName(l.name); }}
                disabled={busy}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={`Control ${l.desc}`}
                style={({ pressed }) => [
                  styles.chip, on && styles.chipOn, pressed && styles.pressed]}>
                <Text style={[styles.chipText, on && styles.chipTextOn]} numberOfLines={1}>
                  {l.desc}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}

      {/* EFFECT chips (agent >= 2.9.84). */}
      {supported.length > 0 && (
        <>
          <Text style={styles.sectionLabel}>EFFECT</Text>
          <View style={styles.chipRow}>
            {supported.map((e) => {
              const on = effect === e;
              return (
                <Pressable
                  key={e}
                  onPress={() => { setEffect(e); void send({ effect: e }); }}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on, disabled: busy }}
                  accessibilityLabel={`Effect ${EFFECT_META[e].label}`}
                  style={({ pressed }) => [
                    styles.chip, on && styles.chipOn, pressed && !busy && styles.pressed]}>
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>
                    {EFFECT_META[e].label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </>
      )}

      {/* SPEED — only for an animated effect. */}
      {animated && (
        <>
          <Text style={styles.sectionLabel}>SPEED</Text>
          <View style={styles.chipRow}>
            {SPEEDS.map((s) => {
              const on = Math.abs(speed - s.value) <= 15;
              return (
                <Pressable
                  key={s.label}
                  onPress={() => { setSpeed(s.value); void send({ speed: s.value }); }}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on, disabled: busy }}
                  accessibilityLabel={`Speed ${s.label}`}
                  style={({ pressed }) => [
                    styles.chip, on && styles.chipOn, pressed && !busy && styles.pressed]}>
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>{s.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </>
      )}

      {/* COLOUR — rgb LEDs only. Hue slider + a live swatch. */}
      {led.rgb && effect !== 'rainbow' && effect !== 'off' && (
        <>
          <View style={styles.sliderHeader}>
            <Text style={styles.sectionLabel}>COLOUR</Text>
            <View style={[styles.swatchPreview, { backgroundColor: cssRgb(color) }]} />
          </View>
          <TrackSlider
            value={hue}
            min={0}
            max={360}
            disabled={busy}
            onChange={setHue}
            onCommit={(v) => void send({ hue: v })}
            thumbColor={cssRgb(color)}
            accessibilityLabel="Light colour hue"
            renderTrack={() => (
              <View style={styles.hueFill}>
                {HUE_STOPS.map((c, i) => (
                  <View key={i} style={{ flex: 1, backgroundColor: c }} />
                ))}
              </View>
            )}
          />
        </>
      )}

      {/* BRIGHTNESS — every LED, unless off. */}
      {effect !== 'off' && (
        <>
          <Text style={styles.sectionLabel}>BRIGHTNESS</Text>
          <TrackSlider
            value={bright}
            min={0}
            max={100}
            disabled={busy}
            onChange={setBright}
            onCommit={(v) => void send({ bright: v })}
            thumbColor={t.text}
            accessibilityLabel="Light brightness"
            renderTrack={(pct) => (
              <View style={styles.brightTrack}>
                <View style={[styles.brightFill,
                  { width: `${pct * 100}%`, backgroundColor: led.rgb ? cssRgb(color) : t.text }]} />
              </View>
            )}
          />
        </>
      )}

      {/* PRESETS — tap to apply, long-press to delete, + to save the current look. */}
      <Text style={styles.sectionLabel}>PRESETS</Text>
      <View style={styles.chipRow}>
        {presets.map((p) => (
          <Pressable
            key={p.id}
            onPress={() => applyPreset(p)}
            onLongPress={() => confirmDelete(p)}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={`Apply preset ${p.label}`}
            style={({ pressed }) => [styles.presetChip, pressed && !busy && styles.pressed]}>
            <View style={[styles.presetDot,
              { backgroundColor: p.color ? cssRgb(p.color) : t.textDim }]} />
            <Text style={styles.chipText} numberOfLines={1}>{p.label}</Text>
          </Pressable>
        ))}
        <Pressable
          onPress={saveCurrent}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Save current look as a preset"
          style={({ pressed }) => [styles.savePreset, pressed && !busy && styles.pressed]}>
          <Ionicons name="add" size={14} color={t.blue} />
          <Text style={[styles.chipText, { color: t.blue }]}>Save</Text>
        </Pressable>
      </View>

      <Text style={styles.hint}>Long-press a preset to delete it.</Text>

      <PresetNameModal
        visible={!!namePrompt}
        defaultName={namePrompt?.label ?? ''}
        onSubmit={(name) => { if (namePrompt) void addPreset(namePrompt.build(name)); setNamePrompt(null); }}
        onClose={() => setNamePrompt(null)}
      />
    </Card>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    header: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      marginBottom: 10,
    },
    headerRight: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    cardTitle: {
      color: t.textDim, fontSize: 11, fontWeight: '700', letterSpacing: 1, fontFamily: mono,
    },
    refreshBtn: {
      borderColor: t.cardBorder, borderWidth: 1, borderRadius: 999,
      paddingVertical: 4, paddingHorizontal: 9,
    },
    pressed: { opacity: 0.6 },

    sectionLabel: {
      color: t.textFaint, fontSize: 10, fontWeight: '700', letterSpacing: 1.2,
      fontFamily: mono, marginTop: 14, marginBottom: 8,
    },
    sliderHeader: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    },
    swatchPreview: {
      width: 22, height: 22, borderRadius: 6, borderWidth: 1, borderColor: t.cardBorder,
      marginTop: 10,
    },

    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    chip: {
      borderColor: t.cardBorder, borderWidth: 1, borderRadius: 999,
      paddingVertical: 6, paddingHorizontal: 12,
    },
    chipOn: { borderColor: t.blue, backgroundColor: t.card },
    chipText: { color: t.textDim, fontSize: 12, fontFamily: mono },
    chipTextOn: { color: t.text, fontWeight: '700' },

    // The hue/brightness slider bodies (the TrackSlider draws the tall touch
    // target + thumb; these are the coloured fills it renders inside).
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
