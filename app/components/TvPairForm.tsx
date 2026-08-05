import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { ApiError, DiscoveredTv, TvIdentifyResult, TvPairResult } from '@/lib/api';
import { hapticError, hapticSuccess } from '@/lib/haptics';
import { normalizeMac } from '@/lib/settings';
import { ALL_BRANDS, type Brand, type TvPairDriver } from '@/lib/tvPairDriver';
import { useTheme, useThemedStyles, type Palette } from '@/lib/theme';

/**
 * The shared TV-pairing form: brand picker, LAN scan, IP + optional MAC, the
 * Android TV two-step code entry, and a result line. Extracted from
 * SmartTvSetup so ONE form serves both the box-mediated path and the box-less
 * direct path — the difference is entirely in the injected `driver`
 * (lib/tvPairDriver). Everything here — the identify-then-act flow, the
 * blocked/force-pair escape hatch, the settled-vs-narration message split — is
 * lifted verbatim from the shipping SmartTvSetup so a box owner sees no change.
 *
 * `onPaired` fires on a settled success, for the caller to react (a box refreshes
 * its /api/tv poll; the direct path lets its store subscription repaint).
 */

/**
 * A pairing error the user can act on. A box driver throws ApiError, whose http
 * kind carries the box's own reason (e.g. "could not persist config: Permission
 * denied") — surfaced verbatim rather than as a blanket network error. The
 * direct driver returns {ok:false,error} instead of throwing, so this just
 * returns the fallback for it.
 */
function pairErr(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    if (e.kind === 'http') return `${fallback} — box says: ${e.message}`;
    return `${fallback} (${e.kind})`;
  }
  return fallback;
}

/** identify names devices we cannot pair ("lg_commercial", null); anything
 *  outside the roster falls back to the user's selection. */
function pairableBrand(b: TvIdentifyResult['brand']): Brand | null {
  return ALL_BRANDS.some((x) => x.id === b) ? (b as Brand) : null;
}

