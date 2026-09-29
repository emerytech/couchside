/**
 * Strip the iOS `aps-environment` entitlement.
 *
 * expo-notifications adds `aps-environment` (the Push Notifications entitlement)
 * by default, because it *can* do remote push. Couchside's wishlist alerts
 * (Phase 1b) are LOCAL notifications only — scheduled on-device, no push server,
 * no push token — and local notifications do NOT require `aps-environment`.
 *
 * Leaving it in forces the App ID / provisioning profile to carry the Push
 * Notifications capability, which broke the build ("profile doesn't include the
 * Push Notifications capability / aps-environment entitlement") and would make
 * the app declare a push capability it never uses (an avoidable App Review
 * question). This plugin runs LAST (registered after expo-notifications in
 * app.json) and deletes the entitlement expo-notifications injected.
 *
 * If real remote push is ever added, remove this plugin and enable the Push
 * Notifications capability on the App ID (needs an interactive Apple sign-in).
 */
const { withEntitlementsPlist } = require('expo/config-plugins');

module.exports = function withoutApsEnvironment(config) {
  return withEntitlementsPlist(config, (cfg) => {
    delete cfg.modResults['aps-environment'];
    return cfg;
  });
};
