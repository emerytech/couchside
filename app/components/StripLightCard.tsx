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

import { PresetNameModal } from '@/components/PresetNameModal';
import { TrackSlider } from '@/components/TrackSlider';
import { usePoll } from '@/hooks/usePoll';
import { api, hostKey, type LedEffect, type LedInfo, type LedsState, type Rgb } from '@/lib/api';
import { hapticLight } from '@/lib/haptics';
import { cssRgb, hexRgb, hueToRgb, rgbToHue, HUE_STOPS } from '@/lib/ledColor';
import {
  addPreset, isBuiltinPreset, removePreset, useLedPresets, type LedPreset,
} from '@/lib/ledPresets';
import { detectStrips, type LedStrip } from '@/lib/ledStrip';
import { useSkinKit } from '@/lib/skin';
import { useSettings } from '@/lib/SettingsContext';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

const POLL_MS = 15000;

type StripEffect =
  | 'solid' | 'off' | 'manual' | 'scanner' | 'rainbow' | 'breathe'
  | 'circle' | 'comet' | 'wipe' | 'twinkle';
const EFFECTS: { id: StripEffect; label: string }[] = [
  { id: 'solid', label: 'Solid' },
  { id: 'manual', label: 'Manual' },
  { id: 'off', label: 'Off' },
  { id: 'scanner', label: 'Scanner' },
  { id: 'circle', label: 'Circle' },
  { id: 'comet', label: 'Comet' },
  { id: 'wipe', label: 'Wipe' },
  { id: 'twinkle', label: 'Twinkle' },
  { id: 'rainbow', label: 'Rainbow' },
  { id: 'breathe', label: 'Breathe' },
];
const SPEEDS = [
  { label: 'Slow', pct: 25, ms: 150 },
  { label: 'Med', pct: 55, ms: 90 },
  { label: 'Fast', pct: 90, ms: 55 },
];
// Brightness levels a tap on a single LED cycles UP through, then off:
// off -> 35 -> 70 -> 100 -> off.
const CELL_STEPS = [35, 70, 100];
/** The next per-LED brightness for a tap: up a step, or off past the top. */
function nextCellBrightness(cur: number): number {
  if (cur <= 0) return CELL_STEPS[0];
  const idx = CELL_STEPS.findIndex((s) => cur <= s);
  return idx < 0 || idx >= CELL_STEPS.length - 1 ? 0 : CELL_STEPS[idx + 1];
}
const scale = (c: Rgb, f: number): Rgb => ({
  r: Math.round(c.r * f), g: Math.round(c.g * f), b: Math.round(c.b * f),
});

/** Friendly name for a known device so the customizer reads as "your box". */
function stripDeviceLabel(prefix: string): string {
  if (prefix.startsWith('valve-leds')) return 'Steam Machine strip';
  return prefix.replace(/[:_-]+$/, '');
}

/** LEDs in PHYSICAL left-to-right order for the customizer. The Steam Machine's
 *  `valve-leds` index runs opposite to the physical strip, so cell 0 painted the
 *  wrong end ("the bar is backwards") — flip it so the row matches the hardware. */
