# Rescue Remote — box agent

Box-side half of Rescue Remote: a tiny pure-stdlib python3 HTTP daemon that runs
on the Bazzite HTPC (`bazzite.local` / `10.1.1.60`) and lets the phone app check
health, read unit logs, and fire a small fixed set of recovery actions.
No pip dependencies — Bazzite is immutable (Fedora Atomic/ostree).

## API (v1, port 8787)

All responses are JSON. Every route except `/api/ping` requires
`Authorization: Bearer <token>`; failures return `401 {"error":"unauthorized"}`.
All responses carry permissive CORS headers; `OPTIONS` returns 204.

| Route | Method | Description |
|---|---|---|
| `/api/ping` | GET | Unauthenticated reachability probe: `{"ok":true,"app":"rescue-agent","version":"1.1.0"}` |
| `/api/status` | GET | hostname, time, uptime, load, CPU temp, memory, disk usage (`/`, `/var`) |
| `/api/units` | GET | State of the watchlist units (system: sddm, htpc-nosleep, greenboot-healthcheck, rescue-agent; user: skyscrape) |
| `/api/journal?unit=<name>&lines=<n>&scope=system\|user` | GET | Last n journal lines (default 100, clamped 1–500). Unit must be on the watchlist, else 400 |
| `/api/actions` | GET | List of available actions with id/label/description/danger |
| `/api/actions/<id>` | POST | Run an action; returns `{ok, exit_code, stdout, stderr, duration_ms}`. Unknown id → 404 |

### Actions

| id | danger | command |
|---|---|---|
| `restart-sddm` | high | `sudo systemctl restart sddm` (fixes wedged gamescope / black screen) |
| `restart-kodi` | medium | `flatpak kill tv.kodi.Kodi` (relaunch from the Steam tile) |
| `restart-skyscrape` | low | `systemctl --user restart skyscrape.service` |
| `reboot` | high | `sudo systemctl reboot` (fire-and-forget) |
| `poweroff` | high | `sudo systemctl poweroff` (fire-and-forget) |

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
- `/dev/uinput` must be writable by the daemon user — on Bazzite the udev
  `uaccess` tag grants this to the logged-in user; no sudo needed.
- On non-Linux (or if `/dev/uinput` can't be opened) the agent still
  completes the handshake but replies with an `err` frame and closes.
- In `--mock` mode no uinput device is created; every decoded event is
  logged to stdout and `hello` reports `dev:"mock"`.

## Deploy (from the Mac)

```sh
./deploy.sh                # deploys to bazzite.local
./deploy.sh 10.1.1.60      # or by IP
```

The script copies the agent and unit file over SSH, generates a token at
`/etc/rescue-agent/token` if one doesn't exist, installs a sudoers rule,
installs and starts `rescue-agent.service`, opens `8787/tcp` in firewalld,
pings the agent, and prints the token to paste into the app.
Idempotent — safe to re-run. The install step runs over `ssh -t`, so sudo on
the box may prompt for the `bazzite` password during deploy.

The daemon runs as `User=bazzite` with no TTY, so the deploy installs
`/etc/sudoers.d/rescue-agent` (validated with `visudo -cf`) granting `bazzite`
passwordless sudo for exactly: `systemctl restart sddm`, `systemctl reboot`,
`systemctl poweroff`, and `journalctl` (system-scope journal reads). Without
this rule, sudo fails with "a terminal is required" and those actions break.

## Pairing via QR

`deploy.sh` ends by printing a terminal QR code of the app deep link
(`rescueremote://setup?host=<host>&port=8787&token=<token>`). Scan it with the
iPhone camera: the Rescue Remote app opens on the Setup tab with host, port,
and token prefilled and runs the connection test automatically — then tap
SAVE. Nothing is saved until you tap SAVE.

To show the QR again any time (reads the token over ssh):

```sh
./show-qr.sh                # bazzite@bazzite.local
./show-qr.sh 10.1.1.60      # or by IP / user@host
```

Rendering uses `npx --yes qrcode` (its default renderer draws in the
terminal); if `npx` is missing or fails, the scripts fall back to printing
the raw URL.

## Mock mode (develop the app on macOS)

```sh
python3 rescue_agentd.py --mock --host 127.0.0.1 --port 8787 --token devtoken
```

Serves believable fake data (wandering CPU temp, counting uptime, all units
green except `skyscrape.service`, plausible journal lines) and never executes
real commands. Actions sleep 0.3 s and return `ok:true`.

## Security notes

- Token comparison uses `hmac.compare_digest` (constant-time).
- Journal access is limited to the fixed watchlist allowlist; actions are a
  fixed table — no arbitrary commands or units.
- All subprocesses use argument lists (`shell=False`); the `lines` parameter is
  clamped; there are no file-serving routes.
- Errors return brief JSON messages, never tracebacks.
- The token file is `chmod 600`. The API is plain HTTP — keep it LAN-only
  (firewalld only opens 8787 to the local network; do not port-forward it).
