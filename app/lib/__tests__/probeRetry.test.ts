/**
 * The "probe once, treat any failure as unsupported, never retry" bug class —
 * the same shape behind the vanishing Suspend button (see suspendProbe.test.ts),
 * found by a 2026-10-04 code sweep in five more places. Each hid an optional
 * control the FIRST time its probe failed for a transient reason (box asleep,
 * 4s timeout, 401, 5xx) and never showed it again that session, because the
 * caller collapsed "agent genuinely can't do this" (an exact 404 / explicit
 * null) into the same state as "box was briefly unreachable".
 *
 * The fixes all keep the same contract: degrade closed while UNKNOWN (never
 * offer a dead control), hide permanently only on a real 404 / explicit answer,
 * and RETRY a transient failure (usePoll's ~2s retry, or an explicit re-probe)
 * so the control returns when the box is reachable again.
 *
 * These files import react-native and cannot run in bare Node, so — as
 * CONVENTIONS "Source-reading guards" sanctions — the shape that prevents the
 * bug is pinned by reading the source (comments stripped, whitespace collapsed)
 * and asserting both the fix IS present and the bug is NOT. Every assertion was
 * verified in both directions (break the source, watch the test fail, restore).
 * The behaviour itself was reproduced + recovered + negative-controlled in the
 * web harness; see docs/BUILD_LOG.md 2026-10-04.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '../..');
/** Read a source file with comments removed and whitespace collapsed, so the
 *  guards pin STRUCTURE, not formatting. Line comments only when the line
 *  starts with `//` (leaves `https://` inside strings alone). */
