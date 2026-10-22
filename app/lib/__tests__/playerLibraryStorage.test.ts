import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import type { LibraryStorage } from '../player/library.ts';

const source = ts.transpileModule(readFileSync(new URL('../player/libraryStore.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const KEY = 'couchside.player.library.v1';
const primary = `${KEY}.json`, backup = `${KEY}.backup.json`;
function mount(files: Map<string, string>): LibraryStorage {
  let storage!: LibraryStorage;
  vm.runInNewContext(source, { exports: {}, require(name: string) {
    if (name === 'react') return {};
    if (name === 'react-native') return { Platform: { OS: 'ios' } };
    if (name === './library') return { PlayerLibrary: class { constructor(s: LibraryStorage) { storage = s; } } };
    if (name === 'expo-file-system') return { Paths: { document: '/sandbox' }, File: class {
      name: string;
      constructor(_base: string, name: string) { this.name = name; }
      get exists() { return files.has(this.name); }
      async text() { if (!files.has(this.name)) throw Error('missing'); return files.get(this.name); }
      write(value: string) { files.set(this.name, value); }
    } };
    throw Error(name);
  } });
  return storage;
}
test('native storage recovers a damaged primary and keeps both copies current after forgetting history', async () => {
  const original = JSON.stringify({ version: 1, entries: [{ title: 'saved history' }] });
  const files = new Map([[primary, 'truncated{'], [backup, original]]);
  const disk = mount(files);
  assert.equal(await disk.read(), original);
  assert.equal(files.get(primary), original);
  const empty = JSON.stringify({ version: 1, entries: [] });
  await disk.write(empty);
  assert.equal(files.get(primary), empty); assert.equal(files.get(backup), empty);
});
test('native storage never downgrades a newer schema to an older backup', async () => {
  const future = '{"version":2,"entries":[]}';
  const files = new Map([[primary, future], [backup, '{"version":1,"entries":[]}']]);
  assert.equal(await mount(files).read(), future);
  assert.equal(files.get(primary), future);
});
test('a new native library starts empty and two damaged copies fail visibly', async () => {
  assert.equal(await mount(new Map()).read(), null);
  await assert.rejects(mount(new Map([[primary, '{'], [backup, '{']])).read());
});
