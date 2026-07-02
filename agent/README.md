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
| `/api/ping` | GET | Unauthenticated reachability probe: `{"ok":true,"app":"rescue-agent","version":"1.0.0"}` |
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
