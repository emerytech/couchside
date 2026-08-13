/**
 * Group individually-addressable kernel LEDs into a STRIP.
 *
 * A Steam Machine / Deck exposes its front strip as N separate /sys/class/leds
 * nodes — `valve-leds[0]` … `valve-leds[16]` — so the LIGHT card renders one chip
 * per node (owner: "clunky"). This collapses any `prefix[N]` family into a single
 * strip so the app can paint across it and sweep a real night-rider — driven from
 * the app via /api/leds/set (works on ANY agent that has the LED control, no
 * effect-engine dependency on the box).
 */
import type { LedInfo } from './api';

export type LedStrip = {
  /** Stable id, e.g. "strip:valve-leds". */
  key: string;
  /** Human label, e.g. "valve-leds (17)". */
  label: string;
  /** The member LEDs, sorted by their [index]. */
  leds: LedInfo[];
  /** True if any member has colour channels. */
  rgb: boolean;
};

const STRIP_RE = /^(.*?)\[(\d+)\]$/;
/** Fewer than this many members isn't worth a strip UI — keep them as singles. */
const MIN_STRIP = 3;

const stripIndex = (name: string): number => {
  const m = name.match(STRIP_RE);
  return m ? parseInt(m[2], 10) : 0;
};

/** Split a flat LED list into detected strips + leftover single LEDs. */
export function detectStrips(leds: LedInfo[]): { strips: LedStrip[]; singles: LedInfo[] } {
  const groups = new Map<string, LedInfo[]>();
  const singles: LedInfo[] = [];
  for (const l of leds) {
    const m = l.name.match(STRIP_RE);
    if (m) {
      const prefix = m[1];
      (groups.get(prefix) ?? groups.set(prefix, []).get(prefix)!).push(l);
    } else {
      singles.push(l);
    }
  }
  const strips: LedStrip[] = [];
  for (const [prefix, arr] of groups) {
    if (arr.length >= MIN_STRIP) {
      arr.sort((a, b) => stripIndex(a.name) - stripIndex(b.name));
      strips.push({
        key: `strip:${prefix}`,
        label: `${prefix.replace(/[:_-]+$/, '')} (${arr.length})`,
        leds: arr,
        rgb: arr.some((l) => l.rgb),
      });
    } else {
      singles.push(...arr);
    }
  }
  strips.sort((a, b) => a.key.localeCompare(b.key));
  return { strips, singles };
}
