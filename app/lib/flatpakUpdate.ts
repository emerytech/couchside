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

/** The launch response, mirroring api.FlatpakStartResult (kept import-free). */
export type FlatpakStart = {
  started: boolean;
  elevated?: boolean;
  error?: string;
  exit_code?: number;
  lines?: string[];
};

/**
 * What to TELL the user after a press, or null when nothing needs saying.
 *
 * THE BUG THIS FIXES: the card set the row to 'skipped' with no message on every
 * `started:false` and on every thrown error, and 'skipped' renders no icon — so
 * a `sudo` denial, a missing wrapper, or a process that died in 400ms all looked
 * identical to not having pressed anything. A user reported exactly that:
 * "mostly works, but the last 2 times nothing happens when I press it". The
 * agent had been returning the reason the whole time; the card threw it away.
 *
 * Precedence for a failed start: the agent's own `error` (could not spawn), then
 * the last transcript line (what flatpak itself said), then the exit code.
 *
 * A start that succeeded but ran UN-elevated while system updates are pending is
 * the other silent case: `flatpak update --user` on a box whose apps are all
 * system-installed finishes in under a second having done nothing, the row shows
 * a checkmark, and the count never moves. Say so, and say what enables the rest.
 */
/**
 * flatpak writes its transcript for a TERMINAL: cursor-show/hide, line-clear
 * and colour escapes ride along in the log lines (MEASURED on a Bazzite box:
 * the last line of a real run was "\x1b[?25h"). Strip them, or the message
 * the user reads ends in garbage — or is NOTHING but garbage.
 */
const TERMINAL_CONTROL = /\x1b\[[0-9;?]*[A-Za-z]|[\x00-\x08\x0b-\x1f\x7f]/g;

export function flatpakStartMessage(r: FlatpakStart, pendingCount: number): string | null {
  if (!r.started) {
    if (r.error) return `Update did not start: ${r.error}`;
    const last = [...(r.lines ?? [])]
      .map((l) => l.replace(TERMINAL_CONTROL, '').trim())
      .reverse()
      .find((l) => l.length > 0);
    if (last) return `Update did not start: ${last}`;
    if (typeof r.exit_code === 'number') return `Update did not start (exit ${r.exit_code}).`;
    return 'Update did not start.';
  }
  if (r.elevated === false && pendingCount > 0) {
    return 'Only your user-installed apps were updated. Enable system updates on the box to update the rest.';
  }
  return null;
}
