# Project — Remote desktop: fullscreen viewer + on-screen controls + (optional) fluid streaming

Status: **SPEC.** P1 in progress (`claude/remote-desktop-p1`); P2–P4 planned.
Origin: owner, 2026-08-10 — "screen viewer, when clicked, opens fullscreen with on-screen pad
controls to control the desktop like remote desktop / RustDesk; reduce latency so it feels fluid,"
then: "can P4 be an additional option that adds more dependencies to the install and more system
access, so the feature can be used?" — yes; P4 is an **opt-in module** (see below).

Supersedes/absorbs the old ROADMAP "Remote desktop screenshot + tap" entry.

---

## 1. The two problems (they are different)

1. **Controls in fullscreen** — click the viewer → fullscreen frame + an on-screen control layer
   (trackpad + buttons) that drives the desktop. **Easy: reuse.** The input path already exists.
2. **Fluidity / low latency** — make it feel like RustDesk. **Hard: architectural.** The current
   viewer is a still-frame poller capped ~1.4 fps; fluid needs a new capture→encode→transport stack.

Input is NOT the bottleneck — it is already low-latency. **Video is.**

---

## 2. Current state (mapped 2026-08-10, file:line)

### Viewer (still-frame poller)
- `GET /api/screen` — probe/info (`couchsided.py:17026`), body `{available, session, backends,
  formats:["image/jpeg"]}` (`screen_info()` `11901`). **No width/height.** 404 → app hides the card.
- `GET /api/screen/frame` — ONE JPEG (`17036`), Bearer header only, `Cache-Control: no-store`.
  Capture (`real_screen_frame()` `11830`): `gamescopectl screenshot` (~1.4s, 4K PNG) in Game Mode
  (`_grab_gamescopectl` `11690`) / `spectacle -b -n -o` JPEG (~0.7s) on KDE (`_grab_spectacle` `11724`);
  downscale via `magick`/`ffmpeg` to `SCREEN_WIDTH=960` q80 (no PIL, off immutable rootfs). Decode dominates.
