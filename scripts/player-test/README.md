# Couchside Player Test — approval required before deployment

This temporary package controls one fixed Big Buck Bunny trailer. It never
starts the full Couchside agent or reads its token/configuration. No root,
installer, systemd unit, Decky component, permanent Flatpak override, update,
reboot or application build is included.

## Package contents and state

- `Couchside Player Test`: add this wrapper as a separate non-Steam shortcut.
- `player_test.py`: Player-only HTTP server and owned-browser lifecycle.
- `couchsided.py`: imported for the fixed catalog and CDP transport constants;
  its `main()` is never called. No production agent file is replaced.
- `remote.html`: optional temporary phone web remote. The installed iPhone app can use a separate manual test-box connection (see below); no app build is included.
- `tv.html`: fixed-source, loopback-only TV video surface. It fills the browser
  viewport with aspect-preserving video; letterboxes instead of cropping/stretching.
- `SHA256SUMS`: package file integrity inventory, not a release signature.

Everything created by the test stays under this extracted package's `state/`:
a freshly generated `test-token` (0600), run lock, browser log, and per-launch
browser profiles. The folder is 0700. Tokens never appear in URLs, command
arguments, HTML or access logs. Closing/restarting the server rotates the token.
Do not share or commit the state directory. Browser profiles can accumulate;
delete them with the package after ending the test.

Only installed Chrome/Chromium is used. Flatpak Chrome gets a per-launch grant
for its fresh profile directory; its token is outside that grant. Flatpak is
started with `--die-with-parent`, and explicit cleanup uses only the numeric
instance ID received directly from that launch. No app-wide browser kill.
All browser launches and cleanup run on one persistent owner worker. They do
not run on short-lived HTTP request threads: Linux parent-death signaling can
end a sandbox when its creating thread exits, even if the server stays alive.
The owner is released only after the browser is stopped during server shutdown.
Native Chrome cleanup signals only the Popen-owned child. If ownership cannot
be established, launch fails; it does not search for or kill another browser.

## Before an approved deployment

1. Confirm a quiet test window. Video will take TV focus temporarily.
2. Read-only baseline: record service status and checksums of the installed
   Themes companion/agent, theme settings, and Steam shortcut inventory. Keep
   baseline/settings/logs private. Capture Crossbar and Horizon screenshots.
3. Check port 8791 is unused, the browser is installed, and Flatpak supports
   `--instance-id-fd`, `--die-with-parent`. Do not install/upgrade dependencies
   or change firewall rules without separate approval. Stop if any check fails.
4. Verify this archive and its inventory. Review the changed source; manifests
   establish byte identity, not trust or a release signature.

## Deployment after explicit owner approval only

1. Copy the archive to a **new** owner-approved directory under the desktop
   user's home. Extract without sudo. Never overlay any existing directory.
2. In Steam's UI add the extracted `Couchside Player Test` wrapper as a separate
   non-Steam shortcut with the same name. Do not auto-edit shortcuts.vdf or reuse
   the production Player shortcut. Record the new shortcut identity for removal.
3. Launch that shortcut in Game Mode. It listens on port 8791 for this test only.
   A foreground terminal run outside Steam does not validate gamescope focus.
4. Privately read `state/test-token` and enter it into the temporary phone remote
   at `http://<Steam-machine-LAN-IP>:8791/`. The token stays in that page's memory,
   not localStorage. This test HTTP connection is **unencrypted**: use only a
   trusted private LAN during the approved window, never port-forward it. The
   token grants only the fixed test operations; it is not the production token.
   Server defaults to loopback when run directly; the reviewed Steam wrapper
   explicitly exposes the test remote on the LAN. No CORS is added.
5. Play the trailer. Verify that video fills the TV with correct proportions
   (only aspect-ratio letterboxing is expected), then actual audio, pause/resume, ±10-second seek,
   mute/unmute and Stop. Test a second launch. Verify any unrelated browser
   window survives stopping the test. Record screenshots and observed results.
6. Stop video, then exit this test shortcut via Steam. Return to Themes, verify
   Crossbar/Horizon navigation/appearance and compare protected file checksums,
   settings and service status against the baseline.

