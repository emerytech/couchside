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
    versionCode: 12,
    adaptiveIcon: {
      ...(config.android.adaptiveIcon || {}),
      foregroundImage: './assets/images/android-icon-direct-foreground.png',
      backgroundImage: './assets/images/android-icon-direct-background.png',
    },
  };

  // USER-SELECTABLE HOME-SCREEN ICON (roadmap 2026-09-26; PR #569 carries the app code).
  // ONE source list feeds BOTH the prebuild plugin (which generates `.MainActivity<Name>`
  // aliases + adaptive-icon resources) and `extra.appIcons` (what the app renders), so the
  // two can never disagree on a name. The DEFAULT launcher icon stays the gold Pro set above
  // (plain MainActivity, alias null). Names are PascalCase (the plugin PascalCases them).
  //
  // RULES FOR EVERY FUTURE DIRECT BUILD (review finding 2026-09-26): this plugin entry and every
  // alias name ever shipped are PERMANENT — append-only, never renamed or removed. A user who
  // picked an alias has MainActivity DISABLED in PackageManager (persisted across updates); a
  // build without that alias would leave them with NO launcher icon and no way in.
  // The release recipe checks the new APK's alias set is a superset of the shipped one.
  const APP_ICONS = [
    {
      alias: 'Standard',
      label: 'Standard',
      preview: 'standard',
      ios: './assets/images/icon.png',
      android: {
        foregroundImage: './assets/images/android-icon-foreground.png',
        backgroundImage: './assets/images/android-icon-background.png',
        monochromeImage: './assets/images/android-icon-monochrome.png',
      },
    },
  ];
  config.plugins = [
    ...(config.plugins || []),
    ['expo-alternate-app-icons', APP_ICONS.map(({ alias, ios, android }) => ({ name: alias, ios, android }))],
  ];
  config.extra = {
    ...(config.extra || {}),
    // The DEFAULT entry OMITS `alias` (lib/appIcon.ts treats a missing alias as the default).
    // Never write `alias: null` here: the release build's embedded config (assets/app.config,
    // generated at gradle time) serialized null as {} on the vc5 test build (2026-09-26), the
    // parser rightly refused {}, and the App icon row silently did not render on the device.
    appIcons: [{ label: 'Pro', preview: 'pro' }, ...APP_ICONS.map(({ alias, label, preview }) => ({ alias, label, preview }))],
  };
  // The couchside:// deep-link filter lives on MainActivity by default. When an alias is the
  // enabled launcher, MainActivity is DISABLED and stops resolving intents — so declare the
  // scheme filter explicitly here: the plugin copies `android.intentFilters` onto every alias,
  // and pairing links keep working whichever icon is active (review finding 2026-09-26).
  config.android.intentFilters = [
    ...(config.android.intentFilters || []),
    {
      action: 'VIEW',
      category: ['DEFAULT', 'BROWSABLE'],
      data: [{ scheme: 'couchside' }],
    },
  ];
  if (config.ios) {
    config.ios = {
      ...config.ios,
      bundleIdentifier: `${config.ios.bundleIdentifier}.direct`,
    };
  }
  return config;
};
