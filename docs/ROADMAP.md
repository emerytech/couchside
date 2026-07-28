# Couchside Roadmap

Living plan. Move items between sections; **never delete**. Only mark Complete after the
§8 checklist in `CLAUDE.md` passed and the work is verified (not merely written).

Entry fields: `priority` (P0 blocker → P3 nice) · `risk` · `affects` · `depends_on` · notes.

---

## 🔨 In Progress

### Trackpad WS liveness on iOS: the couch-switch half (#245)
`priority: P1` · `risk: med (input path)` · `affects: app/lib/gamepad.ts` · `depends_on: —`
- **Idle churn: DONE, shipped** in agent 2.9.53 (box-driven WS PING; the phone's OS
  auto-PONG feeds the idle timer below the frozen JS timer). Live-verified.
- **Couch-switch half: STILL OPEN.** Trackpad dies after a Desktop switch, pill stays
  green, only a force-quit recovers. Ruled OUT by measurement: the compositor
  (libinput enumerates the pad fine) and a stale uinput device (agent 2.9.54
  recreated it — node changed both directions — and the cursor stayed dead).
  A fresh SOCKET fixes it, so it is socket/holder-layer.
- Three hypotheses remain and need different fixes: (a) the recovery condition never
  becomes true, (b) sendRaw is never reached, (c) recovery fires and the rebuilt
  socket is mute too. Evidence leans (c) — the box's mouse event node kept changing
  during an episode, i.e. reconnects were happening while the cursor was dead.
