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

import { usePoll } from '@/hooks/usePoll';
import {
  api,
  ApiError,
  ConnSettings,
  DiscoveredTv,
  hostKey,
  Tv,
  TvIdentifyResult,
  TvPairResult,
} from '@/lib/api';
import { hapticError, hapticSuccess } from '@/lib/haptics';
import { normalizeMac } from '@/lib/settings';
import { useTheme, useThemedStyles, type Palette } from '@/lib/theme';

/**
 * A pairing error the user can act on. The box's own reason (e.g. a 500
 * "could not persist config: Permission denied") is surfaced verbatim instead
 * of a blanket "could not reach the box" — a server-side failure that masquer-
 * ades as a network error is what turned a config-permission bug into a long
 * hunt. Network/timeout kinds keep the friendly fallback (accurate for those).
 */
function pairErr(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    // http = the box answered with an error status; show what it said.
    if (e.kind === 'http') return `${fallback} — box says: ${e.message}`;
    // unreachable / timeout / unauthorized: the friendly fallback fits, but
    // name the kind so it's still diagnosable.
    return `${fallback} (${e.kind})`;
  }
  return fallback;
}

type Brand = 'webos' | 'samsung' | 'roku' | 'androidtv' | 'vidaa';

const BRANDS: { id: Brand; label: string; needsMac: boolean; verb: string }[] = [
  { id: 'webos', label: 'LG', needsMac: true, verb: 'Pair' },
  { id: 'samsung', label: 'Samsung', needsMac: true, verb: 'Pair' },
  { id: 'roku', label: 'Roku', needsMac: false, verb: 'Add' },
  { id: 'androidtv', label: 'Google TV', needsMac: true, verb: 'Pair' },
  { id: 'vidaa', label: 'Hisense', needsMac: true, verb: 'Add' },
];

const NETWORK_BACKENDS = ['webos', 'samsung', 'roku', 'androidtv', 'vidaa', 'lgcom'];

/**
 * identify's `brand` names devices we cannot pair too ("lg_commercial", null),
 * so it is not assignable to Brand. Anything outside BRANDS falls back to the
 * user's selection rather than pairing with a backend this build has no flow
 * for.
 */
function pairableBrand(b: TvIdentifyResult['brand']): Brand | null {
  return BRANDS.some((x) => x.id === b) ? (b as Brand) : null;
}

/**
 * Display names for the TV-picker roster. It spans more than BRANDS: the box's
 * non-pairable backends (RS-232 panel, HDMI-CEC) are choosable TVs too. An id
 * a future agent adds falls through to the raw id rather than rendering blank.
 */
const BACKEND_LABELS: Record<string, string> = {
  webos: 'LG',
  samsung: 'Samsung',
  roku: 'Roku',
  androidtv: 'Google TV',
  vidaa: 'Hisense',
  panel: 'RS-232 panel',
  cec: 'CEC',
};

