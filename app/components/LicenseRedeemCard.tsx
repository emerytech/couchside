import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { getLicenseeName, isGenuinelyPurchased } from '@/lib/entitlement';
import { useEntitlement } from '@/lib/EntitlementContext';
import { mono, useThemedStyles } from '@/lib/theme';
import type { Palette } from '@/lib/theme';

/**
 * Direct-edition unlock: paste the signed license key the maintainer issued on
 * purchase. Shown ONLY on the direct (off-store) build — the store builds unlock
 * through in-app purchase and never render this. The key is verified offline
 * (lib/license.ts); a leaked APK without a key stays on the trial.
 *
 * `compact` drops the card chrome so this can sit inside the full-screen Paywall.
 */
export function LicenseRedeemCard({ compact = false }: { compact?: boolean }) {
  const { entitlement, redeemLicense } = useEntitlement();
  const styles = useThemedStyles(makeStyles);

  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [name, setName] = useState<string | null>(null);

  const purchased = isGenuinelyPurchased(entitlement);

  useEffect(() => {
    let cancelled = false;
    if (purchased) getLicenseeName().then((n) => !cancelled && setName(n));
    return () => {
      cancelled = true;
    };
  }, [purchased]);

  const onRedeem = useCallback(async () => {
    const trimmed = key.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setMsg(null);
    const result = await redeemLicense(trimmed);
    if (result.ok) {
      setName(result.name ?? null);
      setMsg({ text: `Unlocked — licensed to ${result.name}. Thank you!`, ok: true });
      setKey('');
    } else {
      setMsg({ text: result.error ?? 'Could not verify that key.', ok: false });
    }
    setBusy(false);
  }, [key, busy, redeemLicense]);

  if (purchased) {
    return (
      <View style={compact ? styles.compact : styles.card}>
        <Text style={styles.licensed}>
          {name ? `Licensed to ${name} — thank you.` : 'Licensed — thank you.'}
        </Text>
      </View>
    );
  }

  return (
    <View style={compact ? styles.compact : styles.card}>
      {!compact && <Text style={styles.header}>REDEEM LICENSE KEY</Text>}
      <TextInput
        value={key}
        onChangeText={setKey}
        placeholder="CS1.…"
        placeholderTextColor={styles._placeholder.color}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        spellCheck={false}
        multiline
        editable={!busy}
        style={styles.input}
      />
      <Pressable
        onPress={onRedeem}
        disabled={busy || key.trim().length === 0}
        style={({ pressed }) => [
          styles.btn,
          (pressed || busy || key.trim().length === 0) && styles.btnMuted,
        ]}>
        <Text style={styles.btnText}>{busy ? 'CHECKING…' : 'REDEEM'}</Text>
      </Pressable>
      {msg != null && (
        <Text style={[styles.msg, { color: msg.ok ? styles._ok.color : styles._err.color }]}>
          {msg.text}
        </Text>
      )}
      <Text style={styles.hint}>
        Bought Couchside direct? Paste the key from your purchase email. It unlocks this
        device offline — no account, no store.
      </Text>
    </View>
  );
}

const makeStyles = (t: Palette) => StyleSheet.create({
  card: {
    backgroundColor: t.card,
    borderColor: t.cardBorder,
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
  },
  compact: { alignSelf: 'stretch' },
  header: {
    color: t.textDim,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
    fontFamily: mono,
    marginBottom: 12,
  },
  input: {
    color: t.text,
    backgroundColor: t.inset,
    borderColor: t.cardBorder,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 44,
    fontSize: 13,
    fontFamily: mono,
    marginBottom: 12,
  },
  btn: {
    alignSelf: 'stretch',
    backgroundColor: t.blue,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  btnMuted: { opacity: 0.5 },
  btnText: { color: '#0b1220', fontSize: 14, fontWeight: '800', letterSpacing: 1 },
  licensed: { color: t.green, fontSize: 13, fontWeight: '700', fontFamily: mono, textAlign: 'center' },
  msg: { fontSize: 12, fontFamily: mono, marginTop: 12 },
  hint: { color: t.textDim, fontSize: 12, lineHeight: 17, marginTop: 12 },
  // Palette values reached through the stylesheet so the component stays props-free.
  _placeholder: { color: t.textDim },
  _ok: { color: t.green },
  _err: { color: t.red },
});
