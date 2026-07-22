# Project — first-class Nobara support

Goal: Couchside installs and runs on **Nobara Linux** as cleanly as it does on Bazzite/SteamOS.
Nobara is Fedora-based, NOT immutable (no rpm-ostree), ships firewalld, SELinux, KDE by default
(sddm) with a GNOME variant (gdm), and has Steam + gamescope available but manages sessions as
normal desktop logins.

Status: **📋 Planned, blocked on hardware.** No Nobara box or VM exists yet. Everything below is
code-grounded (swept 2026-07-21/22); nothing is hardware-observed.

Sibling target CachyOS (Arch-based) is deliberately out of scope here — different package
manager, different firewall story, and no evidence gathered yet.

---

## The scope surprise: the installer is already distro-agnostic

The earlier assumption was that `install.sh` needed a package-manager + firewall abstraction.
It does not. Verified on `install.sh`:

- **No distro detection at all.** Preflight rejects are only: running as root (`:351`), missing
  `python3` (`:356`), missing `systemctl` (`:358`). No `/etc/os-release` read, no hard reject.
- **Installs no packages.** No `dnf` / `pacman` / `apt` / `rpm-ostree` / `flatpak install`
  anywhere. It assumes `python3`, `systemctl`, `curl`, `openssl`, `sha256sum`, `usermod`,
  `udevadm` — all present on a stock Nobara.
- **Firewall is already the Fedora path**: `firewall-cmd --add-port ${PORT}/tcp --permanent`
  gated on `firewall-cmd --state` (`:898-905`).
- **No immutable-OS handling to port**: no `rpm-ostree` / `steamos-readonly` / `usroverlay`, and
  **zero `/usr` writes**. It writes `/etc/couchside`, `/etc/systemd/system`, `/etc/sudoers.d`,
  `/etc/udev/rules.d`, `/etc/modules-load.d`, `/var/lib/couchside`, `~/.local/...` — all
  writable on Nobara.
- **No SteamOS binaries referenced** by the installer (`steamos-session-select` and
  `steamos-add-to-steam` appear only in the agent).
- Sudoers (`zz-couchside`, fixed-argv NOPASSWD), `input` group, uinput/rtc udev rules,
  WoL `.link`, Ed25519 verify + SHA256SUMS, Decky-coexistence dormancy — all distro-agnostic.

Agent side, the probe-and-appear discipline holds: nothing crashes, and **no capability wrongly
probes TRUE**. Steam-dependent features gate on `_steam_root()`, not on distro, so Steam library,
launch, steam menus, gaming card, stream host + client all work. Hardware probes (gamepad,
media, TV, screen, power) are unaffected.

---

## The three real work items

### 1. SELinux vs the service exec path — the only real risk, UNVERIFIED

`couchside.service` is a **system** unit with `User=<desktop user>` and
`ExecStart=/usr/bin/python3 <install dir>/couchsided.py`, where the install dir is under `$HOME`
(`install.sh:859`, `agent/couchside.service:20`). Under Fedora targeted policy in enforcing mode,
an init-domain service reading/exec'ing from `user_home_t` is normally denied — likely an AVC
and a failed start. SteamOS/Bazzite never exercise this. **The repo has zero SELinux handling**
(no `restorecon`, `chcon`, `semanage`, or policy module anywhere).

This is a policy-based inference, NOT an observation. Nobara may ship permissive, which collapses
the item to a note. Resolve it first, on a box: `getenforce`, stock install, then
`journalctl -u couchside` + `ausearch -m avc -ts recent`.

If enforcing and denied, preferred fix is `semanage fcontext` + `restorecon` on the install dir,
branched inside `install.sh` only when SELinux is enforcing — no path migration for existing
SteamOS/Bazzite boxes. Relocating the install dir (e.g. `/var/lib/couchside`) is the fallback and
has a much bigger blast radius (update path, Decky-owned boxes); do not reach for it first.

**Constraint that shapes the fix:** `couchside update` re-runs `install.sh` from signed release
assets, so anything applied out-of-band gets undone. The fix must live in `install.sh` or the
signed `couchside.service` template.

### 2. `_is_steamos_like()` — the one distro gate in the agent