const backendLabel = (id: string): string => BACKEND_LABELS[id] ?? id;

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
  // `done` separates a SETTLED outcome (success/failure -- gets colour, an icon
  // and a haptic) from in-flight narration like "Waiting for you to accept on
  // the TV…", which should stay quiet grey. Without that split every message
  // rendered the same dim grey as the static hint copy below it.
  const [msg, setMsg] = useState<{ ok: boolean; text: string; done?: boolean } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [found, setFound] = useState<DiscoveredTv[] | null>(null);
  // Set when identify settled on "do not pair with this". `commercial` splits
  // the one blocked device we CAN still drive (an LG signage panel, over plain
  // TCP 9761) from the ones we cannot. Either way the user keeps a force-pair
  // escape: identify can be wrong, and a TV in standby cannot be identified at
  // all, which would otherwise make an off TV impossible to set up.
  const [blocked, setBlocked] = useState<{ host: string; commercial: boolean } | null>(null);
  const [switching, setSwitching] = useState(false);
  // Discovery reports each TV's brand and pick() applies it, so for the common
  // path the brand is already answered and the chip row is clutter. It collapses
  // to a summary once something is known; `brandOpen` is the "Change" escape
  // hatch, still needed for a TV that is off (unidentifiable) or a typed-in IP.
  const [brandKnown, setBrandKnown] = useState(false);
  const [brandOpen, setBrandOpen] = useState(false);

  const tvPoll = usePoll<Tv>(() => api.tv(settings), 15000, true, hostKey(settings));
  const active =
    tvPoll.data?.available && NETWORK_BACKENDS.includes(tvPoll.data.backend)
      ? tvPoll.data
      : null;
  const meta = BRANDS.find((b) => b.id === brand)!;
  // Absent on agents predating the picker, so `?? []` keeps those boxes on the
  // exact pre-picker rendering: one backend, no roster, nothing to choose.
  const backends = tvPoll.data?.backends ?? [];

  // Feedback for a SETTLED outcome fires here rather than at each of the ten
  // setMsg call sites, so no future branch can forget it. In-flight narration
  // (msg.done falsy) stays silent -- buzzing on "Waiting for you to accept on
  // the TV…" would be noise, not signal.
  useEffect(() => {
    if (!msg?.done) return;
    if (msg.ok) hapticSuccess();
    else hapticError();
  }, [msg]);

  // `label` is passed in rather than read off `meta`: identify can switch the
  // brand in the same tick it pairs, and this closure would still be holding
  // the label the user had selected before.
  const connected = useCallback(
    (r: TvPairResult, label: string) => {
      setMsg({ ok: true, done: true, text: r.name ? `Connected: ${r.name}` : `Connected to ${label}.` });
      setHost('');
      setMac('');
      setCode('');
      setAwaitingCode(false);
      setFound(null);
      setBlocked(null);
      // Pull the TV state NOW instead of waiting out the 15s poll. That poll
      // drives the persistent "Connected: <adapter>" row at the top of the
      // card, which is the durable confirmation -- the transient message
      // scrolls away, and a card that still looks unpaired for another 14
      // seconds is why a successful pairing read as no feedback at all.
      tvPoll.refresh();
    },
    [tvPoll],
  );

  // Point the remote at one of several paired TVs. Before this the box resolved
  // a TV by a fixed priority chain, so a second pairing succeeded and then drove
  // nothing at all -- this switch is what makes the extra TV reachable.
  const chooseBackend = useCallback(
    async (id: string) => {
      if (switching) return;
      setSwitching(true);
      setMsg({ ok: true, text: `Switching to ${backendLabel(id)}…` });
      try {
        const r = await api.tvSetActive(settings, id);
        // The reply's `backend` is what RESOLVED, not what was asked for: a
        // chosen TV whose config vanished falls back, and reporting the request
        // as fact is exactly the lie the original priority-chain bug told.
        const now = r.backend ?? id;
        setMsg(
          now === id
            ? { ok: true, done: true, text: `Remote now drives ${backendLabel(id)}.` }
            : {
                ok: false,
                done: true,
                text: `${backendLabel(id)} is not available — still driving ${backendLabel(now)}.`,
              },
        );
      } catch (e: unknown) {
        setMsg({ ok: false, done: true, text: pairErr(e, `Could not switch to ${backendLabel(id)}.`) });
      } finally {
        setSwitching(false);
        // Re-read regardless of outcome: the picker highlights the RESOLVED
        // backend, so a rejected choice must not leave the row looking switched.
        tvPoll.refresh();
      }
    },
    [settings, switching, tvPoll],
  );

  // "Scan for TVs": the box sweeps the LAN (mDNS + SSDP) and returns pairable
  // TVs, so the user taps one instead of typing an IP. A 404 = agent too old.
  const scan = useCallback(async () => {
    setScanning(true);
    setMsg(null);
    try {
      const r = await api.tvDiscover(settings);
      setFound(r.tvs);
      if (r.tvs.length === 0) {
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
  }, [settings]);

  // Tap a discovered TV: prefill its brand + IP, then the normal pair flow runs.
  const pick = useCallback((tv: DiscoveredTv) => {
    setBrand(tv.brand);
    setBrandKnown(true);
    setBrandOpen(false);
    setHost(tv.host);
    setAwaitingCode(false);
    setCode('');
    setBlocked(null);
    setMsg({ ok: true, text: `${tv.name} — tap ${BRANDS.find((b) => b.id === tv.brand)?.verb ?? 'Pair'} below.` });
  }, []);

  // The pairing itself, with the brand passed in: identify may have chosen a
  // different one than the selector shows, and setBrand does not land in time
  // for this call. Assumes busy/error handling from its caller.
  const runPair = useCallback(
    async (b: Brand, h: string) => {
      const bm = BRANDS.find((x) => x.id === b)!;
      const m = bm.needsMac && mac.trim() ? normalizeMac(mac.trim()) ?? undefined : undefined;
      if (b === 'androidtv') {
        // Step 1: open the pairing socket -> TV shows a 6-digit code.
        setMsg({ ok: true, text: 'Opening pairing on the TV…' });
        const r = await api.tvAndroidtvPairStart(settings, h);
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
        text:
          b === 'roku' || b === 'vidaa'
            ? 'Contacting the TV…'
            : 'Waiting for you to accept on the TV…',
      });
      let r: TvPairResult;
      if (b === 'webos') r = await api.tvPairWebos(settings, h, m);
      else if (b === 'samsung') r = await api.tvPairSamsung(settings, h, m);
      else if (b === 'vidaa') r = await api.tvAddVidaa(settings, h, m);
      else r = await api.tvAddRoku(settings, h);
      if (r.ok) connected(r, bm.label);
      else setMsg({ ok: false, done: true, text: r.error ?? 'Could not connect to the TV.' });
    },
    [mac, settings, connected],
  );

  /**
   * Identify first, then act. A user who picked an LG signage panel out of our
   * OWN scan used to get `HTTP 502: pairing failed: _ssl.c:1063: The handshake
   * operation timed out` — nothing in that names the actual problem, and there
   * was no way forward. Asking the box what is at the address turns that into
   * an explanation plus, for the signage case, a path that works.
   */
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
        id = await api.tvIdentify(settings, h);
      } catch (e: unknown) {
        // Most boxes in the field predate identify and 404 this route. That
        // MUST degrade to exactly the old behaviour (pair with the selected
        // brand) -- refusing to pair because a probe is missing would break
        // setup on every un-updated box. Any other error is a real failure and
        // rethrows into the handler below.
        if (!(e instanceof ApiError && e.kind === 'http' && e.status === 404)) throw e;
      }

      if (id && id.brand === 'lg_commercial') {
        // Do NOT attempt webOS here: this is the exact device whose port 3001
        // accepts a connection and then never completes TLS.
        setBlocked({ host: h, commercial: true });
        setMsg({ ok: false, done: true, text: id.reason });
        return;
      }
      if (id && !id.supported) {
        // Settled failure. Falling through would only re-produce the raw socket
        // error identify exists to replace.
        setBlocked({ host: h, commercial: false });
        setMsg({ ok: false, done: true, text: id.reason });
        return;
      }

      // The user should not have to have picked the right brand.
      const chosen = (id && pairableBrand(id.brand)) || brand;
      if (chosen !== brand) setBrand(chosen);
      await runPair(chosen, h);
    } catch (e: unknown) {
      setMsg({ ok: false, done: true, text: pairErr(e, 'Could not reach the box or TV. Check the IP and try again.') });
    } finally {
      setBusy(false);
    }
  }, [brand, host, settings, runPair]);

  // The escape hatch: pair with the brand the user selected, skipping identify
  // entirely. Reachable after identify blocked the address -- it can be wrong,
  // and a TV that is OFF cannot be identified at all, so "nothing answered"
  // must not be the end of the road.
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

  // Record an LG commercial/signage panel. No pairing and no accept prompt --
  // its 9761 control port is unauthenticated -- so this is a one-tap path out
  // of what used to be a dead end.
  const addCommercial = useCallback(async () => {
    const h = blocked?.host ?? host.trim();
    if (!h) return;
    setBusy(true);
    setMsg({ ok: true, text: 'Contacting the display…' });
    try {
      const r = await api.tvAddLgCommercial(settings, h);
      if (r.ok) connected(r, 'LG commercial display');
      else setMsg({ ok: false, done: true, text: r.error ?? 'Could not connect to the display.' });
    } catch (e: unknown) {
      setMsg({ ok: false, done: true, text: pairErr(e, 'Could not reach the box or display. Check the IP and try again.') });
    } finally {
      setBusy(false);
    }
  }, [blocked, host, settings, connected]);

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
      const r = await api.tvAndroidtvPairFinish(settings, c, m);
      if (r.ok) connected(r, 'Google TV');
      else setMsg({ ok: false, done: true, text: r.error ?? 'Pairing failed — check the code and retry.' });
    } catch (e: unknown) {
      setMsg({ ok: false, done: true, text: pairErr(e, 'Could not reach the box. Try again.') });
    } finally {
      setBusy(false);
    }
  }, [code, mac, settings, connected]);

  // Rendered in BOTH flow branches: a chip press is also the only way out of
  // Android TV's step 2 (it clears awaitingCode), so hiding the selector during
  // code entry would strand a user who picked the wrong brand.
  const brandSelector =
    brandKnown && !brandOpen ? (
      <Pressable onPress={() => setBrandOpen(true)} style={styles.brandSummary}>
        <Text style={styles.brandSummaryText}>TV type: {meta.label}</Text>
        <Text style={styles.brandChange}>Change</Text>
      </Pressable>
    ) : (
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.segment}>
        {BRANDS.map((b) => (
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
    <View style={styles.card}>
      <Text style={styles.title}>Smart TV remote</Text>
      <Text style={styles.sub}>
        Control a networked TV — LG webOS, Samsung, Roku, Google TV, or Hisense — from the Pad
        tab. The D-pad, SOURCE key, volume, power, and on-screen keyboard all light up once it’s
        connected, and your phone’s volume buttons drive the TV too.
      </Text>

      {active ? (
        <View style={styles.activeRow}>
          <Ionicons name="tv" size={16} color={t.green} />
          <Text style={styles.activeText}>Connected: {active.adapter}</Text>
        </View>
      ) : null}

      {/* Only worth a row when there is an actual choice. One backend (or an
          agent too old to report the roster) renders nothing here — a picker
          over a single TV is noise. Selection tracks the RESOLVED backend, so a
          fallback shows as itself rather than as whatever was last tapped. */}
      {backends.length > 1 ? (
        <View style={styles.pickerBlock}>
          <Text style={styles.pickerLabel}>Remote drives</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.segment}>
            {backends.map((b) => (
              <Pressable
                key={b}
                onPress={() => chooseBackend(b)}
                disabled={switching}
                style={[
                  styles.seg,
                  tvPoll.data?.backend === b && styles.segOn,
                  switching && styles.buttonBusy,
                ]}>
                <Text
                  style={[styles.segText, tvPoll.data?.backend === b && styles.segTextOn]}>
                  {backendLabel(b)}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : null}

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
                      {(BRANDS.find((b) => b.id === tv.brand)?.label ?? tv.brand)} · {tv.host}
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
              // The block belongs to the address that was identified.
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
          {/* Demoted below Scan and the IP field: discovery already answers this
              for any TV that is on, so leading with it asked the user a question
              the app had. It stays reachable for a TV that is off (nothing to
              identify) and for a hand-typed IP. */}
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
          {blocked?.commercial ? (
            <Pressable
              onPress={addCommercial}
              disabled={busy}
              style={[styles.button, busy && styles.buttonBusy]}>
              <Text style={styles.buttonText}>Add as LG commercial display</Text>
            </Pressable>
          ) : null}
          {blocked ? (
            <Pressable
              onPress={pairAnyway}
              disabled={busy}
              style={[styles.altBtn, busy && styles.buttonBusy]}>
              <Text style={styles.altBtnText}>
                {meta.verb} as {meta.label} anyway
              </Text>
            </Pressable>
          ) : null}
        </>
      )}

      {/* Success used to render in t.textDim -- the same grey as the static
          hint copy directly below it, so "Connected to LG." read as one more
          instruction and a real pairing looked like nothing had happened
          (reported from the field: "it didn't let me know it paired at all; I
          had to go to the Pad tab and test it"). Only failure was styled as a
          signal. A settled outcome now gets colour and an icon; the in-flight
          "waiting for you to accept" step stays quiet grey, because that one
          IS just narration. */}
      {msg ? (
        <View style={styles.msgRow}>
          {msg.done ? (
            <Ionicons
              name={msg.ok ? 'checkmark-circle' : 'alert-circle'}
              size={16}
              color={msg.ok ? t.green : t.red}
            />
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
  pickerBlock: { gap: 6 },
  pickerLabel: { color: t.textDim, fontSize: 12, fontWeight: '700' },
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
