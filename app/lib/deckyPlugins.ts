/**
 * Decky manager — the phone-side logic and copy that needs NO runtime import,
 * so it is unit-testable on bare Node like lib/flatpakUpdate.ts:
 *
 *   node --experimental-strip-types --test lib/__tests__/deckyPlugins.test.ts
 *
 * Spec: docs/memory/project_decky-manager.md (§8 update detection, §9 phone-side
 * search/sort, §10 install_type presentation, §12 copy). Only `import type`
 * below — erased at strip time, so the module never loads api.ts.
 *
 * WHY the version compare is STRICT (`^\d+(\.\d+){0,3}$`, else "unknown"): the
 * agent's older `_ver_tuple` strips non-digits, which turns `2.0.17-f57f127`
 * into (2, 0, 1757127) and advertises phantom updates Decky's own UI never
 * shows. Decky's frontend only flags an update when BOTH sides validate as
 * semver and remote > local (checkForPluginUpdates, verified at v3.2.8); an
 * unparsable side here yields null, which the UI renders as "no update known"
 * — never as "update available" and never as "up to date".
 *
 * WHY search/sort live here: the box serves its whole (already capped,
 * normalised) catalogue and the phone filters it, so no free text reaches the
 * agent — the store's `?query=` is deliberately not proxied (spec §3 last row).
 */
import type {
  DeckyInstallType, DeckyJob, DeckyLoader, DeckyLoaderOp, DeckyPlugin, DeckyStoreEntry,
} from './api';

// ---------- strict semver ----------

export type SemverTuple = [number, number, number, number];

const SEMVER_RE = /^\d+(\.\d+){0,3}$/;

/** `"1.7.1"` → [1,7,1,0]; anything else (`-pre`, hash suffix, `v` prefix,
 *  empty, null) → null. Padded to four so "1.7" and "1.7.0" compare equal. */
export function semverTuple(v: string | null | undefined): SemverTuple | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!SEMVER_RE.test(s)) return null;
  const parts = s.split('.').map((p) => Number(p));
  while (parts.length < 4) parts.push(0);
  return [parts[0], parts[1], parts[2], parts[3]];
}

/** -1 | 0 | 1 when both parse; null when either side is not strict semver. */
export function compareSemver(a: string | null | undefined, b: string | null | undefined): -1 | 0 | 1 | null {
  const ta = semverTuple(a);
  const tb = semverTuple(b);
  if (!ta || !tb) return null;
  for (let i = 0; i < 4; i++) {
    if (ta[i] < tb[i]) return -1;
    if (ta[i] > tb[i]) return 1;
  }
  return 0;
}

// ---------- update detection (mirrors Decky's frontend rule, agent §8) ----------

/**
 * The update the store offers for one installed plugin, or null. Frozen plugins
 * never update (Decky's own rule); `versions[0]` is always the candidate. Only a
 * STRICTLY newer strict-semver remote counts.
 */
export function pluginUpdate(
  installed: { version: string | null; frozen: boolean | null },
  remoteVersions: { name: string; hash: string }[] | undefined,
): { version: string; hash: string } | null {
  if (installed.frozen) return null;
  const top = remoteVersions && remoteVersions[0];
  if (!top) return null;
  if (compareSemver(top.name, installed.version) === 1) return { version: top.name, hash: top.hash };
  return null;
}

/** name → update for every installed plugin the store knows a newer version of. */
export function updateSet(
  plugins: Pick<DeckyPlugin, 'name' | 'version' | 'frozen'>[],
  store: Pick<DeckyStoreEntry, 'name' | 'versions'>[],
): Map<string, { version: string; hash: string }> {
  const byName = new Map<string, Pick<DeckyStoreEntry, 'name' | 'versions'>>();
  for (const e of store) byName.set(e.name, e);
  const out = new Map<string, { version: string; hash: string }>();
  for (const p of plugins) {
    const e = byName.get(p.name);
    const u = e ? pluginUpdate(p, e.versions) : null;
    if (u) out.set(p.name, u);
  }
  return out;
}

