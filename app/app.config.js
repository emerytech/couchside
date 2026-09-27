// Dynamic Expo config — PROTOTYPE build branch only.
//
// STORE builds get app.json VERBATIM: when EXPO_PUBLIC_PROTOTYPE is unset, `config`
// (already parsed from app.json by Expo) is returned untouched, so nothing here can
// affect a normal build. This file lives ONLY on build/prototype-apk (never main),
// exactly like app.config.js on build/direct-apk — variant identity stays off the
// store config.
//
// The PROTOTYPE edition (EXPO_PUBLIC_PROTOTYPE=1, EAS `prototype` profile / the local
// build box) is a SEPARATE APP so it can sit next to the store app AND the .direct
// edition on the same phone for side-by-side testing of the new look: distinct
// applicationId / bundle id (`.prototype`), its own versionCode sequence, and a
// "Couchside Proto" launcher label so it is never mistaken for the real one. The same
// single flag drives IS_PROTOTYPE_BUILD in the JS bundle (app/lib/entitlement.ts), so
// the unfinished Reserve doorway and the prototype identity can never disagree.
module.exports = ({ config }) => {
  if (process.env.EXPO_PUBLIC_PROTOTYPE !== '1') return config;

  config.name = 'Couchside Proto';

  config.ios = {
    ...config.ios,
    bundleIdentifier: `${config.ios.bundleIdentifier}.prototype`,
  };

  config.android = {
    ...config.android,
    package: `${config.android.package}.prototype`,
    // Own versionCode line, independent of the store app (Android compares only
    // within a package). Bump by hand per prototype APK so `adb install -r` over the
    // previously-installed prototype is never refused as a downgrade.
    versionCode: 115,
  };

  return config;
};