`agent/couchsided.py:1903` reads `/etc/os-release` and returns True only if the text contains
`"steamos"` or `"bazzite"`. It is the ONLY distro detector in ~12k lines. On Nobara it returns
False, which hides Couch Mode (`couchmode_available()` `:1935`, gated at `:1949`), the `desktop`
cap (`:2038`), and guide-hold.

- **Guide-hold is coupled for no technical reason.** `guide_hold_available()` (`:8771`) requires
  `couchmode_available()`, but everything under it — `/proc/bus/input/devices` parsing, evdev
  reads, the Phys-or-Uniq + declares-`BTN_MODE` pad filter — is fully distro-agnostic and needs
  only group `input`. Decoupling it (gate on readable evdev, not on distro) hands Nobara the
  guide-button trigger with no new mechanism.
- **Couch Mode proper** additionally requires all four `_COUCHMODE_TOOLS` (`:1900`):
  `gamescope`, `steamos-session-select`, `kscreen-doctor`, `wpctl`. Whether Nobara's HTPC /
  gamescope-session edition provides a `steamos-session-select` equivalent is unknown and must be
  measured on the box. If the tools are there, converting the gate from distro-name to
  tool-presence lights the feature up naturally; if not, it stays hidden and that is correct.
- Screensaver stays hidden either way: `screensaver_available()` (`:1481`) needs
  `steamos-add-to-steam`, which is SteamOS/Bazzite-only.

### 3. sddm assumptions — smaller than it first looked

The agent's built-in `DEFAULT_UNITS` (`:92-96`) and `DEFAULT_ACTIONS["restart-session"]`
(`:99-106`, cmd `sudo systemctl restart sddm` at `:103`) hardcode sddm with no probe gate.

**But `load_config` REPLACES `ACTIONS` wholesale** (`ACTIONS = actions`, `:614`) — it does not
merge — and `install.sh` already conditions both the watchlist entry and the action on
`systemctl cat sddm.service` succeeding (`:639-670`). So on any normally-installed box the
installer's conditioning governs, and the hardcoded defaults surface **only in the
config-missing / config-invalid fallback path** (`:605-612`). Registered as **KI-023 (low)**,
not a Nobara blocker.

Latent cousin, same family: `_inject_session_actions()` (`:704`) injects switch-desktop /
return-gamemode on `shutil.which("steamos-session-select")` **alone**, without the distro gate
that fronts Couch Mode. A third-party gamescope-session package supplying that binary on Nobara
would surface both actions, and `_default_desktop_session()` (`:2218`) would fail its
`steamosctl` probe and fall back to the X11 `plasma` argument — silently moving a Wayland user to
X11. Registered as **KI-024 (low)**.

---

## Which flavor? It matters — but only for the optional half

Nobara ships **five editions**, each also in an NVIDIA variant (nobaraproject.org/download,
checked 2026-07-22): **Official** (custom KDE, the recommended default), **KDE**, **GNOME**,
**Steam-HTPC** (Steam/gamescope interface, living-room TV) and **Steam-Handheld** (Steam
interface, Deck-style devices).

Core Couchside — pair, remote, vitals, units, power actions, gamepad/trackpad, media, Steam
library + launch, stream host/client, TV control — is desktop-environment-agnostic and behaves
the same on all five. What varies is three things, and two of them are KDE binaries the code
already depends on:

| Axis | Official / KDE | GNOME | Steam-HTPC / Steam-Handheld |
|---|---|---|---|
| Display manager | sddm — `restart-session` works | gdm — installer omits the action (`install.sh:639-670`) | sddm underneath |
| `kscreen-doctor` (in `_COUCHMODE_TOOLS`, `:1900`) | present | **absent — Couch Mode structurally impossible** | present if KDE is installed alongside |
| `spectacle` (desktop screen capture, `:7565`) | present | **absent** | n/a in-session (gamescopectl covers it) |
| gamescope session | not by default | no | **yes — the Couch Mode candidate** |

Consequences:

