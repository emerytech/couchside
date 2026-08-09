/**
 * Controller theme picker — a scrollable grid of PREVIEW cards, one per theme.
 *
 * Replaces the old 37-option segmented control in Setup → Prefs, which stacked
 * every theme name in a tall, unreadable column. Each card shows the theme's
 * actual backdrop art (or the derived glow the controller draws when the art
 * isn't bundled yet), a strip of its accent + face-button colours, and its name;
 * the selected one is ringed in its own accent with a check. Tapping a card
 * writes the `controllerTheme` pref immediately and stays on the page, so you can
 * browse and compare — the check just moves. "Off" and "Auto" are the first two
 * cards. Nothing here touches the input path; it's pure selection UI.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, router } from 'expo-router';
import {
  FlatList, Image, Pressable, StyleSheet, Text, useWindowDimensions, View,
  type ImageSourcePropType,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useLockOrientation } from '@/hooks/useLockOrientation';
import { hapticSelection } from '@/lib/haptics';
import {
  THEMES, THEME_PICKER, type ControllerThemePref, type ThemeKey,
} from '@/lib/gameTheme';
import { backdropAssets } from '@/lib/gameThemeAssets';
import { setPref, usePref } from '@/lib/prefs';
import { useResolvedScheme, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

const BASE = '#0b1220'; // the same dark base the real backdrop sits on
const COLUMNS = 2;

const isSpecial = (v: ControllerThemePref): v is 'off' | 'auto' => v === 'off' || v === 'auto';

/** The mini backdrop for one theme card: real art if bundled, else the derived
 *  glow wash the controller itself falls back to, else plain. */
function ThemeArt({ value, dark }: { value: ThemeKey; dark: boolean }) {
  const bd = THEMES[value]?.backdrop;
  const assets = bd ? backdropAssets(bd.key) : null;
  if (assets) {
    return (
      <Image
        source={assets.portrait as ImageSourcePropType}
        style={StyleSheet.absoluteFill}
        resizeMode="cover"
      />
    );
  }
  if (bd) {
    const glow = dark ? bd.glow.dark : bd.glow.light;
    // Derived: a soft glow across the top half, exactly the palette the real art
    // will use — so a theme previews meaningfully before its art is made.
    return (
      <View style={StyleSheet.absoluteFill}>
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '60%', backgroundColor: glow, opacity: 0.45 }} />
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '32%', backgroundColor: glow, opacity: 0.3 }} />
      </View>
    );
  }
  return null;
}

function accentOf(value: ControllerThemePref, dark: boolean, fallback: string): string {
  if (isSpecial(value)) return fallback;
  const a = THEMES[value]?.accent;
  return a ? (dark ? a.dark : a.light) : fallback;
}

/** The accent + face-button colour dots shown along the card's bottom. */
function swatches(value: ControllerThemePref, dark: boolean, fallback: string): string[] {
  if (isSpecial(value)) return [];
  const th = THEMES[value];
  if (!th) return [];
  const out = [dark ? th.accent.dark : th.accent.light];
  const face = th.face;
  for (const k of ['a', 'b', 'x', 'y'] as const) {
    const f = face?.[k];
    if (f) out.push(dark ? f.dark : f.light);
  }
  return out.slice(0, 4);
}

