import { useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PadPresetGallery } from './PadPresetGallery';
import { PadRotationTip } from './PadRotationTip';
import type { PadPreset } from '@/lib/padPresets';
import { setPref } from '@/lib/prefs';
import type { Box } from '@/lib/settings';
import { useTheme } from '@/lib/theme';

const NOOP = () => {};
/** A fresh gallery draft on every open. Save writes the library; Apply also selects the active preset. */
export function PadPresetSheet({ kind, box, onClose, onApply, onLibrary, onExpandedChange = NOOP }: {
  kind: 'presets' | 'help'; box: Box | undefined; onClose(): void;
  onApply(preset: PadPreset, library?: PadPreset[]): Promise<void>; onLibrary(library: PadPreset[], active?: PadPreset): Promise<void>; onExpandedChange?(expanded: boolean): void;
}) {
  const t = useTheme(), insets = useSafeAreaInsets();
  const [saving, setSaving] = useState(false);
  const [showTip, setShowTip] = useState(false);
  const [replayQueued, setReplayQueued] = useState(false);
  const body = (text: string) => <Text style={{ color: t.textDim, fontSize: 14, lineHeight: 21 }}>{text}</Text>;
  const button = (label: string, action: () => void) => <Pressable accessibilityRole="button" onPress={action}
    style={{ padding: 14, minHeight: 44, backgroundColor: t.card, borderRadius: 12, borderWidth: 1, borderColor: t.cardBorder }}>
    <Text style={{ color: t.text }}>{label}</Text></Pressable>;
  return <Modal visible animationType="slide" supportedOrientations={['portrait', 'landscape-left', 'landscape-right']}
    onRequestClose={() => { if (!saving) onClose(); }}>
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: Math.max(insets.top, 8),
      paddingBottom: Math.max(insets.bottom, 8), paddingLeft: insets.left, paddingRight: insets.right }}>
      {kind === 'presets' ? <PadPresetGallery box={box} onApply={onApply} onLibrary={onLibrary} onClose={onClose}
        onExpandedChange={onExpandedChange} onSavingChange={setSaving} />
      : <ScrollView contentContainerStyle={{ padding: 20, gap: 16, maxWidth: 720, width: '100%', alignSelf: 'center' }}>
        <Text accessibilityRole="header" style={{ color: t.text, fontSize: 22, fontWeight: '700' }}>Controller help</Text>
            {body('Open the Pad tab, select PAD, then turn your phone sideways for the full-screen controller. A game does not need to be running. Mouse and other modes behave differently.')}
            {body('If PAD is unavailable, connect to a box that supports a gamepad. Keyboard-only mode hides PAD; Auto-drop pad can also hide it while a game is running. If another phone has control, use the existing control request before playing.')}
            {body('If rotation does not expand PAD, check your phone’s rotation lock. After using Exit, turn upright before rotating sideways again. Small windows may not have enough room for the controller.')}
            {body('Choose a preset in Setup → Prefs → Pad Layout → Control presets. Game presets change only full-screen landscape PAD. Choose Current controls and Apply to return to your exact saved configuration. The Stardew farm background applies only to this preset; choose My usual background to keep your existing backdrop. Your saved theme and game bindings are never overwritten.')}
            {button('Show rotation tip', () => {
              setShowTip(true); setReplayQueued(true);
              void setPref('padRotationTipLearned', false);
            })}
            {showTip && <PadRotationTip onDismiss={() => {
              setShowTip(false); setReplayQueued(false);
              void setPref('padRotationTipLearned', true);
            }} />}
            {replayQueued && body('The tip will also appear next time you use PAD upright while connected. Got it dismisses it there too.')}
            {button('Done', onClose)}
      </ScrollView>}
    </View>
  </Modal>;
}
