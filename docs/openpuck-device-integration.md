# OpenPuck device tools

The mobile app extends its existing **OpenPuck receiver** Utilities card. USB stays
on the selected Couchside computer; the phone does not need USB access.

## Existing features reused

- Linux board detection, pinned/latest firmware resolver, offline seed/cache and
  authenticated `/api/utilities/openpuck/run` route.
- Mobile firmware selection, manual flash confirmation, batch flashing and live
  utility-state refresh. No second firmware download or flashing screen.
- Existing upstream configurator launcher stays available for advanced settings.
- The existing “Pair a controller” action opens Steam's Bluetooth screen. It is
  separate from direct USB OpenPuck/controller pairing.
- The lightweight macOS agent explicitly reports `utilities: false`; Mac users
  retain the standalone utility.
- Windows now provides the same OpenPuck utility routes and existing `utilities`
  capability. Other Linux utilities are not advertised on Windows.

## Added controls

**Inspect puck** reads firmware build/protocol/serial and controller slot battery,
RSSI and report activity. This is a snapshot; inspect again to refresh. The existing
release check can be compared with that actual build. Custom or modified builds
are not labelled current/outdated, and a newer installed build is not downgraded
by an automatic recommendation.

**Run connection check** samples twenty USB responses over roughly ten seconds.
Wireless activity is reported separately. It does not verify every button, axis,
haptic motor or game. An interrupted check records no pass.

**Find USB controller → Pair controller** requires both devices on the selected
computer and Steam closed. Preparation returns device serials, slot numbers and a
90-second one-use confirmation. The agent re-discovers both devices, re-reads the
pairing tables and refuses changed identities or records. Only an empty slot or a
slot already paired to that same device can be used. Other occupied slots are
never replaced. Keys and before-images stay on the agent; a private backup is
saved before writing. Both sides and unrelated slots are read back before commit.
A partial failure explicitly reports recovery is needed, rather than claiming a
successful pair. Verify wireless operation after unplugging the controller cable.

**Enter bootloader for update or reinstall** works on a responsive sealed puck.
It uses the existing Flash buttons after reboot. On SteamOS the desktop may still
require **Mount and Open** for NICENANO; this does not bypass that local policy.

## Implementation boundaries

- All new operations use bearer-authenticated POST routes at
  `/api/utilities/openpuck/device/{inspect,test,prepare_pair,pair,bootloader}`.
- Request fields are closed sets. No arbitrary USB commands, paths, URLs,
  firmware bytes or pairing keys are accepted from the app.
- One mutex covers device operations and flash; overlapping requests are refused.
- Linux uses stdlib `fcntl` USBFS/hidraw and sysfs discovery. It does not detach
  input drivers or install Python dependencies. Existing active-seat USB/HID
  permissions are required. Permission failures are surfaced without elevation.
- Windows uses system WinUSB, SetupAPI and HID DLLs through `ctypes`. No bundled
  libusb or driver replacement. Native calls must be physically validated before
  release. Discovery returns no supported puck for an official Valve receiver.
- Linux remains a single deployment file. Shared operation/resolver functions are
  mirrored into the Windows entry point; an AST parity test prevents divergence.
- Firmware verification checks every UF2 block, family, address range, sequence,
  duplicate target and block count. Only standard assets are accepted. Flash
  success requires a complete write, bootloader disappearance and a newly
  enumerated OpenPuck. A timeout is not counted as a successful batch flash.
- Older agents retain existing flash support; the new routes return 404 and the
  app explains that device tools require a service update.

## Verification and release gate

Automated protocol, auth/refusal, firmware validation, concurrency and pairing
planning tests run for both agents. The existing utilities tests now reject the
old “write error means success” behavior. Mobile pure logic and TypeScript checks
cover firmware comparisons and honest diagnostic results. The web harness must
press all new controls through the real mock HTTP routes.

Physical checks on both Legion (SteamOS) and Emery-PC (Windows) passed:

- Native inspection of firmware 0.9.40 / status protocol 19 and device identity.
- Firmware reinstall with full write and USB reboot confirmation.
- Pairing-table fingerprint unchanged by flashing.
- Direct USB same-device pairing, both records read back, unrelated slots preserved.
- Controller USB removed; twenty USB replies and twenty wireless-activity samples.
- Original puck pairing-table fingerprint still unchanged after re-pairing.

Windows testing exposed CRT text-mode expansion of UF2 bytes and EBADF during
flush after the device rebooted. Explicit binary writes fix the first. The second
enters USB confirmation only after a complete write in the sync/close phase;
permission errors and incomplete writes remain failures. Both fixes have
regression coverage and the corrected native Windows flash passed on hardware.

The app's web harness pressed every new control through authenticated mock routes,
including pairing/bootloader confirmation and the old-agent 404 hint. TypeScript,
agent compilation, utility/device/auth/partial-failure suites, capability parity,
macOS capability compatibility, CI wiring and app logic checks passed locally.
Native Android acceptance on Thor subsequently passed inspection, pairing,
bootloader, firmware reinstall and 20/20 wireless samples before and after flash
against a separate Windows preview agent (source 6f95d79). Pairing records remained
unchanged. The temporary Windows listener and firewall rule were removed afterward.
The Android connection fix at a42e1f5 also passed offline-host to live-Legion
switching without restarting the preview. Native iPhone acceptance remains.
The Android build uses a separate QA package and debug signing; installed store
apps and agent services were preserved. No merge or release is included.