- **Instrumentation shipped** (#260, app 2.9.28): on-Pad diagnostics panel
  (long-press the pill — must NOT be in Setup, since leaving the Pad closes the
  socket) + inputSends / inputDropped / recoveries / opens counters.
- **NEXT:** capture one reading during a real episode; that picks the fix.

### Remote desktop "screenshot + tap"
`priority: P2` · `risk: med` · `affects: agent, app` · `depends_on: #245 learnings`
- MEASURED ceiling ~1.2 fps now / ~1.4 fps optimized (~0.41s of every frame is
  spectacle's Qt startup). **True VNC is off the table** on this architecture;
  what is achievable is tap-to-click on a slow-refreshing frame.
- Absolute pointer PROVEN pixel-exact on Plasma Wayland (screenshot-diff, with a
  relative-mouse control). Declare BTN_TOUCH to suppress a phantom /dev/input/js0.
- **Unproven: gamescope.** Also needs zoom or a two-stage crosshair — a 44pt finger
  is ~289 logical px on a 4K desktop vs a ~100x30 px button — and frame-age gating
  so a stale frame can't produce a confident wrong click.

## 📋 Planned

### Couchside Player — a media-player tile, phone-driven (Friendly-style)
- **priority:** P1 · **risk:** medium · **affects:** new box program + agent + app ·
  **depends_on:** none
- **Full spec: `docs/memory/project_media-player.md`.** Read it first — the measured Phase 0
  results, the allowlist tiers and the screensaver-pattern lessons are all there.
- **Requested by owner 2026-07-27**, with the shape called explicitly: a custom Linux program
  registered as a non-Steam app, "to make sure we are not just patching something quickly
  together". That instinct matches the pattern the repo already ships for
  `Couchside Screensaver` (`agent/couchsided.py:2028`).
- **Why it is worth building, in one line:** TV pad mode already proved a website will never
  draw a focus ring for us. Friendly's real trick is that the *app* is the navigation layer
  and the browser is only a video surface — the phone sends a deep link and the box opens at
  the title, so the tile grid is never navigated at all.
- **Shape:** a `Couchside` tile (python3 stdlib) that spawns Chrome as a child and drives it
  over CDP — real `<video>` state, real seek, its own hub page with a focus model we control.
  Not a browser engine: Widevine decides that, and Electron/castlabs has open Netflix
  breakage on Bazzite while Chrome plays these services on the owner's box today.
- **Phase 0 spike PASSED on hardware 2026-07-27** (bazzite 10.1.1.60, agent 2.9.60):
  CDP reachable through the flatpak sandbox (`Chrome/150.0.7871.186`); Widevine
  **GRANTED**, `HW_SECURE_ALL` **DENIED** so the **720p L3 ceiling is confirmed, not assumed**;
  a control Widevine stream **played with CDP attached** (`currentTime 1.224/60`);
  `navigator.webdriver` false and no browser-wall on max/netflix/hulu.
- **Two traps banked:** `--ozone-platform=wayland` is REQUIRED when spawning from a
  non-graphical parent (else `Missing X server or $DISPLAY` and Chrome dies before binding the
  debug port); and Chrome's DevTools HTTP endpoint ignores `Connection: close`, so reading to
  EOF times out *after* the body arrived and reads as "CDP unreachable".
- **ALLOWLIST — three tiers, only two ship on by default.** (1) frozen service table, client
  sends `service_id` only; (2) deep links where the *path* is checked against that service's
  own regex and the host is never client-supplied; (3) a free URL bar behind a box-side flag
  that ships OFF. CDP is an RCE primitive — random loopback port, never proxied through a LAN
  route, and the phone sends op ids that the player maps to CDP calls it constructs itself.
- **Phase 0b ALSO PASSED, in Game Mode, same day.** A wrapper tile that Steam launches and
  which spawns Chrome as a child **does** surface under gamescope — **screen-capture proven**,
  Widevine playing fullscreen 1920x1080 with our own page's banner over it. And Steam's
  process-group kill **reaps the flatpak Chrome cleanly**: 0 chrome processes, 0 flatpak
  instances, 0 wrapper, CDP port closed.
- **THE BACKEND TRAP (the finding that would have sunk Phase 1):** the Chrome ozone backend is
  the exact inverse between sessions and cannot be hardcoded. Game Mode gives `DISPLAY=:1` with
  **no** `WAYLAND_DISPLAY` (needs `--ozone-platform=x11`); the desktop, spawned from a
  non-graphical parent, gives Wayland with no xauth (needs `--ozone-platform=wayland`). Wrong
  either way and Chrome exits rc=1 before binding the debug port. Both were hit for real.
- **CORRECTED:** the tile is **NOT** picked up by the agent's running-game detection, so
  `NowPlayingCard` / `stop_running_game` do **not** come for free — matches the ROADMAP's own
  prior "no running app for a Steam-launched shortcut" measurement. The player reports its own
  state and ships its own stop. Budget it in Phase 2.
- **LANDMINE:** `_ss_appid()` anchors on the literal `couchside/Couchside`, which a tile at
  `~/.local/opt/couchside/Couchside Player` would also match — silently breaking the
  screensaver's launch. Keep a distinct directory or tighten that anchor first.
- **Prior art surveyed, nothing does this:** StreamingServiceLauncher (MIT), ElectronPlayer
  (MIT but archived — its maintainer hit exactly the Electron+Widevine treadmill we avoid),
  Igalia Cog (MIT, no Widevine), Aura browser (GPL, cannot ingest), ValvePython/vdf + BoilR
  (MIT, the `shortcuts.vdf` and cover-art references). All of them put the catalog on the box;
  none makes the phone the navigation layer. Details in the spec's §6b.
- **Reconciled against the real product 2026-07-27** (the Mac App Store listing was read, not
  just the owner's screenshots — see the spec's §1b). Two changes: **cross-service search is
  promoted** out of "later" to its own phase, because it is what makes a hub beat six tiles and
  it is genuinely better on a phone than on a TV (you type on a phone); and **visual controls**
  (brightness/contrast/saturation) join Phase 4, being one injected CSS filter once CDP exists.
  **Explicitly NOT copied:** Picture-in-Picture and window transparency (they exist because
  Friendly's premise is multitasking on a Mac you are sitting at — irrelevant ten feet from a
  TV) and the bundled VPN. **The ad blocker is DECIDED — NO** (owner, 2026-07-27, see
  `DECISIONS.md`): not for YouTube, not as a toggle, not as a user-supplied list. Written down
  as a refusal precisely because CDP makes it trivial — injection capability is not a licence
  to inject.
- **Phase 1 SHIPPED on the branch 2026-07-27** — `agent/couchside-player.sh`, branded grid art,
  and `tests/test_player_tile.py` (20 checks in CI). **Live-verified in Game Mode:** registered
  via `steamos-add-to-steam` (appid 3442312991), launched by `steam://rungameid`, auto-picked
  `--ozone-platform=x11` from the session, Hulu fullscreen and chromeless (screen-captured),
  CDP live on loopback; `SIGTERM` to the pidfile pid left 0 chrome / 0 flatpak / 0 tile and
  cleaned both runtime files. Deep-link patterns ship **empty except `max`** — the only shape
  actually observed — so an unverified guess can never become a live link.
- **Phase 2 SHIPPED on the branch 2026-07-27** — `player` cap at all five edit sites,
  `GET /api/player` (probe-and-appear) + `POST /api/player` (`op: open|close`), and
  `tests/test_player_api.py` (44 checks in CI, driving a real Handler with stub `steam` /
  `steamos-add-to-steam` binaries that log, so "refused" and "nothing ran" are separate
  observations). **The service table stays in the tile** — the agent validates by asking it, so
  there is one copy and the validator is the code that runs. **Live-verified:** `caps.player`
  true, unauth 401, unknown service and bad path both 404 with nothing written or launched,
  `open netflix` → Netflix on the TV (screen-captured), `close` → 15 Chrome processes → 0.
- **Two corrections banked.** (1) The "0 Chrome" checks in Phases 0b/1 used
  `/app/bin/chrome`, which never matches — the real argv is `/app/extra/chrome`. Re-measured
  with a control (15 → 0). (2) **Steam relaunches the tile by itself** after a return to Game
  Mode, so `running` can be true with no API call behind it; the app must treat tile state as
  observed, not as what was last commanded.
- **Phase 3 SHIPPED on the branch 2026-07-27** — Watch tab (`app/app/(tabs)/watch.tsx`),
  cap-gated on `player === true` (opt-in, unlike the other tabs: undefined means an agent with
  no player routes at all, so the tab would lead nowhere). Service grid, now-playing + Stop,
  and a paste-a-link field that splits a URL into (service, path) using the **box's** host
  table — the app carries no copy of the service list, only a display-name map with a
  title-cased fallback so a newer agent's services still render. `service_urls` was ADDED to
  `/api/player` for this (new field; the existing `services` shape is untouched).
  **Harness-verified by pressing every control:** tile tap opens and highlights; a bad link
  shows the hint and leaves Send disabled; a good link reads "Opens on Max at that title" and
  sends with the path; Stop clears the strip and the box reports `running=false`. No console
  errors; 375px layout clean.
- **Share-sheet intake DEFERRED to its own slice** — it needs an iOS share extension (native
  target + config plugin) and Android intent filters, which the web harness cannot exercise, so
  it would ship unverified. The paste field covers the need meanwhile. Note for that slice:
  `useURL()` is deprecated in Expo SDK 57; use `useLinkingURL()`.
- **Phase 4 BUILT but NOT live-verified 2026-07-27.** Agent CDP client + transport ops
  (play/pause/playpause/mute/seek/picture), `playback` added to `GET /api/player`, transport UI
  in the Watch panel. 81 unit checks, mutation-checked (replacing the frozen seek constant with
  an interpolated one fails the suite), UI exercised in the harness by pressing.
- **Phase 4 LIVE-VERIFIED in Game Mode 2026-07-27.** Against Twitch's autoplaying stream:
  state read `{"playing": true, "position": 35.38, "title": "Twitch"}`; `pause` → playing
  false; `play` → playing true; `seek +10` moved position `0 → 10` (delta exactly 10.0s);
  `picture brightness=1.5` produced `brightness(1.5) contrast(1) saturate(1)` on the element.
  Screen-captured. Both directions of play/pause observed.
- **The blocker was the SESSION, and my first diagnosis of it was WRONG.** It was recorded as
  "CDP evaluates in the wrong context"; a ten-experiment pass falsified that, and the Game Mode
  re-run settled it. Chrome under that particular Plasma desktop session would not navigate
  **anywhere** — ruled out: our client, `Runtime.enable`, target selection, the profile, the
  tile/agent (plain `flatpak run` failed identically), network (a loopback URL also blanked),
  and app-mode (a normal window failed too). Nothing in our code was wrong. **Consequence: the
  desktop session is an unreliable place to test the player — do live checks in Game Mode.**
- **Probe note:** YouTube's home page is autoplay-gated (`duration: 0`, ops return ok while
  `playing` stays false) and Pluto TV's landing page has no `<video>` until a channel is picked.
  Twitch's front page autoplays; use it.
- **Phase 5 SHIPPED 2026-07-27 as ON-BOX SEARCH ONLY** (owner decision: no metadata source, no
  API key, no cloud). The phone sends text; the box opens that service's own search results, so
  nobody types a title on a TV. The "LAN-only, no accounts" promise is untouched. TMDB-style
  "who has this title" was declined — bundled key is extractable, a couchside.tv proxy makes
  search depend on a server, bring-your-own-key ships unused.
- **The query is free text, so it gets deep-link-tier care.** The tile owns the table and the
  encoder: structure is REJECTED (empty, whitespace-only, >80 bytes, control bytes), the rest is
  percent-encoded byte-wise. Round-trip tested: `Amélie`, `千と千尋`, `rick & morty`, `a+b`,
  `100% cotton` all decode back exactly, and `& # ? / " '` cannot survive unencoded.
- **Two silent encoder bugs caught by that test:** `[:print:]` rejects every byte ≥ 0x80 under
  `LC_ALL=C` (so no non-English title could be searched), and `printf "'$c"` sign-extends those
  bytes (`Amélie` → `%FFFFFFFFFFFFFFC3`). Neither is visible by eyeballing a URL.
- **Only VERIFIED search URLs ship** — youtube/netflix/twitch/crunchyroll; everything else
  refuses a query. Live in Game Mode: YouTube and Twitch titled `"the bear - …"`, Crunchyroll
  **41 query hits in the page text** (a generic title was not accepted as proof). **Netflix
  redirects to `/login` when signed out** — normal Netflix behaviour for any of its URLs, not a
  bad search URL; re-check on a signed-in profile.
- **Real fix banked meanwhile:** switching services while the tile ran relaunched Chrome against
  a profile the dying instance still owned, so `flatpak run` deferred to it and the new
  debugging port never bound. The tile now waits for `SingletonLock` to clear.
- **Also fixed:** `player_info()`'s mock branch returned a narrower shape than the real one, so
  the harness rendered no transport at all. A test now asserts both branches return the SAME
  keys — a narrow mock is how a UI gets built against a payload the box never sends.
- **Phase 6 SHIPPED 2026-07-27 — the hub page closes the loop on TV pad mode.** That mode was
  demoted to opt-in because a browser tile grid has no focus model for a d-pad step to land on.
  The tile now writes its OWN page (a `file://` grid inside the browser profile, every href from
  the frozen table, display names via a label map that is explicitly not an allowlist). Live in
  Game Mode: 14 tiles, first focused on load, arrow keys walked the grid to `Apple TV+` with the
  ring in brand green — screen-captured. It covers the case the phone does not: opening the tile
  from the Steam library with a controller in hand.
- **Recents are phone-side** (`app/lib/watchRecents.ts`), never box state — `shortcuts.vdf` is
  rewritten by Steam, and history is per-person, not per-box. Harness-verified.
- **Hidden end-to-end on a box without the player — measured, not assumed.** With the box forced
  to report `caps.player: false`, the whole `GAMES | WATCH` row vanished along with every Watch
  element, and Launch reverted to the plain games list. (`GET /api/player` 404s and the cap is
  false when the tile is absent — both already covered by tests.) First sample was taken
  mid-render and still showed the row; one sample of a React tree is not a measurement.
- **PLAYER PROJECT COMPLETE — phases 0–6.** Remaining follow-ups are small and listed in the
  spec: Netflix search on a signed-in profile, search URLs for the other ten services, and
  share-sheet intake (deferred, needs a device build).

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

### Packaged media shortcuts, installable from the phone
- **priority:** P2 · **risk:** medium · **affects:** agent + app · **depends_on:** shortcut
  launching (shipped 2026-07-26)
- **Requested by owner 2026-07-26:** "these media shortcuts also need to be packagable and
  option to download with couchside agent so users can have quick configured media
  shortcuts on their own boxes."
- Goal: a fresh box gets Netflix/Hulu/Disney+/Max/Prime/YouTube tiles — with cover art —
  without the owner hand-running `ujust get-media-app` six times or knowing what
  shortcuts.vdf is.

#### THE OPEN QUESTION: adopt vs install (decide before writing code)
- **A canned pack that blindly installs its own tiles WILL collide with what the user
  already has, and the collision is worse than it sounds.** MEASURED on the maintainer's
  box 2026-07-26: it already had Netflix/Hulu/Disney+/Prime/Max as Chrome `--app=`
  shortcuts, logged in (`NetflixId`/`SecureNetflixId` persistent to 2027, `_hulu_session`,
  23 Disney+ cookies). Running Bazzite's own `ujust get-media-app` added a SECOND set
  backed by StreamingServiceLauncher, which keeps a separate cookie jar at
  `~/.config/streaming-service-launcher/sessionData`. The new tiles were empty, so the
  owner hit **"it makes me login every time"** — and the duplicates had no cover art
  either, because grid art is keyed by appid (`grid/<appid>p.png`) and the new appids had
  none.
- So the default must be **ADOPT, NOT INSTALL**: enumerate shortcuts.vdf first, match
  known services by URL/exe, offer to launch what exists, and only create a tile where the
  service is genuinely absent. "Install everything" should be an explicit, per-service
  choice, never the default.
- Corollary: whatever creates a tile must also be able to REMOVE it, or we hand users the
  same mess we just cleaned up by hand.

#### Backend choice (also unresolved)
- **Chrome `--app=<url>`** — what the owner's working tiles use. Shares the Chrome flatpak
  profile, so a login done anywhere carries over; Widevine already present (CDM
  4.10.3050.0 on that box). Downside: no TV-tuned UA/zoom.
- **StreamingServiceLauncher** (castlabs Widevine Electron, what Bazzite ships) — purpose
  built, per-service UA and zoom, but a SEPARATE profile from the user's browser, and its
  tracker has open Netflix "unsupported browser" breakage **specifically on Bazzite**
  (aarron-lee/StreamingServiceLauncher#8).
- Leaning Chrome for adoption-friendliness; needs a decision, not a coin flip.

#### Hard constraints already measured
- **File-level edits to shortcuts.vdf DO NOT STICK — not even with Steam down.**
  CORRECTED 2026-07-26 after testing: a prune (32 -> 27 entries) and a separate
  LaunchOptions edit were both applied with Steam shut down, verified on disk, and both
  were REVERTED after Steam restarted — the deleted tiles came back and the added flag
  was gone. Steam holds an authoritative copy (cloud sync is the likely mechanism) and
  rewrites the file from it. So any shortcut management must go through Steam's own
  mechanism (`steamos-add-to-steam`), and REMOVAL may not be reachable from the agent at
  all — it may have to be a "do this in Steam's UI" instruction.
- Cover art is a separate artifact: `~/.steam/steam/userdata/<id>/config/grid/<appid>p.png`.
  A pack without art produces the grey placeholder tile, which is exactly what made the
  duplicates look wrong at a glance.
- **ALLOWLIST — the service table must be FROZEN IN AGENT SOURCE.** A route that accepts a
  client-supplied URL and registers it as a Steam shortcut is an arbitrary-navigation
  primitive: it would let any LAN peer holding the token make the box open anything, with
  a tile that persists across reboots. The client may select `service_id` from a closed
  table only; the URL, exe and argv come from the agent. This is the same rule as
  LAUNCHERS/ACTIONS and is the single thing most likely to be got wrong here.
- Creating/removing tiles is state-changing, so it needs the bearer token, a capability
  key (all five edit sites), and tests proving a non-allowlisted service_id registers
  nothing.

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

### macOS agent (beta) — Macs as a supported box
- **priority:** P2 · **risk:** MEDIUM — new OS surface, TCC unknowns · **affects:** new agent
  variant + installer + release pipeline + couchside.tv · **depends_on:** none (dev Mac = test box)
- **Ship as an explicit beta: works-for-some, no guarantee.** Positioning is
  **console/dashboard/remote — NOT controller** (see the gamepad ceiling below); the beta page
  must say so up front.
- **The playbook is the Windows port.** Third variant file `agent/mac/couchsided-mac.py`,
  skeleton copied from `agent/win/couchsided-win.py` (~6.2k lines, already restructured for
  non-Linux: caps subset + `False` for platform features, same allowlist tables, same auth/WS
  core). The app is capability-adaptive and every Phase-1 cap reuses an EXISTING key, so
  **zero app edits and no five-edit-site work** — Windows already ships
  `couchmode/desktop/screensaver: False` and the app hides them.
- **Phase 1 (core beta):** pair/status/discovery (HTTP sweep, unchanged) · trackpad + keyboard
  via `ctypes` on CoreGraphics (`CGEventCreateMouseEvent`/`CGEventPost` — same trick as the win
  agent's ctypes `SendInput`) · `steam` cap (library VDF under
  `~/Library/Application Support/Steam`, launch via `open steam://rungameid/...` argv) · screen
  frame via `screencapture -x -t jpg` (subprocess argv, ships with macOS) · power: sleep
  (`pmset sleepnow`), restart/shutdown via System Events AppleScript (no sudo) ·
  `boxbattery` (`pmset -g batt` parse) · `file_upload` (drop-dir code ports as-is) · launchd
  LaunchAgent + `install-mac.sh` through the same Ed25519 signing flow. Temp/`power_schedule`
  need root — omit until a sudoers.d slice (macOS has `/etc/sudoers.d`, same zz-couchside
  pattern).
- **Phase 2 (parity extras):** media keys (HID `NSSystemDefined` events) · Roku ECP TV backend
  (pure HTTP, OS-agnostic) · `launchers` (Epic/GOG exist on macOS) · Big Picture / steammenus
  (`steam://` deep links) · in-app agent-update mac branch · `release-agent.sh` mac asset +
  `agent-version-mac.txt` · couchside.tv `/mac` page.
- **Hard ceiling — virtual gamepad is OFF, likely forever:** macOS has no uinput/ViGEm
  equivalent; foohid kext is dead on modern macOS; DriverKit HID needs an Apple-approved
  entitlement + notarized app bundle (not happening for a stdlib Python script); Karabiner's
  dext does keyboard/pointer only. Ship `gamepad: False`.
- **Known friction, beta-acceptable:** (1) TCC — Accessibility (input inject) + Screen
  Recording (`screencapture`) grants attributed to `python3` under launchd; one prompt each,
  may need re-grant after a CLT update; needs one good doc page. (2) `/usr/bin/python3` is a
  shim until Command Line Tools is installed — installer detects and walks the user through
  the CLT dialog; do NOT bundle Python (notarization hell). (3) Macs sleep aggressively and
  iOS cannot send UDP, so no WoL from the phone — doc "Wake for network access". (4) media
  metadata needs the private MediaRemote framework, locked down since macOS 15.4 — `media`
  ships `False` or keys-only. (5) No CEC on Macs — TV is network backends only, same as
  Windows.
- **Unverified (assessment was read-from-source + platform knowledge, nothing executed):**
  CGEvent injection from a launchd agent + the exact TCC prompt flow; `steam://` launch
  behaviour on macOS Steam (fire the URL, don't grep — house rule); `screencapture` latency as
  a frame source; System Events restart without prompts. All live-testable same-day on the dev
  MacBook Pro M2 before any code is committed.
- **Estimate:** Phase 1 in a few focused sessions; the win port took 0.3.x→0.4.3 to reach
  parity, but it also invented the non-Linux skeleton this port inherits.

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

### App Store listing revamp + fresh screenshots — SHIPPED 2026-07-24 (app 2.9.23)
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
- **DONE 2026-07-24 with app 2.9.23.** Both store descriptions rewritten (TV control,
  Fleet, battery, PIN pairing added), the **licensing violation FIXED** ("open-source
  agent, source-available app"), and iOS + iPad screenshots pushed to BOTH stores
  (7 phone + 5 tablet), verified by reading the listings back rather than trusting the
  upload's exit code. Capture method that produced them: iPhone 17 Pro Max / iPad Pro
  13" Simulator + deep-link pair + simctl + PIL bezel/caption, BETA badge painted out.


### 2026-07-27 — Release 2.9.30 (app 2.9.30 / agent 2.9.60) + three security fixes
- **Shipped:** iOS build 99 submitted to App Store review; Android versionCode 66 LIVE on
  Play production; agent 2.9.60 published as signed release assets. Tag `v2.9.30`.
- **App:** in-app QR pairing scanner (hardware-verified); "Boots into" card (Game Mode /
  Desktop / Last used); non-Steam shortcuts in Launch; one-flick-one-step swipe; TV mode
  demoted to off-by-default beta; Display / Audio readout card on Console.
- **Agent:** boot session default; display + audio probes (gamescopectl / kscreen-doctor /
  DRM+EDID, HDR and VRR reported as STATE not capability); flatpak update completion via
  the update PROCESS rather than a count an EOL runtime pins above zero (KI-036).
- **Security, all found by adversarial review rather than by failure:**
  - **KI-033** — `isValidLanIp` accepted `010.1.1.5` as private while `inet_aton` resolves
    it to the PUBLIC 8.1.1.5. Guarded an unauthenticated ping response that becomes a
    bearer-token destination. Rule moved to import-free `lib/lanIp.ts` with a corpus.
  - **KI-034** — `DeepLink` accepted ANY host, so `couchside://setup?host=evil.com` added a
    public box and the app beaconed the token to it. Now behind `parsePairLink`, plus a
    choke-point gate inside `addBox` so future callers start closed.
  - **KI-035** — `arrayBuffer()` with no cap on screen frames and album art; a huge body
    was buffered whole then base64-amplified. Capped both sides.
  - **KI-037** — every agent update restarted Decky Loader, reloading every OTHER plugin
    the user has. Now skipped unless our panel actually changed. Surfaced by a user report
    of an unrelated plugin at 27 GiB "right after updating your app" — not our leak, but
    our restart is what made another plugin's growth look like ours.
- **Process:** `release-agent.sh` now states which AGENT version it publishes onto which
  APP release tag, and warns on a same-version republish — the tag/version mismatch had
  caused a stale publish. Store notes for both stores were stale ("New in 2.9.29") and
  were rewritten; Play gets its own 500-char file.


### Launch non-Steam shortcuts from the phone (Netflix, Hulu, EmuDeck, …)
- **priority:** P1 · **risk:** low · **affects:** agent + app · **depends_on:** none
- **SHIPPED 2026-07-26** — kept here as the record of what it fixed.
- On SteamOS/Bazzite, `shortcuts.vdf` is how EVERYTHING that is not a Steam game
  reaches the TV: Bazzite's own `ujust get-media-app` registers Netflix/Hulu/Disney+/
  Max/Prime Video there, EmuDeck registers its launchers there, and this agent
  registers its own pairing and screensaver tiles there.
- **MEASURED on the maintainer's Bazzite box:** `/api/launchers` returned **5** entries
  (all installed Steam games) while `shortcuts.vdf` held **32**. Every streaming service
  on the machine was unlaunchable from the phone. After the change: **36 launchers,
  5 steam + 31 shortcut**, and a live `POST /api/launchers/shortcut:<appid>` put Netflix
  on the TV.
- **Allowlist shape:** `shortcut:<appid>` must be all digits AND still present in
  shortcuts.vdf; argv is rebuilt as `["steam", "steam://rungameid/<gameid>"]` from the
  agent's own constants plus the validated integer, using the non-Steam encoding
  `(appid << 32) | 0x02000000`. The shortcut's stored Exe — an arbitrary path Steam
  holds — is NEVER executed directly; Steam runs it, exactly as pressing the tile would.
- The agent's own tiles are filtered out, and proven unlaunchable rather than merely
  unlisted.

### TV pad mode — swipe drives the cursor in tile-sized jumps
- **priority:** P1 · **risk:** low · **affects:** app only · **depends_on:** none
- **SHIPPED 2026-07-26.** Kept as the record of why it exists.
- **The problem, measured:** on SteamOS the streaming services people actually watch are
  web pages. Arrow keys do NOT navigate them — Chromium has no spatial navigation by
  default, its `--enable-spatial-navigation` flag is documented to break on any page
  calling `Element.focus()` (Netflix does), and Firefox removed the feature entirely.
  Verified on the box: uinput arrow keys moved Steam's own selection (0 px idle vs
  155,515 px, selection moved exactly two tiles) but a browser tile grid only scrolls.
- Every shipping Linux TV product converged on driving a CURSOR instead of a focus ring —
  KDE's purpose-built Aura browser ships `navMode: "vMouse"`. This mode does that, but in
  tile-sized jumps with a haptic per step, so it FEELS like a d-pad while being a pointer.
  It therefore works on every service, including the ones with no TV UI at all.
- **Not a tab.** Revised 2026-07-26 on owner feedback: it is a chip in the surface's top-left
  corner that flips what a swipe step SENDS (arrow keys for Steam vs pointer jumps for
  browser apps). The mode row was already full at phone width, and TV is a property of the
  swipe rather than a separate input device — the segmented control still reads SWIPE.
- **Auto-switching was investigated and is NOT possible today.** `/api/gaming` reports only
  session and output — no running app for a Steam-launched shortcut (measured with Netflix
  up). `/api/media` shows ZERO MPRIS players while Netflix is open but idle; a player only
  appears once something plays, which is exactly when tile navigation is no longer needed.
  There is no focused-window endpoint. Auto-switch would need a NEW agent capability
  reporting the focused window under gamescope.
- **App-only.** Reuses `SwipeSurface` verbatim — same discrete stepping, same haptic
  rate-limit, same gesture-termination safety — and only changes what a step SENDS.
  Nothing is held between steps, so there is no latched axis to release.
- Step size is a preference (Small/Medium/Large = 160/260/380 px) because "one tile" is
  not a fixed distance: it depends on the service's grid density and the screen.
- **The open question got answered, and the answer was no.** Tested from the couch
  2026-07-26: "it just moves the mouse cursor a bit and you can see the cursor." So uinput
  pointer motion DOES reach the browser under gamescope — the thing this entry listed as
  unproven is now proven — but the premise the mode was built on does not hold. The claim
  above ("it FEELS like a d-pad while being a pointer") assumed the jump would land ON
  something. A d-pad moves a focus ring the app draws; this moves a visible cursor, and a
  browser tile grid has no focus model for a jump to land on, so nothing highlights and the
  step size is just a distance. Hiding the cursor would be worse, not better: with no focus
  ring, the cursor is the only feedback there is. Bigger steps overshoot different things.
- **Demoted to opt-in 2026-07-26 (`tvNavEnabled`, default OFF)** rather than removed. It is
  still the right shape on any surface that DOES draw focus, and the machinery is shared
  with SWIPE so it costs nothing to keep. Labelled UNPOLISHED in Preferences, in the copy,
  so nobody turns it on expecting a TV remote. Do not promote it back to default-on without
  a focused-window capability to snap against — that is the missing piece, not step tuning.

### Media seek buttons (-10s / +10s) on the now-playing card
- **priority:** P2 · **risk:** low · **affects:** app only · **depends_on:** none
- **Requested by u/Most-Bet2021 (r/SteamOS, 2026-07-26):** "a button that fast forwards media
  or goes back like 10+ seconds".
- **The agent side already exists in full — this is an app-only change.** Verified by reading
  the source, not grepping for absence: `POST /api/media/<player>/seek` with
  `{"position_ms": int}` is live (agent ~13034), `"seek"` is already in `MPRIS_OPS`
  (agent 7672), and `_mpris_seek` (agent 7888) prefers `SetPosition` with the current trackid
  and falls back to a relative `Seek` delta for players that reject it. The GET snapshot
  already returns `position_ms`, `length_ms` and `can_seek` (agent 7850-7853), which is
  everything the app needs to compute an offset. The app's `MediaOp` union already includes
  `'seek'` (api.ts:517).
- **So the work is:** two buttons in the transport row of `NowPlayingCard.tsx`, reusing the
  `send('seek', { position_ms })` path the scrub bar already uses (NowPlayingCard.tsx:105-108).
  Clamp to `[0, length_ms]`, gate on `can_seek` exactly as the bar does.
- **Why it is worth doing even though the scrub bar exists:** the bar needs a precise tap on a
  thin target from the couch. Discrete ±10s is the "what did they just say" / "skip the intro"
  gesture, and it is the one the request actually named.
- **No allowlist, capability, or endpoint work.** Nothing new reaches D-Bus: the op is still
  looked up in the closed `MPRIS_OPS` table and the player name is re-validated against a
  fresh `ListNames` before use.
- **Unverified:** whether a seek actually lands on the players people use in Game Mode. On
  bazzite.local `playerctl` is NOT installed (only `mpris-proxy`, which is BlueZ's AVRCP
  bridge, not a player) — the agent shells `busctl` instead, which IS present. Needs a live
  test with Chrome/Firefox/Plex/Kodi flatpaks actually playing, and `can_seek` observed both
  true and false.


### In-app QR pairing scanner (Netflix-style) — SHIPPED 2026-07-27
- **priority:** P1 · **risk:** med (new bearer-token ingress) · **affects:** app only
- Full-bleed camera in a modal off Setup > ADD/PAIR: corner-bracket reticle, translucent
  bottom card, back chevron — the Netflix look the owner asked for, minus Netflix's
  auto-apply trust model (their QR resolves to their infrastructure; ours hands over a
  bearer-token destination).
- **One validator, both callers** (`lib/pairLink.ts`, 26 bare-Node tests): byte-exact
  origin binding, LAN-only host allowlist (private IPv4 via lib/lanIp.ts, single
  non-address labels, `.local`), duplicate-param + octal-octet + hex-literal rejection
  (`0x08080808` getaddrinfo's to 8.8.8.8 — measured), reject-rather-than-sanitise.
  DeepLink.tsx now routes through it too (closes KI-034: it accepted ANY host before).
  `addBox` gained a choke-point gate; only the hand-typed form is exempt.
- Token-change collisions confirm before overwriting (a hostile QR for a box you own
  would otherwise silently swap your working credential); success haptic fires AFTER the
  gate, not on decode.
- **Requires a new native build** (expo-camera). Camera path untestable in the harness;
  everything else verified there by pressing the controls.

### 2026-07-24 — Phone→box file drop (agent 2.9.54 + app FileDropCard)
Send any file from the phone to the box. Agent gains a Bearer-gated `POST /api/upload?name=`
that STREAMS the request body to `~/Downloads/Couchside` in 1 MiB chunks (before the 8 MiB
in-memory body cap, so GB games/videos work), filename rejected-not-sanitised + realpath
contained to the drop root, atomic `.part`→rename. New `file_upload` capability (all 5 sites).
App: `lib/api.ts uploadFile()` (SDK-57 `File.createUploadTask` binary streaming, lazy-imported),
`FileDropCard` on the Console tab (probe-and-appear on the cap), deps `expo-document-picker` +
`expo-file-system`. Tested: `tests/test_upload.py` (happy / auth-fail / traversal+subdir+empty
reject / cap wired) + tsc clean. **Versioned 2.9.54 to stack on top of the un-merged gamepad
keepalive 2.9.53 (`866e3df`, currently deployed to the box) — NOT merged/deployed here.** NOT
yet exercised device→box end-to-end. On `feat/file-drop`; pick up in the session that owns the
gamepad 2.9.53: merge that first, rebase this on top (expect a one-line VERSION conflict → 2.9.54),
run the full agent suite, deploy, then drive FileDropCard on a device.

### 2026-07-24 — Trackpad tester-feedback triage: large-pad, WS zombie, pill, gestures (app)
Root-caused via a 4-agent workflow; shipped as four PRs, all merged to main.
- **Large-pad mode + one-tap corner toggle (#239).** `padTrackpadLarge` collapses the
  pill + mode tabs + button rows + keyboard bar so the drag surface fills the pane, on
  BOTH the MOUSE and SWIPE surfaces; a bidirectional corner chip (expand/contract, gated
  by `padLargeToggle`) toggles it in one tap. Not OS-fullscreen — the tab bar stays.
- **WS "green pill but dead" zombie (#240).** `connect()`'s guard now requires a live
  socket (`wsAlive`); new `ensureLive()` reconnects on foreground when the socket isn't
  provably live. Ends the "force-quit to recover" bug (`teardownSocket(false)` left status
  latched 'connected' over a null socket).
- **Pill tells the truth (#241).** `isStale()` + a 1s poll turn the pill amber
  ("no response · tap to retry") over a half-dead socket; the tap force-`reconnect()`s.
- **Gesture misfires (#242).** `onPanResponderStart` fixes the flaky two-finger right-click
  (a motionless tap now records 2 touches); a `scrolled` flag stops a short two-finger
  stroke leaking a click. Decision logic extracted to a pure module.
- **New capability:** the app's input path now has JS unit tests (19), run in CI via Node's
  `--experimental-strip-types --test` — first JS tests in the app, **no new dependency**.
  Control-verified (each bug test fails without its fix). Convention in CONVENTIONS.md.
- **Verified:** 19/19 unit tests + tsc + web-harness mount checks. Touch gestures (RN-Web
  is mouse-only) and the connected-WS path (harness proxy can't route `/ws/gamepad`) can't
  run in the harness — those are the pure-module + mock-WebSocket tests, by design.

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
