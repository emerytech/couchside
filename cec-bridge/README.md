# Couchside: HDMI-CEC bridge

A tiny Raspberry Pi service that lets a Couchside box drive its TV over
**HDMI-CEC** when the box itself can't — the canonical case being a **Windows
HTPC** (no CEC stack) that forwards TV power/volume to a Pi wired to the TV's
HDMI.

```
phone app ──▶ Couchside agent (box) ──HTTP──▶ this bridge (Pi) ──CEC──▶ TV
```

The box's `cec_bridge` TV backend POSTs each TV op here; the bridge runs the
matching CEC command (`cec-ctl` / `cec-client`) to the TV. Pure python3 stdlib,
bearer-token auth, LAN-only.

## Hardware

- A Raspberry Pi wired by **HDMI to an input on the TV** (the Pi's HDMI is a CEC
  *source*). Any Pi works; a **Pi 2B** (32-bit, Ethernet-only) is plenty.
- The TV's **CEC must be enabled** (vendor names: Anynet+ (Samsung), Bravia Sync
  (Sony), SimpLink (LG), Vizio CEC, "HDMI-CEC"). Off by default on many TVs.
- The Pi on the **same LAN** as the box.

## Install (on the Pi)

Flash Raspberry Pi OS Lite (32-bit for a Pi 2B), enable SSH, boot it on Ethernet
with the HDMI in the TV, then:

```sh
sudo ./install-cec-bridge.sh [PORT]        # default port 8799
```

It installs the CEC tooling, drops the bridge to `/opt/couchside-cec`, generates
a token, and enables a systemd service. It prints the `cec_bridge` config block
to paste into the box's `config.json`. `cec-ctl` (kernel CEC, `/dev/cec*`) is the
preferred/verified path on a Pi and is auto-selected when present.

Verify:

```sh
curl -s localhost:8799/api/ping
```

## Wire it to the box

Add a `cec_bridge` block to the **Windows** agent's `config.json`
(`%ProgramData%\Couchside\config.json`), then restart the agent. (The Linux
agent doesn't read `cec_bridge` — it drives HDMI-CEC / RS-232 directly from
its own ports and doesn't need a relay.)

```json
"cec_bridge": {
  "host": "couchside-cec.local",
  "port": 8799,
  "token": "<the token the installer printed>"
}
```

The agent's `GET /api/tv` will then report a TV backend (shown as `cec`), and the
app's TV strip drives TV power (and, if you pick the TV volume target, volume)
through the Pi. On a box that also has a local backend (RS-232 panel), that one
wins; the bridge is used when it's the only external TV backend.

## HTTP API

Token via `Authorization: Bearer <token>` (except `/api/ping`). LAN-only plain
HTTP — **do not port-forward it.**

| Route | Method | Description |
|---|---|---|
| `/api/ping` | GET | Unauthenticated health: `{ok, app, version, tool, host}` |
| `/api/cec` | GET | Capabilities: `{available, tool, adapter, ops}` |
| `/cec/<op>` | POST | Run a CEC op. `<op>` ∈ `power_on power_off volume_up volume_down mute`. Returns the ActionResult `{ok, exit_code, stdout, stderr, duration_ms}` |

`power_off` maps to CEC **standby**; volume/mute use CEC **User Control**
commands (a TV with system-audio control forwards them to an ARC audio system).

Run with `--mock` to log ops without touching CEC (development).
