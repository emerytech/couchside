# Setup → Utilities menu (owner ask 2026-08-08)

> **Status: SPEC, building.** Owner: an extensible Utilities section in Setup that
> hosts one-click hardware/setup helpers as the app grows. **Launch with two
> tenants: OpenPuck flash + HDMI-CEC.** Framework first, tenants plug in.

## The insight: two reusable ENGINES, not N one-offs

Most candidate utilities are one of two shapes. Build each engine once; a new
utility is then a MANIFEST, not new code.

**Engine A — Board flasher** (the OpenPuck pattern):
detect a plugged board's bootloader → fetch a PINNED firmware (verify sha256) →
write it (UF2 drag-drop, or esptool) → verify the device re-enumerates.
Tenants: OpenPuck (nRF52840→SC2 puck), ZMK (same nice!nano board), QMK, WLED
(ESP→TV bias light), CircuitPython (Pico).

**Engine B — Guided installer**: agent runs a FIXED, signed setup → reports state.
Tenants: Sunshine (game-stream host), Tailscale (remote access), Decky install/
repair, xone/xpadneo (Xbox pads), Pi CEC bridge, fwupd (device firmware), EmuDeck.

## Allowlist model — NON-NEGOTIABLE (CLAUDE.md §3)

Every utility is a FIXED operation. A client selects WHICH allowlisted utility runs;
it never supplies a command, path, firmware URL, or device.
- Firmware = a pinned asset + pinned sha256 (fetch-and-verify, or bundled+signed).
  A hash mismatch aborts. No client-supplied firmware/URL ever.
- Target device = matched by a known bootloader VID:PID / mount label, and the
  resolved path is verified contained. Never a random USB drive. Fail-closed.
- Setup scripts (Engine B) = the same signed-release channel the agent assets use.
- Each utility is its own allowlist entry (id → handler), like ACTIONS / _STEAM_MENU_IDS.

## Agent shape (proposed)

- `GET /api/utilities` — list utilities this box supports + per-utility STATE
  (e.g. openpuck: `board_present` / `no_board`; cec: `available`/`enabled`).
  Read-only, probe-and-appear, cap-gated.
- `POST /api/utilities/<id>/run` — execute the allowlisted utility. `<id>` is looked
  up in a frozen registry (`_UTILITIES`), never interpolated. Long ops report via the
  existing progress/notify path where possible.
- New cap `utilities` (SIX sites). Per-tenant availability is a field in the state,
  not a separate cap, so the app renders the section from one probe.

## Tenant 1 — OpenPuck (Engine A). Detail: [[openpuck-utilities-idea]] (memory)

- **Detect:** the nRF52840 nice!nano UF2 bootloader mounts as `NICENANO` /
  `NRF52BOOT` on the box (Linux, same as macOS). Agent watches for that mount /
  the bootloader USB id.
- **Flash:** fetch pinned `OpenPuck-<ver>-standard.uf2` from safijari/openpuck
  (AGPL; verify pinned sha256), `cp` to the mount. The `cp` "Device not configured"
  NON-ZERO exit **is success** (board reboots on write). Then confirm USB
  re-enumerates as Valve `0x28DE:0x1304` ("Steam Controller Puck").
- **Open spike:** does the box automount the bootloader for the agent user (no root
  cp)? — verify on the box before claiming it works.

## Tenant 2 — HDMI-CEC. SCOPE PENDING owner confirm (box-enable vs Pi bridge)

Couchside already has: box CEC via `SupplementaryGroups=video` ([[cec-video-group-fix]]),
CEC control code, and a Pi CEC bridge (`install-cec-bridge.sh`, [[bedroom-cec-bridge]]).
The utility is ONE of:
  (i) **Enable box CEC** — detect a CEC adapter, apply the video-group grant, verify
      the box can drive the TV. Box-side, reuses existing code, verifiable.
  (ii) **Set up a Pi CEC bridge** — for boxes with no CEC: flash/configure a spare Pi.
       Bigger; needs the Pi.

## Phases

1. **Framework:** cap `utilities`, `GET /api/utilities` (+ state), `POST /run`, app
   Setup→Utilities section (probe-and-appear list, per-utility state + action).
2. **OpenPuck tenant** (Engine A core = the board flasher). Fixture-test the flash
   gate (pinned sha256, matched mount, no injection); hardware-verify on the box.
3. **HDMI-CEC tenant** (per the confirmed scope).
4. Later tenants (ZMK/QMK/WLED via the same flasher; Sunshine/Tailscale via Engine B).

## What NOT to do
- No client-supplied firmware/URL/device/command, ever. Pinned + matched + verified.
- No flashing a device that isn't the exact matched bootloader. Fail-closed.
- Don't claim a flasher/CEC works without HARDWARE verification (§11).
