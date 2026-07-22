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

### On-box pairing tutorial (auto-plays after install)
- **priority:** P1 · **risk:** low · **affects:** agent + installer · **depends_on:** none
- **Full spec: `docs/memory/project_pairing-tutorial.md`.** Read it first — the mechanisms and
  the file:line anchors are already recorded, do not re-derive them.
- The installer's last act on a **fresh** install is to open the box's own screen full-screen
  with a short animated tutorial (open the app → Setup → Scan → tap this box), which then
  swaps itself into the live 6-digit PIN the moment the phone starts pairing. Targets the
  measured funnel gap: ~9–15 app downloads in the first six days after launch, ~0 boxes paired.
- **Cheap because it is mostly assembly.** `/pair` already renders two states and is already
  double-gated (loopback peer + Host header); `render_pin_page` already polls
  `/api/pair/status`; `couchside-pair` already opens the page full-screen in Game Mode and on
  desktop; `install.sh` already runs as the desktop user and already has a fresh-token signal
  at `:602-609` to gate the auto-open so update runs stay quiet. **No new route, no new
  network surface, no app release.**
- Scope fixed with the owner: **box TV only**, **inline CSS/SVG animation — not a GIF** (the
  repo's GIFs are 3.9–5.9 MB; the whole agent is 539 KB of stdlib Python), **PIN flow only**.
  The QR is **kept** alongside the steps — the Steam tile's documented job is re-showing it.
- **The one unproven thing:** whether Steam's built-in CEF browser renders CSS `@keyframes` and
  inline `<svg>`. Probe that with a throwaway page before writing the real one. Everything else
  in the design was read from source; this was not.
- Verify on the real box via `/api/screen/frame` in **both** Game Mode and desktop, observing
  **both** states (idle tutorial and the reload-into-PIN handoff), plus a re-run on an
  already-paired box that must pop nothing.

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

### Close the running game from the Launch tab
- **priority:** P2 · **risk:** medium · **affects:** agent + app · **depends_on:** none
- A card at the top of Launch showing what is running now, how long it has been running, and
  a red button to close it. Today you can start a game from the phone but not stop one, which
  is the half that matters when the TV is black.
- **Half of it already exists:** `_running_game()` (`agent/couchsided.py:9149`) scans
  `/proc/*/cmdline` for Steam's reaper wrapper and returns `{"appid", "label"}`. Runtime comes
  from field 22 (`starttime`) of `/proc/<pid>/stat` against `/proc/uptime` — no new source.
- **THE ALLOWLIST DESIGN, do not deviate:** the stop route takes **NO client input at all** —
  no pid, no appid, no name. `POST /api/game/stop` with an empty body, and the AGENT
  re-resolves the target itself via `_running_game()` at the moment of the call. A client that
  cannot name a process cannot be steered into killing one. Passing a pid or appid "to be
  explicit" would invert that and is exactly what §3 forbids.
- `SIGTERM` to the reaper, never `SIGKILL` first, never a shell string. Degrade closed:
  nothing running is a 404, not a best-effort sweep.
- **Unverified:** whether SIGTERM to the reaper closes a game cleanly or whether Steam
  restarts it / leaves a zombie, and whether the reaper is the right target at all versus the
  game binary. Needs a game actually running on a box.

### Show the box IP and live network throughput on Console
- **priority:** P3 · **risk:** low · **affects:** agent + app · **depends_on:** none
- **The IP is already in the payload.** `/api/status` carries `ip` (the address the phone
  reached the box on, agent >= 2.9.22) and the app's `Status` type already declares it — the
  Console tab simply never renders it. That half is app-only, no agent release needed.
- Throughput is the real work: `/proc/net/dev` exposes cumulative byte counters, so a RATE
  needs two samples and a delta. The agent has to hold the previous sample and its timestamp;
  one read can only ever report totals, never speed.
- Choose the interface the way `net_info_cached()` already does rather than inventing a second
  rule, or the two cards will disagree about which NIC the box is on.
- **Unverified:** what the counters do across suspend/resume or a NIC reset. A counter that
  resets produces a large negative delta — clamp at zero and show nothing rather than
  rendering a nonsense spike.

### Fill in missing Launch tile cover art from the box
- **priority:** P2 · **risk:** low · **affects:** agent + app · **depends_on:** none
- **MEASURED on a Legion Go S, 2026-07-22:** its `appcache/librarycache` holds 1118 entries —
  **826** games have `header.jpg` but only **386** have `library_600x900.jpg`. `_steam_cover_path()`
  looks for `library_600x900.jpg` and nothing else, so roughly **440 installed games render the
  blank text-card fallback while their artwork is already on disk.**
- Entirely local: no CDN, no scraping, no new network egress. The existing
  `/api/steam/<appid>/cover` route already serves from the box; this widens which local files
  it will serve, in a fixed preference order.
- Candidate sources beyond the current two: `library_600x900_2x.jpg`, `header.jpg`,
  `library_hero.jpg`, and user/SteamGridDB art under `userdata/<uid>/config/grid/`. **No `grid/`
  folder existed on the Legion Go S**, so custom-art support is speculative — do not claim it
  works until a box with one is measured.
- **Aspect is the real design problem, not the lookup.** Tiles are 600x900 portrait; `header.jpg`
  is 460x215 landscape. Centre-cropping a header into a portrait tile often looks worse than the
  clean fallback card. So the agent should ADD a field saying which KIND of art it found
  (portrait / header / none) and let the app lay each out properly — never rename or remove an
  existing field.
- Allowlist note: appid stays digits-only validated and the resolved path must still be verified
  to sit inside the cache root. Widening the FILENAME set is fine; widening to a glob or a
  client-supplied filename is not.

### Split Preferences into category sub-tabs
- **priority:** P3 · **risk:** low · **affects:** app only · **depends_on:** none
- Prefs is one long scroll. **COUNTED 2026-07-22: 27 rows across 6 cards** (GENERAL 4,
  APPEARANCE 2, INPUT & PAD 6, PAD LAYOUT 11, STREAM FROM PC 2, TOUCH ANIMATIONS 2), all
  rendering unconditionally — no caps or Platform gating — so the count is the same on every
  device.
- **Reuse the existing sub-tab control**, the one Setup already uses for Boxes / Prefs / Logs /
  Account. A second tab pattern in the same screen would be worse than the scroll.
- Proposed 4 categories: **General** (haptics, confirm-before-suspend, vitals refresh, journal
  lines, open-on, theme, accent) · **Input** (everything changing what the app SENDS) ·
  **What's shown** (every hide/show row) · **Touch animations**.
  Note "Open on" moves out of INPUT & PAD — it is an app-startup setting and its current
  placement is the anomaly.
- **Unverified:** whether FIVE sub-tabs fit the existing tab bar at 375pt. `tabItem` is flex:1
  with a 15px icon + 6px gap + 12px mono label; four fit today, five is untested. That is the
  only reason the proposal stops at four — measure in the harness before going wider, or drop
  the icons on the nested row.
- Also undecided: whether the sub-tab selection should persist across launches. The parent
  control does NOT persist, so matching it means "no".

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
- **Owner requirement: gate it behind a preference toggle.** Rotation must not silently change
  the interface for people who rotate by accident or who read in bed; the pref is what makes
  the gesture opt-in.
- **Unverified:** whether the existing surfaces survive a landscape re-layout at all; no
  screen has ever been rendered rotated.

### Find the missing Steam settings slugs
- **priority:** P3 · **risk:** none · **affects:** agent only
- Notifications, In Game and Remote Play are visible in Steam's sidebar but their slugs are
  unknown; ~25 guesses measured absent. Any find ships agent-side with no app release.

### First-class Nobara support
- **priority:** P2 · **risk:** medium · **affects:** installer + agent · **depends_on:** a Nobara
  box or VM (none exists yet — this is the blocker, not the code)
- Full spec: `docs/memory/project_nobara-support.md`. Estimate: **1–2 sessions once a box exists**
  for core support, +1 for the Couch Mode family.
- **The installer needs far less than assumed.** `install.sh` has no distro detection, installs no
  packages, never touches rpm-ostree, and writes nothing to `/usr` (`:351-358`); its firewall step
  is already `firewall-cmd` (`:898-905`), which is Nobara's. No package-manager or firewall
  abstraction is required. Sudoers, groups, udev, WoL and the Ed25519 verify flow are already
  distro-agnostic.
- **The agent already degrades honestly.** `_is_steamos_like()` (`agent/couchsided.py:1903`) is the
  only distro detector in the file and cleanly hides Couch Mode, the `desktop` cap and guide-hold;
  every Steam feature gates on `_steam_root()` instead, so library, launch, menus, gaming card and
  stream host/client all work. Nothing crashes and no capability wrongly probes true.
- **The one real risk is SELinux**, and it is UNVERIFIED: the system unit exec's the daemon out of
  `$HOME` (`install.sh:859`, `agent/couchside.service:20`), which Fedora targeted policy normally
  denies from an init domain, and the repo has zero SELinux handling. Could be a failed start or a
  non-issue depending on whether Nobara ships enforcing. Phase 0 exists to find out.
- **Free win available:** `guide_hold_available()` (`:8771`) requires `couchmode_available()`, but
  its evdev machinery needs only group `input` — decoupling it gives Nobara the guide-button
  trigger with no new mechanism.
- Any fix must live inside `install.sh` / the signed service template, because `couchside update`
  re-runs the installer and would undo anything applied out-of-band.
- **The edition matters for the optional half only.** Nobara ships five (Official/custom-KDE, KDE,
  GNOME, Steam-HTPC, Steam-Handheld), each with an NVIDIA variant. Core Couchside is
  desktop-agnostic across all of them; what splits is that **`kscreen-doctor` (in
  `_COUCHMODE_TOOLS`) and `spectacle` (screen capture) are Plasma-only** — so GNOME can never run
  Couch Mode and has no desktop-capture backend, while **Steam-HTPC** is the flagship target and
  the only place the Couch Mode question can be answered. Test Official/KDE first (one variable at
  a time), NVIDIA never as the first box.
- **Unverified:** SELinux mode on Nobara, whether Steam-HTPC provides a `steamos-session-select`
  equivalent, gdm-variant behaviour, and every row of the flavor table (derived from what each
  desktop ships, not from running the agent). CachyOS is a separate, un-researched target.

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
