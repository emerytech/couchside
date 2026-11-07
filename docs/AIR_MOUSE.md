# Air Mouse preview

Held checkpoint, November 6, 2026. No release/version bump.

Shared opt-in controls serve Pad > Mouse over the existing box gamepad WebSocket
and directly paired LG remotes over the webOS pointer socket. No Bluetooth or
agent change is required. LG has a touchpad fallback with tap/click and scroll;
the box retains its existing trackpad. Existing LG button delivery is unchanged.

Quick On/Off toggle or portrait hold-to-point, explicit click, three sensitivity levels and one-second
stationary calibration. Lazy Expo sensors at50Hz; no high-rate permission. Samples
have deadzone/smoothing, bounded time steps/deltas and fractional accumulation.
Toggle mode pauses after stillness with hysteresis and resumes on deliberate movement. Click preserves toggle mode. Unsent box throttle frames are discarded on stop.
Rotation stops motion; the initial mapping is portrait-only. Calibration and
speed last for the mounted panel, not persistent settings.

Background, blur, release, target change, disconnect, collapse, rotation and
unmount retire the motion epoch and remove listeners. Pending LG handshakes
cannot deliver retired motion. A busy send drops samples rather than building
a backlog. Uncertain movement/click is never automatically replayed.

## Evidence

Real LG C9: pairing, input enumeration, owner-observed HDMI switch/restore, volume
step/restore, silent reconnect and owner-observed pointer movement passed. Three
movement frames were sent; no click. Private credentials/network records staylocal.

Pure tests cover calibration, reset/gaps, malformed/bounded samples, fractional
accumulation, release during delayed pointer handshake, persistent socket reuse
and cancelled click suppression. TypeScript,878app/hook tests,20crypto tests and
web export passed at the initial checkpoint. Local UI expansion/sensitivity were
exercised. Browser mocks cannot certify native sensor or touch behavior.

## Remaining gates

Native Android/iOS on LG and box: axis direction, drift/precision, calibration,
hold/release, denied/missing sensor, rotation/background/return, target change,
ownership handoff and disconnect during handshake; click and touchpad scroll.
Verify no listener/movement survives release or blur. New native binaries are
required for expo-sensors. Final artifacts require focused acceptance and new
channel build numbers before any authorized release.


## Guided four-target setup (unreleased)

On a connected box, expand Air Mouse and choose **Four-target setup on box**.
The updated Linux or Windows agent opens a fixed local browser page. Opening is
best-effort: the phone reports a request, not proof that the page is visible.
Older agents leave Quick calibrate available and show an upgrade explanation.

Point the top of the phone toward the TV with the screen facing up (Remote grip), use **Quick calibrate** while still, and turn Air Mouse
on. Aim the visible cursor at each of four targets and tap **Click / Confirm
target** on the phone. The page measures normalized cursor distance from each
target and suggests slower sensitivity when appropriate. This is an accuracy
exercise with manual Speed adjustment, **not** an automatic four-point sensor
fit or absolute pointing calibration. Relative gyro input cannot infer where
on the TV the phone is physically aimed. No sensor measurements leave the phone.

**Recenter** immediately stops motion and clears pending movement/filter state,
allowing a comfortable regrip before turning Air Mouse on again. It does not warp
the OS cursor. Quick calibration's sensor-bias correction is retained.

The page supports repeat, user-initiated fullscreen, Exit and Escape. If a browser
refuses to close itself, use its close action or return to Steam. Exit does not
remotely disable phone motion: turn Air Mouse off on the phone. No credential,
remote script, telemetry or new control socket is present in the page.

Agent surface: authenticated, rate-limited `POST /api/air-mouse/show` opens only a
fixed loopback URL; `GET /air-mouse` requires both loopback peer and local Host.
No existing API fields/capabilities changed. The standalone agents embed identical
HTML to preserve their single-file distribution. Tests cover both dispatchers,
authentication, host/peer gates, launch rate limiting, and the target sequence.
Physical phone/box aiming and browser focus remain acceptance gates.


### Android sensor-rate correction

Native Razr diagnostics exposed a 200ms gyro registration in expo-sensors 57.0.3
when HIGH_SAMPLING_RATE_SENSORS is absent. That exceeds the integrator's 80ms
stale-sample cutoff, so the switch could say ON while every sample was discarded.
`app/scripts/patch-gyro-sampling.cjs` changes only the Android gyro fallback to
SENSOR_DELAY_GAME (20ms), retaining the other sensor defaults and existing
permissions. It is idempotent and fails on an unrecognized upstream source.
It runs at postinstall alongside the reviewed TCP cleanup patch. Android native
rebuild is required; a JS-only update cannot fix the sampling registration.
The app/hook suite now has 880 passing tests; TypeScript passes. Physical cursor
acceptance remains required after verifying the replacement's live sensor rate.


Android autolinking is configured to build `expo-sensors` from source; otherwise
Expo's precompiled AAR bypasses the Kotlin patch. The replacement native QA binary
was installed in place and live Razr diagnostics confirmed a 20,000us gyro
registration (previously 200,000us). This confirms sampling configuration, not
physical cursor acceptance; that remains a separate check.


Remote grip is now the default: phone screen faces up and the top points toward
the TV. Horizontal motion uses gyro Z, pitch uses X. The optional Upright grip
retains Y yaw. Changing grip stops motion and clears the old frame's calibration;
Quick calibrate in the new position before pointing. This selects physical grip,
not landscape screen layout. Physical feel/direction must be accepted on device.


Remote grip sensitivity was increased after physical feedback that the initial
mapping required excessive movement: Normal4x and Fast6x relative to the original
1100px/radian gain; Slow restores the original1x for precision. Upright Normal
remains1x. Per-frame60px clamp and all stop/stillness guards remain. Known-angle
regression, TypeScript and all882app/hook tests passed. Physical comfort must
still be accepted on the replacement wrist-gain preview.


On-box preview deployment check: guide-only changes applied to the prior installed
Linux agent to avoid unrelated branch features. Service restart, ping/TLS health,
byte-identical settings, local page200, hostile-Host403, unauthenticated launch401
and the real Android phone's authenticated launch request passed. TV visibility,
four-target completion and sensitivity comfort remain physical acceptance gates;
a successful launch request alone is not proof the page appeared.
