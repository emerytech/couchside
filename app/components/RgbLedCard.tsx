/**
 * LIGHT (Console tab) — set the box's front RGB / status LED colour + brightness
 * from the phone. The read-only siblings show state; this one changes it.
 *
 * Probe-and-appear, the AudioOutputCard shape exactly: a 404 (agent too old),
 * `available: false` (no controllable/writable LED), or zero *notable* LEDs
 * renders NOTHING — no dead card. On a stock box the LED sysfs files are
 * root-owned, so nothing is writable until an install-time udev grant lands, and
 * the card correctly stays hidden until then.
 *
 * Tap-only by design (colour swatches + discrete brightness levels), because
 * drag gestures aren't verifiable in the web harness. Every tap fires one POST
 * then RE-READS /api/leds rather than trusting the echo (CLAUDE.md §11: observe
 * the real state) — the ring that moves is the box telling us it moved.
 *
 * The LED `name` sent back is one the box itself listed; the agent looks it up in
 * its live /sys/class/leds set and refuses anything else, so this control can
 * only ever aim at an LED the box offered.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { usePoll } from '@/hooks/usePoll';
import { api, hostKey, type LedInfo, type LedsState, type Rgb } from '@/lib/api';
import { hapticLight } from '@/lib/haptics';
import { useSkinKit } from '@/lib/skin';
import { useSettings } from '@/lib/SettingsContext';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

/** LEDs don't change on their own second-by-second; the taps refresh immediately,
 *  so this is just a backstop (e.g. another app changed the colour). */
const POLL_MS = 15000;

/** Frozen preset colours (0–255 per channel), sent verbatim; the agent
 *  range-checks each triple. Tap-testable: one swatch = one POST. */
const PRESETS: { label: string; rgb: Rgb }[] = [
  { label: 'Red', rgb: { r: 255, g: 0, b: 0 } },
  { label: 'Orange', rgb: { r: 255, g: 120, b: 0 } },
  { label: 'Yellow', rgb: { r: 255, g: 220, b: 0 } },
  { label: 'Green', rgb: { r: 0, g: 200, b: 0 } },
  { label: 'Cyan', rgb: { r: 0, g: 200, b: 255 } },
  { label: 'Blue', rgb: { r: 0, g: 80, b: 255 } },
  { label: 'Purple', rgb: { r: 160, g: 0, b: 255 } },
  { label: 'Pink', rgb: { r: 255, g: 0, b: 150 } },
  { label: 'White', rgb: { r: 255, g: 255, b: 255 } },
  { label: 'Warm', rgb: { r: 255, g: 170, b: 90 } },
];

const LEVELS = [0, 25, 50, 75, 100];

const css = (c: Rgb) => `rgb(${c.r}, ${c.g}, ${c.b})`;

/** A colour round-trips through device scaling, so match within a small
 *  tolerance rather than requiring exact equality. */
function sameColor(a: Rgb | null, b: Rgb): boolean {
  if (!a) return false;
  return Math.abs(a.r - b.r) <= 3 && Math.abs(a.g - b.g) <= 3 && Math.abs(a.b - b.b) <= 3;
}

/** The level button (from the rendered set) that best matches the reported
 *  brightness, so exactly one lights up. */
function nearestLevel(pct: number, levels: number[]): number {
  return levels.reduce((best, lv) =>
    Math.abs(lv - pct) < Math.abs(best - pct) ? lv : best, levels[0]);
}

