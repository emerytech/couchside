import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { usePoll } from '@/hooks/usePoll';
import { api, Tv, TvKey, TvOp } from '@/lib/api';
import { GamepadClient } from '@/lib/gamepad';
import { hapticLight } from '@/lib/haptics';
import { Settings } from '@/lib/settings';
import { mono, theme } from '@/lib/theme';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

/**
 * Traditional TV-remote layout for the Pad tab: big circular D-pad with OK,
 * corner keys, volume/brightness rockers, Steam + QAM, source row.
 *
 * Two nav targets when the box's display is a Newline panel on RS-232 (the
 * agent reports tv.keys): BOX drives the box over the virtual gamepad
 * (D-pad/A/B), TV emulates the Newline factory remote over serial (arrows/OK/
 * menu/home/back/settings/brightness). Without RS-232 only BOX exists and the
 * TV-specific clusters stay hidden — CEC/soft setups keep a clean remote.
 */
export function RemoteView({
  client,
  settings,
}: {
  client: GamepadClient;
  settings: Settings;
}) {
  // TV caps, self-polled: cheap, and the strip adapts if the backend changes.
  // Deliberately does NOT gate on tvPoll.error: usePoll keeps last-good data
  // through a transient failure, and dropping the caps there would silently
  // flip the nav target from TV to BOX mid-interaction (one lost poll would
  // turn OSD arrow presses into gamepad presses inside a game). A box with no
  // backend never yields data (404), so the TV clusters still stay hidden.
  const tvPoll = usePoll<Tv>(() => api.tv(settings), 15000, true);
  const tv = tvPoll.data?.available ? tvPoll.data : null;
  const hasTvKeys = tv?.keys === true;
  const sources = tv?.sources ?? [];
  const canBlank = tv?.screen_toggle === true;

  const [target, setTarget] = useState<'box' | 'tv'>('box');
  const nav = hasTvKeys ? target : 'box';

  // ---- senders -------------------------------------------------------------

  const tvKey = useCallback(
    (k: TvKey) => {
      hapticLight();
      void api.tvKey(settings, k).catch(() => {});
    },
    [settings],
  );

  const padTap = useCallback(
    (k: 'du' | 'dd' | 'dl' | 'dr' | 'a' | 'b' | 'start' | 'select') => {
      hapticLight();
      client.sendButton(k, 1);
      setTimeout(() => client.sendButton(k, 0), 50);
    },
    [client],
  );

  const steam = useCallback(() => {
    hapticLight();
    client.sendButton('guide', 1);
    setTimeout(() => client.sendButton('guide', 0), 60);
  }, [client]);

  const qam = useCallback(() => {
    hapticLight();
    client.qamChord();
  }, [client]);

  const tvOp = useCallback(
    (op: TvOp) => {
      hapticLight();
      void api.tvSend(settings, op, settings.volumeTarget ?? 'box').catch(() => {});
    },
    [settings],
  );

  const blank = useCallback(() => {
    hapticLight();
    void api.tvScreenToggle(settings).catch(() => {});
  }, [settings]);

  const source = useCallback(
    (id: string) => {
      hapticLight();
      void api.tvSelectSource(settings, id).catch(() => {});
    },
    [settings],
  );

  // Nav cluster routing: BOX = virtual gamepad, TV = factory-remote serial keys.
  const navUp = () => (nav === 'tv' ? tvKey('up') : padTap('du'));
  const navDown = () => (nav === 'tv' ? tvKey('down') : padTap('dd'));
  const navLeft = () => (nav === 'tv' ? tvKey('left') : padTap('dl'));
  const navRight = () => (nav === 'tv' ? tvKey('right') : padTap('dr'));
  const navOk = () => (nav === 'tv' ? tvKey('ok') : padTap('a'));
  const navBack = () => (nav === 'tv' ? tvKey('back') : padTap('b'));
  const navMenu = () => (nav === 'tv' ? tvKey('menu') : padTap('start'));
  const navHome = () => (nav === 'tv' ? tvKey('home') : steam());
  const navSettings = () => (nav === 'tv' ? tvKey('settings') : padTap('select'));

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}>
      {/* Nav target toggle — only meaningful with an RS-232 panel */}
      {hasTvKeys && (
        <View style={styles.targetRow}>
          <View style={styles.targetSeg}>
            {(['box', 'tv'] as const).map((t) => (
              <Pressable
                key={t}
                onPress={() => {
                  hapticLight();
                  setTarget(t);
                }}
                style={[styles.seg, target === t && styles.segActive]}>
                <Text style={[styles.segText, target === t && styles.segTextActive]}>
                  {t === 'box' ? 'BOX' : 'TV'}
                </Text>
              </Pressable>
            ))}
          </View>
          {canBlank && (
            <Pressable onPress={blank} style={({ pressed }) => [styles.pwr, pressed && styles.pressed]}>
              <Ionicons name="power" size={20} color={theme.red} />
            </Pressable>
          )}
        </View>
      )}

      {/* Corner keys + D-pad */}
      <View style={styles.navBlock}>
        <View style={styles.cornerRow}>
          <CornerBtn icon="menu" label="MENU" onPress={navMenu} />
          <CornerBtn icon="settings-outline" label={nav === 'tv' ? 'SETTINGS' : 'VIEW'} onPress={navSettings} />
        </View>

        <Dpad
          onUp={navUp}
          onDown={navDown}
          onLeft={navLeft}
          onRight={navRight}
          onOk={navOk}
        />

        <View style={styles.cornerRow}>
          <CornerBtn icon="arrow-undo" label="BACK" onPress={navBack} />
          <CornerBtn
            icon={nav === 'tv' ? 'home-outline' : 'logo-steam'}
            label={nav === 'tv' ? 'HOME' : 'STEAM'}
            onPress={navHome}
          />
        </View>
      </View>

      {/* Rockers + center stack (vol | mute/blank | brightness) */}
      <View style={styles.rockerRow}>
        <Rocker
          label="VOL"
          onPlus={() => tvOp('volume_up')}
          onMinus={() => tvOp('volume_down')}
        />
        <View style={styles.midStack}>
          <MidBtn icon="volume-mute" label="MUTE" color={theme.red} onPress={() => tvOp('mute')} />
          <MidBtn icon="logo-steam" label="STEAM" color={theme.green} onPress={steam} />
          <MidBtn icon="ellipsis-horizontal" label="QAM" color={theme.amber} onPress={qam} />
        </View>
        {hasTvKeys ? (
          <Rocker
            label="BRT"
            onPlus={() => tvKey('bright_up')}
            onMinus={() => tvKey('bright_down')}
          />
        ) : (
          <View style={styles.rockerGhost} />
        )}
      </View>

      {/* Source row (RS-232 panels only) */}
      {sources.length > 0 && (
        <View style={styles.sourceRow}>
          {sources.map((s) => {
            const isBox = s.id === 'ops';
            return (
              <Pressable
                key={s.id}
                onPress={() => source(s.id)}
                style={({ pressed }) => [
                  styles.sourcePill,
                  isBox && styles.sourcePillBox,
                  pressed && styles.pressed,
                ]}>
                <Text style={[styles.sourceText, isBox && { color: theme.green }]}>
                  {isBox ? 'BOX' : s.label.toUpperCase()}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}
    </ScrollView>
  );
}

// ---- pieces ----------------------------------------------------------------

function CornerBtn({
  icon,
  label,
  onPress,
}: {
  icon: IoniconName;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.corner, pressed && styles.pressed]}>
      <Ionicons name={icon} size={17} color={theme.text} />
      <Text style={styles.cornerText}>{label}</Text>
    </Pressable>
  );
}

/**
 * The circular D-pad: a light ring of four wedge buttons around a bright OK
 * disc, echoing a classic TV remote (light pad on dark chrome).
 */
function Dpad({
  onUp,
  onDown,
  onLeft,
  onRight,
  onOk,
}: {
  onUp: () => void;
  onDown: () => void;
  onLeft: () => void;
  onRight: () => void;
  onOk: () => void;
}) {
  return (
    <View style={styles.dpad}>
      <Pressable onPress={onUp} style={({ pressed }) => [styles.wedge, styles.wedgeUp, pressed && styles.wedgePressed]}>
        <Ionicons name="chevron-up" size={26} color="#0b1220" />
      </Pressable>
      <Pressable onPress={onDown} style={({ pressed }) => [styles.wedge, styles.wedgeDown, pressed && styles.wedgePressed]}>
        <Ionicons name="chevron-down" size={26} color="#0b1220" />
      </Pressable>
      <Pressable onPress={onLeft} style={({ pressed }) => [styles.wedge, styles.wedgeLeft, pressed && styles.wedgePressed]}>
        <Ionicons name="chevron-back" size={26} color="#0b1220" />
      </Pressable>
      <Pressable onPress={onRight} style={({ pressed }) => [styles.wedge, styles.wedgeRight, pressed && styles.wedgePressed]}>
        <Ionicons name="chevron-forward" size={26} color="#0b1220" />
      </Pressable>
      <Pressable onPress={onOk} style={({ pressed }) => [styles.ok, pressed && styles.okPressed]}>
        <Text style={styles.okText}>OK</Text>
      </Pressable>
    </View>
  );
}

function Rocker({
  label,
  onPlus,
  onMinus,
}: {
  label: string;
  onPlus: () => void;
  onMinus: () => void;
}) {
  return (
    <View style={styles.rocker}>
      <Pressable onPress={onPlus} style={({ pressed }) => [styles.rockerBtn, pressed && styles.pressed]}>
        <Ionicons name="add" size={26} color={theme.text} />
      </Pressable>
      <Text style={styles.rockerLabel}>{label}</Text>
      <Pressable onPress={onMinus} style={({ pressed }) => [styles.rockerBtn, pressed && styles.pressed]}>
        <Ionicons name="remove" size={26} color={theme.text} />
      </Pressable>
    </View>
  );
}

function MidBtn({
  icon,
  label,
  color,
  onPress,
}: {
  icon: IoniconName;
  label: string;
  color: string;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.mid, pressed && styles.pressed]}>
      <Ionicons name={icon} size={18} color={color} />
      <Text style={[styles.midText, { color }]}>{label}</Text>
    </Pressable>
  );
}

