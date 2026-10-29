import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

// Run the actual event handlers with React state updates deliberately queued:
// reproduces multiple native TextInput events arriving before another render.
const source = readFileSync(new URL('../../app/(tabs)/pad.tsx', import.meta.url), 'utf8');
const desktop = readFileSync(new URL('../../components/DesktopKeyboard.tsx', import.meta.url), 'utf8');
function callback(name: string, text = source): string {
  const start = text.indexOf(`  const ${name} = useCallback(`);
  assert.ok(start >= 0, name);
  const tail = text.slice(start);
  const end = /\n  (?:}, \[[^\n]*\]\);|\);)/.exec(tail);
  assert.ok(end, name);
  return tail.slice(0, end.index + end[0].length);
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

for (const [name, text] of [['Pad', source], ['Desktop', desktop]]) {
  test(`${name}: native keypress plus submit sends Return exactly once`, () => {
    let enters = 0, backspaces = 0;
    const context = vm.createContext({
      useCallback: (f: unknown) => f, valueRef: { current: '' },
      onBackspace: () => { backspaces++; }, onEnter: () => { enters++; },
      client: { sendKey: (key: string) => {
        if (key === 'enter') enters++; else if (key === 'backspace') backspaces++;
      } },
    });
    const submit = /onSubmitEditing={([^\n]+)}/.exec(text);
    assert.ok(submit);
    vm.runInContext(stripTypeScriptTypes(`${callback('onKeyPress', text)}
      globalThis.press = onKeyPress; globalThis.submit = (${submit[1]});`), context);
    context.press({ nativeEvent: { key: 'Enter' } });
    context.submit();
    assert.equal(enters, 1);
    context.press({ nativeEvent: { key: 'Backspace' } });
    assert.equal(backspaces, 1);
    context.valueRef.current = 'x';
    context.press({ nativeEvent: { key: 'Backspace' } });
    assert.equal(backspaces, 1, 'nonempty deletion belongs to the text diff');
  });
}

test('Desktop: batched text changes and clear use the latest baseline before render', () => {
  let remote = '';
  const context = vm.createContext({
    useCallback: (f: unknown) => f, valueRef: { current: '' }, setValue: () => {},
    client: {
      sendText: (s: string) => { remote += s; },
      sendKey: (k: string) => { if (k === 'backspace') remote = remote.slice(0, -1); },
    },
  });
  const delta = source.slice(source.indexOf('export function textDelta'), source.indexOf("\nif (typeof globalThis", source.indexOf('export function textDelta'))).replace('export ', '');
  vm.runInContext(stripTypeScriptTypes(`${delta}
    ${callback('setValueSynced', desktop)}
    ${callback('onChangeText', desktop)}
    globalThis.change = onChangeText; globalThis.clear = () => setValueSynced('');`), context);
  for (const next of ['r', 'ra', 'rap', 'rapid', 'rapid', 'rapi', 'rapid paste']) context.change(next);
  assert.equal(remote, 'rapid paste');
  context.clear(); context.change('new');
  assert.equal(remote, 'rapid pastenew', 'local clear does not delete remote text');
});
