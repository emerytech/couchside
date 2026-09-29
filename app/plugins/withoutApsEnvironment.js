/**
 * Strip the iOS `aps-environment` entitlement.
 *
 * expo-notifications adds `aps-environment` (the Push Notifications entitlement)
 * by default because it *can* do remote push. Couchside's wishlist alerts
 * (Phase 1b) are LOCAL notifications only — scheduled on-device, no push server,
 * no push token — and local notifications do NOT require `aps-environment`.
 *
 * Leaving it in forced the App ID / provisioning profile to carry the Push
 * Notifications capability (enabling it needs an interactive Apple sign-in),
 * which failed every non-interactive build:
 *   "profile doesn't include the Push Notifications capability / aps-environment"
 * Deleting the entitlement makes the existing profile build clean AND drops an
 * unused capability the app never exercises (one fewer App Review question).
 *
 * ORDERING IS LOAD-BEARING — this plugin MUST be registered FIRST in app.json's
 * `plugins` array. Expo composes entitlements mods so the LAST-registered mod
 * runs FIRST; registering first makes THIS mod run LAST, i.e. AFTER
 * expo-notifications has added `aps-environment`, so the delete actually sticks.
 * (Registered last, it ran before expo-notifications and stripped nothing —
 * verified via prebuild: `aps-environment present = false` vs `= true`.)
 *
 * If real remote push is ever added, remove this plugin and enable the Push
 * Notifications capability on the App ID (an interactive Apple sign-in).
 */
const { withEntitlementsPlist } = require('expo/config-plugins');

module.exports = function withoutApsEnvironment(config) {
  return withEntitlementsPlist(config, (cfg) => {
    delete cfg.modResults['aps-environment'];
    return cfg;
  });
};
