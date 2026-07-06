# Couchside: Windows box agent

The Windows port of the Couchside box agent: the same agent API contract v1
as the Linux daemon ([`agent/couchsided.py`](../couchsided.py)), so the phone
app pairs with and controls a Windows HTPC exactly like a SteamOS/Bazzite
box — health, service watchlist, event-log tails, recovery actions, Steam
game launching, TV/volume control, and the virtual gamepad/mouse/keyboard.

Pure Python stdlib (`ctypes` for Win32); no pip dependencies. Runs as
`couchsided-win.py` (Python 3.9+) or as a self-contained
`couchside-agent.exe` built with `build.ps1`.

## Install (one line)

Open **PowerShell** on the box and run — it self-elevates via UAC:

```powershell
irm https://couchside.tv/install.ps1 | iex
```

That single command installs Python (via winget) if needed, downloads the
agent, installs the ViGEmBus virtual-gamepad driver, sets up the token +
firewall + at-logon task, and opens the pairing page. When it finishes,
scan the QR with the Couchside app (phone on the same Wi-Fi/LAN).

The installer:

1. installs **Python 3** via winget if not already present (skipped when a
   real Python 3 is found; the Microsoft Store stub is rejected),
2. downloads the agent to `%LOCALAPPDATA%\Couchside\agent\` (or copies it
   from a local checkout when run from `agent\win\`),
3. installs the **ViGEmBus** driver + client DLL for the virtual gamepad
   (skip with `-NoGamepad`),
4. creates `%ProgramData%\Couchside\token` (pairing secret, ACL-restricted)
   and an initial `config.json` tailored to the box (adds the
   `Steam Client Service` watch only if Steam is installed),
5. disables hibernation so the Suspend action sleeps to RAM
   (`-KeepHibernate` to skip),
6. opens the port in Windows Firewall for the network profile(s) the box is on
   (Private, plus Public/Domain when the active network is classed that way, so
   a home LAN that Windows misclassifies as **Public** still pairs),
7. registers + starts a **Scheduled Task** ("Couchside Agent"): at-logon,
   current user, **non-elevated**, in the interactive session,
8. opens `http://localhost:8787/pair` — scan the QR with the Couchside app.

Idempotent: safe to re-run for upgrades. An existing token and config.json
are always kept, so paired phones keep working.

### Options / uninstall

Options don't survive the `| iex` pipe, so download the script to pass them:

```powershell
irm https://couchside.tv/install.ps1 -OutFile install.ps1
powershell -ExecutionPolicy Bypass -File install.ps1 -Port 9000 -NoGamepad
powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall
```

Flags: `-Port <n>`, `-NoGamepad`, `-NoFirewall`, `-KeepHibernate`,
`-Uninstall`.

### Why a Scheduled Task and not a Windows service

Virtual input (`SendInput`, ViGEm) must run **in the interactive user
session**. A classic Windows service lives in session 0 and its injected
input never reaches the desktop. The task runs **non-elevated**: an
interactive user can shut down, reboot, suspend, and lock without admin
rights, and SendInput/ViGEm need none either. This mirrors the Linux
agent's least-privilege model — the token-authed action/launcher API runs
LAN requests as an ordinary user, never as Administrator. (An action that
genuinely needs admin — e.g. `net stop` on a service — will fail; like the
Linux sudoers model, privileged actions are an explicit opt-in you own, by
running the task elevated at your own risk.)

### Virtual gamepad prerequisite: ViGEmBus

The gamepad emulates a real Xbox 360 pad through the
[ViGEmBus](https://github.com/nefarius/ViGEmBus/releases) kernel driver (the
same driver DS4Windows uses) driven via `ViGEmClient.dll` placed next to the
agent. Without it, everything else still works and the app's pad screen
shows "gamepad unavailable" — mouse, keyboard, and volume need **no driver**
(they go through `SendInput`).

## What maps to what

