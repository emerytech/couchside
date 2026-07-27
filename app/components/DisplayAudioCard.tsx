/**
 * DISPLAY & AUDIO (Console tab) — what the box is actually driving: the mode,
 * the panel it is plugged into, HDR/VRR, and the default audio out/in.
 *
 * Probe-and-appear, the BootSessionCard shape exactly: a 404 (agent too old)
 * or `available: false` (nothing readable on this box) renders NOTHING. There
 * is no placeholder card, because a card full of dashes is worse than no card.
 *
 * WHY EVERY ROW IS DEFENSIVE, and why that is not paranoia: no single source on
 * a Linux box answers all of this. The current mode comes from the compositor
 * and only exists in Game Mode; the panel name and preferred mode come from
 * EDID and exist headless; HDR/VRR state is readable on some paths and simply
 * is not on others. The agent omits what it could not read (CLAUDE.md §3.7,
 * degrade closed), so an absent field means "couldn't tell" and renders as a
 * dim em dash. It must never be rendered as a value, and never as an error —
 * "couldn't read the refresh rate" is not a fault condition, it is Tuesday.
 *
 * THE CLAIM THIS CARD IS CAREFUL NOT TO MAKE: a preferred mode from EDID and a
 * list of valid refresh rates are CAPABILITIES, not the current state. On most
 * boxes they happen to equal what is being scanned out, so printing them as
 * "RESOLUTION / REFRESH" unqualified would look right everywhere except the one
 * box where it is wrong. Where a value is a capability the row says so, in the
 * value itself, every time.
 *
 * Slow cadence on purpose: this is three subprocesses on the box (compositor
 * query + two WirePlumber reads) and a monitor does not change while you watch
 * it. The refresh control in the header is how you get an answer NOW — after
 * plugging in a TV, or switching to Game Mode.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { usePoll } from '@/hooks/usePoll';
import { api, hostKey, type DisplayInfo, type DisplayMode } from '@/lib/api';
import { hapticLight } from '@/lib/haptics';
import { useSkinKit } from '@/lib/skin';
import { useSettings } from '@/lib/SettingsContext';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

/** A monitor's specs do not change while you look at them. */
const POLL_MS = 30000;

/** The one thing an unreadable field is allowed to render as. */
const DASH = '—';

/** 60 -> "60", 59.955 -> "59.96". Trailing zeros dropped so an integer rate
 *  does not read as a suspiciously precise measurement. */
function fmtHz(hz: number): string {
  return String(Number(hz.toFixed(2)));
}

function fmtSize(m: DisplayMode): string {
  return `${m.width} × ${m.height}`;
}

/** What to print for a value that has a live state, a capability, or neither.
 *  Order matters: an explicit "not supported" outranks any claimed state, so a
 *  panel that says it cannot do HDR can never be labelled HDR ON. An unknown
 *  live state falls back to the capability word, never to "off". */
function stateWord(supported?: boolean, on?: boolean): string {
  if (supported === false) return 'not supported';
  if (on === true) return 'on';
  if (on === false) return 'off';
  if (supported === true) return 'supported';
  return DASH;
}

/**
 * One label/value row. `note` is the qualifier that keeps the card honest
 * ("preferred", "supported") and renders dim, right after the value.
 *
 * numberOfLines={1} is load-bearing, not polish: an audio device description
 * ("Thinkcentre TIO24Gen3Touch for USB-audio Analog Stereo") is 52 characters
 * and will shove the label off the left edge on a phone if it is allowed to
 * wrap or grow.
 */
function Row({
  label,
  value,
  note,
  dim,
}: {
  label: string;
  value: string;
  note?: string;
  dim?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View
      style={styles.lineRow}
      accessible
      accessibilityRole="text"
      accessibilityLabel={
        value === DASH
          ? `${label}: unavailable`
          : `${label}: ${value}${note ? `, ${note}` : ''}`
      }>
      <Text style={styles.lineLabel}>{label}</Text>
      <Text
        style={[styles.lineVal, (dim || value === DASH) && styles.lineValDim]}
        numberOfLines={1}>
        {value}
        {note ? <Text style={styles.note}>{`  ${note}`}</Text> : null}
      </Text>
    </View>
  );
}

