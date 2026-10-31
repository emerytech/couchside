import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { DECKY_BLINK_LINE, DECKY_ROOT_PLUGIN_LINE, installConfirmCopy, type InstallConfirmInput } from '@/lib/deckyPlugins';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

/** Content for the manager's existing modal. Keeping one native Modal avoids
 * presenting a second sheet while the plugin-actions sheet is dismissing. */
export function DeckyInstallConfirmation({ input, disabled, onCancel, onConfirm }: {
  input: InstallConfirmInput;
  disabled: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { okLabel } = installConfirmCopy(input);
  const downgrade = input.type === 'downgrade';
  return <>
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <View style={styles.heading}>
        <View style={styles.icon}><Ionicons name="extension-puzzle-outline" size={25} color={t.blue} /></View>
        <View style={styles.headingText}>
          <Text style={styles.eyebrow}>{okLabel.toUpperCase()} PLUGIN</Text>
          <Text accessibilityRole="header" style={styles.title}>{input.name}</Text>
          <Text style={styles.author}>By {input.author || 'unknown'}</Text>
        </View>
      </View>
      <View style={styles.versions}>
        {input.installedVersion ? <>
          <View style={styles.version}><Text style={styles.label}>Installed</Text><Text style={styles.versionText}>{input.installedVersion}</Text></View>
          <Ionicons name="arrow-forward" size={20} color={t.textFaint} />
        </> : null}
        <View style={styles.version}><Text style={styles.label}>{input.type === 'reinstall' ? 'Reinstall' : 'New version'}</Text><Text style={[styles.versionText, { color: downgrade ? t.amber : t.blue }]}>{input.remoteVersion}</Text></View>
      </View>
      {input.type === 'reinstall' ? <Text style={styles.body}>Decky removes the current copy before reinstalling.</Text> : null}
      {downgrade ? <Text style={[styles.body, { color: t.amber }]}>This replaces your installed version with an older release.</Text> : null}
      <View style={styles.detail}>
        <Ionicons name="shield-checkmark-outline" size={19} color={t.blue} />
        <Text style={styles.detailText}>Decky downloads the plugin and verifies its SHA-256 before installing.</Text>
      </View>
      <View style={styles.detail}>
        <Ionicons name="lock-closed-outline" size={19} color={input.root ? t.amber : t.textDim} />
        <Text style={[styles.detailText, input.root && { color: t.amber }]}>{input.root ? DECKY_ROOT_PLUGIN_LINE : 'Plugins run as your user, or as root when flagged.'}</Text>
      </View>
      {input.steamUiUp ? <View style={styles.notice}><Ionicons name="information-circle-outline" size={19} color={t.textDim} /><Text style={styles.detailText}>{DECKY_BLINK_LINE}</Text></View> : null}
      {disabled ? <Text accessibilityLiveRegion="polite" style={[styles.body, { color: t.amber }]}>Wait for the current operation to finish.</Text> : null}
    </ScrollView>
    <View style={styles.actions}>
      <Pressable accessibilityRole="button" onPress={onCancel} style={({ pressed }) => [styles.button, styles.cancel, pressed && styles.pressed]}><Text style={styles.cancelText}>Cancel</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onConfirm}
        testID="decky-confirm-install" style={({ pressed }) => [styles.button, { backgroundColor: downgrade ? t.red : t.blue }, (pressed || disabled) && styles.pressed]}>
        <Text style={styles.confirmText}>{okLabel}</Text>
      </Pressable>
    </View>
  </>;
}

const makeStyles = (t: Palette) => StyleSheet.create({
  scroll: { flexShrink: 1 },
  content: { gap: 16 },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  headingText: { flex: 1, gap: 4 },
  icon: { width: 48, height: 48, borderRadius: 13, backgroundColor: t.inset, alignItems: 'center', justifyContent: 'center' },
  eyebrow: { color: t.blue, fontSize: 10, fontWeight: '700', letterSpacing: 1.3 },
  title: { color: t.text, fontSize: 20, fontWeight: '800' },
  author: { color: t.textDim, fontSize: 12 },
  versions: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, backgroundColor: t.inset, borderRadius: 12 },
  version: { flex: 1, gap: 5 },
  label: { color: t.textDim, fontSize: 11 },
  versionText: { color: t.text, fontSize: 16, fontFamily: mono, fontWeight: '600' },
  body: { color: t.textDim, fontSize: 13, lineHeight: 19 },
  detail: { flexDirection: 'row', alignItems: 'flex-start', gap: 9 },
  detailText: { flex: 1, color: t.textDim, fontSize: 12, lineHeight: 18 },
  notice: { flexDirection: 'row', gap: 9, padding: 12, backgroundColor: t.inset, borderRadius: 10 },
  actions: { flexDirection: 'row', gap: 10, paddingTop: 4 },
  button: { flex: 1, minHeight: 46, paddingVertical: 12, paddingHorizontal: 12, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  cancel: { backgroundColor: t.inset, borderColor: t.cardBorder, borderWidth: 1 },
  cancelText: { color: t.textDim, fontSize: 14, fontWeight: '700' },
  confirmText: { color: t.onAccent, fontSize: 14, fontWeight: '800' },
  pressed: { opacity: 0.6 },
});
