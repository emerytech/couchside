# Couchside — Architecture

Living-room box control from a phone. **LAN-only, bearer-token authed, no cloud, no account.**
The only outbound internet call in the whole system is the box's own GitHub update check
(`agent/couchsided.py:1004-1013`) — the phone app never leaves your network.

---

## 1. Components and how they talk

| Component | Language / runtime | Lives in | Role |
|---|---|---|---|
| Phone app | Expo / React Native / TypeScript (expo-router) | `app/` | The remote. Talks HTTP + one WebSocket to a box. |
| Linux agent | Python 3, **pure stdlib**, single file | `agent/couchsided.py` (11,121 lines) | The daemon on the SteamOS/Bazzite/Linux box. |
| Windows agent | Python 3 stdlib + `ctypes` Win32 | `agent/win/couchsided-win.py` | Same API contract v1 on a Windows HTPC. |
| Decky plugin | Python backend + React (Decky Loader) | `couchside-decky/` | Installs/manages the agent from Game Mode, no terminal. |
| Installers | bash / PowerShell | `install.sh`, `install.ps1` | Signed release assets; write unit, sudoers, udev, token. |

### Wire protocol

- **HTTP**, port **8787** (`DEFAULT_PORT`, `agent/couchsided.py:50`; app mirror `app/lib/settings.ts:86`).
  Server is `ThreadingHTTPServer` with `protocol_version = "HTTP/1.1"`, per-connection
  `timeout = 30`, and a hard `MAX_BODY_BYTES = 8 MiB` enforced *before* any body read
  (`agent/couchsided.py:9355-9369`).
- **WebSocket**, same port, single route `/ws/gamepad` — hand-rolled framing, no library
  (`WS_GUID` at `agent/couchsided.py:8673`, upgrade at `:10662-10695`). App side:
  `ws://<host>:<port>/ws/gamepad?token=…` (`app/lib/gamepad.ts:577`).

### Auth model

One shared bearer token per box, stored at `/etc/couchside/token`, loaded at startup and
re-readable so a regenerated token needs no restart (`_current_token`, `:9412-9424`).

```python
def _authorized(self):
    auth = self.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return False
    supplied = auth[len("Bearer "):].strip()
    return hmac.compare_digest(supplied, self.token)
```
`agent/couchsided.py:9494-9499`

Rules that fall out of that:
- Every `/api/*` route is gated (`do_GET:9571`, `do_POST:9889`). Auth happens **before** the
  body is read on POST, then the size cap, then the read — an unauthenticated client can't
  make the agent allocate.
- The WS token rides `?token=` and is checked **before** the 101 handshake (`:10669-10673`).
  Query strings are redacted from the access log (`_log:9445-9451`) because journald output
  is itself served back over `/api/journal`.
- **No CORS headers, deliberately** — `ACAO:*` would let a malicious browser tab read
  responses (`_send:9463-9465`).
- Unauthenticated routes are exactly four: `/api/ping`, `/pair`, `/api/pair/start`,
  `/api/pair/finish` (plus `/api/pair/status`).

### Discovery and pairing

1. **Discovery.** Two probes run in parallel and merge by IP (`app/lib/boxDiscovery.ts:1-16`):
   an HTTP sweep of the phone's /24 hitting unauth `GET /api/ping`, and a UDP broadcast of
   `COUCHSIDE_DISCOVER?` (`agent/couchsided.py:9257`). The HTTP sweep is the reliable path —
   **iOS blocks UDP on the local network**, so UDP is a fast-path bonus only.
   `/api/ping` returns `{ok, app, version, ip, host}` where `ip` is
   `self.connection.getsockname()[0]` — the LAN address the phone actually reached, cached by
   the app as a fallback for when mDNS `.local` dies (SteamOS Game Mode Wi-Fi power-save).
   `/api/status` refreshes the same value every poll (`:9575-9588`).
2. **PIN pairing** (app-initiated, no token yet). `POST /api/pair/start` mints a 6-digit PIN and
   opens the loopback `/pair` page **on the box's own screen**; `POST /api/pair/finish` trades
   the correct PIN for the token. TTL 120s, 5 attempts, 3s start debounce, one live session
   (`:9129-9200`, routes at `:9860-9886`).
