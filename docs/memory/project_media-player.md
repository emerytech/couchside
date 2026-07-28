# Project: Couchside Player — a real media-player tile, phone-driven

**Status:** Phase 0 SPIKE PASSED on hardware 2026-07-27. Nothing built yet.
**Branch:** `claude/couchside-media-player-f6e3df` (off `main`).
**Owner ask (2026-07-27):** "a Couchside media player that can host all of the streaming
services via a url input, similar to how Friendly Streaming works for macOS" — and,
explicitly: *"we may need to build a custom linux program and then add it as a non steam app
to make sure we are not just patching something quickly together."*

---

## 1. Why this exists (the insight, not the wishlist)

**TV pad mode already proved the navigation model is the problem, not the input plumbing.**
It shipped 2026-07-26 and was demoted to opt-in the same week. From that entry, measured:

> "it just moves the mouse cursor a bit and you can see the cursor" … "a browser tile grid
> has no focus model for a jump to land on, so nothing highlights and the step size is just
> a distance."

Right diagnosis, wrong layer to fix it at. A website will never draw a focus ring for us.

Friendly Streaming's actual trick is not that it is a browser — it is that **the app is the
navigation layer and the browser is only a video surface.** The phone holds the catalog,
sends a deep link, and the box opens *at the title*. Netflix's own tile grid is never
navigated, so the thing TV pad mode could not solve stops being on the critical path.

That is the feature. The URL bar is the mechanism, not the point.

---

## 1b. Reconciled against the actual inspiration (read 2026-07-27)

