/**
 * Preview images for the App icon picker — the one file that `require`s them.
 *
 * Metro bundles images only through STATIC `require()` calls, so a build cannot
 * name a preview file in `expo.extra`; it names a preview KEY instead, and this
 * table is the allowlist that key is looked up in (unknown key -> no image -> the
 * picker falls back to plain text buttons). Kept apart from lib/appIcon.ts so the
 * pure parser stays loadable by the bare-Node test glob.
 *
 * `pro` is the direct edition's gold icon, `standard` the store icon. Both PNGs
 * live on main as plain assets (the direct build's app.config.js points its native
 * icon at the same icon-direct.png).
 */
import type { ImageSourcePropType } from 'react-native';

export const APP_ICON_PREVIEWS: Readonly<Record<string, ImageSourcePropType>> = {
  pro: require('../assets/images/icon-direct.png'),
  standard: require('../assets/images/icon.png'),
};

export function previewFor(key: string | undefined): ImageSourcePropType | undefined {
  return key && Object.prototype.hasOwnProperty.call(APP_ICON_PREVIEWS, key) ? APP_ICON_PREVIEWS[key] : undefined;
}
