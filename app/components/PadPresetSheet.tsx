import { useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LandscapePad, StardewPad } from '@/components/LandscapePad';
import { PadRotationTip } from '@/components/PadRotationTip';
import { padLayout, stardewLayout } from '@/lib/padLayout';
import { CURRENT_CONTROLS, normalizePadPreset, type PadPreset } from '@/lib/padPresets';
import { setPref } from '@/lib/prefs';
import type { Box } from '@/lib/settings';
import { mono, useTheme } from '@/lib/theme';

const NOOP = () => {};
const previewControls = {
  btn: () => ({ onDown: NOOP, onUp: NOOP }),
  trig: () => ({ onDown: NOOP, onUp: NOOP }),
  stickMove: () => NOOP, stickRelease: () => NOOP,
  qam: NOOP, locked: false, onToggleLock: NOOP, onExit: NOOP, onVariant: NOOP,
};

/** Uses the actual renderer with inert inputs, never a connection or a live pad. */
function Preview({ preset }: { preset: PadPreset }) {
  const t = useTheme();
  const [width, setWidth] = useState(0);
  const win = { width: 844, height: 390 };
  const insets = { left: 47, right: 0, top: 0, bottom: 21 };
  const layout = preset.id === 'current' ? padLayout(win, insets) : stardewLayout(win, insets, preset.size);
  const scale = width / win.width;
  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={{ height: width ? win.height * scale : 160, overflow: 'hidden', borderRadius: 12, backgroundColor: t.bg }}
      accessibilityLabel={`${preset.id === 'current' ? 'Current controls' : 'Stardew Valley'} landscape preview. Preview does not send input.`}>
      {width > 0 && layout.ok && (
        <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
          style={{ width: win.width, height: win.height, transformOrigin: 'top left', transform: [{ scale }] }}>
          {preset.id === 'current'
            ? <LandscapePad layout={layout} {...previewControls} />
            : <StardewPad background={preset.background} layout={layout} {...previewControls} />}
        </View>
      )}
    </View>
  );
}

/** Mounted afresh on each open; draft edits have no effect until Apply. */
export function PadPresetSheet({ kind, box, onClose, onApply }: {
  kind: 'presets' | 'help';
  box: Box | undefined;
  onClose: () => void;
  onApply: (preset: PadPreset) => Promise<void>;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState(() => normalizePadPreset(box?.controlPreset));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showTip, setShowTip] = useState(false);
  const [replayQueued, setReplayQueued] = useState(false);
  const button = (label: string, onPress: () => void, selected = false, disabled = false) => (
    <Pressable key={label} onPress={onPress} disabled={disabled} accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      style={({ pressed }) => ({ minHeight: 44, padding: 12, borderRadius: 10, borderWidth: 1,
        borderColor: selected ? t.blue : t.cardBorder, backgroundColor: t.card, opacity: disabled ? 0.5 : pressed ? 0.7 : 1 })}>
      <Text style={{ color: selected ? t.blue : t.text, fontFamily: mono, fontSize: 14 }}>{label}</Text>
    </Pressable>
  );
  const body = (text: string) => <Text style={{ color: t.textDim, fontSize: 14, lineHeight: 21 }}>{text}</Text>;
  return (
    <Modal visible animationType="slide" onRequestClose={() => { if (!saving) onClose(); }}>
      <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: Math.max(insets.top, 16), paddingBottom: Math.max(insets.bottom, 16) }}>
        <ScrollView contentContainerStyle={{ padding: 20, gap: 16, width: '100%', maxWidth: 720, alignSelf: 'center' }}>
          <Text accessibilityRole="header" style={{ color: t.text, fontSize: 22, fontWeight: '700' }}>
            {kind === 'presets' ? 'Control presets' : 'Controller help'}
          </Text>
          {kind === 'presets' ? <>
            {body(box ? `For ${box.name} on this phone. Applies only to full-screen PAD when you turn sideways.` : 'Pair a box to save a preset. You can still preview the layouts here.')}
            {button('Current controls', () => setDraft(CURRENT_CONTROLS), draft.id === 'current', saving)}
            {button('Stardew Valley', () => setDraft({ version: 1, id: 'stardew', size: 'larger' }), draft.id === 'stardew', saving)}
            {draft.id === 'stardew' && <>
              <View style={{ flexDirection: 'row', gap: 12 }}>
                {button('Standard', () => setDraft({ ...draft, size: 'standard' }), draft.size === 'standard', saving)}
                {button('Larger', () => setDraft({ ...draft, size: 'larger' }), draft.size === 'larger', saving)}
              </View>
              <Text style={{ color: t.text, fontFamily: mono }}>Background</Text>
              {button('Stardew farm', () => setDraft({ ...draft, background: 'farm' }), draft.background !== 'current', saving)}
              {button('My usual background', () => setDraft({ ...draft, background: 'current' }), draft.background === 'current', saving)}
              {body('Stardew’s Xbox controls: X uses tools; A interacts or selects; B opens inventory or goes back; Y opens crafting. LT/RT select the previous/next item, or switch menu tabs. Hold Use tool to charge an upgraded tool. Start opens the menu; multiplayer does not pause.')}
              {body('Uses the game’s default Xbox bindings. Custom Steam Input layouts can change these actions. Move also navigates menus. Choose Current controls for the right stick, journal, and LB/RB toolbar-row controls.')}
            </>}
            <Preview preset={draft} />
            {body('Landscape preview · controls are inactive. The farm background applies only to this preset. Your button colors, portrait PAD, gestures and saved theme stay as they are. Current controls restores your usual layout.')}
            {!!error && <Text accessibilityRole="alert" style={{ color: t.red }}>{error}</Text>}
            {button(saving ? 'Applying…' : 'Apply', () => {
              setSaving(true); setError('');
              void onApply(draft).then(onClose).catch(() => {
                setError('Could not save the preset. Please try again.');
              }).finally(() => setSaving(false));
            }, true, !box || saving)}
            {button('Cancel', onClose, false, saving)}
          </> : <>
            {body('Open the Pad tab, select PAD, then turn your phone sideways for the full-screen controller. A game does not need to be running. Mouse and other modes behave differently.')}
            {body('If PAD is unavailable, connect to a box that supports a gamepad. Keyboard-only mode hides PAD; Auto-drop pad can also hide it while a game is running. If another phone has control, use the existing control request before playing.')}
            {body('If rotation does not expand PAD, check your phone’s rotation lock. After using Exit, turn upright before rotating sideways again. Small windows may not have enough room for the controller.')}
            {body('Choose a preset in Setup → Prefs → Pad Layout → Control presets. Stardew changes only landscape PAD. Choose Current controls and Apply to return to your exact saved configuration. The Stardew farm background applies only to this preset; choose My usual background to keep your existing backdrop. Your saved theme and game bindings are never overwritten.')}
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
          </>}
        </ScrollView>
      </View>
    </Modal>
  );
}
