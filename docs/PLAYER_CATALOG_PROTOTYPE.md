# Player catalog prototype

Branch: `codex/player-catalog-prototype`. Separate worktree from the active themes work.

Launch → Watch → Sample films → Big Buck Bunny — trailer → Play on TV.
The existing phone controls provide play/pause, skip, mute and Stop. If the
browser does not autoplay, press Play after the video loads.

## Scope

One built-in provider uses Stremio's catalog/metas/stream shapes without importing
Stremio code or its SDK. No arbitrary add-on installation, torrent engine, mpv,
cloud service, API key, new dependency or installer change. It plays the 33-second
MP4 trailer hosted by W3C. The UI credits Blender Foundation and CC BY 3.0.
General remote provider fetching and manifest installation are future work.

## Contract

Authenticated GET `/api/player` adds optional `catalog` and `catalog_video` fields.
Old apps ignore these; new apps hide the catalog on old boxes that omit them.
Authenticated POST `/api/player` with exactly
`{"op":"catalog-open","video_id":"couchside:bbb-trailer"}` selects a source constant.
Unknown IDs return 404, extra fields 400, repeat launches within the existing
open interval 429, and missing credentials 401. The custom URL setting remains
unchanged: this operation only opens the single built-in source.

Playback reuses `player_open`, Steam shortcut registration/relaunch, Chrome and
CDP controls. It still requires the existing Player installation and browser.
Catalog requests do not run commands or accept paths/URLs from the phone.

## Verification

- `tests/test_player_catalog.py`: real HTTP auth/refusal/rate limit and fixed
  source lookup; actual player config write + launch handoff with Steam stubbed.
- Existing player API and transport suites; protocol parity; TypeScript check.
- Web export; actual Watch catalog button and pause button pressed in mock harness.
- Real local Chrome loaded the remote trailer; actual agent CDP play, pause,
  mute/unmute and seek code exercised. This is separate from the mocked UI test.
- Screenshots and playback readings are in local `output/player-prototype/`.

## Repeatable local browser acceptance check

Run `python3 scripts/player-browser-smoke.py` from this checkout. It requires
an installed Chrome/Chromium and access to the fixed W3C sample. It installs no
packages. The script starts its own loopback HTTP server and a fresh headless
browser profile; it uses no user's browser session, token, or cookies.

Catalog discovery/selection, pause/resume with actual clock advancement, backward
and forward seek, mute/unmute, and Stop all run through the real `/api/player`
HTTP handlers and CDP client. Only the Steam registration/relaunch step is
replaced by a local browser launch. Missing auth and unknown IDs must launch
nothing. Stop must end the browser and clear active playback/catalog metadata.

A screenshot and a redacted result are saved to local
`output/player-prototype/browser-smoke.png` and `browser-smoke-result.json`.
Temporary browser state is cleaned up even on failure. The check is opt-in
because it requires a browser and an external media host; the stdlib catalog
regression suite remains in CI.

Verified locally on 2026-10-21. This does not verify Steam focus, audible output,
a physical phone, or theme coexistence on a real machine. No app files changed
in this follow-up. App dependencies must be installed into this worktree before
running the web harness; do not link them to another active checkout.

## Hardware checks still required

Deployment requires the owner's explicit approval. Do not replace the live
agent, Decky companion, or settings; do not import unfinished Themes work.
A future deployment plan must preserve the installed companion and identify
an approved compatible Player build and rollback before touching the machine.

1. Agree on the test installation and matching phone build with the owner.
2. In Game Mode, open Watch and press Play on TV. Capture `/api/screen/frame`
   proving that the trailer is visible, and verify sound comes from the TV.
3. Press pause/resume, skip forward/back, mute/unmute and Stop on the phone;
   verify actual playback and returned position/state, not only HTTP success.
4. Reopen the catalog, switch to an existing service, return to Steam, and
   verify themes, focus and controller navigation still work.
5. Verify a box without Player and an older agent both hide the catalog.

No Steam-machine install, restart, TV takeover, release or push was performed.

## Isolated Steam test package (prepared; not deployed)

Build locally with `python3 scripts/build-player-test.py`. The archive is written
only under `output/player-test-package/`, with exact file checksums and a content
identifier. Only the Player server, static remote, agent source, launcher and
review instructions are included: no Claude files, production credentials,
private notes, logs, browser state, release builds or Git history.

