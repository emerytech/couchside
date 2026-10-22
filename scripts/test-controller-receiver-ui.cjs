#!/usr/bin/env node
// Render the actual native component with fixture polling and HTML view shims.
// This checks UI semantics without a phone/app build or network access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const appRequire = createRequire(path.join(root, 'app/package.json'));
const React = appRequire('react');
const { renderToStaticMarkup } = appRequire('react-dom/server');
const ts = appRequire('typescript');
let state;
let error = null;
function view(tag) {
  return ({ children, testID, disabled }) => React.createElement(tag,
    { 'data-testid': testID, ...(tag === 'button' ? { disabled } : {}) }, children);
}
const source = fs.readFileSync(path.join(root, 'app/components/ControllerReceiversPanel.tsx'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022,
}}).outputText;
const stubs = {
  'react-native': { View: view('div'), Text: view('span'), Pressable: view('button'),
    StyleSheet: { create: x => x } },
  '@/hooks/usePoll': { usePoll: () => ({ data: state, error, dataKey: 'fixture', refresh() {} }) },
  '@/lib/api': { api: {}, hostKey: () => 'fixture' },
  '@/lib/SettingsContext': { useSettings: () => ({ ready: true, settings: { host: 'fixture' } }) },
  '@/lib/theme': { useTheme: () => ({ text: '#fff', textFaint: '#aaa', green: '#0f0', blue: '#00f' }) },
};
const loaded = { exports: {} };
new Function('require', 'module', 'exports', compiled)(name => stubs[name] ?? appRequire(name), loaded, loaded.exports);
const render = () => renderToStaticMarkup(React.createElement(loaded.exports.ControllerReceiversPanel));
const receiver = { id: 'usb-1-3', kind: 'steam_machine', label: 'Steam Machine controller receiver',
  status: 'detected', flashable: false, usb_id: '28de:1305' };
state = { supported: true, scan_status: 'ok', pairing_available: true, receivers: [receiver] };
let html = render();
assert(html.includes(receiver.label));
assert(html.includes('Pair / manage in Steam'));
assert(html.includes('does not confirm a controller is paired'));
assert(!html.includes('Flash') && !html.includes('firmware'));
assert(!html.includes('disabled=""'));
console.log('PASS internal receiver renders detection and Steam handoff, never flashing or paired success');
state = { ...state, receivers: [{ ...receiver, label: 'External controller receiver', kind: 'external_puck' }] };
assert(render().includes('External controller receiver'));
state = { ...state, pairing_available: false };
assert(render().includes('disabled=""'));
assert(render().includes('Steam must be available'));
error = new Error('offline');
html = render();
assert(html.includes('status is unavailable') && html.includes('disabled=""'));
assert(!html.includes('>Detected<'));
error = null;
state = { ...state, receivers: [] };
html = render();
assert(html.includes('No supported receiver detected') && !html.includes('data-testid="controller-receivers-pair"'));
state = null;
assert.equal(render(), '');
state = { supported: false };
assert.equal(render(), '');
console.log('PASS external, Steam unavailable, offline, empty and older/unsupported agent states');