// ---------- install_type presentation (§10 / §12) ----------

/**
 * Decky's INSTALL / UPDATE / REINSTALL / DOWNGRADE, decided the way the agent
 * decides it so the button never promises one thing and the box does another:
 * nothing installed → install; installed but unparsable → reinstall (presented
 * as such, never silently "update"); remote newer → update; equal → reinstall;
 * remote older (the box is ahead of the store) → downgrade, shown honestly.
 */
export function installType(
  installedVersion: string | null | undefined,
  remoteVersion: string,
): DeckyInstallType {
  if (installedVersion == null) return 'install';
  const c = compareSemver(remoteVersion, installedVersion);
  if (c === null) return 'reinstall';
  if (c === 1) return 'update';
  if (c === 0) return 'reinstall';
  return 'downgrade';
}

/** Button label: Install / Update to x / Reinstall x / Downgrade to x. */
export function installLabel(type: DeckyInstallType | null | undefined, version: string): string {
  switch (type) {
    case 'update': return `Update to ${version}`;
    case 'reinstall': return `Reinstall ${version}`;
    case 'downgrade': return `Downgrade to ${version}`;
    default: return 'Install';
  }
}

/** Downgrade and Reinstall must name BOTH versions in their confirm (spec §12). */
export function installNamesBothVersions(type: DeckyInstallType | null | undefined): boolean {
  return type === 'reinstall' || type === 'downgrade';
}

export type InstallConfirmInput = {
  name: string;
  author: string;
  type: DeckyInstallType | null | undefined;
  installedVersion: string | null | undefined;
  remoteVersion: string;
  /** Known root flag (installed copy's plugin.json, or a future agent field). */
  root?: boolean;
  /** Steam's Decky menu is live on the TV right now (op replies carry it). */
  steamUiUp?: boolean;
};

export const DECKY_ROOT_PLUGIN_LINE = 'This plugin runs as root on your box.';
export const DECKY_BLINK_LINE =
  "Decky's menu will blink and any open Decky prompt is cancelled.";

/** The confirm sheet for a store install: author + version always; both versions
 *  for reinstall/downgrade; the root sentence when flagged; the blink warning
 *  when Steam's UI is up (KI-068 hand-off honesty). */
export function installConfirmCopy(i: InstallConfirmInput): { title: string; message: string; okLabel: string } {
  const label = installLabel(i.type, i.remoteVersion);
  const lines: string[] = [];
  if (i.type === 'downgrade') {
    lines.push(`Downgrade ${i.name} from ${i.installedVersion ?? '?'} to ${i.remoteVersion}? The store's newest version is OLDER than what is on your box.`);
  } else if (i.type === 'reinstall') {
    lines.push(`Reinstall ${i.name} ${i.remoteVersion} over the installed ${i.installedVersion ?? 'copy'}? Decky removes the current copy first.`);
  } else if (i.type === 'update') {
    lines.push(`Update ${i.name} ${i.installedVersion ?? ''} → ${i.remoteVersion}?`.replace('  ', ' '));
  } else {
    lines.push(`Install ${i.name} ${i.remoteVersion}?`);
  }
  lines.push(`By ${i.author || 'unknown'}. Decky Loader downloads it and checks its SHA-256 before installing.`);
  if (i.root) lines.push(DECKY_ROOT_PLUGIN_LINE);
  else lines.push('Plugins run as your user — or as root if the plugin is flagged for it.');
  if (i.steamUiUp) lines.push(DECKY_BLINK_LINE);
  return { title: label, message: lines.join('\n\n'), okLabel: label.split(' ')[0] };
}

// ---------- phone-side search + sort (§9) ----------

export type StoreSort = 'downloads' | 'name' | 'updated';

/** Case-insensitive substring over name / author / tags / description. Empty
 *  query → everything (a copy, never the same array). */
