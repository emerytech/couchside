/** Local presentation only. This never subscribes anyone or contacts a server. */
export function showNewsletterInvite(ready: boolean, configured: boolean, dismissed: boolean): boolean {
  return ready && configured && !dismissed;
}
export const NEWSLETTER_URL = 'https://couchside.tv/news/';
