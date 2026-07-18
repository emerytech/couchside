import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { usePoll } from '@/hooks/usePoll';
import { api, ConnSettings, hostKey, Tv, TvPairResult } from '@/lib/api';
import { normalizeMac } from '@/lib/settings';
import { useTheme, useThemedStyles, type Palette } from '@/lib/theme';

type Brand = 'webos' | 'samsung' | 'roku' | 'androidtv' | 'vidaa';

const BRANDS: { id: Brand; label: string; needsMac: boolean; verb: string }[] = [
  { id: 'webos', label: 'LG', needsMac: true, verb: 'Pair' },
  { id: 'samsung', label: 'Samsung', needsMac: true, verb: 'Pair' },
  { id: 'roku', label: 'Roku', needsMac: false, verb: 'Add' },
  { id: 'androidtv', label: 'Google TV', needsMac: true, verb: 'Pair' },
  { id: 'vidaa', label: 'Hisense', needsMac: true, verb: 'Add' },
];

const NETWORK_BACKENDS = ['webos', 'samsung', 'roku', 'androidtv', 'vidaa'];

/**
 * Pair a networked smart TV (LG webOS / Samsung Tizen / Roku / Android-Google TV)
 * to the box so the Pad tab's D-pad drives it. webOS/Samsung show an accept
 * prompt on the TV; Roku needs no pairing; Android/Google TV is two-step (a
 * 6-digit code appears on the TV, entered here). The box's agent owns the
 * connection — the phone only kicks off pairing over the LAN.
 */
