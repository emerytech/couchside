/**
 * REACTIVE (LIGHT STRIP) — the host for the reactive/ambient modes: the strip
 * renders live box state instead of a static look, and keeps going with the app
 * closed. It is a MODE PICKER → per-mode config PANEL: each mode is a small panel
 * component (MeterPanel, PlaytimePanel, …), so adding a mode is a new panel, not
 * more StripLightCard lines.
 *
 * Probe-and-appear: the modes offered come straight from the agent's `reactive`
 * block — live meters it can actually read right now, plus the playtime countdown
 * when advertised. An older agent has no `reactive` block, so the whole section is
 * hidden by the caller.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { MeterPanel } from '@/components/reactive/MeterPanel';
import { PlaytimePanel } from '@/components/reactive/PlaytimePanel';
import { reactiveStyles } from '@/components/reactive/styles';
import { api, type ConnSettings, type LedActive, type LedEffect, type LedsState } from '@/lib/api';
import { hapticLight } from '@/lib/haptics';
import { useTheme } from '@/lib/theme';

const MODE_LABEL: Partial<Record<LedEffect, string>> = {
  meter_cpu: 'CPU', meter_battery: 'Battery', playtime: 'Playtime',
};
const isReactive = (e?: LedEffect): boolean =>
  e === 'meter_cpu' || e === 'meter_battery' || e === 'playtime';

export function ReactiveModeControls(props: {
  settings: ConnSettings;
  strip: string;
  reactive: NonNullable<LedsState['reactive']>;
  active: LedActive | undefined;
  onApplied: () => void;
}) {
  const { settings, strip, reactive, active, onApplied } = props;
  const t = useTheme();
  const styles = reactiveStyles(t);

  // The offered modes: the live meters the box advertised, plus playtime if it can.
  const modes: LedEffect[] = [
    ...(reactive.meters ?? []),
    ...(reactive.playtime ? (['playtime'] as LedEffect[]) : []),
  ];

  const running = active && isReactive(active.effect) ? active.effect : null;
  const [mode, setMode] = useState<LedEffect | null>(running);
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    if (running) { seeded.current = true; setMode(running); }
  }, [running]);

  // Selecting a live meter applies it immediately (it just starts reading); playtime
  // waits for its own Start button (its panel owns that), so only switch the picker.
  const pick = (m: LedEffect) => {
    hapticLight();
    setMode(m);
    if (m === 'meter_cpu' || m === 'meter_battery') {
      void api.setStripEffect(settings, strip, { effect: m, brightness: 100 }).then(onApplied);
    }
  };

  if (modes.length === 0) return null;

  return (
    <View>
      <Text style={styles.sectionLabel}>REACTIVE</Text>
      <Text style={styles.hint}>The bar shows live box stats — keeps going with the app closed.</Text>

      <View style={styles.chipRow}>
        {modes.map((m) => {
          const on = mode === m;
          return (
            <Pressable key={m} onPress={() => pick(m)}
              accessibilityRole="button" accessibilityState={{ selected: on }}
              accessibilityLabel={`Mode ${MODE_LABEL[m] ?? m}`}
              style={({ pressed }) => [styles.chip, on && styles.chipOn, pressed && styles.pressed]}>
              <Text style={[styles.chipText, on && styles.chipTextOn]}>{MODE_LABEL[m] ?? m}</Text>
            </Pressable>
          );
        })}
      </View>

      {(mode === 'meter_cpu' || mode === 'meter_battery') && (
        <MeterPanel settings={settings} strip={strip} kind={mode} active={active} onApplied={onApplied} />
      )}
      {mode === 'playtime' && (
        <PlaytimePanel settings={settings} strip={strip} active={active} onApplied={onApplied} />
      )}
    </View>
  );
}
