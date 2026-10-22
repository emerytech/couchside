import test from 'node:test';
import assert from 'node:assert/strict';
import { PlayerLibrary, normalizeLibrary } from '../player/library.ts';
import { boxCatalogProvider, mediaKey, MetadataProviders, type MediaTitle } from '../player/discovery.ts';

const title: MediaTitle = { ref: { provider: 'sample', id: '1' }, kind: 'movie',
  name: 'A film', description: 'Description', attribution: 'Creator', externalIds: { imdb: 'tt123' } };
function storage(value: string | null = null) {
  return { value, writes: 0, async read() { return this.value; }, async write(next: string) { this.writes++; this.value = next; } };
}

test('saving before hydration completes preserves existing titles and serializes writes', async () => {
  const existing = { ...title, ref: { provider: 'other', id: '1' } };
  const disk = storage(JSON.stringify({ version: 1, entries: [{ title: existing, saved: true, updatedAt: 1 }] }));
  let release!: () => void;
  const firstWrite = new Promise<void>(resolve => { release = resolve; });
  const originalWrite = disk.write.bind(disk);
  disk.write = async value => { if (!disk.writes) await firstWrite; await originalWrite(value); };
  const library = new PlayerLibrary(disk);
  const saved = library.update(title, { saved: true });
  const watched = library.update(title, { watched: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(disk.writes, 0);
  release(); await Promise.all([saved, watched]);
  const reloaded = new PlayerLibrary(disk); await reloaded.load();
  assert.equal(reloaded.snapshot().entries.length, 2, 'same local ID from different providers remains distinct');
  assert.equal(reloaded.snapshot().entries[0].saved, true);
  assert.equal(reloaded.snapshot().entries[0].watched, true);
  assert.deepEqual(reloaded.snapshot().entries[0].title.externalIds, { imdb: 'tt123' });
});

test('invalid and future library data is preserved rather than overwritten', async () => {
  for (const raw of ['bad json', '{"version":2,"entries":[]}']) {
    const disk = storage(raw); const library = new PlayerLibrary(disk);
    await library.update(title, { saved: true });
    assert.match(library.snapshot().error!, /Couldn’t read/);
    assert.equal(disk.value, raw); assert.equal(disk.writes, 0);
  }
});

test('failed save is visible and a subsequent action persists the full state', async () => {
  const disk = storage(); let fail = true;
  const library = new PlayerLibrary({ read: () => disk.read(), async write(v) { if (fail) throw Error('disk full'); await disk.write(v); } });
  await library.update(title, { saved: true });
  assert.match(library.snapshot().error!, /could not be saved/);
  fail = false; await library.update(title, { watched: true });
  assert.equal(library.snapshot().error, null);
  assert.equal(JSON.parse(disk.value!).entries[0].saved, true);
});

test('progress is bounded, ignores invalid samples, preserves saved/manual watched and avoids stationary writes', async () => {
  const disk = storage(); const library = new PlayerLibrary(disk);
  await library.recordProgress(title, 2, 100); assert.equal(disk.writes, 0);
  await library.recordProgress(title, NaN, 100); assert.equal(disk.writes, 0);
  await library.update(title, { saved: true, watched: true });
  await library.recordProgress(title, 20, 100);
  assert.equal(library.snapshot().entries[0].watched, true);
  assert.equal(library.snapshot().entries[0].saved, true);
  const count = disk.writes;
  await library.recordProgress(title, 20, 100); assert.equal(disk.writes, count);
  await library.update(title, { watched: false });
  await library.recordProgress(title, 96, 100); assert.equal(library.snapshot().entries[0].watched, true);
  await library.remove(title.ref); assert.equal(library.snapshot().entries.length, 0);
  const reload = new PlayerLibrary(disk); await reload.load(); assert.equal(reload.snapshot().entries.length, 0);
});

test('stored data has bounded snapshots and never retains playback URLs or credentials', () => {
  const entries = normalizeLibrary({ version: 1, entries: [{ title: { ...title, description: 'x'.repeat(5000),
    poster: 'javascript:alert(1)', token: 'secret', url: 'https://example.com/movie.mp4' },
    saved: true, watched: false, progress: { position: 500, duration: 100 }, updatedAt: 3 }] });
  assert.equal(entries[0].title.description.length, 1200);
  assert.equal(entries[0].title.poster, undefined);
  assert.equal(entries[0].progress?.position, 100);
  assert.ok(!JSON.stringify(entries).includes('secret'));
  assert.ok(!JSON.stringify(entries).includes('movie.mp4'));
});

test('metadata providers can be replaced without changing library identity or playback authority', async () => {
  const registry = new MetadataProviders();
  const provider = boxCatalogProvider({ metas: [{ id: 'one', name: 'Bunny', description: 'Short film', credit: 'Creator', license: 'CC' }] });
  registry.add(provider); registry.add({ ...provider, id: 'another-provider' });
  assert.throws(() => registry.add(provider), /Duplicate/);
  assert.equal(registry.list().length, 2);
  const signal = new AbortController().signal;
  assert.equal((await registry.get(provider.id)!.search('BUNNY', signal)).titles.length, 1);
  assert.equal((await provider.search('missing', signal)).titles.length, 0);
  assert.equal(await provider.details('missing', signal), null);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(provider.discover(controller.signal), /cancelled/);
  assert.notEqual(mediaKey({ provider: 'a:b', id: 'c' }), mediaKey({ provider: 'a', id: 'b:c' }));
});

test('full libraries retain saved titles rather than silently evicting them', async () => {
  const entries = Array.from({ length: 200 }, (_, i) => ({ title: { ...title, ref: { provider: 'sample', id: String(i) } }, saved: true, updatedAt: i }));
  const disk = storage(JSON.stringify({ version: 1, entries }));
  const library = new PlayerLibrary(disk);
  await library.update({ ...title, ref: { provider: 'sample', id: 'new' } }, { saved: true });
  assert.equal(library.snapshot().entries.length, 200);
  assert.match(library.snapshot().error!, /200 titles/);
  assert.equal(disk.writes, 0);
});
