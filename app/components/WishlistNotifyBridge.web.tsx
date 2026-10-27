/**
 * Web stub for the wishlist notify bridge. The native component imports
 * expo-notifications (whose web build logs a harmless push-token warning and has
 * no useful web runtime); Metro resolves THIS on web so nothing notification-
 * related loads in the harness. The bridge is native-only anyway (see
 * app/_layout.tsx), so this renders nothing.
 */
export function WishlistNotifyBridge() {
  return null;
}
