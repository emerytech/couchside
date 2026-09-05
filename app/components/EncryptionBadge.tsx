/**
 * Encryption indicator for a box.
 *
 * Honest by construction: a `secure` box is pinned + fail-closed — if the cert
 * pin ever fails it goes UNREACHABLE, never silently plaintext — so "secure" ==
 * genuinely encrypted whenever the box is reachable. A box that isn't `secure`
 * talks plain HTTP, token and all. So the badge never lies:
 *   - closed green lock  -> TLS, cert-pinned to the one paired (encrypted)
 *   - open amber lock     -> plain HTTP (token + traffic in the clear)
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { Alert, Pressable, Text, View } from 'react-native';

import { useTheme } from '@/lib/theme';

/** Compact lock glyph — for the box switcher pill + fleet rows. */
export function LockBadge({ secure, size = 13 }: { secure?: boolean; size?: number }) {
  const t = useTheme();
  return (
    <Ionicons
      name={secure ? 'lock-closed' : 'lock-open-outline'}
      size={size}
      color={secure ? t.green : t.amber}
      accessibilityLabel={secure ? 'Encrypted connection' : 'Unencrypted connection'}
    />
  );
}

/** Lock + word + a tap-through explainer — for the setup / box-detail screen. */
export function EncryptionBadge({ secure }: { secure?: boolean }) {
  const t = useTheme();
  const explain = () =>
    Alert.alert(
      secure ? 'Encrypted connection' : 'Unencrypted connection',
      secure
        ? 'Traffic to this box — including your access token — is encrypted with TLS, and '
          + "the box's certificate is pinned to the exact one you paired. Nobody else on your "
          + 'network can read it.'
        : 'This box uses plain HTTP: your access token and traffic travel in the clear on your '
          + 'local network. Update the box agent, enable encryption on the box, and re-pair '
          + '(scan its QR) to turn it on.',
    );
  return (
    <Pressable onPress={explain} hitSlop={8}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <LockBadge secure={secure} size={15} />
        <Text style={{ color: secure ? t.green : t.amber, fontSize: 13, fontWeight: '600' }}>
          {secure ? 'Encrypted' : 'Unencrypted'}
        </Text>
        <Ionicons name="information-circle-outline" size={13} color={t.textDim} />
      </View>
    </Pressable>
  );
}
