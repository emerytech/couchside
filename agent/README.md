# Couchside: box agent

The box-side half of Couchside: a tiny pure-stdlib python3 daemon for your
couch gaming box (Steam Deck / SteamOS, Bazzite, or any systemd Linux HTPC)
that lets the phone app check health, watch service logs, fire recovery
actions ("restart the session", "reboot"), and act as a virtual Xbox 360
gamepad, so you can un-wedge the box from the couch without a keyboard.

No pip dependencies. It runs on immutable distros (SteamOS read-only rootfs,
Bazzite/Fedora Atomic ostree) with nothing but the preinstalled `python3`.

## Install (run ON the box, as your normal desktop user)

```sh
curl -fsSL https://raw.githubusercontent.com/emerytech/couchside/main/install.sh | bash
```

The installer refuses to run as root (it uses `sudo` only where needed) and:

1. installs the daemon to `~/.local/opt/couchside/`,
2. creates `/etc/couchside/token` (pairing secret, `chmod 600`),
3. generates an initial `/etc/couchside/config.json` tailored to the box
   (adds `sddm.service` and a session-restart action only if sddm exists;
   adds a stop-kodi action only if the Kodi flatpak is installed),
4. installs a **narrow sudoers rule** (see Security below). It prints the
   exact contents first, and `--no-sudoers` skips it,
5. installs + starts `couchside.service` (systemd, `Restart=always`),
6. opens the port in firewalld if firewalld is running (Bazzite),
7. prints your token and a `couchside://setup?...` QR code; scan it with
   your phone camera to pair the app.

Idempotent: safe to re-run for upgrades. An existing token and config.json
are always kept, so paired phones keep working.

Uninstall:

```sh
./install.sh --uninstall     # asks before deleting the token and sudoers rule
```

Upgrading from the pre-rename "Rescue Remote" agent: the installer migrates
your token from `/etc/rescue-agent/token` automatically and removes the old
`rescue-agent.service`, so existing phone pairings keep working.

## Configuration: /etc/couchside/config.json

Watched units and actions are yours to define. The daemon loads
`/etc/couchside/config.json` at startup (`--config` overrides the path);
if the file is missing or invalid it logs a warning and uses safe generic
defaults (units: `sddm.service`, `couchside.service`; actions:
`restart-session`, `reboot`, `poweroff`). Restart the service after editing:
`sudo systemctl restart couchside`.

```jsonc
{
  "port": 8787,                       // optional; default 8787
  "units": [                          // the watchlist shown in the app; ALSO
    {"name": "sddm.service",          // the journal-read allowlist
     "scope": "system"},              // "system" or "user" (systemctl --user)
    {"name": "couchside.service", "scope": "system"}
  ],
  "actions": {
    "restart-session": {
      "label": "Restart Session",     // optional; defaults to the id
      "description": "Restart the display session (sddm)",  // optional
      "danger": "high",               // required: "low" | "medium" | "high"
      "cmd": ["sudo", "systemctl", "restart", "sddm"],  // required argv list
      "user_env": false,              // optional: run with XDG_RUNTIME_DIR set
                                      // (needed for systemctl --user, flatpak)
      "detached": false               // optional: fire-and-forget (reboot etc.)
    }
  },
  "action_order": ["restart-session"], // optional listing order for the app
  "panel": {                            // optional RS-232 TV/panel control;
    "device": "/dev/ttyUSB0",           // omit to disable. See "TV control".
    "baud": 19200,                      // 9600|19200|38400|57600|115200
    "protocol": "newline"               // only "newline" today
  }
}
```

### Examples: adding your own units and actions

Watch a user-scope service and give it a restart button:

```json
{
  "units": [
    {"name": "sddm.service", "scope": "system"},
    {"name": "couchside.service", "scope": "system"},
    {"name": "sunshine.service", "scope": "user"}
  ],
  "actions": {
    "restart-sunshine": {
      "label": "Restart Sunshine",
      "description": "Restart the game-streaming host",
      "danger": "low",
      "cmd": ["systemctl", "--user", "restart", "sunshine.service"],
      "user_env": true
    },
    "reboot": {"label": "Reboot", "danger": "high",
               "cmd": ["sudo", "systemctl", "reboot"], "detached": true}
  }
}
```

Kill a flatpak app (`user_env: true` so flatpak can find the session bus):

```json
"stop-kodi": {
  "label": "Stop Kodi",
  "danger": "medium",
  "cmd": ["flatpak", "kill", "tv.kodi.Kodi"],
  "user_env": true
}
```

