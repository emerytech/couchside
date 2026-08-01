# Project — CachyOS support (and the plasmalogin bug it exposed)

Investigated 2026-07-30 against real hardware. Everything below marked VERIFIED was
read off the box, not inferred. Sibling spec: `project_nobara-support.md`.

> **Status, 2026-08-01.** Items 1 and 2 of "Remaining CachyOS work" have SHIPPED —
> display-manager detection in agent 2.9.66 (see the boxed note below) and the
> Arch/`ID_LIKE` installer pass after it. Item 3 (a pacman OS-update path) is still
> deliberately unbuilt. The investigation is kept verbatim because the reasoning is
> what makes the next distro cheap, not the conclusion.

## The test box

- **ASUS ROG Zephyrus G14** (`GA402RK`), CachyOS, user `deck`, ssh key-based
  (password auth also on, but it is a throwaway test device the owner will tear down).
- `ID=cachyos`, `ID_LIKE=arch`, `BUILD_ID=rolling`, kernel **`7.1.5-1-cachyos-deckify`**.
- Agent **2.9.65** installed via the normal `curl … | bash` and running. `deck` has
  **no passwordless sudo** — plan around that when testing.

## The scope surprise: "deckify" ships Valve's tooling, so ~90% already works

CachyOS's handheld/deckify variant ports the SteamOS userland onto Arch. Present and
VERIFIED: `steamos-session-select`, `steamos-add-to-steam`, `gamescope`, `steam`,
`jupiter-biosupdate`, `/dev/uinput`, Python 3.14.6. No firewall at all (nothing to open).
Absent: `steamos-update`, `rpm-ostree` (pacman, non-atomic).

**Caps VERIFIED live on the box** (`/api/status`, agent 2.9.65). Auth gate intact —
no-token `/api/status` → 401:

    true : gamepad steam media tv screen power_schedule boxbattery file_upload
           gaming steamlink steammenus streamhost display_info session_default
    false: couchmode desktop screensaver player

- `couchmode: false` is **correct**, not a bug — a laptop with one panel and no TV
  attached has nothing to hand off to. Re-test on a box with an external display.
- OS-update buttons correctly never appear: `os_updater_kind()` finds neither
  `rpm-ostree` nor `steamos-update` and returns None. Degrades closed, as designed.
- **Couch Mode itself should work once a display is attached.** `steamos-session-select`
  here is a CachyOS reimplementation, but it accepts the exact verbs the agent sends
  (`gamescope`, `plasma`), and its `pkexec` helper is granted
  `allow_any/allow_inactive/allow_active = yes` in
  `/usr/share/polkit-1/actions/org.cachyos.set.session.policy` — so it runs with **no
  password prompt**. This was the predicted showstopper and it is not one.

## THE BUG — display-manager detection fails open (agent + install.sh)

> **FIXED 2026-07-30, agent 2.9.66.**
> `_DM_CONF_DIRS` table (sddm + plasmalogin), plasmalogin in `_KNOWN_DMS`, the
> dm-None→sddm fallback deleted, greetd setter dispatch RESTORED (it was lost in the
> 2.9.65 getter fix — every greetd set silently wrote the SDDM path), restart-session
> retargets/vanishes per detected manager, install.sh allowlists the detected DM before
> writing grants. Mode read now scans the conf dir alphabetically last-wins like the DM
> itself (the state-file fallback was root-only on BOTH measured boxes and never worked).
> LIVE-VERIFIED on this box: old grants → `available:false` end-to-end over HTTP
> (fail-closed observed), fixtures → mode "game"; the Bazzite box regression clean
> (`backend "sddm", mode "desktop"`, stock action kept). Verbatim fixtures from both
> boxes live in tests/test_session_default.py. Leftovers: KI-049 (greetd grant never
> written by install.sh), KI-050 (Decky bootstrap may still write old sddm grants).

Original investigation below, kept verbatim.

