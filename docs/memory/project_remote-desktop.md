# Project — Remote desktop: fullscreen control + absolute input + fluid streaming (portal-unified)

Status: **P1 SHIPPED (#433). Portal cursor PROVEN pixel-exact on KDE (2026-08-10).** P2 (absolute
input) + P4a (fluid capture) are now **one opt-in module** riding the SAME xdg-desktop-portal session.
Spec rewritten around the portal 2026-08-10. Absorbs `project_screenstream-module.md` (now superseded;
its MJPEG-over-WS transport survives verbatim, its capture backend is replaced by the portal).

Origin: owner, 2026-08-10 — "screen viewer → fullscreen with on-screen pad controls like RustDesk;
reduce latency so it feels fluid," then "can it be an additional option that adds more dependencies +
system access, so the feature can be used?" — yes. That opt-in IS this module.

---

## 0. The one decision that reframes everything (GROUNDED, do not relitigate)

**Wayland remote-desktop goes through `xdg-desktop-portal`, NOT raw uinput.** kwin honors the PORTAL,
not a virtual absolute uinput device — that is exactly why the raw-uinput P2 attempt failed (legacy =
no motion; modern tablet/touchscreen classify but the cursor never moves; buttons work, positioning
doesn't). RustDesk proves the approach but is **AGPL-3.0** → we borrow the mechanism, never its code.

- **ScreenCast portal** → the video (a PipeWire node).
- **RemoteDesktop portal** → the input (`NotifyPointerMotionAbsolute` / `NotifyPointerButton` / keyboard).
- **ONE session selects BOTH** (RemoteDesktop devices + ScreenCast sources) → **ONE consent dialog**
  grants input *and* capture together. Proven: our proof session got `devices:2` AND `streams:[…]`
  from a single `Start`. So P2 and P4a are not two features — they are two consumers of one session.

**PROVEN pixel-exact (2026-08-10, lenovodesktop, KDE Plasma 6 / xdg-desktop-portal 1.20.4).**
Contamination-free control run: owner parked the PHYSICAL mouse bottom-left (hands off); the portal
warped the cursor to (700,140) and (1400,140) and right-clicked; KDE's desktop context menu anchored at
≈(700,148) and ≈(1408,148) — both at our targets (~8px = menu border offset), NOT at the parked mouse.
Menu TRACKED across two distinct arbitrary targets. Driver: scratchpad `portal.py` (raw-Gio edition).

### The hard-won D-Bus recipe (this WILL bite the next person — use raw `Gio.bus_get_sync(SESSION)`)
1. **pydbus MANGLES `CreateSession`'s return** — it handed back a `/session/…` path built from
   `session_handle_token` instead of the real `/request/…` handle. `gdbus` proved the portal is
   spec-compliant. Using pydbus's bogus path as the session → `SelectDevices` "Ended" (code 2).
   **=> do not use pydbus for the portal calls.**
2. Every Create/Select/Start is **Request/Response**: the method returns a `/request/…` handle; the real
   result (incl. `session_handle`, and Start's `streams`) arrives in the async `Response` signal on that
   path. Response is delivered ONLY while a GLib main loop runs.
3. **`SelectDevices`/`SelectSources` auto-Respond in MICROSECONDS** → install the `AddMatch` rule
   **synchronously** (blocking `org.freedesktop.DBus.AddMatch` via `con.call_sync`) BEFORE issuing the
   call, or the fast Response races past `signal_subscribe`'s async AddMatch and you time out. Start is
   human-gated (seconds) so it never races. Subscribe on the predicted path
   `/request/<uniqname_with_dots_as_underscores>/<handle_token>`.
4. Response codes: 0=success, 1=cancelled, 2=ended/invalid-session.
5. Flow: `CreateSession` → `SelectDevices(types=2 POINTER)` → `SelectSources(types=1 MONITOR,
   cursor_mode=2 embedded)` → **`Start('',opts)` pops the KDE "Share your screen / Remote control"
   dialog — user clicks Share/Allow** → results `{devices:2, streams:[(node,{position,size:(1920,1080),
   source_type:1})]}`. Then `NotifyPointerMotionAbsolute(session,{},node,float(px),float(py))` (px,py =
   PIXELS in the stream) and `NotifyPointerButton(session,{},0x111,1/0)` (BTN_RIGHT=0x111, LEFT=0x110).
6. **Consent persistence — RESOLVED: version-dependent, NOT on this box → plan for per-session consent.**
   The `RemoteDesktopDialog` has a "remember" checkbox (`allowRestore`), shown only when `persistenceRequested`
   (persist_mode≠None); `remotedesktop.cpp` forces NoPersist if unticked. BUT this box's captured dialog shows
   only **Approve/Deny, no checkbox**, its text reads **"Control input devices"** (KDE master reads "Move the
   pointer and type keystrokes" → the box runs an OLDER portal-kde without the RemoteDesktop persist checkbox),
   and `restore_token` came back None. Three consistent signals → **the combined session RE-PROMPTS every agent
   session here.** Newer KDE adds the checkbox. So: attended/per-session consent is the baseline (fine — the
   user is initiating remote control of their own box, like RustDesk attended mode); silent headless reconnect
   is a NEWER-KDE bonus (tick "remember" once, replay the token), **not guaranteed**. Do NOT design around or
   claim headless. Capture (ScreenCast) persist is broader, but the unified session ties both to RemoteDesktop.

---

## 1. The two problems (unchanged framing, now both solved by the portal)
1. **Controls in fullscreen** — SHIPPED as P1 (#433): still-frame background + relative-mouse overlay
   over `/ws/gamepad`. Easy reuse; input was never the bottleneck.
2. **Fluidity + precision** — the still-frame poller is capped ~1.4 fps and relative-only. The portal
   module fixes BOTH: PipeWire capture → fluid; `NotifyPointerMotionAbsolute` → tap-to-point.

---

## 2. Current shipped state (anchors verified 2026-08-10 by a code map; couchsided.py is 19031 lines)

### Viewer / capture (still-frame poller — the fallback the module degrades to)
- `GET /api/screen` = probe-and-appear `screen_info()` (`couchsided.py:11947`), 404 hides the card.
- `GET /api/screen/frame` = one JPEG, `no-store` (`17082`), `real_screen_frame()` (`11876`): single-flight
  `SCREEN_LOCK` + 500ms cache → ~2 captures/s ceiling. Backends resolved PER CALL by `_screen_live()`
  (`11673`, degrade-closed → None); `_screen_env()` (`11701`) sets `WAYLAND_DISPLAY`/`DISPLAY`.
- Capture argv is an **allowlist**: `_grab_gamescopectl` (`11736`) / `_grab_spectacle` (`11770`) are
  literal argv LISTs; `subprocess.run([...], timeout=SCREEN_CAPTURE_TIMEOUT_S)`. **No client string ever
  reaches a subprocess** — the backend is a fixed-string switch in `real_screen_frame` (`11905`).
- `screen` cap set in `set_caps` (`1592`, `_SCREEN is not None`).

### Input (`/ws/gamepad`, already fast, RELATIVE only)
- Hand-rolled RFC6455 (`15640-15733`): `ws_send(conn,opcode,payload)` (`15717`, opcode-generic, UNMASKED,
  u16/u64 length escape, blocking `sendall`); `ws_try_parse`/`ws_recv_frame`. `WS_OP_TEXT/CLOSE/PING/PONG`
  at `15644` — **no `WS_OP_BINARY`**. Per-socket send serialized through `entry["slock"]` (`_wsend_op`
  `15780`, rationale `15742-15745`) — mandatory: a socket is written from the recv loop AND other threads.
- Route: `/ws/gamepad` dispatched at `16749`, in the **pre-auth zone** (before `_authorized()` at `16827`)
  — the handler auths itself. `_handle_gamepad_ws` (`18536`): `?token=` + `hmac.compare_digest` → 401,
  then `Sec-WebSocket-Accept`, 101, `_gamepad_session` (`18575`). Holder gate: `if not entry.get("held")`
  drops input from non-holders (`18832`). Cleanup on every exit path (`18673`).
- Mouse is **relative-only** (`{t:'m',dx,dy}` etc.). **No absolute pointer** anywhere yet.

### App (P1)
- Route `app/app/desktop.tsx` (NESTED app/ dir — not `app/desktop.tsx`). Own `GamepadClient` (`noPad:true`,
  relative mouse via `useTrackpad`); frame via `useScreenFrame` (`app/hooks/useScreenFrame.ts`) poll of
  `api.screenFrameSource` → base64 data-URI → `<Image resizeMode="contain">` in a 16:9 stage. Reached from
  `components/ScreenPreview.tsx` CONTROL pill (gated by `caps.screen`).
- `GamepadClient` (`app/lib/gamepad.ts`) is the reference WS client: IP-first/mDNS URL, connect watchdog,
  backoff reconnect, superseded-socket guard, one `sendRaw()` choke point (JSON TEXT). `base64FromArrayBuffer`
  (`api.ts:1249`) is module-private (must export for a binary consumer).

---

## 3. Architecture of the opt-in portal module (the unification)

```
 KDE Wayland session  ── ONE xdg-desktop-portal session (RemoteDesktop POINTER + ScreenCast MONITOR),
        │                 ONE consent, restore_token persisted
        ▼
 couchside-portal  (NEW helper file; python3 + gi/Gio; runs as User=<user>, session bus)
   ├─ owns the portal session (consent flow + restore_token save/replay)
   ├─ INPUT verbs  : move<x,y> / button<code,state> / key  → NotifyPointerMotionAbsolute / Button
   └─ CAPTURE      : OpenPipeWireRemote(fd) → ffmpeg(-f pipewire … -c:v mjpeg) → MJPEG frames
        │  AF_UNIX socket, 0600, user-owned  (detect-and-degrade, like _helper_call at 4731)
        ▼
 couchsided.py  (STAYS pure-stdlib, single file)
   ├─ spawns + supervises couchside-portal; _portal_call() → None only when socket absent/dead (=fallback)
   ├─ /ws/gamepad : NEW allowlisted {t:'ma',x,y} branch → forward to helper (ABSOLUTE input = P2)
   └─ /ws/screen  : NEW endpoint — reads MJPEG frames from helper → one binary WS frame each (P4a)
        │  ws + ?token=, LAN only, drop-oldest backpressure
        ▼
 app  ├─ lib/screenstream.ts  : ScreenStreamClient (binary MJPEG consumer) → newest JPEG → <Image>
      └─ desktop.tsx          : swap poll→stream when caps.screenstream; absolute-tap overlay (P2)
```

### Why a separate helper (non-negotiable)
The portal driver needs `gi`/`Gio` (PyGObject) = a **third-party Python import**, which the base agent
**forbids** (`agent stays pure Python 3 stdlib, single file`). So the portal code CANNOT live in
`couchsided.py`. It is a separate process, exactly the **privileged-helper pattern** — EXCEPT it runs as
the **user** (session bus / PipeWire / Wayland need the user session), NOT root. So: NO root, NO
`/usr/local/libexec`; a user systemd unit + a user-owned socket. This is the session-scoped variant of
`couchside-helper.py` (`agent/couchside-helper.py`, VERBS table `:359`, argv-list `_run` `:140`,
SO_PEERCRED auth `:393`) — copy its frozen-verb-table + argv-list + fail-closed discipline, drop the root.

### Two independent consumers of one session
Input needs the session UP with a stream selected (for coord space) — it does NOT need ffmpeg running.
Capture needs ffmpeg reading the node. So a phone can drive the cursor (P2) with capture idle, or stream
(P4a) without touching the pointer. One `Start`, two consumers.

---

## 4. Phases

### P1 — Fullscreen relative control — ✅ SHIPPED (#433). The permanent fallback.
No agent/API change. When the module is absent, this is what the user gets: relative mouse + ~1.4fps
still frames. Honest, always-available.

### P2 — Absolute tap-to-point (portal input) — part of the module
- Helper: input verbs → `NotifyPointerMotionAbsolute` (px in the stream) + `NotifyPointerButton`.
- Agent: `/ws/gamepad` gains an **allowlisted** `{t:'ma',x,y}` branch (x,y normalized 0..1) →
  `_portal_call("move", …)`. Additive frame; the holder gate still applies (`18832`).
- App: `sendMouseAbs(x,y)` in `gamepad.ts` (`sendRaw({t:'ma',x:q01(x),y:q01(y)})`, NEW 0..1 quantizer —
  NOT `q()` which is −1..1); a transparent tap overlay on the stage mapping touch → normalized content
  rect (mind `contain` letterbox) → `sendMouseAbs` + momentary left click.
- Coord mapping: px = x * stream_width, py = y * stream_height (agent knows the stream size from the
  helper). Pixel-exact PROVEN. **gamescope is out of scope** (Game Mode has no portal desktop session).

### P4a — Fluid MJPEG capture (portal ScreenCast) — the rest of the module
- **Capture = gstreamer, NOT ffmpeg** (PROVEN: this box's ffmpeg has no `pipewiregrab` filter; gstreamer has
  `pipewiresrc` + `jpegenc`). Helper: `OpenPipeWireRemote(session,{})` via `call_with_unix_fd_list_sync` →
  unix fd → `gst-launch-1.0 -q pipewiresrc fd=<fd> path=<node> ! videorate ! video/x-raw,framerate=20/1 !
  videoconvert ! jpegenc quality=<q> ! fdsink` spawned with `Popen(..., pass_fds=(fd,))` → MJPEG to the agent.
  argv is a LIST built from an **allowlisted profile enum** (e.g. `720p20` = cap-height 720 / q~85 / 20fps);
  the client only names a profile KEY, never a resolution/filter string. One-frame proof used `num-buffers=1
  ! jpegenc ! filesink` → a valid 1920×1080 JPEG.
- Agent `/ws/screen` (NEW): add `WS_OP_BINARY=0x2` (`15644`); dispatch in the pre-auth zone right after
  `/ws/gamepad` (`16751`); `_handle_screen_ws` mirrors `_handle_gamepad_ws` (same `?token=` +
  `compare_digest`, handshake); `_screen_session` builds `entry={conn,slock}`, reads MJPEG (split on
  `\xff\xd8…\xff\xd9`), keeps ONLY the newest JPEG in a single slot (drop-oldest — blocking `sendall`
  means a slow phone MUST fall behind, never queue), sends `_wsend_op(entry,WS_OP_BINARY,jpeg)`; recv loop
  handles the `{t:'start',profile}` control frame + disconnect; `finally` REAPS the helper's capture
  (a leaked encoder keeps filming the screen — privacy failure). A per-server stream cap (like
  `SCREEN_LOCK` single-flights the poll path) so N phones can't spawn N encoders.
- App: `lib/screenstream.ts` = stripped `GamepadClient` copy but `/ws/screen`, **`ws.binaryType =
  'arraybuffer'`**, onmessage → `isUsableBodySize` → `base64FromArrayBuffer` (export it) → data-URI, keep
  only newest, fire `onFrame`. `useScreenStream(settings,active)` returns the SAME `{frame,failed,lastGood}`
  as `useScreenFrame`; `desktop.tsx:50` branches on `caps.screenstream`. Separate socket from input.
- **P4b (H264/VAAPI) stays deferred** — forces `react-native-webrtc`/native decoder into EVERY app build.
  MJPEG decodes with the existing `<Image>` → no new app native dep. Lead with P4a.

### P3 — (folded) faster still-frames — only if the module can't be installed; not a priority now.

---

## 5. The `screenstream` capability — all SIX edit sites (CLAUDE.md §4; enforced by test_protocol_parity.py)
Linux-only (Wayland portal path) → goes in `linuxOnlyCapabilities`, NOT the cross-platform group, and
must NOT be added to `agent/win/couchsided-win.py` (parity's "leaked" branch asserts its absence there).
1. Agent real dict `set_caps` `couchsided.py:1587-1618` → `"screenstream": safe(screenstream_available),`
   before the `}` at 1618 (define `screenstream_available()`: static probe = helper installed + ffmpeg +
   pipewire + persisted token; returns False on any failure = degrade closed).
2. Agent mock tuple `couchsided.py:1580-1585` → append `"screenstream"`.
3. App `BoxCaps` `app/lib/api.ts:80-207` → `screenstream?: boolean;` at EXACTLY 2-space indent (parity
   regex `^\s{2}([a-z_]+)\??:`). Optional `?` — old agents omit it.
4. App `normalizeCaps` `app/lib/settings.ts:218-302` → `const screenstream = bool('screenstream');` AND add
   it to the RETURN object (295-301). **Omitting the return entry is the classic silent bug** (parses,
   never persists, app re-probes forever).
5. App `capsEqual` `app/lib/api.ts:1157-1184` → `&& a.screenstream === b.screenstream`.
6. `protocol/protocol.json` `linuxOnlyCapabilities.keys` (`:176-194`) → `"screenstream"` after `"player"`.

**Gating nuance:** `caps.screenstream` may FLIP with the Game↔Desktop session (portal needs a desktop
session). If so, gate the fluid viewer via a LIVE `usePoll(api.status)` like `caps.desktop` does
(`app/app/(tabs)/pad.tsx:1336`, `deskPoll`), not persisted `settings.caps`. The endpoint ALSO degrades
closed on `_screen_live() is None` regardless of the cap — cap is the hint, the live probe is the truth.

---

## 6. Distribution / install / consent (precedent: the privileged helper + ujust; map 3)
- Base agent stays pure-stdlib; base `install.sh` unchanged. The helper + units + a deps step ship via the
  **signed release channel**: add the new files to `scripts/release-agent.sh` `files[]` (like the
  `couchside-helper.{py,socket,service}` trio) so they land in `SHA256SUMS` and get Ed25519-signed;
  `install.sh` verifies against the two embedded pubkeys; **system/root code present-but-not-in-the-signed-
  manifest is DROPPED**, and it must `py_compile`. Front door = an installer flag and/or a
  `ujust get-couchside` action (status|install|uninstall).
- Install: user systemd unit for `couchside-portal` (User=<user>, NOT root; ProtectHome would BREAK it —
  it needs the session bus). Install ffmpeg/pipewire (or verify present — Bazzite ships pipewire; ffmpeg
  is common). On immutable/ostree distros there is no pip/rpm path (the whole reason the base is stdlib) —
  the deps step must handle-or-honestly-refuse. **Uninstall must remove every artifact** (unit, socket dir,
  the persisted portal token, deps marker) — a hard ujust-PR requirement.
- Consent: **per-session on this box's KDE** (no persist checkbox — §0.6). Still pass `persist_mode=2` and
  save/replay any `restore_token` for newer KDE that offers it, but design the UX for a click each session
  (the phone triggers a "approve on the box" prompt; honest copy: "your box will ask you to allow this").

---

## 7. Constraints (do not violate)
- Base agent pure-stdlib single file → the portal driver is a SEPARATE process; NO third-party Python in
  `couchsided.py`. This ALSO rules out `aiortc`/WebRTC → MJPEG over the hand-rolled WS (P4a), never full
  WebRTC.
- **Allowlist (§3):** the encoder profile and every input verb are dict-key LOOKUPS from frozen tables;
  argv is always a LIST, never `shell=True`, never a formatted command string. A client names a profile
  KEY / sends `{t:'ma',x,y}` (numbers) — no client string reaches ffmpeg, the portal, or a shell.
- **Input path is safety-critical (§4):** `{t:'ma'}` is additive on `/ws/gamepad`, behind the existing
  holder gate. Do NOT put pixel traffic on the input socket; `/ws/screen` is a SEPARATE socket and a
  SEPARATE app client. Do not refactor the gamepad lifecycle.
- Response shapes additive-only; `screenstream` = all six sites or it never persists.
- Degrade closed: no module / no desktop session / no token → still-frame poller (P1), never a black or
  guessed stream, never a fake "moved" cursor.
- Reap the encoder on EVERY `/ws/screen` exit path (a leaked ffmpeg keeps filming the screen).

## 8. Verification plan (device-only; the harness has no real screen, no WS video proxy)
- Portal input: PROVEN (cursor→menu, contamination-free). Re-prove after the helper refactor.
- Capture: **measure real fps + end-to-end latency** (capture→encode→WS→decode→paint) BEFORE any "fluid"
  copy. Target ~15–25fps / ~100–250ms. The last remote-desktop claim was tempered precisely because
  ~1.4fps isn't fluid; hold this to a MEASURED number.
- Observe BOTH states (§11): cap fires (module present → fluid + tap-to-point) AND does not (absent →
  P1 poller + relative). A detector seen firing only once is unverified.
- Backpressure: a slow/paused consumer must fall BEHIND (drop frames), never accumulate latency/memory.
- Consent persistence: tick "remember" once, restart, confirm silent-or-reprompt (§0.6).
- Security pass: new "video of your screen" + absolute-input flow — token-authed, LAN-only, holder-gated
  input, encoder argv agent-built, helper socket user-owned + peer-checked, no CORS.
- Tests: `/ws/screen` auth-fail (401, no handshake); unknown-profile → fallback/refuse (no arbitrary argv);
  subprocess lifecycle (connect→frames→disconnect→reaped) + drop-on-backpressure; `{t:'ma'}` non-allowlisted
  guard; the six-site cap parity (`python3 tests/test_protocol_parity.py`).

## 9. Open questions (decide on hardware)
- ~~restore_token headless~~ RESOLVED (§0.6): per-session consent on this box; headless is a newer-KDE bonus.
- ~~ffmpeg vs gstreamer~~ RESOLVED: gstreamer `pipewiresrc ! jpegenc` (box ffmpeg lacks pipewiregrab). Helper
  owns capture (OpenPipeWireRemote fd + gst), streams JPEGs to the agent → keeps `couchsided.py` stdlib.
- Capture-while-idle-input: confirm the ONE session serves gst capture AND portal input concurrently (both
  proven separately; test simultaneously — should be fine, they're independent consumers of the session).
- Keyboard over the portal (KDE historically incomplete) — POINTER first; add KEYBOARD device only if kwin
  honors it (verify). Text entry can stay on the existing uinput keyboard meanwhile.
- Profiles: start `720p20` (q6). Bandwidth/CPU of MJPEG at 20fps on the box — measure.
- gamescope Game Mode: explicitly OUT (no portal desktop session; in-game fluid = Steam Remote Play).
- Multi-phone: one portal session, one holder for input; capture could fan out but bound the encoder count.
