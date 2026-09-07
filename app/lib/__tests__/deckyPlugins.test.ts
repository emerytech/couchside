/**
 * Decky manager phone-side logic — lib/deckyPlugins.ts.
 *
 * Run: from app/, `node --experimental-strip-types --test lib/__tests__/deckyPlugins.test.ts`
 * Picked up by the CI app-input glob.
 *
 * Spec §14: strict semver compare, the update set, search/sort, and all four
 * install_type labels including DOWNGRADE. Controls run both directions
 * (CLAUDE.md §11.3): every "update" case is paired with a "no update" one, so
 * a function that always found an update would fail — the phantom-update bug
 * (`2.0.17-f57f127` read as 2.0.1757127) is the first test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  apiErrorHint, canRunLoaderOp, compareSemver, DECKY_INSTALL_ALERT, DECKY_ROOT_FROM_HOME,
  deckyHint, describeLoaderState, installConfirmCopy, installLabel, installNamesBothVersions,
  installType, isJobActive, jobCopy, loaderOpCopy, pluginUpdate, runResultCopy, searchStore,
  semverTuple, sortStore, updateSet,
} from '../deckyPlugins.ts';
import type { DeckyJob, DeckyStoreEntry } from '../api';

test('THE BUG: a hash-suffixed version is NOT semver, so no phantom update', () => {
  // The agent's old _ver_tuple turned this into (2,0,1757127) and showed an update.
  assert.equal(semverTuple('2.0.17-f57f127'), null);
  assert.equal(compareSemver('2.0.18', '2.0.17-f57f127'), null);
  assert.equal(pluginUpdate({ version: '2.0.17-f57f127', frozen: false }, [{ name: '2.0.18', hash: 'h' }]), null);
  // CONTROL: the same remote against a clean local IS an update.
  assert.deepEqual(pluginUpdate({ version: '2.0.17', frozen: false }, [{ name: '2.0.18', hash: 'h' }]), { version: '2.0.18', hash: 'h' });
});

test('strict semver: shapes accepted and refused', () => {
  assert.deepEqual(semverTuple('1.7.1'), [1, 7, 1, 0]);
  assert.deepEqual(semverTuple('1.7'), [1, 7, 0, 0]);
  assert.deepEqual(semverTuple('3'), [3, 0, 0, 0]);
  assert.deepEqual(semverTuple('1.2.3.4'), [1, 2, 3, 4]);
  assert.equal(semverTuple('1.2.3.4.5'), null);
  assert.equal(semverTuple('v1.7.1'), null);
  assert.equal(semverTuple('1.7.1-pre'), null);
  assert.equal(semverTuple(''), null);
  assert.equal(semverTuple(null), null);
  assert.equal(semverTuple(undefined), null);
  assert.equal(semverTuple('1..2'), null);
});

test('compareSemver orders numerically, not lexically', () => {
  assert.equal(compareSemver('1.10.0', '1.9.0'), 1);     // lexical would say -1
  assert.equal(compareSemver('1.9.0', '1.10.0'), -1);
  assert.equal(compareSemver('1.7', '1.7.0'), 0);
  assert.equal(compareSemver('1.7.1', '1.7.1'), 0);
  assert.equal(compareSemver('1.7.1', null), null);
});

test('update set: newer / equal / older / frozen / unknown-to-store', () => {
  const plugins = [
    { name: 'SteamGridDB', version: '1.7.0', frozen: false },   // newer in store → update
    { name: 'CSS Loader', version: '2.1.2', frozen: false },    // equal → none
    { name: 'Ahead', version: '9.9.9', frozen: false },         // box ahead → none
    { name: 'Frozen', version: '0.1.0', frozen: true },         // frozen → none even though newer
    { name: 'Couchside', version: '0.2.9', frozen: false },     // not in store → none
    { name: 'NullVer', version: null, frozen: false },          // unparsable local → none
  ];
  const store = [
    { name: 'SteamGridDB', versions: [{ name: '1.7.1', hash: 'a'.repeat(64), created: '' }] },
    { name: 'CSS Loader', versions: [{ name: '2.1.2', hash: 'b'.repeat(64), created: '' }] },
    { name: 'Ahead', versions: [{ name: '1.0.0', hash: 'c'.repeat(64), created: '' }] },
    { name: 'Frozen', versions: [{ name: '0.2.0', hash: 'd'.repeat(64), created: '' }] },
    { name: 'NullVer', versions: [{ name: '1.0.0', hash: 'e'.repeat(64), created: '' }] },
  ];
  const s = updateSet(plugins, store);
  assert.deepEqual([...s.keys()], ['SteamGridDB']);
  assert.deepEqual(s.get('SteamGridDB'), { version: '1.7.1', hash: 'a'.repeat(64) });
  // versions[0] is the candidate — a newer entry further down is ignored (Decky's rule).
  assert.equal(pluginUpdate({ version: '1.0.0', frozen: false },
    [{ name: '1.0.0', hash: 'x' }, { name: '2.0.0', hash: 'y' }]), null);
  assert.equal(pluginUpdate({ version: '1.0.0', frozen: false }, []), null);
  assert.equal(pluginUpdate({ version: '1.0.0', frozen: false }, undefined), null);
});

test('install_type: all four cases + the unparsable-installed REINSTALL rule', () => {
  assert.equal(installType(null, '1.0.0'), 'install');
  assert.equal(installType(undefined, '1.0.0'), 'install');
  assert.equal(installType('0.9.0', '1.0.0'), 'update');
  assert.equal(installType('1.0.0', '1.0.0'), 'reinstall');
  assert.equal(installType('1.1.0', '1.0.0'), 'downgrade');
  // Unparsable installed version → presented as REINSTALL, never a silent update.
  assert.equal(installType('1.0.0-dev', '1.0.0'), 'reinstall');
  assert.equal(installType('garbage', '2.0.0'), 'reinstall');
});

test('install labels: Install / Update to x / Reinstall x / Downgrade to x', () => {
  assert.equal(installLabel('install', '1.2.3'), 'Install');
  assert.equal(installLabel(null, '1.2.3'), 'Install');
  assert.equal(installLabel('update', '1.2.3'), 'Update to 1.2.3');
  assert.equal(installLabel('reinstall', '1.2.3'), 'Reinstall 1.2.3');
  assert.equal(installLabel('downgrade', '1.2.3'), 'Downgrade to 1.2.3');
  // Only reinstall/downgrade must name both versions in the confirm.
  assert.equal(installNamesBothVersions('downgrade'), true);
  assert.equal(installNamesBothVersions('reinstall'), true);
  assert.equal(installNamesBothVersions('update'), false);
  assert.equal(installNamesBothVersions('install'), false);
});

test('install confirm copy names author, version, both versions on downgrade, root, blink', () => {
  const dg = installConfirmCopy({
    name: 'PowerTools', author: 'NGnius', type: 'downgrade', installedVersion: '2.0.0', remoteVersion: '1.5.0',
  });
  assert.equal(dg.title, 'Downgrade to 1.5.0');
  assert.ok(dg.message.includes('2.0.0') && dg.message.includes('1.5.0'), 'names both versions');
  assert.ok(dg.message.includes('NGnius'));
  assert.ok(!dg.message.includes('This plugin runs as root on your box'), 'no root line when not flagged');
  assert.equal(dg.okLabel, 'Downgrade');

  const ri = installConfirmCopy({
    name: 'X', author: 'a', type: 'reinstall', installedVersion: '1.0.0', remoteVersion: '1.0.0',
  });
  assert.ok(ri.message.includes('1.0.0 over the installed 1.0.0'));

  const root = installConfirmCopy({
    name: 'Y', author: 'b', type: 'install', installedVersion: null, remoteVersion: '0.1.0', root: true, steamUiUp: true,
  });
  assert.ok(root.message.includes('This plugin runs as root on your box.'));
  assert.ok(root.message.includes("Decky's menu will blink and any open Decky prompt is cancelled."));
  assert.equal(root.okLabel, 'Install');
  // CONTROL: no blink line when Steam's UI is not up.
  const quiet = installConfirmCopy({ name: 'Y', author: 'b', type: 'install', installedVersion: null, remoteVersion: '0.1.0' });
  assert.ok(!quiet.message.includes('blink'));
});

const ENTRIES: DeckyStoreEntry[] = [
  { id: 1, name: 'SteamGridDB', author: 'SteamGridDB', description: 'Custom art for your games', tags: ['art', 'library'], downloads: 1648887, updated: '2026-03-01T00:00:00Z', has_icon: true, installed_version: null, update_available: false, install_type: 'install', versions: [{ name: '1.7.1', hash: 'a'.repeat(64), created: '' }] },
  { id: 2, name: 'CSS Loader', author: 'suchmememanyskill', description: 'Themes for Steam', tags: ['theme'], downloads: 900000, updated: '2026-05-01T00:00:00Z', has_icon: false, installed_version: '2.1.2', update_available: false, install_type: 'reinstall', versions: [{ name: '2.1.2', hash: 'b'.repeat(64), created: '' }] },
  { id: 3, name: 'animation changer', author: 'AAGaming', description: 'Boot videos', tags: ['boot', 'art'], downloads: 500, updated: '2025-01-01T00:00:00Z', has_icon: true, installed_version: null, update_available: false, install_type: 'install', versions: [{ name: '0.3.0', hash: 'c'.repeat(64), created: '' }] },
];

test('search: name / author / tags / description, case-insensitive; empty = all (a copy)', () => {
  assert.deepEqual(searchStore(ENTRIES, 'grid').map((e) => e.id), [1]);          // name
  assert.deepEqual(searchStore(ENTRIES, 'aagaming').map((e) => e.id), [3]);      // author
  assert.deepEqual(searchStore(ENTRIES, 'ART').map((e) => e.id), [1, 3]);        // tag (case)
  assert.deepEqual(searchStore(ENTRIES, 'themes').map((e) => e.id), [2]);        // description
  assert.deepEqual(searchStore(ENTRIES, 'zzz'), []);                              // control: nothing
  const all = searchStore(ENTRIES, '   ');
  assert.equal(all.length, 3);
  assert.notEqual(all, ENTRIES, 'returns a copy, never the input array');
});

test('sort: downloads desc, name A–Z case-insensitively, updated newest first', () => {
  assert.deepEqual(sortStore(ENTRIES, 'downloads').map((e) => e.id), [1, 2, 3]);
  assert.deepEqual(sortStore(ENTRIES, 'name').map((e) => e.id), [3, 2, 1]);     // 'animation' < 'CSS' < 'Steam'
  assert.deepEqual(sortStore(ENTRIES, 'updated').map((e) => e.id), [2, 1, 3]);
  // Input untouched.
  assert.deepEqual(ENTRIES.map((e) => e.id), [1, 2, 3]);
});

test('loader state presentation covers every spec state and never throws on an unknown one', () => {
  const states = ['not_installed', 'installing', 'uninstalling', 'installed_stopped', 'running_untrusted',
    'running_unreachable', 'running_no_steam', 'installed_cef_flag_missing', 'installed_steam_needs_restart', 'running'];
  for (const state of states) {
    const p = describeLoaderState({ state });
    assert.ok(p.line.length > 0 && p.icon.length > 0, state);
  }
  assert.equal(describeLoaderState({ state: 'not_installed' }).action, 'install');
  assert.equal(describeLoaderState({ state: 'installed_stopped' }).action, 'start');
  assert.equal(describeLoaderState({ state: 'installed_cef_flag_missing' }).action, 'repair');
  assert.equal(describeLoaderState({ state: 'running' }).action, 'manage');
  assert.ok(describeLoaderState({ state: 'installed_stopped', stopped_reason: 'self_stop_recent' }).line.includes('crash loop'));
  assert.ok(describeLoaderState({ state: 'running_untrusted' }).line.includes('port 1337'));
  assert.ok(describeLoaderState({ state: 'installed_steam_needs_restart' }).line.includes('Restart Steam or reboot'));
  const unknown = describeLoaderState({ state: 'something_new' });
  assert.equal(unknown.line, 'something_new');
});

test('hints: installer > helper > opt-in precedence; none when all clear', () => {
  assert.equal(deckyHint({ allowed: false, installer_ready: false, helper: 'outdated' })?.kind, 'installer');
  assert.equal(deckyHint({ allowed: false, installer_ready: true, helper: 'outdated' })?.kind, 'helper');
  assert.equal(deckyHint({ allowed: false, installer_ready: true, helper: 'present' })?.kind, 'optin');
  assert.ok(deckyHint({ allowed: false, installer_ready: true, helper: 'absent' })?.text.includes('couchside allow-decky on'));
  assert.equal(deckyHint({ allowed: true, installer_ready: true, helper: 'present' }), null);
  assert.ok(deckyHint({ allowed: true, installer_ready: true, helper: 'outdated' })?.text.includes('Installing privileged helper'));
});

test('canRunLoaderOp fails closed on any missing precondition and while an op is active', () => {
  const ok = { allowed: true, installer_ready: true, helper: 'present' as const, op: null };
  assert.equal(canRunLoaderOp(ok), true);
  assert.equal(canRunLoaderOp({ ...ok, allowed: false }), false);
  assert.equal(canRunLoaderOp({ ...ok, installer_ready: false }), false);
  assert.equal(canRunLoaderOp({ ...ok, helper: 'outdated' }), false);
  assert.equal(canRunLoaderOp({ ...ok, helper: 'absent' }), true);   // sudo path is fine
  assert.equal(canRunLoaderOp({ ...ok, op: { state: 'starting', mode: 'install', ok: null, tag: null, at: null } }), false);
  assert.equal(canRunLoaderOp({ ...ok, op: { state: 'running', mode: 'install', ok: null, tag: null, at: null } }), false);
  assert.equal(canRunLoaderOp({ ...ok, op: { state: 'done', mode: 'install', ok: true, tag: 'v3.2.8', at: 1 } }), true);
});

test('loader op copy: starting is "Starting…", never a stale success; every terminal state has a reason', () => {
  assert.equal(loaderOpCopy({ state: 'starting', mode: 'install', ok: null, tag: null, at: null })?.line, 'Starting…');
  assert.equal(loaderOpCopy({ state: 'done', mode: 'install', ok: true, tag: 'v3.2.8', at: 1 })?.line, 'Installed v3.2.8.');
  assert.ok(loaderOpCopy({ state: 'done', mode: 'uninstall', ok: true, tag: '', at: 1 })?.line.includes('plugins and settings are kept'));
  assert.ok(loaderOpCopy({ state: 'failed', mode: 'install', ok: false, tag: null, at: 1, detail: 'exit 5' })?.line.includes('exit 5'));
  assert.ok(loaderOpCopy({ state: 'refused', mode: 'install', ok: false, tag: null, at: 1 })?.line.includes('allow-decky'));
  assert.ok(loaderOpCopy({ state: 'interrupted', mode: 'install', ok: false, tag: null, at: null })?.line.includes('interrupted'));
  assert.ok(loaderOpCopy({ state: 'did_not_start', mode: 'install', ok: false, tag: null, at: null, detail: 'unit x result=exit-code' })?.line.includes('result=exit-code'));
  assert.equal(loaderOpCopy(null), null);
});

test('run-result copy: every ok:false flag maps to a reason; started → null', () => {
  assert.equal(runResultCopy({ ok: true, started: true }), null);
  assert.ok(runResultCopy({ ok: false, needs_optin: true })?.includes('allow-decky on'));
  assert.ok(runResultCopy({ ok: false, needs_installer: true })?.includes('installer'));
  assert.ok(runResultCopy({ ok: false, helper_outdated: true })?.includes('privileged helper'));
  assert.ok(runResultCopy({ ok: false, helper_unreachable: true, retry: true })?.includes('try again'));
  assert.ok(runResultCopy({ ok: false, busy: true, what: 'plugin_job' })?.includes('plugin job'));
  assert.ok(runResultCopy({ ok: false, did_not_start: true, detail: 'x' })?.includes('x'));
  // The old-app string from the agent surfaces verbatim.
  assert.equal(runResultCopy({ ok: false, error: 'Update the Couchside app to manage Decky Loader' }),
    'Update the Couchside app to manage Decky Loader');
});

test('apiErrorHint maps the spec refusal shapes, incl. the named restart action', () => {
  assert.ok(apiErrorHint(403, { error: 'needs_optin' }, 'f').text.includes('allow-decky on'));
  assert.ok(apiErrorHint(409, { busy: true, what: 'loader_op' }, 'f').text.includes('loader op'));
  assert.ok(apiErrorHint(409, { busy: true, what: 'plugin_job' }, 'f').text.includes('plugin job'));
  const stopped = apiErrorHint(409, { error: 'loader_stopped', restart_action: 'restart-decky', repair: true, stopped_reason: null }, 'f');
  assert.equal(stopped.restartAction, 'restart-decky');
  assert.ok(stopped.text.includes('restarts all plugins'), 'KI-037 wording');
  const stoppedNoAction = apiErrorHint(409, { error: 'loader_stopped', restart_action: null, repair: true, stopped_reason: 'self_stop_recent' }, 'f');
  assert.equal(stoppedNoAction.restartAction, undefined);
  assert.ok(stoppedNoAction.text.includes('crash loop'));
  assert.ok(apiErrorHint(409, { error: 'protected' }, 'f').text.includes('Couchside'));
  assert.ok(apiErrorHint(422, { error: 'no verifiable hash' }, 'f').text.includes('hash'));
  assert.ok(apiErrorHint(503, { error: 'loader_down', repair: true }, 'f').repair);
  assert.ok(apiErrorHint(503, { error: 'store_unavailable' }, 'f').text.includes('store'));
  assert.equal(apiErrorHint(500, null, 'fallback').text, 'fallback');
  assert.equal(apiErrorHint(undefined, undefined, 'fallback').text, 'fallback');
});

function job(p: Partial<DeckyJob>): DeckyJob {
  return {
    kind: 'install', name: 'X', version: '1.0.0', store_id: 7, phase: 'download', started_at: 0,
    done: false, ok: null, outcome: null, error: null, restarted_loader: false, log: [], ...p,
  };
}

test('job banner: running / unknown=Checking / done copy by steam_ui_up / failed-update Reinstall / retry=TV', () => {
  assert.equal(isJobActive(job({})), true);
  assert.equal(isJobActive(job({ done: true, outcome: 'done' })), false);
  assert.equal(isJobActive(null), false);
  assert.ok(jobCopy(job({}), false).line.startsWith('Installing X 1.0.0'));
  assert.ok(jobCopy(job({ done: true, outcome: 'unknown' }), false).line.startsWith('Checking'));
  const up = jobCopy(job({ done: true, outcome: 'done', ok: true }), true);
  assert.ok(up.line.includes('reload Decky to see it in the Quick Access Menu'));
  assert.equal(up.offerReload, true);
  const down = jobCopy(job({ done: true, outcome: 'done', ok: true }), false);
  assert.ok(down.line.includes('next time Steam starts'));
  assert.equal(down.offerReload, undefined);
  const failed = jobCopy(job({ kind: 'update', done: true, outcome: 'failed', ok: false,
    error: 'update failed; X 0.9.0 was removed by Decky Loader — reinstall from the Store', reinstall_id: 7 }), false);
  assert.equal(failed.reinstallId, 7);
  assert.ok(failed.line.includes('removed by Decky Loader'));
  const failedNoRid = jobCopy(job({ done: true, outcome: 'failed', ok: false, error: 'extracted but not loaded' }), false);
  assert.equal(failedNoRid.reinstallId, undefined);
  // The agent signals a prompt timeout as outcome:'failed' + retry:true — NOT a
  // distinct 'retry' outcome (there is none). jobCopy must read the flag.
  const retry = jobCopy(job({ done: true, outcome: 'failed', retry: true }), true);
  assert.ok(retry.line.includes('Decky may be asking on the TV'));
  assert.equal(retry.offerRetry, true);
  // Control: a hard failure with no retry flag does NOT offer Retry.
  const hardFail = jobCopy(job({ done: true, outcome: 'failed', error: 'Decky refused' }), true);
  assert.equal(hardFail.offerRetry, undefined);
  assert.ok(jobCopy(job({ kind: 'uninstall', done: true, outcome: 'done', verified: true }), false).line.includes('removed'));
  // reload_plugin only ENQUEUES (verified:null) -> "queued"; verified:true -> "reloaded".
  assert.ok(jobCopy(job({ kind: 'reload', done: true, outcome: 'done', verified: null }), false).line.includes('queued'));
  assert.ok(jobCopy(job({ kind: 'reload', done: true, outcome: 'done', verified: true }), false).line.includes('reloaded'));
  assert.ok(jobCopy(job({ done: true, outcome: 'interrupted' }), false).line.includes('interrupted'));
});

test('the install alert leads with the root-from-home sentence and names GitHub, no checksum, Steam restart', () => {
  assert.ok(DECKY_INSTALL_ALERT.startsWith(DECKY_ROOT_FROM_HOME));
  assert.ok(DECKY_ROOT_FROM_HOME.includes('runs as root from your home directory'));
  assert.ok(DECKY_INSTALL_ALERT.includes('GitHub'));
  assert.ok(DECKY_INSTALL_ALERT.includes('no checksum'));
  assert.ok(DECKY_INSTALL_ALERT.includes('Steam must restart'));
});
