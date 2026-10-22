import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

// Run the actual event handlers with React state updates deliberately queued:
// reproduces multiple native TextInput events arriving before another render.
const source = readFileSync(new URL('../../app/(tabs)/pad.tsx', import.meta.url), 'utf8');
function callback(name: string): string {
  const start = source.indexOf(`  const ${name} = useCallback(`);
  assert.ok(start >= 0, name);
  const end = source.indexOf('\n  );', start);
  const shortEnd = source.indexOf('\n  }, []);', start);
  return source.slice(start, shortEnd >= 0 && shortEnd < end ? shortEnd + 11 : end + 5);
}
function mount() {
  const delta = source.slice(source.indexOf('export function textDelta'), source.indexOf("\nif (typeof globalThis", source.indexOf('export function textDelta'))).replace('export ', '');
  let remote = '', queued = '';
  const context = vm.createContext({
    useCallback: (f: unknown) => f, valueRef: { current: '' },
    setValue: (s: string) => { queued = s; },
    onText: (s: string) => { remote += s; },
    onBackspace: () => { remote = remote.slice(0, -1); },
  });
  const code = `${delta}\n${callback('setValueSynced')}\n${callback('onChangeText')}\nglobalThis.handlers = { change: onChangeText, clear: () => setValueSynced('') };`;
  vm.runInContext(stripTypeScriptTypes(code), context);
  return { handlers: context.handlers as { change(s: string): void; clear(): void }, remote: () => remote, queued: () => queued };
}
test('rapid native events before render send each character exactly once', () => {
  const h = mount();
  for (const s of ['n', 'no', 'not', 'note', 'notep', 'notepa', 'notepad']) h.handlers.change(s);
  assert.equal(h.remote(), 'notepad'); assert.equal(h.queued(), 'notepad');
});
test('batched duplicate events, paste, replacement and deletion preserve remote text', () => {
  const h = mount();
  for (const s of ['hello', 'hello', 'hello world', 'hello World', 'hello Worl', '']) h.handlers.change(s);
  assert.equal(h.remote(), '');
  h.handlers.change('again'); assert.equal(h.remote(), 'again');
});
test('clearing the local field resets the baseline without deleting remote text', () => {
  const h = mount(); h.handlers.change('first'); h.handlers.clear(); h.handlers.change('second');
  assert.equal(h.remote(), 'firstsecond');
});