- **GNOME is the reduced flavor.** Couch Mode can never work there (kscreen-doctor is Plasma-only),
  and desktop screen capture has no backend — the agent's only two grabbers are `gamescopectl`
  (needs a live gamescope socket) and `spectacle` (KDE). Note the cap is set from static binary
  presence (`set_screen` `:7505-7510`) while backends are resolved per request (`_screen_live`),
  so on a GNOME box with gamescope installed but not running, the SCREEN card can appear and then
  503 on every frame. It degrades closed rather than serving a lie, but the card should not be
  there. Wayland-native capture on GNOME means the xdg-desktop-portal ScreenCast route — a real
  piece of new work, not a binary swap. Out of scope for v1: document GNOME as core-only.
- **Steam-HTPC is the flavor to target and to test on.** It is the living-room use case Couchside
  exists for and the closest analogue to Bazzite, so it is where the Couch Mode question actually
  gets answered. Steam-Handheld is the Legion-Go-S-shaped sibling.
- **Official/KDE is the desktop control case** and should be the phase-0 box: it exercises sddm,
  kscreen-doctor and spectacle, so a pass there separates "distro problem" from "flavor problem".
- **NVIDIA variants are an orthogonal, untested axis** shared with Bazzite — see the standing
  NVIDIA gap (CEC likely absent, gamescope/couch-mode, screen capture, DRM enumeration). Do not
  fold NVIDIA findings into the Nobara verdict; test the non-NVIDIA ISO first so one variable
  moves at a time.

Practical answer to "does the flavor matter": **for shipping "Nobara is supported", no** — the
installer and core agent do not care. For Couch Mode / screensaver / screen capture, **yes**, and
the split is KDE-vs-GNOME plus whether a gamescope session exists, not a Nobara version number.

## Phases

**Phase 0 — box + ground truth. Blocks everything. ~half session.**
Nobara **Official (KDE)** box or VM, non-NVIDIA — it exercises sddm + kscreen-doctor + spectacle,
so a failure there is a distro problem rather than a flavor gap. Run **stock, unmodified**
`install.sh` first — the point is to observe what
actually breaks, not to pre-patch. Record: `getenforce`; whether `couchside.service` starts; any
AVC denials; which caps probe true; the `/api/actions` list; and the app driven against it —
pair, trackpad, a launch, a power action. Press the controls, don't just render them.

**Phase 1 — core support (the "supported" bar). ~1 session after phase 0.**
- SELinux branch in `install.sh`, shaped by phase-0 evidence (item 1).
- Tighten the session-action gate, KI-024 (item 3), + agent tests in the existing pure-stdlib
  `tests/test_*.py` style, including the absent-tool refusal case.
- Verification sweep on the box: install → pair → remote → gamepad → media → launch → **update
  path** (`couchside update` must not undo the SELinux fix) → uninstall.
- Docs: README distro list; couchside.tv copy (the ets3d repo consumes the signed installer via
  the existing sync — no pipeline change).
- Re-run `scripts/release-agent.sh` to re-sign. Branching **inside** existing files needs no
  release-flow change; only a NEW standalone file (e.g. an SELinux policy module) must be added
  to the `files=()` array (`release-agent.sh:35`) or `install.sh`'s own verify step will fetch an
  unlisted file.

**Phase 2 — Couch Mode family on Steam-HTPC. Optional, ~1 session, empirical.**
- Second box/VM: **Steam-HTPC** edition. Measure which of the four `_COUCHMODE_TOOLS` exist there
  and what its session-select equivalent is.
- Decouple guide-hold from the distro gate first — smallest, most certain win.
- If the tooling exists, convert the gate to tool-detection and live-prove the desktop↔gamescope
  switch **in both directions** (a detector is unverified until seen firing AND not firing).
  If not, leave it hidden and document why.

## Explicitly NOT verified

- No Nobara box of any edition exists. SELinux mode, Steam-HTPC session tooling, and gdm
  behaviour are all unobserved.
- The flavor table above is derived from what each desktop ships (kscreen-doctor and spectacle are
  Plasma components) plus the edition list on nobaraproject.org — **not** from running the agent on
  any of them. Confirm per edition before claiming support.
- NVIDIA variants untested, same standing gap as Bazzite.
- Whether Steam-HTPC's gamescope session is close enough to SteamOS's for Couch Mode to work at
  all.