3. **QR pairing** (box-initiated). `GET /pair` renders the token as a QR. Two independent gates,
   both required: peer IP must be loopback **and** the `Host:` header must name loopback
   (anti-DNS-rebinding — a page in the box's own browser can rebind a domain to 127.0.0.1, but
   its `Host` header still says `attacker.tld`). See `_is_loopback:9382` and
   `_host_header_is_local:9394`.
   The QR encodes `https://couchside.tv/pair#host=…&port=…&token=…&ip=…` — HTTPS because Android
   camera apps won't open custom schemes, and the params ride the **URL fragment** so the token
   never reaches a server (`build_pair_url:9107-9126`).

---

## 2. Directory layout

```
agent/
  couchsided.py            The entire Linux agent. Single file, pure stdlib, ~11k lines.
  couchside.service        systemd unit TEMPLATE; install.sh substitutes __USER__/__UID__/__EXEC__.
  couchside-screensaver.sh Aerial screensaver runner launched via a Steam shortcut.
  qr.py                    Terminal/HTML QR renderer for the pairing link (stdlib, no qrcode dep).
  win/couchsided-win.py    Windows agent — same API contract, ViGEmBus + SendInput + sc/wevtutil.
  win/couchside-tray.pyw   Windows tray widget; win/build.ps1 packages it.
  steam-grid/              Branded Steam capsule art for the screensaver shortcut.

app/
  app/(tabs)/              expo-router screens: index (Console), pad, launch, actions, fleet, setup.
  app/(tabs)/_layout.tsx   Tab gating from caps + first-run redirect to Setup.
  lib/api.ts               The whole HTTP client + every response type (BoxCaps, probeGated, capsEqual).
  lib/gamepad.ts           WebSocket client: pad/trackpad/keyboard frames, handoff, reconnect.
  lib/settings.ts          Persisted fleet/box model; normalizeCaps lives here.
  lib/SettingsContext.tsx  React context over settings.ts.
  lib/entitlement.ts       IAP unlock state; purchase.ts drives the store.
  lib/boxDiscovery.ts      HTTP /24 sweep + UDP probe, merged.
  hooks/useCapsSync.ts     Always-mounted 30s caps healer (see §3).
  hooks/usePoll.ts         Generic poll-with-resetKey hook every card uses.
  components/              One file per surface: RemoteView, RemotePowerBar, GamingCard, etc.

tests/                     Pure-stdlib python tests, no pytest. Each locks a field-proven trap:
  test_guide_hold.py       Guide-hold must not fire on a tap or match the agent's OWN pad.
  test_gamepad_handoff.py  Re-promotion must REUSE its virtual pad (orphan-pad regression).
  test_couch_ceremony.py   Staged desktop->TV switch; no fake-green "Ready", no wrong audio sink.
  test_steamlink.py        remoteclients.vdf + binary appinfo.vdf v29 parsing, launch allowlist.
  test_gaming_card.py      sysfs/proc fixtures: card* glob trap, reaper AppId matcher.
  test_stream_host.py      /proc/net fixtures; ESTABLISHED :27036 peer is the ROUTER, not a session.
  test_actions_inject.py   Injected-action gating.
  test_steam_menus.py      The frozen Steam settings-panel allowlist.

scripts/
  release-agent.sh         Publish agent assets (agent-version.txt / -win.txt) onto a release.
  sign-release.sh          Ed25519 detached signatures the installers verify.
  asc-submit.py            App Store Connect submission.
  play-release-notes.py    Play Console release notes upload.
  ws-latency-test.py       Cold-path latency harness for /ws/gamepad.
  web-dev.sh / web-dev-proxy.py  Local web dev against a real box.

.github/workflows/
  ci.yml                   compile job (py_compile all three entrypoints incl. the Windows agent,
                           cross-platform because py_compile is syntax-only) + smoke job (boot
                           --mock on a spare port, hit a real authed endpoint) + every tests/ file.
  notify-decky.yml         Pings the couchside-decky repo when the agent ships.
```

---

## 3. The architectural patterns that actually matter

### 3a. Probe-and-appear

Optional features are discovered, never assumed. The app fires a probe; **a 404 means the
surface doesn't exist and the UI hides it** — it is never an error.

