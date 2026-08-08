/**
 * The styled backdrop behind the immersive controller (MOVE / landscape pad).
 *
 * Renders full-bleed under everything, `pointerEvents="none"` so it never eats a
 * touch. Two modes, chosen automatically:
 *
 *  - ART: when the running game's backdrop key resolves to a bundled image
 *    (lib/gameThemeAssets.ts), that image is drawn, orientation-correct.
 *  - DERIVED: when the art has not been made yet, a dark base with a soft glow
 *    in the top third is drawn from the theme's `glow` colour — the same palette
 *    the eventual art uses, so the mode is styled before its art exists.
 *
 * EITHER WAY a legibility SCRIM sits on top: a stack of translucent dark bands,
 * heaviest across the bottom where the movement zone and thumb clusters live.
 * That is what makes the feature safe regardless of the art — a too-bright asset
 * degrades to "slightly washed", never "buttons you cannot read". The scrim is
 * built from plain Views (no gradient dependency, works in the web harness too).
 *
 * Nothing here is on the input path; it is pure decoration under the controls.
 */
import { Image, StyleSheet, View, type ImageSourcePropType } from 'react-native';

import { backdropAssets } from '@/lib/gameThemeAssets';
import type { Backdrop } from '@/lib/gameTheme';

/** The dark base every backdrop sits on — the app's own bg, so a missing or
 *  transparent asset can never flash a bright frame. */
const BASE = '#0b1220';

/**
 * The legibility scrim. Four bands from top (light) to bottom (heavy): the
 * controls cluster in the lower half, so that is where the art is pushed down
 * most. Tuned so even a fully-white backdrop leaves the button glyphs (drawn in
 * the accent / face colours, all >= 3:1 on card) readable.
 */
function Scrim() {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <View style={[styles.band, { flex: 2, backgroundColor: 'rgba(11,18,32,0.28)' }]} />
      <View style={[styles.band, { flex: 2, backgroundColor: 'rgba(11,18,32,0.45)' }]} />
      <View style={[styles.band, { flex: 3, backgroundColor: 'rgba(11,18,32,0.62)' }]} />
      <View style={[styles.band, { flex: 4, backgroundColor: 'rgba(11,18,32,0.72)' }]} />
    </View>
  );
}

export function GameBackdrop({
  backdrop, landscape,
}: {
  backdrop: Backdrop | null;
  landscape: boolean;
}) {
  // No theme, or a theme with no backdrop: draw nothing. The pad keeps its
  // normal bg. (This component is only mounted when backdrop != null, but the
  // guard keeps it honest and cheap.)
  if (!backdrop) return null;

  const assets = backdropAssets(backdrop.key);

  // ART path.
  //
  // A bare <Image> at absoluteFill + cover, NOT <ImageBackground>. ImageBackground
  // sizes its inner image from an onLayout MEASUREMENT of its container, then
  // stamps that as a numeric width/height. On native (iOS), the immersive/rotation
  // transition measured the container once at a non-final size and never
  // re-measured, so the art filled only a top band with BASE showing below —
  // invisible in the web harness, where ImageBackground is a CSS `cover` div that
  // always fills. A bare Image at absoluteFill covers the parent directly at
  // layout time with no measurement step. The Scrim is a following sibling, so it
  // still sits on top. (Same pattern the launch-tile art uses, device-proven.)
  if (assets) {
    const source = landscape ? assets.landscape : assets.portrait;
    return (
      <View style={[StyleSheet.absoluteFill, { backgroundColor: BASE }]} pointerEvents="none">
        <Image
          source={source as ImageSourcePropType}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
        />
        <Scrim />
      </View>
    );
  }

  // DERIVED path: dark base + a soft top glow in the theme colour. The glow is
  // a wide, low-opacity block in the top third — deliberately far from where the
  // controls sit — plus the same scrim, so it reads as "styled" without ever
  // competing with the buttons.
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: BASE }]} pointerEvents="none">
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: '38%',
          backgroundColor: backdrop.glow,
          opacity: 0.14,
        }}
      />
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: '18%',
          backgroundColor: backdrop.glow,
          opacity: 0.1,
        }}
      />
      <Scrim />
    </View>
  );
}

const styles = StyleSheet.create({
  band: { width: '100%' },
});
