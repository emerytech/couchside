/**
 * The skin kit: the seam that lets the Console and Fleet tabs be restyled
 * wholesale without either screen knowing which look is active.
 *
 * WHY A SEAM AND NOT JUST EDITING THE SCREENS: the owner wants to compare
 * several distinct cyberpunk directions side by side before committing. Each
 * direction is an independent module implementing this one interface, so they
 * can be built and swapped without touching index.tsx / fleet.tsx again -- and
 * so the CLASSIC skin can stay in the build as a pixel-identical control. If
 * classic ever drifts, the refactor broke something and every comparison
 * against it is worthless.
 *
 * SEMANTIC COLOUR IS NOT THE SKIN'S TO CHOOSE. Callers pass the already-
 * resolved colour from tempColor()/pctColor()/batteryColor(). A skin may
 * decorate with it (glow, pulse, border) but must never substitute its own --
 * green/amber/red carry meaning, and battery is inverted.
 */
import React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

// ---------------------------------------------------------------------------
// Component contracts
// ---------------------------------------------------------------------------

export type CardProps = {
  /** Small caps heading. Omitted for cards that draw their own header. */
  title?: string;
  /**
   * Ordinal within the screen, for staggered mount. Cards probe-and-appear at
   * arbitrary times, so this is a hint for delay, never an array index that
   * must stay stable.
   */
  index?: number;
  /**
   * Semantic emphasis. 'alert' is the unreachable banner; 'live' is a card
   * reporting something actively happening (a stream being served); 'down' is
   * a Fleet tile for a box that is not answering.
   */
  tone?: 'default' | 'live' | 'alert' | 'down';
  /** Border/emphasis colour override, already semantically resolved. */
  accentColor?: string;
  /** Present on Fleet tiles: the card is a button that switches box. */
  onPress?: () => void;
  /** The active box's tile. Drives the selected border treatment. */
  selected?: boolean;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
};

export type MetricProps = {
  /** Pre-formatted display string ("58.7°C", "1d 2h 7m"). */
  value: string;
  /** Already-resolved semantic colour. */
  color: string;
  /**
   * Numeric value behind `value`, when there is one, so skins can animate
   * changes (count-up, flicker on delta). Null for non-numeric readouts.
   */
  numeric?: number | null;
};

export type BarProps = {
  /** 0..100. */
  pct: number;
  /** Already-resolved semantic colour. */
  color: string;
  height?: number;
};

export type SparkProps = {
  values: (number | null)[] | undefined;
  color: string;
  height?: number;
  min?: number;
  max?: number;
};

export type DotProps = {
  color: string;
  size?: number;
  /**
   * Whether this dot represents something currently alive. Skins use it to
   * decide whether to animate; a DOWN box should not have a healthy pulse.
   */
  live?: boolean;
};

/**
 * One complete visual direction. Every screen-level chrome decision lives
 * here; index.tsx / fleet.tsx only compose these.
 */
export type SkinKit = {
  /** Human label, for the dev skin switcher. */
  label: string;
  /**
   * Wraps a screen's scrolling content. Lets a skin paint a full-bleed
   * background layer (grid, scanlines, reactor sheen) behind everything.
   */
  Screen: React.ComponentType<{ children: React.ReactNode }>;
  Card: React.ComponentType<CardProps>;
  /** Small caps label used for card titles and section headings. */
  SectionTitle: React.ComponentType<{ children: React.ReactNode }>;
  BigMetric: React.ComponentType<MetricProps>;
  Bar: React.ComponentType<BarProps>;
  Spark: React.ComponentType<SparkProps>;
  Dot: React.ComponentType<DotProps>;
};

// ---------------------------------------------------------------------------
// Vitals: the machine's exertion, shared down the tree
// ---------------------------------------------------------------------------

export type Vitals = {
  /** 0..1 exertion. Drives motion RATE and intensity only, never colour. */
  v: number;
  /** True when the box is answering. A dead box must not look alive. */
  alive: boolean;
};

export const VitalsContext = React.createContext<Vitals>({ v: 0, alive: false });

export function useVitals(): Vitals {
  return React.useContext(VitalsContext);
}