The public root page contains no token. All API routes except the credential-free `/api/ping` require the
separate test bearer token. Authenticated GETs expose `/api/player`, the minimal
`/api/status` compatibility envelope, and an empty `/api/launchers` list. Only
POST `/api/player` accepts commands; `/tv` serves the
fixed public sample to the loopback browser only (also checks Host). It contains
no token or user-supplied URL. There is no power, gamepad,
keyboard, settings, shell, URL entry, production pairing, discovery or installer.
The HTTP server caps workers and body sizes, sets timeouts, and exposes no
client-addressable filesystem paths. Port binding failure never falls back to
a production port. Only one server may run from each package directory.

## Rollback / end of test

1. Stop video through the test remote. Exit **only this test shortcut** via Steam
   so Steam terminates its wrapper; SIGTERM/SIGINT cleanup ends its own browser.
2. Check port 8791 has closed and its test browser/Flatpak instance has exited.
   If cleanup is inconclusive, inspect this package's session before proceeding;
   do not kill Chrome by application name or use production service restarts.
3. Remove only the recorded `Couchside Player Test` shortcut through Steam's UI.
   Never restore an entire shortcuts.vdf over a running Steam session.
4. Delete only the extracted test directory, including its private state, after
   saving any desired private test evidence. Keep the original archive locally.
5. Confirm Themes services/settings/checksums and Crossbar/Horizon UI still match.
   Steam's shortcut entry is the only intended persistent change outside the
   extracted package; Steam/browser OS caches may also be generated normally.

No automatic destructive rollback script is provided. A rollback must never
restore old production files over newer Themes work or alter unrelated shortcuts.

## Local validation and limits

`python3 player_test.py --headless --port 0` starts an ephemeral loopback test
using an installed native Chrome/Chromium. Without `--headless`, normal browser
rendering is used. On Steam the wrapper uses port 8791. Browser debug ports are
ephemeral and bound to loopback; the phone never receives them.

Private browser logs now include the backend, owner-thread name, debug-port
readiness, stop requests and observed exit codes; they include no test token.

The revision fixes a reproduced Linux thread-lifetime defect matching the first
failed Steam trial. Local Linux regression tests use real parent-death signals:
the request-thread control dies after the response, while persistent ownership
survives and still supports explicit Stop. The software-decoding package subsequently passed an approved hardware retest.
This native-app compatibility revision still requires its own approval and a fresh baseline.

Local tests cover API denials and process ownership. A real local browser check
covers the isolated server/remote and controls. Flatpak instance handling is
fixture-tested; actual Flatpak Chrome, Steam/gamescope, TV audio, a physical
phone and coexistence with the installed Themes companion still require the
approved machine test. The package is experimental, not a release installer.

## TV sizing revision

Chrome's built-in MP4 viewer kept the raw trailer small despite a fullscreen
browser window. The test browser now opens a fixed local `/tv` page. The video
element covers the viewport, uses `object-fit: contain`, and has no default body
margin or scrollbars. The server supplies the same single allowlisted media URL;
no URL input is added. The remote controls still operate on the video over CDP.
No fullscreen-permission prompt, CSS injection into another site or production
browser-profile change is needed.

Local package acceptance measures the decoded video element in real Chrome at
1280×720, 1024×768, 2560×1080 and 3840×2160, checks aspect-preserving fit, captures
16:9/ultrawide screenshots, reloads the surface, then repeats cleanup/reopen tests.
Actual Steam/TV presentation still requires a newly approved hardware retest.

## Software-decoder diagnostic revision

The saved hardware failure included buffered media plus media error code 3 /
PIPELINE_ERROR_DECODE. It did not identify the exact GPU/driver/codec cause.
This revision requests `--disable-accelerated-video-decode` only for the owned
test browser, retaining GPU compositing and all existing cleanup/isolation.
It is a targeted software-decoder mitigation for this fixed sample; it changes
no system/browser settings or Themes component. Software decode can cost more
CPU and is not a production policy for DRM, HDR or high-resolution streaming.

The isolated state now reports media errors, readiness/seeking and decoded-frame
counts. Error state cannot report playing. The phone remote and TV surface show
an explicit failure message rather than a frozen picture labeled as playing.

Local acceptance requires clock AND decoded-frame advancement initially, after
seeking and after reopening, then completion of the reopened clip. It also
replays a synthetic code-3 state to verify failure reporting; this is not a
claim to reproduce the machine's actual decoder fault locally. Local Chrome
media diagnostics identify FFmpegVideoDecoder with platform decoding false.
The Steam-machine decoder path remains unverified until a newly approved retest.

