import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redirectLicenseLink, getLicenseActivation, resetLicenseActivation, clearLicenseActivation, subscribeLicenseActivation } from '../licenseActivation.ts';
const key = 'CS1.' + Buffer.from('{"name":"Test"}').toString('base64url') + '.' + 'A'.repeat(86);
const link = 'couchside:///setup?license=' + key;
test('cold and repeated warm links stage a key and return only nonsensitive route params', () => {
 resetLicenseActivation();
 let updates=0; const stop=subscribeLicenseActivation(()=>updates++);
 const first=redirectLicenseLink(link,true); const a=getLicenseActivation()!;
 assert.equal(a.key,key); assert.match(first,/^\/setup\?tab=account&activation=\d+$/); assert.ok(!first.includes(key));
 const second=redirectLicenseLink(link,true); const b=getLicenseActivation()!;
 assert.notEqual(first,second); assert.ok(b.id>a.id); assert.equal(updates,2);
 clearLicenseActivation(a.id); assert.equal(getLicenseActivation()?.key,key);
 clearLicenseActivation(b.id); assert.equal(getLicenseActivation()?.key,'');
 resetLicenseActivation();assert.equal(getLicenseActivation(),null);stop();
});
test('invalid, ambiguous, oversized, and foreign links never prefill or expose a key', () => {
 for(const url of [link+'&license='+key,link.replace('couchside:','https:'),link.replace('/setup','/other'),link.replace('///','//evil/'),link+'#fragment','couchside:///setup?license=nope','couchside:///setup?license=CS1.'+'A'.repeat(8200)+'.'+'A'.repeat(86)]){
  redirectLicenseLink(link,true);
  const result=redirectLicenseLink(url,true);
  assert.equal(getLicenseActivation(),null); assert.equal(result,'/setup?tab=account'); assert.ok(!result.includes(key));
 }
});
test('store builds never stage licenses; existing pairing/ordinary links remain unchanged',()=>{
 resetLicenseActivation(); assert.equal(redirectLicenseLink(link,false),'/setup'); assert.equal(getLicenseActivation(),null);
 for(const path of ['couchside://setup?host=192.168.1.2&token=pair','couchside:///setup?tab=account','/remote'])assert.equal(redirectLicenseLink(path,true),path);
 assert.doesNotThrow(()=>redirectLicenseLink('http://[broken',true));
});
