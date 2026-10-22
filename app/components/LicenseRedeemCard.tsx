import { clearLicenseActivation, type LicenseActivation } from '@/lib/licenseActivation';
import React, { useCallback, useEffect, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { getLicenseeName, isGenuinelyPurchased } from '@/lib/entitlement';
import { useEntitlement } from '@/lib/EntitlementContext';
import { mono, useThemedStyles } from '@/lib/theme';
import type { Palette } from '@/lib/theme';

/**
 * Where "Buy a license" sends people: a couchside.tv/buy redirect we control, NOT
 * a raw processor URL. The server 302s /buy to the current checkout (Polar today),
 * so switching or replacing the payment processor is a one-line web change and NEVER
 * needs another app rebuild. Someone tapping this already has the app, so /buy sends
 * them straight to checkout rather than the /direct landing page.
 */
const BUY_URL = 'https://couchside.tv/buy';

/**
 * Direct-edition unlock: paste the signed license key the maintainer issued on
 * purchase. Shown ONLY on the direct (off-store) build — the store builds unlock
 * through in-app purchase and never render this. The key is verified offline
 * (lib/license.ts); a leaked APK without a key stays on the trial.
 *
 * `compact` drops the card chrome so this can sit inside the full-screen Paywall.
 */
export function LicenseRedeemCard({ compact = false, activation = null }: { compact?: boolean; activation?: LicenseActivation | null }) {
  const { entitlement, redeemLicense } = useEntitlement();
  const styles = useThemedStyles(makeStyles);

  const [key, setKey] = useState(activation?.key ?? '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [recover, setRecover] = useState(false);
  const [email, setEmail] = useState('');
  const [recovering, setRecovering] = useState(false);
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);

  const purchased = isGenuinelyPurchased(entitlement);
  useEffect(() => {
    if (activation?.key) {
      setKey(activation.key);
      setMsg(null);
    }
  }, [activation?.id, activation?.key]);


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
      if (activation) clearLicenseActivation(activation.id);
    } else {
      setMsg({ text: result.error ?? 'Could not verify that key.', ok: false });
    }
    setBusy(false);
  }, [key, busy, redeemLicense, activation]);

  const onRecover = async () => {
    if (recovering) return;
    const normalized = email.trim();
    if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      setRecoveryMessage('Enter the email used for your Direct purchase.');
      return;
    }
    setRecovering(true);
    setRecoveryMessage(null);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('https://couchside-license-webhook.taylor-c24.workers.dev/recover', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: normalized }), signal: controller.signal,
      });
      setRecoveryMessage(response.status === 202
        ? 'If a purchase matches that email, we’ll send its license. Check your inbox and spam folder, then tap Open in Couchside in the email.'
        : 'Recovery is temporarily unavailable. Try again later or contact support@couchside.tv.');
    } catch {
      setRecoveryMessage('Couldn’t reach license recovery. Check your internet connection and try again.');
    } finally {
      clearTimeout(timeout);
      setRecovering(false);
    }
  };

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
        accessibilityLabel="License key"
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
      <Pressable
        onPress={() => setRecover(!recover)}
        accessibilityRole="button"
        accessibilityState={{ expanded: recover }}
        style={({ pressed }) => [styles.buyLink, pressed && styles.pressed]}>
        <Text style={styles.buyLinkText}>Already purchased? Recover my license</Text>
      </Pressable>
      {recover && (
        <View>
          <Text style={styles.hint}>Use your Direct purchase email. We’ll email your key; it won’t be shown here. This does not restore Play Store purchases.</Text>
          <TextInput
            accessibilityLabel="Purchase email"
            value={email} onChangeText={setEmail}
            placeholder="Purchase email address"
            placeholderTextColor={styles._placeholder.color}
            autoCapitalize="none" autoCorrect={false}
            autoComplete="email" keyboardType="email-address"
            maxLength={254} editable={!recovering}
            style={[styles.input, { marginTop: 12 }]}
          />
          <Pressable onPress={() => void onRecover()} disabled={recovering || !email.trim()}
            accessibilityRole="button"
            style={({ pressed }) => [styles.btn, (pressed || recovering || !email.trim()) && styles.btnMuted]}>
            <Text style={styles.btnText}>{recovering ? 'REQUESTING…' : 'EMAIL MY LICENSE'}</Text>
          </Pressable>
          {recoveryMessage && <Text accessibilityLiveRegion="polite" style={styles.hint}>{recoveryMessage}</Text>}
          <Pressable onPress={() => void Linking.openURL('mailto:support@couchside.tv?subject=Couchside%20Direct%20license%20recovery')} style={styles.buyLink}>
            <Text style={styles.buyLinkText}>Can’t find the email? Contact support</Text>
          </Pressable>
        </View>
      )}
      <Text style={styles.hint}>
        {activation?.key ? 'Your emailed key is filled in. Tap Redeem to verify and unlock.' : 'Bought Couchside direct? Paste the key from your purchase email.'} It unlocks this
        device offline — no account, no store.
      </Text>
      <Pressable
        onPress={() => void Linking.openURL(BUY_URL)}
        hitSlop={8}
        style={({ pressed }) => [styles.buyLink, pressed && styles.pressed]}>
        <Text style={styles.buyLinkText}>Don't have a key? Buy a license →</Text>
      </Pressable>
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
  buyLink: { marginTop: 14, alignSelf: 'center' },
  buyLinkText: { color: t.blue, fontSize: 13, fontWeight: '700', fontFamily: mono },
  pressed: { opacity: 0.6 },
  // Palette values reached through the stylesheet so the component stays props-free.
  _placeholder: { color: t.textDim },
  _ok: { color: t.green },
  _err: { color: t.red },
});