The first draft of this spec was written from four screenshots the owner pasted. The Mac App
Store listing for **[Friendly Streaming Browser](https://apps.apple.com/us/app/friendly-streaming-browser/id553245401?mt=12)**
was then read directly. Recording the diff, because two items changed the plan.

**Confirmed from the screenshots:** channel grid, custom URL entry, per-channel edit
(name/URL/icon), "My Streaming" = recently viewed, Discover = a genuine catalog.

**Missed, and it changed a priority:**
- **Cross-platform search** — *"Search across multiple streaming platforms in one go. Plus,
  explore top-rated movies and TV series by genre and IMDb ratings."* This spec had filed
  Discover as a P4 nice-to-have. Wrong. Search across services is what makes a hub beat six
  tiles, and it is the one capability that is **better** on a phone than on a TV, because you
  type on a phone. Promoted to Phase 5.
- **Visual controls** (brightness / saturation / contrast) — reads like desktop fluff, is
  actually a standing TV complaint, and is one injected CSS filter once CDP exists. Added to
  Phase 4.
- **Local video player** with its own codec list — a separate feature (files already on the
  box). Backlog at most; not part of this project.

**DELIBERATELY NOT COPIED — do not let these creep back in:**
- **Picture-in-Picture** and **window transparency.** These are Friendly's headline features
  because its premise is *multitasking on a Mac you are sitting at* — watch in a corner while
  you work. On a TV there is one screen, ten feet away, and nobody is multitasking. Copying
  these would be cargo-culting the inspiration instead of the insight.
- **Bundled VPN.** Not our business, and it would drag a network-level component into a
  LAN-only product whose whole security story is "no cloud, no accounts".

**DECIDED NO — the ad blocker (owner, 2026-07-27).** Friendly ships one ("Luna"). Couchside
will **not**, in any form: not for YouTube, not as an optional toggle, not as a user-supplied
filter list. It is against YouTube's terms and it would change how a paid app can be described
in two app stores, in exchange for something users can already get with an extension in their
own browser. Recorded in `DECISIONS.md`.

This is written as a refusal precisely because CDP makes it trivial — **injection capability is
not a licence to inject.** Anyone extending the player should read that line twice.

**Business datapoint:** Friendly is free with optional tips ($1.99 / $4.99 / $9.99). Worth
knowing when pricing this against a paid unlock.

**The part that is ours:** Friendly is single-machine — it assumes a keyboard within reach.
Phone-as-navigation-layer is not in that product, because it does not have the problem. The
inspiration supplies the *shape*; the differentiator is bigger than the first draft claimed.

## 2. Shape: this is the SCREENSAVER pattern, second instance

The owner's instinct ("custom program, registered as a non-Steam app") is not just correct,
it is **the pattern this repo already ships**. `agent/couchsided.py:2028` documents every
hard-won detail of it for `Couchside Screensaver`:

| Lesson (already measured, already shipped) | Consequence for the player |
|---|---|
| "it must be launched THROUGH STEAM (gamescope surfaces only what Steam focuses — the atom tricks were tested and do not work)" | Kills any design where the agent spawns the browser directly in Game Mode. Steam launches the tile. |
| Steam titles a non-Steam shortcut from the **file basename** | The installed file is literally named `Couchside`, not `couchside-player.sh` |
| `steamos-add-to-steam`, then poll `shortcuts.vdf` (≤10s), then `steam://rungameid/<id>` | Same registration routine, `SS_REGISTER_WAIT_S` |
| A fresh registration's **first** `rungameid` only opens the tile's page — needs a **double fire ~4s apart** | Same, `SS_FIRST_LAUNCH_GAP_S` |
| Stop kills the pid from a **pidfile, NOT the pgid — Steam's reaper owns the process group** | Same pidfile discipline |
| Grid art at `grid/<appid>p.png` or the tile is a filename-on-gradient placeholder | Ship a branded capsule beside the binary, like `steam-grid/` |
| Legacy-path fallback so a rename does not orphan already-registered boxes | Same `_ss_script()`-style resolver |
| File-level `shortcuts.vdf` edits **do not stick** — Steam rewrites from an authoritative copy | Registration goes through `steamos-add-to-steam`; **removal may not be reachable from the agent at all** |

So the player is: a separate program, shipped as a signed release asset, installed by
`install.sh` / the Decky plugin, registered as a non-Steam app, and managed by the agent over
a conf file + pidfile. Exactly the screensaver's lifecycle, bigger scope.

## 3. What the custom program IS — and is not

**It is not a browser engine.** It is a session manager + remote endpoint + TV UI that drives
Chromium as a child.

```
"Couchside"  (python3 stdlib, the Steam tile)
  ├─ spawns Chrome:  --app=<url> --ozone-platform=wayland --user-data-dir=<own>
  │                  --remote-debugging-port=<random, 127.0.0.1>
  ├─ drives it over CDP (WebSocket)  ── play/pause/seek, navigate, read <video> state
  ├─ serves its own TV hub page on loopback ── a focus model we control
  ├─ pidfile + conf, exactly like screensaver.pid / screensaver.conf
  └─ agent talks to it over loopback; the phone talks to the agent
```

**Widevine decides the engine, and it is not a preference.** Electron ships no CDM; the only
path is castlabs ECS + VMP signing — and ROADMAP already records that StreamingServiceLauncher
(*which is* castlabs Electron) has open Netflix "unsupported browser" breakage **specifically
on Bazzite**, the primary target. Meanwhile Chrome plays these services on the owner's box
today. Reuse the engine that demonstrably works on the target; own everything around it.

Also rejected: a Couchside kiosk page that iframes the services (every major service sets
X-Frame-Options/CSP and DRM in a frame fails), and `steam://openurl` into Steam's CEF browser
(no Widevine at all).

**The CDP client is reuse, not new code** — the agent already hand-rolls a masked RFC6455
client for the WebOS TV backend at `agent/couchsided.py:5930`.

### What CDP buys that shelling out to `--app=` cannot

- **Real playback state** from the `<video>` element (`currentTime` / `duration` / `paused`).
  Fixes the measured MPRIS blind spot ("`/api/media` shows ZERO MPRIS players while Netflix is
  open but idle") and delivers the −10s/+10s seek requested by u/Most-Bet2021, on web video,
  where MPRIS gives nothing.
- **A focus model on our own hub page**, which is precisely what TV pad mode could not get
  from a website.
- One branded tile instead of six half-broken ones, which largely dissolves the adopt-vs-install
  collision problem in the "Packaged media shortcuts" entry.
- Steam's own reaper cleans up correctly — **measured**, see Phase 0b/Q7.

**CORRECTION (Phase 0b, 2026-07-27):** an earlier draft of this spec claimed the app's existing
`NowPlayingCard` + `stop_running_game` (`agent/couchsided.py:10460`) would handle the tile "for
free". **That is wrong.** With the tile running under gamescope, `/api/status` carried no
running-game field — consistent with the ROADMAP's prior measurement that `/api/gaming` reports
"no running app for a Steam-launched shortcut". A non-Steam shortcut is invisible to the
agent's running-game detection, so the player must report its own state and ship its own stop
control. Budget for that in Phase 2 rather than assuming it is free.

---

## 4. Phase 0 spike — RESULTS (bazzite 10.1.1.60, agent 2.9.60, 2026-07-27)

Harness: `scripts/` candidate, currently `/tmp/cdp_spike.py` on the box — stdlib CDP client,
Chrome launched via flatpak, driven over the DevTools WebSocket.

| Question | Result |
|---|---|
| Q1 CDP reachable from the HOST while Chrome is in the flatpak sandbox | **reachable** — `Chrome/150.0.7871.186`, `LISTEN 127.0.0.1:9333`. Confirms the app's `shared=network` Context |
| Q2 Widevine CDM loads with CDP attached | **GRANTED `com.widevine.alpha`** (`SW_SECURE_DECODE`) |
| Q2b hardware-secure (L1) | **DENIED `NotSupportedError`** — L3 only, i.e. the **720p Netflix ceiling is real and confirmed**, not a guess |
| Q3 encrypted content actually plays, CDP attached **[control]** | **WORKS** — Shaka Angel One Widevine asset + `cwip-shaka-proxy` no_auth licence, `stage: playing`, `currentTime 1.224 / 60` |
| Q4 automation tells | `navigator.webdriver` **false**, no `HeadlessChrome` in UA, `navigator.plugins.length 5` |
| Q5 real services render, logged out, fresh profile | **max / netflix / hulu all render, no browser-wall** |

The control in Q3 is the point: a public, no-login, known-good Widevine stream, so a failure
would have been ours and not a service's anti-automation.

### Two traps the spike hit, both worth keeping

1. **`--ozone-platform=wayland` is REQUIRED when spawning from a non-graphical parent.**
   Without it Chrome picks the X11 ozone backend, finds no xauth cookie, and dies before it
   ever binds the debugging port:
   `Authorization required, but no authorization protocol specified` /
   `Missing X server or $DISPLAY` / `The platform failed to initialize. Exiting.`
   This is exactly how the agent (systemd user service) or an SSH session would spawn it.
2. **Chrome's DevTools HTTP endpoint ignores `Connection: close`.** Reading to EOF hangs until
   the socket timeout — *after* the body has already arrived — which reads as "CDP
   unreachable" and nearly killed the design on a harness bug. Parse `Content-Length`.

### Box facts measured while surveying

- **No system Chromium.** `com.google.Chrome` **flatpak** 150.0.7871.186 is the only
  Widevine-capable browser present. So the flatpak-reaper question below is not hypothetical.
- Existing working tiles are `flatpak run com.google.Chrome --no-first-run --start-fullscreen
  --app=<url>` for **Hulu / Disney+ / Prime Video / Max** — logged in, shared profile.
- **Netflix is the odd one out**: its tile is
  `/var/home/bazzite/Applications/streaming_scripts/netflix` = StreamingServiceLauncher, with
  its own CDM at `~/.config/streaming-service-launcher/WidevineCdm/4.10.3050.0/`. That is the
  duplicate-with-an-empty-cookie-jar mess the ROADMAP describes, sitting on the box right now.
- Chrome flatpak owns `org.mpris.MediaPlayer2.chromium.*`, so MPRIS during playback is
  plausible — **not yet observed**.

---

## 4b. Phase 0b — Game Mode, the two questions desktop mode could not answer

Same box, flipped to Game Mode with the product's own path (`POST /api/couch-mode`,
`{"output":"DP-1"}`) and returned afterwards with `POST /api/desktop-mode`.

| Question | Result |
|---|---|
| **Q6** Does a wrapper tile — Steam launches it, it spawns Chrome as a child — surface under gamescope? | **YES, proven by screen capture.** Widevine content playing fullscreen `1920x1080`, `document.visibilityState: visible`, our own page's banner drawn over it, read live over CDP at `t=52.2/60` |
| **Q7** Does Steam's process-group kill reap a **flatpak** Chrome child, or orphan it on the TV? | **Reaps it cleanly.** After `SIGTERM` to the reaper's pgid: 0 `/app/bin/chrome` processes, 0 `flatpak ps` instances, 0 wrapper, CDP port closed |

Mechanics confirmed on the way through: `steamos-add-to-steam` registered the tile and the
appid appeared in `shortcuts.vdf` within seconds; Steam launched it through
`reaper SteamLaunch AppId=<appid> --`; CDP stayed reachable on loopback from outside the tile.

### THE BACKEND TRAP — the single most important Phase 0b finding

**The ozone backend cannot be hardcoded. It is the exact inverse between the two sessions.**

| Session | What Steam/the parent provides | Correct flag |
|---|---|---|
| Game Mode (gamescope) | `DISPLAY=:1`, **`WAYLAND_DISPLAY` unset** | `--ozone-platform=x11` |
| Plasma desktop, spawned from a non-graphical parent (systemd user service, ssh) | `WAYLAND_DISPLAY=wayland-0`, no usable xauth cookie | `--ozone-platform=wayland` |

Get it wrong in either direction and Chrome exits **rc=1 before binding the debug port** —
`Failed to connect to Wayland display: No such file or directory` in Game Mode, or
`Missing X server or $DISPLAY` on the desktop. Both were hit for real. The player must select
per launch:

```sh
if [ -n "${WAYLAND_DISPLAY:-}" ]; then OZONE="--ozone-platform=wayland"
elif [ -n "${DISPLAY:-}" ];         then OZONE="--ozone-platform=x11"
else                                     OZONE=""; fi
```

### A landmine Phase 1 must not step on

`_ss_appid()` (`agent/couchsided.py:2145`) anchors its `shortcuts.vdf` lookup on the literal
`b"couchside/Couchside"`. A player tile installed at `~/.local/opt/couchside/Couchside Player`
**would also match that prefix**, and whichever entry appeared first in the file would win —
silently breaking the shipped screensaver's launch. The Phase 0b tile was deliberately put at
`~/.local/opt/couchside-player/` to avoid this. Phase 1 must either keep a distinct directory
or tighten the screensaver's anchor first.

### A measurement error worth keeping, from Phase 2

Phases 0b and 1 both reported "0 Chrome processes" after a reap, measured with
`grep -F "/app/bin/chrome"`. **That pattern never matches on this box** — the flatpak's real
argv is `/app/extra/chrome`. The check could only ever return 0, so it was evidence of nothing.
The conclusion happened to survive, because `flatpak ps` and the closed CDP port were
independent signals that did hold. Phase 2 re-measured with the correct pattern and a built-in
control: **15 → 0** across a close, which proves the pattern matches when Chrome IS running.

The rule this is an instance of: a "zero" from a pattern you have never seen match a live
process is not a measurement (CLAUDE.md §11 rules 2 and 3).

### Steam relaunches the tile on its own

Observed 2026-07-27: after the box returned to Game Mode, Steam launched the registered tile
without anyone asking — `reaper SteamLaunch AppId=3442312991` parented by `steam -gamepadui`.
So `running` can become true with no `POST /api/player` behind it, and the app must treat the
tile's state as *observed*, never as *what we last commanded*. Not yet run down to a cause
(Steam restoring the last-run app is the obvious candidate, unconfirmed).

### Side effect to clean up

The probe registered a real non-Steam shortcut named **"Couchside Player"** (appid
`4251224299`) in the maintainer's Steam library. Removal is a Steam-UI action — consistent with
the known "file-level `shortcuts.vdf` edits do not stick" constraint.

## 5. Security design

The one genuinely new primitive here is "a client can make the box's browser go somewhere",
plus CDP. Both are handled explicitly rather than assumed benign.

### URL handling — three tiers, only the first two ship by default

1. **Frozen service table.** The client sends `service_id` only. Host, exe and argv come from
   a frozen dict in agent source, exactly like `LAUNCHERS` / `ACTIONS`. An id that is not
   present is a 404, never a pass-through. This is the whole channel grid.
2. **Deep links, host still not client-supplied.** Client sends `service_id` + `path`; the
   path is validated against **that service's own regex** on its table entry (Max
   `^/video/watch/[0-9a-f-]{36}$`, Netflix `^/watch/\d+$`, …). Covers the real use case —
   share a link from the phone, it opens on the TV — with zero widening of the allowlist.