function code(rel: string): string {
  return readFileSync(join(root, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const api = code('lib/api.ts');
const pad = code('app/(tabs)/pad.tsx');
const installable = code('components/InstallableSection.tsx');
const steamCard = code('components/SteamIntegrationCard.tsx');
const itadCard = code('components/ItadIntegrationCard.tsx');
const utils = code('components/UtilitiesSection.tsx');

// ── Site 1: Steam Search button (pad.tsx searchUnsupported + api.steamGoto) ──

test('api.steamGoto resolves the agent ok on a 200 and throws otherwise (control)', () => {
  // Pin the exact method body: calls the goto route and resolves `!!r?.ok` with
  // NO .catch, so every failure (404 or transient) propagates as an ApiError.
  assert.ok(
    api.includes(
      "steamGoto(settings: ConnSettings, id: 'home'): Promise<boolean> { "
        + "return request<{ ok: boolean }>(settings, '/api/steam/goto', "
        + "{ method: 'POST', body: { id }, }).then((r) => !!r?.ok); },"),
    'steamGoto body not in the expected shape — update this guard with the code');
});

test('THE BUG: steamGoto must NOT .catch(() => false) — that hid Search for the session', () => {
  const start = api.indexOf("steamGoto(settings: ConnSettings, id: 'home')");
  assert.ok(start > 0, 'steamGoto not found');
  const body = api.slice(start, start + 260);
  assert.ok(!body.includes('.catch('), 'a transient error must THROW, not resolve false');
});

test('the Search button hides ONLY on an exact 404, never on a transient error', () => {
  // The catch brands the feature unsupported solely for a 404 (route missing =
  // agent too old); anything else leaves the button for the next tap.
  assert.ok(
    pad.includes('if (e instanceof ApiError && e.status === 404) setSearchUnsupported(true);'),
    'the 404-only guard that marks Search unsupported is gone');
});

test('THE BUG: `if (!anchored)` must not brand the feature unsupported', () => {
  // The old code set searchUnsupported true whenever steamGoto resolved false,
  // and steamGoto resolved false on EVERY error. Now `!anchored` just aborts.
  assert.ok(
    /if \(!anchored\) return;/.test(pad),
    'a not-ok anchor must abort the tap, not hide the button');
  assert.ok(
    !/if \(!anchored\) \{ [^}]*setSearchUnsupported\(true\)/.test(pad),
    'setSearchUnsupported must not be driven by !anchored any more');
});

// ── Site 2: pad mode bounce off a box with no Steam menus (pad.tsx) ──

test('the menus bounce fires only on a real negative ANSWER, not a failed fetch', () => {
  assert.ok(
    pad.includes('const answered = menusPoll.dataKey === hostKey(settings) && menusPoll.error == null;'),
    'the "answered for this box" guard is gone');
  assert.ok(
    /if \(answered && !hasSteamMenus\) setMode\('remote'\);/.test(pad),
    'only bounce to remote once the box answered and has no menus');
});

test('THE BUG: a failed first menus fetch must not overwrite a saved STEAM mode', () => {
  // usePoll leaves data null + loading false on a FAILED first fetch exactly as
  // on a success with no menus, so gating on `!loading` bounced an asleep box.
  assert.ok(
    !pad.includes('!menusPoll.loading && !hasSteamMenus'),
    'the loading-based bounce that overwrote the saved mode is back');
});

// ── Site 3: InstallableSection ("Install games from your library" card) ──

test('InstallableSection probes through usePoll so a transient failure retries', () => {
  assert.ok(
    /usePoll\( \(\) => api\.installable\(settings\), 60_000, configured, hostKey\(settings\)\)/.test(installable),
    'the installable probe must run through usePoll (retry + resetKey), not a one-shot effect');
});

test('THE BUG: InstallableSection must not be a one-shot effect keyed on [settings]', () => {
  assert.ok(!installable.includes('let live = true'), 'the old one-shot fetch (no retry) is back');
  // A 404 still hides it; the card shows only on a real count.
  assert.ok(installable.includes('if (count === null || count === 0) return null;'), 'still hides on null/zero');
});

// ── Site 4: SteamIntegrationCard + ItadIntegrationCard ──

for (const [name, src, method] of [
  ['SteamIntegrationCard', steamCard, 'api.steamWebApi(settings)'],
  ['ItadIntegrationCard', itadCard, 'api.itadStatus(settings)'],
] as const) {
  test(`${name} probes through usePoll and retries transient failures`, () => {
    assert.ok(
      src.includes(`usePoll( () => ${method}, 30_000, ready && configured, hostKey(settings))`),
      `${name} must read its status through usePoll`);
    assert.ok(src.includes('const status = poll.data;'), `${name} status comes from the poll`);
    // Hide once we KNOW (null after an answer) or while a transient failure
    // keeps us hidden + retrying; spinner only on the first in-flight probe.
    assert.ok(src.includes('if (status == null && !loading) return null;'), `${name} degrades closed`);
  });

  test(`THE BUG: ${name} must not catch EVERY error to null (which hid it for good)`, () => {
    // The old refresh did `try { setStatus(await ...) } catch { setStatus(null) }`
    // — a transient error set null, and null hides the card permanently.
    assert.ok(!/catch \{ setStatus\(null\); \}/.test(src), `${name} still maps any error to "unsupported"`);
    assert.ok(!src.includes('setStatus('), `${name} must not keep local status state alongside the poll`);
    // A mutation re-reads the box instead of trusting an optimistic local value.
    assert.ok(src.includes('poll.refresh()'), `${name} must re-probe after connect/disconnect`);
  });
}

// ── Site 5: UtilitiesSection (OpenPuck / CEC / Decky helpers) ──

test('UtilitiesSection.refresh handles a transient failure instead of leaking a rejection', () => {
  const m = utils.match(/const refresh = useCallback\(async \(\) => \{(.*?)\}, \[settings\]\);/);
  assert.ok(m, 'refresh body not found — update this guard with the code');
  const body = m[1];
  // api.utilities throws on non-404; it MUST be inside a try that returns on a
  // transient failure (leaving utils unchanged) rather than crashing refresh.
  assert.ok(/try \{ res = await api\.utilities\(settings\);/.test(body), 'the utilities probe must be in a try');
  assert.ok(/\} catch \{ return; \}/.test(body), 'a transient failure must return, not set null');
  assert.ok(body.includes('setProbed(true);'), 'a real answer marks the probe done');
});

test('UtilitiesSection retries the first probe until the box answers', () => {
  // `probed` flips true only on a resolved probe (success OR 404), so the retry
  // runs through transient failures and stops the moment the box answers.
  assert.ok(utils.includes('setProbed(false);'), 'a box switch must re-probe from scratch');
  assert.ok(
    /if \(!canProbe \|\| probed\) return undefined; const id = setInterval\(\(\) => \{ void refresh\(\); \}, 3000\);/.test(utils),
    'the bounded re-probe loop (every 3s until answered) is gone');
});

test('THE BUG: a transient utilities failure must not permanently blank the card', () => {
  // The render still hides on a genuine null (404/caps-false), which is the
  // negative control: an unsupported box stays hidden.
  assert.ok(utils.includes('if (!canProbe || !utils || utils.length === 0) return null;'), 'still hides when unsupported');
});