function displayLeds(strip: LedStrip): LedInfo[] {
  const flip = strip.leds[0]?.name.startsWith('valve-leds');
  return flip ? strip.leds.slice().reverse() : strip.leds;
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
  // Sweep direction for the agent-rendered directional effects (circle/comet/wipe).
  const [reverse, setReverse] = useState(false);
  // ALTERNATE: when on, the painted pattern cycles between its colours and a single
  // alternate colour on a timer (a 2-frame sequence played on the box).
  const [altOn, setAltOn] = useState(false);
  const [altHue, setAltHue] = useState(210);      // default a blue alternate
  const [cycleMs, setCycleMs] = useState(500);    // ms between the two frames
  const [frame, setFrame] = useState<(Rgb | null)[]>([]);
  // Per-LED brightness % (0 = off). A tap on a cell cycles it up the CELL_STEPS
  // then off, so you can dial each LED's level (and turn it off) by tapping.
  const [cellBright, setCellBright] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  // Pending "name this preset" prompt: the auto label + a builder that turns the
  // typed name into the full preset to save.
  const [namePrompt, setNamePrompt] = useState<
    { label: string; build: (name: string) => Omit<LedPreset, 'id'> } | null>(null);

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
    setFrame(displayLeds(strip).map((l) => (l.brightness_pct > 0 ? l.color : null)));
    setCellBright(displayLeds(strip).map((l) => l.brightness_pct));
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
    const ol = displayLeds(strip);
    const n = ol.length;
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
          void api.setLed(settings, ol[i].name, cell ? { color: cell, brightness: b } : { brightness: 0 }).catch(() => {});
        }
      }
      setFrame(next); last = next; first = false; tick++;
    }, ms);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentMode, effect, strip?.key, speedPct]);

  if (!poll.data || strips.length === 0 || !strip) return null;

  // Cells, paints and patterns all operate in PHYSICAL order (flipped for the
  // Steam Machine so the row matches the strip).
  const orderedLeds = displayLeds(strip);
  const color = hueToRgb(hue);
  const AGENT_ANIMATED = ['scanner', 'rainbow', 'breathe', 'circle', 'comet', 'wipe', 'twinkle'];
  const animated = AGENT_ANIMATED.includes(effect);
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
          effect: e as LedEffect, brightness: Math.round(bright), reverse,
          ...(animated || e !== 'off' ? { speed: Math.round(speedPct) } : {}),
          ...(e === 'rainbow' ? {} : { color }),
        });
      } finally { await poll.refresh(); setBusy(false); }
      return;
    }
    // App fallback: solid/off fill immediately; scanner runs the loop above.
    if (e === 'solid' || e === 'off') {
      const b = Math.round(bright);
      orderedLeds.forEach((l) => void api.setLed(settings, l.name, e === 'off' ? { brightness: 0 } : { color, brightness: b }).catch(() => {}));
      setFrame(orderedLeds.map(() => (e === 'off' ? null : color)));
    }
  };

  /** Re-apply the current colour/brightness — for a solid strip, or to re-arm an
   *  agent effect with the tweaked colour/speed (slider/speed commit). */
  // speedOverride: a speed CHIP sets state + re-applies in one tick, so it must
  // pass the new value explicitly — reading speedPct here would send the PREVIOUS
  // speed (stale closure: setSpeedPct hasn't re-rendered yet). Sliders re-render on
  // each onChange before onCommit, so they call reapply() with no arg (current).
  const reapply = (over?: { speed?: number; reverse?: boolean }) => {
    if (agentMode && agentStrip && effect !== 'off') {
      void api.setStripEffect(settings, agentStrip.prefix, {
        effect: effect as LedEffect, brightness: Math.round(bright),
        speed: Math.round(over?.speed ?? speedPct),
        reverse: over?.reverse ?? reverse,
        ...(effect === 'rainbow' ? {} : { color }),
      }).catch(() => {});
      return;
    }
    if (effect === 'solid') {
      const b = Math.round(bright);
      orderedLeds.forEach((l) => void api.setLed(settings, l.name, { color, brightness: b }).catch(() => {}));
      setFrame(orderedLeds.map(() => color));
    }
  };

  /** The two frames of the alternate: each lit LED shows its painted colour (A) or
   *  the single alternate colour (B), both at that LED's brightness. Off stays off. */
  const buildAltFrames = (mf: (Rgb | null)[], br: number[], alt: Rgb): (Rgb | null)[][] => {
    const at = (i: number) => (br[i] ?? (mf[i] ? 100 : 0)) / 100;
    const A = orderedLeds.map((_, i) => (mf[i] && at(i) > 0 ? scale(mf[i] as Rgb, at(i)) : null));
    const B = orderedLeds.map((_, i) => (mf[i] && at(i) > 0 ? scale(alt, at(i)) : null));
    return [A, B];
  };

  /** Play the current alternate on the box (a 2-frame looping sequence). */
  const pushAlt = (mf: (Rgb | null)[], br: number[], altHueVal: number, ms: number) => {
    if (!agentMode || !agentStrip) return;
    void api.setStripSequence(settings, agentStrip.prefix, {
      frames: buildAltFrames(mf, br, hueToRgb(altHueVal)), holdMs: ms, loop: true, brightness: 100,
    }).catch(() => {});
  };

  /** Paint the static main pattern on the box (used when ALTERNATE turns off). */
  const applyMainPattern = (mf: (Rgb | null)[], br: number[]) => {
    if (!agentMode || !agentStrip) return;
    void api.setStripEffect(settings, agentStrip.prefix, { effect: 'manual', brightness: 100 })
      .then(() => Promise.all(orderedLeds.map((l, i) => {
        const c = mf[i]; const b = br[i] ?? (c ? 100 : 0);
        return api.setLed(settings, l.name,
          c && b > 0 ? { color: c as Rgb, brightness: b } : { brightness: 0 });
      })))
      .catch(() => {});
  };

  /** Turn the alternate on (play the 2-frame sequence) or off (static main pattern). */
  const toggleAlt = (on: boolean) => {
    hapticLight();
    setAltOn(on);
    if (on) {
      setEffect('manual');
      pushAlt(frame, cellBright, altHue, cycleMs);
    } else {
      applyMainPattern(frame, cellBright);
    }
  };

  /** Tap one LED to cycle its brightness up a step, then off — a per-LED dimmer.
   *  Keeps the cell's own colour if it's already lit; a first tap on an off cell
   *  uses the current picker colour. When ALTERNATE is on, the tap re-pushes the
   *  2-frame sequence instead of a one-off write. */
  const paintCell = (i: number) => {
    hapticLight();
    const cur = cellBright[i] ?? (frame[i] ? 100 : 0);
    const next = nextCellBrightness(cur);
    const cellColor = next > 0 ? (frame[i] ?? color) : null;
    const newFrame = frame.slice(); newFrame[i] = cellColor;
    const newBright = orderedLeds.map((_, k) => (k === i ? next : (cellBright[k] ?? (frame[k] ? 100 : 0))));
    setFrame(newFrame);
    setCellBright(newBright);
    if (altOn) {
      pushAlt(newFrame, newBright, altHue, cycleMs);
    } else {
      void api.setLed(settings, orderedLeds[i].name,
        next > 0 ? { color: cellColor as Rgb, brightness: next } : { brightness: 0 }).catch(() => {});
    }
  };

  /** Coerce any saved preset effect to one the strip runs. */
  const toStripEffect = (e: LedEffect): StripEffect =>
    (EFFECTS.some((x) => x.id === e) ? e : 'breathe') as StripEffect;
  const nearestSpeed = (p: number) =>
    SPEEDS.reduce((b, s) => (Math.abs(s.pct - p) < Math.abs(b - p) ? s.pct : b), 55);

  const applyPreset = (p: LedPreset) => {
    hapticLight();
    // A GENERATOR preset (Police): build a strip-sized timed sequence + play it on
    // the box (red/blue halves alternating -> a police bar).
    if (p.generator === 'police') {
      setBright(p.brightness);
      const n = orderedLeds.length;
      const R: Rgb = { r: 255, g: 0, b: 0 };
      const B: Rgb = { r: 0, g: 40, b: 255 };
      const half = Math.ceil(n / 2);
      const A = orderedLeds.map((_, i) => (i < half ? R : null));
      const Bf = orderedLeds.map((_, i) => (i >= half ? B : null));
      setFrame(A);   // preview one flash in the grid
      if (agentMode && agentStrip) {
        const holdMs = Math.max(90, 600 - p.speed * 5);   // faster preset = quicker flash
        void api.setStripSequence(settings, agentStrip.prefix, {
          frames: [A, Bf], holdMs, loop: true, brightness: p.brightness,
        }).then(() => poll.refresh()).catch(() => {});
      }
      return;
    }
    // A painted PATTERN preset: enter manual mode, then repaint every LED.
    if (p.pattern && p.pattern.length) {
      setEffect('manual'); setBright(p.brightness);
      const pat = orderedLeds.map((_, i) => p.pattern![i] ?? null);
      setFrame(pat);
      if (agentMode && agentStrip) {
        void api.setStripEffect(settings, agentStrip.prefix, { effect: 'manual', brightness: p.brightness })
          .then(() => Promise.all(orderedLeds.map((l, i) =>
            api.setLed(settings, l.name, pat[i]
              ? { color: pat[i] as Rgb, brightness: Math.round(p.brightness) }
              : { brightness: 0 }))))
          .then(() => poll.refresh())
          .catch(() => {});
      } else {
        orderedLeds.forEach((l, i) => void api.setLed(settings, l.name, pat[i]
          ? { color: pat[i] as Rgb, brightness: Math.round(p.brightness) } : { brightness: 0 }).catch(() => {}));
      }
      return;
    }
    const e = toStripEffect(p.effect);
    const h = p.color ? rgbToHue(p.color) : hue;
    setEffect(e); setHue(h); setBright(p.brightness); setSpeedPct(nearestSpeed(p.speed));
    if (agentMode && agentStrip) {
      void api.setStripEffect(settings, agentStrip.prefix, {
        effect: e as LedEffect, brightness: p.brightness, speed: p.speed,
        ...(e === 'rainbow' ? {} : { color: p.color ?? hueToRgb(h) }),
      }).then(() => poll.refresh()).catch(() => {});
    } else {
      void applyEffect(e);
    }
  };

  /** Open the "name this preset" prompt, pre-filled with an auto label. */
  const saveCurrent = () => {
    hapticLight();
    if (effect === 'manual') {
      const pattern = frame.map((c) => c ?? null);
      setNamePrompt({
        label: `Custom ${orderedLeds.length}`,
        build: (name) => ({
          label: name, effect: 'manual', color: null,
          speed: Math.round(speedPct), brightness: Math.round(bright), pattern,
        }),
      });
      return;
    }
    const base = EFFECTS.find((x) => x.id === effect)?.label ?? 'Look';
    const usesColor = effect !== 'rainbow' && effect !== 'off';
    setNamePrompt({
      label: base + (usesColor ? ` ${hexRgb(color)}` : ''),
      build: (name) => ({
        label: name, effect: effect as LedEffect, color: usesColor ? color : null,
        speed: Math.round(speedPct), brightness: Math.round(bright),
      }),
    });
  };

  /** Long-press a preset to delete it — but PREINSTALLED (seeded) presets are
   *  protected, so those explain instead of deleting. */
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
    <Card index={7}>
      <View style={styles.header}>
        <Text style={styles.cardTitle}>LIGHT STRIP</Text>
        <View style={styles.headerRight}>
          <Text style={styles.count}>{stripDeviceLabel(agentStrip?.prefix ?? strip.key)} · {orderedLeds.length}</Text>
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
        {orderedLeds.map((l, i) => {
          const c = frame[i] ?? null;
          const bpct = cellBright[i] ?? (c ? 100 : 0);
          const shown = c && bpct > 0 ? scale(c, bpct / 100) : null;   // dim by level
          return (
            <Pressable
              key={l.name} onPress={() => paintCell(i)} style={styles.cellWrap}
              accessibilityRole="button"
              accessibilityLabel={`LED ${i}, ${bpct > 0 ? `${bpct}%` : 'off'} — tap to change`}>
              {({ pressed }) => (
                <View style={[styles.cell, { backgroundColor: shown ? cssRgb(shown) : t.card },
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
                  key={s.label} onPress={() => { hapticLight(); setSpeedPct(s.pct); if (agentMode) reapply({ speed: s.pct }); }}
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

      {/* DIRECTION — only the agent-rendered sweeps have a direction. */}
      {agentMode && (['circle', 'comet', 'wipe'] as StripEffect[]).includes(effect) && (
        <>
          <Text style={styles.sectionLabel}>DIRECTION</Text>
          <View style={styles.chipRow}>
            {[{ label: '→', rev: false }, { label: '←', rev: true }].map((d) => {
              const on = reverse === d.rev;
              return (
                <Pressable
                  key={d.label}
                  onPress={() => { hapticLight(); setReverse(d.rev); reapply({ reverse: d.rev }); }}
                  accessibilityRole="button" accessibilityState={{ selected: on }}
                  accessibilityLabel={d.rev ? 'Direction reverse' : 'Direction forward'}
                  style={({ pressed }) => [styles.chip, on && styles.chipOn, pressed && styles.pressed]}>
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>{d.label}</Text>
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
            value={hue} min={0} max={360} onChange={setHue} onCommit={() => reapply()}
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
            value={bright} min={0} max={100} onChange={setBright} onCommit={() => reapply()}
            thumbColor={t.text} accessibilityLabel="Strip brightness"
            renderTrack={(pct) => (
              <View style={styles.brightTrack}>
                <View style={[styles.brightFill, { width: `${pct * 100}%`, backgroundColor: cssRgb(color) }]} />
              </View>
            )}
          />
        </>
      )}

      {/* ALTERNATE — a painted pattern that cycles to a second colour on a timer. */}
      {effect === 'manual' && (
        <>
          <View style={styles.sliderHeader}>
            <Text style={styles.sectionLabel}>ALTERNATE</Text>
            <Pressable
              onPress={() => toggleAlt(!altOn)}
              accessibilityRole="switch" accessibilityState={{ checked: altOn }}
              accessibilityLabel="Alternate colour cycling"
              style={({ pressed }) => [styles.chip, altOn && styles.chipOn, pressed && styles.pressed]}>
              <Text style={[styles.chipText, altOn && styles.chipTextOn]}>{altOn ? 'On' : 'Off'}</Text>
            </Pressable>
          </View>
          {altOn && (
            <>
              <View style={styles.sliderHeader}>
                <Text style={styles.sectionLabel}>ALTERNATE COLOUR</Text>
                <View style={[styles.swatchPreview, { backgroundColor: cssRgb(hueToRgb(altHue)) }]} />
              </View>
              <TrackSlider
                value={altHue} min={0} max={360} onChange={setAltHue}
                onCommit={() => pushAlt(frame, cellBright, altHue, cycleMs)}
                thumbColor={cssRgb(hueToRgb(altHue))} accessibilityLabel="Alternate colour hue"
                renderTrack={() => (
                  <View style={styles.hueFill}>
                    {HUE_STOPS.map((c, i) => (<View key={i} style={{ flex: 1, backgroundColor: c }} />))}
                  </View>
                )}
              />
              <View style={styles.sliderHeader}>
                <Text style={styles.sectionLabel}>CYCLE EVERY</Text>
                <Text style={{ color: t.textDim, fontSize: 12, fontFamily: mono }}>
                  {(cycleMs / 1000).toFixed(cycleMs < 1000 ? 2 : 1)}s
                </Text>
              </View>
              <TrackSlider
                value={cycleMs} min={100} max={3000} onChange={setCycleMs}
                onCommit={() => pushAlt(frame, cellBright, altHue, cycleMs)}
                thumbColor={t.text} accessibilityLabel="Alternate cycle time"
                renderTrack={(pct) => (
                  <View style={styles.brightTrack}>
                    <View style={[styles.brightFill, { width: `${pct * 100}%`, backgroundColor: cssRgb(hueToRgb(altHue)) }]} />
                  </View>
                )}
              />
            </>
          )}
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
        {effect === 'manual'
          ? 'Pick a colour, tap cells to paint them, then Save the pattern.'
          : agentMode
            ? 'Effects run on the box — they keep going with the app closed. Long-press a preset to delete.'
            : 'Tap a cell to paint it. Scanner sweeps a dot across the strip.'}
      </Text>

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
