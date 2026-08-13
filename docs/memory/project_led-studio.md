# Project: LED Studio — editor, presets, effects, persistence, OpenRGB

> **✅ SHIPPED 2026-08-13 — app 2.9.46 / agent 2.9.86, tag v2.9.46 (full release chain).**
> Marquee = the addressable `valve-leds` strip driven by the box's FIRMWARE effects
> (scanner→patrol survives app-close/reboot) + manual per-LED paint + pattern presets,
> HARDWARE-PROVEN on a real Steam Machine. PRs #450/#451/#452 merged; agent signed +
> published, iOS in App Store review, Android in Play production. OpenRGB still
> mock-server-only (no real daemon). Next: TLS app track (see `tls-encryption-p1` memory).

**Owner ask (2026-08-13):** the LED control "works good on Steam Machine but I'd like to
build it out" — an easier in-app editor, saved custom presets, automation/effects (a
"night rider" KITT scanner named as the example), and survive reboot (a reboot currently
reverts to stock LED). Follow-up: "make it OpenRGB-compatible … configure system LEDs
straight from the phone."

**Decisions (asked 2026-08-13):**
- **Scope:** *both in one push* — kernel-LED buildout AND OpenRGB together.
- **Night rider:** *addressable → real sweep* — the owner has addressable / motherboard RGB
  and wants a real dot sweeping. A single front bar can only breathe/pulse; a true scanner
  needs multiple zones/LEDs ⇒ **OpenRGB is required for the real scanner**.
- **Editor UX:** *native sliders* (hue / brightness). Sliders are drag = NOT harness-
  verifiable (CLAUDE.md §6) → must be proven on a real device before ship.

This supersedes the "OpenRGB fallback: deferred" line in ROADMAP and the LIGHT-card
follow-ups. Prior art: the LIGHT card + `/api/leds` (cap `ledcontrol`, agent 2.9.81) and
the audio switcher's mock-observable allowlist-switch pattern.

---

## Architecture at a glance

Two LED backends, one app surface:

1. **Kernel LED backend** — `/sys/class/leds` (the existing `ledcontrol` path). The box's
   front bar / status LED. One-shot color+brightness today; this project adds an **effect
   engine** (a background thread that animates it) + **persistence** (re-apply on boot).
   Works on the owner's Steam Machine TODAY, zero new box deps.
2. **OpenRGB backend** — a hand-rolled stdlib SDK client speaking the OpenRGB binary
   protocol to a local `openrgb --server` on 127.0.0.1:6742. Whole-system RGB (motherboard,
   RAM, GPU, strips, fans) with per-LED control ⇒ the real multi-zone scanner. NEW box
   dependency (install OpenRGB + run its server + i2c/hidraw udev perms). Install-gated:
   cap `openrgb` appears only when the server answers.

The **effect engine** is backend-agnostic: one `led-fx` daemon thread owns the "current
effect" (type + params + target) and renders frames by calling either backend's write.
Setting a new effect replaces the running one. `solid` = no animation (one write, thread
idle/stopped). Effects: `solid`, `breathe`, `pulse`, `rainbow`, `strobe` (all backends),
`scanner` (OpenRGB / multi-LED only — degrades to `pulse` on a single LED).

**Persistence:** the active effect+params are written atomically to
`~/.config/couchside/leds.json` on every change (the fdopen/rename pattern at
couchsided.py:692; sibling of `screensaver.conf`/`player.conf`). At agent startup a
`led-restore` step reads it and re-applies (restarts the effect thread). The agent is a
systemd **user** service → "survive reboot" = re-apply on login. Between boot and agent
start the LED shows firmware default briefly (acceptable; documented).

**Caps:** keep `ledcontrol` (gates the whole LIGHT surface). Effects/presets/persistence
ride on **new fields in the `/api/leds` payload** (`effects: [...]`, `active: {...}`), NOT
a new cap — the app reads them to decide whether to show effect controls (probe-and-appear
at payload level; old app ignores unknown fields). Add exactly **one** new cap: `openrgb`
(a distinct, install-gated subsystem the app must know about without 404-probing). One new
cap = the six-site dance runs once (§4).

