import {strict as assert} from 'node:assert';
import {APPEARANCE_PACKS,parseAppearancePack,importAppearance} from '../appearancePacks.ts';
for(const p of APPEARANCE_PACKS) assert.deepEqual(parseAppearancePack(p),p);
const good=importAppearance(':root { --c-accent: #88ccaa; --g-library: linear-gradient(135deg, #112233, #445566); --c-osk: #123456; }','Test');
assert.equal(good.accepted.length,2);assert.deepEqual(good.skipped,['--c-osk']);
assert.equal(good.pack.backgrounds.library?.angle,135);
for(const css of ['@import "x"; --c-accent:#ffffff;','--c-accent:url(x);','--c-accent:var(--secret);','--c-accent:#fff;','x'.repeat(32769)])assert.throws(()=>importAppearance(css,'bad'));
for(const patch of [{version:true},{name:'bad\nname'},{url:'https://example.com'},{colors:{...good.pack.colors,accent:'url(x)'}},{backgrounds:{home:{angle:999,stops:['#112233','#445566']}}}])assert.throws(()=>parseAppearancePack({...good.pack,...patch}));
assert.equal(APPEARANCE_PACKS[0].name,'Ocean');
// iOS smart punctuation must not silently turn an intended color into a default.
for(const dash of ['\u2013','\u2014']){
 assert.throws(()=>importAppearance(`:root { ${dash}c-bg: #081d2c; }`,'Typed'),/Smart punctuation/);
 assert.throws(()=>importAppearance(`--c-accent:#ffffff; ${dash}g-library:linear-gradient(90deg,#112233,#445566);`,'Mixed'),/Smart punctuation/);
}
const literal=importAppearance(':root { --c-bg: #081d2c; --c-card: #163448; --c-text: #f0fbff; --c-text-2: #adcadb; --c-accent: #66d9e8; --c-ring-a: #b3f4ff; --g-art-default: linear-gradient(135deg, #081d2c, #164758); --g-library: linear-gradient(90deg, #163448, #081d2c); --g-settings: linear-gradient(180deg, #164758, #081d2c); --unsupported-test: #123456; }','Harbor iPhone');
assert.equal(literal.accepted.length,9);assert.deepEqual(literal.skipped,['--unsupported-test']);
assert.equal(literal.pack.colors.background,'#081d2c');assert.equal(literal.pack.backgrounds.library?.angle,90);
console.log('PASS appearance validation and conservative PC5 token import');
