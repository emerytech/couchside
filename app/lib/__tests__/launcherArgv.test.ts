/**
 * Custom-launcher argv construction — lib/launcherArgv.ts.
 *
 * Run: from app/, `node --experimental-strip-types --test lib/__tests__/*.test.ts`
 *
 * WHY THESE TESTS. The old single-field whitespace split shipped a real bug: a
 * spaced Windows path (`C:\Program Files\...`) was torn into two argv entries
 * and the launch failed — the exact thing a paying Windows customer reported.
 * The agent stores this argv verbatim, so getting it wrong here is unrecoverable
 * downstream. Per CLAUDE.md §11 each rule is exercised in BOTH directions and
 * carries a control (an input whose answer is known independently — the plain
 * Linux `flatpak run ...` case, which BOTH the old and new code get right).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs, buildLauncherArgv } from '../launcherArgv.ts';

test('program with spaces stays a single argv[0] (the reported bug)', () => {
  // The old code: 'C:\\Program Files\\Kodi\\kodi.exe'.split(/\s+/) -> 2 entries.
  assert.deepEqual(
    buildLauncherArgv('C:\\Program Files\\Kodi\\kodi.exe', ''),
    ['C:\\Program Files\\Kodi\\kodi.exe'],
  );
});

test('control: a plain spaceless command still parses as before', () => {
  // Known answer, unchanged from the old split — proves the new path is not
  // just "always one token".
  assert.deepEqual(
    buildLauncherArgv('flatpak', 'run org.libretro.RetroArch'),
    ['flatpak', 'run', 'org.libretro.RetroArch'],
  );
});

test('arguments split on whitespace', () => {
  assert.deepEqual(
    buildLauncherArgv('C:\\Program Files\\Kodi\\kodi.exe', '--fullscreen --windowed'),
    ['C:\\Program Files\\Kodi\\kodi.exe', '--fullscreen', '--windowed'],
  );
});

test('a quoted argument keeps its embedded space as one token', () => {
  assert.deepEqual(parseArgs('--title "Big Buck Bunny" --loop'), [
    '--title',
    'Big Buck Bunny',
    '--loop',
  ]);
});

test("single quotes work too, and are stripped", () => {
  assert.deepEqual(parseArgs("--path 'a b c'"), ['--path', 'a b c']);
});

test('empty / whitespace program yields empty argv (nothing to run)', () => {
  assert.deepEqual(buildLauncherArgv('', '--fullscreen'), []);
  assert.deepEqual(buildLauncherArgv('   ', 'x'), []);
});

test('surrounding whitespace on the program is trimmed but interior kept', () => {
  assert.deepEqual(buildLauncherArgv('  /usr/bin/vlc  ', ''), ['/usr/bin/vlc']);
  assert.deepEqual(buildLauncherArgv('  C:\\Program Files\\VLC\\vlc.exe  ', ''), [
    'C:\\Program Files\\VLC\\vlc.exe',
  ]);
});

test('empty arguments field contributes nothing', () => {
  assert.deepEqual(buildLauncherArgv('kodi', ''), ['kodi']);
  assert.deepEqual(buildLauncherArgv('kodi', '   '), ['kodi']);
});
