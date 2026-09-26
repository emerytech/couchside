/**
 * SYSTEM RGB (Console tab) — whole-system / addressable RGB via OpenRGB, from the
 * phone. Owner ask 2026-08-13: "make it OpenRGB-compatible … configure system
 * LEDs straight from the phone", with a real "night rider" sweep across the LEDs.
 *
 * Sibling of the LIGHT card (RgbLedCard): the LIGHT card drives the single kernel
 * front bar; this drives motherboard / RAM / GPU / strip controllers that OpenRGB
 * exposes, which is what makes a REAL multi-zone SCANNER possible (a lit dot
 * sweeping across the strip). The agent renders the sweep frame-by-frame.
 *
 * Probe-and-appear: null on a 404 (older agent) or `available: false` (no OpenRGB
 * server on the box) — no dead card. OpenRGB must be installed + its server
 * running on the box, so most boxes won't show this at all.
 *
 * Controls: EFFECT + SPEED chips are TAPS (harness-verifiable, §6); HUE /
 * BRIGHTNESS are the shared PanResponder sliders (drag = on-device proof). Every
 * change POSTs then re-reads /api/openrgb (§11: observe the real state). The agent
 * persists the choice, so a reboot restores it.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { TrackSlider } from '@/components/TrackSlider';
import { usePoll } from '@/hooks/usePoll';
import {
  api, hostKey, type LedEffect, type OpenRgbController, type OpenRgbState,
} from '@/lib/api';
import { hapticLight } from '@/lib/haptics';
import { cssRgb, hexRgb, hsToRgb, rgbToHs, HUE_STOPS, satStops } from '@/lib/ledColor';
import { useSkinKit } from '@/lib/skin';
import { useSettings } from '@/lib/SettingsContext';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

const POLL_MS = 15000;

/** OpenRGB devices are always colour-capable, so every effect applies. */
const EFFECTS: { id: LedEffect; label: string }[] = [
  { id: 'solid', label: 'Solid' },
  { id: 'off', label: 'Off' },
  { id: 'breathe', label: 'Breathe' },
  { id: 'pulse', label: 'Pulse' },
  { id: 'rainbow', label: 'Rainbow' },
  { id: 'strobe', label: 'Strobe' },
  { id: 'scanner', label: 'Scanner' },
];
/** Speed is a continuous 1–100 dial; the label anchors the readout. */
function speedLabel(v: number): string {
  if (v <= 33) return 'Slow';
  if (v <= 66) return 'Med';
  return 'Fast';
}

