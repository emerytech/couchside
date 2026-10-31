/** Portrait controls share the usable row width, never a fixed device size. */
export function portraitPadMetrics(contentWidth: number) {
  const width = Math.max(0, contentWidth);
  // Two three-button clusters, four internal gaps and an eight-point gutter.
  const button = Math.max(44, Math.min(58, Math.floor((width - 24) / 6)));
  // Each stick group also contains a 44-point click button and an 8-point gap.
  const stick = Math.max(88, Math.min(132, Math.floor((width - 8) / 2 - 52)));
  return { button, stick, clusterHeight: button * 3 + 8 };
}
