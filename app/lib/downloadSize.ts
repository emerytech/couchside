/**
 * Size formatting for the Steam downloads card.
 *
 * EXTRACTED FROM app/(tabs)/launch.tsx so it can be tested. The bug these guard
 * (KI-056) shipped and was reported TWICE by the same tester, and the fix went
 * out with no test at all because the code lived in a screen file that the
 * install-free test glob does not reach.
 *
 * THE BUG: fmtGB is toFixed(1), so anything under ~50 MB renders "0.0". A small
 * content patch passed the bytes_total > 0 gate and printed "0.0 / 0.0 GB" — a
 * download Steam was reporting honestly looked broken. The agent was truthful
 * throughout; only the display lied, which is why the fix belongs here and why
 * no total is ever invented.
 */

/** GB with one decimal (Steam's own display convention). */
export function fmtGB(bytes: number): string {
  return (bytes / 1e9).toFixed(1);
}

/**
 * Unit floor for switching a row from GB to MB. Anything under this renders as
 * whole MB, so a small patch reads as "28 / 31 MB" instead of "0.0 / 0.0 GB".
 */
export const MB_FLOOR = 100e6;

/** "1.2 / 42.0 GB" above the floor, "28 / 31 MB" under it. One unit per row,
 *  chosen by the TOTAL, so the pair never mixes units mid-line. */
export function fmtPair(downloaded: number, total: number): string {
  if (total < MB_FLOOR) {
    return `${Math.round(downloaded / 1e6)} / ${Math.round(total / 1e6)} MB`;
  }
  return `${fmtGB(downloaded)} / ${fmtGB(total)} GB`;
}

/** Single-size variant for queued rows. */
export function fmtTotal(total: number): string {
  return total < MB_FLOOR ? `${Math.round(total / 1e6)} MB` : `${fmtGB(total)} GB`;
}