export function searchStore<T extends Pick<DeckyStoreEntry, 'name' | 'author' | 'tags' | 'description'>>(
  entries: T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries.slice();
  return entries.filter((e) =>
    e.name.toLowerCase().includes(q)
    || (e.author || '').toLowerCase().includes(q)
    || (e.tags || []).some((t) => t.toLowerCase().includes(q))
    || (e.description || '').toLowerCase().includes(q));
}

/** Stable sort by downloads (desc), name (A–Z), or updated (newest first — ISO
 *  strings compare lexically). Ties fall back to name so the order is deterministic. */
export function sortStore<T extends Pick<DeckyStoreEntry, 'name' | 'downloads' | 'updated'>>(
  entries: T[],
  sort: StoreSort,
): T[] {
  const byName = (a: T, b: T) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  const out = entries.slice();
  if (sort === 'name') return out.sort(byName);
  if (sort === 'updated') {
    return out.sort((a, b) => (b.updated || '').localeCompare(a.updated || '') || byName(a, b));
  }
  return out.sort((a, b) => (b.downloads || 0) - (a.downloads || 0) || byName(a, b));
}

// ---------- copy (§5, §11, §12) — one place, three surfaces ----------

/** The material fact, verbatim from the spec; leads the opt-in, the Install
 *  alert and the README. */
export const DECKY_ROOT_FROM_HOME =
  'Decky Loader runs as root from your home directory. On a Decky box, anyone who can act as '
  + 'your desktop user — including a paired phone, through the gamepad — can become root. '
  + "That is Decky's design, not something Couchside can wall off.";

/** The Install alert body: the fact first, then what the box will do. */
export const DECKY_INSTALL_ALERT =
  DECKY_ROOT_FROM_HOME
  + '\n\nThe box downloads the latest stable PluginLoader from GitHub over TLS — Decky publishes '
  + 'no checksum for it — and installs it as a root service. Steam must restart afterwards to '
  + 'show the Decky menu.';

/** KI-037: there is no per-plugin restart in the loader's service; a loader
 *  restart restarts every plugin. Said every time the action is offered. */
export const DECKY_RESTART_ALL_PLUGINS = 'This restarts all plugins.';

export const DECKY_OPTIN_CMD = 'couchside allow-decky on';
export const DECKY_HELPER_OUTDATED =
  "The box's privileged helper predates this feature; re-run install.sh once the release "
  + 'assets are published and check it prints “Installing privileged helper”.';
export const DECKY_NEEDS_INSTALLER = 'Re-run the installer on the box to add the Decky installer.';
export const DECKY_TV_ASKING = 'Decky may be asking on the TV.';
export const DECKY_UNIT_DRIFTED = "Decky's updater replaced the service file — Repair re-pins it.";
export const DECKY_PANEL_MISSING = 'Re-run the Couchside installer to add the Couchside panel.';
export const DECKY_STEAM_RESTART = 'Installed. Restart Steam or reboot to see the Decky menu.';
export const DECKY_REPAIR_STABLE = 'Repair installs the latest stable loader.';
export const DECKY_UNINSTALL_KEEPS = 'Your plugins and settings are kept.';

export type Tone = 'good' | 'action' | 'idle' | 'warn';
/** What the primary control on a surface should do for this state. */
export type LoaderAction = 'install' | 'start' | 'repair' | 'manage' | null;

export type LoaderPresentation = { line: string; icon: string; tone: Tone; action: LoaderAction; chip: string };

/**
 * One state → (status line, icon, tone, primary action, chip) mapping shared by
 * the Utilities row, the Setup card and the /decky screen so the three never
 * disagree. Unknown states render their raw name (open union, never a crash).
 */
