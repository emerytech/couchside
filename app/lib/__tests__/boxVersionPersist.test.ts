import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { isValidLanIp } from '../lanIp.ts';

// A long-paired box must come back from storage with its last-known service
// version. loadBoxes used to drop Box.version on every cold launch, so
// useCapsSync rewrote it on the first /api/status answer — a settings write (and
// a new `settings` object) every launch with nothing actually changed.
//
// settings.ts imports react-native and expo-secure-store, which bare Node cannot
// load, so this executes the REAL source with those stubbed (the
// statusLearning.test.ts approach): Platform.OS 'web' routes storage through a
// fake localStorage, and loadBoxes/saveBoxes run unmodified.
const source = stripTypeScriptTypes(readFileSync(new URL('../settings.ts', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '')
  .replace(/^export \{[^}]*\};\n/gm, '')
  .replace(/^export /gm, '');

const KEY = 'couchpilot.boxes.v1';

function coldLaunch(stored: Record<string, string>) {
  const ls = {
    getItem: (k: string) => (k in stored ? stored[k] : null),
    setItem: (k: string, v: string) => { stored[k] = v; },
  };
  const context: any = {
    Platform: { OS: 'web' }, SecureStore: {}, isValidLanIp, window: { localStorage: ls },
  };
  runInNewContext(source, context);
  return context as {
    loadBoxes: () => Promise<{ boxes: any[]; activeBoxId: string | null }>;
    saveBoxes: (s: unknown) => Promise<void>;
  };
}

function persisted(box: Record<string, unknown>): Record<string, string> {
  return { [KEY]: JSON.stringify({ boxes: [{ id: 'box-0', host: 'steam-machine.local', port: 8787, token: 't', padMode: 'swipe', ...box }], activeBoxId: 'box-0' }) };
}

test('a learned service version survives save -> cold launch', async () => {
  const stored: Record<string, string> = {};
  const first = coldLaunch(stored);
  await first.saveBoxes({
    boxes: [{ id: 'box-3', name: 'Living room', host: 'steam-machine.local', port: 8787, token: 't', padMode: 'swipe', version: '2.9.129' }],
    activeBoxId: 'box-3',
  });
  const { boxes, activeBoxId } = await coldLaunch(stored).loadBoxes();
  assert.equal(activeBoxId, 'box-3');
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].version, '2.9.129');
});

test('the version is kept verbatim, never cleaned up', async () => {
  // useCapsSync compares the raw agent_version against this value. Trimming or
  // reformatting it here would make the two disagree and bring the per-launch
  // write back; the Windows suffix is also what isWindowsAgent reads.
  for (const v of ['0.4.12-win', '2.9.129', ' 2.9.129 ']) {
    const { boxes } = await coldLaunch(persisted({ version: v })).loadBoxes();
    assert.equal(boxes[0].version, v);
  }
});

test('control: a non-string or empty version is dropped, the box still loads', async () => {
  for (const v of [42, 0, true, null, {}, ['2.9.129'], '']) {
    const { boxes } = await coldLaunch(persisted({ version: v, lastIp: '10.1.1.38' })).loadBoxes();
    assert.equal(boxes.length, 1, `box with version ${JSON.stringify(v)} must still load`);
    assert.equal(boxes[0].version, undefined, `version ${JSON.stringify(v)} must be dropped`);
    assert.equal(boxes[0].host, 'steam-machine.local');
    assert.equal(boxes[0].lastIp, '10.1.1.38');
  }
});

test('a box that never learned a version stays unknown', async () => {
  const { boxes } = await coldLaunch(persisted({})).loadBoxes();
  assert.equal(boxes.length, 1);
  assert.equal('version' in boxes[0] ? boxes[0].version : undefined, undefined);
});
