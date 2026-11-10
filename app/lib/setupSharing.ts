/** Deliberately accepts curated choices only, never a saved Box or pairing link. */
export const SETUP_TYPES = ['Steam Machine / SteamOS', 'Windows gaming PC', 'Linux gaming PC', 'Handheld gaming PC', 'TV setup'] as const;
export const SETUP_FEATURES = ['Phone controller', 'Air Mouse', 'Touchpad & keyboard', 'Game-specific controls', 'TV remote & inputs', 'Game library', 'Decky manager'] as const;
export const COUCHSIDE_SHARE_URL = 'https://couchside.tv/';
export const FRIEND_MESSAGE = 'Your phone can be your gaming remote. Couchside gives you controller, mouse and keyboard controls for your gaming PC, plus supported TV controls. Take a look: ' + COUCHSIDE_SHARE_URL;

export function setupShareText(type: string, features: readonly string[]): string {
  if (!(SETUP_TYPES as readonly string[]).includes(type)) throw Error('Choose a setup type.');
  if (!features.length || features.some(x => !(SETUP_FEATURES as readonly string[]).includes(x))) throw Error('Choose at least one Couchside feature.');
  const selected = SETUP_FEATURES.filter(x => features.includes(x));
  return `My gaming setup, powered by Couchside\n\n${type}\nI use my phone for: ${selected.join(', ')}.\n\nOne less reason to leave the couch.\n${COUCHSIDE_SHARE_URL}`;
}

/** Opens a composer; the user still reviews, attaches any photos, and sends. */
export function showcaseDraftUrl(summary: string): string {
  const body = `${summary}\n\nI'd like to share how I use Couchside. Please contact me before publishing my setup, photos or name.\n\nWhat works well for me:\n[Add your story here]\n\nOptional: attach a photo after checking it for personal details. Sending this email does not subscribe me to marketing.`;
  return `mailto:taylor@couchside.tv?subject=${encodeURIComponent('My Couchside gaming setup')}&body=${encodeURIComponent(body)}`;
}
