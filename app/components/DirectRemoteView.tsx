import Ionicons from '@expo/vector-icons/Ionicons';
import { useCallback, useState } from 'react';
import { Alert, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { hapticLight } from '@/lib/haptics';
import { DirectTv } from '@/lib/tvdirect/model';
import { RokuKey, RokuOp, rokuKey, rokuOp, rokuText } from '@/lib/tvdirect/roku';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

import { CornerBtn, Dpad, MidBtn, Rocker } from './RemoteView';

/** Shown once per app session: a Roku that 403s control needs its "Control by
 *  mobile apps" network access made permissive. Same rule and copy as
 *  RemoteView's agent-mediated path — the two can never be on screen together
 *  (one needs a box, the other needs remote-only mode), so a shared counter
 *  would be indistinguishable from this and buy nothing. */
let rokuHintShown = false;

/**
 * The remote for REMOTE-ONLY mode: this phone driving a smart TV directly, with
 * no Couchside box anywhere.
 *
 * It renders the SAME controls as RemoteView (Dpad/CornerBtn/Rocker/MidBtn are
 * imported from it) so the two modes do not drift into two remotes. What
 * differs is everything behind the press: RemoteView routes to a box's agent
 * over HTTP + a gamepad WebSocket, this sends ECP straight to the TV.
 *
 * There is no BOX/TV target toggle here (there is no box), no Steam or QAM
 * button, and no joystick — Roku has no pointer, so the OK disc is a plain OK
 * exactly as it is when RemoteView's target is a serial TV.
 */
export function DirectRemoteView({ tv }: { tv: DirectTv }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [circleSize, setCircleSize] = useState(200);
  const [muted, setMuted] = useState(false);
  const [textOpen, setTextOpen] = useState(false);
  const [textVal, setTextVal] = useState('');

  const onCircleLayout = useCallback(
    (e: { nativeEvent: { layout: { width: number; height: number } } }) => {
      const { width, height } = e.nativeEvent.layout;
      const s = Math.max(132, Math.min(240, Math.floor(Math.min(width, height)) - 4));
      setCircleSize((prev) => (Math.abs(prev - s) > 1 ? s : prev));
    },
    [],
  );

  // Every send goes through here so the 403 explanation exists in exactly one
  // place. Results are never thrown — the transport degrades closed by design.
  const report = useCallback((r: { ok: boolean; hint?: string }) => {
    if (!r.ok && r.hint === 'roku_control_disabled' && !rokuHintShown) {
      rokuHintShown = true;
      Alert.alert(
        'Roku is refusing control',
        'This Roku is set to block control from apps. On the Roku, open Settings → System → Advanced system settings → Control by mobile apps → Network access and choose Permissive.',
      );
    }
  }, []);

  const key = useCallback(
    (k: RokuKey) => {
      hapticLight();
      void rokuKey(tv.host, k).then(report);
    },
    [tv.host, report],
  );

  const op = useCallback(
    (o: RokuOp) => {
      hapticLight();
      void rokuOp(tv.host, o).then(report);
    },
    [tv.host, report],
  );

  const sendText = useCallback(() => {
    const s = textVal;
    setTextOpen(false);
    setTextVal('');
    if (s) void rokuText(tv.host, s).then(report);
  }, [textVal, tv.host, report]);

  return (
    <View style={styles.root}>
      {/* Power + keyboard row. Roku answers ECP in standby, so power ON is a
          real keypress here rather than the Wake-on-LAN dance the box path
          needs for webOS/Samsung. */}
      <View style={styles.topRow}>
        <Pressable
          onPress={() => op('power_off')}
          style={({ pressed }) => [styles.pwr, pressed && styles.pressed]}>
          <Ionicons name="power" size={20} color={t.red} />
          <Text style={[styles.pwrText, { color: t.red }]}>OFF</Text>
        </Pressable>
        <Pressable
          onPress={() => op('power_on')}
          style={({ pressed }) => [styles.pwr, pressed && styles.pressed]}>
          <Ionicons name="power" size={20} color={t.green} />
          <Text style={[styles.pwrText, { color: t.green }]}>ON</Text>
        </Pressable>
        <View style={styles.spacer} />
        <Pressable
          onPress={() => {
            hapticLight();
            setTextOpen(true);
          }}
          style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}>
          <Ionicons name="keypad" size={20} color={t.blue} />
        </Pressable>
      </View>

      <View style={styles.navBlock}>
        <View style={styles.cornerRow}>
          <CornerBtn icon="menu" label="OPTIONS" onPress={() => key('menu')} />
          <CornerBtn icon="home-outline" label="HOME" onPress={() => key('home')} />
        </View>

        <View style={styles.circleArea} onLayout={onCircleLayout}>
          <Dpad
            size={circleSize}
            onUp={() => key('up')}
            onDown={() => key('down')}
            onLeft={() => key('left')}
            onRight={() => key('right')}
            onOk={() => key('ok')}
            // No pointer on a Roku: the hold-to-point joystick would arm a
            // gesture that can send nothing. Same choice RemoteView makes when
            // its target is a serial TV.
            joyEnabled={false}
            onJoyMove={() => {}}
            onJoyActive={() => {}}
          />
        </View>

        <View style={styles.cornerRow}>
          <CornerBtn icon="arrow-undo" label="BACK" onPress={() => key('back')} />
          <CornerBtn icon="information-circle-outline" label="INFO" onPress={() => key('info')} />
        </View>
      </View>

      {/* Transport row. Roku has ONE key for play/pause/stop (Play toggles), so
          there is one button rather than three that would all do the same thing. */}
      <View style={styles.mediaRow}>
        <MidBtn icon="play-back" label="REW" color={t.text} onPress={() => key('rewind')} />
        <MidBtn icon="play" label="PLAY/PAUSE" color={t.text} onPress={() => key('play')} />
        <MidBtn icon="play-forward" label="FF" color={t.text} onPress={() => key('fast_forward')} />
      </View>

      <View style={styles.rockerRow}>
        <Rocker
          label="VOL"
          onPlus={() => op('volume_up')}
          onMinus={() => op('volume_down')}
        />
        <View style={styles.midStack}>
          <MidBtn
            icon={muted ? 'volume-mute' : 'volume-high'}
            label="MUTE"
            color={muted ? t.red : t.text}
            onPress={() => {
              setMuted((m) => !m);
              op('mute');
            }}
          />
        </View>
        {/* Balances the row against the VOL rocker: Roku exposes no brightness
            keys, and a dead rocker would be worse than an empty slot. */}
        <View style={styles.rockerGhost} />
      </View>

      <Modal visible={textOpen} transparent animationType="fade" onRequestClose={() => setTextOpen(false)}>
        <Pressable style={styles.textBackdrop} onPress={() => setTextOpen(false)}>
          <Pressable style={styles.textSheet} onPress={() => {}}>
            <Text style={styles.textTitle}>Send text to {tv.name}</Text>
            <Text style={styles.textHint}>
              Open a search or text box on the TV first — the letters are typed one at a time
              wherever its cursor already is.
            </Text>
            <TextInput
              value={textVal}
              onChangeText={setTextVal}
              placeholder="Type here…"
              placeholderTextColor={t.textFaint}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="send"
              onSubmitEditing={sendText}
              style={styles.textInput}
            />
            <View style={styles.textBtnRow}>
              <Pressable onPress={() => setTextOpen(false)} style={styles.textBtn}>
                <Text style={styles.textBtnCancel}>CANCEL</Text>
              </Pressable>
              <Pressable onPress={sendText} style={[styles.textBtn, styles.textBtnSendBg]}>
                <Text style={styles.textBtnSend}>SEND</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const makeStyles = (t: Palette) => StyleSheet.create({
  root: { flex: 1, gap: 10, paddingBottom: 6 },
  pressed: { opacity: 0.6 },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  spacer: { flex: 1 },
  pwr: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 40,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: t.card,
    borderWidth: 1,
    borderColor: t.cardBorder,
  },
  pwrText: { fontSize: 11, fontWeight: '800', letterSpacing: 1, fontFamily: mono },
  iconBtn: {
    width: 44,
    height: 40,
    borderRadius: 10,
    backgroundColor: t.card,
    borderWidth: 1,
    borderColor: t.cardBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  navBlock: { flex: 1, gap: 6, minHeight: 190 },
  circleArea: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  cornerRow: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 8 },
  mediaRow: { flexDirection: 'row', justifyContent: 'center', gap: 8 },
  rockerRow: { flexDirection: 'row', justifyContent: 'center', gap: 12 },
  rockerGhost: { width: 84 },
  midStack: { justifyContent: 'center' },
  textBackdrop: { flex: 1, backgroundColor: '#000a', justifyContent: 'center', padding: 24 },
  textSheet: {
    backgroundColor: t.card,
    borderColor: t.cardBorder,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    padding: 16,
    gap: 12,
  },
  textTitle: { color: t.text, fontSize: 15, fontWeight: '700' },
  textHint: { color: t.textDim, fontSize: 12, lineHeight: 17 },
  textInput: {
    backgroundColor: t.inset,
    borderColor: t.cardBorder,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    color: t.text,
    fontSize: 16,
  },
  textBtnRow: { flexDirection: 'row', gap: 10 },
  textBtn: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: 'center',
    backgroundColor: t.inset,
  },
  textBtnSendBg: { backgroundColor: t.blue },
  textBtnCancel: { color: t.textDim, fontWeight: '700', fontSize: 13 },
  textBtnSend: { color: t.bg, fontWeight: '800', fontSize: 13 },
});
