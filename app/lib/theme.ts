import { Platform, TextStyle } from 'react-native';

/** Dark ops-console palette. Legible at 2am. */
export const theme = {
  bg: '#0b1220',
  card: '#141c2e',
  cardBorder: '#1e2942',
  inset: '#0e1526',
  text: '#e5ecf8',
  textDim: '#8b97ad',
  textFaint: '#5b6780',
  green: '#34d399',
  amber: '#fbbf24',
  red: '#f87171',
  redDeep: '#7f1d1d',
  blue: '#60a5fa',
  slate: '#64748b',
  tabBar: '#0e1526',
  tabBarBorder: '#1e2942',
} as const;

export const mono = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
});

/** Style fragment for numeric readouts: monospaced digits that don't jitter. */
export const numeric: TextStyle = {
  fontFamily: mono,
  fontVariant: ['tabular-nums'],
};

export function tempColor(c: number | null): string {
  if (c == null) return theme.textFaint;
  if (c < 70) return theme.green;
  if (c < 85) return theme.amber;
  return theme.red;
}

export function pctColor(pct: number): string {
  if (pct < 70) return theme.green;
  if (pct < 90) return theme.amber;
  return theme.red;
}