The launcher runs the restricted test server **inside its own Steam shortcut**;
it does not install another agent service. This gives the test direct ownership
of its browser without calling the production launcher's shared paths. The
server imports the prototype's catalog/CDP functions but never calls agent main.
Only the fixed sample and playback operations are allowed, on test port 8791.
Its separate token and fresh browser profiles live inside the extracted package.
Cleanup targets the owned native child or the exact numeric Flatpak instance
reported by its launch. No automatic Steam shortcut database changes are made.

`python3 scripts/player-test-smoke.py output/player-test-package/<folder>`
checks the built package locally with real Chrome and its actual web remote,
including reopening, Stop and server shutdown while an unrelated browser lives.
`tests/test_player_isolated.py` covers restricted routes/auth/input and scoped
cleanup, including invalid Flatpak IDs and termination failures; it runs in CI.

Deployment and rollback steps are included in `scripts/player-test/README.md`.
They require explicit owner approval and a read-only baseline before transfer.
Actual Flatpak/Steam focus, TV audio, physical-phone use and Themes coexistence
remain unverified. Nothing has been installed, pushed or published.

## First approved hardware trial — failed, Player rolled back

The isolated server started from its separate Steam shortcut and the test web
remote connected. Chrome announced a debugging port but exited before usable
playback; Steam remained on its launch screen. The root cause is not established.
Local headless success therefore does not establish Steam/Flatpak compatibility.

The trial was stopped. Only the test server/browser, test shortcut and extracted
test directory were removed. All 220 protected baseline files were unchanged,
production services remained active, the Steam shortcuts file matched its
original bytes, and the original Themes home/selection returned on screen.
No usable video, TV audio or physical-phone playback controls were verified.
Private hardware logs and baselines stay local. Diagnose locally before proposing
a revised package and another deployment window.

## Revised launcher — persistent browser owner

The HTTP handler used to launch Flatpak from a worker thread that ended after
sending its response. Linux parent-death signals are tied to the creating thread;
Flatpak forwards `--die-with-parent` to bubblewrap. This provides a mechanism
matching the observed browser startup followed by exit without server exit.

The launcher now submits browser start/stop to a persistent single-worker owner,
which is shut down only after browser cleanup. Flatpak's parent-death protection
and numeric-instance cleanup are retained. Private diagnostics record backend,
owner thread and exit code without credentials or request contents.

The local Linux regression uses the actual kernel parent-death signal. Restoring
the request-thread launch fails the survival assertion with SIGTERM; the revised
path passes. API auth/input/cleanup/shutdown tests also pass. These checks prove
the defect and correction in isolation, not the cause of every possible Steam
launch failure. Native local Chrome/web-remote acceptance is tested separately;
actual Flatpak/Steam playback still awaits an approved hardware retest.

