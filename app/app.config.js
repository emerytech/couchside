// Dynamic Expo config.
//
// STORE builds get app.json VERBATIM — when EXPO_PUBLIC_DIRECT is unset, `config`
// (already parsed from app.json by Expo) is returned untouched, so the App Store /
// Play listing is byte-for-byte unaffected by this file.
//
// The DIRECT (off-store) edition (EXPO_PUBLIC_DIRECT=1, EAS `direct` profile) is a
// SEPARATE APP: distinct applicationId / bundle id / versionCode. A sideloaded APK
// that shared the store package could not be installed alongside the store app,
// would fight it on updates, and (signed with a different key) could not update over
// it — exactly the "don't mess up the store listing" risk. Giving it its own
// package identity keeps the two completely independent.
//
// The launcher NAME matches the store app ("Couchside", no "Direct" suffix), but the
// direct edition ships a DISTINCT premium "Pro" icon (shiny gold, black couch, black
// frame) as a perk for buyers — assets/images/icon-direct.png (iOS/legacy) plus a
// gold adaptive background + framed black-couch foreground on Android. So the home
// screen reads "Couchside" with a gold icon; only the package id is truly separate.
module.exports = ({ config }) => {
  // Web design-review demo (EXPO_PUBLIC_DEMO=1): served under /couchside/app/ on
  // couchside.tv, so its assets need that subpath baseUrl. Build-branch only,
  // like everything in this file; store/direct builds never set the flag.
  if (process.env.EXPO_PUBLIC_DEMO === '1') {
    config.experiments = { ...(config.experiments || {}), baseUrl: '/couchside/app' };
  }

  if (process.env.EXPO_PUBLIC_DIRECT !== '1') return config;

  // Keep the launcher label identical to the store app (no "Direct" suffix): the
  // home-screen icon + name should look exactly like the Play/App Store version.
  config.name = 'Couchside';

  // Premium "Pro" icon for the direct edition (see header note). iOS/legacy use the
  // composed square; Android uses a gold adaptive BACKGROUND + a framed black-couch
  // FOREGROUND so the frame sits inside the mask safe zone (a full-bleed border would
  // be cropped by the launcher mask). Monochrome (themed-icon) stays the base couch.
  config.icon = './assets/images/icon-direct.png';
  config.android = {
    ...config.android,
    package: `${config.android.package}.direct`,
    // A separate package has its own versionCode line — keep it OFF the store
    // app's sequence. The `direct` EAS profile sets autoIncrement:false, so this
    // fixed value is authoritative; bump it by hand when cutting a new direct APK
    // (Android refuses to install over an equal-or-lower versionCode).
    versionCode: 2,
    adaptiveIcon: {
      ...(config.android.adaptiveIcon || {}),
      foregroundImage: './assets/images/android-icon-direct-foreground.png',
      backgroundImage: './assets/images/android-icon-direct-background.png',
    },
  };
  if (config.ios) {
    config.ios = {
      ...config.ios,
      bundleIdentifier: `${config.ios.bundleIdentifier}.direct`,
    };
  }
  return config;
};
