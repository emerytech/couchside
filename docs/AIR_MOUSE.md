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
and cancelled click suppression. TypeScript,876app/hook tests,20crypto tests and
web export passed at the initial checkpoint. Local UI expansion/sensitivity were
exercised. Browser mocks cannot certify native sensor or touch behavior.

## Remaining gates

Native Android/iOS on LG and box: axis direction, drift/precision, calibration,
hold/release, denied/missing sensor, rotation/background/return, target change,
ownership handoff and disconnect during handshake; click and touchpad scroll.
Verify no listener/movement survives release or blur. New native binaries are
required for expo-sensors. Final artifacts require focused acceptance and new
channel build numbers before any authorized release.
