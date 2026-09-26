/**
 * "Box installation is damaged" — the decision and the words, for the Console
 * banner (components/InstallHealthBanner.tsx).
 *
 * WHY. A SteamOS image update took /etc/couchside (token + journal wrapper), the
 * udev rules and the uinput modules-load file off a real Steam Deck while the
 * agent kept running, and nothing said so for a month: the gamepad, scheduled
 * wake and system journal just quietly degraded. The agent (>= 2.9.115) now
 * reports `install_health` on /api/status: `{ok, missing: [ids], unknown: [ids]}`.
 *
 * RULES (tests: lib/__tests__/installHealth.test.ts):
 *  - The field is OPTIONAL. An older agent omits it, and absence means "the box
 *    did not say" — show nothing, never a guess.
 *  - Show only on `ok === false` WITH a non-empty `missing`. `ok` is false for a
 *    piece the agent could not CHECK (unknown) too — that is the agent degrading
 *    closed, not evidence of damage, so an unknown alone never raises the banner.
 *  - Ids come from the agent's frozen table; a NEWER agent may send an id this app
 *    has never heard of. It still counts (the box said it is missing) and renders
 *    as its raw id rather than being dropped.
 *  - The fix is always "re-run the installer FROM A TERMINAL on the box": the
 *    phone-triggered update runs without a password and cannot write /etc.
 *
 * Runtime-import-free (the onboarding constant below is a plain string module),
 * so the bare-Node test glob can load it.
 */
import { INSTALL_COMMAND } from './onboarding.ts';

/** GET /api/status → install_health (agent >= 2.9.115). */
export type InstallHealth = {
  /** True only when every expected piece was checked AND present. */
  ok: boolean;
  /** Piece ids that are gone (frozen agent table; unknown ids render raw). */
  missing: string[];
  /** Piece ids the agent could not check (e.g. sudo would not list rules). */
  unknown?: string[];
};

/** The one-line repair, identical to the first-install command. */
export const REPAIR_COMMAND = INSTALL_COMMAND;

/** Short human names for the agent's piece ids. Kept to a few words each: the
 *  banner lists several on one phone-width line. */
export const PIECE_LABELS: Readonly<Record<string, string>> = {
  token_canonical: 'pairing token file',
  sudoers_grant: 'sudo permissions',
  journal_wrapper: 'log reader',
  udev_uinput: 'gamepad access rule',
  modules_uinput: 'gamepad driver autoload',
  udev_rtc: 'wake-timer access rule',
  udev_cec: 'HDMI-CEC access rule',
  udev_openpuck: 'OpenPuck USB rule',
  systemd_unit: 'service unit',
};

export function pieceLabel(id: string): string {
  return Object.prototype.hasOwnProperty.call(PIECE_LABELS, id) ? PIECE_LABELS[id] : id;
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
}

/**
 * The ids to report as missing, or null when there is nothing to say: field
 * absent (older agent), malformed, ok, or false-with-only-unknowns. Accepts
 * `unknown` input on purpose — this is wire data from whatever agent version the
 * box runs, and a bad shape must hide the banner, never throw.
 */
export function damagedPieces(health: unknown): string[] | null {
  if (health == null || typeof health !== 'object') return null;
  const h = health as { ok?: unknown; missing?: unknown };
  if (h.ok !== false) return null;
  const missing = stringList(h.missing);
  return missing.length > 0 ? missing : null;
}

/** Ids the agent could not check, for a quieter secondary line. */
export function uncheckedPieces(health: unknown): string[] {
  if (health == null || typeof health !== 'object') return [];
  return stringList((health as { unknown?: unknown }).unknown);
}

/** "Box installation is damaged (missing: a, b, c) — re-run the installer on the box" */
export function damagedHeadline(missing: string[]): string {
  return `Box installation is damaged (missing: ${missing.map(pieceLabel).join(', ')}) — re-run the installer on the box`;
}

/** Why a phone-side update is not the fix, in one sentence. */
export const REPAIR_HINT =
  'Run this in a terminal on the box (Desktop Mode on a Steam Deck). An update from the phone cannot restore these — it has no password to write system files.';