```ts
async function probeOrNull<T>(p: Promise<T>): Promise<T | null> {
  try { return await p; }
  catch (e: unknown) {
    if (e instanceof ApiError && e.kind === 'http' && e.status === 404) return null;
    throw e;
  }
}
```
`app/lib/api.ts:654-661`

This is what makes an old agent and a new app compose without a version matrix: ship a route,
the surface appears; don't, and it stays hidden.

### 3b. The caps system (probe-and-appear, folded into the poll)

N features meant N probe round-trips on every connect. `caps` is a boolean summary that rides
the status poll the app already makes, so the right UI paints on the **first frame**
(rationale block at `agent/couchsided.py:931-947`). It is a **hint, not authority** — a live op
still confirms, and `probeGated` falls back to probing whenever caps is unknown:

```ts
function probeGated<T>(cap: boolean | undefined, probe: () => Promise<T | null>) {
  if (cap === false) return Promise.resolve(null);
  return probe();
}
```
`app/lib/api.ts:671-677` — only an **explicit false** skips the request. `undefined` (older
agent, or a key that predates this box's version) still probes, so behavior against agents
< 2.8.2 is unchanged.

Two details worth knowing:
- `CAPS` is a **boot-time snapshot** (presence of a Steam install, a session bus, a controller
  node is static per boot), *except* `desktop`, which is session-volatile and recomputed per
  request: `"caps": dict(CAPS, desktop=desktop_available())` (`agent/couchsided.py:1419-1423`).
- In `--mock` every capability reads `True`, so the whole app is exercisable on a dev laptop
  with no hardware.
- `hooks/useCapsSync.ts` is an always-mounted 30s safety net. Without it, a stale persisted
  `false` (cached before a box *became* capable) stuck forever for a user who lived on the Pad
  tab — observed in the field.

### 3c. Adding a capability key — FIVE sites, all mandatory

Miss any one and the cap silently never persists, so the app re-probes on every launch. This
has been shipped-and-fixed five separate times (`screensaver`, `couchmode`/`desktop`,
`steamlink`, `gaming`, `streamhost`, `steammenus` — the comments in `normalizeCaps` are a
scar log).

| # | File | Site |
|---|---|---|
| 1 | `agent/couchsided.py:980-994` | the real `CAPS` dict — `"newcap": safe(newcap_available)` |
| 2 | `agent/couchsided.py:975-978` | the **mock all-true tuple** — add the string or `--mock` lies |
| 3 | `app/lib/api.ts:79-137` | the `BoxCaps` type — declare it **optional** (`newcap?: boolean`) |
| 4 | `app/lib/settings.ts:200-241` | `normalizeCaps` — `const newcap = bool('newcap')` **and** put it in the returned object |
| 5 | `app/lib/api.ts:715-733` | `capsEqual` — add `a.newcap === b.newcap` |

Sites 4 and 5 are the trap. `normalizeCaps` hard-requires the six **original** keys as booleans
(`gamepad, steam, media, tv, screen, power_schedule`) and drops the whole blob if any is
missing — a partial payload is not half-trusted. Every key added *after* those six must be
optional, so `undefined` stays "unknown, probe" and never degrades to `false`.

Current keys: `gamepad`, `steam`, `media`, `tv`, `screen`, `power_schedule`, `screensaver`,
`couchmode`, `desktop`, `steamlink`, `gaming`, `streamhost`, `steammenus`.

Caps also gate whole tabs — `hidePad = caps?.gamepad === false`,
`hideLaunch = caps?.steam === false` (`app/app/(tabs)/_layout.tsx:28-30`), which is how a
headless "server box" loses its gaming tabs. Note the `=== false`: **never hide a tab on a guess.**

### 3d. Single-file, pure-stdlib agent

Immutable/atomic distros (SteamOS, Bazzite/ostree) have no usable `pip`, so the agent imports
nothing outside the stdlib — no `psutil`, no `requests`, no `vdf` parser. Consequences visible
throughout:

- Metrics come from `/proc` directly: `/proc/uptime` (`:749`), `/proc/meminfo` (`:886-898`),
  `/proc/net/route` for the default interface (`:768-780`), `/sys/class/net/<if>/address` for
  the MAC.
- HTTP is `urllib.request` (`_http_text:1017-1024`), JSON is `json`, hashing is `hashlib`/`hmac`.
- uinput is driven by **hand-assembled ioctl numbers** — the kernel's `_IOC` macros
  reimplemented in Python (`:6887-6926`), with a runtime assert that
  `struct uinput_user_dev` packs to exactly 1116 bytes (`:6937-6940`).
- WebSocket framing is hand-rolled (`ws_recv_frame`, `_wsend_op`, `_wsend_json` at `:8789-8810`).
- Steam's VDF is line-scanned rather than parsed:
  ```python
  # Steam's VDF has no stdlib parser and the agent ships pure-stdlib (no pip on
  # immutable distros), so rather than vendor a parser we line-scan for the one
  # thing needed here: `"path"   "<value>"`.
  ```
  `_parse_vdf_paths`, `agent/couchsided.py:2609-2627`. The binary `appinfo.vdf` gets a bespoke
  v28/v29 reader (`:2839-2934`) locked by a synthetic fixture in `tests/test_steamlink.py`.
- CI enforces the constraint cheaply: `py_compile` on all three entrypoints plus a `--mock`
  boot-and-authed-request smoke test, no dependencies to install (`.github/workflows/ci.yml`).

### 3e. Injected Actions — gated on the box *actually* being able to do it

Actions are config-driven (`/etc/couchside/config.json`), but four are **injected at load time
only when the box can really perform them**, because *a dead button costs more trust than a
missing one*. All four are idempotent, run after `load_config`, and yield to a config-defined
action of the same id (`main:11076-11079`).

| Action | Gate | Site |
|---|---|---|
| Switch to Desktop / Return to Game Mode | `shutil.which("steamos-session-select")` | `:611-623` |
| Suspend | sudoers NOPASSWD grant for `systemctl suspend` | `:677-690` |
| Restart Decky | unit file **and** NOPASSWD grant for `systemctl restart plugin_loader` | `:698-716` |
| Pair Controller | a Steam install (the action is a `steam://` URL) | `:718-733` |

The sudo probe is the load-bearing part, and its docstring is the best bug story in the repo
(`_nopasswd_last_match`, `:626-653`): `sudo -n -l <cmd>` exit-code probing returns 0 for *any*
allowing rule including password-requiring `(ALL) ALL`, and "any NOPASSWD line names the
command" is wrong because **sudoers is last-match-wins and sudoers.d loads in lexical order** —
a box's `wheel` file sorted after `couchside` and silently shadowed every grant for three days.
Hence the real evaluator walks rules in order tracking the last match, and the installers now
write `zz-couchside` so it sorts last. Any failure returns `False`: a missing grant must **hide**
the action.

### 3f. TTL-memo caches

Every expensive read is memoized behind a monotonic-clock TTL so the app's polls stay cheap.

| Cache | TTL | Why | Site |
|---|---|---|---|
| `_NET_CACHE` | 30s | avoid shelling to `ethtool` per status poll | `:761-763`, `:836-840` |
| `_GAMING_CACHE` | 2s | ~5s card poll must not re-scan sysfs/proc | `:8004-8006`, `:8300-8310` |
| `_STEAM_LIB_CACHE` | 30s | re-reading `libraryfolders.vdf` + realpath per request | `:2665-2680` |
| `_update_cache` | 6h | GitHub contacted at most a few times a day | `:1013-1045` |
| `_APPINFO_CACHE` | mtime+size keyed | the multi-MB `appinfo.vdf` blob | `:2822-2830`, `:2936-2952` |

Chatty *logging* gets the same treatment: `/api/screen/frame` successes are sampled to one per
15s so a 1–2 fps preview can't scroll real diagnostics out of the journal (`:9436-9440`).

### 3g. The launcher allowlist

`POST /api/launchers/<id>` never executes a caller-supplied argv. `_launcher_argv`
(`agent/couchsided.py:3243-3283`) resolves an id only if it corresponds to a launcher that
actually exists right now:

- `steam:<appid>` → digits only, **and** `_steam_game_installed(appid)` must find that specific
  `appmanifest_<appid>.acf`.
- `stream:<appid>` → digits only, **and** the appid must appear in `_streamable_appids()`, the
  set harvested from `remoteclients.vdf` (a host game is by definition *not* installed locally,
  so the on-disk check can't apply).
- `custom:<slug>` → must match a stored launcher; the argv comes from config, never the request.

Anything else returns `None` → 404 "unknown launcher". Launch itself is
`subprocess.Popen(argv, shell=False, start_new_session=True)` into a discovered graphical
session env (`real_launch:3306-3320`). Two related kill switches default **off**:
`ALLOW_APP_UPDATE` and `ALLOW_APP_LAUNCHERS` (`:238`, `:248`) — app-side launcher *creation*
would let any bearer-token holder run an arbitrary command.

### 3h. Session and handoff state (`/ws/gamepad`)

Multi-phone control is explicit. Module state: `GAMEPAD_LOCK`, `GAMEPAD_HOLDER` (the one entry
owning the virtual devices), `GAMEPAD_SESSIONS` (holder + waiters) at `:8776-8778`. Each entry
carries its own `slock` so sends are serialized per socket.

On connect, `?handoff=ask` decides the role (`_gamepad_session:10702-10745`):
no holder → **hold**; `ask` → **wait**, and the holder gets a `control_request` prompt;
anything else (including pre-2.9.2 clients) → **takeover**, demoting the holder with a
`{"t":"released","by":…}` frame. Waiters receive `waiting`; only the holder ever receives
`hello`, so **`hello` IS the "you have control now" signal** (`_make_holder:8849-8892`).

Two hard-won details:
- Waiters **pre-create** their mouse/keyboard while the human decides, because the uinput
  enumeration settle burns real time — first input after a pass measured 524ms with
  create-at-grant vs ~7ms with create-at-wait (`:10743-10756`).
- `_make_holder` **reuses** an existing pad on re-promotion. The old always-create path orphaned
  a pad per Pass/take-back cycle with its fd open; three phantom "Microsoft X-Box 360 pad"
  devices were found on one box after an afternoon, and the enumeration churn corrupted that
  box's Steam desktop controller config. Locked by `tests/test_gamepad_handoff.py`.
- `GAMEPAD_IDLE_TIMEOUT_S = 12.0` (`:8786`): the app pings every ~5s, so 12s of silence means
  app→box is dead. A box→app heartbeat *cannot* detect this — it flows regardless and would mask
  a dead outbound.

---

### 3i. The skin seam (`app/lib/skin/`) — added #140

Console and Fleet render through a **swappable look**, not fixed styles. Screens compose
a `SkinKit` and never know which skin is active.

```
app/lib/skin/
  kit.ts       the SkinKit surface (Screen, Card, SectionTitle, BigMetric, Bar, Spark,
               Dot) + VitalsContext. This is the contract screens code against.
  motion.ts    useBreath, useReducedMotion, vitality(), breathPeriod().
  classic.tsx  the pre-redesign look, RETAINED as a live A/B control.
  reactor.tsx  the shipped look.
  index.tsx    registry, DEFAULT_SKIN, web-only ?skin= dev override.
```

Four rules a skin must obey — each exists because breaking it produced a real defect:

1. **ONE breath clock per screen**, shared via `VitalsContext`. N cards must not mean N
   oscillators.
2. **Semantic colour is sacred.** Callers pass the already-resolved
   `tempColor`/`pctColor`/`batteryColor` (battery is INVERTED — low is bad). A skin
   *decorates* with that colour and never substitutes its own. Vitality drives motion
   **rate**, never hue.
3. **Light mode branches explicitly** — halos in dark, tinted pills + border weight in
   light. Glow on a near-white background is mud.
4. **Reduced motion is a hard stop, not a slowdown**, and probe-and-appear cards
   mount/unmount mid-poll, so entrance animations must not re-fire.

`classic.tsx` is not dead code: `?skin=classic` renders the genuinely shipped 2.9.11
dashboard, which is what makes "is this a regression?" answerable in ten seconds rather
than from memory. **Do not delete it.**

**Verifying a skin is harder than it looks** — the browser pane reports
`visibilityState: hidden` permanently, so `requestAnimationFrame` runs at 0 fps while
Reanimated shared values keep advancing when read from JS. A probe that samples `.value`
reports PASS against a frozen DOM. Measure the *painted* result
(`getComputedStyle(el).opacity` over time). See CONVENTIONS §"Verifying app UI".

## 4. External integrations

**Steam.** Root discovery + library enumeration via line-scanned `libraryfolders.vdf`
(`:2597-2660`); installed games from `appmanifest_*.acf` as an **allowlist** (`:3118`);
non-Steam shortcuts registered through `shortcuts.vdf` + `steam://addnonsteamgame`
(`:1216-1255`), which is how the aerial screensaver gets a launchable, branded Steam entry with
custom capsule art from `agent/steam-grid/`. Everything user-facing is a `steam://` deep link
fired as the desktop user through the already-running client — `steam://rungameid/<id>` to
launch or stream, `steam://open/settings/bluetooth` for controller pairing.
**Remote Play** works in both directions and they are distinct caps: `steamlink` is the CLIENT
direction ("Stream from PC", parsed from `config/remoteclients.vdf`, `:2809-3050`), `streamhost`
is this box **serving** a session, detected log-driven and cross-checked against `/proc/net`
ports 27036/27031 (`:8371-8470`) — an ESTABLISHED peer on 27036 is the router, not a session.
Cover art is served from the box's own cache over the LAN, never a CDN.

**TV / CEC.** Three backends, in preference order (`:3492-3510`): `panel` — RS-232 to a
commercial display (e.g. Newline TruTouch), config-driven via `CONFIG_PANEL`; `cec` — HDMI-CEC
through the kernel framework (`cec-ctl`) or libcec (`cec-client`); `soft` — the box's own volume
via uinput media keys, the fallback when neither can drive the TV. CEC availability is
re-evaluated **cheaply per request** (`cec_current:3594`), because a TV powered on after the
agent booted must not stay hidden — only the ~6s libcec adapter probe is frozen at startup
(`set_cec:3575-3591`). `_usable_cec_dev` (`:3535-3549`) skips `/dev/cecN` whose DRM connector
reads `disconnected`, so the TV strip never appears over a dead bus. CEC has no discrete "off" —
`power_off` maps to standby. Smart TVs add hand-rolled backends: LG WebOS over its own WS
protocol (`:4215-4310`), Android TV / Samsung / Roku / VIDAA discovered by a stdlib mDNS query
implementation (`_mdns_discover:5689-5720`).

**MPRIS media.** Now-playing and transport over the user session bus via `busctl --user
--json=short` — no `dbus-python`, no `playerctl` dependency (`:6056-6160`). `mpris_available`
requires both `busctl` and a live session bus (`:6079-6082`). Album art is resolved from the
player's own advertised cache path and inlined by the app as a base64 `data:` URI, so nothing
sensitive lands in Fresco's disk cache (`app/lib/api.ts:749-790`).

**uinput virtual devices.** Four pure-stdlib device classes, each a legacy-uinput handshake of
`UI_SET_EVBIT` / `UI_SET_KEYBIT` / `UI_SET_ABSBIT` → write `uinput_user_dev` → `UI_DEV_CREATE`:
`UInputGamepad` (a virtual Xbox 360 pad, `:6927-6980`), `UInputMouse` (`:7088`),
`UInputKeyboard` (`:7145`), and `UInputMediaKeys` for soft volume (`:3945-3951` — needs
`/dev/uinput`, never sudo). Access comes from `SupplementaryGroups=input` in the systemd unit
plus the installer's udev rule — deliberately **not** an active login seat, since headless boxes
have none (`agent/couchside.service:15-18`). There is a mandatory settle window after
`UI_DEV_CREATE`: the compositor enumerates a new device asynchronously and events sent before
that lands are dropped (`:7065-7073`). Windows swaps the whole layer for ViGEmBus via
`ViGEmClient.dll` + `SendInput`, which is why that agent must run as a **logon-triggered
scheduled task in the interactive session**, never a session-0 service
(`agent/win/couchsided-win.py:27-32`).

**Screen preview.** Backend picked at startup (`set_screen:6442-6464`): gamescope/Game Mode does
*not* implement wlr-screencopy so `grim` fails there; KDE desktop sessions use `spectacle -b -n`.
Downscaling shells out to ImageMagick then ffmpeg, keeping the agent off PIL (`:6427-6438`).
