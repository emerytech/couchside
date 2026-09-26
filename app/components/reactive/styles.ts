/** Shared styling for the reactive-mode panels (meter, playtime, …). Kept in one
 *  place so every mode panel reads as one system. */
import { StyleSheet } from 'react-native';

import { mono, type Palette } from '@/lib/theme';

export const reactiveStyles = (t: Palette) =>
  StyleSheet.create({
    hint: { color: t.textFaint, fontSize: 11, fontFamily: mono, marginBottom: 4 },
    sectionLabel: {
      color: t.textFaint, fontSize: 10, fontWeight: '700', letterSpacing: 1.2,
      fontFamily: mono, marginTop: 14, marginBottom: 8,
    },
    sliderHeader: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
    readout: { color: t.textDim, fontSize: 11, fontFamily: mono, marginBottom: 2 },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    chip: {
      borderColor: t.cardBorder, borderWidth: 1, borderRadius: 999,
      paddingVertical: 6, paddingHorizontal: 12,
    },
    chipOn: { borderColor: t.blue, backgroundColor: t.card },
    chipText: { color: t.textDim, fontSize: 12, fontFamily: mono },
    chipTextOn: { color: t.text, fontWeight: '700' },
    pressed: { opacity: 0.6 },
    track: {
      height: 18, borderRadius: 9, backgroundColor: t.card, overflow: 'hidden',
      borderWidth: StyleSheet.hairlineWidth, borderColor: t.cardBorder,
    },
    fill: { height: '100%', borderRadius: 9 },
    swatch: { width: 22, height: 22, borderRadius: 6, borderWidth: 1, borderColor: t.cardBorder },
  });