References: [Linux parent-death semantics](https://man7.org/linux/man-pages/man2/PR_SET_PDEATHSIG.2const.html)
and [Flatpak forwarding to bubblewrap](https://github.com/flatpak/flatpak/blob/main/common/flatpak-run.c).

## Revised package hardware retest — launch fixed, presentation blocked

The approved persistent-owner revision survived the Play request in Steam Game
Mode. Actual video metadata and an advancing playback clock were observed.
The browser-based remote passed pause, backward/forward seek, mute/unmute,
resume and Stop; Stop cleared the active video state.

The TV screenshot revealed a separate acceptance failure: the MP4 rendered as a
small centered video instead of filling the TV. The test was therefore stopped
and Player alone was rolled back. The isolated server/browser, shortcut and
extracted package were removed; test port closed. All 220 protected files
matched the fresh baseline, production services remained active, the shortcut
file matched its original bytes, and the Themes home returned.

The launch-lifetime fix is now supported by hardware evidence. Full-TV video
presentation remains the next blocker. Audible TV output and controls from a
physical phone were not verified. Private evidence remains local; no production
agent or Themes files were changed and nothing was pushed or published.

## TV surface sizing revision

The test browser now opens a dedicated loopback `/tv` page instead of Chrome's
built-in raw-MP4 viewer. HTML/body margins and scrolling are removed; the video
element covers the viewport with `object-fit: contain`. This fills a 16:9 TV
and letterboxes differing aspect ratios without cropping or stretching.

The page contains only the same fixed sample source, supplied by the server;
no token, user URL or client-selected path is added. `/tv` requires a loopback
peer and a loopback Host header, while LAN remote API auth remains unchanged.
The persistent browser owner and exact-instance cleanup are retained.

Local real-Chrome package tests measure actual decoded-video geometry at
1280×720, 1024×768, 2560×1080 and 3840×2160, capture 16:9/ultrawide screenshots,
verify sizing after a real page reload and rerun the remote controls, reopening
and shutdown checks. Unit tests cover the fixed source and route/Host/peer gates.
This revision has not been deployed; actual Steam/TV sizing still needs a fresh
approved hardware retest. Themes remains untouched.

## TV sizing hardware retest — sizing passes, decode failure remains

The approved TV-surface package filled the real 3840×2160 browser viewport with
aspect-preserving fit. A TV capture and owner confirmation established that the
fullscreen title card was visible. Initial remote-control actions returned
success and the clock initially advanced, but sustained/reopened playback did
not pass: after a seek it reported playing while the clock stayed at 10 seconds
and the title card remained frozen. Owner observation confirmed no motion.

Saved browser diagnostics reported media error code 3 / PIPELINE_ERROR_DECODE,
with buffered data present and the document visible. This identifies a decode
failure, not its underlying hardware/driver/codec cause. A playing boolean and
successful control response must not count as proof of moving playback.

Player alone was rolled back: test server/browser, shortcut and extracted files
removed; test port closed. All 220 protected files and original Steam shortcuts
matched the fresh baseline; both production services remained active and the
Themes home returned. Further decoder diagnosis should happen locally before
another approved deployment. Private hardware evidence stays local; no production
agent or Themes files were changed and nothing was pushed or published.

## Decoder mitigation revision — local only

Hardware evidence establishes a decode-pipeline error despite buffered data,
not a proven driver or GPU root cause. The owned test browser now requests
software video decode while preserving GPU compositing and fullscreen sizing.
No global acceleration setting or production browser profile is changed.

Local Chrome reports FFmpegVideoDecoder and platform decoding false. Stronger
acceptance measures real clock and decoded-frame advancement after seeks and
reopening, and requires the reopened clip to finish. A synthetic code-3 replay
verifies explicit error reporting and playing=false; it does not simulate the
actual hardware fault. The snapshot exposes ready/seeking/error/frame counts
without changing the production agent or its response contract.

This is a locally verified mitigation, not a confirmed resolution on SteamOS.
A newly approved hardware retest is still needed for sustained TV picture/audio
and physical-phone acceptance. Themes has not been touched or redeployed.


## Software-decoding hardware retest — passed (2026-10-21)

Approved isolated package `8d3c5c902c52-7a8fd23977da` passed sustained
clock and decoded-frame advancement, pause/resume, backward/forward seek,
mute/unmute, Stop, reopen, and full sample-clip completion on the Steam machine.
The user confirmed the fullscreen TV playback worked. Controls were exercised
through the test remote web UI; the native phone application remains untested.
The software-decoding launch flag was used; the hardware decoder name was not
independently captured during active playback.

Fresh before/after verification found all 220 protected Themes files unchanged,
both companion services active, and every existing Steam shortcut unchanged.
Only the isolated Couchside Player Test shortcut was added. The successful test
package and shortcut remain installed, but the test server/browser were stopped
and port 8791 was verified closed. No production agent, Decky plugin, or Themes
settings were replaced. Private evidence remains local under ignored output.
This validates the fixed sample prototype, not arbitrary add-ons or media.


## Installed iPhone app compatibility package (2026-10-21)

The isolated server now offers credential-free `GET /api/ping`, authenticated
`GET /api/status` and an empty `GET /api/launchers` response, alongside the
existing authenticated Player API. The status response is explicitly scoped to
the test and contains placeholder counters, not production machine telemetry.
Player state supplies the existing app's services, available and seek-offset
fields. A strict `open` operation accepts only `service: "sample"` and reuses
the fixed trailer, software decoder and owned browser. It does not accept URLs,
paths, search queries or any other service. All machine mutation routes remain
unavailable; no proxy to the production agent is involved.

After an approved deployment, manually add a separate **Player Test** phone
connection for the machine's IP on **8791**, using only its temporary test token.
Keep the existing Themes connection unchanged. Open **Launch → Watch → Sample**
and use the video transport controls. The legacy Services tile avoids depending
on the prototype catalog UI being present in the installed app. No iPhone app
build, dependency install, OTA update, TestFlight upload or new app identity is
needed. The package README contains the exact phone test and cleanup steps.

The checked-in app contract can be exercised locally without building it:
`scripts/player-app-contract-smoke.mjs` extracts its API method bodies and runs
them over loopback HTTP against a real isolated browser. This substitutes the
network transport, not the request payloads. It does not execute the installed
iPhone binary or establish that its UI is identical; actual phone acceptance
still requires a separately approved machine test.


Local acceptance passed: all 15 Linux isolation/contract tests, real-browser
web-remote regression, fullscreen sizing through 3840×2160, full sample
completion, and 35 loopback requests using the app-source API methods covering
connection, legacy Sample launch, decoded-frame/clock advancement, pause/resume,
both seeks, mute/unmute, Stop and reopen. Test shutdown closed owned browser
debug listeners and preserved the unrelated remote browser.

Review archive: `couchside-player-test-8d3c5c902c52-c042710f22dd.tar.gz`.
SHA256: `6aaf998f33760490bf156ff8a69a5ade09d82550964de8f7af142bb7d07f57ff`.
The revision prefix identifies the base commit; the content suffix identifies
this uncommitted compatibility revision. Its seven-file allowlist and checksum
inventory were verified; no credentials or runtime state are included.
No Steam machine connection, deployment, phone update, push or publication was
performed while preparing this revision. The prior successful Player package
remains the last approved deployment.


## Approved iPhone compatibility deployment — launch not started, rolled back

The reviewed c042710f22dd archive was verified and staged in a new isolated
folder. A distinct **Couchside Player iPhone Test** shortcut was added while
preserving the prior successful Player shortcut/package. The Steam RunGame
request did not start the HTTP server; the captured Steam game-process log
contained no matching launch. This does not establish a package runtime defect.
The iPhone test was not started and no phone connection was changed.

Per the owner's failure rule, removed only the new shortcut through Steam's
native API and the new extracted package directory. Verified port 8791 closed,
all 220 protected Themes files unchanged, both services active, and every
original Steam shortcut record unchanged. Previous successful Player installation
was retained. Private baseline and launch evidence remain local. A renewed
launch/deployment attempt needs owner approval; no production component changed.


## Production-path parity prepared for release integration (2026-10-21)

The production tile now recognizes only the exact built-in sample URL and writes
its static `sample.html` into the selected browser's profile (the same readable
location used by the existing hub). That sample uses an aspect-preserving
viewport-filling video element, visible load/decode failures, software video
decoding and autoplay. Streaming-service and other URL launches retain their
existing URL and decoder policy. No network listener, new installed asset,
Flatpak override, global browser setting or external dependency was introduced.

Production `PLAYER_JS_STATE` now reports ready/seeking/frame counts and a fixed
media-error message, and requires both decoded readiness and no media error
before reporting playing. Watch renders the reported failure with Stop/retry
instructions. Older agents may omit these optional fields. The isolated server
now uses this production state constant directly; its separate override was
removed so the real-browser checks also cover the shared production behavior.

Local production-page acceptance uses the tile's actual page/flags generator
with real Chrome, the real HTTP handler and CDP: four aspect-ratio/viewport sizes
through 4K, decoded-frame progress, pause/resume/seek/mute/Stop and a synthetic
code-3 error with paused=false that must report playing=false. Steam launch and
Flatpak are replaced locally, so this is not integrated hardware acceptance.
The earlier failed standalone iPhone launch dispatch remains unresolved and the
installed iPhone UI still requires owner-coordinated testing. No machine agent,
Decky companion or Themes configuration was changed by this production fix.


Release-local checks for the production parity change: catalog, isolated, API,
transport, tile, open-URL and navigation suites pass on macOS/Bash; installer
Player policy, protocol parity and app TypeScript checks also pass. All 15
isolated tests pass on Linux, including parent-death ownership. The first broad
Alpine run lacked Bash (so shell-based suites could not probe the tile); those
suites were rerun successfully with Bash available locally. A Bash-3 empty-array
regression found by the new non-sample policy tests was fixed before checkpoint.
No failing test result is being represented as a successful platform run.


The rebuilt isolated package using the shared production state also passed the
full browser/app-source replay, including code-3 reporting, full clip completion,
Stop/reopen, 35 app API requests and owned-listener cleanup. Review-only archive
`couchside-player-test-0a0204771d3d-64ff3ce4e0dd.tar.gz` has SHA256
`700511ddb0c54302b12ed2d576c0490ab998bb17267aab9ebca4210ae3b63562`.
It was built locally and was not deployed. This confirms local integration
behavior, not a production release approval or physical-phone acceptance.


A final Linux run with Bash available passed all seven Player suites (catalog,
isolated, API, transport, tile, open-URL and navigation) with networking disabled
and this worktree mounted read-only. This supersedes the earlier minimal-Alpine
shell-toolchain failures. All current local validation completed successfully.