export function TvPairForm({
  driver,
  onPaired,
}: {
  driver: TvPairDriver;
  onPaired?: () => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [brand, setBrand] = useState<Brand>(() => driver.brands[0]?.id ?? 'roku');
  const [host, setHost] = useState('');
  const [mac, setMac] = useState('');
  const [code, setCode] = useState('');
  const [awaitingCode, setAwaitingCode] = useState(false); // androidtv step 2
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; done?: boolean } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [found, setFound] = useState<DiscoveredTv[] | null>(null);
  const [blocked, setBlocked] = useState<{ host: string; commercial: boolean } | null>(null);
  const [brandKnown, setBrandKnown] = useState(false);
  const [brandOpen, setBrandOpen] = useState(false);

  // Brand LABELS are universal, so meta reads from the full roster even when the
  // driver only offers a subset (the picker chips below use driver.brands).
  const meta = ALL_BRANDS.find((b) => b.id === brand) ?? ALL_BRANDS[0];

  // Haptic on a SETTLED outcome only; in-flight narration (msg.done falsy) stays
  // quiet — buzzing on "Waiting for you to accept on the TV…" is noise.
  useEffect(() => {
    if (!msg?.done) return;
    if (msg.ok) hapticSuccess();
    else hapticError();
  }, [msg]);

  const connected = useCallback(
    (r: TvPairResult, label: string) => {
      setMsg({ ok: true, done: true, text: r.name ? `Connected: ${r.name}` : `Connected to ${label}.` });
      setHost('');
      setMac('');
      setCode('');
      setAwaitingCode(false);
      setFound(null);
      setBlocked(null);
      onPaired?.();
    },
    [onPaired],
  );

  const scan = useCallback(async () => {
    setScanning(true);
    setMsg(null);
    try {
      const tvs = await driver.discover();
      setFound(tvs);
      if (tvs.length === 0) {
        setMsg({ ok: false, done: true, text: 'No TVs found on the network — enter the IP below.' });
      }
    } catch (e: unknown) {
      setFound([]);
      setMsg({
        ok: false,
        done: true,
        text:
          e instanceof ApiError && e.kind === 'http' && e.status === 404
            ? 'This box’s Couchside service is too old to scan — update it, or enter the IP below.'
            : 'Scan failed — enter the IP below.',
      });
    } finally {
      setScanning(false);
    }
  }, [driver]);

  const pick = useCallback((tv: DiscoveredTv) => {
    setBrand(tv.brand);
    setBrandKnown(true);
    setBrandOpen(false);
    setHost(tv.host);
    setAwaitingCode(false);
    setCode('');
    setBlocked(null);
    setMsg({ ok: true, text: `${tv.name} — tap ${ALL_BRANDS.find((b) => b.id === tv.brand)?.verb ?? 'Pair'} below.` });
  }, []);

  const runPair = useCallback(
    async (b: Brand, h: string) => {
      const bm = ALL_BRANDS.find((x) => x.id === b)!;
      const m = bm.needsMac && mac.trim() ? normalizeMac(mac.trim()) ?? undefined : undefined;
      if (b === 'androidtv') {
        setMsg({ ok: true, text: 'Opening pairing on the TV…' });
        const r = await driver.androidtvStart(h);
        if (r.ok && r.code_shown) {
          setAwaitingCode(true);
          setMsg({ ok: true, text: 'Enter the 6-digit code now showing on the TV.' });
        } else {
          setMsg({ ok: false, done: true, text: r.error ?? 'Could not start pairing.' });
        }
        return;
      }
      setMsg({
        ok: true,
        text: b === 'roku' || b === 'vidaa' ? 'Contacting the TV…' : 'Waiting for you to accept on the TV…',
      });
      const r = await driver.pair(b, h, m);
      if (r.ok) connected(r, bm.label);
      else setMsg({ ok: false, done: true, text: r.error ?? 'Could not connect to the TV.' });
    },
    [mac, driver, connected],
  );

  const submit = useCallback(async () => {
    const h = host.trim();
    if (!h) {
      setMsg({ ok: false, done: true, text: 'Enter the TV’s IP address.' });
      return;
    }
    setBusy(true);
    setBlocked(null);
    try {
      let id: TvIdentifyResult | null = null;
      try {
        setMsg({ ok: true, text: 'Identifying…' });
        id = await driver.identify(h);
      } catch (e: unknown) {
        // Old agents 404 identify; that MUST degrade to pairing the selected
        // brand. Any other error is real and rethrows.
        if (!(e instanceof ApiError && e.kind === 'http' && e.status === 404)) throw e;
      }

      if (id && id.brand === 'lg_commercial') {
        setBlocked({ host: h, commercial: true });
        setMsg({ ok: false, done: true, text: id.reason });
        return;
      }
      if (id && !id.supported) {
        setBlocked({ host: h, commercial: false });
        setMsg({ ok: false, done: true, text: id.reason });
        return;
      }

      const chosen = (id && pairableBrand(id.brand)) || brand;
      if (chosen !== brand) setBrand(chosen);
      await runPair(chosen, h);
    } catch (e: unknown) {
      setMsg({ ok: false, done: true, text: pairErr(e, 'Could not reach the box or TV. Check the IP and try again.') });
    } finally {
      setBusy(false);
    }
  }, [brand, host, driver, runPair]);

  const pairAnyway = useCallback(async () => {
    const h = host.trim();
    if (!h) return;
    setBusy(true);
    setBlocked(null);
    try {
      await runPair(brand, h);
    } catch (e: unknown) {
      setMsg({ ok: false, done: true, text: pairErr(e, 'Could not reach the box or TV. Check the IP and try again.') });
    } finally {
      setBusy(false);
    }
  }, [brand, host, runPair]);

  const addCommercial = useCallback(async () => {
    const h = blocked?.host ?? host.trim();
    if (!h) return;
    setBusy(true);
    setMsg({ ok: true, text: 'Contacting the display…' });
    try {
      const r = await driver.addLgCommercial(h);
      if (r.ok) connected(r, 'LG commercial display');
      else setMsg({ ok: false, done: true, text: r.error ?? 'Could not connect to the display.' });
    } catch (e: unknown) {
      setMsg({ ok: false, done: true, text: pairErr(e, 'Could not reach the box or display. Check the IP and try again.') });
    } finally {
      setBusy(false);
    }
  }, [blocked, host, driver, connected]);

  const finishAndroidtv = useCallback(async () => {
    const c = code.trim();
    if (c.length !== 6) {
      setMsg({ ok: false, done: true, text: 'Enter the 6-digit code from the TV.' });
      return;
    }
    setBusy(true);
    setMsg({ ok: true, text: 'Pairing…' });
    try {
      const m = mac.trim() ? normalizeMac(mac.trim()) ?? undefined : undefined;
      const r = await driver.androidtvFinish(c, m);
      if (r.ok) connected(r, 'Google TV');
      else setMsg({ ok: false, done: true, text: r.error ?? 'Pairing failed — check the code and retry.' });
    } catch (e: unknown) {
      setMsg({ ok: false, done: true, text: pairErr(e, 'Could not reach the box. Try again.') });
    } finally {
      setBusy(false);
    }
  }, [code, mac, driver, connected]);

  // Rendered in BOTH branches: a chip press is the only way out of Android TV's
  // step 2 (it clears awaitingCode), so hiding it during code entry would strand
  // a user who picked the wrong brand.
  const brandSelector =
    brandKnown && !brandOpen ? (
      <Pressable onPress={() => setBrandOpen(true)} style={styles.brandSummary}>
        <Text style={styles.brandSummaryText}>TV type: {meta.label}</Text>
        <Text style={styles.brandChange}>Change</Text>
      </Pressable>
    ) : (
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.segment}>
        {driver.brands.map((b) => (
          <Pressable
            key={b.id}
            onPress={() => {
              setBrand(b.id);
              setBrandKnown(true);
              setBrandOpen(false);
              setMsg(null);
              setAwaitingCode(false);
              setCode('');
            }}
            style={[styles.seg, brand === b.id && styles.segOn]}>
            <Text style={[styles.segText, brand === b.id && styles.segTextOn]}>{b.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
    );

  return (
    <View style={styles.root}>
      {awaitingCode ? (
        <>
          {brandSelector}
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
          <Pressable onPress={finishAndroidtv} disabled={busy} style={[styles.button, busy && styles.buttonBusy]}>
            {busy ? <ActivityIndicator color={t.bg} /> : <Text style={styles.buttonText}>Finish pairing</Text>}
          </Pressable>
        </>
      ) : (
        <>
          <Pressable
            onPress={scan}
            disabled={scanning || busy}
            style={[styles.scanBtn, (scanning || busy) && styles.buttonBusy]}>
            {scanning ? (
              <ActivityIndicator color={t.blue} />
            ) : (
              <>
                <Ionicons name="wifi" size={16} color={t.blue} />
                <Text style={styles.scanBtnText}>Scan for TVs</Text>
              </>
            )}
          </Pressable>
          {found && found.length > 0 ? (
            <View style={styles.foundList}>
              {found.map((tv) => (
                <Pressable key={tv.host} onPress={() => pick(tv)} style={styles.foundRow}>
                  <Ionicons name="tv-outline" size={18} color={t.text} />
                  <View style={styles.foundText}>
                    <Text style={styles.foundName} numberOfLines={1}>{tv.name}</Text>
                    <Text style={styles.foundMeta}>
                      {(ALL_BRANDS.find((b) => b.id === tv.brand)?.label ?? tv.brand)} · {tv.host}
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={t.textDim} />
                </Pressable>
              ))}
            </View>
          ) : null}
          <TextInput
            value={host}
            onChangeText={(v) => {
              setHost(v);
              setBlocked(null);
            }}
            placeholder="TV IP address (e.g. 192.168.1.50)"
            placeholderTextColor={t.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="numbers-and-punctuation"
            editable={!busy}
            style={styles.input}
          />
          {brandSelector}
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
          <Pressable onPress={submit} disabled={busy} style={[styles.button, busy && styles.buttonBusy]}>
            {busy ? (
              <ActivityIndicator color={t.bg} />
            ) : (
              <Text style={styles.buttonText}>
                {meta.verb} {meta.label}
              </Text>
            )}
          </Pressable>
          {blocked?.commercial ? (
            <Pressable onPress={addCommercial} disabled={busy} style={[styles.button, busy && styles.buttonBusy]}>
              <Text style={styles.buttonText}>Add as LG commercial display</Text>
            </Pressable>
          ) : null}
          {blocked ? (
            <Pressable onPress={pairAnyway} disabled={busy} style={[styles.altBtn, busy && styles.buttonBusy]}>
              <Text style={styles.altBtnText}>
                {meta.verb} as {meta.label} anyway
              </Text>
            </Pressable>
          ) : null}
        </>
      )}

      {msg ? (
        <View style={styles.msgRow}>
          {msg.done ? (
            <Ionicons name={msg.ok ? 'checkmark-circle' : 'alert-circle'} size={16} color={msg.ok ? t.green : t.red} />
          ) : null}
          <Text
            style={[
              styles.msg,
              { color: !msg.done ? t.textDim : msg.ok ? t.green : t.red },
              msg.done && styles.msgDone,
            ]}>
            {msg.text}
          </Text>
        </View>
      ) : null}

      <Text style={styles.hint}>
        {brand === 'roku'
          ? 'No pairing needed — just make sure the Roku is on and on this network. If the D-pad does not respond after adding, enable control on the Roku: Settings → System → Advanced system settings → Control by mobile apps → Network access → Permissive.'
          : brand === 'vidaa'
            ? 'No pairing needed — just make sure the TV is on and on this network. The MAC is optional (Wake-on-LAN power-on).'
            : brand === 'androidtv'
              ? 'Your Android/Google TV must be on. After “Pair”, a 6-digit code appears on the TV — enter it here.'
              : `Your ${meta.label} TV must be on. An accept prompt appears on the TV — say yes. The MAC is optional and lets the box wake the TV over the network.`}
      </Text>
    </View>
  );
}

const makeStyles = (t: Palette) => StyleSheet.create({
  root: { gap: 10 },
  brandSummary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    backgroundColor: t.inset,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    minHeight: 44,
  },
  brandSummaryText: { color: t.text, fontSize: 13, fontWeight: '600', flexShrink: 1 },
  brandChange: { color: t.blue, fontSize: 13, fontWeight: '700' },
  segment: { flexDirection: 'row', backgroundColor: t.inset, borderRadius: 10, padding: 3, gap: 3 },
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
  scanBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 10,
    paddingVertical: 11,
    minHeight: 44,
    backgroundColor: t.inset,
    borderWidth: 1,
    borderColor: t.cardBorder,
  },
  scanBtnText: { color: t.blue, fontSize: 14, fontWeight: '700' },
  altBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    paddingVertical: 11,
    minHeight: 44,
    backgroundColor: t.inset,
    borderWidth: 1,
    borderColor: t.cardBorder,
  },
  altBtnText: { color: t.textDim, fontSize: 14, fontWeight: '600' },
  foundList: { gap: 6 },
  foundRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: t.card,
    borderWidth: 1,
    borderColor: t.cardBorder,
  },
  foundText: { flex: 1 },
  foundName: { color: t.text, fontSize: 14, fontWeight: '700' },
  foundMeta: { color: t.textDim, fontSize: 12, marginTop: 1 },
  msgRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: 2 },
  msg: { fontSize: 13, lineHeight: 18, flex: 1 },
  msgDone: { fontSize: 14, fontWeight: '600', lineHeight: 19 },
  hint: { color: t.textFaint, fontSize: 12, lineHeight: 16 },
});
