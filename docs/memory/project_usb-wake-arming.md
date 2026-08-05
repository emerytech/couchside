# Controller-wake arming — light up /api/usb-wake + opt-in root arming (owner ask 2026-08-05)

> Owner: contributing to Solaris17/SteamOS-USB-Wake surfaced the question "does any of this
> improve Couchside?" Answer after reading our own code: the wake stack is mostly SHIPPED —
> what remains is rendering the read half and building the deliberate opt-in arm path.

## 1. What already exists (verified by reading source, 2026-08-05)

- **WoL, end to end.** Installer f3 (`install.sh:1200`) arms the wired NIC (systemd `.link`
  persist + ethtool now, WiFi skipped, BIOS caveat noted). App sends magic packets
  (`app/lib/wol.ts`, ports 9+7, react-native-udp behind a `wolAvailable` guard) and
  `api.ts wolRelay()` posts `/api/wol` so an AWAKE sibling box can wake a sleeping one —
  that relay is the iOS answer if react-native-udp is dead there (see §5 open questions).
  `wol_armed`/`mac`/`wired` already ride status (`couchsided.py:1057`).
- **Suspend action** exists, sudoers-gated (`_inject_suspend_action`, `couchsided.py:842`).
- **USB wake read half, shipped DARK.** `/api/usb-wake` (`couchsided.py:15970`) serves
  `usb_wake_devices()` (`:1211`): per-device wake state, `transient` heuristic, hub/root-hub
  flags, mock included. **No app screen calls it — zero hits in app/.** The route comment is
  explicit: arming "writes /sys/.../power/wakeup, which needs root. That stays a deliberate,
  documented, opt-in step." The transient doc comment already encodes the field data (a DIY
  SteamOS box where only root hubs were armed so controllers didn't wake; then arm-everything
  caused spurious wakes when a controller's 15-min auto-off counted as a disconnect; the Xbox
  dongle 045e:02e6 is a leaf that reports transient yet never leaves — heuristic is a UI hint,
  NOT an arming gate).
- **The privileged-helper channel shipped in agent 2.9.69** — the root-write mechanism the
  arm path was waiting for.

## 2. What this project adds

Phase 0 — **render the read half** (app only). A "Wake sources" card (box screen/Settings)
listing devices from `/api/usb-wake`: name, armed state, transient warning copy, and the
directionality caveat (wake is not directional — a controller's auto-off can WAKE the box;
same caveat SteamOS-USB-Wake's README carries). Exit: a user can see WHY their controller
does not wake the box. Web-harness driven — press the card, don't just render it (§6).

Phase 1 — **docs cross-link, zero code, ships anytime.** couchside.tv + Bazzite guide:
"controller doesn't wake the box" → today's manual answers (BIOS WoL/USB toggles, or
github.com/Solaris17/SteamOS-USB-Wake for arm-everything). Carry the spurious-wake caveat.
Goodwill loop: owner is now a contributor to that repo (separate workspace).

Phase 2 — **opt-in arming via the helper.** New helper op: given device ids CHOSEN in the
app, agent looks each id up in its OWN `usb_wake_devices()` output (client id = lookup key,
never a path — §3 rule 1), reads idVendor/idProduct from ITS sysfs, and the helper writes
`/etc/udev/rules.d/99-couchside-usb-wake.rules` with one MATCH line per device
(`ATTR{idVendor}==... ATTR{idProduct}==... ATTR{power/wakeup}="enabled"`) plus an immediate
sysfs write for no-reboot effect. udev persistence beats SteamOS-USB-Wake's boot-oneshot:
covers hotplug AND re-enumeration (their gap; an upstream PR adding the same rule is queued
in the contrib workspace). Default-suggest hubs + require explicit choice for transient
leaves. Disarm = remove rule + write `disabled` to the devices it named; the rule file
itself is the record of what Couchside armed.

Phase 3 — **hardware proof, both states** (§11 rule 2): arm dongle → suspend → controller
powers on → box wakes. Disarm → suspend → controller does nothing. Bazzite box, fixtures
from its sysfs VERBATIM for the tests.

## 3. Constraints and edit-site checklist

- New capability key `usbwake` gates the card → **all SIX edit sites** (agent CAPS + mock;
  app BoxCaps + normalizeCaps + capsEqual; protocol/protocol.json) — parity test enforces.
- Helper op = new allowlisted entry, argv list, no client string ever reaches the rule file
  (vendor/product read from sysfs, id validated against the enumeration).
- Tests: happy + auth-fail + unknown-id refusal for the arm route; §6 row for client-id
  endpoints; udev rule content golden-tested against fixture sysfs.
- Never auto-arm. Never arm-everything. The app's warning copy is load-bearing support
  deflection.

## 4. Non-goals

- No RTC/scheduled wake here (power_schedule exists separately).
- No Windows parity in v1 (different mechanism entirely: powercfg / device manager).
- Not replicating SteamOS-USB-Wake's arm-everything semantics — their tool stays the
  right answer for non-Couchside boxes; ours is per-device and reversible.

## 5. Open questions / unverified

- **Does react-native-udp actually work in the iOS build?** Old memory says iOS UDP blocked;
  `wolAvailable` guards a null dgram. Verify ON DEVICE before any UI promises direct WoL
  from iPhone; the `/api/wol` relay is the fallback either way. (Evidence rule: test the
  thing, don't trust either the old claim or the new hope.)
- Whether `udevadm control --reload-rules` is needed post-write or inotify picks it up on
  SteamOS/Bazzite builds — measure on the box.
- Estimate: Phase 0+1 one session; Phase 2+3 one to two sessions with the bazzite box
  reachable.
