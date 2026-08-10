# Project — Screen-stream module (P4a): fluid remote desktop, as an OPT-IN add-on

Status: **SPEC.** Not built. Written 2026-08-10.
Origin: owner wants the screen viewer to feel **fluid** ("like RustDesk"), and agreed it should be
"an additional option that adds more dependencies to the install and more system access to enable
the feature." This is the P4a tier of `docs/memory/project_remote-desktop.md` (P1 shipped in #433).

> **One-line thesis:** keep the base agent pure-stdlib and the base install untouched; ship an
> **opt-in module** that installs a few system packages + grants screencast access and, when present,
> streams the **KDE desktop** as MJPEG-over-WebSocket (~15–25 fps) — decoded on the phone with the
> `<Image>` it already has (no new app native dependency). The app degrades to the P1–P3 still-frame
> poller whenever the module is absent.

---

## 1. Why an opt-in module (and why THIS shape)

- **The base agent stays pure-stdlib, single file.** The module never adds a third-party *Python*
  import. It orchestrates a **subprocess** (ffmpeg/gstreamer/pipewire) via the existing argv allowlist
  (§3) — exactly how the current capture already shells out to gamescopectl / spectacle / ffmpeg.
- **The "more deps + access" is real and belongs behind an opt-in.** Fluid capture needs a continuous
  screencast (PipeWire portal or a wlroots grabber) + a hardware/software JPEG encoder. Those are
  SYSTEM packages and a **portal permission**, not something to force on every install.
- **The app-side decoder cost is why P4a, not P4b.** One app binary ships to everyone. **MJPEG**
  decodes with the `<Image>` component already in the app → **no new native dependency**. H264/VP8
  (P4b) would force `react-native-webrtc` (or a native player) into *every* build for a feature only
  opt-in users touch. P4a keeps the whole thing cleanly optional end-to-end.

## 2. Grounding facts (measured on real boxes 2026-08-10)

- Current viewer = still-frame poller. `GET /api/screen/frame` → one downscaled JPEG (960px, q80) per
  HTTP GET. On the work box (10.7.0.200, gamescope) a frame is a valid 960×540 JPEG (~61 KB) in ~1.2s;
  server floor ~2 captures/s (`SCREEN_MIN_INTERVAL_S=0.5` + 500 ms cache). **Ceiling ~1.4 fps.** The
  4K `gamescopectl screenshot` write is **async ~1.5s** (this bit me — KI-058 was a false alarm; there
  is NO capture bug). Capture is healthy on both boxes.
- Input is a SEPARATE `/ws/gamepad` WebSocket (`lib/gamepad.ts` ↔ `/dev/uinput`), already low-latency.
  Video and input are different channels and stay that way.
