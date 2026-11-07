# Air Mouse preview

Held checkpoint, November 6, 2026. No release/version bump.

## Current behavior

Air Mouse starts on when entering a connected Pad > Mouse screen after preferences
load. The preference can disable this default. The Mouse layout stays portrait
while Air Mouse is enabled, preventing a switch to laptop mode while pointing.
Background, blur, landscape rotation, target change and unmount switch motion off and retire pending callbacks. Temporary unavailable/stale status blocks motion and clears queued deltas while retaining ON; only fresh samples can resume when available. Portrait window/inset changes clear motion without switching OFF. Returning from OS background does not silently
restart it. Touching the trackpad temporarily yields gyro movement without switching Air Mouse OFF. After release and a short settling interval, gyro aiming resumes; the final touchpad delta is preserved. The same controls are available in Swipe mode.

A single bottom-right touchpad button opens an upward animated fan: On/Off,
Quick calibrate, Recenter, Click/Confirm and Prefs. Closing the fan does not stop
pointing or click the box. Reduced-motion preference disables the animation.
Detailed controls live in Setup > Prefs > Pad Layout > Air Mouse, also reachable
from the fan. Speed, start-on behavior, larger-cursor size and shake-to-enlarge choice are persisted.

There is one physical grip: screen facing up, phone top pointed toward the TV.
Gyro Z controls horizontal movement and X controls vertical movement. An upright
selector is deliberately absent. Tabletop/optical-mouse emulation is not included.
Quick calibration estimates stationary sensor bias for one second. Recenter stops
motion and clears filters/queued movement so the user can regrip; it does not warp
the OS cursor. Bias calibration lasts for the mounted controller.

Normal/Fast remote gain is 4x/6x the initial 1100px/radian mapping; Slow restores
its 1x baseline. Radial deadband, radial speed response, shared adaptive filtering
and vector-length limiting preserve direction through diagonals and figure eights.
Fine corrections get stronger smoothing and a lower gain; deliberate sweeps get
faster response. Stillness hysteresis clears filter/carry drift. Per-frame motion
is bounded and gaps over 80ms reset the integrator. No movement/click is replayed.

Basic box movement uses the existing gamepad WebSocket, with unsent mouse frames
cancelled on stop. Direct LG movement uses one cancellable webOS pointer socket;
its existing button delivery remains unchanged. No Bluetooth is required. Direct
LG retains a touchpad fallback. Browser mock connections cannot certify sensors.

## TV navigation

The TV remote uses a larger adaptive navigation circle, with compact Menu, Settings, Back and Home buttons in its corners. A quick center tap sends OK. Holding or dragging the center enables joystick control: native pointer movement for a paired LG TV, or bounded directional repeats for button-only TV backends. Release, blur and background retire movement and repeat timers.

Remote > TV with the LG backend routes Air Mouse to the TV pointer socket rather than the box cursor. The authenticated pointer route bounds deltas, validates the returned socket host, and never retries uncertain input delivery. Mouse and Swipe continue to control the box. Active Air Mouse keeps these screens in portrait.

## Android native sampling

expo-sensors 57.0.3 requests SENSOR_DELAY_NORMAL without the high-rate permission:
real Razr diagnostics showed 200ms updates, exceeding the stale-gap guard and
causing an ON switch with no movement. The guarded postinstall patch changes only
the gyro fallback to SENSOR_DELAY_GAME (20ms/50Hz). Android autolinking builds
expo-sensors from source so a precompiled AAR cannot bypass the patch. No new
permission is added. Live native diagnostics confirmed the corrected 20,000us
registration, and the box then received real relative-motion events.

Android's JS event gate is 10ms to avoid the SDK's strict `>` throttle dropping
nominal 20ms hardware samples. Hardware remains 50Hz; iOS stays at 20ms. New native
binaries are required for the sensor module/patch; a JS-only update is insufficient.

## Guided setup

