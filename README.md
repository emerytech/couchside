# Couchside

**Your phone is the dashboard, remote console, and game controller for your living-room Linux box.**

Couchside pairs a native iOS & Android app with a tiny, dependency-free Python agent that runs on a SteamOS / Bazzite HTPC, a Steam Deck, or any systemd Linux machine. When gamescope wedges into a black screen and the TV shows nothing, Couchside is the screen: see live vitals, read the logs, restart the display session, or become an Xbox 360 controller, all from the couch and entirely on your own LAN. No cloud, no accounts, no analytics.

## See it in action

Real footage — a phone driving Steam Big Picture on the TV over the LAN, nothing staged.

| Navigate & switch input modes | Browse and launch the library |
| --- | --- |
| ![Driving the Steam sidebar from the phone, then switching input modes](docs/media/couchside-remote-nav.gif) | ![Browsing the Steam cover-art library from the phone](docs/media/couchside-launcher.gif) |

| Type from the phone | Big Picture & Quick Access Menu |
| --- | --- |
| ![Typing into the Steam search box on the TV from the phone's keyboard bar](docs/media/couchside-keyboard.gif) | ![Steam Big Picture and the Quick Access Menu, controlled from the phone](docs/media/couchside-bigpicture.gif) |

The full install — one command, scan the QR, drive the box — is on the site: [couchside.tv](https://couchside.tv/#how) (terminal sped up, nothing else).

The gamepad UI on the phone and the Steam sidebar responding on the TV, at the same time:

![Phone showing the Couchside gamepad while the TV shows the Steam menu it is driving](docs/media/couchside-hero-real.jpg)

## Features

- **Live console:** hostname, uptime, CPU temperature, load averages, memory and per-disk usage with color-coded bars, refreshed every few seconds. A big red BOX UNREACHABLE banner (with last-seen time) when the box drops off the network, which is exactly when you need it.
- **systemd unit health:** a watchlist of system and user units (display manager, the Couchside agent itself, your own services) with active/failed state at a glance.
- **One-tap runbook actions:** grouped by danger level, every action confirmed before it runs and *double*-confirmed if it's destructive:
  - **Restart display session** fixes the classic wedged-gamescope black screen without touching anything else.
  - **Reboot** / **Power off** are clean and fire-and-forget.
- **Journal viewer:** the last journald lines for any watchlist unit, newest first, straight from the phone.
- **Virtual game controller:** the agent creates a real virtual **Xbox 360 pad** via `/dev/uinput`; games and Steam Big Picture see genuine wired-360 input. Four input modes, switchable with one tap:
  - **Gamepad:** full layout with dual analog sticks, D-pad, ABXY, bumpers, analog triggers, Start/Select/Guide, and haptic feedback.
  - **Swipe:** an Apple-TV-remote-style surface. Swipe to move through menus, tap to select, plus Back / Guide / Menu buttons. Perfect for Kodi and Big Picture navigation.
  - **Trackpad:** a relative-mouse trackpad with tap-to-click, two-finger right-click and scroll, for desktop sessions.
  - **Remote:** a classic TV-remote layout — a big circular D-pad with OK, Back/Menu/Home/Settings keys, volume and brightness rockers, and Steam/QAM shortcuts. On an RS-232 panel it adds input-source buttons and a BOX/TV toggle that drives either the box (as the virtual gamepad) or the TV's own factory remote over serial.
- **QR pairing:** the installer prints a QR code; scan it with the phone camera and the app opens with host, port, and token prefilled.
- **Volume, mute, and box power.** A control next to the device picker adjusts the box's own OS volume and mute (a real drag-to-set 0–100 slider on SteamOS/Bazzite). On an HDMI-CEC or RS-232 setup you can switch it to drive the TV/panel instead — and on an RS-232 panel, also switch the display's input source, blank the screen without cutting power to an OPS box, and pass factory-remote keys. The same control suspends the box and, once it is offline, wakes it back up with a Wake-on-LAN magic packet.

## Control your TV

Couchside can also drive a **networked smart TV directly** — no HDMI-CEC and no serial cable. Add one under **Setup → Boxes → Smart TV remote**; the D-pad and on-screen keyboard on the Pad tab light up once it's connected.

- **LG webOS** — enter the TV's IP, then accept the pairing prompt that appears on the TV (once). An optional MAC address enables Wake-on-LAN power-on.
- **Samsung (Tizen)** _(beta — not yet validated on real hardware)_ — enter the IP, then approve the "Allow" prompt on the TV. Optional MAC for Wake-on-LAN.
- **Roku** — enter the IP; no pairing. **If the D-pad doesn't respond after adding, the Roku is blocking app control:** on the Roku, set _Settings → System → Advanced system settings → Control by mobile apps → Network access_ to **Permissive**.
- **Android / Google TV** — enter the IP, then type the 6-digit code the TV shows. Optional MAC for Wake-on-LAN.

These network backends run on the Linux agent. The Windows agent supports **Roku** (from `0.3.6-win`); LG/Samsung/Google TV are Linux-only for now. TV control also works **through the box** when it has an HDMI-CEC link or an RS-232 serial panel (power, volume, input source, on-screen remote) — see the volume/power control above.

## Requirements

- A **SteamOS, Bazzite, or other systemd-based Linux** machine on your home network (HTPC, Steam Deck in desktop/docked use, mini PC…). The agent is pure Python 3 stdlib: no pip, and it works on immutable/ostree systems.
  - **Windows HTPC?** There's a Windows agent with the same API ([`agent/win/`](agent/win/README.md)) — services, Event Log, Steam launching + Big Picture, volume, and a ViGEm virtual gamepad. Install it in one line from PowerShell: `irm https://couchside.tv/install.ps1 | iex`.
- An **iPhone or Android phone** on the same LAN.

## Install the agent

On the box (or over SSH):

```sh
curl -fsSL https://couchside.tv/install.sh | bash
```

The installer copies the agent to `~/.local/opt/couchside/`, generates a token at `/etc/couchside/token`, installs a scoped sudoers rule, enables `couchside.service`, opens `8787/tcp` in the local firewall, and finishes by printing a pairing QR code.

## Get the app

- **Android → [Google Play](https://play.google.com/store/apps/details?id=com.ets3d.rescueremote)** — available now.
- **iPhone / iPad → [App Store](https://apps.apple.com/app/id6786884115)** — available now.

Free 7-day trial with every feature unlocked, then a one-time unlock ($4.99 summer launch price). Prefer to build it yourself? The app's full source is right here: clone this repo and run it on your own device for personal use (see [app/LICENSE](app/LICENSE)).

## Pairing

**QR (recommended):** point the phone camera at the QR code the installer prints. It's a `couchside://setup?host=…&port=…&token=…` deep link, so the app opens on the Setup tab with everything prefilled and runs a connection test automatically. Nothing is saved until you tap **SAVE**.

**Manual:** on the Setup tab enter the host (e.g. `mybox.local`), port (`8787`), and the contents of `/etc/couchside/token`, tap **TEST**, then **SAVE**.

## Security model

Couchside is deliberately small and boring about security:

- **Bearer token auth.** Every API route except the reachability ping requires `Authorization: Bearer <token>`; the gamepad WebSocket authenticates before the handshake completes. Comparisons are constant-time (`hmac.compare_digest`). The token file is `chmod 600`; on the phone it lives in the iOS Keychain / Android Keystore.
- **Scoped sudo, nothing more.** The installer writes a `visudo`-validated sudoers rule granting the agent user passwordless sudo for exactly five things: `systemctl restart sddm`, `systemctl reboot`, `systemctl poweroff`, `systemctl suspend`, and `journalctl`. Nothing else. Actions are a fixed table; there is no "run arbitrary command" route.
- **Journal access is allowlisted.** Only units on the configured watchlist can be read, with line counts clamped server-side, so a leaked token can't be used to trawl the whole system journal.
- **LAN-only by design.** The API is plain HTTP on port 8787 and is meant to stay on your local network. The firewall rule opens the port locally; **do not port-forward it**. There is no relay, no cloud endpoint, and the app never talks to anything except your agent.
- No client-addressable file routes. The agent serves image bytes on two routes only: the album-art image a running media player advertises (realpath-allowlisted, image-sniffed, 2 MiB cap; client passes a player id, never a path) and an on-demand screen-preview frame captured to a tmpfs file that's deleted right after (rate-clamped, off by default in the app). Subprocesses run with `shell=False`, errors return brief JSON, never tracebacks.

## Uninstall

```sh
curl -fsSL https://couchside.tv/install.sh | bash -s -- --uninstall
```

That removes the service, sudoers rule, udev/modules-load drop-ins, and the install dir (it asks before deleting the token). To do it by hand:

```sh
sudo systemctl disable --now couchside.service
sudo rm -rf /etc/couchside /etc/sudoers.d/couchside ~/.local/opt/couchside
sudo rm -f /etc/udev/rules.d/99-couchside-uinput.rules \
           /etc/modules-load.d/couchside-uinput.conf \
           /etc/systemd/network/50-couchside-wol.link
sudo rm -f /etc/systemd/system/couchside.service && sudo systemctl daemon-reload
```

Then delete the app from your phone.

## Development

```
agent/   couchsided.py: pure-stdlib Python 3 daemon (HTTP API + gamepad WebSocket)
agent/win/  Windows port of the agent (same API; SendInput + ViGEmBus)
app/     Expo / React Native app for iOS & Android (tabs: Console, Actions, Pad, Launch, Setup; the journal viewer lives inside Setup)
docs/    privacy policy, images
store/   App Store & Google Play metadata, review notes, screenshot plan
```

Develop the app without hardware using the agent's mock mode on your Mac:

```sh
python3 agent/couchsided.py --mock --host 127.0.0.1 --port 8787 --token devtoken
```

Mock mode serves believable fake data and never executes real commands. The HTTP API and the `/ws/gamepad` WebSocket protocol (v2) are documented in [`agent/README.md`](agent/README.md).

## Pricing & license

**The agent is free and open source. The app's source is public. The official app builds are a free 7-day trial, then a one-time unlock: $4.99 summer launch price, rising to $7.99 on September 1.**

- **Agent, installer, brand, docs: MIT.** Use them anywhere, for anything — including building your own client against the protocol. See [LICENSE](LICENSE).
- **The mobile app (`app/`): source-available under the PolyForm Noncommercial License 1.0.0.** Read it, audit it, `npx expo run:ios` / `npx expo run:android` it onto your own phone, and modify it for personal, noncommercial use. What you can't do is sell it or redistribute it commercially. See [app/LICENSE](app/LICENSE). The trial gate ships in this public source; self-built personal copies without a store build are treated as unlocked by design, and that's fine.
- **The official builds on the [App Store](https://apps.apple.com/app/id6786884115) and [Google Play](https://play.google.com/store/apps/details?id=com.ets3d.rescueremote) are free to download** with everything unlocked for 7 days, then a **one-time in-app unlock: $4.99 through the summer, rising to $7.99 on September 1**. No subscription, no accounts. Unlock before September 1 to keep a permanent **Early Adopter** badge. You're paying for signed, notarized, auto-updating builds and a setup that goes from `curl` to couch in under ten minutes. It's also the only funding this project has, so thank you.

© 2026 Taylor Emery (ETS3D LLC).