export function DisplayAudioCard() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { Card } = useSkinKit();
  const { settings, ready } = useSettings();
  const configured = !!settings.host && !!settings.token;

  const poll = usePoll<DisplayInfo | null>(
    () => api.displayInfo(settings), POLL_MS, ready && configured, hostKey(settings));

  const d = poll.data;
  // Absent capability or old agent -> render nothing at all.
  if (!d || !d.available) return null;

  const disp = d.display;
  const audio = d.audio;
  // available:true with both halves missing would be an agent bug, but it
  // would render as a card of six dashes, so treat it the same as absent.
  if (!disp && !audio) return null;

  // Resolution and refresh are resolved SEPARATELY from the same three
  // candidate sources, because the compositor can answer one and not the other
  // (the measured Game Mode path gives a size with no rate). Each carries the
  // note that says which kind of answer it is.
  let resValue = DASH;
  let resNote: string | undefined;
  if (disp?.mode) {
    resValue = fmtSize(disp.mode);
  } else if (disp?.preferred_mode) {
    resValue = fmtSize(disp.preferred_mode);
    resNote = 'preferred';
  }

  let hzValue = DASH;
  let hzNote: string | undefined;
  if (disp?.mode?.refresh_hz != null) {
    hzValue = `${fmtHz(disp.mode.refresh_hz)} Hz`;
  } else if (disp?.preferred_mode?.refresh_hz != null) {
    hzValue = `${fmtHz(disp.preferred_mode.refresh_hz)} Hz`;
    hzNote = 'preferred';
  } else if (disp?.refresh_rates_hz?.length) {
    // The compositor's list of VALID rates. On a 60-only panel this is [60],
    // which is exactly the case that would pass for a current reading.
    hzValue = `${disp.refresh_rates_hz.map(fmtHz).join(' / ')} Hz`;
    hzNote = 'supported';
  }

  const hdr = stateWord(disp?.hdr?.supported, disp?.hdr?.enabled);
  const vrr = stateWord(disp?.vrr?.supported, disp?.vrr?.active);

  // The panel's own name. Manufacturer only as a fallback: "Lenovo Group
  // Limited TIO24Gen3T" does not fit a phone row, and the model is the half
  // that identifies the thing in front of you.
  const monitor = disp?.monitor || disp?.make || DASH;

  const connector = disp?.connector || DASH;
  const connNote =
    disp?.connector == null
      ? undefined
      : [
          disp.connected === true ? 'connected' : disp.connected === false ? 'no signal' : null,
          disp.internal === true ? 'built-in' : disp.internal === false ? 'external' : null,
        ]
          .filter(Boolean)
          .join(' · ') || undefined;

  return (
    <Card index={6}>
      <View style={styles.header}>
        <Text style={styles.cardTitle}>DISPLAY / AUDIO</Text>
        <Pressable
          onPress={() => {
            hapticLight();
            poll.refresh();
          }}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Refresh display and audio info"
          style={({ pressed }) => [styles.refreshBtn, pressed && styles.pressed]}>
          <Ionicons name="refresh" size={13} color={t.textDim} />
        </Pressable>
      </View>

      {disp && (
        <View style={styles.block}>
          <Row label="RES" value={resValue} note={resNote} />
          <Row label="REFRESH" value={hzValue} note={hzNote} />
          <Row label="HDR" value={hdr} dim={hdr !== 'on'} />
          <Row label="VRR" value={vrr} dim={vrr !== 'on'} />
          <Row label="MONITOR" value={monitor} />
          <Row label="OUTPUT" value={connector} note={connNote} />
        </View>
      )}

      {audio && (
        <View style={styles.block}>
          <Text style={styles.sectionLabel}>AUDIO</Text>
          <Row label="OUT" value={audio.output || DASH} />
          <Row label="IN" value={audio.input || DASH} />
        </View>
      )}
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
    pressed: { opacity: 0.7 },

    block: { gap: 6 },
    sectionLabel: {
      color: t.textFaint,
      fontSize: 10,
      fontWeight: '700',
      letterSpacing: 1.2,
      fontFamily: mono,
      marginTop: 10,
    },
    lineRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    lineLabel: {
      color: t.textDim,
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 0.8,
      fontFamily: mono,
      minWidth: 62,
    },
    // flex + right-align rather than marginLeft:'auto': a long value has to
    // SHRINK inside the row, not push the label out of it.
    lineVal: {
      color: t.text,
      fontSize: 14,
      fontFamily: mono,
      flex: 1,
      textAlign: 'right',
    },
    lineValDim: { color: t.textFaint },
    note: { color: t.textFaint, fontSize: 12, fontFamily: mono },
  });