// ---- styles ----------------------------------------------------------------

const DPAD = 216;
const WEDGE = 74;
const OK = 88;

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingBottom: 16, gap: 14 },
  pressed: { opacity: 0.6 },

  targetRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  targetSeg: {
    flex: 1,
    flexDirection: 'row',
    gap: 2,
    padding: 2,
    borderRadius: 10,
    backgroundColor: theme.inset,
    borderWidth: 1,
    borderColor: theme.cardBorder,
  },
  seg: { flex: 1, paddingVertical: 9, borderRadius: 8, alignItems: 'center' },
  segActive: { backgroundColor: theme.card, borderWidth: 1, borderColor: theme.blue },
  segText: { color: theme.textDim, fontSize: 12, fontWeight: '700', fontFamily: mono },
  segTextActive: { color: theme.blue },
  pwr: {
    width: 44,
    height: 40,
    borderRadius: 10,
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: 'rgba(248,113,113,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  navBlock: { gap: 6 },
  cornerRow: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 8 },
  corner: {
    minWidth: 92,
    alignItems: 'center',
    gap: 3,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.cardBorder,
  },
  cornerText: {
    color: theme.textDim,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1,
    fontFamily: mono,
  },

  dpad: {
    width: DPAD,
    height: DPAD,
    borderRadius: DPAD / 2,
    backgroundColor: '#e8edf6',
    alignSelf: 'center',
    marginVertical: 4,
  },
  wedge: {
    position: 'absolute',
    width: WEDGE,
    height: WEDGE,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: WEDGE / 2,
  },
  wedgePressed: { backgroundColor: 'rgba(11,18,32,0.12)' },
  wedgeUp: { top: 4, left: (DPAD - WEDGE) / 2 },
  wedgeDown: { bottom: 4, left: (DPAD - WEDGE) / 2 },
  wedgeLeft: { left: 4, top: (DPAD - WEDGE) / 2 },
  wedgeRight: { right: 4, top: (DPAD - WEDGE) / 2 },
  ok: {
    position: 'absolute',
    width: OK,
    height: OK,
    borderRadius: OK / 2,
    left: (DPAD - OK) / 2,
    top: (DPAD - OK) / 2,
    backgroundColor: '#f8fafc',
    borderWidth: 4,
    borderColor: '#0b1220',
    alignItems: 'center',
    justifyContent: 'center',
  },
  okPressed: { backgroundColor: '#cbd5e1' },
  okText: { color: '#0b1220', fontSize: 20, fontWeight: '800', fontFamily: mono },

  rockerRow: { flexDirection: 'row', justifyContent: 'center', gap: 12 },
  rocker: {
    width: 84,
    borderRadius: 42,
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.cardBorder,
    alignItems: 'center',
    paddingVertical: 6,
  },
  rockerGhost: { width: 84 },
  rockerBtn: {
    width: 72,
    height: 58,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rockerLabel: {
    color: theme.textDim,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 1,
    fontFamily: mono,
    paddingVertical: 4,
  },
  midStack: { justifyContent: 'space-between', gap: 8 },
  mid: {
    width: 108,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    paddingVertical: 13,
    borderRadius: 12,
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.cardBorder,
  },
  midText: { fontSize: 11, fontWeight: '800', letterSpacing: 0.5, fontFamily: mono },

  sourceRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8 },
  sourcePill: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.cardBorder,
  },
  sourcePillBox: { borderColor: 'rgba(52,211,153,0.5)' },
  sourceText: {
    color: theme.textDim,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.5,
    fontFamily: mono,
  },
});
