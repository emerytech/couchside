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
- Steam's Close Game works, and the app's existing `NowPlayingCard` + `stop_running_game`
  (`agent/couchsided.py:10460`) already handle a running Steam app. Free.

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
- **Phase 1 — the tile.** `Couchside` program: launches Chrome, pidfile, conf,
  `steamos-add-to-steam` registration, grid art, legacy-path resolver. Cloned from the
  screensaver routine. Proves it surfaces under gamescope when Steam launches it.
- **Phase 2 — agent integration.** `player` cap + routes (open by `service_id`, close, state)
  + tests: happy path, auth failure, non-allowlisted `service_id` refused and nothing runs.
- **Phase 3 — app.** Watch tab (cap-gated), channel grid, deep links, share-sheet intake on
  both platforms. Exercised in the web harness by **pressing** the controls.
- **Phase 4 — transport.** Play/pause/seek and now-playing read from the `<video>` element via
  CDP; `NowPlayingCard` integration; the −10s/+10s ask.
- **Phase 5 — hub UI + library.** The player's own TV page with a real focus model; recents /
  saved stored phone-side (no new box state, and `shortcuts.vdf` cannot hold it anyway).

---

## 7. NOT verified — the live list

1. **Does the tile surface under gamescope?** The screensaver precedent says Steam-launched
   things do, and the existing Chrome `--app=` tiles work in Game Mode. But the player is a
   *wrapper* that spawns Chrome as a child, and that exact arrangement is untested. The box
   was in Plasma desktop for Phase 0; Game Mode was never entered.
2. **The flatpak reaper problem.** `flatpak run` reparents through the portal into a separate
   cgroup, so Steam's process-group kill may leave an orphan Chrome on the TV after Close
   Game. There is no system Chromium on the box to fall back to, so the player must track and
   kill the flatpak instance explicitly. Untested.
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