- **Session matters.** gamescope Game Mode has no wlr-screencopy and `gamescopectl` is one-shot only →
  no cheap continuous capture there. The **KDE Plasma desktop session** DOES have PipeWire screencast
  (`xdg-desktop-portal-kde`) and wlroots-style grabbers. Remote *desktop* is a desktop-session activity
  (you switch to Desktop Mode to use a mouse), so **P4a targets the KDE desktop session**; Game Mode
  stays on the still-frame poller (fluid in-game = Steam Remote Play's own encoder, out of scope).

## 3. Architecture

```
 KDE desktop (Wayland)                          Agent (pure stdlib)                 Phone app
 ┌───────────────────┐   PipeWire screencast    ┌──────────────────────┐   MJPEG    ┌────────────┐
 │ compositor        │─────────portal──────────▶│ ffmpeg (subprocess)  │   frames   │ WS client  │
 │                   │   (or wlr grabber)        │  → mjpeg to stdout   │══over WS══▶│ → <Image>  │
 └───────────────────┘                           │  agent frames each   │  /ws/screen │  per frame │
                                                 │  JPEG onto the WS    │            └────────────┘
                                                 └──────────────────────┘
```

### 3a. Capture backend (the one real unknown — decide on hardware)
Candidates, best-first for a KDE Wayland session:
1. **PipeWire screencast portal** (`xdg-desktop-portal` `org.freedesktop.portal.ScreenCast`) → a
   PipeWire node → ffmpeg `-f pipewire`/gstreamer `pipewiresrc` → MJPEG. Most "correct" on Wayland,
   honors the portal permission (the opt-in "more access"). Caveat: the portal usually needs a
   **one-time user grant** (a picker dialog) — the module install is where that consent lives; the
   session token can be **persisted** (portal `persist_mode`) so it doesn't re-prompt.
2. **wlroots grabber loop** (`grim`/wlr-screencopy in a tight loop). Simpler, but each `grim` is a full
   frame grab (~tens of ms at low res) — reaches maybe 10–15 fps of small JPEGs. No encoder needed.
   NOT available under gamescope. Fine on wlroots-based sessions.
3. **ffmpeg `kmsgrab`** (grabs the KMS framebuffer). Fast + universal, but needs `CAP_SYS_ADMIN` — the
   heaviest "more access." A last resort, gated hard.
Encoder: MJPEG (`-c:v mjpeg`) is CPU-cheap and needs no GPU; resolution + quality + fps are chosen by
the AGENT from an allowlisted enum (e.g. 720p / q6 / 20fps), never a client string (§3).

### 3b. Transport — MJPEG over the existing hand-rolled WebSocket
- New endpoint **`/ws/screen`** (token-authed, LAN-only, same RFC6455 code the gamepad WS uses). NOT
  the gamepad socket — keep video off the input channel.
- The agent reads whole JPEGs from the encoder's stdout (MJPEG = `FFD8…FFD9` delimited) and sends each
  as **one binary WS frame**. Backpressure: if the socket is slow, DROP the oldest frame (never queue —
  a laggy phone must fall behind, not accumulate latency).
- Client sends a small control frame to start/stop + request a profile (`{t:'start', profile:'720p20'}`
  from an allowlisted set); everything else is server-chosen.
- **No full WebRTC.** ICE/DTLS/SRTP would need `aiortc` (third-party Python = forbidden). MJPEG-over-WS
  needs none of it.

### 3c. App side
- A new WS consumer (mirror the `lib/gamepad.ts` client shape) that receives binary JPEG frames and
  feeds the newest to an `<Image>` (base64 or blob URL). **No new native dependency.**
- The `/desktop` route (P1) already has the frame surface + trackpad + control bar — it just swaps its
  poll for the stream when the module is present. Input still goes over `/ws/gamepad` unchanged.

## 4. Gating — caps + probe-and-appear (degrade closed)
- New capability key **`caps.screenstream`** = the module is installed AND a capture backend works.
  This is a CAPABILITY KEY → **all six edit sites** (agent CAPS dict + mock tuple; app BoxCaps +
  normalizeCaps + capsEqual; `protocol/protocol.json`; `tests/test_protocol_parity.py` enforces it).
- The app shows the **fluid** viewer only when `caps.screenstream` is true; otherwise it uses the
  P1–P3 still-frame poller. A box without the module looks exactly like today — **never a guess**.
- `/api/screen` may also advertise the stream (`stream:true`) additively, but the cap is the gate.

## 5. Opt-in install + access (precedent: Decky channel, the privileged helper)
- A **separate install step**, NOT base `install.sh`: a `ujust` recipe (Bazzite) / an installer flag /
  the signed helper channel. It: installs `ffmpeg` (+ `pipewire`/portal if missing), registers the
  screencast portal grant (persisted token), and enables the stream endpoint.
- Documented, **off by default**, uninstallable. Copy is honest: LAN-only, desktop-session, and it
  captures your screen continuously while active.
- Distribution mirrors the signed helper / Decky release channel, not the always-shipped installer.

## 6. Security (a new "video of your screen" flow)
- Same model as everything else: **token-authed, LAN-only**, no cloud. Frames are never written to disk
  (like the current `no-store`).
- The module GRANTS more: continuous screencast + an encoder subprocess. That access is the *point* of
  the opt-in, and it is where the consent lives. Needs a security pass (a new WS endpoint that streams
  screen contents; confirm it is holder-gated like input, or at least token-gated, and that a stream
  can't be started by a non-authed client).
- §3 intact: the encoder argv is agent-built from an allowlisted profile enum; no client string reaches
  a shell or the ffmpeg args.

## 7. Verification plan (device-only; measure before you claim "fluid")
- **Not harness-verifiable** — the harness has no real screen and no WS video proxy. Verify on a real
  KDE-desktop box with the module installed.
- **Measure real fps + end-to-end latency** (capture→encode→WS→decode→paint) before ANY "fluid" copy.
  The last remote-desktop claim was tempered precisely because ~1.4fps isn't fluid; hold this one to a
  measured number (target ~15–25fps, ~100–250ms).
- **Observe both states:** module present → fluid; module absent → the still-frame poller, honestly
  (the cap must fire AND not fire).
- Backpressure test: a slow/paused consumer must fall BEHIND (drop frames), never accumulate latency or
  memory.

## 8. Constraints (do not violate)
- Base agent pure-stdlib, single file. Module = subprocess + argv allowlist; **no third-party Python**
  (rules out aiortc → no full WebRTC).
- Response shapes additive-only; `caps.screenstream` = all six edit sites (§4).
- Degrade closed: no backend / not installed → still-frame poller, never a black or guessed stream.
- App decoder = `<Image>` JPEG only (P4a). Anything needing a native decoder is P4b and forces an
  app-wide dep — a separate decision.
- Input path untouched: video is `/ws/screen`, control stays `/ws/gamepad`.

## 9. Open questions (decide on hardware / with the owner)
- **Capture backend:** PipeWire portal (correct, needs a persisted grant) vs wlr grabber loop (simpler,
  wlroots-only) vs kmsgrab (fast, heavy access). Pick per what the box's KDE session actually exposes.
- **Portal consent UX:** the first ScreenCast grant is a desktop dialog on the box's TV — how is that
  handled headlessly at install (persist the token) vs on first stream?
- **Profiles:** the allowlisted resolution/quality/fps set (start conservative: 720p/q~6/20fps).
- **gamescope Game Mode:** explicitly out of P4a (no cheap continuous capture). Revisit only if someone
  needs in-game fluid beyond Steam Remote Play.
- **Endpoint:** new `/ws/screen` vs multiplex on an existing socket (recommend a dedicated socket).
- **P4b later?** If MJPEG's bandwidth/CPU is unacceptable, H264/VP8 + `react-native-webrtc` is the
  upgrade — but that is an app-wide native-dep decision, its own project.

## 10. Suggested build order
1. Agent: `/ws/screen` + an ffmpeg-MJPEG subprocess against ONE backend (start with a wlr grabber loop
   or PipeWire portal, whichever the test box exposes) + the `caps.screenstream` six-site cap + a
   device/subprocess lifecycle test (start → frames → stop → reap; drop-on-backpressure).
2. App: a `/ws/screen` client + swap the `/desktop` frame source to the stream when the cap is set.
3. The opt-in installer step (deps + portal grant) + docs.
4. On-box: measure fps/latency, tune the profile, confirm degrade-closed, security pass.
