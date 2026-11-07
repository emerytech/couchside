# Air Mouse preview

Held checkpoint, November 6, 2026. No release/version bump.

## Current behavior

Air Mouse starts on when entering a connected Pad > Mouse screen after preferences
load. The preference can disable this default. The Mouse layout stays portrait
while Air Mouse is enabled, preventing a switch to laptop mode while pointing.
Background, target change and unmount retire pending callbacks. Menu blur pauses motion while remembering ON. Mouse/Swipe/LG remain portrait; optional PAD/MOVE Air Mouse supports controller rotation and resets pending deltas when dimensions change. Temporary unavailable/stale status blocks motion and clears queued deltas while retaining ON; only fresh samples can resume when available. Portrait window/inset changes clear motion without switching OFF. Returning from OS background does not silently
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

iPhone preview preparation: an internal cloud build is being prepared from the Air Mouse branch for native Steam Machine and LG pointer testing. Saved-box baseline and secure Steam Machine reachability were checked before the update. iOS motion, menu resume, touchpad handoff and LG pointing remain pending native acceptance; Android results do not certify iOS. No store submission or release is authorized.

iPhone installation checkpoint: internal cloud preview 2.9.82 (292) passed signature/provisioning checks and installed in place. The six saved box entries survived, the existing secure Steam Machine connection worked, and the Air Mouse fan/Prefs/Back flow retained ON and reconnected. Physical gyro/handoff and native LG cursor acceptance are still pending. The experimental Linux cursor enlargement reported unavailable on this run; normal pointing remains the test target. Nothing was submitted to a store or released.

Owner iPhone feedback, November 7: internal preview 2.9.82 (292) was reported to feel very smooth against the Steam Machine. This accepts subjective pointing feel on this iPhone; individual handoff gestures and native LG pointing are not independently certified by that feedback. LG testing remains next. Release remains on hold.

## Requested expansion and future preset

Owner direction, November 7: make Air Mouse an optional input in PAD and MOVE as well as the existing Mouse, Swipe and native LG paths. Reuse the compact fan, preserve touch control and held-input ownership, and pause safely outside eligible input surfaces. PAD/MOVE retain their controller orientation behavior; the Mouse portrait policy must not be copied blindly. This expansion is requested, not yet implemented or tested.

Future Baldur’s Gate preset: a dedicated themed pad optimized for keyboard-and-mouse navigation, with Air Mouse cursor control. Plan configurable keyboard actions and mouse buttons rather than only Xbox-button remapping. Confirm the intended Baldur’s Gate title before choosing bindings. Agent support must be capability-checked with safe release of all held keys/buttons on disconnect, preset changes and backgrounding. This is a saved product idea, not part of the current accepted preview.

Owner LG iPhone test, November 7: native LG cursor feels jerky and laggy compared with smooth Steam Machine cursor. LG acceptance FAILED/pending tuning. Current RemoteView sends each move through the HTTP tvPointer API, unlike the box WebSocket movement path; this is an investigation lead, not proven root cause. No release.

## LG stream and controller-mode preview changes

LG movement can use an additive authenticated `tvp` frame on the existing controller WebSocket when `/api/tv` advertises `pointer_stream`. Only the current controller holder can send it; move bounds remain 120 per axis and invalid frames do not terminate the controller session. No automatic movement/click replay occurs. Older agents keep the HTTP route. TV sockets use TCP_NODELAY. This removes a request/response round trip per sample, but physical LG smoothness still needs retesting. The scoped agent change is installed on the test Steam Machine.

PAD and MOVE expose the compact AIR fan as a separate opt-in controller input, initially OFF to avoid unexpected cursor movement during gameplay. They retain controller rotation behavior. Controller touches remain independent; this mode does not suppress gyro when holding a gamepad button. Landscape launchers use free-space placement outside existing control hitboxes. Sensor and pending-motion cleanup still runs on background, blur, target changes and unmount. Native acceptance of these additions remains pending. No release.

Installation checkpoint: internal iPhone preview 2.9.82 (293), built from `fd05da5`, passed IPA signature/provisioning checks and installed in place. Actual installed version and six retained saved connections were verified. It is connected to the Steam Machine and open at native LG Remote for the physical retest. Branch CI at `455291b` passed 13 checks with one skipped. Local input suites passed 121 tests, plus the added stream-client ordering test and agent ownership/validation checks. LG subjective smoothness and PAD/MOVE native acceptance remain pending; no release.

Baldur’s Gate layout refinement: use the regular MOVE layout as the base, add a touchpad above the A/B buttons, dedicated left-click and right-click buttons, and Air Mouse enabled for this custom preset. Touchpad contact should temporarily own cursor motion for fine adjustments, with Air Mouse resuming after release. Preserve ordinary MOVE defaults. Exact game title and movement/key bindings remain unspecified; do not infer WASD or alter the default MOVE mapping. Saved design direction, not implemented yet.

Owner native LG acceptance, November 7: iPhone preview 2.9.82 (293) was reported as “LG pointing is smooth now” after the requested movement/figure-eight test. Mark subjective LG pointing accepted for this device and deployed test agent. PAD/MOVE simultaneous input and lifecycle acceptance remain pending. No release authorized.

LG thumb-click addition: while native LG Air Mouse is ON, a separate 68×48dp CLICK button remains visible immediately left of the AIR launcher, even with the fan closed. It sends a native pointer click at the current TV cursor position, not a D-pad OK key. Pressing it temporarily pauses gyro integration to reduce tap-induced cursor movement, then resumes after the normal settling interval. Other input modes keep their existing controls. Native visual/selection acceptance remains pending the next preview.