export function RgbLedCard() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { Card } = useSkinKit();
  const { settings, ready } = useSettings();
  const configured = !!settings.host && !!settings.token;

  // Which LED is being written (disables the controls + shows a spinner) so a
  // double-tap can't fire two writes at once.
  const [busy, setBusy] = useState(false);
  // When several notable LEDs exist, which one the controls act on.
  const [selName, setSelName] = useState<string | null>(null);

  const poll = usePoll<LedsState | null>(
    () => api.leds(settings), POLL_MS, ready && configured, hostKey(settings));

  const d = poll.data;
  const leds = (d?.leds ?? []).filter((l) => l.notable && l.writable);
  // Old agent, no writable LED, or nothing notable -> render nothing at all.
  if (!d || !d.available || leds.length === 0) return null;

  const led: LedInfo = leds.find((l) => l.name === selName) ?? leds[0];
  const off = led.brightness_pct === 0;
  // An rgb LED gets its "off" from the OFF swatch, so drop the duplicate level-0
  // button (otherwise both light up when off). A mono LED keeps it — it has no
  // swatch. When off, no level highlights (the OFF swatch shows the state).
  const levels = led.rgb ? LEVELS.filter((l) => l > 0) : LEVELS;
  const activeLevel = off ? -1 : nearestLevel(led.brightness_pct, levels);

  const apply = async (patch: { brightness?: number; color?: Rgb }) => {
    if (busy) return;
    hapticLight();
    setBusy(true);
    try {
      await api.setLed(settings, led.name, patch);
    } finally {
      await poll.refresh();
      setBusy(false);
    }
  };

  return (
    <Card index={6}>
      <View style={styles.header}>
        <Text style={styles.cardTitle}>LIGHT</Text>
        <View style={styles.headerRight}>
          {/* One spinner for the whole card while a write is in flight — the
              swatch/level that lands is shown by the ring after the re-read, so
              a per-control spinner (which would sit on stale state) is wrong. */}
          {busy ? <ActivityIndicator size="small" color={t.blue} /> : null}
          <Pressable
            onPress={() => {
              hapticLight();
              poll.refresh();
            }}
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
        <View style={styles.ledRow}>
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
                  styles.ledChip, on && styles.ledChipOn, pressed && styles.pressed]}>
                <Text style={[styles.ledChipText, on && styles.ledChipTextOn]} numberOfLines={1}>
                  {l.desc}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}

      {/* Colour swatches (rgb LEDs only). */}
      {led.rgb && (
        <>
          <Text style={styles.sectionLabel}>COLOUR</Text>
          <View style={styles.swatchGrid}>
            {PRESETS.map((p) => {
              const on = !off && sameColor(led.color, p.rgb);
              return (
                <Pressable
                  key={p.label}
                  onPress={() => apply({
                    color: p.rgb,
                    brightness: led.brightness_pct > 0 ? led.brightness_pct : 100,
                  })}
                  disabled={busy}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on, disabled: busy }}
                  accessibilityLabel={`Set light to ${p.label}`}
                  style={({ pressed }) => [
                    styles.swatch,
                    { backgroundColor: css(p.rgb) },
                    on && styles.swatchOn,
                    pressed && !busy && styles.pressed,
                  ]}>
                  {on ? (
                    <Ionicons
                      name="checkmark"
                      size={16}
                      color={p.rgb.r + p.rgb.g + p.rgb.b > 480 ? '#000' : '#fff'}
                    />
                  ) : null}
                </Pressable>
              );
            })}
            {/* Off — turns the light out (brightness 0), rendered as an inset chip. */}
            <Pressable
              onPress={() => apply({ brightness: 0 })}
              disabled={busy}
              accessibilityRole="radio"
              accessibilityState={{ selected: off, disabled: busy }}
              accessibilityLabel="Turn the light off"
              style={({ pressed }) => [
                styles.swatch, styles.offSwatch, off && styles.swatchOn,
                pressed && !busy && styles.pressed]}>
              <Text style={styles.offText}>OFF</Text>
            </Pressable>
          </View>
        </>
      )}

      {/* Brightness levels (every LED). */}
      <Text style={styles.sectionLabel}>BRIGHTNESS</Text>
      <View style={styles.levelRow}>
        {levels.map((lv) => {
          const on = activeLevel === lv;
          return (
            <Pressable
              key={lv}
              onPress={() => apply({ brightness: lv })}
              disabled={busy}
              accessibilityRole="button"
              accessibilityState={{ selected: on, disabled: busy }}
              accessibilityLabel={lv === 0 ? 'Brightness off' : `Brightness ${lv} percent`}
              style={({ pressed }) => [
                styles.level, on && styles.levelOn, pressed && !busy && styles.pressed]}>
              <Text style={[styles.levelText, on && styles.levelTextOn]}>
                {lv === 0 ? 'Off' : `${lv}`}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <Text style={styles.hint}>
        {led.rgb ? 'Tap a colour, then a brightness.' : 'Tap a brightness level.'}
      </Text>
    </Card>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 10,
    },
    headerRight: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    cardTitle: {
      color: t.textDim,
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 1,
      fontFamily: mono,
    },
    refreshBtn: {
      borderColor: t.cardBorder,
      borderWidth: 1,
      borderRadius: 999,
      paddingVertical: 4,
      paddingHorizontal: 9,
    },
    pressed: { opacity: 0.6 },

    sectionLabel: {
      color: t.textFaint,
      fontSize: 10,
      fontWeight: '700',
      letterSpacing: 1.2,
      fontFamily: mono,
      marginTop: 12,
      marginBottom: 8,
    },

    ledRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    ledChip: {
      borderColor: t.cardBorder,
      borderWidth: 1,
      borderRadius: 999,
      paddingVertical: 5,
      paddingHorizontal: 11,
    },
    ledChipOn: { borderColor: t.text },
    ledChipText: { color: t.textDim, fontSize: 12, fontFamily: mono },
    ledChipTextOn: { color: t.text, fontWeight: '700' },

    swatchGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
    // A 2px transparent border is ALWAYS present so selecting shifts no layout.
    swatch: {
      width: 44,
      height: 44,
      borderRadius: 10,
      borderWidth: 2,
      borderColor: 'transparent',
      alignItems: 'center',
      justifyContent: 'center',
    },
    swatchOn: { borderColor: t.text },
    offSwatch: {
      backgroundColor: t.card,
      borderColor: t.cardBorder,
    },
    offText: {
      color: t.textDim,
      fontSize: 10,
      fontWeight: '700',
      letterSpacing: 1,
      fontFamily: mono,
    },

    levelRow: { flexDirection: 'row', gap: 6 },
    level: {
      flex: 1,
      height: 38,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: t.cardBorder,
      alignItems: 'center',
      justifyContent: 'center',
    },
    levelOn: { borderColor: t.blue, backgroundColor: t.card },
    levelText: { color: t.textDim, fontSize: 13, fontFamily: mono },
    levelTextOn: { color: t.text, fontWeight: '700' },

    hint: {
      color: t.textFaint,
      fontSize: 11,
      fontFamily: mono,
      marginTop: 10,
    },
  });
