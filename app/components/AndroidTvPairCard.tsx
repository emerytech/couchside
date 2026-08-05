/**
 * Pairing card for a Google TV / Android TV, in REMOTE-ONLY mode.
 *
 * Roku needs none of this (its ECP is unauthenticated), so this card exists
 * only for the brand that does: Android TV wants a mutually-authenticated TLS
 * session, which means this phone must hold its own client certificate and the
 * TV must be told to trust it via a 6-digit code shown on screen.
 *
 * THE ORDER OF OPERATIONS IS THE DESIGN, and it comes from a measurement:
 * the TV's code dialog EXPIRES. On real hardware, taking 39s to enter the code
 * left the secret unanswered and the next connection refused outright, while
 * 5.6s paired instantly. So the expensive work — RSA key generation — happens
 * BEFORE the code is requested, never between the code appearing and the user
 * typing it. By the time the TV shows a code, the only thing left is typing.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { hapticSelection, hapticSuccess, hapticWarning } from '@/lib/haptics';
import { pairStart, type PairSession } from '@/lib/tvdirect/androidtv';
import { fetchPeerCert, makeConnect, mintIdentity, sha256 } from '@/lib/tvdirect/atvnative';
import { ATV_PAIR_PORT, isValidPairCode } from '@/lib/tvdirect/atvproto';
import { isValidTvHost } from '@/lib/tvdirect/model';
import { addTv, dropTvSession } from '@/lib/tvdirect/store';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

type Phase =
  | { kind: 'idle' }
  | { kind: 'preparing'; step: string }
  | { kind: 'code' }
  | { kind: 'finishing' }
  | { kind: 'done'; name: string; mintMs: number }
  | { kind: 'failed'; msg: string };

export function AndroidTvPairCard({ onPaired }: { onPaired?: () => void }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [host, setHost] = useState('');
  const [code, setCode] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const session = useRef<PairSession | null>(null);
  const pending = useRef<{ certPem: string; keyPem: string; modulusHex: string; caPem: string } | null>(
    null,
  );

  const hostOk = isValidTvHost(host.trim());

  const fail = useCallback((msg: string) => {
    hapticWarning();
    session.current?.cancel();
    session.current = null;
    setPhase({ kind: 'failed', msg });
  }, []);

  const begin = useCallback(async () => {
    const ip = host.trim();
    if (!isValidTvHost(ip)) {
      fail('Enter the TV’s IP address on your network.');
      return;
    }
    hapticSelection();
    setCode('');

    // Let the "preparing" state PAINT before the blocking work starts. RSA
    // keygen runs on the JS thread; without yielding first, the button would
    // simply appear frozen with no explanation.
    setPhase({ kind: 'preparing', step: 'Making a secure key for this phone…' });
    await new Promise((r) => setTimeout(r, 50));

    let mintMs = 0;
    let identity;
    try {
      const minted = mintIdentity();
      mintMs = minted.elapsedMs;
      identity = minted;
    } catch (e) {
      fail(`Could not create a secure key: ${(e as Error).message}`);
      return;
    }

    setPhase({ kind: 'preparing', step: 'Checking the TV’s certificate…' });
    await new Promise((r) => setTimeout(r, 50));
    const caPem = await fetchPeerCert(ip, ATV_PAIR_PORT);
    if (!caPem) {
      // Honest failure: we cannot tell "no TV there" from "this platform will
      // not hand us the certificate", so the message names both.
      fail(
        'Could not read this TV’s security certificate. Check the IP and that the TV is on and on the same Wi-Fi. If the address is right, this TV may not be pairable from the app yet.',
      );
      return;
    }

    setPhase({ kind: 'preparing', step: 'Asking the TV for a code…' });
    try {
      session.current = await pairStart(
        ip,
        identity,
        { connect: makeConnect(caPem), sha256 },
        'Couchside',
      );
      pending.current = { ...identity, caPem };
      // From here the TV's own countdown is running — go straight to the code
      // field, nothing in between.
      setPhase({ kind: 'code' });
    } catch (e) {
      fail(`The TV did not start pairing: ${(e as Error).message}`);
    }
  }, [host, fail]);

  const finish = useCallback(async () => {
    const s = session.current;
    const creds = pending.current;
    if (!s || !creds) return;
    if (!isValidPairCode(code)) {
      hapticWarning();
      setPhase({ kind: 'failed', msg: 'The code is 6 characters (digits and letters A–F).' });
      return;
    }
    setPhase({ kind: 'finishing' });
    try {
      await s.finish(code.trim());
      session.current = null;
      const ip = host.trim();
      // A re-pair replaces credentials, so any cached session for this host is
      // stale and must not be reused.
      dropTvSession(ip);
      const stored = await addTv({
        name: `Google TV (${ip})`,
        brand: 'androidtv',
        host: ip,
        atv: creds,
      });
      if (!stored) {
        fail('Paired, but the TV could not be saved.');
        return;
      }
      hapticSuccess();
      setPhase({ kind: 'done', name: stored.name, mintMs: 0 });
      onPaired?.();
    } catch (e) {
      fail((e as Error).message);
    }
  }, [code, host, fail, onPaired]);

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Ionicons name="logo-google" size={15} color={t.blue} />
        <Text style={styles.headerText}>GOOGLE TV / ANDROID TV</Text>
      </View>

      {phase.kind === 'code' || phase.kind === 'finishing' ? (
        <>
          <Text style={styles.lead}>Type the 6-character code showing on the TV.</Text>
          <Text style={styles.hint}>
            It expires quickly — if it disappears, tap Start over for a fresh one.
          </Text>
          <TextInput
            style={styles.codeInput}
            value={code}
            onChangeText={setCode}
            placeholder="A1B2C3"
            placeholderTextColor={t.textFaint}
            autoCapitalize="characters"
            autoCorrect={false}
            autoFocus
            maxLength={6}
            editable={phase.kind === 'code'}
            onSubmitEditing={() => void finish()}
          />
          <View style={styles.row}>
            <Pressable
              onPress={() => {
                session.current?.cancel();
                session.current = null;
                setPhase({ kind: 'idle' });
              }}
              style={({ pressed }) => [styles.btnGhost, pressed && styles.pressed]}>
              <Text style={styles.btnGhostText}>START OVER</Text>
            </Pressable>
            <Pressable
              onPress={() => void finish()}
              disabled={phase.kind === 'finishing'}
              style={({ pressed }) => [
                styles.btn,
                (pressed || phase.kind === 'finishing') && styles.pressed,
              ]}>
              <Text style={styles.btnText}>
                {phase.kind === 'finishing' ? 'PAIRING…' : 'PAIR'}
              </Text>
            </Pressable>
          </View>
        </>
      ) : (
        <>
          <Text style={styles.fieldLabel}>TV IP ADDRESS</Text>
          <TextInput
            style={styles.input}
            value={host}
            onChangeText={(v) => {
              setHost(v);
              if (phase.kind === 'failed' || phase.kind === 'done') setPhase({ kind: 'idle' });
            }}
            placeholder="192.168.1.30"
            placeholderTextColor={t.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="numbers-and-punctuation"
            editable={phase.kind !== 'preparing'}
          />
          <Text style={styles.hint}>
            On the TV: Settings → System → About → Status, or Settings → Network.
          </Text>
          <Pressable
            onPress={() => void begin()}
            disabled={!hostOk || phase.kind === 'preparing'}
            style={({ pressed }) => [
              styles.btn,
              (!hostOk || phase.kind === 'preparing' || pressed) && styles.pressed,
            ]}>
            {phase.kind === 'preparing' ? (
              <ActivityIndicator size="small" color={t.bg} />
            ) : (
              <Text style={styles.btnText}>PAIR THIS TV</Text>
            )}
          </Pressable>
        </>
      )}

      {phase.kind === 'preparing' && (
        <Text style={styles.hint}>
          {phase.step} This can take a while on some phones — it only happens once per TV.
        </Text>
      )}
      {phase.kind === 'failed' && <Text style={styles.err}>{phase.msg}</Text>}
      {phase.kind === 'done' && (
        <Text style={styles.ok}>Paired {phase.name}. It’s on the Remote tab.</Text>
      )}
    </View>
  );
}

const makeStyles = (t: Palette) => StyleSheet.create({
  card: {
    backgroundColor: t.inset,
    borderColor: t.cardBorder,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 12,
    gap: 8,
  },
  pressed: { opacity: 0.6 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerText: {
    color: t.textDim,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.4,
    fontFamily: mono,
  },
  lead: { color: t.text, fontSize: 14, fontWeight: '700' },
  fieldLabel: {
    color: t.textDim,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.2,
    fontFamily: mono,
  },
  input: {
    backgroundColor: t.card,
    borderColor: t.cardBorder,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: t.text,
    fontSize: 15,
    fontFamily: mono,
  },
  codeInput: {
    backgroundColor: t.card,
    borderColor: t.blue,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 14,
    color: t.text,
    fontSize: 26,
    letterSpacing: 8,
    textAlign: 'center',
    fontFamily: mono,
  },
  row: { flexDirection: 'row', gap: 8 },
  btn: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    backgroundColor: t.blue,
  },
  btnText: { color: t.bg, fontSize: 12, fontWeight: '800', letterSpacing: 1, fontFamily: mono },
  btnGhost: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    backgroundColor: t.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: t.cardBorder,
  },
  btnGhostText: {
    color: t.textDim,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
    fontFamily: mono,
  },
  hint: { color: t.textFaint, fontSize: 11, lineHeight: 16 },
  err: { color: t.red, fontSize: 12, lineHeight: 17 },
  ok: { color: t.green, fontSize: 12, lineHeight: 17 },
});
