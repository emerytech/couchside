/** Templates are editable frame data; they never start hardware playback. */
type Color = { r: number; g: number; b: number };
export type SequenceTemplate = 'double-flash' | 'fade' | 'flicker';
export function makeSequenceTemplate(kind: SequenceTemplate, count: number, color: Color) {
  const levels = kind === 'double-flash' ? [1, 0, 1, 0]
    : kind === 'fade' ? [0, .1, .2, .4, .65, .85, 1, .85, .65, .4, .2, .1]
    : [.25, .8, .45, 1, .15, .6, .35, .9, .2, .5];
  const holds = kind === 'double-flash' ? [100, 120, 100, 1500]
    : kind === 'fade' ? levels.map(() => 150)
    : [180, 80, 250, 60, 300, 90, 140, 70, 400, 200];
  return { frames: levels.map((level) => Array.from({ length: count }, () => level === 0 ? null : ({
    r: Math.round(color.r * level), g: Math.round(color.g * level), b: Math.round(color.b * level),
  }))), holds };
}
