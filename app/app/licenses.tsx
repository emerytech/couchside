/**
 * Open Source Licenses — attribution + license notices for third-party works
 * Couchside references.
 *
 * The load-bearing entry is OpenPuck: an AGPL-3.0 firmware (safijari's project,
 * EmeryTech fork) that Couchside DOWNLOADS at flash time and writes to a plugged-in
 * board. Couchside never embeds or compiles OpenPuck's source, so the app is not a
 * derivative work; because Couchside distributes the firmware binary, AGPL-3.0 §6
 * asks that the corresponding source be offered — the "View source" link below at
 * the exact shipped tag IS that offer. Nothing on this screen is interactive beyond
 * the links; it exists to satisfy attribution + the source offer.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Linking from 'expo-linking';
import { Stack, router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useLockOrientation } from '@/hooks/useLockOrientation';
import { hapticLight } from '@/lib/haptics';
import { useTheme, useThemedStyles, type Palette } from '@/lib/theme';

// OpenPuck firmware — MUST stay in lockstep with the pinned build the agent flashes
// (agent _OPENPUCK_FW_TAG / OPENPUCK-NOTICE.txt). The source link is the AGPL §6
// offer and must point at the EXACT shipped tag, never a moving branch.
const OPENPUCK = {
  version: 'OpenPuck 0.9.40',
  originalAuthor: 'safijari',
  originalUrl: 'https://github.com/safijari/openpuck',
  forkUrl: 'https://github.com/emerytech/openpuck',
  sourceAtTagUrl: 'https://github.com/emerytech/openpuck/tree/0.9.40',
  releasesUrl: 'https://github.com/emerytech/openpuck/releases',
  licenseUrl: 'https://www.gnu.org/licenses/agpl-3.0.html',
};

function LinkRow({ icon, label, url }: { icon: string; label: string; url: string }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      onPress={() => { hapticLight(); void Linking.openURL(url); }}
      style={({ pressed }) => [styles.linkRow, pressed && { opacity: 0.7 }]}
      accessibilityRole="link"
      accessibilityLabel={label}
    >
      <Ionicons name={icon as never} size={16} color={t.blue} />
      <Text style={styles.linkText}>{label}</Text>
      <Ionicons name="open-outline" size={14} color={t.textDim} />
    </Pressable>
  );
}

export default function LicensesScreen() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  useLockOrientation('portrait'); // like every screen but the Pad

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel="Back">
          <Ionicons name="chevron-back" size={26} color={t.text} />
        </Pressable>
        <Text style={styles.title}>Open source licenses</Text>
        <View style={{ width: 26 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 14, paddingBottom: insets.bottom + 24 }}>
        <Text style={styles.lede}>
          Couchside references third-party works. Their authors and licenses are
          credited here.
        </Text>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>OpenPuck firmware</Text>
          <Text style={styles.cardMeta}>{OPENPUCK.version} · AGPL-3.0</Text>
          <Text style={styles.body}>
            OpenPuck turns a plugged-in nRF52840 board into a Steam Controller 2
            wireless receiver. It is a separate work by {OPENPUCK.originalAuthor}
            {', modified by EmeryTech.'} It runs on the board — never inside the
            Couchside app. Couchside downloads the released firmware at flash time
            and writes it to your board; it does not embed or compile OpenPuck&apos;s
            source.
          </Text>
          <Text style={styles.body}>
            OpenPuck is licensed under the GNU Affero General Public License v3.0.
            Because Couchside distributes the firmware, the corresponding source for
            the exact build it flashes is offered at the shipped tag below. The app
            pins {OPENPUCK.version} by default; if you opt into flashing a newer build,
            its source is published under that build&apos;s own tag on the fork
            (see all releases).
          </Text>
          <View style={styles.links}>
            <LinkRow icon="git-branch-outline" label="View source (at the shipped tag)" url={OPENPUCK.sourceAtTagUrl} />
            <LinkRow icon="albums-outline" label="All releases + their source (fork)" url={OPENPUCK.releasesUrl} />
            <LinkRow icon="person-outline" label={`Original project — ${OPENPUCK.originalAuthor}`} url={OPENPUCK.originalUrl} />
            <LinkRow icon="git-network-outline" label="EmeryTech fork" url={OPENPUCK.forkUrl} />
            <LinkRow icon="document-text-outline" label="AGPL-3.0 license text" url={OPENPUCK.licenseUrl} />
          </View>
        </View>

        <Text style={styles.footer}>
          Couchside itself is licensed separately and does not incorporate
          OpenPuck&apos;s code.
        </Text>
      </ScrollView>
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
    lede: { color: t.textFaint, fontSize: 13, lineHeight: 18, marginBottom: 14 },
    card: {
      borderRadius: 14, borderWidth: 1, borderColor: t.cardBorder,
      backgroundColor: t.card, padding: 14,
    },
    cardTitle: { color: t.text, fontSize: 16, fontWeight: '800' },
    cardMeta: { color: t.textFaint, fontSize: 12, fontWeight: '700', marginTop: 2, marginBottom: 10 },
    body: { color: t.textDim, fontSize: 13, lineHeight: 19, marginBottom: 10 },
    links: { marginTop: 4, gap: 4 },
    linkRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 },
    linkText: { color: t.blue, fontSize: 13, fontWeight: '700', flex: 1 },
    footer: { color: t.textFaint, fontSize: 12, lineHeight: 18, marginTop: 16 },
  });
