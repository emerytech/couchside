# Couchside Roadmap

Living plan. Move items between sections; **never delete**. Only mark Complete after the
§8 checklist in `CLAUDE.md` passed and the work is verified (not merely written).

Entry fields: `priority` (P0 blocker → P3 nice) · `risk` · `affects` · `depends_on` · notes.

---

## 🔨 In Progress

### Large trackpad toggle — edge-to-edge scrolling surface
- **priority:** P2 · **risk:** low · **affects:** app only · **depends_on:** none
- Tester ask (likwidtek): the trackpad is cramped for "mindless scrolling." A
  `padTrackpadLarge` pref (Setup → PAD LAYOUT) collapses the status pill, mode tabs,
  button rows, and keyboard bar in MOUSE/trackpad mode so the pad fills the pane; a
  floating corner chip is the escape hatch (the only affordance left once the mode
  tabs hide). **Not** OS-fullscreen — the bottom tab bar stays (hiding it is a
  navigator-level change, follow-up only if asked).
- **PR #239.** Verified in the web harness (collapse + exit chip both pressed, not
  just rendered); tsc clean. Awaiting merge — mark Complete once merged.

## 📋 Planned

### Trackpad reliability — "green pill but dead" zombie + gesture misfires
- **priority:** P1 · **risk:** MED (safety-critical input path, CLAUDE.md §4) · **affects:** app only · **depends_on:** none
- From the tester triage (items A + B; C shipped as PR #239). Root-caused in code —
  see BUILD_LOG 2026-07-23 and the workflow findings; do not re-derive.
- **A — WS zombie (the force-quit bug).** The connection pill is a *latched* self-report
  with no liveness input, so a half-dead socket stays green forever; `connect()`'s
  idempotent guard early-returns whenever it *thinks* it is connected, stranding a client
  whose socket was nulled + ping stopped and never reconnects (mouse **and** paste dead
  until force-quit). The existing foreground-reconnect (`pad.tsx:968`) no-ops for the same
  reason. Fix: require a live socket in the guard (`ws && ws.readyState===1`) at
  `lib/gamepad.ts:~474`; add `wake()/ensureLive()` on AppState `active` that reconnects
  unconditionally + probes immediately (don't wait ~12s for the watchdog); drive the pill
  color off `lastInbound`/`readyState`, which also re-enables tap-to-retry. **Needs §4
  device-lifecycle tests.** Highest-impact of the three.
- **B — gesture misfires.** Two-finger tap (right-click) uses `maxTouches` sampled only
  during *move*, so a motionless two-finger tap stays count 1 → left-click; and a sub-8px
  two-finger stroke leaks a right-click because `moved` (8px net) is decoupled from the
  scroll notch (18px). Fix in `hooks/useTrackpad.ts`: track live count via
  `onPanResponderStart`/`gestureState.numberActiveTouches`; latch an explicit `scrolled`
  flag and gate the right-click on `!scrolled`. One file covers Pad + RemoteView.
- Recommended split: **A solo** (risk isolation + lifecycle tests), **B** on its own.



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

### Note mode — jot a clue on the phone while the game runs
- **priority:** P2 · **risk:** low · **affects:** app only · **depends_on:** the drag stroke (shipped)
- **Full spec: `docs/memory/project_note-mode.md`.** Read it first.
- A toggle in the Pad's swipe menu switches the surface into note mode, so you can write down
  a clue without leaving the game. The toggle is itself hideable via a Pref. Leaving note mode
  CLEARS the note from view but does not delete it; clearing on exit is a separate preference.
- Cheap because `app/lib/touchTrail.ts` + `TouchIndicatorLayer` already turn touch coordinates
  into contiguous glowing runs of line — note mode is that with the fade removed.
- **Open questions, deliberately not assumed:** where the ink persists (memory / prefs blob /
  its own key), whether it survives an app restart, whether it is per-box, and what bounds it
  (48 Views is fine for a fading trail, 2000 is not for a drawing).
- **Cannot be verified in the web harness** — RN Web emits mouse events, never touch events.
  Device only, via `adb shell input swipe` + `screencap` mid-gesture.

### One-button "update everything" from the phone
- **priority:** P1 · **risk:** MEDIUM — allowlist-sensitive · **affects:** agent + app · **depends_on:** the sudo/NOPASSWD problem below
- **Requested by likwidtek (Discord, 2026-07-22):** actions to update Bazzite (`ujust update`),
  Couchside, Decky + plugins, Steam, flatpaks — "all from your phone, one button".
- **The allowlist shape is the whole design.** Each updater is its OWN explicit entry in the
  agent's frozen action table with a FIXED argv list. "Update everything" is then a fixed
  SEQUENCE of those entries — never a loop over names the client supplies, and never a
  generic "run updater X" route. Today `DEFAULT_ACTIONS` has exactly three ids
  (restart-session, reboot, poweroff); this would be the largest widening the table has ever
  had, so each entry gets the §6 treatment: happy path, auth failure, non-allowlisted id
  refused with nothing run.
- **The real blocker is privilege, not plumbing.** `rpm-ostree` / `ujust update` need root,
  and the agent runs as the desktop user. This hits the SAME wall that already breaks the
  in-app agent update on a stock Deck (`sudo: a password is required`). Solve that first or
  the button exists and fails.
- **Atomic OS caveat, owner's own point:** on Bazzite an update is staged and needs a reboot,
  and layered packages are re-applied. The UI must report "staged, reboot to apply" rather
  than "done" — reporting success for something that has not happened yet is the exact
  failure this project keeps paying for.
- Flatpak (`flatpak update`) is per-user and needs no root — cheapest first slice, and the one
  that proves the pattern end to end.

### Decky self-heal (update / reinstall from the phone)
- **priority:** P2 · **risk:** low · **affects:** agent · **depends_on:** none
- **Requested by likwidtek (Discord, 2026-07-22):** "a solution to decky crashing and needing
  to be updated — an action to update or reinstall decky to keep it from crashing."
- **Partly exists:** `restart-decky` is already an INJECTED action, gated on the unit existing
  AND the NOPASSWD grant being present (`_inject_decky_action`). What does not exist is
  update-or-reinstall.
- Directly related to **KI-004** (Decky Loader vanishes on every Steam CEF restart; worked
  around, not fixed). Worth reading that before designing — a reinstall button that papers
  over a known root cause is worse than fixing the cause.

### Two-way clipboard (box <-> phone)
- **priority:** P2 · **risk:** low · **affects:** agent + app · **depends_on:** none
- **Requested by likwidtek (Discord, 2026-07-22).** **Half of this does NOT exist**, contrary
  to what was said in that thread: the agent only ever WRITES the box clipboard, as part of
  delivering non-ASCII text (`clipboard_paste`, agent ~8908). `wl-paste` appears solely as a
  read-back check that `wl-copy` landed, plus restoring what was there. There is no
  `/api/clipboard` route and no clipboard call in `app/lib/api.ts`.
- So: phone -> box TEXT ENTRY works. **Copy on the box, paste on the phone does not exist.**
  Neither does "put this on the box's clipboard without typing it somewhere".
- A read route returns whatever the user last copied on their desktop — passwords included —
  to any LAN peer holding the token. It needs the same deliberate treatment as `/pair`, not a
  casual GET.

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

### "Now streaming" card + stop-stream, for games streamed from a PC
- **priority:** P2 · **risk:** low · **affects:** agent + app · **depends_on:** none
- **Reported by owner 2026-07-22.** A LOCAL running game shows a "now playing" card with the
  red **Close Game** button (NowPlayingCard, agent `stop_running_game`). A game **streamed**
  from the main gaming PC (Steam Remote Play / in-home streaming) shows **nothing** in those
  spots.
- **Why:** `_running_game()` (agent ~9923) scans `/proc/*/cmdline` for the Steam **reaper**
  wrapper of a game running ON THE BOX. A streamed game runs on the **host PC**; the box only
  runs Steam's **streaming client**, so there is no local reaper process to find — the card
  and Close button never appear.
- **The action is DIFFERENT, do not reuse Close Game.** `stop_running_game` kills a local
  process group; the streamed game is on the host and can't be killed from the box that way.
  The right action is **stop/disconnect the stream** (leave the streaming client), which the
  box CAN do locally. Label it "Stop streaming", not "Close Game".
- **Detection:** the box already knows about streaming — `steamlink` / `streamhost` caps,
  `stream_host_online()`, and the `streaming_log.txt` start/stop markers (see [[steam-detection-traps]]
  and **KI-005**). A "streaming now" signal wants the same cross-checks that KI-005 is about
  (a dirty-ended session can advertise live for up to 12h) — reuse them, don't re-derive.
- **App:** the compact NowPlayingCard gains a streaming variant — "Streaming <game> from
  <host>" + a Stop-streaming button — shown above Downloads in Launch and on Console, same
  slots as the local card.
- **Verify on hardware** (a real Remote Play session from the PC to the box); the harness
  can't produce a stream.

### "Check for app update" in Setup > Account
- **priority:** P3 · **risk:** low · **affects:** app + website · **depends_on:** none
- **Requested by owner 2026-07-22.** Next to the existing agent-update banner in
  Setup > Account, a control that tells the user whether a newer MOBILE CLIENT exists and
  links to the store listing. Today only the box agent has an update check; the app can't
  tell you it's stale.
- **No agent involvement.** Simplest cross-platform source: a tiny signed-ish JSON on
  couchside.tv (e.g. `app-version.json` = `{"ios":"2.9.21","android_vc":55,"min_ios":...}`),
  written by the release process which already knows these numbers. App fetches it, compares
  to `expo-application` nativeApplicationVersion / nativeBuildVersion, shows
  "Update available" + a deep link to the App Store / Play listing.
  - iOS alternative: `https://itunes.apple.com/lookup?bundleId=...` returns the live App
    Store version with no infra, but it is Apple-hosted and only covers iOS. Play has no
    public version endpoint, so the couchside.tv JSON is the portable answer and keeps both
    platforms on one code path.
- **Privacy:** the check is an anonymous GET of a public version file — no box, no token, no
  user data — matching the agent-update check's privacy stance. Keep it that way; never
  send anything identifying.
- **Traps:** `Constants.nativeBuildVersion` typechecks but does not exist — use
  `expo-application` ([[expo-sdk57-api-traps]]). Read the store version BACK / test the
  compare in both directions (newer AND same) before trusting the banner.

### More Console sensors (battery health, CPU governor, GPU power)
- **priority:** P3 · **risk:** low · **affects:** agent + app · **depends_on:** none
- All read-only sysfs, no new capability, no client input. **PROBED on a Legion Go S,
  2026-07-22** — every value below was actually read off that box, not assumed available.
- **Battery health** — `energy_full` 55500000 vs `energy_full_design` 55500000 = **100%**,
  `cycle_count` **54**. Answers "is my battery dying", which nothing else in the app can, and
  it is two file reads. Highest value of the set.
- **CPU governor + current frequency** — `scaling_governor` = `powersave`,
  `scaling_cur_freq` = 2160 MHz. On a handheld this explains "why is it slow" more often than
  temperature does.
- **GPU power draw** — `hwmon/power1_average` = **5.07 W**. Next to the box battery draw it
  shows where the watts are going. Note `power1_cap` was NOT present on this box, so a
  TDP-limit readout cannot be assumed.
- **GPU clock** — `hwmon/freq1_input` = 800 MHz. Cheap, but the least informative of the set
  on its own.
- **Fan RPM** — **NOT available here**: no `fan1_input` under any hwmon. Probe-and-appear only,
  and do not promise it in copy until a box is found that has one.
- Every one of these is absent on some hardware, so each is independently optional and must
  degrade to "not shown" rather than to zero — the same rule that made PSI return `{}` instead
  of `0.00`.
- **Unverified:** none of these have been read on a DISCRETE-GPU box or a desktop; the
  hwmon paths in particular vary by driver.

### Live network throughput on Console
- **priority:** P3 · **risk:** low · **affects:** agent + app · **depends_on:** none
- The box IP half of this SHIPPED in 2.9.21 — Console renders `status.ip` under uptime.
  Throughput is what remains.
- `/proc/net/dev` exposes cumulative byte counters, so a RATE needs two samples and a delta:
  the agent has to hold the previous sample and its timestamp. One read can only ever report
  totals, never speed.
- Choose the interface the way `net_info_cached()` already does, or the two cards will disagree
  about which NIC the box is on.
- **Unverified:** what the counters do across suspend/resume or a NIC reset. A counter that
  resets produces a large negative delta — clamp at zero and show nothing rather than a
  nonsense spike.

### Make Preferences findable (filter + collapse + re-split PAD LAYOUT)
- **priority:** P2 · **risk:** low · **affects:** app only · **depends_on:** none
- **FILTER SHIPPED in #224 (2026-07-22).** Find-as-you-type over label+sub, card chrome
  dissolves under a query, empty-state on no match. Remaining: the collapse/fold of whole
  sections, and re-splitting the overloaded PAD LAYOUT card. See [[shipped-2.9.21]] follow-ons.- **COUNTED on main 2026-07-22: ~25-28 controls, and PAD LAYOUT holds 12 of them.** The
  problem is the DISTRIBUTION, not the total:
  PAD LAYOUT 12 · INPUT & PAD 5 · GENERAL 3 · TOUCH ANIMATIONS 2 · STREAM FROM PC 2 ·
  APPEARANCE 1.
- **PAD LAYOUT is doing two unrelated jobs**, which is why scanning it fails:
  - *what appears on screen* — Mouse buttons, Steam buttons, Desktop navigation, Windows
    shortcuts, Keyboard bar, Gesture hints
  - *how input behaves* — Steam search button, Send keys instead of a controller, Ask before
    switching control, Open keyboard with the box, Hardware volume buttons, Hide the TV volume
    target
  Splitting along that seam is most of the win on its own.
- **Plan:** (1) a filter box at the top, same pattern as the Launch grid search so it is
  consistent rather than novel — typing "keyboard" should surface the four matching rows;
  (2) collapsible sections with the state remembered, same mechanism as the Stream from PC
  card; (3) the PAD LAYOUT split above.

**SUPERSEDES the earlier "category sub-tabs" proposal in this file — do not build that.**
Sub-tabs add a navigation layer and HIDE options behind a tab the user has to guess, which is
worse for discovery, not better. The earlier entry also flagged that five tabs was untested at
375pt; filter + collapse avoids that risk entirely and costs less. Recorded because the old
recommendation was wrong, not merely superseded.

- **Unverified:** whether a filter over ~25 rows actually feels better than scrolling them.
  Worth building behind the existing web harness and pressing, rather than assuming — the
  harness CAN exercise this one, unlike row-overflow or cover art.

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

### App Store listing revamp + fresh screenshots
- **priority:** P1 · **risk:** medium (public listing; App Review 2.3.1 + licensing) · **affects:**
  store metadata + assets only · **depends_on:** build-target decision
- **Recon + plan done 2026-07-23.** Live listing (id 6786884115, v2.9.21) fetched for real: copy +
  screenshots are **build-65 / 2.9.12-era** and show none of the reactor skin, TV control, gaming/
  battery cards, Fleet, or PIN pairing. Also found a **live licensing violation** ("The whole
  project — app and agent — is open source" — app is source-available, not open source).
- Full plan (shot-list, copy draft, Apple 2026 spec, iOS-Simulator capture method, open decisions)
  in `docs/memory/project_appstore-revamp.md`.
- **Gating decisions before generating:** (1) does the copy cross the TV-marketing lockstep line
  now; (2) shoot against live 2.9.21 vs cut a fresh release off main first; (3) stage a real box for
  the Launch cover-art hero. Nothing published without maintainer go-ahead (public content).

### Auto-drop the phone's pad while a real game runs (opt-in input-mode switch)
- **priority:** P2 · **risk:** medium (churn if debounce is wrong) · **affects:** app only ·
  **depends_on:** none
- **What:** an opt-in pref that flips the phone into keyboard mode (`n` / `?nopad=1`,
  "Send keys instead of a controller") automatically when a Steam game launches, and restores
  the prior mode when the game exits. Off by default.
- **The whole point: stop stealing controller 1 from the game.** When the phone connects mid-
  session, Couchside's uinput pad appears and can grab the Player-1 slot, bumping the real
  controller the player is actually holding. That is the core bug this fixes — the phone should
  never displace the game's real pad. Secondary wins fall out of the same move: no Steam Input
  double-wrap of our pad (`28de:11ff`), and no pad create/destroy churn (which has corrupted
  Steam's desktop config before). Dropping the pad for the duration of the game removes all of
  it; the phone returns to a pad for menu/couch nav after the game exits. Grew out of the "does
  Couchside interfere with a gaming session" thread.
- **Where it lives — APP, not agent.** `n` is a per-client app pref applied at WS handshake;
  the agent only obeys per-connection (create a pad or not). The app already polls
  `/api/gaming` (backed by `_running_game()`, a `/proc/*/cmdline` reaper scan returning
  `{appid, label, running_s}`), and toggling `n` already forces the pad re-handshake. So: watch
  the game-running edge, flip `n`, re-handshake. **Zero agent change, zero new allowlist
  surface.** Agent-side auto would be worse — it would override the mode the client asked for.
- **Traps that ARE the work (not the wiring):**
  - Re-handshake = a brief input gap + churn risk. Debounce on `running_s`, edge-trigger ONCE
    per transition, never level-set every poll — a flickery detector would thrash the pad.
  - Detector is a reaper scan: stable *during* a game, but has a launch window (reaper not up
    yet) and a 2s cache. Edge-detect transitions.
  - Auto must not clobber the user's manual toggle: restore the manual baseline on game-exit,
    don't overwrite the stored pref.
  - Blanket "any game" is probably wrong for pad-driven titles; v1 = global opt-in, a later
    pass can make it per-game remembered.
- **Unverified:** detector not yet observed firing AND not-firing on a real launch/exit; the
  re-handshake input gap is unmeasured. The web harness can't exercise this (needs a real Steam
  game on a box) — verify on the AMD Zephyrus G14 testbed once Bazzite is on it.

### Measure Couchside's perf impact on a live gaming session (validation task)
- **priority:** P2 · **risk:** none (measurement, ships nothing) · **affects:** validation only ·
  **depends_on:** none
- **Why:** the "does the agent hurt gaming performance" question is currently answered entirely
  from architecture — NOTHING is measured. No fixture, no frametime capture, no control run.
  This task produces the missing numbers before any claim gets made (house evidence rule: test
  the thing, don't reason about it).
- **Conditions to compare (same scene, same run length):**
  - baseline — `couchside.service` stopped
  - agent running, no phone connected (idle listener)
  - phone connected, NOT streaming screen (input WS only)
  - phone actively streaming `/api/screen/frame` during play (suspected the real cost: GPU
    readback + encode competing with the game for the GPU)
- **Method:** run a game with mangohud (or gamescope frame stats) on the AMD Zephyrus G14
  testbed once Bazzite is on it. Report **1% lows + the frametime graph**, not average FPS.
  Include a control run whose number you already know, per the house "control in every
  measurement" rule.
- **If a cost shows, mitigations to evaluate:** `nice`/`SCHED_IDLE` the capture-encode path;
  don't hold a gamescope grab when no viewer is attached; guarantee the virtual pad is torn
  down when the controller role is released (overlaps the auto-drop-pad feature above).
- **Output:** the numbers, plus a KNOWN_ISSUES entry only if a real regression is found.

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

### 2026-07-23 — Pairing popup: raise it in front + one store QR, not two (agent 2.9.52)
Two fixes to the on-box pairing tutorial, both VERIFIED LIVE on a real Bazzite box (Plasma
**Wayland**, desktop mode), screenshot before/after. **Popup was behind the terminal:** on a fresh
desktop install `couchside-pair` is launched detached (`setsid`), so KWin's focus-stealing
prevention drops the new full-screen browser to the BOTTOM of the stack — behind (even below) the
Konsole the install ran in. On Wayland a client cannot reorder itself; only the compositor can.
`couchside-pair` now runs a background KWin-scripting raiser (`qdbus org.kde.KWin /Scripting`,
`loadScript`/`run`/`unloadScript`) that finds our own page by title ("Couchside" in every `/pair`
`<title>`, never by browser name, so an unrelated browser is never yanked) and pulls it to the
front, retrying ~18s while the browser cold-starts. Best-effort + KDE-only: no KWin (Game Mode →
`steam://openurl`, another WM, or SSH-no-display) and every step no-ops. **MEASURED:** `keepAbove`
alone does NOT reliably raise a full-screen window here; `minimized=true→false` (un-minimize forces
a restack) + `keepAbove` + `activeWindow` does — the raiser uses all three. **Two store QRs → one:**
step 1 now carries a single QR to `https://couchside.tv/#get` (whose hero already holds both store
badges) instead of separate App Store + Google Play codes — the phone picks its own store, one less
code to aim a camera at, roomier one-screen layout. New-page render proven on the box's own browser
at 4K. `tests/test_pair_page.py` updated. See [[pairing-tutorial-on-box]].

### 2026-07-23 — Pairing page: store QR codes + reliable desktop-mode open (agent 2.9.48)
Two follow-ups to the on-box pairing tutorial. **Store QR codes on `/pair`:** a fresh installer
standing at the box can now scan an App Store or Google Play code to DOWNLOAD the app, not just
pair — two compact QRs under step 1, drawn by the same offline `PAIR_QR_JS` canvas generator (no
new asset, no network, static public URLs). Encoding of both store URLs proven through the real
generator (iOS 29 modules, Play 37 — the longer Play URL still fits). **Desktop-mode open fixed:**
`couchside-pair`'s desktop chain fell to `xdg-open`, which on SteamOS/KDE routes through
`kfmclient` (not shipped) and fails silently — MEASURED LIVE on a Deck OLED in Desktop Mode
2026-07-23. The chain now launches a real browser DIRECTLY with its own full-screen flag
(Chrome/Chromium/Brave/Edge `--app --start-fullscreen`, Firefox `--kiosk`), Flatpak first then
native, and only falls to kde-open5/gio (xdg-open LAST) then Steam CEF. **Rejected** auto-switching
to Game Mode (owner floated it): a session switch tears down the desktop + install terminal.
**NOT a bug:** the auto-open staying quiet on `couchside update` — it's `FRESH_TOKEN`-gated by
design. Owner's live check still owed: on-box CEF render of the store QRs + a real-phone scan.
See [[pairing-tutorial-on-box]].

### 2026-07-22 — Drag trail is a real stroke, verified on a device (#224)
The 2.9.17 "Trace drags" pref drew a fading DOT every 20px; each shrank on appearance, so a
fast drag pulled apart into beads. #224 replaced it with abutting rotated-View segments
(square ends, length == true distance — no gap to bead), added a `boxShadow` glow, and
staggered the per-batch fade. **Driven on a physical Razr 2023** with `adb shell input swipe`
+ `screencap` mid-gesture — the exact device check this item was blocked on. Stroke confirmed
continuous at 3x; glow confirmed rendering on Android on rotated Views. Geometry extracted to
`app/lib/touchTrail.ts`, tested in CI (mutation-checked). Also fixed an 80px undrawn hole on
capped fast flicks, found by driving it on hardware. Tap-ring "Show taps" was already proven.


### 2026-07-22 — Release 2.9.21 (app 2.9.21 / agent 2.9.43)
Play **vc 55 LIVE**; App Store **2.9.21 submitted for review** (build 75, first store
submission since 2.9.17); TestFlight **public link submitted for Beta App Review**; Decky
**v0.2.40** bundling the agent, signed.

Shipped in this release, each verified on hardware rather than in the harness:
- **Android cover art** — had NEVER worked. RN's `<Image>` `source.headers` are dropped by
  Android's loader; instrumenting the agent showed every request arriving as
  `auth_header='' ua='okhttp/4.9.2'`. The cover route now also accepts `?token=`, scoped to
  image GETs only and proven not to be a general bypass.
- **Steam search button** — no deep link exists (four candidates ruled out against a control);
  it anchors the UI with `steam://open/games` then walks focus with arrows. LEFT/RIGHT/OFF pref.
- **Close the running game** — `POST /api/game/stop` takes NO argument by design; the agent
  re-resolves the target itself. NOT yet verified against a real running game.
- **Launch search + collapsible Stream from PC.**
- **Disk percent** — was dividing by total blocks including root-reserved, so /home read 91%
  where df said 97%. Now matches df. Game drives (SD cards) appear, via Steam's own library list.
- **Battery** — draw, ACPI power profile, and time-to-full while charging.
- **Memory pressure (PSI) and swap**; **GPU shared memory** (a 512 MB APU carve-out was being
  reported as the whole GPU).
- **Update progress** in the app and on the box's own screen.
- **Scan failure now explains itself** — it only covers the device's own /24.

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
