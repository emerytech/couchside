import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { normalizeFavorites } from '../watchFavoriteOrder.ts';

const source = ts.transpileModule(
  readFileSync(new URL('../watchFavorites.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

function mount(store: { value: string | null }, deferWrites = false) {
  const subscriptions: (() => void)[] = [];
  const writes: string[] = [];
  const releases: (() => void)[] = [];
  const exports = {} as { useWatchFavorites: () => string[]; toggleWatchFavorite: (service: string) => void };
  vm.runInNewContext(source, {
    exports,
    require(name: string) {
      if (name === './watchFavoriteOrder') return { normalizeFavorites };
      if (name === 'react-native') return { Platform: { OS: 'ios' } };
      if (name === 'react') return { useSyncExternalStore(subscribe: (listener: () => void) => () => void, snapshot: () => string[]) {
        subscriptions.push(subscribe(() => {}));
        return snapshot();
      } };
      if (name === 'expo-secure-store') return {
        getItemAsync: async () => store.value,
        setItemAsync: async (_key: string, value: string) => {
          writes.push(value);
          if (deferWrites) await new Promise<void>(resolve => releases.push(resolve));
          store.value = value;
        },
      };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  exports.useWatchFavorites();
  return { exports, writes, releases, unmount: () => subscriptions.forEach(off => off()) };
}

test('favorite changes persist in order and survive a new module instance', async () => {
  const store = { value: '["youtube"]' };
  const first = mount(store, true);
  await turn();
  first.exports.toggleWatchFavorite('netflix');
  first.exports.toggleWatchFavorite('youtube');
  await turn();
  assert.equal(first.writes.length, 1, 'second write waits for the first');
  first.releases.shift()!();
  await turn();
  assert.equal(first.writes.length, 2);
  first.releases.shift()!();
  await turn();
  assert.deepEqual(JSON.parse(store.value), ['netflix']);
  first.unmount();
  const second = mount(store);
  await turn();
  assert.deepEqual(Array.from(second.exports.useWatchFavorites()), ['netflix']);
  second.unmount();
});

test('corrupt storage does not block future favorite changes', async () => {
  const store = { value: 'not json' };
  const app = mount(store);
  await turn();
  app.exports.toggleWatchFavorite('youtube');
  await turn();
  assert.deepEqual(JSON.parse(store.value), ['youtube']);
  app.unmount();
});
