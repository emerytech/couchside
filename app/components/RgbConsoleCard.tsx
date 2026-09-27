/**
 * RGB (Console tab) — the COMPACT lighting card.
 *
 * Console used to stack three full lighting cards (StripLightCard, RgbLedCard,
 * OpenRgbCard), which "took over" the tab (owner, 2026-09-27). This one small
 * card replaces all three inline: a live preview (a row of the strip's current
 * colours, or one swatch for a single light / OpenRGB device), the current
 * effect + brightness, and a "Configure" button that opens the FULL controls in
 * RgbConfiguratorSheet. Nothing is lost — the sheet renders the three original
 * cards unchanged (reactive meters, playtime countdown, Game Aura, box themes,
 * per-LED paint, sequence frames).
 *
 * Probe-and-appear: it polls the SAME endpoints the cards do (GET /api/leds,
 * GET /api/openrgb) and renders NOTHING when the box has no controllable
 * lighting — the exact null-gate of the three cards, folded into `rgbSummary`.
 * So on a box with no lights this card is invisible, like today.
 *
 * The whole card is a button (harness-pressable, §6) that opens the sheet; a
 * long-press is still caught by the Console's EditableSection wrapper for
 * reorder/hide.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { RgbConfiguratorSheet } from '@/components/RgbConfiguratorSheet';
import { usePoll } from '@/hooks/usePoll';
import { api, hostKey, type LedsState, type OpenRgbState } from '@/lib/api';
import { hapticSelection } from '@/lib/haptics';
import { cssRgb } from '@/lib/ledColor';
import { rgbSummary } from '@/lib/rgbConsole';
import { useSettings } from '@/lib/SettingsContext';
import { useSkinKit } from '@/lib/skin';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

/** Lights don't change second-by-second; this is a slow backstop, like the
 *  cards it stands in for (both poll /api/leds at 15s). */
const POLL_MS = 15000;
/** Cap on preview dots so a 17-LED strip stays one tidy row. */
const MAX_SWATCHES = 6;

export function RgbConsoleCard() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { Card } = useSkinKit();
  const { settings, ready } = useSettings();
  const configured = !!settings.host && !!settings.token;
  const [open, setOpen] = useState(false);

  // The same two polls the three cards run — so this card appears in exactly the
  // cases at least one of them would. When the sheet is closed these are the
  // only lighting polls; the heavy cards only mount (and poll) inside the sheet.
  const ledsPoll = usePoll<LedsState | null>(
    () => api.leds(settings), POLL_MS, ready && configured, hostKey(settings));
  const orgbPoll = usePoll<OpenRgbState | null>(
    () => api.openrgb(settings), POLL_MS, ready && configured, hostKey(settings));

  const summary = rgbSummary(ledsPoll.data, orgbPoll.data, MAX_SWATCHES);

  // Probe-and-appear: no controllable lighting -> render nothing (no dead card).
  if (!summary) return null;

  const openSheet = () => {
    hapticSelection();
    setOpen(true);
  };

  const brightnessText = summary.brightness != null ? ` · ${Math.round(summary.brightness)}%` : '';
  const moreText = summary.surfaces > 1 ? `  +${summary.surfaces - 1} more` : '';

  return (
    <>
      <Card title="RGB">
        <Pressable
          onPress={openSheet}
          accessibilityRole="button"
          accessibilityLabel="Open RGB configurator"
          style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
          {/* Live preview: the strip's current colours, or one swatch. */}
          <View style={styles.swatches}>
            {summary.swatches.map((c, i) => (
              <View
                key={i}
                style={[styles.swatch, { backgroundColor: cssRgb(c) }]}
              />
            ))}
          </View>

          <View style={styles.meta}>
            <Text style={styles.device} numberOfLines={1}>
              {summary.device}
            </Text>
            <Text style={styles.effect} numberOfLines={1}>
              {summary.effectLabel}
              {brightnessText}
              {moreText ? <Text style={styles.more}>{moreText}</Text> : null}
            </Text>
          </View>

          <View style={styles.cta} pointerEvents="none">
            <Text style={styles.ctaText}>Configure</Text>
            <Ionicons name="chevron-forward" size={16} color={t.blue} />
          </View>
        </Pressable>
      </Card>

      <RgbConfiguratorSheet visible={open} onClose={() => setOpen(false)} />
    </>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    pressed: { opacity: 0.7 },
    swatches: { flexDirection: 'row', gap: 3, flexShrink: 0 },
    swatch: {
      width: 13,
      height: 13,
      borderRadius: 3,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.cardBorder,
    },
    meta: { flex: 1, minWidth: 0 },
    device: { color: t.text, fontSize: 13, fontWeight: '700' },
    more: { color: t.textFaint, fontSize: 12, fontWeight: '600' },
    effect: { color: t.textDim, fontSize: 12, fontFamily: mono, marginTop: 2 },
    cta: { flexDirection: 'row', alignItems: 'center', gap: 2 },
    ctaText: { color: t.blue, fontSize: 13, fontWeight: '700' },
  });
