# Couchside Player backup checkpoint

This development backup is not a production release. It combines the reviewed
Player navigation work, discovery/personal library, and the receiver controls
from the separate Player session. It preserves the already-integrated optional
Themes/Theme Studio and lighting features from the 2.9.78 release base.

## Included work

- Warm Player Home and fixed service-home switching, with fallback to the
  existing launch path. CDP stays local; arbitrary client scripts are not accepted.
- Explicit Browse/Playback controls, visible focus, browser Back behavior,
  favorites, app-strip arrows, and screensaver activity signaling.
- Provider-neutral discovery with a licensed sample catalog, cancellable search,
  detail cards, saved titles, watched state, and local library persistence.
- Progress requires exact media identity from the matching agent. No inferred
  Netflix/Prime history, automatic resume, metadata account, or paid API enabled.
- Controller receiver detection and authenticated Steam-settings handoff, kept
  separate from firmware flashing. USB presence is not proof of a controller bond.

## Test builds and evidence

Version 2.9.78: iOS267 is available to internal TestFlight testers; Direct43 is a
locally signed test APK, not a public download replacement. Both include receiver
controls and discovery. Existing Direct signing identity, license public key,
launcher/deep-link configuration, source-map pairing, and all four local Android
native modules were checked. iOS multicast signing and native encrypted-upload
module were verified. App tests:789 passed; TypeScript and receiver fixtures
passed. These checks do not replace physical-device acceptance of the new UI.

The matching preview agent for receiver endpoints and identified library progress
was not deployed as part of those phone builds. Automatic resume, season/episode
browsing, a real movie/TV metadata source, and provider selection remain pending.
See PLAYER_DISCOVERY.md for the extension contract and storage details.

## Netflix device repair

A Steam-machine M7702-1003 failure was diagnosed as Widevine initialization
failure and a stale downloaded-component path. Backing up the profile component,
updating Chrome through its official Flatpak installation, and restarting again
to load the corrected bundled component resolved it. Full encrypted Netflix
playback, advancing frames/time for another minute, pause and resume passed.
No browser security protection was disabled and login data was preserved.
This was a device repair, not an automatic fix in Couchside source.

## Backup boundaries

This branch backs up source, tests and public development notes. It contains no
new signing keys, credentials, private logs, local Claude instructions, account
data, or device-profile backups. Claude files previously tracked on public main
are removed from this branch's current snapshot but remain in existing history.
This does not purge information already published on GitHub.

Build artifacts, private handoff notes, signing credentials and device data need
a separate encrypted off-machine backup to provide full disaster recovery.
