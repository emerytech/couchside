/**
 * Open a game in the user's Steam app via a deep link, falling back to the web
 * store when the Steam app / URL handler isn't available.
 *
 * This leaves the PHONE (it opens Steam, or a browser); it never touches the box.
 * Shared by the Not-installed page (installable.tsx) and the installed-game sheet
 * (GameSheet.tsx) so both behave identically.
 */
import { Linking, Platform } from 'react-native';

export async function openInSteamStore(appid: number): Promise<void> {
  const deep = `steam://store/${appid}`;
  const web = `https://store.steampowered.com/app/${appid}`;
  try {
    if (Platform.OS !== 'web' && (await Linking.canOpenURL(deep))) {
      await Linking.openURL(deep);
      return;
    }
  } catch {
    /* fall through to web */
  }
  try {
    await Linking.openURL(web);
  } catch {
    /* nothing else to do */
  }
}
