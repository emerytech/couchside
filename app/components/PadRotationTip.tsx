import { Pressable, Text, View } from 'react-native';
import { useTheme } from '@/lib/theme';
import { ROTATION_TIP_BODY, ROTATION_TIP_TITLE } from '@/lib/padPresets';

/** Inline callout: no modal, scrim, timer, or interception of pad touches. */
export function PadRotationTip({ onDismiss }: { onDismiss: () => void }) {
  const t = useTheme();
  return (
    <View style={{ backgroundColor: t.card, borderColor: t.cardBorder, borderWidth: 1, borderRadius: 12, padding: 12, gap: 4 }}>
      <Text style={{ color: t.text, fontSize: 14, fontWeight: '600' }}>{ROTATION_TIP_TITLE}</Text>
      <Text style={{ color: t.textDim, fontSize: 13 }}>{ROTATION_TIP_BODY}</Text>
      <Pressable onPress={onDismiss} accessibilityRole="button" style={{ minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start', paddingHorizontal: 8 }}>
        <Text style={{ color: t.blue, fontSize: 14, fontWeight: '600' }}>Got it</Text>
      </Pressable>
    </View>
  );
}
