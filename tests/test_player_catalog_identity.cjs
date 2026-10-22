// Execute the actual agent-authored read-only media state script. A last-opened
// title, unrelated page, or service trailer must not create library history.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { resolve } = require('node:path');
const { script, source, id } = JSON.parse(execFileSync('python3', ['-c', `
import importlib.util,json,sys
s=importlib.util.spec_from_file_location('cs',sys.argv[1]);c=importlib.util.module_from_spec(s);s.loader.exec_module(c)
k=next(iter(c._PLAYER_CATALOG_STREAMS))
print(json.dumps(dict(script=c.PLAYER_JS_STATE,source=c._PLAYER_CATALOG_STREAMS[k]['url'],id=k)))
`, resolve(__dirname, '../agent/couchsided.py')], { encoding: 'utf8' }));
const video = { currentSrc: source, paused: false, ended: false, error: null,
  readyState: 4, currentTime: 12, duration: 60, muted: false };
const read = videos => vm.runInNewContext(script, { document: { title: 'Private account page', querySelectorAll: () => videos } });
assert.equal(read([video]).catalog_id, id);
for (const currentSrc of ['', 'blob:private', 'https://netflix.com/trailer.mp4', source + '?different=1']) {
  assert.equal(read([{ ...video, currentSrc }]).catalog_id, null);
}
assert.equal(read([]), null);
assert.equal(read([{ ...video, paused: true }]).playing, false);
assert.equal(read([{ ...video, duration: Infinity }]).duration, 0);
assert.ok(!JSON.stringify(read([video])).includes(source), 'source URLs stay on the box');
console.log('Playback identity: exact source match, unrelated source rejection, no video, pause, live duration and URL privacy passed');
