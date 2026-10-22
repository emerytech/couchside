const { withAndroidManifest } = require('expo/config-plugins');
module.exports = config => withAndroidManifest(config, config => {
  const manifest = config.modResults.manifest;
  const permission = 'android.permission.REQUEST_INSTALL_PACKAGES';
  manifest['uses-permission'] = (manifest['uses-permission'] || []).filter(p => p.$['android:name'] !== permission);
  if (process.env.EXPO_PUBLIC_DIRECT === '1') manifest['uses-permission'].push({ $: { 'android:name': permission } });
  return config;
});
