/**
 * When does the pad's touch surface CHANGE UNDER THE FINGERS?
 *
 * Pure, so the safety-critical answer is testable without a renderer.
 *
 * Every immersive pad surface (both movement tables, the landscape
 * controller) is built from PanResponders and Pressables whose releases live
 * in their own callbacks. React fires NEITHER on unmount — no
 * onPanResponderTerminate, no onPressOut — so any transition that swaps or
 * removes those components while a finger is down leaves the agent holding
 * the last frame: a stick axis pinned, a button latched, the character
 * walking with nobody touching the screen. The socket stays healthy and the
 * agent zeroes a pad only on demote/teardown, so nothing self-heals.
 *
 * The screen therefore calls `client.releaseAll()` whenever this signature
 * changes. Each field is here because a real transition changes ONLY that one:
 *
 *  - `mounted`  the pad is on screen at all (immersive AND focused AND the
 *               layout fits). Covers EXIT, blur, and a window shrinking below
 *               the floors while still landscape (found in review).
 *  - `mode`     PAD <-> MOVE <-> SWIPE: different components entirely.
 *  - `landscape` inside MOVE, rotation swaps the vertical table for the
 *               spread one — every surface remounts while `mounted` and
 *               `mode` both stay put.
 */
export type PadSurface = { mounted: boolean; mode: string; landscape: boolean };

export function surfaceChanged(prev: PadSurface, next: PadSurface): boolean {
  return prev.mounted !== next.mounted
    || prev.mode !== next.mode
    || prev.landscape !== next.landscape;
}