export function describeLoaderState(
  l: Pick<DeckyLoader, 'state'> & Partial<Pick<DeckyLoader, 'stopped_reason' | 'version'>>,
): LoaderPresentation {
  switch (l.state) {
    case 'not_installed':
      return { line: 'Not installed.', icon: 'cube-outline', tone: 'idle', action: 'install', chip: 'Not installed' };
    case 'installing':
      return { line: 'Installing Decky Loader…', icon: 'sync', tone: 'action', action: null, chip: 'Installing' };
    case 'uninstalling':
      return { line: 'Removing Decky Loader…', icon: 'sync', tone: 'action', action: null, chip: 'Removing' };
    case 'installed_stopped':
      return {
        line: l.stopped_reason === 'self_stop_recent'
          ? 'Installed but stopped — Decky stopped itself after a Steam crash loop. Check Steam, then start it.'
          : 'Installed but stopped.',
        icon: 'pause-circle-outline', tone: 'warn', action: 'start', chip: 'Stopped',
      };
    case 'running_untrusted':
      return {
        line: "Another program owns port 1337 — Decky Loader can't be reached safely.",
        icon: 'alert-circle-outline', tone: 'warn', action: 'repair', chip: 'Untrusted',
      };
    case 'running_unreachable':
      return { line: 'Running but not answering — run Repair.', icon: 'alert-circle-outline', tone: 'warn', action: 'repair', chip: 'Unreachable' };
    case 'running_no_steam':
      return { line: "Running. Steam isn't open.", icon: 'checkmark-circle', tone: 'good', action: 'manage', chip: 'Running' };
    case 'installed_cef_flag_missing':
      return { line: "Steam can't show the Decky menu yet — run Repair.", icon: 'build-outline', tone: 'action', action: 'repair', chip: 'Needs repair' };
    case 'installed_steam_needs_restart':
      return { line: DECKY_STEAM_RESTART, icon: 'refresh-circle-outline', tone: 'action', action: 'manage', chip: 'Restart Steam' };
    case 'running':
      return { line: 'Running.', icon: 'checkmark-circle', tone: 'good', action: 'manage', chip: 'Running' };
    default:
      return { line: String(l.state), icon: 'help-circle-outline', tone: 'idle', action: 'manage', chip: String(l.state) };
  }
}

/**
 * The one-line hint under a Decky surface, by precedence: no installer on the
 * box → re-run it; helper too old → name the helper; not opted in → the opt-in
 * command (shown whether or not the loader is installed, so the feature is
 * discoverable from the phone — spec §5). Null when nothing is in the way.
 */
export function deckyHint(
  l: Pick<DeckyLoader, 'allowed' | 'installer_ready' | 'helper'>,
): { kind: 'installer' | 'helper' | 'optin'; text: string } | null {
  if (!l.installer_ready) return { kind: 'installer', text: DECKY_NEEDS_INSTALLER };
  if (l.helper === 'outdated') return { kind: 'helper', text: DECKY_HELPER_OUTDATED };
  if (!l.allowed) return { kind: 'optin', text: `Enable on the box: ${DECKY_OPTIN_CMD}` };
  return null;
}

/** Can the phone start a loader op right now (spec §3 degrade-closed rules)? */
export function canRunLoaderOp(
  l: Pick<DeckyLoader, 'allowed' | 'installer_ready' | 'helper' | 'op'>,
): boolean {
  if (!l.installer_ready || !l.allowed || l.helper === 'outdated') return false;
  return !isLoaderOpActive(l.op);
}

export function isLoaderOpActive(op: DeckyLoaderOp | null | undefined): boolean {
  return !!op && (op.state === 'starting' || op.state === 'running');
}

/** The line for the loader op result. `starting` is "Starting…" — never a stale
 *  success, because the agent only reports a result correlated to this request. */
