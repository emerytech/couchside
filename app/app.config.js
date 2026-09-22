// Dynamic Expo config.
//
// STORE builds get app.json VERBATIM — when EXPO_PUBLIC_DIRECT is unset, `config`
// (already parsed from app.json by Expo) is returned untouched, so the App Store /
// Play listing is byte-for-byte unaffected by this file.
//
// The DIRECT (off-store) edition (EXPO_PUBLIC_DIRECT=1, EAS `direct` profile) is a
// SEPARATE APP: distinct applicationId / bundle id / display name / versionCode. A
// sideloaded APK that shared the store package could not be installed alongside the
// store app, would fight it on updates, and (signed with a different key) could not
// update over it — exactly the "don't mess up the store listing" risk. Giving it
// its own identity keeps the two completely independent.
module.exports = ({ config }) => {
  // Web design-review demo (EXPO_PUBLIC_DEMO=1): served under /couchside/app/ on
  // couchside.tv, so its assets need that subpath baseUrl. Build-branch only,
  // like everything in this file; store/direct builds never set the flag.
  if (process.env.EXPO_PUBLIC_DEMO === '1') {
    config.experiments = { ...(config.experiments || {}), baseUrl: '/couchside/app' };
  }

  if (process.env.EXPO_PUBLIC_DIRECT !== '1') return config;

  config.name = 'Couchside Direct';
  config.android = {
    ...config.android,
    package: `${config.android.package}.direct`,
    // A separate package has its own versionCode line — keep it OFF the store
    // app's sequence. The `direct` EAS profile sets autoIncrement:false, so this
    // fixed value is authoritative; bump it by hand when cutting a new direct APK
    // (Android refuses to install over an equal-or-lower versionCode).
    versionCode: 1,
  };
  if (config.ios) {
    config.ios = {
      ...config.ios,
      bundleIdentifier: `${config.ios.bundleIdentifier}.direct`,
    };
  }
  return config;
};
