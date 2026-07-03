# Couchside — box agent

The box-side half of Couchside: a tiny pure-stdlib python3 daemon for your
couch gaming box (Steam Deck / SteamOS, Bazzite, or any systemd Linux HTPC)
that lets the phone app check health, watch service logs, fire recovery
actions ("restart the session", "reboot"), and act as a virtual Xbox 360
gamepad — so you can un-wedge the box from the couch without a keyboard.

No pip dependencies — it runs on immutable distros (SteamOS read-only rootfs,
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
4. installs a **narrow sudoers rule** (see Security below) — it prints the
   exact contents first, and `--no-sudoers` skips it,
5. installs + starts `couchside.service` (systemd, `Restart=always`),
6. opens the port in firewalld if firewalld is running (Bazzite),
7. prints your token and a `couchside://setup?...` QR code — scan it with
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

## Configuration — /etc/couchside/config.json

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
  "action_order": ["restart-session"] // optional listing order for the app
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

- `cmd` is an argv list run with `shell=False` — no shell, no expansion.
- Anything needing root must go through `sudo` **and** have a matching
  `NOPASSWD` sudoers entry (the daemon has no TTY to type a password into).
  The installer's rule covers `systemctl restart sddm`, `reboot`, `poweroff`,
  and `journalctl`; add your own entries to `/etc/sudoers.d/couchside` (via
  `visudo`) for other privileged actions.
- Journal reads are allowed **only** for units in `units` — that list is the
  allowlist.

## API (v1, default port 8787)

All responses are JSON. Every route except `/api/ping` requires
`Authorization: Bearer <token>`; failures return `401 {"error":"unauthorized"}`.
All responses carry permissive CORS headers; `OPTIONS` returns 204.

| Route | Method | Description |
|---|---|---|
| `/api/ping` | GET | Unauthenticated reachability probe: `{"ok":true,"app":"couchside-agent","version":"2.0.0"}` |
| `/api/status` | GET | hostname, time, uptime, load, CPU temp, memory, disk usage (`/`, `/var`) |
| `/api/units` | GET | State of the configured watchlist units |
| `/api/journal?unit=<name>&lines=<n>&scope=system\|user` | GET | Last n journal lines (default 100, clamped 1–500). Unit must be in the configured watchlist, else 400 |
| `/api/actions` | GET | Configured actions with id/label/description/danger |
| `/api/actions/<id>` | POST | Run an action; returns `{ok, exit_code, stdout, stderr, duration_ms}`. Unknown id → 404 |

## Virtual gamepad (WS protocol v1)

The agent exposes a virtual Xbox 360 controller over a WebSocket on the same
port:

```
ws://<host>:8787/ws/gamepad?token=<token>
```

Auth is the `token` query parameter, checked with `hmac.compare_digest`
**before** the handshake response — a bad/missing token gets a plain HTTP
`401` and the socket is closed (no WebSocket handshake). On success the agent
completes the RFC6455 handshake, creates the uinput device, and sends
`{"t":"hello","dev":"Microsoft X-Box 360 pad"}` (`dev:"mock"` in `--mock`).

**One-connection rule:** only one gamepad connection is active at a time. A
new valid connection *replaces* the old one — the old uinput device is
destroyed first, then the old socket is closed.

Client → server messages (one JSON object per masked text frame; no
fragmentation):

| Message | Meaning |
|---|---|
| `{"t":"b","k":K,"v":0\|1}` | Button; `K` ∈ `a b x y lb rb l3 r3 start select guide dl dr du dd` |
| `{"t":"t","k":"lt"\|"rt","v":0..255}` | Analog trigger |
| `{"t":"s","k":"l"\|"r","x":F,"y":F}` | Stick, floats −1..1; +x right, **+y down** (screen coords, maps directly to Xbox ABS) |
| `{"t":"ping"}` | Keepalive → `{"t":"pong"}` |

Server → client: `hello` (after device ready), `pong`, and
`{"t":"err","msg":"..."}` followed by close on any error (bad message,
uinput failure). WS ping (opcode 0x9) is answered with pong (0xA). Idle
sockets time out after ~60 s.

### uinput notes

- Pure stdlib (`fcntl.ioctl` + `struct`), legacy uinput API: write
  `struct uinput_user_dev` (1116 bytes) then `UI_DEV_CREATE`.
- Device identity: name `Microsoft X-Box 360 pad`, bustype `0x03`,
  vendor `0x045e`, product `0x028e`, version `0x110` — games see a real
  wired 360 pad.
- Mapping: face/shoulder/thumb/menu buttons → `BTN_SOUTH/EAST/WEST/NORTH`,
  `BTN_TL/TR`, `BTN_THUMBL/R`, `BTN_SELECT/START/MODE`; dpad →
  `ABS_HAT0X/Y` (−1/0/+1); sticks → `ABS_X/Y` and `ABS_RX/RY`
  (−32768..32767); triggers → `ABS_Z`/`ABS_RZ` (0..255). Every batch is
  followed by `EV_SYN`/`SYN_REPORT`.
- `/dev/uinput` must be writable by the daemon user. On SteamOS and Bazzite
  the udev `uaccess` tag grants this to the user with an **active seat
  session** — i.e. someone is logged in on the box (Game Mode counts). If no
  seat session is active, or your distro lacks the uaccess rule, the gamepad
  reports `uinput unavailable`; a udev rule or an input-group membership can
  grant access permanently.
- On non-Linux (or if `/dev/uinput` can't be opened) the agent still
  completes the handshake but replies with an `err` frame and closes.
- In `--mock` mode no uinput device is created; every decoded event is
  logged to stdout and `hello` reports `dev:"mock"`.

## Security model

- **Token**: a random 48-hex-char secret in `/etc/couchside/token`
  (`chmod 600`, owned by the agent user). Compared with
  `hmac.compare_digest` (constant-time). Every route except `/api/ping`
  requires it.
- **Scoped sudoers**: the daemon runs as your desktop user with no TTY, so
  privileged actions need `NOPASSWD` rules. The installer grants exactly
  four commands — `systemctl restart sddm`, `systemctl reboot`,
  `systemctl poweroff`, `journalctl *` — nothing else, validated with
  `visudo -cf` before install. Skip with `--no-sudoers` (those actions and
  system-journal reads will then fail).
- **Allowlists, not shells**: journal reads are limited to the configured
  unit list; actions are a fixed config table run with argument lists
  (`shell=False`) — no arbitrary commands, no file-serving routes. The
  `lines` parameter is clamped; errors return brief JSON, never tracebacks.
- **LAN-only, plain HTTP**: there is no TLS. Keep port 8787 on your local
  network — do **not** port-forward it. Anyone with the token on your LAN
  controls the box.

## SteamOS vs Bazzite notes

| | SteamOS (Steam Deck) | Bazzite |
|---|---|---|
| User | `deck` | whatever you created (e.g. `bazzite`) |
| Firewall | none enabled by default — nothing to open | firewalld — installer opens 8787/tcp |
| python3 | preinstalled | preinstalled |
| `/dev/uinput` | `uaccess` grants the active-seat user; Game Mode session counts | same |
| sudo password | must be set once (`passwd` in Desktop Mode) before the installer's sudo steps work | set during install |

Both are immutable-rootfs distros; the agent deliberately touches only
`~/.local/opt`, `/etc`, and `/etc/systemd/system`, which are writable on both.

## Development

Mock mode (fake data, no real commands — for phone-app development on macOS):

```sh
python3 agent/couchsided.py --mock --host 127.0.0.1 --port 8787 --token devtoken
# optionally: --config /path/to/config.json to mock your own unit list
```

Serves believable fake data (wandering CPU temp, counting uptime, plausible
journal lines) and never executes real commands. Actions sleep 0.3 s and
return `ok:true`.

Deploy a working checkout to a test box (dev only; end users use the curl
one-liner):

```sh
./agent/deploy.sh deck@steamdeck.local
```

Re-print the pairing QR any time (reads the token over ssh):

```sh
./agent/show-qr.sh deck@steamdeck.local
```