The Prefs screen requests the box's four-target page, then returns to Pad. Quick
calibrate, turn Air on if needed, aim the cursor and use the fan's Click to confirm
each target. This is an accuracy exercise with manual speed adjustment, not an
automatic gyro gain fit or absolute pointing calibration. The page includes
repeat, user-initiated fullscreen, Exit and Escape. Close the browser or return to
Steam if it refuses script-driven close; turn Air off separately on the phone.

Authenticated, rate-limited POST /api/air-mouse/show opens a fixed loopback URL.
GET /air-mouse requires a loopback peer and local Host. The standalone Linux and
Windows agents embed identical static HTML with no credentials or network scripts.
Opening is best-effort: a successful request is not proof the screen is visible.
The owner did visually confirm the Steam Machine screen and complete four targets
using the Razr. Later curve/UI changes require a fresh physical feel check.

## Larger cursor — experimental

The phone maintains an authenticated POST /api/air-mouse/cursor lease while active
and the preference is enabled. The Linux agent starts a stdlib-only X11 worker
that snapshots the current named arrow, loads an enlarged image, and restores the
snapshot on stop, agent pipe EOF or an 8-second lease expiry. Stale stop requests
cannot retire a newer lease. Size choices are 128, 192 and 256 pixels. Optional shake-to-enlarge requests a short 256-pixel locator lease; ordinary aiming resumes without replaying the shake motion. It does not write desktop/theme settings. No cursor
support is claimed for Windows, direct LG, Wayland-only or app-drawn cursors.

Gamescope cursor resources/names complicated the live test. Ordinary Steam UI
restart passed; Gamescope refused manual service restart, so no service protection
was bypassed. Current cached/unnamed cursors may remain unsupported until a fresh
Game Mode session. A lease only reports success if the resulting image dimensions
are enlarged. Failed enlargement leaves normal pointing available. Visible sizing,
restoration across active cursor changes and fresh-session acceptance remain gates;
do not describe this option as production ready.

## Verification and remaining gates

TypeScript, web export, 889 app/hook tests, guide dispatcher/lease ownership tests,
and target sequence tests pass locally. Figure-eight tests check rotated curve
consistency; tremor/sweep tests check steady fine response and preserved coverage.

The native Razr direction mapping and four-target flow were owner-confirmed.
The combined upward-menu/radial-tuning preview still needs physical acceptance:
figure eights, precision, stillness/OFF, default-on and manual-off behavior,
portrait lock, touchpad pausing, fan open/close, Prefs round trip and settings
persistence. Cursor sizing/restoration is experimental as above. iOS and native
LG motion acceptance remain untested. Exact-head CI and final artifacts must be
reviewed before any separately authorized release. Pairing keys, private logs,
network records and Claude handoffs stay local.


Latest native preview evidence: the Android package was installed in place;
saved secure connection survived. Native UI showed Air Mouse ON on entry and
still ON after opening the vertical fan, and the OS reported portrait orientation.
Browser verified the expanded upward fan and Prefs page. USB disconnected before
native Prefs round-trip verification. These are preview checks, not release approval.

Latest source checkpoint: enlarged TV navigation and hold/drag joystick, Swipe support, touchpad/gyro handoff, runtime portrait lock, native LG routing and shake locator are integrated. Updated combined Android installation and physical acceptance are pending. Earlier owner confirmation covered the upward menu and motion feel, not these latest additions.

Continuous-motion regression: a high angular speed alone must never suppress aiming. Shake suppression now starts only after three qualifying rapid reversals confirm the locator gesture. Tests cover 20 seconds of fast figure-eight input without suppression; native sustained movement and touchpad handoff still require physical acceptance.

Residual freeze investigation: owner reports touchpad stalls too. Native sensor delivery remains steady in captured intervals; a separate device-to-box latency probe showed multi-second reply delays. Shared transport versus Air-active interference is not yet isolated. Continuous aiming and touchpad handoff acceptance remain failed/pending; do not certify this preview for release.

