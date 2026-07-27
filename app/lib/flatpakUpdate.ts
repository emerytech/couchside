/**
 * When is a box's flatpak update actually FINISHED? Zero runtime imports, so it
 * is unit-testable on bare Node like lib/lanIp.ts and lib/swipeSteps.ts.
 *
 * THE BUG THIS FIXES (KI-036, device-confirmed 2026-07-27). The card used to
 * treat "done" as `count === 0`, where count is `flatpak remote-ls --updates`.
 * That list counts runtimes `flatpak update` will NOT apply: an end-of-life
 * runtime (measured: org.freedesktop.Platform 23.08) reports as "update
 * available" while the update says "Nothing to do" and cannot cross the EOL
 * major boundary. So the count is pinned above zero, `count === 0` is
 * UNREACHABLE, and the drain ran its full ten minutes — marking a successful
 * update "skipped" and, on an "update everything" press, blocking the OS update
 * behind that dead wait.
 *
 * The honest signal is whether the box's update PROCESS is still running, which
 * the agent reports as `running` (>= 2.9.59). Completion is `running === false`.
 * A remaining count then just means some app can't be updated (EOL) — true, and
 * not a failure. Older agents don't send `running`; there we fall back to the
 * historical `count === 0`, i.e. the old behaviour, so nothing regresses.
 */

export type FlatpakProgress = {
  /** Pending count from the box's remote-ls (includes un-updatable EOL apps). */
  count: number;
  /** Is the box's update process still executing? Absent on agents < 2.9.59. */
  running?: boolean;
};

/**
 * True once the update has finished and the poller may stop.
 *
 * - `null` (status not yet readable) → false: keep waiting.
 * - `running` present (new agent) → finished exactly when it is false, whatever
 *   the count. This is the fix: a nonzero count no longer blocks completion.
 * - `running` absent (old agent) → fall back to `count === 0`, unchanged.
 */
export function isFlatpakUpdateComplete(status: FlatpakProgress | null | undefined): boolean {
  if (status == null) return false;
  if (typeof status.running === 'boolean') return status.running === false;
  return status.count === 0;
}
