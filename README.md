# Couchside

**Your phone is the monitor, remote console, and game controller for your living-room Linux box.**

Couchside pairs a native iOS & Android app with a tiny, dependency-free Python agent that runs on a SteamOS / Bazzite HTPC, a Steam Deck, or any systemd Linux machine. When gamescope wedges into a black screen and the TV shows nothing, Couchside is the screen: see live vitals, read the logs, restart the display session, or become an Xbox 360 controller — all from the couch, entirely on your own LAN. No cloud, no accounts, no analytics.

![Console](docs/img/console.png)

## Features

- **Live console** — hostname, uptime, CPU temperature, load averages, memory and per-disk usage with color-coded bars, refreshed every few seconds. A big red BOX UNREACHABLE banner (with last-seen time) when the box drops off the network — which is exactly when you need it.
- **systemd unit health** — a watchlist of system and user units (display manager, the Couchside agent itself, your own services) with active/failed state at a glance.
- **One-tap runbook actions** — grouped by danger level, every action confirmed before it runs and *double*-confirmed if it's destructive:
  - **Restart display session** — fixes the classic wedged-gamescope black screen without touching anything else.
  - **Reboot** / **Power off** — clean, fire-and-forget.
- **Journal viewer** — the last journald lines for any watchlist unit, newest first, straight from the phone.
- **Virtual game controller** — the agent creates a real virtual **Xbox 360 pad** via `/dev/uinput`; games and Steam Big Picture see genuine wired-360 input. Three input modes, switchable with one tap:
  - **Gamepad** — full layout: dual analog sticks, D-pad, ABXY, bumpers, analog triggers, Start/Select/Guide, with haptic feedback.
  - **Swipe** — an Apple-TV-remote-style surface: swipe to move through menus, tap to select, plus Back / Guide / Menu buttons. Perfect for Kodi and Big Picture navigation.
  - **Trackpad** — a relative-mouse trackpad with tap-to-click, two-finger right-click and scroll, for desktop sessions.
- **QR pairing** — the installer prints a QR code; scan it with the phone camera and the app opens with host, port, and token prefilled.
- **TV power & volume — coming soon.** On HDMI-CEC-capable setups, turn your TV on/off and change its volume straight from the app. Built and in pre-release now, shipping in an upcoming update.

![Actions](docs/img/actions.png) ![Pad](docs/img/pad.png)

## Requirements

- A **SteamOS, Bazzite, or other systemd-based Linux** machine on your home network (HTPC, Steam Deck in desktop/docked use, mini PC…). The agent is pure Python 3 stdlib — no pip, works on immutable/ostree systems.
- An **iPhone or Android phone** on the same LAN.

## Install the agent

On the box (or over SSH):

```sh
curl -fsSL https://couchside.tv/install.sh | bash
```

The installer copies the agent to `~/.local/opt/couchside/`, generates a token at `/etc/couchside/token`, installs a scoped sudoers rule, enables `couchside.service`, opens `8787/tcp` in the local firewall, and finishes by printing a pairing QR code.

## Get the app

**Coming soon** — Couchside is in review on both stores:

- iPhone / iPad → [App Store](https://apps.apple.com/app/id6786884115)
- Android → [Google Play](https://play.google.com/store/apps/details?id=com.ets3d.rescueremote)

Free 7-day trial with every feature unlocked, then a one-time unlock ($4.99 summer launch price). Prefer to build it yourself? The app is open source — clone this repo and run it on your own device.

## Pairing

**QR (recommended):** point the phone camera at the QR code the installer prints. It's a `couchside://setup?host=…&port=…&token=…` deep link — the app opens on the Setup tab with everything prefilled and runs a connection test automatically. Nothing is saved until you tap **SAVE**.

**Manual:** on the Setup tab enter the host (e.g. `mybox.local`), port (`8787`), and the contents of `/etc/couchside/token`, tap **TEST**, then **SAVE**.

![Setup](docs/img/setup.png)

## Security model

Couchside is deliberately small and boring about security:

- **Bearer token auth.** Every API route except the reachability ping requires `Authorization: Bearer <token>`; the gamepad WebSocket authenticates before the handshake completes. Comparisons are constant-time (`hmac.compare_digest`). The token file is `chmod 600`; on the phone it lives in the iOS Keychain / Android Keystore.
- **Scoped sudo, nothing more.** The installer writes a `visudo`-validated sudoers rule granting the agent user passwordless sudo for exactly four things — `systemctl restart sddm`, `systemctl reboot`, `systemctl poweroff`, and `journalctl` — and nothing else. Actions are a fixed table; there is no "run arbitrary command" route.
- **Journal access is allowlisted.** Only units on the configured watchlist can be read, with line counts clamped server-side, so a leaked token can't be used to trawl the whole system journal.
- **LAN-only by design.** The API is plain HTTP on port 8787 and is meant to stay on your local network. The firewall rule opens the port locally; **do not port-forward it**. There is no relay, no cloud endpoint, and the app never talks to anything except your agent.
- No file-serving routes, subprocesses run with `shell=False`, errors return brief JSON — never tracebacks.

## Uninstall

```sh
systemctl disable --now couchside.service
sudo rm -rf /etc/couchside /etc/sudoers.d/couchside ~/.local/opt/couchside
sudo rm /etc/systemd/system/couchside.service && sudo systemctl daemon-reload
```

Then delete the app from your phone.

## Development

```
agent/   couchsided.py — pure-stdlib Python 3 daemon (HTTP API + gamepad WebSocket)
app/     Expo / React Native app for iOS & Android (tabs: Console, Actions, Pad, Logs, Setup)
docs/    privacy policy, images
store/   App Store & Google Play metadata, review notes, screenshot plan
```

Develop the app without hardware using the agent's mock mode on your Mac:

```sh
python3 agent/couchsided.py --mock --host 127.0.0.1 --port 8787 --token devtoken
```

Mock mode serves believable fake data and never executes real commands. The HTTP API and the `/ws/gamepad` WebSocket protocol (v1) are documented in [`agent/README.md`](agent/README.md).

## Pricing & license

**The agent is free. The app's code is free. The official app builds are a free 7-day trial, then a one-time unlock — $4.99 summer launch price, rising to $7.99 on September 1.**

- **Agent, installer, brand, docs — MIT.** Use them anywhere, for anything. See [LICENSE](LICENSE).
- **The mobile app (`app/`) — GPLv3.** Clone the repo, `npx expo run:ios` / `npx expo run:android` onto your own phone, modify it, fork it — all welcome. See [app/LICENSE](app/LICENSE). The trial gate ships in this open source; self-built copies may remove it, and that's fine.
- **The official builds on the [App Store](https://apps.apple.com/app/id6786884115) and [Google Play](https://play.google.com/store/apps/details?id=com.ets3d.rescueremote) are free to download** with everything unlocked for 7 days, then a **one-time in-app unlock — $4.99 through the summer, rising to $7.99 on September 1** — no subscription, no accounts. Unlock before September 1 to keep a permanent **Early Adopter** badge. You're paying for signed, notarized, auto-updating builds and a setup that goes from `curl` to couch in under ten minutes. It's also the only funding this project has — thank you.

© 2026 Taylor Emery (ETS3D LLC).