3. **Free URL bar.** A genuinely new primitive, so it is gated behind a **box-side config flag
   that ships OFF**. A default install never gains arbitrary navigation.

Tier-3 validation rules (reject, never sanitise — §3 rule 6):

- `https` only. `http` only when the host is loopback or RFC1918 (the Plex/Jellyfin case).
- Parse with `urllib.parse`, then verify the parts independently: no userinfo in the netloc,
  host is a valid DNS label set or IP literal, port from a small allowed set, no control
  characters or whitespace anywhere in the raw string, length capped, ASCII only (reject IDN
  rather than normalising it).
- **Never hand a client URL to `xdg-open` or `steam://openurl`.** Both re-dispatch by scheme,
  so a crafted string becomes an arbitrary handler launch — that, not the navigation itself,
  is the RCE path. Always an argv list into the browser binary the player resolved.
- Rate-limit the open route the way `pair_show_on_box` is rate-limited after **KI-019**, so a
  LAN peer holding the token cannot strobe the TV.

Accepted and documented, not fixed: once a page is open it can navigate anywhere. That is
inherent to a browser.

### CDP is an RCE primitive and is treated as one

`Runtime.evaluate` runs arbitrary JS; `Page.navigate` to `file://` plus a DOM read is local
file exfiltration. Therefore:

- Bind to `127.0.0.1` on a **random** port, chosen per launch.
- **Never expose or proxy the CDP port through any agent LAN route.** Not even read-only.
- The phone sends allowlisted **op ids**; the player maps op id → a CDP call **it** constructs.
  No client-supplied string ever reaches `Runtime.evaluate` or `Page.navigate`.
- Degrade closed (§3 rule 7): if no Widevine-capable browser is found, report unavailable
  rather than launching something that renders a black rectangle.

### Capability key

`player`, wired at all five edit sites (agent CAPS dict + mock tuple; app BoxCaps +
normalizeCaps + capsEqual), with a test asserting all five.

---

## 6. Phases

- **Phase 0 — spike. DONE 2026-07-27.** Results in §4. Design is viable.
- **Phase 1 — the tile. DONE 2026-07-27.** `agent/couchside-player.sh` + branded grid art +
  `tests/test_player_tile.py` (20 checks, wired into CI, two mutation-checked).
  **Verified live in Game Mode on bazzite 10.1.1.60:** `steamos-add-to-steam` registered it
  (appid `3442312991`), 3 grid-art files installed, `steam://rungameid` launched it, the tile
  auto-selected `--ozone-platform=x11` from `DISPLAY=:1` with `WAYLAND_DISPLAY` unset, Hulu
  came up **fullscreen and chromeless** (screen-captured), CDP listened on `127.0.0.1:38977`
  and reported the page. `SIGTERM` to the pidfile pid then left **0 chrome, 0 flatpak
  instances, 0 tile processes**, with both runtime files removed.
  Browser resolution on the real box returned `flatpak com.google.Chrome`, and
  `--print-url evilcorp` exited 1.
