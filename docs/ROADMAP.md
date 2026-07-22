# Couchside Roadmap

Living plan. Move items between sections; **never delete**. Only mark Complete after the
§8 checklist in `CLAUDE.md` passed and the work is verified (not merely written).

Entry fields: `priority` (P0 blocker → P3 nice) · `risk` · `affects` · `depends_on` · notes.

---

## 🔨 In Progress

### Touch animations (tap rings + drag trails)
- **priority:** P3 · **risk:** low · **affects:** app only · **depends_on:** none
- Two Preferences toggles, both default OFF, drawing touch feedback over the whole UI so
  screen recordings of Couchside are legible for the store listing, support screen-shares
  and demos. iOS has no system-wide "Show taps" and no recorder can draw into another app,
  so the app draws its own. Pure JS, no new dependency. **Shipped in 2.9.17** (#179).
- **Shipped but NOT Complete — the drag trail is still unverified.** "Show taps" is proven
  in the web harness in both states with a coordinate control; "Trace drags" cannot be
  exercised on web at all (`touchMove` measured 0 across 171 mouse-driven move events — RNW
  emits mouse events, not touch events). Being live on Play is not evidence it works. Move
  to ✅ only after a device shows the trail drawing.
- **How to verify without a rebuild:** the `__touchTrace` counters are in the shipped
  bundle on purpose. Turn both prefs on, drag, read `globalThis.__touchTrace` — `touchMove`
  and `marks` must both climb. If `touchMove` stays 0 on a real device, the `onTouchMove`
  fix is wrong and the trail needs a different attachment point.
- The camera PiP from the `feat/demo-mode` prototype is explicitly **not** coming with it:
  it needs `expo-camera`, the CI gate blocks that from `main`, and the shipping app carries
  no mention of native camera use.

---

## 📋 Planned

### In-app Bluetooth pairing
- **priority:** P2 · **risk:** medium · **affects:** agent + app · **depends_on:** none
- Agent drives `bluetoothctl`; app renders discovered devices and pairs on tap. Removes the
  TV round-trip and works on non-Steam boxes.
- **Research done:** one-shot `bluetoothctl pair` does NOT work — `--agent` registration is
  async and loses the race ("No agent is registered"); the same command over stdin succeeds.
  So it needs a **persistent stdin-fed session**, not a one-shot. Scan output carries
  hard-coded ANSI even when piped; bare `devices` mixes scan leftovers with real pairings
  (use `devices Paired`); Battery Percentage only appears on a *connected* device.
- **Value is narrower than it looks:** the shipped Bluetooth button already reaches Steam's
  own pairing UI, which handles agents and PINs correctly.

### Landscape "laptop mode" — mini QWERTY + trackpad
- **priority:** P2 · **risk:** low · **affects:** app only · **depends_on:** none
- Rotating the phone to landscape shows a full soft QWERTY plus a trackpad on one screen,
  laid out like a laptop, for driving the box's DESKTOP. Portrait is unchanged.
- Landscape is free real estate: `app.json` is `"orientation": "default"` and no screen
  uses landscape for anything today, so the rotation is an unused gesture rather than a
  new control to find.
- **Distinct from keyboard mode** (arrows/enter/esc instead of a virtual gamepad, agent
  asked for `?nopad=1`). That one is about NOT creating a controller in Game Mode. This one
  is about typing and pointing at a desktop. They can ship independently; a later pass can
  decide whether rotating should also imply no-pad.
- Both halves already exist as portrait components (`Trackpad`, the keyboard bar) — the work
  is the landscape layout and the key set, not new input plumbing.
- **Unverified:** whether the existing surfaces survive a landscape re-layout at all; no
  screen has ever been rendered rotated.

### Find the missing Steam settings slugs
- **priority:** P3 · **risk:** none · **affects:** agent only
- Notifications, In Game and Remote Play are visible in Steam's sidebar but their slugs are
  unknown; ~25 guesses measured absent. Any find ships agent-side with no app release.

---

## 💡 Backlog

- **Cloud iOS build to clear 2.9.10's `INVALID_BINARY`** — the App Store record is still
  editable; local builds are TestFlight-only on this beta-macOS Mac. Moot if a later version
  supersedes it. **priority:** P2 · costs EAS overage.
- **Windows agent CI** — `couchsided-win.py` is only syntax-checked; no real `windows-latest`
  build/import gate. See KI registry.
- **AMD / NVIDIA hardware coverage** — the amdgpu GPU block and NVIDIA boxes are unverified;
  no such box has been reachable.
- **Owner-side:** Legion Go Decky crash-loop + right-stick drift.

---

## ✅ Completed

### 2026-07-21 — Release 2.9.17 (app 2.9.17 / agent 2.9.36 unchanged)
Play **vc53 LIVE**; iOS **build 71 submitted for review** (App Store live was still 2.9.9 at
release time). Carries touch animations (#179) and the unlock copy pass (#180). 2.9.16's
queued review submission was cancelled so 2.9.17 could carry everything in one submission —
its version record was **renamed**, not replaced, because App Store allows only one editable
version at a time. Builds were confirmed VALID *before* cancelling, so the unqueued window
was ~1 minute.

### 2026-07-20 — Release 2.9.12 (app 2.9.12 / agent 2.9.32)
Play vc49 / iOS build 65. Carries the redesign, host-online, the screen-capture
re-detect (#142) and the fixture time-bomb fix (#141).

### 2026-07-20 — Cyberpunk Console + Fleet, via a swappable skin seam (#140)
Owner picked **Reactor** from three directions built and compared live. Landed as a
seam (`app/lib/skin/`) rather than a restyle: `kit.ts` defines the surface screens
compose against, `motion.ts` owns ONE breath clock per screen (N cards must not mean N
oscillators) and drives motion RATE from vitality but **never colour**. `classic.tsx`
is retained as a live A/B control — `?skin=classic` is the real shipped 2.9.11
dashboard, which is what makes "is this a regression?" answerable in seconds. Don't
delete it. `vitals.tsx` and `hud.tsx` were built, compared and deleted; recover from
git history if revisited.
**Known gap:** `ScreenPreview`, the BOX UNREACHABLE banner and the "No box configured"
empty card still use bespoke local styles rather than the kit.

### 2026-07-20 — Stream hosts show whether they are actually online (#143)
Offline hosts dim with a reason; Setup › Prefs can hide them entirely. Detection reads
**Steam's own remote-connection log** for when each client was last seen — no hostname
resolution, no port probing, no network sweep. That sidesteps the dead end this was
stuck on (`remoteclients.vdf` has only a hostname and a WAN `ippublic` identical across
hosts). `stream_host_online()` is deliberately conservative: ambiguity resolves to
**offline**, because a false "online" is exactly what makes Steam offer a multi-gigabyte
install instead of a stream.

### 2026-07-19 — Steam settings shortcuts (app 2.9.11 / agent 2.9.31)
19 hardware-verified deep links behind `/api/steam/menus`, surfaced as an Actions sub-tab.
Shipped Play production vc48 + TestFlight 64.

### 2026-07-19 — Steam Controller detection (agent 2.9.28)
`max(len(real), phantoms − our_pads)`. Proven on device.

### 2026-07-19 — Stream-host dirty-end recovery (agent 2.9.29)
Data-port cross-check; sessions clear in a poll instead of 12 hours.

### 2026-07-19 — "Pair a controller" action (agent 2.9.30)
Screen-capture verified end to end through the agent's own runner.

### 2026-07-19 — Web target + dev harness
`scripts/web-dev.sh` renders the real app UI against mock or the real box.

_(Earlier releases 2.8.x–2.9.10 predate this roadmap; see `docs/BUILD_LOG.md` and the
release tags.)_
