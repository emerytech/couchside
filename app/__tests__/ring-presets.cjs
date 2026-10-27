const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const source = fs.readFileSync(require('node:path').join(__dirname, '../lib/ledPresets.ts'), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
let stored = null;
function load() {
  const exports = {};
  vm.runInNewContext(code, { exports, console, setTimeout,
    require: name => name === 'react' ? { useSyncExternalStore() {} }
      : name === 'react-native' ? { Platform: { OS: 'ios' } }
      : { getItemAsync: async () => stored, setItemAsync: async (_, value) => { stored = value; } },
  });
  return exports;
}
(async () => {
  const a = load(); await new Promise(r => setImmediate(r));
  const program = { scene: 'ocean', brightness: 40, period: 20,
    night: { enabled: true, start: 1320, end: 420, brightness: 5 } };
  const saved = await a.addPreset({ label: 'Ocean night', effect: 'solid', color: null,
    speed: 50, brightness: 40, ringProgram: program });
  const b = load(); await new Promise(r => setImmediate(r));
  assert.deepEqual(JSON.parse(JSON.stringify(b.getPresets().find(p => p.id === saved.id).ringProgram)), program);
  assert.equal(b.normalizeRingProgram({ ...program, period: Infinity }), undefined);
  assert.equal(b.normalizeRingProgram({ ...program, night: { ...program.night, end: 1320 } }), undefined);
  await b.removePreset(saved.id);
  assert.ok(!JSON.parse(stored).some(p => p.id === saved.id));
  console.log('Scene favorite save, reload, validation and removal passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