**Presets:** the user's named-preset *library* lives **app-side** (`couchside.ledpresets.v1`
in AsyncStorage, per phone — the note.ts / consoleLayout pattern). Applying a preset POSTs
the color/effect to the agent; the agent remembers the *last applied* state as the
boot-restore. (Box-side library sync across phones = deferred backlog.)

---

## Allowlist / security design (CLAUDE.md §3 — zero tolerance)

- **Effect names are a frozen set** (`_LED_EFFECTS`), looked up, never interpolated. Unknown
  → 400, nothing runs.
- **Effect params are range-checked and rejected** (not sanitised): speed ∈ frozen set or
  int 1..100; colors are `{r,g,b}` 0..255 (reuse `_validate_led_body`'s colour check);
  target LED name looked up in the live `/sys/class/leds` set exactly as today.
- **The effect thread only ever calls the existing validated writers** (`set_led` /
  `_led_write` fixed literals, or the OpenRGB client's bounded per-LED writes). No new raw
  path is exposed.
- **OpenRGB client is loopback-only** (127.0.0.1:6742), no auth needed on localhost, and every
  write is bounded by the server-reported controller/zone/LED counts — a client-supplied
  device index is looked up against the enumerated count and 404s otherwise. The app never
  names a socket, host, or command string.
- **`openrgb` is never shelled with `shell=True`.** If we ever launch/start the server it is
  an argv LIST with a fixed binary chosen by the agent. (v1 does NOT auto-start the server;
  it only connects if one is already listening — degrade closed.)
- **Persistence file is user-owned, atomically written, validated on read** — junk → drop to
  firmware default, never a write of attacker-controlled bytes.
- Every new route requires the bearer token; none are pre-auth.

---

## Endpoints (all bearer-gated; `--mock` observable)

Kernel + effect engine (cap `ledcontrol`):
- `GET  /api/leds` — EXISTING; **extend** payload with `effects` (supported effect ids) and
  `active` (the running effect+params per LED, from persistence). Additive only (§4).
- `POST /api/leds/set` — EXISTING; unchanged (solid color/brightness). Setting a solid also
  stops any running effect on that LED and updates persistence.
- `POST /api/leds/effect` — NEW. Body `{led, effect, color?|colors?, speed?, brightness?}`.
  Starts/replaces the effect on `led`; `effect:"solid"` or `"off"` stops it. Persists.

OpenRGB (cap `openrgb`):
- `GET  /api/openrgb` — enumerate controllers → `[{index, name, type, zones:[{name,leds}],
  led_count}]` + `{available, server}`. Empty/unavailable when no server.
- `POST /api/openrgb/set` — `{device, color?|per_led?, effect?, speed?, brightness?}`.
  `device` looked up against the enumerated count. Static color, or start an effect
  (scanner/rainbow/etc.) driven agent-side per-LED. Persists.

App: `RgbLedCard` grows an effect row + sliders + a preset strip; a new OpenRGB section (or
a second card) lists controllers and drives them. `lib/api.ts` gains `LedEffect`,
`OpenRgbState`, `setLedEffect()`, `openrgb()`, `openrgbSet()`. `lib/ledPresets.ts` (new) =
the app-side preset library.

---

## OpenRGB wire protocol (hand-rolled, stdlib socket+struct)

Header (16 B, little-endian): `b"ORGB"` + `pkt_dev_idx:u32` + `pkt_id:u32` + `pkt_size:u32`.
Port 6742. Handshake: `SET_CLIENT_NAME(50)` "Couchside" → `REQUEST_PROTOCOL_VERSION(40)`
(send client ver u32, read server ver, use min) → `REQUEST_CONTROLLER_COUNT(0)` (reply body
= u32 count) → per device `REQUEST_CONTROLLER_DATA(1)` (send protocol ver u32; reply body =
`data_size:u32` then controller struct).

Writes: `RGBCONTROLLER_UPDATELEDS(1050)` body = `data_size:u32, num_colors:u16, colors[]`;
`RGBCONTROLLER_UPDATESINGLELED(1052)` body = `led_idx:i32, color`;
`RGBCONTROLLER_SETCUSTOMMODE(1100)` (put device in Direct/Custom so our colors stick).
Color = `struct.pack("<BBBx", r, g, b)` (R,G,B,pad). Strings = `u16 length (incl NUL) + bytes`.
Counts (modes/zones/leds/colors) = u16, LE. Controller-data parse order: data_size,
type:i32, name/description/version/serial/location (bstrings), num_modes:u16 + active:i32 +
modes, num_zones:u16 + zones, num_leds:u16 + leds(name+u32 color), num_colors:u16 + colors.
Parse is version-sensitive — we parse only what we need (name + total led_count + zone
names/counts) and pin a conservative client protocol version. **"Wrong version → server
blindly unpacks → random stuff"** — so version negotiation is mandatory before any write.

Testing without hardware: a tiny in-process mock OpenRGB TCP server in the test speaks the
protocol so the client's enumerate + frame-write round-trips are exercised in CI (§11
observe-both-states). **Real OpenRGB hardware remains the final gate**, flagged like the
kernel LED path shipped hardware-unverified.

---

## Phases

- **P1 — kernel effect engine + persistence (agent).** `_led_effects` module: frozen effect
  set, one `led-fx` thread, `/api/leds/effect`, extend `/api/leds` payload, persist +
  boot-restore. Tests: effect allowlist (unknown→400 nothing runs), thread lifecycle
  (start→replace→stop→reap), persistence round-trip, mock-observable. Works on Steam Machine.
- **P2 — app editor + presets + effect controls.** Native hue/brightness sliders, effect
  chips + speed, `+ Save preset` strip backed by `lib/ledPresets.ts`. Harness: press effect
  chips + preset taps (verifiable); sliders proven on-device (§6). 
- **P3 — OpenRGB client (agent).** `_openrgb` stdlib client, `/api/openrgb` + `/api/openrgb/set`,
  cap `openrgb` (six sites), scanner effect via per-LED frames. Tests: mock-server round-trip
  + parity. Flag: hardware-unverified until owner runs it.
- **P4 — app OpenRGB section.** Controller list + drive color/effect from the phone.
- **P5 — polish/backlog:** box-side preset sync; auto-start the OpenRGB server (argv, opt-in);
  more effects; per-zone scanner direction/tail params.
- **P6 — per-LED "addressable, made easy" (owner ask 2026-08-13).** "Allow each LED to be
  addressable but easier to use — v1 demonstrated it but was clunky." Agent side is ALREADY
  there: `_ORGB.set_frame(idx, colors[])` writes an arbitrary per-LED colour array (the
  scanner uses it). Missing piece is an APP paint UX + a `POST /api/openrgb/paint {device,
  colors:[{r,g,b}...]}` (or `per_led`) passthrough. Proposed UX (iterate live on device):
  a strip rendered as a row of LED cells you tap/DRAG to paint with the picked colour, plus
  fill helpers (whole-strip, per-ZONE using the zones the agent already reports, gradient
  between two colours, N-segment split) so common looks need one gesture, not N taps. Drag-
  paint is the crux and is NOT harness-testable → this is the reason for the on-device dev
  build. Persist a painted frame like other states so it survives reboot.

## Risks / must-prove
- Write contention: Steam/InputPlumber may also drive the Deck LED; our effect thread races
  it (documented; last-writer-wins at our frame rate).
- OpenRGB protocol version drift across box installs → negotiate + parse defensively.
- OpenRGB not installed / server not running → cap absent, section hidden (degrade closed).
- Reboot race: OS may reset LEDs at login after our restore → restore with a short retry.
- Sliders unverifiable in harness → on-device proof required (§6, §11).
- No OpenRGB hardware reachable this session → mock-server tests + explicit hardware gate.
