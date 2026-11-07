# Air Mouse preview

Held checkpoint, November 6, 2026. No release/version bump.

## Current behavior

Air Mouse starts on when entering a connected Pad > Mouse screen after preferences
load. The preference can disable this default. The Mouse layout stays portrait
while Air Mouse is enabled, preventing a switch to laptop mode while pointing.
Background, blur, disconnect, rotation/reflow, target change and unmount stop
motion and retire pending callbacks. Returning from OS background does not silently
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