- Server floor ~2 captures/s: `SCREEN_MIN_INTERVAL_S=0.5`, single-flight `SCREEN_LOCK`, 500ms cache.
  **Measured ceiling ~1.2–1.4 fps** (ROADMAP/BUILD_LOG; ~0.41s of every frame is spectacle's Qt startup).
  **No MJPEG/chunked/WebSocket stream path.** `caps.screen` exists (`1592`) but ScreenPreview probes
  `/api/screen` directly, not the cap.
- App: `components/ScreenPreview.tsx` — poll `1000ms` (`700ms` in the tap→`<Modal>` fullscreen), OFF by
  default, fetches `api.ts:screenFrameSource` (base64 data-URI, Bearer header, `?t=` cache-bust),
  `<Image resizeMode="contain">`. On the Console tab (`(tabs)/index.tsx:373`). `lib/immersive.ts`
  fullscreen store exists; NO fullscreen route (the "fullscreen" today is the in-component Modal).

### Input (separate, already fast)
- One `/ws/gamepad` WebSocket, client = `lib/gamepad.ts` (NOT api.ts). Mouse is **relative-only**
  (`{t:'m',dx,dy}`, coalesced ~90Hz `MOUSE_MOVE_INTERVAL_MS=11`), buttons `{t:'mb',k,v}`, wheel
  `{t:'mw',dy}`, keys `{t:'k',key}` / `{t:'kt',text}`. Senders `sendMouseMove/Button/Wheel/Key/Text`,
  `sendDesktopKey('meta'|'overview')`.
- Injection: direct `/dev/uinput` evdev writes behind frozenset allowlist `_MOUSE_TYPES/_KEYBOARD_TYPES`
  (`_gamepad_message` `18764`), decoders `mouse_events` `12610` / `keyboard_events` `12635`. §3-clean,
  compositor-agnostic. Input dropped unless the session holds control (`18786`); devices lazy-created.
- **No absolute pointer** anywhere (protocol or device — EV_REL only, `12402`). BUT absolute pointer was
  PROVEN pixel-exact on Plasma Wayland in a past screenshot-diff experiment (needs an EV_ABS device +
  BTN_TOUCH to suppress a phantom js0). Reusable primitives: `hooks/useTrackpad` (relative mouse
  PanResponder), `components/RemoteView` (trackpad + click/scroll/meta/overview/esc over the client).

---

## 3. Phases

### P1 — Fullscreen control mode (app-only, ship-now) — THIS BRANCH
Click the screen viewer → a landscape, immersive fullscreen view: the live frame as background +
a control overlay (trackpad for relative mouse, left/right click, scroll, a small key row, keyboard
toggle) driving the existing `/ws/gamepad` client. Reuses `useTrackpad` + RemoteView's mappings +
`immersive.ts` + `useLockOrientation('landscape')`. Frame keeps polling at the fullscreen cadence.
- No agent change, no API change, no new dep.
- Relative-mouse control at ~1.4fps = "confirm-by-frame": good for click/close/type, not motion.
- **Verification reality:** the frame/layout/fullscreen IS harness-verifiable; the CONTROLS are not
  driveable by real touch (RN-Web = mouse, and the gamepad WS is not proxied). Use the CONVENTIONS
  fake-WebSocket harness pattern (in-page fake WS that PONGs every frame; assert the `send()`ed input
  frames) to prove the overlay emits the right `{t:'m'/'mb'/'mw'/'k'}` frames; the feel needs a device.

### P2 — Absolute tap-to-click (agent + app, medium)
Tap a point on the frame → pointer goes there. Add: EV_ABS uinput mouse (+BTN_TOUCH), a `{t:'ma',x,y}`
protocol frame (ADDITIVE, six-site cap if gated), width/height on `ScreenInfo`, tap→coordinate mapping
(frame is `contain` → letterbox math), and **frame-age gating** so a stale frame can't cause a confident
wrong click. Proven on Plasma; **gamescope unproven** → needs a zoom or two-stage crosshair (a 44pt
finger ≈ 289 logical px on a 4K desktop vs a ~100×30px button). Makes P1 feel like real remote desktop.

### P3 — Faster frames (agent + app, medium)
Smaller region/res + stream frames (MJPEG multipart or WS-framed JPEG) instead of one HTTP GET each.
Realistic ~5–10 fps of small JPEGs. Better for control; still not "fluid."

### P4 — Fluid hardware-encoded video, as an OPT-IN MODULE (the "RustDesk" answer) — HIGH/large
Owner: "an additional option that adds more dependencies to the install and more system access." This
is the correct shape and it fits the constraints:
- **Core agent stays pure-stdlib single-file.** No third-party PYTHON. The module SHELLS OUT to system
  binaries (gstreamer/ffmpeg/pipewire) via the existing argv allowlist — same as today's capture. Extra
  DEPS are SYSTEM packages the user opts into, not pip/bundled python.
- **Gated by caps + probe-and-appear.** New `caps.screenstream` (six edit sites, §4) → the app shows the
  fluid viewer ONLY when the module is present; else it degrades to the P1–P3 still-frame poller. Never a guess.
- **Opt-in deps + access** (precedent: Decky channel, the privileged helper). A separate install step /
  `ujust` recipe installs gstreamer+VAAPI+pipewire and grants the PipeWire **screencast-portal**
  permission (maybe a unit/helper). "More access" (continuous capture + HW encoder) is explicit,
  documented, off by default — distributed like the signed helper, NOT base `install.sh`.
- **Transport avoids the forbidden bit.** No full WebRTC (ICE/DTLS/SRTP → needs `aiortc` = third-party =
  FORBIDDEN). Use H264/VP8- or MJPEG-**over the existing hand-rolled RFC6455 WebSocket**: encoder
  subprocess stdout → framed to the WS.
- **The ASYMMETRY that decides sub-tiers.** The BOX side is cleanly opt-in, but the APP-side decoder is
  NOT per-box optional — one app binary ships to everyone:
  - **P4a (LEAD WITH THIS): MJPEG "fast-capture" module.** pipewire continuous grab → small JPEGs over
    WS. Opt-in box deps + screencast access, ~15–25 fps, and **NO new app native dep** (JPEG decode reuses
    `<Image>`). Most of the "fluid" win, cleanly optional end-to-end.
  - **P4b (max): H264/VAAPI stream.** True 30–60fps / ~50–150ms, but forces `react-native-webrtc` (or a
    native H264 player) into EVERY app build (bloat + iOS build surface) even for non-users.
- gamescope continuous capture is unproven (gamescopectl is one-shot — may be desktop-session-only).
- New "video of your screen" data flow → a security pass (token-authed, LAN-only, opt-in consent).

---

## 4. Constraints (do not violate)
- Agent: pure-stdlib, single file. New capture/encode = argv-allowlisted subprocess, never a shell string
  or client-supplied command (§3). No third-party python (rules out aiortc → no full WebRTC).
- Input path is safety-critical (§4). P1's overlay drives DESKTOP mouse (relative) — lower stakes than the
  d-pad latch, but still uinput; keep it behind the existing control/handoff gate.
- Response shapes additive-only. `caps.screenstream` if added = all six edit sites.
- Never `caps`-gate what should probe-and-appear; degrade closed (no module → still-frame poller, honestly).
- RN has no native `<video>`/WebRTC — any decoder is a NEW native dep that ships to ALL app users (the P4a/P4b split).

## 5. Verification plan (and how the harness lies)
- Frame display / fullscreen / landscape / immersive: harness-verifiable (screenshot + layout).
- **Controls: the gamepad WS is NOT proxied in the harness and RN-Web emits mouse, not touch.** Use the
  fake-WebSocket pattern (CONVENTIONS "Harness wire-proof for gamepad surfaces"): an in-page fake WS that
  PONGs every frame; read the `send()`ed frames and assert the overlay emits the right input JSON. The
  actual feel + tap-to-click accuracy (P2) need a device (`adb`/screencap; a real box answers `/api/screen`).
- P4 streaming: device-only against a box with the module installed; also measure real fps + latency before
  any "fluid" copy (the last remote-desktop claim was tempered precisely because ~1.4fps isn't fluid).

## 6. Open questions
- P1: does the fullscreen viewer open its OWN `/ws/gamepad` client (handoff with the Pad tab) or share one?
  (Leaning: own client, opened on enter / closed on exit, request control — you ARE the controller while in it.)
- P2: gamescope absolute mapping (zoom vs two-stage crosshair); frame-age threshold.
- P4: encoder availability per box (VAAPI vs software); gamescope continuous capture; module distribution
  channel (ujust recipe vs installer flag vs signed helper); audio? clipboard? (scope to screen+input first).