Historical A/B preparation: the archived owner-approved upward-menu preview is source `89fb2d6`. Its pure integrator and shared gamepad/mouse transport match the current branch. The archived APK and source-map checksums were verified and the preview reinstalled without clearing app data for a same-device gyro-only comparison. Results are pending; this is a QA rollback, not a release.

Menu lifecycle: ON intent is remembered per target for the app session. Blur/unmount removes the sensor listener, clears pending motion and retires the cursor lease while retaining that intent; returning to a focused, available input surface starts fresh samples. Explicit OFF stays OFF across menu visits. OS backgrounding while the input controller is mounted still switches OFF. Paused menus never own sensors or transmit movement. Native menu round-trip acceptance is pending.

Native preview checkpoint: menu Preferences/Back round trip stopped sensor samples in the menu, restored ON on return and resumed sensor sampling. During an automated held Mouse touchpad gesture, gyro output was gated for the gesture and allowed again after release, without turning OFF. Physical smoothness and remaining freezes still need owner confirmation. The diagnostic inbound-age counter was corrected to update on actual inbound messages, rather than only at the keepalive timer; older age readings can overstate silence.

## Synthetic movement-only QA

A private build can enable `EXPO_PUBLIC_AIR_SYNTHETIC=1` and open Pad with
`syntheticGyro=1`. Ordinary builds cannot activate this source. It runs for 30
seconds: stillness, five repeated figure eights, then stillness. The generated
samples pass through the same grip mapping, integrator, lifecycle/handoff gates
and transport as native gyro. The test source emits no buttons, clicks, keys or
scroll commands, and stops automatically. Click/Confirm is disabled in this mode.

First live Razr-to-Steam-Machine run reproduced delivery bursts without physical
sensor input: 922 generated movement vectors matched the receiver's cumulative
X/Y sequence exactly, with no aggregate motion loss. Receiver gaps reached about
3.47 seconds; matched movement delivery had up to about 3.45 seconds of excess
latency above the run's baseline clock offset. A separate roughly two-second
source pause coincided with stale-connection gating. X11 cursor positions also
recorded the stalls. Screen capture showed a Steam Launching frame, so visual
cursor verification was not claimed. This isolates a delivery/connection problem
in the exercised path; it does not yet identify Wi-Fi, TCP buffering or the
native bridge as the root cause. Physical sensor timing and touchpad feel remain
separate acceptance checks. Raw logs, screen captures and host details stay local.

## Android Wi-Fi stall isolation and mitigation

A private QA route can send the same synthetic run over USB loopback forwards
while retaining the saved TLS pin and token. This route changes only the
in-memory endpoint, refuses unpaired connections and never edits saved boxes.
The Mac-to-box network segment remains common to both tests.

Same-binary comparison removed multi-second receiver gaps when the Razr Wi-Fi
segment was bypassed: USB max gap about 150 ms, versus Wi-Fi about 2.10 seconds.
The Android controller now requests the OS low-latency Wi-Fi lock while focused,
connected and foregrounded. It does not configure Wi-Fi, scan or access network
credentials. Older native builds safely skip the optional module. Native lifecycle
checks confirmed acquisition on Pad, release in stacked Prefs, reacquisition on
Back and release after Home.

Three candidate Wi-Fi runs measured maximum receiver gaps of about 125, 149 and
150 ms, with generated/received X/Y totals matching. The final installed source
checkpoint is `1688f39`; its final run generated 999 vectors. No multi-second
stall recurred in these runs. Smaller 100–150 ms pauses remain, including one
107 ms phone-side generation gap in the final run; do not claim zero freezes or
zero measured pauses. Synthetic mode was stopped and the phone returned
to normal input. USB reverse routes/tunnel and the bounded receiver recorder were
removed/stopped. Raw measurements and private infrastructure details stay local.

Owner acceptance, November 7: the final installed Razr preview (`1688f39`) was reported to “feel great” after returning to normal input. This confirms the subjective feel of that preview on this device; it does not establish zero timing gaps or acceptance on iOS, other Android models or native LG pointing. Release remains on hold.
