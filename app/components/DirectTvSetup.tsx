/**
 * Setup card for REMOTE-ONLY MODE: the toggle, plus adding a TV the phone
 * drives directly (no Couchside box, no agent).
 *
 * Distinct from components/SmartTvSetup.tsx, which pairs a TV to a BOX — that
 * one posts to the agent's /api/tv/* routes and the credentials live on the
 * box. This one has no box to post to, so the TV list lives on the phone
 * (lib/tvdirect/store.ts) and the commands go straight out over the LAN.
 *
 * Only Roku is offered today, and that is a capability statement rather than a
 * shortlist: Roku's ECP is plain unauthenticated HTTP, while LG/Samsung/Google
 * TV need a raw TLS socket the app does not have yet. The other brands are
 * NAMED here with what they currently need, because "my TV isn't listed" with
 * no explanation is the worst version of this screen.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

import { hapticSelection } from '@/lib/haptics';
import { setPref, usePref } from '@/lib/prefs';
import { useBoxes } from '@/lib/SettingsContext';
import { isValidTvHost } from '@/lib/tvdirect/model';
import { rokuIdentify } from '@/lib/tvdirect/roku';
import {
  addTv,
  removeTv,
  scanForTvs,
  selectTv,
  useTvs,
  type FoundTv,
} from '@/lib/tvdirect/store';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

type AddState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'failed'; msg: string }
  | { kind: 'added'; name: string };

export function DirectTvSetup() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const remoteOnly = usePref('remoteOnlyMode');
  const { tvs, activeTvId } = useTvs();
  const { boxes } = useBoxes();
  const [host, setHost] = useState('');
  const [state, setState] = useState<AddState>({ kind: 'idle' });
  // LAN sweep: found TVs stream in via onFound while workers drain. 'done'
  // distinguishes "haven't scanned" from "scanned and the LAN is empty".
  const [scanning, setScanning] = useState(false);
  const [scanDone, setScanDone] = useState(false);
  const [foundTvs, setFoundTvs] = useState<FoundTv[]>([]);
  const scanAbort = useRef<{ aborted: boolean }>({ aborted: false });
  useEffect(
    () => () => {
      scanAbort.current.aborted = true; // unmount mid-sweep: stop the workers
    },
    [],
  );

  const scan = useCallback(async () => {
    hapticSelection();
    scanAbort.current = { aborted: false };
    setScanning(true);
    setScanDone(false);
    setFoundTvs([]);
    await scanForTvs((tv) => {
      // Dedupe on host: a TV that answers twice (Wi-Fi hiccup retry) is one row.
      setFoundTvs((prev) => (prev.some((p) => p.host === tv.host) ? prev : [...prev, tv]));
    }, scanAbort.current);
    if (!scanAbort.current.aborted) {
      setScanning(false);
      setScanDone(true);
    }
  }, []);

  const addFound = useCallback(
    async (tv: FoundTv) => {
      hapticSelection();
      // Already identified by the sweep itself — adding is just storing.
      const stored = await addTv({ name: tv.name, brand: tv.brand, host: tv.host });
      if (stored) {
        setFoundTvs((prev) => prev.filter((p) => p.host !== tv.host));
        setState({ kind: 'added', name: stored.name });
        if (boxes.length === 0 && !remoteOnly) await setPref('remoteOnlyMode', true);
      }
    },
    [boxes.length, remoteOnly],
  );

  const hostOk = isValidTvHost(host.trim());

  const add = useCallback(async () => {
    const ip = host.trim();
    if (!isValidTvHost(ip)) {
      setState({ kind: 'failed', msg: 'Enter the TV’s IP address on your network.' });
      return;
    }
    setState({ kind: 'testing' });
    // IDENTIFY BEFORE ADDING. A TV that never answers would otherwise sit in the
    // list looking configured while every press vanished — the repo's
    // dead-button-costs-more-than-a-missing-one rule.
    const info = await rokuIdentify(ip);
    if (!info) {
      setState({
        kind: 'failed',
        msg: 'No Roku answered at that address. Check the IP in the TV’s Settings → Network → About, and that the phone is on the same Wi-Fi.',
      });
      return;
    }
    const stored = await addTv({ name: info.name, brand: 'roku', host: ip });
    if (!stored) {
      setState({ kind: 'failed', msg: 'That address could not be stored.' });
      return;
    }
    setHost('');
    setState({ kind: 'added', name: stored.name });
    // Someone with no box who just added a TV has told us which app they want.
    // Only auto-enable when the fleet is EMPTY: flipping a box owner into
    // remote-only would hide the tabs they came for.
    if (boxes.length === 0 && !remoteOnly) await setPref('remoteOnlyMode', true);
  }, [host, boxes.length, remoteOnly]);

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Ionicons name="tv-outline" size={16} color={t.blue} />
        <Text style={styles.headerText}>TV REMOTE (NO BOX)</Text>
      </View>

      <View style={styles.toggleRow}>
        <View style={styles.toggleBody}>
          <Text style={styles.toggleLabel}>Remote-only mode</Text>
          <Text style={styles.toggleSub}>
            Turns Couchside into just a TV remote: the box tabs are hidden and the phone talks
            to your TV directly. Turn it off any time to get them back.
          </Text>
        </View>
        <Switch
          value={remoteOnly}
          onValueChange={(v) => {
            hapticSelection();
            void setPref('remoteOnlyMode', v);
          }}
          trackColor={{ true: t.blue, false: t.inset }}
        />
      </View>

      {tvs.length > 0 && (
        <View style={styles.list}>
          {tvs.map((tv) => (
            <View key={tv.id} style={styles.tvRow}>
              <Pressable
                onPress={() => {
                  hapticSelection();
                  void selectTv(tv.id);
                }}
                style={styles.tvMain}>
                <Ionicons
                  name={tv.id === activeTvId ? 'radio-button-on' : 'radio-button-off'}
                  size={16}
                  color={tv.id === activeTvId ? t.blue : t.textFaint}
                />
                <View style={styles.tvBody}>
                  <Text style={styles.tvName} numberOfLines={1}>
                    {tv.name}
                  </Text>
                  <Text style={styles.tvHost} numberOfLines={1}>
                    {tv.brand} · {tv.host}
                  </Text>
                </View>
              </Pressable>
              <Pressable onPress={() => void removeTv(tv.id)} hitSlop={8} style={styles.removeBtn}>
                <Text style={[styles.removeText, { color: t.red }]}>REMOVE</Text>
              </Pressable>
            </View>
          ))}
        </View>
      )}

      {/* LAN sweep — the no-typing path. Same /24 HTTP sweep the box scanner
          uses (iOS blocks UDP, so SSDP was never an option). Every row here
          already answered device-info AS a Roku; ADD just stores it. */}
      <Pressable
        onPress={() => void scan()}
        disabled={scanning}
        style={({ pressed }) => [styles.scanBtn, (pressed || scanning) && styles.pressed]}>
        {scanning ? (
          <ActivityIndicator size="small" color={t.blue} />
        ) : (
          <Ionicons name="wifi" size={16} color={t.blue} />
        )}
        <Text style={styles.scanBtnText}>
          {scanning ? 'SCANNING YOUR WI-FI…' : 'SCAN FOR ROKU TVS'}
        </Text>
      </Pressable>
      {foundTvs.map((tv) => (
        <View key={tv.host} style={styles.tvRow}>
          <View style={styles.tvMain}>
            <Ionicons name="tv-outline" size={16} color={t.blue} />
            <View style={styles.tvBody}>
              <Text style={styles.tvName} numberOfLines={1}>
                {tv.name}
              </Text>
              <Text style={styles.tvHost} numberOfLines={1}>
                {tv.model ? `${tv.model} · ` : ''}
                {tv.host}
              </Text>
            </View>
          </View>
          <Pressable onPress={() => void addFound(tv)} hitSlop={8} style={styles.removeBtn}>
            <Text style={[styles.removeText, { color: t.blue }]}>ADD</Text>
          </Pressable>
        </View>
      ))}
      {scanDone && foundTvs.length === 0 && (
        <Text style={styles.help}>
          No Roku answered on this network. TV on the same Wi-Fi as the phone? You can still add
          it by IP below.
        </Text>
      )}

      <Text style={styles.fieldLabel}>ROKU TV — IP ADDRESS</Text>
      <TextInput
        style={styles.input}
        value={host}
        onChangeText={(v) => {
          setHost(v);
          if (state.kind !== 'idle') setState({ kind: 'idle' });
        }}
        placeholder="192.168.1.24"
        placeholderTextColor={t.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="numbers-and-punctuation"
      />
      <Text style={styles.help}>
        On the TV: Settings → Network → About. Roku only for now — see below.
      </Text>

      <Pressable
        onPress={() => void add()}
        disabled={!hostOk || state.kind === 'testing'}
        style={({ pressed }) => [
          styles.addBtn,
          (!hostOk || state.kind === 'testing' || pressed) && styles.pressed,
        ]}>
        <Text style={styles.addBtnText}>
          {state.kind === 'testing' ? 'CHECKING…' : 'ADD TV'}
        </Text>
      </Pressable>

      {state.kind === 'failed' && <Text style={styles.err}>{state.msg}</Text>}
      {state.kind === 'added' && (
        <Text style={styles.ok}>Added {state.name}. It’s on the Remote tab.</Text>
      )}

      {/* Honest ceiling. These brands work TODAY through a box (Setup → your
          box → Smart TV), and need app-side TLS sockets to work without one. */}
      <Text style={styles.note}>
        LG, Samsung, Google TV and Hisense need a Couchside box to control for now — the app
        can’t yet make the encrypted connection those TVs require on its own. With a box, all
        of them work: open the box above and use its Smart TV section.
      </Text>
    </View>
  );
}