function Card({
  value, label, selected, colW, onPress,
}: {
  value: ControllerThemePref;
  label: string;
  selected: boolean;
  colW: number;
  onPress: () => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const dark = useResolvedScheme() === 'dark';
  const accent = accentOf(value, dark, t.blue);
  const dots = swatches(value, dark, t.blue);

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        { width: colW },
        selected && { borderColor: accent, borderWidth: 2 },
        pressed && { opacity: 0.85 },
      ]}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`${label}${selected ? ', selected' : ''}`}
    >
      <View style={styles.art}>
        {isSpecial(value) ? (
          <View style={[StyleSheet.absoluteFill, styles.specialArt]}>
            <Ionicons
              name={value === 'off' ? 'remove-circle-outline' : 'sparkles-outline'}
              size={30}
              color={value === 'off' ? t.textFaint : t.blue}
            />
          </View>
        ) : (
          <ThemeArt value={value} dark={dark} />
        )}
        {/* A bottom scrim so the swatch dots read over bright art. */}
        <View style={styles.artScrim} pointerEvents="none" />
        {dots.length > 0 ? (
          <View style={styles.dots} pointerEvents="none">
            {dots.map((c, i) => (
              <View key={i} style={[styles.dot, { backgroundColor: c }]} />
            ))}
          </View>
        ) : null}
        {selected ? (
          <View style={[styles.check, { backgroundColor: accent }]}>
            <Ionicons name="checkmark" size={14} color={BASE} />
          </View>
        ) : null}
      </View>
      <Text style={[styles.name, selected && { color: t.text, fontWeight: '700' }]} numberOfLines={1}>
        {label}
      </Text>
      {value === 'auto' ? <Text style={styles.hint} numberOfLines={1}>matches the game</Text> : null}
      {value === 'off' ? <Text style={styles.hint} numberOfLines={1}>plain controller</Text> : null}
    </Pressable>
  );
}

export default function ThemePickerPage() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  useLockOrientation('portrait');

  const current = usePref('controllerTheme');
  const { width } = useWindowDimensions();
  const colW = Math.floor((width - 16 - 12 * (COLUMNS - 1)) / COLUMNS); // 8 padding + 12 gap

  const select = (v: ControllerThemePref) => {
    void setPref('controllerTheme', v);
    hapticSelection();
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel="Back">
          <Ionicons name="chevron-back" size={26} color={t.text} />
        </Pressable>
        <Text style={styles.title}>Controller theme</Text>
        <View style={{ width: 26 }} />
      </View>
      <Text style={styles.lede}>
        Styles the full-screen controller (MOVE / landscape pad). Tap to apply — the change is instant.
      </Text>

      <FlatList
        data={THEME_PICKER as ReadonlyArray<{ value: ControllerThemePref; label: string }>}
        keyExtractor={(o) => o.value}
        numColumns={COLUMNS}
        renderItem={({ item }) => (
          <Card
            value={item.value}
            label={item.label}
            selected={current === item.value}
            colW={colW}
            onPress={() => select(item.value)}
          />
        )}
        columnWrapperStyle={styles.row}
        contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: insets.bottom + 24 }}
        initialNumToRender={12}
        windowSize={7}
        removeClippedSubviews
      />
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.bg },
    header: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: 12, paddingVertical: 10,
    },
    title: { color: t.text, fontSize: 20, fontWeight: '800' },
    lede: { color: t.textFaint, fontSize: 13, lineHeight: 18, paddingHorizontal: 14, marginBottom: 10 },
    row: { gap: 12, paddingHorizontal: 0, marginBottom: 12 },
    card: { borderRadius: 14, borderWidth: 1, borderColor: t.cardBorder, backgroundColor: t.card, padding: 6 },
    art: {
      width: '100%', aspectRatio: 0.82, borderRadius: 10, overflow: 'hidden',
      backgroundColor: BASE, position: 'relative',
    },
    specialArt: { alignItems: 'center', justifyContent: 'center', backgroundColor: t.inset },
    artScrim: {
      position: 'absolute', left: 0, right: 0, bottom: 0, height: '40%',
      backgroundColor: 'rgba(11,18,32,0.55)',
    },
    dots: { position: 'absolute', left: 8, bottom: 8, flexDirection: 'row', gap: 5 },
    dot: { width: 12, height: 12, borderRadius: 6, borderWidth: 1, borderColor: 'rgba(0,0,0,0.35)' },
    check: {
      position: 'absolute', top: 6, right: 6, width: 22, height: 22, borderRadius: 11,
      alignItems: 'center', justifyContent: 'center',
    },
    name: { color: t.textDim, fontSize: 12, fontWeight: '600', marginTop: 6, paddingHorizontal: 2 },
    hint: { color: t.textFaint, fontSize: 10, paddingHorizontal: 2, marginTop: 1 },
  });
