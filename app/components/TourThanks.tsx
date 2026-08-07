/**
 * A word of thanks after someone walks the whole feature tour.
 *
 * THE PRICE COMES FROM THE STORE, and is never written down here.
 * getProduct().displayPrice is what App Store Connect / Play Console actually
 * charges, so changing the price there changes this line with no app release —
 * the remote-config behaviour you would otherwise build, except it cannot
 * disagree with the receipt, and it is already localised and in the reader's own
 * currency. A hardcoded "$4.99" would be a false claim the day the price steps
 * up and a wrong one today for anybody paying in euros; this app has already
 * taken one App Review rejection over how IAP was presented.
 *
 * IF THE STORE DOES NOT ANSWER, THE SENTENCE LOSES ITS NUMBER rather than
 * falling back to a guess. "The lifetime unlock is discounted while it is early"
 * is true without a figure; a figure that might be wrong is not.
 *
 * IT DOES NOT SELL TO SOMEONE WHO ALREADY PAID. A supporter who reaches the end
 * of the tour gets thanked; they do not get a discount pitch for a thing they
 * have already bought. Same message, different second half.
 *
 * SHOWN ONCE, AND ONLY ON A REAL FINISH — never after "Skip tour", which is
 * someone asking to be left alone. See hooks/useTourThanks.ts.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { dismissTourThanks } from '@/hooks/useTourThanks';
import { isGenuinelyPurchased } from '@/lib/entitlement';
import { useEntitlement } from '@/lib/EntitlementContext';
import { hapticLight } from '@/lib/haptics';
import { getProduct } from '@/lib/purchase';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

export function TourThanks() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const { entitlement } = useEntitlement();

  const owned = isGenuinelyPurchased(entitlement);

  // The live store price. Null until it answers, and null forever if it cannot
  // be reached — the copy below drops the number in that case rather than
  // inventing one.
  const [price, setPrice] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (owned) return;
    let alive = true;
    void (async () => {
      const p = await getProduct();
      if (alive && p?.displayPrice) setPrice(p.displayPrice);
    })();
    return () => {
      alive = false;
    };
  }, [owned]);

  const close = () => {
    hapticLight();
    dismissTourThanks();
  };

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Pressable style={styles.scrim} onPress={close} accessibilityLabel="Dismiss" />
      <View style={styles.wrap} pointerEvents="box-none">
        <View style={styles.card}>
          <View style={styles.badge}>
            <Ionicons name="heart" size={16} color={t.green} />
          </View>

          <Text style={styles.title}>Thanks for giving it a go</Text>

          <Text style={styles.body}>
            Couchside is a passion project. I hope you find it genuinely useful — and I am
            committed to making it better as time goes on.
          </Text>

          {owned ? (
            <Text style={styles.body}>
              You have already bought the unlock, and that is the thing that keeps this going.
              Thank you, sincerely.
            </Text>
          ) : (
            <Text style={styles.body}>
              Any purchase during these early days is appreciated more than you would guess.
              The lifetime unlock is discounted{price ? ` to ${price}` : ''} while it is early —
              one payment, no subscription, ever.
            </Text>
          )}

          <View style={styles.actions}>
            {owned ? null : (
              <Pressable
                onPress={() => {
                  hapticLight();
                  dismissTourThanks();
                  // navigate, NOT push: a push creates a SECOND (tabs) entry on the root
                  // stack, and every duplicate entry arms the iOS back-swipe with a
                  // screen to pop to — measured pulling the pad out from under a
                  // stick drag (see _layout.tsx). navigate switches tabs in place.
                  router.navigate('/(tabs)/setup?tab=account');
                }}
                accessibilityRole="button"
                style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}>
                <Text style={styles.secondaryText}>SEE THE UNLOCK</Text>
              </Pressable>
            )}
            <Pressable
              onPress={close}
              accessibilityRole="button"
              style={({ pressed }) => [styles.primary, pressed && styles.pressed]}>
              <Text style={styles.primaryText}>{owned ? 'THANKS' : 'NOT NOW'}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#000000b0' },
    wrap: { flex: 1, justifyContent: 'center', paddingHorizontal: 22 },
    card: {
      backgroundColor: t.card,
      borderRadius: 18,
      borderWidth: 1,
      borderColor: t.cardBorder,
      padding: 20,
      gap: 12,
    },
    badge: {
      width: 34,
      height: 34,
      borderRadius: 17,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: t.inset,
      borderWidth: 1,
      borderColor: t.cardBorder,
    },
    title: { color: t.text, fontSize: 19, fontWeight: '800' },
    body: { color: t.textDim, fontSize: 13.5, lineHeight: 20 },
    actions: { flexDirection: 'row', gap: 10, marginTop: 6 },
    secondary: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 12,
      paddingVertical: 13,
      backgroundColor: t.green,
    },
    secondaryText: { color: '#04140c', fontSize: 13, fontWeight: '900', letterSpacing: 1, fontFamily: mono },
    primary: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 12,
      paddingVertical: 13,
      backgroundColor: t.inset,
      borderWidth: 1,
      borderColor: t.cardBorder,
    },
    primaryText: { color: t.textDim, fontSize: 13, fontWeight: '800', letterSpacing: 1, fontFamily: mono },
    pressed: { opacity: 0.75 },
  });