export function loaderOpCopy(op: DeckyLoaderOp | null | undefined): { line: string; tone: Tone } | null {
  if (!op) return null;
  const what = op.mode === 'uninstall' ? 'Uninstall' : 'Install / repair';
  switch (op.state) {
    case 'starting': return { line: 'Starting…', tone: 'action' };
    case 'running': return { line: `${what} running on the box…`, tone: 'action' };
    case 'done':
      return op.mode === 'uninstall'
        ? { line: `Decky Loader removed. ${DECKY_UNINSTALL_KEEPS}`, tone: 'good' }
        : { line: `Installed${op.tag ? ` ${op.tag}` : ''}.`, tone: 'good' };
    case 'failed':
      // Do NOT claim "the previous loader was restored": the wrapper only rolls
      // back when an existing services/ was moved aside (an install with a
      // loader already present). A first install, an uninstall, or a failure
      // before services/ is touched restores nothing, so the claim was
      // fabricated success (CLAUDE.md §11). The log carries the truth, incl. the
      // wrapper's literal "rolled back to previous services/" when it happened.
      return { line: `${what} failed${op.detail ? `: ${op.detail}` : ''}. See the log below.`, tone: 'warn' };
    case 'refused':
      return { line: `Refused on the box — Decky management is not enabled (${DECKY_OPTIN_CMD}).`, tone: 'warn' };
    case 'interrupted':
      return { line: `${what} was interrupted before it finished (the box may have restarted). Run Repair.`, tone: 'warn' };
    case 'did_not_start':
      return { line: `Did not start${op.detail ? `: ${op.detail}` : ''}.`, tone: 'warn' };
    default:
      return { line: String(op.state), tone: 'idle' };
  }
}

/** Reasons a loader-op POST can come back `ok:false` (or refuse with a status). */
export function runResultCopy(r: {
  ok?: boolean; started?: boolean; error?: string; detail?: string;
  needs_installer?: boolean; needs_optin?: boolean; helper_outdated?: boolean;
  helper_unreachable?: boolean; retry?: boolean; busy?: boolean; what?: string; did_not_start?: boolean;
}): string | null {
  if (r.started) return null;
  if (r.needs_installer) return DECKY_NEEDS_INSTALLER;
  if (r.needs_optin) return `Not enabled on the box. Run: ${DECKY_OPTIN_CMD}`;
  if (r.helper_outdated) return DECKY_HELPER_OUTDATED;
  if (r.helper_unreachable) return "The box's privileged helper didn't answer — try again in a moment.";
  if (r.busy) return `The box is busy (${r.what === 'plugin_job' ? 'a plugin job' : 'a loader op'} is running). Try again when it finishes.`;
  if (r.did_not_start) return `Did not start${r.detail ? `: ${r.detail}` : ''}.`;
  if (r.error) return r.error;
  if (r.detail) return r.detail;
  return 'Could not start.';
}

/**
 * Map a refused Decky request (ApiError status + parsed body) to copy and,
 * when the agent named one, the restart action to offer. Every branch is a
 * shape from spec §6/§10; anything else falls back to the message.
 */
export function apiErrorHint(
  status: number | undefined,
  body: unknown,
  fallback: string,
): { text: string; restartAction?: string; repair?: boolean } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const err = typeof b.error === 'string' ? b.error : '';
  if (status === 403) return { text: `Not enabled on the box. Run: ${DECKY_OPTIN_CMD}` };
  if (status === 409) {
    if (b.busy === true) {
      return { text: `The box is busy (${b.what === 'plugin_job' ? 'a plugin job' : 'a loader op'} is running). Try again when it finishes.` };
    }
    if (err === 'loader_stopped') {
      const ra = typeof b.restart_action === 'string' ? b.restart_action : undefined;
      const why = b.stopped_reason === 'self_stop_recent'
        ? ' It stopped itself after a Steam crash loop — check Steam first.' : '';
      return {
        text: `Decky Loader is stopped.${why} ${ra ? `Start it with Restart Decky (${DECKY_RESTART_ALL_PLUGINS.toLowerCase()}) and retry.` : 'Run Repair, then retry.'}`,
        restartAction: ra,
        repair: true,
      };
    }
    if (err === 'protected' || /protected/.test(err)) return { text: 'Installed by Couchside — managed by the installer, not here.' };
    return { text: err || fallback };
  }
  if (status === 422) return { text: 'The store lists no verifiable hash for this version, so it cannot be installed safely.' };
  if (status === 503) {
    if (err === 'store_unavailable') return { text: 'The store list is not loaded on the box yet.' };
    return { text: "Decky Loader isn't answering — run Repair.", repair: true };
  }
  if (status === 404) return { text: err ? `Not found: ${err}` : fallback };
  return { text: fallback };
}