Chromium's test flag reference:
https://chromium.googlesource.com/chromium/src/+/master/content/test/gpu/gpu_tests/common_browser_args.py


## Existing iPhone app compatibility revision — review before deployment

No new iPhone binary, TestFlight upload, app update, or production Themes change.
The earlier software-decoding package passed fullscreen motion and sample-clip
completion on Steam. This revision changes only the isolated HTTP contract.

### Connection in the already-installed app (after deployment approval)

1. Launch the separately installed **Couchside Player Test** Steam shortcut.
   Privately read this package's `state/test-token`; do not use the Themes token.
2. In the iPhone app's Setup, expand the manual host/port/token add-box form.
   **Add a new box**, named **Player Test**, host `10.1.1.209`, port **8791**,
   and that temporary test token. Leave the existing Themes box untouched.
   Do not edit its connection, token, TLS settings, or remove it. Manual add
   distinguishes the same host on different ports. There is no LAN discovery,
   PIN pairing or QR page for this isolated server.
3. Use **Test connection**: ping and authenticated status should both pass.
   Save the new entry. A status refresh reports Player support; allow the
   capability poll to run before opening **Launch → Watch**. If the Watch
   preference is off, enable the app's existing experimental Watch option;
   this is a phone UI preference, not a machine theme change.
4. Tap **Sample** in Services. It plays only the fixed Big Buck Bunny trailer.
   This existing Services path avoids requiring the prototype's newer catalog
   UI in the installed app. A newer app may also show the one-item catalog.
5. Use the **video transport buttons** for play/pause, ±10-second seek,
   mute/unmute, and Stop. Observe the TV and status, then reopen Sample.
   System volume, power, d-pad navigation, keyboard, screenshots, game launching,
   Themes and settings are unsupported on this test connection. Any incidental
   requests from those app components are refused, never sent to production.
6. Stop Player and exit its Steam shortcut. Verify port 8791 closed and Themes
   baseline unchanged, then switch the phone back to its existing Themes box.
   Remove only the **Player Test** phone entry when finished. Its token rotates
   every server launch, so update only that entry's token for another session.

The server intentionally recognizes the app's agent-family ping, but marks its
identity/version as an isolated Player test. The status response is a minimal
compatibility envelope, not machine telemetry: memory/load counters are zero
placeholders, temperature unknown, disks empty, uptime is this test's lifetime.
Steam/Launch and Player caps keep the existing Launch → Watch UI reachable;
no actual Steam mutation or game launcher routes are enabled. The launcher list
is empty and creation disabled. Every other feature cap is false. The fixed
legacy open payload is exactly `{"op":"open","service":"sample"}`; URLs,
paths, searches, unknown services and additional fields are rejected. It uses
the same browser ownership, source, software decoding, and rate limit as catalog
playback. No production token/config/service is read, forwarded, or modified.

### Local evidence and remaining phone check

`python3 tests/test_player_isolated.py` covers connection envelopes, auth, strict
legacy open payloads, shared rate limit, process ownership, and route denials.
`python3 scripts/player-test-smoke.py <built-package-folder>` also executes the
checked-in app's API method bodies using Node's TypeScript stripping and a
loopback HTTP transport. It checks connection/status/caps, the Sample service,
real decoded-frame and clock advancement, pause/resume, both seeks, mute/unmute,
Stop and reopening. The existing web-remote/browser regression runs too.

This is not execution of the installed TestFlight binary or its React Native UI.
The actual iPhone's connection form, Watch rendering and LAN permission remain
hardware acceptance checks. If the installed app differs from the checked-in
contract, stop and report it; do not replace the app or alter Themes to work
around it. No compatibility revision has been deployed by these local tests.


## Shared production playback state

Release integration work now puts decoded readiness/frame/error reporting in
`couchsided.py` itself. The isolated package imports that shared implementation
instead of overriding it. The production tile also has a fixed sample-only TV
page and software-decode flags; other service decoding policies are unchanged.
These production changes have local acceptance evidence, not a deployed-machine
or installed-iPhone acceptance result. The c042710f22dd archive is the earlier
reviewed compatibility package, not a bundle of these later source changes.