Notes:

- `cmd` is an argv list run with `shell=False`: no shell, no expansion.
- Anything needing root must go through `sudo` **and** have a matching
  `NOPASSWD` sudoers entry (the daemon has no TTY to type a password into).
  The installer's rule covers `systemctl restart sddm`, `reboot`, `poweroff`,
  `suspend`, and `journalctl`; add your own entries to `/etc/sudoers.d/couchside`
  (via `visudo`) for other privileged actions.
- Journal reads are allowed **only** for units in `units`; that list is the
  allowlist.

## API (v1, default port 8787)

All responses are JSON. Every route except `/api/ping` requires
`Authorization: Bearer <token>`; failures return `401 {"error":"unauthorized"}`.
All responses carry permissive CORS headers; `OPTIONS` returns 204.

| Route | Method | Description |
|---|---|---|
| `/api/ping` | GET | Unauthenticated reachability probe: `{"ok":true,"app":"couchside-agent","version":"<agent version>","host":"…","ip":"…"}` |
| `/api/status` | GET | hostname, time, uptime, load, CPU temp, memory, disk usage (`/`, `/var`), `net` (`iface`, `mac`, `wired`, `wol_armed`) for the app's Wake-on-LAN power path, and `caps` (added in 2.8.2): a boot-time summary `{"gamepad","steam","media","tv","screen","power_schedule"}` of booleans saying which optional features this box supports, so the app hides unsupported UI and skips the per-feature probes (`/api/tv`, `/api/media`, `/api/screen`, `/api/downloads`, `/api/power/schedule`) on connect. A hint, not authority — a live op still confirms. Older agents omit `caps` and the app falls back to probing each feature. Also carries `history` (added in 2.8.3): a recent-vitals ring `{t[],temp[],load[],mem_pct[]}` (parallel arrays, oldest first, ~30 samples, sampled on the poll itself ≥10s apart — no background thread) rendered as sparklines in the app; entries are null when a value was unreadable |
| `/api/units` | GET | State of the configured watchlist units |
| `/api/journal?unit=<name>&lines=<n>&scope=system\|user` | GET | Last n journal lines (default 100, clamped 1 to 500). Unit must be in the configured watchlist, else 400 |
| `/api/actions` | GET | Configured actions with id/label/description/danger |
| `/api/actions/<id>` | POST | Run an action; returns `{ok, exit_code, stdout, stderr, duration_ms}`. Unknown id → 404 |
| `/api/downloads` | GET | In-progress Steam downloads/updates: `{"downloads":[{"appid","name","state","bytes_total","bytes_downloaded","percent"}]}`. `state` ∈ `downloading paused queued validating finalizing updating`. Read-only, best-effort; empty list when nothing is pending or Steam is absent; never 500s on parse errors. Added in 2.8.0 — older agents 404 and the app hides the section. Bearer-gated |
| `/api/tv` | GET | TV/volume probe. `{"available":true,"backend":..,"adapter":..,"box_volume":bool,"tv_volume":bool,"tv_power":bool,"muted":bool\|null,"source_box":bool,"sources":[{"id","label"}],"screen_toggle":bool,"keys":bool,"box_volume_level":0-100\|null,"tv_volume_level":0-100\|null}`. `box_volume` is the box's own OS volume; `tv_volume`/`tv_power` mean a panel/CEC backend is present; `source_box`/`sources`/`screen_toggle`/`keys` and the `*_level` readings are panel-only (RS-232). 404 only when the box has neither. Bearer-gated |
| `/api/tv/<op>` | POST | One-shot command; returns `{ok, exit_code, stdout, stderr, duration_ms}` (+ `muted` for the mute op). `<op>` ∈ `power_on power_off volume_up volume_down mute` (plus panel-only `source_box`, `screen_toggle`). Power goes to the TV backend; volume goes to the box by default, or add `?target=tv` to send it to the panel/CEC. Unknown op → 404 |
| `/api/tv/volume` | POST | Absolute volume. Body `{"level":0-100,"target":"box"\|"tv"}`. Box converges via media-key steps (Game-Mode OSD); TV via the RS-232 closed loop. Returns the ActionResult plus the final `level` |
| `/api/tv/source/<id>` | POST | Switch the display's input source (panel only). `<id>` is one of the `sources` from `GET /api/tv`. Unknown id / no panel → 404 |
| `/api/tv/key/<k>` | POST | Send a factory-remote key (panel only). `<k>` ∈ `up down left right ok menu home back settings bright_up bright_down` |
| `/api/media` | GET | Now-playing across MPRIS players: `{"available":true,"players":[{id,identity,status,title,artist,album,position_ms,length_ms,rate,can_seek,can_go_next,can_go_previous,can_play,can_pause,art,art_key}]}`. Read over the user session bus via `busctl` (ships with systemd). 404 when there is no session bus / `busctl`; 200 with an empty list when idle. Playing players first, capped at 8. Added in 2.8.0 |
| `/api/media/<player>/<op>` | POST | Transport op; `<op>` ∈ `play pause play_pause next previous stop seek`. `seek` body `{"position_ms":int}` (absolute; `SetPosition` with a `Seek`-delta fallback). Unknown op / dead player → 404. ActionResult shape |
| `/api/media/art?player=<id>&k=<art_key>` | GET | Album-art bytes for the player's current track. Serves only a `file://` image the player advertised, under a realpath allowlist, image-sniffed, 2 MiB cap; `http(s)` art is never fetched. The client passes a player id + cache-key, never a path. `Cache-Control: private, max-age=3600`. 404 when no servable art |
| `/api/screen` | GET | Screen-capture probe: `{"available":true,"session":"gamescope"\|"desktop","backends":[...],"formats":["image/jpeg"]}`. 404 when no capture path (no gamescope socket / no `spectacle`, or no downscaler). Added in 2.8.0 |
| `/api/screen/frame` | GET | One freshly-captured frame, downscaled to a ~960px JPEG (`Cache-Control: no-store`). gamescope Game Mode via `gamescopectl screenshot` (async write, polled to completion); KDE Desktop via `spectacle`; downscaled with ImageMagick/ffmpeg. A single-flight lock + 500 ms server cache cap captures at ~2/s no matter how many clients poll; 503 on capture failure. The client passes no path; `?t=` is ignored server-side |
| `/api/power/schedule` | GET | Sleep timer + wake schedule: `{"sleep":{action,fire_at,remaining_s}\|null,"wake":{fire_at,remaining_s}\|null,"wake_available":bool,"limits":{...}}`. The sleep timer is in-process (a restart clears it); the wake alarm is read from `/dev/rtc0` each request. Added in 2.8.1 |
| `/api/power/sleep` | POST | Arm a delayed `{"delay_s":60..28800,"action":"suspend"\|"poweroff"}`. The action must be permitted (arm-time `sudo -n -l` probe) or 400. `DELETE` cancels (idempotent) |
| `/api/power/wake` | POST | Set an RTC wake alarm `{"at":epoch}`, clamped now+120s..now+86100s; read-back verified. 409 when `/dev/rtc0` isn't writable (needs the udev rule). `DELETE` clears (idempotent) |
| `/api/utilities` | GET | Setup › Utilities tenants (`openpuck`, `cec`, and — agent 2.9.105+, **only when a Steam root exists** — `decky` with `state` = the loader state below). A box without Steam never lists the row; the app probes `/api/decky/loader` for the rest |
| `/api/utilities/decky/run?op=install\|uninstall` | POST | Start a Decky Loader install/repair/update (`install` is one idempotent procedure) or uninstall (plugins + settings kept). `op` must be exactly one of the two literals → 400 otherwise; a **missing** `?op=` (an app older than 2.9.58) answers 200 `{ok:false, error:"Update the Couchside app to manage Decky Loader"}` rather than a dead 400. 403 `needs_optin` without the `/etc/couchside/allow-decky` marker; 409 `{busy, what:"loader_op"\|"plugin_job"}`; 200 `ok:false` with `needs_installer` (wrapper/unit template absent — re-run install.sh), `helper_outdated` (helper < 1.1.0; final, sudo is NOT tried), `helper_unreachable` + `retry` (helper socket present but silent), or `did_not_start` + `detail`. Success: ActionResult + `{started:true, via:"helper"\|"sudo", log:"/run/couchside/decky-loader.log"}` — then poll `/api/decky/loader` for `op`. The work runs as root under a pinned oneshot unit (`couchside-decky-loader@<op>.service`), never in the agent's process |
| `/api/decky/loader` | GET | Decky Loader state, memoised ≤500 ms. `state` ∈ `not_installed installing uninstalling installed_stopped running_untrusted running_unreachable running_no_steam installed_cef_flag_missing installed_steam_needs_restart running` plus `installed, active, api_reachable, loader_is_root, steam_running, steam_ui_up, cef_flag_present, version, channel:0\|1\|2\|null, allowed, installer_ready, elevated, helper:"present"\|"outdated"\|"absent"\|"unreachable", installed_by:"install.sh"\|"plugin"\|"unknown", panel:"installed"\|"missing", stopped_reason:"self_stop_recent"\|null, loader_update:{current,remote,updatable,checked_at,channel}\|null, op:{state:"starting"\|"running"\|"done"\|"failed"\|"refused"\|"interrupted"\|"did_not_start", mode, ok, tag, at, detail}\|null, restart_action:"restart-decky"\|null, unit_pinned:bool\|null`. `op` is correlated to THIS agent's last request (a previous run's `done` is never shown as this one's). **404 when the box has no Steam root** — that is how an app probes for the whole feature. Added in 2.9.105 |
| `/api/decky/loader/log?n=` | GET | `{lines}` — the last `n` (int, clamped 1..400, default 100; non-integer → 400) lines of the wrapper transcript at the constant path `/run/couchside/decky-loader.log` |
| `/api/decky/loader/check` | POST | One `updater/get_version_info` over the loader's loopback WebSocket (≤3 s hold, cached 6 h): `{ok, loader_update:{current,remote,updatable,checked_at,channel}, cached}`. Read-only; the loader's own updater is never invoked (Repair = `?op=install`). 403 without the marker · 409 busy · 503 `loader_down` |
| `/api/decky/plugins` | GET | Filesystem listing of `~/homebrew/plugins` (never a WebSocket poll — Decky holds ONE socket and a connect displaces Steam's frontend): `{available, source:"fs", flags_available, running_probe:"proc"\|"unknown", plugins:[{name, folder, version, author, root, disabled, hidden, frozen, running:bool\|null, protected, update:{version,hash}\|null}], updates:n\|null, store_checked_at, unreadable:n, job}`. `name` is `plugin.json`'s name, never the folder; `disabled/hidden/frozen` come from `settings/loader.json` and are `null` (with `flags_available:false`, `update:null`) when that file is mid-rewrite; `running` is `null` until a verbatim `/proc` fixture ships; `update` uses strict semver against the cached store (`null` when the cache is cold). `available:false` (200) when the loader is not installed. `Couchside` is `protected` |
| `/api/decky/store` | GET | The box's cached copy of `https://plugins.deckbrew.xyz/plugins` (fetched in a background thread, never inside a GET; 900 s TTL; 4 MiB cap; **no redirects followed**; every field type-checked and capped, bad entries dropped): `{available, fetching, count, fetched_at, stale, error, plugins:[{id, name, author, description, tags, downloads, updated, has_icon, installed_version, update_available, install_type:"install"\|"update"\|"reinstall"\|"downgrade"\|null, versions:[{name,hash,created}]}]}`. Cold cache → `{available:false, fetching:true}` and a fetch starts — only if the marker is present. Search/sort happen on the phone |
| `/api/decky/store/refresh` | POST | Refetch the store list (≥60 s apart): `{refreshed, fetching, fetched_at}`. 403 without the marker |
| `/api/decky/store/icon/<id>` | GET | Plugin icon bytes, `Cache-Control: public, max-age=86400`. Auth like `/api/steam/<appid>/cover` (bearer header, `?token=`, or `?ticket=`). `<id>` must match `[0-9]{1,9}` (400) and be a key of the cached store list (404); the icon is fetched from the entry's `image_url` only when its host is exactly `cdn.tzatzikiweeb.moe` over https, with no redirects, ≤1 MiB, image-sniffed (jpeg/png/webp/gif/avif), cached at `~/.cache/couchside/decky-icons/<id>`. Served from cache without the marker; fetched only with it (uncached → 404) |
| `/api/decky/plugins/install` | POST | `{id:int}` (int-not-bool, `0 < id < 10^9`, looked up in the cached store) → `{ok:true, job}`. The agent builds the artifact URL from `versions[0].hash` (must be 64-hex → else 422 `no verifiable hash`), tells Decky Loader over its loopback WebSocket to download, sha256-check, extract and start it, confirms Decky's own prompt, then reads completion back from disk + one `loader/get_plugins`. 400 · 403 · 404 · 409 `{busy,what}` / `{error:"protected"}` / `{error:"loader_stopped", restart_action, repair, stopped_reason}` (never a silent loader restart) · 503 `{error:"loader_down", repair}` / `{error:"store_unavailable"}` |
| `/api/decky/plugins/uninstall` · `/reload` | POST | `{name}` (str, 1–64 printable; must be a name the fs listing enumerates → 404; `Couchside` and NFKC look-alikes → 409 protected) → `{ok:true, job}`. Jobs, like install, so the app's 4 s request timeout never turns a completed op into a reported failure. Reload restarts ONE plugin backend (`loader/reload_plugin`). Same 403/409/503 refusals as install |
| `/api/decky/jobs` | GET | `{job:{kind:"install"\|"update"\|"uninstall"\|"reload", name, version, store_id, phase, started_at, done, ok, outcome:"done"\|"failed"\|"unknown"\|"interrupted", error, retry, reinstall_id, verified, steam_ui_up, restarted_loader:false, log:[…]}\|null}` — read from the disk record (`~/.cache/couchside/decky-job.json`), so an agent restart mid-job resumes the read-back (< 180 s) or reports `interrupted`, never `null`. `retry:true` marks a soft failure (Decky's prompt timed out — it may be asking on the TV — or the loader could not be reached before anything was sent); `reinstall_id` is set when a failed update left no copy behind |

**Decky manager gating rule:** every `/api/decky/*` route is bearer-gated and 404s
when the box has no Steam root. Routes that open the loader's WebSocket or leave
the LAN on demand (`/utilities/decky/run`, `/loader/check`, `/store/refresh`,
`/plugins/install|uninstall|reload`) additionally require the owner's one-time
`couchside allow-decky on` on the box (403 `needs_optin` otherwise, nothing
spawned, no socket opened); pure filesystem/cache reads are token-only. The
agent never touches plugin bytes, never runs root work in its own process, and
never restarts the loader on its own — a stopped loader is a state the app
shows, with the existing `restart-decky` action offered.

**Media players:** any MPRIS-speaking app works (Spotify, Firefox/Chromium, VLC, mpv, …). **Kodi** needs its MPRIS add-on enabled to appear here.

## Virtual gamepad, mouse & keyboard (WS protocol v2)

The agent exposes a virtual Xbox 360 controller over a WebSocket on the same
port:

```
ws://<host>:8787/ws/gamepad?token=<token>
```

Auth is the `token` query parameter, checked with `hmac.compare_digest`
**before** the handshake response: a bad/missing token gets a plain HTTP
`401` and the socket is closed (no WebSocket handshake). On success the agent
completes the RFC6455 handshake, creates the uinput device, and sends
`{"t":"hello","dev":"Microsoft X-Box 360 pad","text":"unicode"|"ascii"}`
(`dev:"mock"` in `--mock`). The `text` field advertises how much of a typed
string the agent can deliver (see **Text input** below); older agents omit it
and the app defaults by device name.

**One-connection rule:** only one gamepad connection is active at a time. A
new valid connection *replaces* the old one: the old uinput device is
destroyed first, then the old socket is closed.

Client to server messages (one JSON object per masked text frame; no
fragmentation). The gamepad, virtual mouse, and virtual keyboard uinput devices
are each created lazily on first use — the Trackpad and Remote input modes drive
the mouse/keyboard messages (v2):

| Message | Meaning |
|---|---|
| `{"t":"b","k":K,"v":0\|1}` | Button; `K` ∈ `a b x y lb rb l3 r3 start select guide dl dr du dd` |
| `{"t":"t","k":"lt"\|"rt","v":0..255}` | Analog trigger |
| `{"t":"s","k":"l"\|"r","x":F,"y":F}` | Stick, floats −1..1; +x right, **+y down** (screen coords, maps directly to Xbox ABS) |
| `{"t":"m","dx":I,"dy":I}` | Relative mouse move (virtual mouse) |
| `{"t":"mb","k":"l"\|"r"\|"m","v":0\|1}` | Mouse button down/up |
| `{"t":"mw","dy":I}` | Mouse wheel |
| `{"t":"kt","text":"…"}` | Type text (virtual keyboard) — see **Text input** |
| `{"t":"k","key":K}` | One special key; `K` ∈ `backspace enter tab esc space up down left right home end` |
| `{"t":"ping"}` | Keepalive → `{"t":"pong"}` |

Server to client: `hello` (after device ready), `pong`, and
`{"t":"err","msg":"..."}` followed by close on any error (bad message,
uinput failure). WS ping (opcode 0x9) is answered with pong (0xA). Idle
sockets time out after ~60 s.

### Text input

A `{"t":"kt"}` frame never closes the session: characters the ASCII keymap can
type go through the uinput keyboard; any run of genuinely non-ASCII text
(emoji, CJK, accents) is delivered by setting the wayland clipboard
(`wl-copy`, text on stdin) and sending Ctrl+V. Before pressing Ctrl+V the agent
reads the clipboard back with `wl-paste` and only proceeds if it matches — so a
failed or wrong-session copy can never paste a stale clipboard. The clipboard is
cleared a few seconds later.

The `hello` frame's `text` capability is `unicode` only when a **safe** paste
path exists: `wl-copy` **and** `wl-paste` are installed **and** exactly one
wayland session socket is present (two sessions make the target ambiguous). Else
it is `ascii`, and the app strips non-typeable characters client-side. Stock
SteamOS has no `wl-clipboard` (→ `ascii`); it is common on Bazzite (→ `unicode`).
The app always normalizes autocorrect artifacts (smart quotes, em dash,
ellipsis, NBSP) to ASCII regardless, so the common paste-from-notes case types
reliably on every agent version.

### uinput notes

- Pure stdlib (`fcntl.ioctl` + `struct`), legacy uinput API: write
  `struct uinput_user_dev` (1116 bytes) then `UI_DEV_CREATE`.
- Device identity: name `Microsoft X-Box 360 pad`, bustype `0x03`,
  vendor `0x045e`, product `0x028e`, version `0x110`; games see a real
  wired 360 pad.
- Mapping: face/shoulder/thumb/menu buttons → `BTN_SOUTH/EAST/WEST/NORTH`,
  `BTN_TL/TR`, `BTN_THUMBL/R`, `BTN_SELECT/START/MODE`; dpad →
  `ABS_HAT0X/Y` (−1/0/+1); sticks → `ABS_X/Y` and `ABS_RX/RY`
  (−32768..32767); triggers → `ABS_Z`/`ABS_RZ` (0..255). Every batch is
  followed by `EV_SYN`/`SYN_REPORT`.
- `/dev/uinput` must be writable by the daemon user. On SteamOS and Bazzite
  the udev `uaccess` tag grants this to the user with an **active seat
  session**, i.e. someone is logged in on the box (Game Mode counts). If no
  seat session is active, or your distro lacks the uaccess rule, the gamepad
  reports `uinput unavailable`; a udev rule or an input-group membership can
  grant access permanently.
- On non-Linux (or if `/dev/uinput` can't be opened) the agent still
  completes the handshake but replies with an `err` frame and closes.
- In `--mock` mode no uinput device is created; every decoded event is
  logged to stdout and `hello` reports `dev:"mock"`.

## TV control (probe-and-appear)

Two concerns, kept separate. Power (and, if you opt in, volume) can drive an
external TV/panel; volume by default drives the box's own OS output. Backends
are probed once at startup, and `GET /api/tv` reports what is available.

| Backend | Drives | How | Detected when |
|---|---|---|---|
| `panel` | TV power + volume | RS-232 serial command frames | `config.json` names a serial `device` that exists (see below) |
| `cec` | TV power + volume | HDMI-CEC via `cec-ctl` (v4l-utils) or `cec-client` (libcec) | a CEC tool is on `PATH` **and** a **connected** `/dev/cec*` port or a libcec adapter is found |
| `soft` | box volume + mute | the OS volume media keys via `/dev/uinput`, so the SteamOS volume OSD shows | `/dev/uinput` is writable |

The unified op set is `power_on power_off volume_up volume_down mute`. Power
always goes to the panel/CEC backend. Volume goes to the box (`soft`) by
default; `POST /api/tv/volume_*?target=tv` sends it to the panel/CEC instead.
The `soft` media-key device is created at startup so the compositor has it
enumerated before the first press. Mute is a special case: gamescope binds no
mute key and shows no mute OSD, so mute instead drives the volume to 0 with the
volume-down key (the on-screen bar empties to the muted-speaker icon, the panel
gets a real indicator) and restores the saved level on unmute. `GET /api/tv`
returns `box_volume`,
`tv_volume`, `tv_power`, and the current `muted` state; it 404s only when the
box has neither box volume nor a TV backend. The startup banner logs
`tv: <backend> (<adapter>)`.

### panel backend: RS-232 serial (preferred)

Config-driven so the agent never blasts command frames at an unrelated tty.
Add a `panel` block to `config.json`:

```json
"panel": { "device": "/dev/ttyUSB0", "baud": 19200, "protocol": "newline" }
```

- `device`: the serial port (must live under `/dev/`); typically a
  USB-to-RS-232 adapter (`/dev/ttyUSB0`). Active only when the path exists.
- `baud`: one of `9600 19200 38400 57600 115200` (default `19200`).
- `protocol`: only `"newline"` today (Newline TruTouch / TT-series).

The line is opened raw at `<baud>` 8N1 (pure-stdlib `termios`), the command
frame is written, and a short reply is read back (echoed in `stdout`). Frame =
`7F 08 99 A2 B3 C4 02 FF 01 XX CF`; the panel echoes
`7F 09 99 A2 B3 C4 02 FF 01 XX 01 CF` on success. Key codes `XX`:

| Op | `XX` | Frame |
|---|---|---|
| `power_on` | `00` | `7F 08 99 A2 B3 C4 02 FF 01 00 CF` |
| `power_off` | `01` | `7F 08 99 A2 B3 C4 02 FF 01 01 CF` |
| `mute` | `02` | `7F 08 99 A2 B3 C4 02 FF 01 02 CF` |
| `volume_down` | `17` | `7F 08 99 A2 B3 C4 02 FF 01 17 CF` |
| `volume_up` | `18` | `7F 08 99 A2 B3 C4 02 FF 01 18 CF` |

Unlike CEC, power-on/off are **discrete** codes and the panel MCU listens even
in standby, so **power-on-from-off works**. Codes are from Newline's RS-series
manual; verify against your panel with the harmless firmware-query frame
(`…01 3D CF`) before trusting power.

### cec backend: HDMI-CEC (fallback)

Each op shells **one** command through an arg-list subprocess (`shell=False`,
10 s timeout); libcec commands are fed on **stdin** (never `echo | cec-client`).
All target the TV (logical address `0`); `power_off` maps to CEC **standby**:

| Op | `cec-ctl` | `cec-client` (stdin) |
|---|---|---|
| `power_on` | `--to 0 --image-view-on` | `on 0` |
| `power_off` | `--to 0 --standby` | `standby 0` |
| `volume_up` | `--to 0 --user-control-pressed ui-cmd=volume-up --user-control-released` | `volup` |
| `volume_down` | `--to 0 --user-control-pressed ui-cmd=volume-down --user-control-released` | `voldown` |
| `mute` | `--to 0 --user-control-pressed ui-cmd=mute --user-control-released` | `mute` |

Volume/mute use CEC **User Control** (UI) commands; a TV with
system-audio-control on forwards them to an ARC audio system.

CEC availability is **re-evaluated per request** (cheap sysfs reads), not frozen
at startup, so a display powered on after the agent started becomes controllable
without a restart. A `/dev/cec*` node is used only while its DRM HDMI connector
is not `disconnected`; a CEC adapter bound to a dark port (box HDMI unplugged,
display on DisplayPort) is ignored, so the strip never appears over a dead bus.
Note a TV in deep-off that drops HPD reads `disconnected` and is hidden until
woken once by other means (only the expensive libcec adapter probe is cached
from startup). The RS-232 `panel` backend has none of these caveats and is
preferred when configured.

### mock

In `--mock` the **panel** backend is faked (`available:true`, backend
`panel`): every op logs `[panel] <op> -> <frame>` and returns synthetic
success, so the app's TV strip can be built without any hardware.

## Security model

- **Token**: a random 48-hex-char secret in `/etc/couchside/token`
  (`chmod 600`, owned by the agent user). Compared with
  `hmac.compare_digest` (constant-time). Every route except `/api/ping`
  requires it.
- **Scoped sudoers**: the daemon runs as your desktop user with no TTY, so
  privileged actions need `NOPASSWD` rules. The installer grants a fixed set
  of **exact-argument** commands (`systemctl reboot|poweroff|suspend`,
  `systemctl restart plugin_loader`, `systemctl restart --no-block
  couchside.service`, the root-owned journal wrapper — never `journalctl`
  itself — plus display-manager grants only for the DETECTED manager) and
  nothing else, validated with `visudo -cf` before install; the top-level
  README's **Security model** is the authoritative list and
  `tests/test_readme_sudo_grants.py` compiles it against install.sh. Skip with
  `--no-sudoers` (those actions and system-journal reads will then fail).
- **Allowlists, not shells**: journal reads are limited to the configured
  unit list; actions are a fixed config table run with argument lists
  (`shell=False`), so no arbitrary commands. No route takes a client-supplied
  file path. The agent serves image bytes on exactly four routes: the album-art
  image a running media player advertises (validated against a small realpath
  allowlist — `/tmp`, `$XDG_RUNTIME_DIR`, `~/.cache`, `~/.var`, `~/.mozilla` —
  image-sniffed, 2 MiB cap; client passes a player id), an on-demand screen
  frame captured to a tmpfs file that is deleted immediately after
  (rate-clamped to ~2/s, 12 MiB cap; client passes no path), Steam cover art
  from the box's own library cache (client passes an app id), and the Decky
  store icon proxy (client passes a store id that must be a key of the box's
  own cached store list; the box fetches from `cdn.tzatzikiweeb.moe` only,
  https only, no redirects, ≤1 MiB, image-sniffed, cached by the integer id —
  never by anything the client sent). The `lines`/`n` parameters are clamped;
  errors return brief JSON, never tracebacks.
- **Decky Loader management is a separate opt-in** (`couchside allow-decky on`,
  agent 2.9.105+): it grants two exact `systemctl start` argvs for pinned
  oneshot units and a marker file; the root wrapper they run has no grant of
  its own. The full story — including that Decky Loader runs as root from your
  home and that Decky publishes no checksum for it — is in the top-level
  README's **Security model**.
- **LAN-only, plain HTTP** (TLS is on the roadmap; see below). Today the
  transport is unencrypted: the bearer token rides HTTP headers and
  `ws://…?token=` in the clear, so anyone who can *sniff your local network*
  (a promiscuous device, a compromised switch/AP) can read it and control the
  box. That is an accepted trade-off **on a home LAN you trust** — the token is
  the gate and there is no cloud tier to attack.

  > ⚠️ **Do not port-forward Couchside to the internet.** Couchside is built for
  > a trusted home LAN. Exposing port 8787 (or any Couchside port) publicly is
  > unsafe: a single bearer token is the only gate, there is no account to lock
  > and no cloud tier to revoke, and anyone who can reach the port can attempt to
  > pair. For remote access, use a VPN or Tailscale/WireGuard back to your home
  > network — **never** a router port-forward.

  **Coming: opt-in TLS.** A dark, additive HTTPS listener (self-signed cert,
  trusted-on-first-use by a fingerprint you confirm off the box's own screen at
  pairing — the SSH model) is in progress so the token stops crossing the LAN in
  the clear. It will not change the port-forward guidance above: TLS protects the
  wire, it does not make public exposure safe. See
  `docs/memory/project_tls-encryption.md`.

## SteamOS vs Bazzite notes

| | SteamOS (Steam Deck) | Bazzite |
|---|---|---|
| User | `deck` | whatever you created (e.g. `bazzite`) |
| Firewall | none enabled by default, nothing to open | firewalld, installer opens 8787/tcp |
| python3 | preinstalled | preinstalled |
| `/dev/uinput` | `uaccess` grants the active-seat user; Game Mode session counts | same |
| sudo password | must be set once (`passwd` in Desktop Mode) before the installer's sudo steps work | set during install |

Both are immutable-rootfs distros. The agent deliberately touches only
`~/.local/opt`, `/etc`, and `/etc/systemd/system`, which are writable on both.

## Development

Mock mode (fake data, no real commands, for phone-app development on macOS):

```sh
python3 agent/couchsided.py --mock --host 127.0.0.1 --port 8787 --token devtoken
# optionally: --config /path/to/config.json to mock your own unit list
```

Serves believable fake data (wandering CPU temp, counting uptime, plausible
journal lines) and never executes real commands. Actions sleep 0.3 s and
return `ok:true`.

`--mock-decky <state>` (2.9.105+) picks the Decky Loader state the mock starts
in — one of `running not_installed installing uninstalling stopped needs_optin
needs_installer helper_outdated steam_needs_restart installed_steam_needs_restart
cef_flag_missing no_steam interrupted untrusted unreachable` (argparse rejects
anything else). Mock loader ops mutate it, so one run walks
`not_installed → installing → installed_steam_needs_restart → running →
uninstalling → not_installed`; mock plugin jobs advance over ~3 s and mutate a
four-plugin list; the store is an 8-entry fixture with one PNG and one AVIF icon.
`scripts/web-dev.sh <port> [agent args…]` forwards everything after the port to
the agent, and `.claude/launch.json` has `couchside-web-harness-decky` (port
8199, `--mock-decky not_installed`).

Deploy a working checkout to a test box (dev only; end users use the curl
one-liner):

```sh
./agent/deploy.sh deck@steamdeck.local
```

Re-print the pairing QR any time (reads the token over ssh):

```sh
./agent/show-qr.sh deck@steamdeck.local
```