export function SmartTvSetup({ settings }: { settings: ConnSettings }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [brand, setBrand] = useState<Brand>('webos');
  const [host, setHost] = useState('');
  const [mac, setMac] = useState('');
  const [code, setCode] = useState('');
  const [awaitingCode, setAwaitingCode] = useState(false); // androidtv step 2
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const tvPoll = usePoll<Tv>(() => api.tv(settings), 15000, true, hostKey(settings));
  const active =
    tvPoll.data?.available && NETWORK_BACKENDS.includes(tvPoll.data.backend)
      ? tvPoll.data
      : null;
  const meta = BRANDS.find((b) => b.id === brand)!;

  const connected = useCallback(
    (r: TvPairResult) => {
      setMsg({ ok: true, text: r.name ? `Connected: ${r.name}` : `Connected to ${meta.label}.` });
      setHost('');
      setMac('');
      setCode('');
      setAwaitingCode(false);
    },
    [meta],
  );

  const submit = useCallback(async () => {
    const h = host.trim();
    if (!h) {
      setMsg({ ok: false, text: 'Enter the TV’s IP address.' });
      return;
    }
    setBusy(true);
    const m = meta.needsMac && mac.trim() ? normalizeMac(mac.trim()) ?? undefined : undefined;
    try {
      if (brand === 'androidtv') {
        // Step 1: open the pairing socket -> TV shows a 6-digit code.
        setMsg({ ok: true, text: 'Opening pairing on the TV…' });
        const r = await api.tvAndroidtvPairStart(settings, h);
        if (r.ok && r.code_shown) {
          setAwaitingCode(true);
          setMsg({ ok: true, text: 'Enter the 6-digit code now showing on the TV.' });
        } else {
          setMsg({ ok: false, text: r.error ?? 'Could not start pairing.' });
        }
        return;
      }
      setMsg({
        ok: true,
        text:
          brand === 'roku' || brand === 'vidaa'
            ? 'Contacting the TV…'
            : 'Waiting for you to accept on the TV…',
      });
      let r: TvPairResult;
      if (brand === 'webos') r = await api.tvPairWebos(settings, h, m);
      else if (brand === 'samsung') r = await api.tvPairSamsung(settings, h, m);
      else if (brand === 'vidaa') r = await api.tvAddVidaa(settings, h, m);
      else r = await api.tvAddRoku(settings, h);
      if (r.ok) connected(r);
      else setMsg({ ok: false, text: r.error ?? 'Could not connect to the TV.' });
    } catch {
      setMsg({ ok: false, text: 'Could not reach the box or TV. Check the IP and try again.' });
    } finally {
      setBusy(false);
    }
  }, [brand, host, mac, meta, settings, connected]);

  const finishAndroidtv = useCallback(async () => {
    const c = code.trim();
    if (c.length !== 6) {
      setMsg({ ok: false, text: 'Enter the 6-digit code from the TV.' });
      return;
    }
    setBusy(true);
    setMsg({ ok: true, text: 'Pairing…' });
    try {
      const m = mac.trim() ? normalizeMac(mac.trim()) ?? undefined : undefined;
      const r = await api.tvAndroidtvPairFinish(settings, c, m);
      if (r.ok) connected(r);
      else setMsg({ ok: false, text: r.error ?? 'Pairing failed — check the code and retry.' });
    } catch {
      setMsg({ ok: false, text: 'Could not reach the box. Try again.' });
    } finally {
      setBusy(false);
    }
  }, [code, mac, settings, connected]);

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Smart TV remote</Text>
      <Text style={styles.sub}>
        Control a networked TV — LG webOS, Samsung, Roku, or Google TV — from the Pad tab. The
        D-pad and on-screen keyboard light up once it’s connected.
      </Text>

      {active ? (
        <View style={styles.activeRow}>
          <Ionicons name="tv" size={16} color={t.green} />
          <Text style={styles.activeText}>Connected: {active.adapter}</Text>
        </View>
      ) : null}

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.segment}>
        {BRANDS.map((b) => (
          <Pressable
            key={b.id}
            onPress={() => {
              setBrand(b.id);
              setMsg(null);
              setAwaitingCode(false);
              setCode('');
            }}
            style={[styles.seg, brand === b.id && styles.segOn]}>
            <Text style={[styles.segText, brand === b.id && styles.segTextOn]}>{b.label}</Text>
          </Pressable>
        ))}
      </ScrollView>

      {awaitingCode ? (
        <>
          <TextInput
            value={code}
            onChangeText={(v) => setCode(v.replace(/[^0-9A-Fa-f]/g, '').slice(0, 6))}
            placeholder="6-digit code from the TV"
            placeholderTextColor={t.textFaint}
            autoCapitalize="characters"
            autoCorrect={false}
            keyboardType="visible-password"
            editable={!busy}
            style={styles.input}
          />
          <Pressable
            onPress={finishAndroidtv}
            disabled={busy}
            style={[styles.button, busy && styles.buttonBusy]}>
            {busy ? (
              <ActivityIndicator color={t.bg} />
            ) : (
              <Text style={styles.buttonText}>Finish pairing</Text>
            )}
          </Pressable>
        </>
      ) : (
        <>
          <TextInput
            value={host}
            onChangeText={setHost}
            placeholder="TV IP address (e.g. 192.168.1.50)"
            placeholderTextColor={t.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="numbers-and-punctuation"
            editable={!busy}
            style={styles.input}
          />
          {meta.needsMac ? (
            <TextInput
              value={mac}
              onChangeText={setMac}
              placeholder="MAC for power-on (optional)"
              placeholderTextColor={t.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!busy}
              style={styles.input}
            />
          ) : null}
          <Pressable
            onPress={submit}
            disabled={busy}
            style={[styles.button, busy && styles.buttonBusy]}>
            {busy ? (
              <ActivityIndicator color={t.bg} />
            ) : (
              <Text style={styles.buttonText}>
                {meta.verb} {meta.label}
              </Text>
            )}
          </Pressable>
        </>
      )}

      {msg ? (
        <Text style={[styles.msg, { color: msg.ok ? t.textDim : t.red }]}>{msg.text}</Text>
      ) : null}

      <Text style={styles.hint}>
        {brand === 'roku'
          ? 'No pairing needed — just make sure the Roku is on and on this network. If the D-pad does not respond after adding, enable control on the Roku: Settings → System → Advanced system settings → Control by mobile apps → Network access → Permissive.'
          : brand === 'vidaa'
            ? 'No pairing needed — just make sure the TV is on and on this network. The MAC is optional (Wake-on-LAN power-on).'
          : brand === 'androidtv'
            ? 'Your Android/Google TV must be on. After “Pair”, a 6-digit code appears on the TV — enter it here. The MAC is optional (Wake-on-LAN power-on).'
            : `Your ${meta.label} TV must be on. An accept prompt appears on the TV — say yes. The MAC is optional and lets the box wake the TV over the network.`}
      </Text>
    </View>
  );
}

const makeStyles = (t: Palette) => StyleSheet.create({
  card: {
    backgroundColor: t.card,
    borderColor: t.cardBorder,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    padding: 16,
    gap: 10,
  },
  title: { color: t.text, fontSize: 16, fontWeight: '700' },
  sub: { color: t.textDim, fontSize: 13, lineHeight: 18 },
  activeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: t.inset,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  activeText: { color: t.text, fontSize: 13, fontWeight: '600', flexShrink: 1 },
  segment: {
    flexDirection: 'row',
    backgroundColor: t.inset,
    borderRadius: 10,
    padding: 3,
    gap: 3,
  },
  seg: { paddingVertical: 9, paddingHorizontal: 16, borderRadius: 8, alignItems: 'center' },
  segOn: { backgroundColor: t.blue },
  segText: { color: t.textDim, fontSize: 13, fontWeight: '600' },
  segTextOn: { color: t.bg },
  input: {
    backgroundColor: t.inset,
    borderColor: t.cardBorder,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    color: t.text,
    fontSize: 14,
  },
  button: {
    backgroundColor: t.green,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  buttonBusy: { opacity: 0.7 },
  buttonText: { color: t.bg, fontSize: 15, fontWeight: '700' },
  msg: { fontSize: 13, lineHeight: 18 },
  hint: { color: t.textFaint, fontSize: 12, lineHeight: 16 },
});