**This is not CachyOS-specific. KDE is moving from SDDM to plasmalogin, so Bazzite will
hit it too.** It also breaks the brand-new "Boots into" feature (agent 2.9.58) on any
plasmalogin box, so fix it BEFORE that ships.

VERIFIED on the box:

    /api/session/default  ->  {"available": true, "backend": "sddm", "mode": "unknown"}

    display-manager symlink : /usr/lib/systemd/system/plasmalogin.service
    /etc/sddm.conf.d        : MISSING
    /etc/plasmalogin.conf.d : EXISTS -> zz-steamos-autologin.conf = "Session=gamescope-session.desktop"
    sudo -n -l              : NOPASSWD: /usr/bin/tee /etc/sddm.conf.d/zzz-couchside-session.conf
                              NOPASSWD: /usr/bin/systemctl restart sddm
    grep -c plasmalogin couchsided.py : 0

The agent asks "is there a sudoers grant for the SDDM drop-in?" — which `install.sh`
writes **unconditionally** — and treats that as proof SDDM is the display manager. So on a
plasmalogin box it advertises `available: true, backend: "sddm"`, the app shows the
"Boots into" card, and the write goes to a directory that does not exist. `mode:
"unknown"` is the tell: it cannot read the current value because it is reading the wrong
place. Two conventions broken at once — the probe fails OPEN, and it ships a dead button.

Same root cause hits **`systemctl restart sddm`** — the "Restart display session" rescue
action, the product's signature fix-a-black-screen button — which is aimed at a unit that
does not exist here.

### The fix

Detect, don't assume. CachyOS's own `/usr/bin/steamos-session-select` shows the pattern:

    DISPLAY_MANAGER="$(systemctl show -p Id --value display-manager)"
    case "${DISPLAY_MANAGER%.service}" in
        plasmalogin) CONF_FILE="/etc/plasmalogin.conf.d/zz-steamos-autologin.conf";;
        sddm)        CONF_FILE="/etc/sddm.conf.d/zz-steamos-autologin.conf";;
    esac

The agent **already reads that symlink** — `DISPLAY_MANAGER_UNIT =
"/etc/systemd/system/display-manager.service"` (couchsided.py ~:3805) — it just never uses
it to choose the drop-in path. Derive BOTH the conf dir and the restart unit from the
detected manager. Keep the `zzz-` prefix: the distro owns `zz-steamos-autologin.conf` and
SDDM/plasmalogin read `*.conf` alphabetically with last-wins (already documented ~:3732).

Sites: `SDDM_DROPIN` / `SDDM_DROPIN_LEGACY` / `SDDM_STATE` (~:3745-3749, used again ~:4034),
the availability probe (~:3773), and `install.sh` (~:924, :933-934) which must grant the
path for the DM actually present. Availability must go FALSE when the detected manager has
no writable drop-in — no dead button.

## Remaining CachyOS work (smaller than a port)

1. ~~**Display-manager detection**~~ — SHIPPED in 2.9.66. The only real bug.
2. ~~**Installer pass**~~ — SHIPPED: recognises `ID_LIKE=arch`, pacman for any deps, skips
   the firewall step when none exists (this box has neither firewalld nor ufw).
3. **Optional:** a pacman OS-update path. Arguably leave unsupported — rolling-release
   updates are a different risk profile than atomic ones, and hiding the button is honest.

## Explicitly NOT verified

- Never actually **set** a boot session and watched it fail — `deck` has no passwordless
  sudo and the investigating session declined to use the shared password. (Since resolved:
  both boot states were later proven on this hardware while shipping 2.9.66.)
- `couchmode` with an external display attached (laptop had none).
- `screensaver: false` and `desktop: false` were not chased. `steamos-add-to-steam` IS
  present, so screensaver may only need the shortcut registered.
- `/api/displays` returned `{available: None, outputs: []}` rather than a structured
  answer; not investigated.