export function OpenRgbCard() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { Card } = useSkinKit();
  const { settings, ready } = useSettings();
  const configured = !!settings.host && !!settings.token;

  const [busy, setBusy] = useState(false);
  const [selIdx, setSelIdx] = useState<number | null>(null);
  const [effect, setEffect] = useState<LedEffect>('solid');
  const [hue, setHue] = useState(0);
  const [sat, setSat] = useState(100);
  const [bright, setBright] = useState(100);
  const [speed, setSpeed] = useState(55);
  const seeded = useRef<number | null>(null);

  const poll = usePoll<OpenRgbState | null>(
    () => api.openrgb(settings), POLL_MS, ready && configured, hostKey(settings));

  const d = poll.data;
  const ctrls = d?.controllers ?? [];
  const dev: OpenRgbController | undefined =
    ctrls.find((c) => c.index === selIdx) ?? ctrls[0];

  useEffect(() => {
    if (!dev || seeded.current === dev.index) return;
    seeded.current = dev.index;
    const a = d?.active?.[String(dev.index)];
    setEffect(a?.effect ?? 'solid');
    setSpeed(a?.speed ?? 55);
    setBright(a?.brightness ?? 100);
    const hs = a?.color ? rgbToHs(a.color) : { h: 0, s: 100 };
    setHue(hs.h);
    setSat(hs.s);
  }, [dev, d]);

  if (!d || !d.available || !dev || ctrls.length === 0) return null;

  const supported = d.effects ?? EFFECTS.map((e) => e.id);
  const shown = EFFECTS.filter((e) => supported.includes(e.id));
  const animated = effect !== 'solid' && effect !== 'off';
  const color = hsToRgb(hue, sat);

  const send = async (over: Partial<{ effect: LedEffect; hue: number; sat: number; bright: number; speed: number }>) => {
    if (busy || !dev) return;
    let eff = over.effect ?? effect;
    if (over.effect === undefined
        && (over.hue !== undefined || over.sat !== undefined || over.bright !== undefined)
        && eff === 'off') {
      eff = 'solid';
      setEffect('solid');
    }
    const b = Math.round(over.bright ?? bright);
    const sp = Math.round(over.speed ?? speed);
    const col = hsToRgb(over.hue ?? hue, over.sat ?? sat);
    hapticLight();
    setBusy(true);
    try {
      if (eff === 'off') {
        await api.openrgbSet(settings, dev.index, { effect: 'off' });
      } else {
        await api.openrgbSet(settings, dev.index, {
          effect: eff, brightness: b,
          ...(animated || eff !== 'solid' ? { speed: sp } : {}),
          ...(eff === 'rainbow' ? {} : { color: col }),
        });
      }
    } finally {
      await poll.refresh();
      setBusy(false);
    }
  };

  return (
    <Card index={7}>
      <View style={styles.header}>
        <Text style={styles.cardTitle}>SYSTEM RGB</Text>
        <View style={styles.headerRight}>
          {busy ? <ActivityIndicator size="small" color={t.blue} /> : null}
          <Pressable
            onPress={() => { hapticLight(); poll.refresh(); }}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Refresh OpenRGB devices"
            style={({ pressed }) => [styles.refreshBtn, pressed && styles.pressed]}>
            <Ionicons name="refresh" size={13} color={t.textDim} />
          </Pressable>
        </View>
      </View>

      {/* Device picker — only when the box exposes more than one controller. */}
      {ctrls.length > 1 && (
        <View style={styles.chipRow}>
          {ctrls.map((c) => {
            const on = c.index === dev.index;
            return (
              <Pressable
                key={c.index}
                onPress={() => { hapticLight(); setSelIdx(c.index); }}
                disabled={busy}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={`Control ${c.name}`}
                style={({ pressed }) => [
                  styles.chip, on && styles.chipOn, pressed && styles.pressed]}>
                <Text style={[styles.chipText, on && styles.chipTextOn]} numberOfLines={1}>
                  {c.name}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}

      <Text style={styles.deviceMeta}>
        {dev.name} · {dev.led_count} LEDs · {dev.zones.map((z) => z.name).join(', ')}
      </Text>

      {/* EFFECT chips. */}
      <Text style={styles.sectionLabel}>EFFECT</Text>
      <View style={styles.chipRow}>
        {shown.map((e) => {
          const on = effect === e.id;
          return (
            <Pressable
              key={e.id}
              onPress={() => { setEffect(e.id); void send({ effect: e.id }); }}
              disabled={busy}
              accessibilityRole="button"
              accessibilityState={{ selected: on, disabled: busy }}
              accessibilityLabel={`Effect ${e.label}`}
              style={({ pressed }) => [
                styles.chip, on && styles.chipOn, pressed && !busy && styles.pressed]}>
              <Text style={[styles.chipText, on && styles.chipTextOn]}>{e.label}</Text>
            </Pressable>
          );
        })}
      </View>

      {/* SPEED — animated effects only. Continuous 1–100 dial. */}
      {animated && (
        <>
          <View style={styles.sliderHeader}>
            <Text style={styles.sectionLabel}>SPEED</Text>
            <Text style={styles.readout}>{speedLabel(speed)} · {Math.round(speed)}</Text>
          </View>
          <TrackSlider
            value={speed}
            min={1}
            max={100}
            disabled={busy}
            onChange={setSpeed}
            onCommit={(v) => void send({ speed: v })}
            thumbColor={t.blue}
            accessibilityLabel="Effect speed"
            renderTrack={(pct) => (
              <View style={styles.brightTrack}>
                <View style={[styles.brightFill, { width: `${pct * 100}%`, backgroundColor: t.blue }]} />
              </View>
            )}
          />
        </>
      )}

      {/* COLOUR — hidden for rainbow (cycles its own) and off. Hue + saturation
          (saturation 0 = white) with a live swatch + hex readout. */}
      {effect !== 'rainbow' && effect !== 'off' && (
        <>
          <View style={styles.sliderHeader}>
            <Text style={styles.sectionLabel}>COLOUR</Text>
            <View style={styles.headerRight}>
              <Text style={styles.readout}>{hexRgb(color)}</Text>
              <View style={[styles.swatchPreview, { backgroundColor: cssRgb(color) }]} />
            </View>
          </View>
          <TrackSlider
            value={hue}
            min={0}
            max={360}
            disabled={busy}
            onChange={setHue}
            onCommit={(v) => void send({ hue: v })}
            thumbColor={cssRgb(color)}
            accessibilityLabel="System RGB colour hue"
            renderTrack={() => (
              <View style={styles.hueFill}>
                {HUE_STOPS.map((c, i) => (
                  <View key={i} style={{ flex: 1, backgroundColor: c }} />
                ))}
              </View>
            )}
          />
          <TrackSlider
            value={sat}
            min={0}
            max={100}
            disabled={busy}
            onChange={setSat}
            onCommit={(v) => void send({ sat: v })}
            thumbColor={cssRgb(color)}
            accessibilityLabel="System RGB colour saturation"
            renderTrack={() => (
              <View style={styles.hueFill}>
                {satStops(hue).map((c, i) => (
                  <View key={i} style={{ flex: 1, backgroundColor: c }} />
                ))}
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
            value={bright}
            min={0}
            max={100}
            disabled={busy}
            onChange={setBright}
            onCommit={(v) => void send({ bright: v })}
            thumbColor={t.text}
            accessibilityLabel="System RGB brightness"
            renderTrack={(pct) => (
              <View style={styles.brightTrack}>
                <View style={[styles.brightFill,
                  { width: `${pct * 100}%`, backgroundColor: cssRgb(color) }]} />
              </View>
            )}
          />
        </>
      )}

      <Text style={styles.hint}>
        Scanner sweeps a lit dot across the strip — a real night-rider.
      </Text>
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

    deviceMeta: {
      color: t.textFaint, fontSize: 11, fontFamily: mono, marginTop: 10,
    },
    sectionLabel: {
      color: t.textFaint, fontSize: 10, fontWeight: '700', letterSpacing: 1.2,
      fontFamily: mono, marginTop: 14, marginBottom: 8,
    },
    sliderHeader: {
      flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between',
    },
    readout: {
      color: t.textDim, fontSize: 11, fontFamily: mono, marginBottom: 2,
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

    hueFill: {
      flexDirection: 'row', height: 18, borderRadius: 9, overflow: 'hidden',
      borderWidth: StyleSheet.hairlineWidth, borderColor: t.cardBorder,
    },
    brightTrack: {
      height: 18, borderRadius: 9, backgroundColor: t.card, overflow: 'hidden',
      borderWidth: StyleSheet.hairlineWidth, borderColor: t.cardBorder,
    },
    brightFill: { height: '100%', borderRadius: 9 },

    hint: { color: t.textFaint, fontSize: 11, fontFamily: mono, marginTop: 12 },
  });