- **Phase 2 — agent integration. DONE 2026-07-27.** `player` cap at all five edit sites,
  `GET /api/player` (probe-and-appear) and `POST /api/player` (`op: open|close`), plus
  `tests/test_player_api.py` (44 checks, in CI).
  **The allowlist deliberately lives in the TILE, not the agent** — `_pl_validate()` settles a
  request by asking it (`--print-url <service> <path>`, non-zero means refused), so there is
  exactly one copy of the table and the validator is literally the code that will run. A
  second copy in the agent would be a copy that drifts.
  **Verified live on bazzite 10.1.1.60:** `caps.player` true; `GET` returns the tile's own
  service list; unauthenticated 401; unknown service and a bad `max` path both 404 with no conf
  written and nothing launched; `POST open netflix` → 200 → tile up with Netflix on the TV
  (screen-captured); `POST close` → 200 and **15 Chrome processes → 0**, flatpak instances 0,
  tile 0, pidfile gone, `running` false.
- **Phase 3 — app.** Watch tab (cap-gated), channel grid, deep links, share-sheet intake on
  both platforms. Exercised in the web harness by **pressing** the controls.
- **Phase 4 — transport + picture.** Play/pause/seek and now-playing read from the `<video>`
  element via CDP; the −10s/+10s ask. Plus **visual controls** (brightness / contrast /
  saturation) — one injected CSS `filter` on the video element, near-free once CDP is wired,
  and a real TV complaint ("this show is too dark") rather than a desktop toy.