const makeStyles = (t: Palette) => StyleSheet.create({
  card: {
    backgroundColor: t.card,
    borderColor: t.cardBorder,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 14,
    gap: 10,
    marginBottom: 12,
  },
  pressed: { opacity: 0.6 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerText: {
    color: t.textDim,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.5,
    fontFamily: mono,
  },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  toggleBody: { flex: 1, gap: 3 },
  toggleLabel: { color: t.text, fontSize: 14, fontWeight: '700' },
  toggleSub: { color: t.textDim, fontSize: 12, lineHeight: 17 },
  list: { gap: 6 },
  scanBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 10,
    paddingVertical: 12,
    backgroundColor: t.inset,
    borderWidth: 1,
    borderColor: t.cardBorder,
  },
  scanBtnText: {
    color: t.blue,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
    fontFamily: mono,
  },
  tvRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: t.inset,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  tvMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  tvBody: { flex: 1 },
  tvName: { color: t.text, fontSize: 13, fontWeight: '700' },
  tvHost: { color: t.textDim, fontSize: 11, fontFamily: mono },
  removeBtn: { paddingHorizontal: 6, paddingVertical: 4 },
  removeText: { fontSize: 11, fontWeight: '800', letterSpacing: 0.5, fontFamily: mono },
  fieldLabel: {
    color: t.textDim,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.2,
    fontFamily: mono,
    marginTop: 2,
  },
  input: {
    backgroundColor: t.inset,
    borderColor: t.cardBorder,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    color: t.text,
    fontSize: 15,
    fontFamily: mono,
  },
  help: { color: t.textFaint, fontSize: 11, lineHeight: 16 },
  addBtn: {
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    backgroundColor: t.blue,
  },
  addBtnText: { color: t.bg, fontSize: 12, fontWeight: '800', letterSpacing: 1, fontFamily: mono },
  err: { color: t.red, fontSize: 12, lineHeight: 17 },
  ok: { color: t.green, fontSize: 12, lineHeight: 17 },
  note: {
    color: t.textFaint,
    fontSize: 11,
    lineHeight: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: t.cardBorder,
    paddingTop: 10,
  },
});