Portrait PAD placement correction: AIR now has a reserved 60×52dp slot beside the keyboard bar rather than floating over the screen’s bottom edge. The keyboard bar uses the remaining width; the upward fan stays outside normal layout so opening it does not resize the controller. Immersive PAD/MOVE free-space placement is unchanged. Not in installed iPhone293.

## Baldur’s Gate 3 keyboard/mouse MOVE preview

Setup → Prefs → Pad Layout has a separate **Baldur’s Gate 3 MOVE** switch (off by default). With it enabled, MOVE uses a no-virtual-controller connection and a dedicated keyboard/mouse-only input driver. Standard MOVE and existing presets are unchanged. The new surface retains MOVE’s zone and A/B positions, adds a touchpad above them and separate left/right mouse buttons, and defaults Air Mouse ON. A sends Enter, B sends Escape; clicking the game world remains a mouse action.

The movement zone is configurable on-screen: **WASD camera** is the preference default, or choose **Cursor** steering. Camera mode requires the agent’s advertised `camera_keys`; supported keyboard-only agents without that extension use cursor steering and show an update hint. Agents that do not acknowledge keyboard-only mode cannot operate the preset. This avoids sending controller buttons or guessing support for newer protocol frames. Windows and Linux agent source include the additive support; Windows installation/native acceptance is still pending.

Held camera keys are limited to W/A/S/D, renewed while held, reference-counted across sessions, and expire after 500 ms without renewal. Demotion/disconnect and app blur/background/layout/preset changes release owned inputs. Windows keeps its session/elevation injection guard. Mouse buttons are reference-counted so an Air click or touchpad drag cannot release another held source. Touchpad fingers are tracked locally, so a finger on MOVE cannot turn a one-finger pad drag into scrolling. Touchpad contact temporarily pauses Air Mouse for fine movement; camera movement can coexist with gyro aiming.

TypeScript, driver/layout/touchpad tests and agent lease/ownership/Windows-boundary checks passed locally. This is development source and local web preview work, not an installed phone or released agent update. Native BG3 gameplay, simultaneous controls and reconnect/lifecycle acceptance remain pending. The LG thumb-click and portrait AIR footer corrections also await the next phone preview. No release.

Local UI verification: the BG3 preference, movement-mode selector, left/right clicks and Enter confirmation were exercised against an isolated mock agent. Portrait layout was visually checked with the touchpad above A/B and separate click buttons. This verifies the browser preview, not physical phone multi-touch, gyro, real BG3 gameplay or installed agent compatibility.

Preview preparation checkpoint: the scoped BG3 keyboard-only/leased-camera-key agent changes are installed on the Steam Machine test box; service recovery and existing LG pointer availability passed. Internal iPhone 2.9.82 (294), from source `03cde10`, is building with BG3 MOVE, the LG thumb-click button and portrait PAD footer correction. Installation and native acceptance remain pending. No Windows deployment or public release.

Installation checkpoint: internal iPhone preview 2.9.82 (294), source `03cde10`, passed signature/provisioning checks and installed in place with all six saved boxes retained. Native UI shows the separate portrait PAD footer slot, LG’s closed-fan Click button, and the enabled BG3 MOVE layout. BG3 negotiated keyboard-only mode and WASD support, and Air Mouse defaulted ON. The Steam Machine’s virtual-input listing showed the keyboard and mouse, with no virtual Xbox pad. Physical gameplay/input-release, touchpad handoff and lifecycle acceptance remain pending; no release.

Owner physical BG3 acceptance, November 7: on iPhone 2.9.82 (294) against the Steam Machine test agent, the requested Air Mouse/touchpad, click/A-B and WASD move/release check was answered “Stays keyboard/mouse; controls release correctly.” Mark this physical control-mode/release check accepted. Do not infer rotation, background/reconnect, LG Click selection, Windows native acceptance or release approval; those remain pending.

BG3 label clarification: the Enter and Escape controls now read “Confirm / Enter” and “Back / Esc”, centered on two lines to fit the original targets. Their keyboard bindings are unchanged. Escape can open the game menu when no dialog/menu is available to dismiss; the label describes back/cancel rather than claiming a controller B action. This label-only change is not in installed preview 294.

Label-preview preparation: internal iPhone 2.9.82 (295), source `9df2359`, is building for installation and physical BG3 rotation/background-reconnect checks. The Steam Machine test agent remains active. A bounded, fixed-WASD-only receiver recorder is prepared to verify release state during those checks. These lifecycle gates are still pending; no release.

Owner rotation feedback on installed iPhone 295 confirmed release when rotation replaced the control layout; the fixed-WASD receiver recording ended with no keys held. It also exposed an inverted BG3 vertical adapter: the shared stick uses negative Y for up. BG3 now maps that to W and upward cursor movement; standard MOVE is unchanged. Direction acceptance and background/reconnect remain pending.

Synthetic QA adds a bounded numeric-only source/send trace under the existing compile-time and explicit-route gates. It buffers in memory and writes one cache report after the 30-second movement-only run; normal builds do not activate it. Separate internal QA and normal previews will be used to compare generated vectors with received movement before changing accepted gyro tuning. No release.

The corrected-axis source `2d79525` is being built as two internal previews: 296 for an explicitly gated, movement-only synthetic gyro run, and 297 with synthetic input disabled for normal testing afterward. The normal preview will be restored after QA. Rotation release on 295 was accepted with receiver confirmation; forward-direction and background/reconnect checks remain pending the corrected preview.
