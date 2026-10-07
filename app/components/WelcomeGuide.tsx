import Ionicons from '@expo/vector-icons/Ionicons';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useReducedMotion } from '@/lib/skin/motion';
import { useTheme, useThemedStyles, type Palette } from '@/lib/theme';

const LOGO = require('../assets/images/icon.png');

/** The approved welcome design, using the same brand asset as the app icon. */
export function WelcomeGuide({ onStart, onExplore }: { onStart: () => void; onExplore: () => void }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  return (
    <ScrollView style={styles.screen} contentContainerStyle={[styles.scroll,
      { paddingTop: insets.top + 20, paddingBottom: insets.bottom + 16 }]}
      alwaysBounceVertical={false}>
      <View style={styles.content}>
        <View style={styles.brand}>
          <Image source={LOGO} style={styles.smallLogo} accessible={false} />
          <Text style={styles.wordmark}>couchside</Text>
        </View>
        <Animated.View entering={reduced ? undefined : FadeInDown.duration(240)} style={styles.hero}>
          <View style={styles.glow} />
          <Image source={LOGO} accessibilityLabel="Couchside logo" style={styles.logo} />
        </Animated.View>
        <Animated.View entering={reduced ? undefined : FadeInDown.duration(280)}>
          <Text style={styles.heading}>{'Welcome to\nCouchside.'}</Text>
          <Text style={styles.tagline}>Your couch. Your games. Your remote.</Text>
          <Text style={styles.copy}>I built Couchside to make using a gaming PC from the couch easier. Launch games, control your box, and troubleshoot—all from your phone.</Text>
          <Text style={styles.copy}>Or connect directly to a supported smart TV and make your phone the remote.</Text>
          <View style={styles.signature}>
            <Ionicons name="heart-outline" size={17} color={t.green} accessible={false} />
            <Text style={styles.signatureText}>{'An independent project, built with care.\nThanks for giving it a try. — Taylor'}</Text>
          </View>
        </Animated.View>
        <View style={styles.actions}>
          <Pressable accessibilityRole="button" onPress={onStart}
            style={({ pressed }) => [styles.primary, pressed && styles.pressed]}>
            <Text style={styles.primaryText}>Get started</Text>
            <Ionicons name="arrow-forward" size={19} color={t.onAccent} accessible={false} />
          </Pressable>
          <Pressable accessibilityRole="button" onPress={onExplore}
            style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}>
            <Text style={styles.secondaryText}>Explore first</Text>
          </Pressable>
        </View>
      </View>
    </ScrollView>
  );
}

const makeStyles = (t: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: t.bg },
  scroll: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 27 },
  content: { width: '100%', maxWidth: 390, alignSelf: 'center' },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  smallLogo: { width: 30, height: 30, borderRadius: 7 },
  wordmark: { color: t.text, fontSize: 16, fontWeight: '600', letterSpacing: -0.3 },
  hero: { height: 205, marginTop: 20, alignItems: 'center', justifyContent: 'center' },
  glow: { position: 'absolute', width: 160, height: 140, borderRadius: 70,
    backgroundColor: t.bg, boxShadow: `0 0 55px 8px ${t.blue}20` },
  logo: { width: 130, height: 130, borderRadius: 30 },
  heading: { color: t.text, fontSize: 32, lineHeight: 35, letterSpacing: -1.1, fontWeight: '700', marginTop: 10, marginBottom: 15 },
  tagline: { color: t.blue, fontSize: 16, lineHeight: 24, fontWeight: '500', marginBottom: 21 },
  copy: { color: t.textDim, fontSize: 14, lineHeight: 23, marginBottom: 14 },
  signature: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 5 },
  signatureText: { flex: 1, color: t.textDim, fontSize: 12, lineHeight: 19 },
  actions: { marginTop: 27, gap: 10 },
  primary: { minHeight: 54, paddingVertical: 14, paddingHorizontal: 16, borderRadius: 15,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, backgroundColor: t.accent },
  primaryText: { color: t.onAccent, fontSize: 16, fontWeight: '600' },
  secondary: { minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingVertical: 10 },
  secondaryText: { color: t.textDim, fontSize: 13 },
  pressed: { opacity: 0.8 },
});
