/**
 * The Suspend button in Power & volume, and the probe that decides whether it
 * shows.
 *
 * Shipped broken in 2.9.74 TestFlight: Suspend vanished from the menu on a box
 * whose /api/actions plainly listed it. The probe effect depended on the whole
 * `settings` object and cancelled its request in cleanup. Settings is rebuilt
 * whenever anything about the box is saved, and the learners save right after
 * the box first answers — so the probe was cancelled ~30ms after it went out,
 * the re-run saw "already probed" and asked nothing, and the answer (which DID
 * list suspend) was discarded. Measured in the web harness with logging:
 * SENT -> cleanup 27ms later -> skip -> ANSWER {cancelled: true, hasSuspend: true}.
 *
 * RemotePowerBar imports react-native and cannot run in bare Node, so the
 * shape that prevents this is pinned by reading the source. The behaviour was
 * proven in the harness (appears on connect, hidden for a box without it,
 * re-asked after a reconnect, retried after a failed probe).
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(import.meta.dirname, '../../components/RemotePowerBar.tsx'), 'utf8');
// Code only: the explanatory comment above the probe names the old pattern.
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const start = code.indexOf('const suspendProbe = React.useRef');
const probe = code.slice(start, code.indexOf('}, [reachable, boxKey, status.lastSuccess]);', start) + 60);

test('the suspend probe exists where the test expects it (control)', () => {
  assert.ok(start > 0, 'probe block not found — update this test with the code');
  assert.ok(probe.includes('api') && probe.includes('.actions(settingsRef.current)'), 'it asks the box for its actions');
});

test('THE BUG: the probe is keyed to the box, not to the settings object', () => {
  // Any settings write (lastSeen, lastIp, caps, version) used to re-run the
  // effect and cancel the in-flight answer.
  assert.ok(probe.includes('}, [reachable, boxKey, status.lastSuccess]);'), 'deps are box + reachability + poll answers');
  assert.ok(!/\}, \[[^\]]*\bsettings\b[^\]]*\]\);/.test(probe), 'settings must not be a dependency of the probe');
  assert.ok(!probe.includes('cancelled = true'), 'a re-run must not discard the answer');
});

test('an answer applies unless a newer probe superseded it, and remembers its box', () => {
  assert.match(probe, /if \(suspendProbe\.current === mine\) \{\s*setSuspendFor\(\{ key: mine\.key, ok: r\.actions\.some\(\(a\) => a\.id === 'suspend'\) \}\);/);
  // The button only ever reflects THIS box's answer (a switch hides it until
  // the new box answers).
  assert.ok(code.includes('const hasSuspend = suspendFor?.key === boxKey && suspendFor.ok;'));
});

test('a failed probe hides the button AND clears itself so it is asked again', () => {
  // Degrade closed: never offer a dead action. But do not stay closed for the
  // whole connection because one request failed.
  assert.match(probe, /\.catch\(\(\) => \{\s*if \(suspendProbe\.current === mine\) \{\s*setSuspendFor\(\{ key: mine\.key, ok: false \}\);\s*suspendProbe\.current = null;/);
});

test('a disconnect forgets the probe, so a reconnect asks again (control)', () => {
  assert.match(probe, /if \(!reachable\) \{\s*suspendProbe\.current = null;\s*return;/);
});

test('the menu still gates the button on reachability and the probe answer', () => {
  assert.ok(code.includes('const canSuspend = reachable && hasSuspend;'));
  assert.match(code, /\{canSuspend && \(\s*<View style=\{styles\.suspendGroup\}>/);
});