| Contract surface | Linux agent | Windows agent |
|---|---|---|
| `/api/status` uptime/mem/disks | `/proc`, `statvfs` | `GetTickCount64`, `GlobalMemoryStatusEx`, fixed drives |
| `/api/status` load | loadavg | CPU-utilization EMAs (1/5/15 min) from `GetSystemTimes` |
| `/api/status` cpu_temp_c | hwmon | WMI thermal zone (often unavailable → `null`) |
| `/api/status` net (WoL path) | `/sys`, ethtool | `GetAdaptersInfo`, `Get-NetAdapterPowerManagement` |
| `/api/units` | systemd units | Windows **services** (`sc query`); states mapped to systemd vocabulary |
| `/api/journal` | journalctl | Event Log (`wevtutil`), provider = unit name, SCM fallback |
| `/api/actions` | sudo systemctl | `shutdown.exe` / `rundll32` (task already elevated) |
| `/api/launchers` steam: | `~/.steam` + VDF/ACF | registry `SteamPath` + same VDF/ACF parsing; `steam.exe steam://rungameid/…` |
| `/api/tv` soft volume | uinput media keys | `SendInput` `VK_VOLUME_*` (native mute + OSD; `muted` read via Core Audio) |
| `/api/tv` panel (RS-232) | `/dev/ttyUSB*` termios | `COMn` via `CreateFileW`/`SetCommState` (same Newline frames) |
| `/api/tv` CEC | cec-ctl / cec-client | not available on Windows (panel or soft only) |
| `/ws/gamepad` pad | uinput Xbox 360 | **ViGEmBus** Xbox 360 |
| `/ws/gamepad` mouse/kb | uinput | `SendInput` (text via `KEYEVENTF_UNICODE`: layout-independent, any script) |
| Pairing `/pair` | inlined JS QR | server-rendered QR (`qr.py`) |
| Privilege model | scoped NOPASSWD sudoers | non-elevated interactive scheduled task |
| Service supervision | systemd `Restart=always` | task `RestartCount`/`RestartInterval` |

Config schema is identical (see the [Linux README](../README.md#configuration-etccouchsideconfigjson));
differences: `units[].name` is a Windows **service name** (scope is accepted
but ignored), and `panel.device` is a COM port (`"COM3"`).

The Windows panel backend drives the **core** TV op set (power, volume, mute)
over the same Newline RS-232 frames. The newer RS-232 extensions — input-source
switching (`/api/tv/source/<id>`), screen blank (`screen_toggle`), factory-remote
keys (`/api/tv/key/<k>`), and absolute-volume set (`/api/tv/volume`) — are Linux
(`couchsided.py`) only for now; the Windows agent's `/api/tv` reports neither the
`sources`/`keys`/`screen_toggle` flags nor the `*_level` readings, so the app's
Remote-view TV clusters and absolute slider stay hidden on a Windows box.

## Suspend / Wake-on-LAN notes

- The Suspend action uses `rundll32 powrprof.dll,SetSuspendState 0,1,0`,
  which **hibernates** when hibernation is enabled — that's why the
  installer runs `powercfg /hibernate off`.
- For the app's wake path, enable "Wake on Magic Packet" in the NIC's
  Device Manager properties (and, on many boards, in the BIOS). Wired
  Ethernet strongly recommended. `/api/status`'s `net.wol_armed` reports
  the current state when readable.

## Development (mock mode, runs on macOS/Linux too)

```sh
python3 agent/win/couchsided-win.py --mock --host 127.0.0.1 --port 8787 --token devtoken
```

Same behavior as the Linux agent's mock mode: believable fake data
(Windows-flavored hostnames, `C:\`/`D:\` disks, Event-Log-style journal
lines), no real commands, gamepad/mouse/keyboard events logged to stdout.
Real mode refuses to start on non-Windows.

## Security model

Same as the Linux agent (token bearer auth, constant-time compares,
allowlisted journal reads, argv-list actions with `shell=False`, loopback +
Host-header-gated `/pair`, LAN-only plain HTTP — do **not** port-forward),
with the sudoers model replaced by a **non-elevated** interactive scheduled
task (LAN clients holding the token can only ever execute as the ordinary
desktop user, never as Administrator). The token file is ACL-restricted via
language-neutral SIDs to SYSTEM/Administrators/the installing user. The
firewall rule opens the port for the profile(s) the box is actually on —
Private always, plus Public/Domain only when the active network is classed
that way (so a misclassified home LAN pairs, while a truly-private box stays
Private-only). If the box roams to untrusted Wi-Fi, tighten the rule to
Private and rely on the bearer token, which every route but `/api/ping`
requires regardless.