/** Is a job still in flight? A record with done:false is running, however old
 *  the app's view of it is (the agent's watchdog is what ends it). */
export function isJobActive(job: DeckyJob | null | undefined): boolean {
  return !!job && !job.done;
}

export type JobCopy = {
  line: string;
  tone: Tone;
  /** Offer one-tap Reinstall of this store id (a failed UPDATE removed the old copy). */
  reinstallId?: number;
  /** Offer "Reload Decky" (the restart action, KI-037 wording) after an install. */
  offerReload?: boolean;
  /** Offer "Retry" (prompt timeout: nothing was installed). */
  offerRetry?: boolean;
};

const KIND_VERB: Record<DeckyJob['kind'], string> = {
  install: 'Installing', update: 'Updating', uninstall: 'Removing', reload: 'Reloading',
};

/**
 * The job banner line. `unknown` is "Checking…" until the box's read-back
 * settles — never "failed" from a closed socket alone. A failed update whose
 * old copy is gone names it and offers Reinstall; a prompt timeout says the
 * prompt may be on the TV.
 */
export function jobCopy(job: DeckyJob, steamUiUp: boolean | undefined): JobCopy {
  const who = job.version ? `${job.name} ${job.version}` : job.name;
  if (!job.done) {
    return { line: `${KIND_VERB[job.kind] ?? 'Working on'} ${who}… (${job.phase || 'queued'})`, tone: 'action' };
  }
  const ui = steamUiUp ?? job.steam_ui_up;
  // A soft failure the agent flags `retry:true` (prompt timeout, or the socket
  // never reached Decky) is the "Decky may be asking on the TV" case — the
  // agent signals it as `outcome:"failed", retry:true`, NOT `outcome:"retry"`
  // (there is no such outcome). Handle it before the switch so it never falls
  // through to the bare `failed` line with no Retry button.
  if (job.done && job.retry && job.outcome === 'failed') {
    return { line: `${DECKY_TV_ASKING} Nothing was installed yet — approve it there, or retry from here.`, tone: 'warn', offerRetry: true };
  }
  switch (job.outcome) {
    case 'done':
      if (job.kind === 'uninstall') return { line: `${job.name} removed${job.verified ? '' : ' (not yet confirmed on disk)'}.`, tone: 'good' };
      // reload_plugin only ENQUEUES the restart (verified:null), so never claim
      // it finished — say it is queued. Only verified:true means it came back.
      if (job.kind === 'reload') {
        return job.verified === true
          ? { line: `${job.name} reloaded.`, tone: 'good' }
          : { line: `Reload queued for ${job.name} — Decky restarts it in the background.`, tone: 'good' };
      }
      return ui
        ? { line: `Installed ${who} — reload Decky to see it in the Quick Access Menu.`, tone: 'good', offerReload: true }
        : { line: `Installed ${who} — it appears next time Steam starts.`, tone: 'good' };
    case 'unknown':
      return { line: `Checking… the box is confirming ${who}.`, tone: 'action' };
    case 'interrupted':
      return { line: `${KIND_VERB[job.kind] ?? 'The job for'} ${who} was interrupted (the box's service restarted). Check the list.`, tone: 'warn' };
    case 'failed':
    default: {
      const rid = typeof job.reinstall_id === 'number' ? job.reinstall_id : undefined;
      return {
        line: job.error ? `${who}: ${job.error}` : `${KIND_VERB[job.kind] ?? 'Job for'} ${who} failed.`,
        tone: 'warn',
        reinstallId: rid,
      };
    }
  }
}

/** Decky's update channel as the app names it (loader.json `branch`). */
export function channelLabel(channel: 0 | 1 | 2 | null | undefined): string | null {
  if (channel === 0) return 'stable';
  if (channel === 1) return 'pre-release';
  if (channel === 2) return 'testing';
  return null;
}
