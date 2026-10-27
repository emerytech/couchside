const assert = require('node:assert/strict');
const plugin = require('../plugins/withDirectUpdater');
(async () => {
  const original = process.env.EXPO_PUBLIC_DIRECT;
  try {
    for (const direct of ['0', '1']) {
      process.env.EXPO_PUBLIC_DIRECT = direct;
      const config = plugin({});
      const result = await config.mods.android.manifest({
        modResults: { manifest: { 'uses-permission': [
          { $: { 'android:name': 'android.permission.INTERNET' } },
          { $: { 'android:name': 'android.permission.REQUEST_INSTALL_PACKAGES' } },
        ] } }, modRequest: { nextMod: async value => value },
      });
      const permissions = result.modResults.manifest['uses-permission'].map(p => p.$['android:name']);
      assert(permissions.includes('android.permission.INTERNET'));
      assert.equal(permissions.filter(p => p === 'android.permission.REQUEST_INSTALL_PACKAGES').length, direct === '1' ? 1 : 0);
    }
    console.log('Direct-only install permission checks passed');
  } finally {
    if (original === undefined) delete process.env.EXPO_PUBLIC_DIRECT;
    else process.env.EXPO_PUBLIC_DIRECT = original;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
