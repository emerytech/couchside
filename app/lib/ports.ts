/**
 * Couchside-Ports — phone-side logic and copy that needs NO runtime import, so
 * it is unit-testable on bare Node like lib/deckyPlugins.ts:
 *
 *   node --experimental-strip-types --test lib/__tests__/ports.test.ts
 *
 * Only `import type` below — erased at strip time, so the module never loads
 * api.ts. The AGENT owns the catalogue (its install allowlist); nothing here
 * ever builds a URL or a command. The legal line lives here too: engines are
 * redistributable, game dumps are ALWAYS the player's own — a port that needs
 * them says so and the UI surfaces that step from this one place.
 */
import type { Port, PortActionResult, PortInstallJob } from './api';

export type Tone = 'good' | 'action' | 'idle' | 'warn';

export const PORTS_OPTIN_CMD = 'couchside allow-ports on';
export const PORTS_OPTIN_HINT =
  `Port installs are off on this box. Enable them on the box with: ${PORTS_OPTIN_CMD}`;
export const PORTS_LEGAL_LINE =
  'Ports ship the engine only. You supply your own legally-obtained game files — nothing copies a game for you.';

/** True when a port can run on this box's platform. An unknown/absent platform
 *  reads as "show it" (never hide a port just because the box did not say). */
export function portMatchesPlatform(
  port: Pick<Port, 'platforms'>,
  platform: string | null | undefined,
): boolean {
  if (!platform) return true;
  if (!port.platforms || port.platforms.length === 0) return true;
  return port.platforms.includes(platform);
}

/** Is a job for THIS port in flight right now? */
export function portJobActive(
  job: PortInstallJob | null | undefined,
  portId: string,
): boolean {
  return !!job && job.id === portId && job.running;
}

/** Any port job running (install or uninstall), regardless of which port. */
export function anyPortJobActive(job: PortInstallJob | null | undefined): boolean {
  return !!job && job.running;
}

/**
 * The button on a port row. While a job for it runs -> the busy verb (disabled).
 * Installed -> Play lives in Steam, so the row offers Remove. Not installed ->
 * Install. Opt-in is handled separately (a hint, not a disabled button) so the
 * owner learns the one command instead of staring at a dead control.
 */
export function portButton(
  port: Pick<Port, 'id' | 'installed'>,
  job: PortInstallJob | null | undefined,
): { label: string; action: 'install' | 'uninstall' | null; busy: boolean } {
  if (portJobActive(job, port.id)) {
    const verb = job && job.mode === 'uninstall' ? 'Removing…' : 'Installing…';
    return { label: verb, action: null, busy: true };
  }
  if (port.installed) return { label: 'Remove', action: 'uninstall', busy: false };
  return { label: 'Install', action: 'install', busy: false };
}

/**
 * The progress/status line for the current job, or null when there is none.
 * `running` is the truth while in flight (a client timeout is never a failure);
 * once finished, ok decides. A finished install that still needs the player's
 * own dump says so — that is the bring-your-own step the owner acts on next.
 */
export function portJobCopy(
  job: PortInstallJob | null | undefined,
  portName?: string,
): { line: string; tone: Tone; needsDump: boolean } | null {
  if (!job) return null;
  const who = portName || job.id;
  const verb = job.mode === 'uninstall' ? 'Removing' : 'Installing';
  if (job.running) {
    return { line: `${verb} ${who} on the box…`, tone: 'action', needsDump: false };
  }
  if (job.ok) {
    if (job.mode === 'uninstall') {
      return { line: `${who} removed.`, tone: 'good', needsDump: false };
    }
    if (job.requires_user_files) {
      const how = job.user_files_prompt ? ` ${job.user_files_prompt}` : '';
      return {
        line: `Installed ${who}. One more step on the box:${how}`,
        tone: 'good',
        needsDump: true,
      };
    }
    return { line: `Installed ${who}.`, tone: 'good', needsDump: false };
  }
  // Finished, not ok.
  const code = typeof job.exit_code === 'number' ? ` (exit ${job.exit_code})` : '';
  return {
    line: `${verb} ${who} failed${code}. See the log below.`,
    tone: 'warn',
    needsDump: false,
  };
}

/**
 * Why a POST came back without starting, as a line to show — or null when it
 * DID start. needs_optin is the common one (the box is not opted in), and it
 * leads with the exact command so the owner can act.
 */
export function portActionError(r: PortActionResult | null | undefined): string | null {
  if (!r || r.started) return null;
  if (r.needs_optin) return PORTS_OPTIN_HINT;
  if (r.running) return 'A port install is already running on the box. Wait for it to finish.';
  if (r.error) {
    const code = typeof r.exit_code === 'number' ? ` (exit ${r.exit_code})` : '';
    return `${r.error}${code}`;
  }
  return 'Could not start.';
}

/** The confirm-sheet copy for installing a port: what runs, where the engine
 *  comes from, and the bring-your-own-dump reminder for ports that need it. */
export function installConfirmCopy(port: Pick<Port, 'name' | 'requires_user_files' | 'user_files_prompt'>): {
  title: string;
  message: string;
  okLabel: string;
} {
  const lines: string[] = [
    `Install ${port.name} on your Steam Machine?`,
    'The box downloads the port engine from its pinned GitHub release over TLS and installs it as your desktop user (no root).',
    PORTS_LEGAL_LINE,
  ];
  if (port.requires_user_files && port.user_files_prompt) {
    lines.push(`After it installs: ${port.user_files_prompt}`);
  }
  return { title: `Install ${port.name}`, message: lines.join('\n\n'), okLabel: 'Install' };
}

/** Confirm copy for removing a port. */
export function uninstallConfirmCopy(port: Pick<Port, 'name'>): {
  title: string;
  message: string;
  okLabel: string;
} {
  return {
    title: `Remove ${port.name}`,
    message: `Remove ${port.name} from your Steam Machine? Any game files you supplied yourself are left where they are.`,
    okLabel: 'Remove',
  };
}
