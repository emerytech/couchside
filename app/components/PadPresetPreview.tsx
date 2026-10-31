import { useEffect, useMemo, useState } from 'react';
import { AppState, View } from 'react-native';
import { CustomPresetPad, CatalogPad, LandscapePad, StardewPad } from './LandscapePad';
import { isGamePadId } from '@/lib/gamePadCatalog';
import { previewLayout } from '@/lib/padPresetGallery';
import type { PadPreset } from '@/lib/padPresets';
import { useTheme } from '@/lib/theme';

// Deliberately no client, connection, box or transport. Renderers own the local
// pressed/stick visuals; every output terminates here, including guide/QAM.
const NOOP = () => {};
const LOCAL_INPUTS = {
  btn: () => ({ onDown: NOOP, onUp: NOOP }), trig: () => ({ onDown: NOOP, onUp: NOOP }),
  stickMove: () => NOOP, stickRelease: () => NOOP,
  qam: NOOP, locked: false, onToggleLock: NOOP, onExit: NOOP, onVariant: NOOP, onSettings: NOOP,
};
export function PadPresetPreview({ preset, interactive, expanded = false }: {
  preset: PadPreset; interactive: boolean; expanded?: boolean;
}) {
  const t = useTheme();
  const [area, setArea] = useState({ width: 0, height: 0 });
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    const sub = AppState.addEventListener('change', () => setEpoch(n => n + 1));
    return () => sub.remove();
  }, []);
  const width = expanded ? Math.min(area.width, area.height * 844 / 390) : area.width;
  const layout = useMemo(() => previewLayout(preset, width), [preset, width]);
  return <View testID="preset-preview" onLayout={e => setArea(e.nativeEvent.layout)}
    style={{ ...(expanded ? { flex: 1 } : { aspectRatio: 844 / 390 }), width: '100%',
      alignItems: 'center', justifyContent: 'center', overflow: 'hidden', borderRadius: expanded ? 0 : 16, backgroundColor: t.bg }}>
    {layout.ok && <View key={`${JSON.stringify(preset)}:${interactive}:${width}:${epoch}`}
      pointerEvents={interactive ? 'auto' : 'none'} accessibilityElementsHidden={!interactive}
      importantForAccessibility={interactive ? 'auto' : 'no-hide-descendants'}
      style={{ width, height: width * 390 / 844 }}>
      {preset.custom ? <CustomPresetPad preset={preset} layout={layout} {...LOCAL_INPUTS} /> : isGamePadId(preset.id) ? <CatalogPad presetId={preset.id} background={preset.background} layout={layout} {...LOCAL_INPUTS} />
        : preset.id === 'current' ? <LandscapePad layout={layout} {...LOCAL_INPUTS} />
        : <StardewPad variant={preset.id} background={preset.background} layout={layout} {...LOCAL_INPUTS} />}
    </View>}
  </View>;
}