- **Phase 5 — cross-service search.** *Promoted out of "later" after reading the real product
  (§1b).* Search once on the phone, see which service has it, jump straight in. This is the
  feature that makes a hub worth more than six tiles, and it is the one thing that is genuinely
  **better** on a phone than on a TV, because you type on a phone. App-side, so the agent stays
  stdlib. A bundled metadata API key is extractable — plan for that rather than pretending
  otherwise.
- **Phase 6 — hub UI + library.** The player's own TV page with a real focus model; recents /
  saved stored phone-side (no new box state, and `shortcuts.vdf` cannot hold it anyway).

---

## 6b. Prior art — what exists, and what is actually reusable

Surveyed 2026-07-27. Licence matters here: the agent/installer/protocol are MIT, so MIT and
MIT-or-Apache are ingestible; GPL is not.

| Project | Licence | Verdict |
|---|---|---|
| [StreamingServiceLauncher](https://github.com/aarron-lee/StreamingServiceLauncher) | **MIT** | The closest existing thing, and the one already installed on the maintainer's box. Electron + castlabs, its own cookie jar, `services.json` table, and a `steamos-install-streaming-app` helper. **Take the ideas, not the engine:** the services table and the Steam-install helper are the reusable parts; its separate profile is exactly the "logs me in every time" bug we are trying to avoid |
| [castlabs/electron-releases](https://github.com/castlabs/electron-releases) | **MIT** repo, but production Widevine needs their **EVS** signing service | The only legitimate Widevine-in-Electron path. Repo licence is not the constraint — VMP signing is. Reinforces "don't ship an Electron browser" |
| [ElectronPlayer](https://github.com/oscartbeaumont/ElectronPlayer) | MIT, **ARCHIVED Oct 2024** | Independent confirmation of the thesis. Netflix/Hulu/Prime in Electron with Widevine; the maintainer ended up pinning a June-2019 Electron per-OS and warned it would stop working. Exactly the treadmill we avoid by driving the user's own Chrome |
| [Igalia Cog](https://github.com/Igalia/cog) | **MIT** | WPE WebKit app container, the set-top-box shape done properly, with a `cogctl` D-Bus control surface. **No documented Widevine/EME support**, which is disqualifying — but it is the reference for what a clean control surface looks like |
| [KDE Aura browser](https://invent.kde.org/plasma/aura-browser) / Plasma Bigscreen | **GPL-3.0** | Cannot ingest. Still the best evidence for the design: a purpose-built TV browser that also concluded a cursor beats a focus ring on the open web |
| [ValvePython/vdf](https://github.com/ValvePython/vdf) | **MIT** | Binary `shortcuts.vdf` read **and write**. Cannot be a dependency (agent is stdlib-only) but it is the reference implementation for the format the agent already parses by hand |
| [BoilR](https://github.com/PhilipK/BoilR) | **MIT or Apache-2.0** | Bulk non-Steam shortcut import + SteamGridDB art. The prior art for the cover-art half of Phase 1 |

**Nothing found does what we are building.** Every project above puts the catalog *on the box*
and drives it with a remote. None makes the phone the navigation layer, and none exposes a
control surface a second device can drive. The reusable material is: SSL's services table
shape, BoilR/vdf's grasp of `shortcuts.vdf`, and Cog's control-surface design.

## 7. NOT verified — the live list

1. ~~Does the tile surface under gamescope?~~ **ANSWERED Phase 0b: yes, screen-capture proven.**
2. ~~The flatpak reaper problem.~~ **ANSWERED Phase 0b: Steam's process-group kill reaps the
   flatpak child cleanly — 0 orphans.**
3. **Profile choice.** A dedicated `--user-data-dir` avoids colliding with the user's desktop
   Chrome — a collision makes `--app=` open a tab in the existing instance and silently ignore
   our debugging port — but costs one-time logins. With phone keyboard + clipboard paste
   already shipped, "sign in using your phone" is a decent first run, and with ONE tile it
   never becomes the empty-duplicate mess. Not yet tried end to end.
4. **Playback of a real, logged-in service with CDP attached.** Q3 proved DRM works with a
   control asset; Q5 proved the services render logged out. Nobody has yet pressed play on
   Netflix in this configuration.
5. **MPRIS during playback.** Chrome flatpak may own the name; not observed.
6. **Un-registration.** Probably not reachable from the agent (Steam rewrites `shortcuts.vdf`);
   may have to be a "do this in Steam's UI" instruction, same as the screensaver.
