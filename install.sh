#!/usr/bin/env bash
# install.sh: Couchside box agent installer.
#
# Run this ON the box (SteamOS / Bazzite), as your normal desktop user:
#
#   curl -fsSL https://couchside.tv/install.sh | bash
#
# Or from a git checkout:  ./install.sh
#
# Flags:
#   --no-sudoers   skip installing /etc/sudoers.d/couchside (high-danger
#                  actions and system journal reads will fail without it)
#   --uninstall    remove the agent (asks before deleting the token/sudoers)
#   --help         this text
set -euo pipefail

# Raw file sources (used when not running from a git checkout)
DAEMON_URL="https://raw.githubusercontent.com/emerytech/couchside/main/agent/couchsided.py"
UNIT_URL="https://raw.githubusercontent.com/emerytech/couchside/main/agent/couchside.service"
# Pure-stdlib terminal QR renderer, so the installer can draw the pairing QR
# without qrencode (immutable distros like Bazzite rarely ship it). Optional:
# a failed fetch just falls back to printing the URL.
QR_URL="https://raw.githubusercontent.com/emerytech/couchside/main/agent/qr.py"
# Built Decky Loader plugin, shipped as a tarball because the compiled frontend
# (dist/) isn't checked into git, so raw source wouldn't give a working panel.
PLUGIN_URL="https://github.com/emerytech/couchside-decky/releases/latest/download/Couchside.tar.gz"

PORT_DEFAULT=8787
INSTALL_DIR="${HOME}/.local/opt/couchside"
ETC_DIR="/etc/couchside"
TOKEN_FILE="${ETC_DIR}/token"
CONFIG_FILE="${ETC_DIR}/config.json"
SUDOERS_FILE="/etc/sudoers.d/couchside"
UNIT_DST="/etc/systemd/system/couchside.service"

# Decky Loader's plugin directory (root-owned). The optional Game Mode panel is
# installed here when Decky is present, and removed from here on --uninstall.
DECKY_PLUGINS="${HOME}/homebrew/plugins"
DECKY_PLUGIN_DIR="${DECKY_PLUGINS}/Couchside"

# Pairing-QR launcher: a script that opens http://localhost:PORT/pair full-screen
# on the box's own display, plus a .desktop entry to add it to Steam (Game Mode).
PAIR_SCRIPT="${INSTALL_DIR}/couchside-pair"
PAIR_DESKTOP="${HOME}/.local/share/applications/couchside-pair.desktop"

# Prior installs to migrate FROM, oldest first. The chain is:
#   rescue-agent  ->  couchpilot  ->  couchside
# Each entry is "etc_dir|unit|sudoers"; the migration step below retires every
# one it finds, copying the first token it sees into TOKEN_FILE (so paired
# phones keep working) and disabling/removing the old unit + sudoers rule.
OLD_INSTALLS=(
    "/etc/rescue-agent|rescue-agent.service|/etc/sudoers.d/rescue-agent"
    "/etc/couchpilot|couchpilot.service|/etc/sudoers.d/couchpilot"
)

NO_SUDOERS=0
UNINSTALL=0
NO_DECKY=0

usage() {
    cat <<'USAGE'
Couchside box agent installer. Run ON the box as your desktop user.

Usage: install.sh [--no-sudoers] [--no-decky] [--uninstall] [--help]

  (no flags)     install/upgrade the agent (idempotent, safe to re-run)
  --no-sudoers   skip installing /etc/sudoers.d/couchside (high-danger
                 actions and system journal reads will fail without it)
  --no-decky     skip the Decky Loader Game Mode panel even if Decky is found
  --uninstall    remove the agent (asks before deleting the token/sudoers)
  --help         this text
USAGE
}

for arg in "$@"; do
    case "$arg" in
        --no-sudoers) NO_SUDOERS=1 ;;
        --no-decky)   NO_DECKY=1 ;;
        --uninstall)  UNINSTALL=1 ;;
        --help|-h)    usage; exit 0 ;;
        *) echo "error: unknown flag: $arg" >&2; usage >&2; exit 2 ;;
    esac
done

say()  { echo "==> $*"; }
note() { echo "    $*"; }
die()  { echo "error: $*" >&2; exit 1; }

ask_yn() {
    # ask_yn "question" -> returns 0 for yes. Reads from the tty so it works
    # even when the script itself came in on stdin (curl | bash).
    local reply
    if [ -r /dev/tty ]; then
        read -r -p "$1 [y/N] " reply < /dev/tty || reply=""
    else
        reply=""  # non-interactive: default to "no" (keep the files)
    fi
    [[ "$reply" == [yY]* ]]
}

deregister_steam_shortcut() {
    # Remove the "Couchside — Pair Phone" tile from every Steam account's
    # shortcuts.vdf (symmetric with register_steam_shortcut, used on --uninstall).
    # If a pristine .couchside-bak backup exists, restore it verbatim; otherwise
    # surgically drop our entry and reserialize. Steam only reads shortcuts.vdf at
    # startup and rewrites it on exit, so edits while Steam runs are lost — note
    # that and continue (best-effort, never fatal).
    local steamroot=""
    for d in "$HOME/.local/share/Steam" "$HOME/.steam/steam" \
             "$HOME/.var/app/com.valvesoftware.Steam/data/Steam"; do
        [ -d "$d/userdata" ] && { steamroot="$(cd "$d" && pwd -P)"; break; }
    done
    if [ -z "$steamroot" ]; then
        return 0
    fi
    if pgrep -x steam >/dev/null 2>&1; then
        note "Steam is running; it rewrites shortcuts.vdf on exit. Close Steam and"
        note "re-run --uninstall if the 'Couchside — Pair Phone' tile lingers."
    fi

    STEAMROOT="$steamroot" python3 - <<'PYVDF'
# Remove our non-Steam shortcut from shortcuts.vdf (binary VDF, pure stdlib).
# Prefer restoring the pristine .couchside-bak; else drop our entry in place.
import os, struct

APPNAME = "Couchside — Pair Phone"
STEAMROOT = os.environ["STEAMROOT"]


def parse_map(buf, pos):
    out = {}
    while True:
        t = buf[pos]; pos += 1
        if t == 0x08:
            return out, pos
        end = buf.index(b"\x00", pos)
        key = buf[pos:end].decode("utf-8", "replace"); pos = end + 1
        if t == 0x00:
            val, pos = parse_map(buf, pos)
        elif t == 0x01:
            end = buf.index(b"\x00", pos)
            val = buf[pos:end].decode("utf-8", "replace"); pos = end + 1
        elif t == 0x02:
            val = struct.unpack_from("<i", buf, pos)[0]; pos += 4
        else:
            raise ValueError("unknown VDF field type 0x%02x" % t)
        out[key] = val


def ser_map(m):
    out = bytearray()
    for k, v in m.items():
        kb = k.encode("utf-8")
        if isinstance(v, dict):
            out += b"\x00" + kb + b"\x00" + ser_map(v)
        elif isinstance(v, int):
            out += b"\x02" + kb + b"\x00" + struct.pack("<i", v)
        else:
            out += b"\x01" + kb + b"\x00" + str(v).encode("utf-8") + b"\x00"
    out += b"\x08"
    return bytes(out)


def is_ours(entry):
    if not isinstance(entry, dict):
        return False
    name = entry.get("AppName", entry.get("appname", ""))
    return isinstance(name, str) and name.strip().lower() == APPNAME.strip().lower()


udir = os.path.join(STEAMROOT, "userdata")
if not os.path.isdir(udir):
    raise SystemExit(0)
for acct in sorted(os.listdir(udir)):
    if not acct.isdigit() or acct == "0":
        continue
    cfg = os.path.join(udir, acct, "config")
    path = os.path.join(cfg, "shortcuts.vdf")
    bak = path + ".couchside-bak"
    if not os.path.exists(path):
        continue
    # Surgically remove ONLY our entry and reserialize. Do NOT restore the
    # pristine .couchside-bak verbatim as the preferred path: Steam rewrites
    # shortcuts.vdf on exit, so the backup lacks any non-Steam tiles the user
    # added AFTER install — restoring it would silently wipe them. The backup is
    # kept only as a last-resort fallback when the live file can't be parsed.
    with open(path, "rb") as f:
        buf = f.read()
    root = None
    try:
        root, _ = parse_map(buf, 0)
    except Exception as e:
        print("    ! %s: could not parse (%s)" % (path, e))
    # Edit in place only if we parsed it AND can reproduce it byte-for-byte.
    if root is not None and isinstance(root.get("shortcuts"), dict) and ser_map(root) == buf:
        shortcuts = root["shortcuts"]
        ours = [k for k, v in shortcuts.items() if is_ours(v)]
        if ours:
            for k in ours:
                del shortcuts[k]
            # Renumber remaining entries to keep the 0..N-1 index Steam expects.
            kept = [shortcuts[k] for k in sorted(shortcuts, key=lambda x: int(x)
                                                 if x.isdigit() else 1 << 30)]
            root["shortcuts"] = {str(i): v for i, v in enumerate(kept)}
            tmp = path + ".couchside-tmp"
            with open(tmp, "wb") as f:
                f.write(ser_map(root))
            os.replace(tmp, path)
            print("    - account %s: removed the Couchside tile" % acct)
    elif os.path.exists(bak):
        # Live file unparseable/unreproducible: fall back to the pristine backup.
        tmp = path + ".couchside-tmp"
        with open(bak, "rb") as bf, open(tmp, "wb") as tf:
            tf.write(bf.read())
        os.replace(tmp, path)
        print("    = account %s: unparseable live file; restored pre-Couchside backup" % acct)
    else:
        print("    ! %s: could not edit and no backup, leaving it alone" % path)
        continue
    # The pristine backup has served its purpose; drop it so a later reinstall
    # re-captures a fresh one.
    if os.path.exists(bak):
        try:
            os.remove(bak)
        except OSError:
            pass
PYVDF
}

# ---------------------------------------------------------------------------
# (a) Preflight checks
# ---------------------------------------------------------------------------
if [ "$(id -u)" -eq 0 ]; then
    die "do not run this as root. Run it as your normal desktop user (deck,
       bazzite, ...). The agent runs as that user and the script uses sudo
       only for the few steps that need it."
fi
command -v python3 >/dev/null 2>&1 || die "python3 not found. Couchside needs
       python3 (preinstalled on SteamOS and Bazzite). Install it and re-run."
command -v systemctl >/dev/null 2>&1 || die "systemctl not found: Couchside requires a systemd distro."

USER_NAME="$(id -un)"
USER_UID="$(id -u)"

# Heads-up for the Steam Deck's most common snag: a fresh Deck's "deck" user
# has no password, so sudo can't authenticate until one is set.
if ! sudo -n true 2>/dev/null; then
    note "The next steps use sudo and will prompt for your password."
    note "On a fresh Steam Deck the 'deck' user has NO password yet. If sudo"
    note "rejects you, run 'passwd' to set one, then re-run this installer."
fi

# ---------------------------------------------------------------------------
# --uninstall
# ---------------------------------------------------------------------------
if [ "$UNINSTALL" -eq 1 ]; then
    say "Uninstalling Couchside agent (sudo may prompt for your password)"
    sudo systemctl disable --now couchside.service 2>/dev/null || true
    sudo rm -f "$UNIT_DST"
    sudo systemctl daemon-reload
    note "removed couchside.service"
    rm -rf "$INSTALL_DIR"
    note "removed $INSTALL_DIR (incl. the couchside-pair launcher script)"
    rm -f "$PAIR_DESKTOP"
    note "removed $PAIR_DESKTOP"
    # Symmetric with install: pull the "Couchside — Pair Phone" tile out of every
    # Steam account's shortcuts.vdf so uninstall doesn't leave a dead tile.
    deregister_steam_shortcut || note "couldn't clean the Steam tile (skipping)"
    sudo rm -f /etc/systemd/network/50-couchside-wol.link
    note "removed the Wake-on-LAN .link file"
    sudo rm -f /etc/udev/rules.d/99-couchside-uinput.rules \
               /etc/udev/rules.d/99-couchside-rtc.rules \
               /etc/modules-load.d/couchside-uinput.conf
    sudo udevadm control --reload-rules 2>/dev/null || true
    note "removed the udev/modules-load drop-ins"
    if [ "$NO_DECKY" -eq 0 ] && sudo test -d "$DECKY_PLUGIN_DIR"; then
        sudo rm -rf "$DECKY_PLUGIN_DIR"
        sudo systemctl restart plugin_loader.service 2>/dev/null || true
        note "removed the Decky Loader Game Mode panel"
    fi
    if sudo test -e "$ETC_DIR"; then
        if ask_yn "Remove $ETC_DIR (pairing token + config; phones will need re-pairing)?"; then
            sudo rm -rf "$ETC_DIR"
            note "removed $ETC_DIR"
        else
            note "kept $ETC_DIR"
        fi
    fi
    if sudo test -e "$SUDOERS_FILE"; then
        if ask_yn "Remove sudoers rule $SUDOERS_FILE?"; then
            sudo rm -f "$SUDOERS_FILE"
            note "removed $SUDOERS_FILE"
        else
            note "kept $SUDOERS_FILE"
        fi
    fi
    say "Couchside agent uninstalled."
    exit 0
fi

# ---------------------------------------------------------------------------
# (b) Get the agent files: local checkout, or fetch from GitHub
# ---------------------------------------------------------------------------
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]:-}" ]; then
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/agent/couchsided.py" ]; then
    say "Installing from local checkout: $SCRIPT_DIR"
    cp "$SCRIPT_DIR/agent/couchsided.py" "$WORK_DIR/couchsided.py"
    cp "$SCRIPT_DIR/agent/couchside.service" "$WORK_DIR/couchside.service"
    # Optional QR helper: present in a checkout, harmless if not.
    [ -f "$SCRIPT_DIR/agent/qr.py" ] && cp "$SCRIPT_DIR/agent/qr.py" "$WORK_DIR/qr.py"
else
    command -v curl >/dev/null 2>&1 || die "curl not found (needed to fetch the agent files)."
    say "Fetching agent files from GitHub"
    note "$DAEMON_URL"
    curl -fsSL "$DAEMON_URL" -o "$WORK_DIR/couchsided.py"
    note "$UNIT_URL"
    curl -fsSL "$UNIT_URL" -o "$WORK_DIR/couchside.service"
    # Optional: don't abort the install if only the QR helper fails to fetch.
    curl -fsSL "$QR_URL" -o "$WORK_DIR/qr.py" 2>/dev/null || true
fi
# Integrity / sanity gate (FAIL CLOSED): never install code we just fetched
# without first checking it parses. py_compile catches a truncated download or an
# HTML error page served in place of the .py, so a half-written daemon can't be
# installed and left crash-looping. This is a SANITY gate, not authentication.
# TODO (stronger follow-up): pin DAEMON_URL/UNIT_URL to a tagged release and
# verify a published SHA256SUMS (curl the sums + `sha256sum -c`) so a
# compromised or MITM'd raw.githubusercontent.com response is rejected too.
python3 -m py_compile "$WORK_DIR/couchsided.py" || die "downloaded couchsided.py does not compile, aborting."
# The unit is not Python; sanity-check it's a non-empty [Service] file so a
# failed/HTML fetch can't be installed as the systemd unit.
if ! grep -q '^\[Service\]' "$WORK_DIR/couchside.service" 2>/dev/null; then
    die "downloaded couchside.service is missing/invalid (no [Service] section), aborting."
fi

# ---------------------------------------------------------------------------
# (c) Install the daemon to ~/.local/opt/couchside
# ---------------------------------------------------------------------------
say "Installing daemon to $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
install -m 0755 "$WORK_DIR/couchsided.py" "$INSTALL_DIR/couchsided.py"
# The QR helper is optional: install it only if it fetched and compiles, so the
# terminal pairing QR works without qrencode. Its absence just prints the URL.
if [ -f "$WORK_DIR/qr.py" ] && python3 -m py_compile "$WORK_DIR/qr.py" 2>/dev/null; then
    install -m 0755 "$WORK_DIR/qr.py" "$INSTALL_DIR/qr.py"
fi

# ---------------------------------------------------------------------------
# (d) Token: /etc/couchside/token (sudo from here on)
# ---------------------------------------------------------------------------
say "Setting up $ETC_DIR (sudo may prompt for your password)"
sudo mkdir -p "$ETC_DIR"

MIGRATED_TOKEN=""
if sudo test -s "$TOKEN_FILE"; then
    note "token already exists, keeping it (existing phone pairings keep working)"
else
    # Look for a token to inherit from any prior install (newest-named first so
    # couchpilot wins over rescue-agent if somehow both are present).
    for entry in "${OLD_INSTALLS[@]}"; do
        old_etc="${entry%%|*}"
        old_token="${old_etc}/token"
        if sudo test -s "$old_token"; then
            MIGRATED_TOKEN="$old_token"
        fi
    done
fi
if sudo test -s "$TOKEN_FILE"; then
    :
elif [ -n "$MIGRATED_TOKEN" ]; then
    note "migrating token from $MIGRATED_TOKEN (existing phone pairings keep working)"
    sudo cp "$MIGRATED_TOKEN" "$TOKEN_FILE"
else
    note "generating new pairing token"
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex 24 | sudo tee "$TOKEN_FILE" > /dev/null
    else
        python3 -c 'import secrets; print(secrets.token_hex(24))' | sudo tee "$TOKEN_FILE" > /dev/null
    fi
fi
# Daemon reads the token as the desktop user, so enforce every run.
sudo chmod 600 "$TOKEN_FILE"
sudo chown "$USER_NAME" "$TOKEN_FILE"

# ---------------------------------------------------------------------------
# (e) Initial config.json (only if absent)
# ---------------------------------------------------------------------------
if sudo test -s "$CONFIG_FILE"; then
    say "Config $CONFIG_FILE already exists, keeping it"
else
    say "Generating initial $CONFIG_FILE"
    HAVE_SDDM=0
    if systemctl cat sddm.service >/dev/null 2>&1; then
        HAVE_SDDM=1
        note "found sddm.service, adding it to the watchlist + restart-session action"
    else
        note "no sddm.service on this box, skipping session-restart action"
    fi
    HAVE_KODI=0
    if command -v flatpak >/dev/null 2>&1 && flatpak info tv.kodi.Kodi >/dev/null 2>&1; then
        HAVE_KODI=1
        note "found Kodi flatpak, adding a stop-kodi action"
    fi
    HAVE_SDDM="$HAVE_SDDM" HAVE_KODI="$HAVE_KODI" python3 - > "$WORK_DIR/config.json" <<'PYEOF'
import json, os

have_sddm = os.environ.get("HAVE_SDDM") == "1"
have_kodi = os.environ.get("HAVE_KODI") == "1"

units = []
if have_sddm:
    units.append({"name": "sddm.service", "scope": "system"})
units.append({"name": "couchside.service", "scope": "system"})

actions, order = {}, []
if have_sddm:
    actions["restart-session"] = {
        "label": "Restart Session",
        "description": "Restart the display session (sddm), fixes a wedged/black screen",
        "danger": "high",
        "cmd": ["sudo", "systemctl", "restart", "sddm"],
        "user_env": False, "detached": False,
    }
    order.append("restart-session")
if have_kodi:
    actions["stop-kodi"] = {
        "label": "Stop Kodi",
        "description": "Stop the Kodi flatpak, relaunch it from Game Mode",
        "danger": "medium",
        "cmd": ["flatpak", "kill", "tv.kodi.Kodi"],
        "user_env": True, "detached": False,
    }
    order.append("stop-kodi")
actions["reboot"] = {
    "label": "Reboot", "description": "Reboot the box", "danger": "high",
    "cmd": ["sudo", "systemctl", "reboot"], "user_env": False, "detached": True,
}
actions["poweroff"] = {
    "label": "Power Off", "description": "Power off the box", "danger": "high",
    "cmd": ["sudo", "systemctl", "poweroff"], "user_env": False, "detached": True,
}
order += ["reboot", "poweroff"]

print(json.dumps({"units": units, "actions": actions, "action_order": order}, indent=2))
PYEOF
    sudo install -m 0644 -o root -g root "$WORK_DIR/config.json" "$CONFIG_FILE"
fi

# ---------------------------------------------------------------------------
# (f) Sudoers rule: security-sensitive, so here is exactly what gets written
# ---------------------------------------------------------------------------
if [ "$NO_SUDOERS" -eq 1 ]; then
    say "Skipping sudoers rule (--no-sudoers)"
    note "WARNING: without $SUDOERS_FILE, high-danger actions"
    note "(restart-session / reboot / poweroff) and system-journal reads WILL FAIL:"
    note "the daemon has no TTY, so sudo cannot prompt for a password."
else
    say "Installing sudoers rule at $SUDOERS_FILE"
    note "This grants user '$USER_NAME' passwordless sudo for EXACTLY these commands"
    note "(and nothing else). The daemon needs them because it runs with no TTY:"
    cat > "$WORK_DIR/couchside-sudoers" <<SUDOERS
# couchside: allow the Couchside agent (running as $USER_NAME, no TTY) to run
# exactly the privileged commands it needs, without a password.
$USER_NAME ALL=(root) NOPASSWD: /usr/bin/systemctl restart sddm
$USER_NAME ALL=(root) NOPASSWD: /usr/bin/systemctl reboot
$USER_NAME ALL=(root) NOPASSWD: /usr/bin/systemctl poweroff
$USER_NAME ALL=(root) NOPASSWD: /usr/bin/systemctl suspend
# Constrain to the exact call the daemon makes: real_journal() runs
# journalctl -u <unit> -n <n> --no-pager -o short-iso via sudo. Requiring the
# leading -u blocks a bare journalctl --file=/... or --directory=/... that a
# trailing bare wildcard would have allowed (arbitrary-file read as root).
$USER_NAME ALL=(root) NOPASSWD: /usr/bin/journalctl -u *
SUDOERS
    echo "------------------------------------------------------------------"
    cat "$WORK_DIR/couchside-sudoers"
    echo "------------------------------------------------------------------"
    sudo visudo -cf "$WORK_DIR/couchside-sudoers"
    sudo install -m 0440 -o root -g root "$WORK_DIR/couchside-sudoers" "$SUDOERS_FILE"
fi

# ---------------------------------------------------------------------------
# (f2) Virtual-gamepad device access (/dev/uinput)
# ---------------------------------------------------------------------------
# The gamepad needs the daemon to write /dev/uinput. On seat-based desktops
# (Bazzite in Game Mode) udev's uaccess tag grants the active user; on a
# headless box there is no seat, so grant access explicitly: a udev rule puts
# the node in group "input" mode 0660 (+autoload the module), and the agent
# user joins that group (the unit also sets SupplementaryGroups=input).
say "Granting the agent access to /dev/uinput (virtual gamepad)"
sudo install -d /etc/udev/rules.d
printf '%s\n' 'KERNEL=="uinput", SUBSYSTEM=="misc", GROUP="input", MODE="0660", OPTIONS+="static_node=uinput"' \
    | sudo tee /etc/udev/rules.d/99-couchside-uinput.rules >/dev/null
printf '%s\n' 'uinput' | sudo tee /etc/modules-load.d/couchside-uinput.conf >/dev/null
sudo modprobe uinput 2>/dev/null || note "uinput module not loadable now (loads on next boot)"
if getent group input >/dev/null 2>&1; then
    sudo usermod -aG input "$USER_NAME"
fi

# Scheduled-wake RTC access: the agent sets an RTC alarm via ioctl on /dev/rtc0,
# which is root:clock by default. Add it to group input (which the agent is
# already in) — no sudoers needed. Kernel-verified: RTC_WKALM_SET carries no
# capability check; only RTC_SET_TIME needs CAP_SYS_TIME, so this grants
# scheduling a wake, NOT skewing the clock.
say "Granting the agent access to /dev/rtc0 (scheduled wake)"
printf '%s\n' 'KERNEL=="rtc0", SUBSYSTEM=="rtc", GROUP="input", MODE="0660"' \
    | sudo tee /etc/udev/rules.d/99-couchside-rtc.rules >/dev/null

# Apply the rules to the already-present nodes so no reboot is needed.
sudo udevadm control --reload-rules 2>/dev/null || true
sudo udevadm trigger --name-match=uinput 2>/dev/null || true
sudo udevadm trigger --subsystem-match=rtc --action=change 2>/dev/null || true

# ---------------------------------------------------------------------------
# (f3) Wake-on-LAN: arm the wired NIC so the phone can wake the box from suspend
# ---------------------------------------------------------------------------
# The app's power control suspends the box over the LAN and wakes it with a
# Wake-on-LAN magic packet. That works only on wired Ethernet with WoL armed, so
# arm it here on the wired default-route interface: a systemd .link file makes it
# persist (udev applies it every boot, no ethtool needed) and ethtool arms it now
# if present. WoL must also be enabled in the box's BIOS/firmware, which software
# cannot set. WiFi boxes are skipped (WoL over WiFi is unreliable).
WOL_IFACE="$(python3 - <<'PYEOF' 2>/dev/null || true
import os
def default_iface():
    try:
        with open("/proc/net/route") as f:
            next(f)
            for line in f:
                c = line.split()
                if len(c) > 1 and c[1] == "00000000":
                    return c[0]
    except Exception:
        return ""
    return ""
i = default_iface()
# Wired only: a wireless NIC has a /sys/class/net/<if>/wireless directory.
if i and not os.path.isdir("/sys/class/net/%s/wireless" % i):
    print(i)
PYEOF
)"
if [ -n "$WOL_IFACE" ]; then
    WOL_MAC="$(cat "/sys/class/net/$WOL_IFACE/address" 2>/dev/null || true)"
    if [ -n "$WOL_MAC" ]; then
        say "Arming Wake-on-LAN on $WOL_IFACE ($WOL_MAC)"
        sudo install -d /etc/systemd/network
        printf '[Match]\nMACAddress=%s\n\n[Link]\nWakeOnLan=magic\n' "$WOL_MAC" \
            | sudo tee /etc/systemd/network/50-couchside-wol.link >/dev/null
        if command -v ethtool >/dev/null 2>&1; then
            sudo ethtool -s "$WOL_IFACE" wol g 2>/dev/null \
                || note "ethtool could not arm WoL now; it applies on the next boot"
        else
            note "ethtool not installed; WoL arms on the next boot via the .link file"
        fi
        note "Enable Wake-on-LAN in the box's BIOS/firmware too if it isn't already."
    fi
else
    note "No wired interface found; skipping Wake-on-LAN arming (WiFi cannot wake)."
fi

# ---------------------------------------------------------------------------
# (g) systemd unit
# ---------------------------------------------------------------------------
say "Installing systemd unit $UNIT_DST"
# Inject the RESOLVED daemon path (never a hardcoded /home): $HOME may be
# /var/home on Bazzite/ostree, a systemd-homed image, or an LDAP path, so a
# literal /home/$USER ExecStart would silently never start there. Substitute the
# __EXEC__ placeholder (current template) AND rewrite the old hardcoded
# /home/__USER__/.local/opt/couchside/couchsided.py path so a raw-fetched older
# unit is healed the same way.
DAEMON_PATH="$INSTALL_DIR/couchsided.py"
sed -e "s|/home/__USER__/.local/opt/couchside/couchsided.py|__EXEC__|g" \
    -e "s|__EXEC__|$DAEMON_PATH|g" \
    -e "s|__USER__|$USER_NAME|g" -e "s|__UID__|$USER_UID|g" \
    "$WORK_DIR/couchside.service" > "$WORK_DIR/couchside.service.rendered"
sudo install -m 0644 -o root -g root "$WORK_DIR/couchside.service.rendered" "$UNIT_DST"
sudo systemctl daemon-reload
sudo systemctl enable couchside.service
# restart (not `enable --now`) so re-installs replace the running process too
sudo systemctl restart couchside.service

# ---------------------------------------------------------------------------
# (h) Firewall (Bazzite/Fedora ships firewalld; SteamOS generally has none)
# ---------------------------------------------------------------------------
PORT="$(sudo cat "$CONFIG_FILE" 2>/dev/null | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("port") or '"$PORT_DEFAULT"')
except Exception: print('"$PORT_DEFAULT"')' 2>/dev/null || echo "$PORT_DEFAULT")"

if command -v firewall-cmd >/dev/null 2>&1 && sudo firewall-cmd --state >/dev/null 2>&1; then
    say "Opening ${PORT}/tcp in firewalld"
    sudo firewall-cmd --add-port="${PORT}/tcp" --permanent
    sudo firewall-cmd --reload
else
    say "No running firewalld detected, skipping firewall step"
    note "(SteamOS ships with no firewall enabled; nothing to open.)"
fi

# ---------------------------------------------------------------------------
# (h2) Pairing-QR launcher: browser opener script + Steam/Game-Mode .desktop
# ---------------------------------------------------------------------------
# These let the user re-show the pairing QR full-screen on the TV with no
# terminal: add the .desktop once via Steam > Add a Non-Steam Game, then launch
# the "Pair Phone" tile in Game Mode. The script opens http://localhost:PORT/pair
# full-screen, preferring a Flatpak Chrome/Chromium app-window, then xdg-open.
say "Installing the pairing-QR launcher ($PAIR_SCRIPT)"
mkdir -p "$INSTALL_DIR"
cat > "$PAIR_SCRIPT" <<'PAIREOF'
#!/usr/bin/env bash
# couchside-pair: open the Couchside pairing QR full-screen on this box.
# The /pair page is served LOCALHOST-ONLY by the agent, so it must be opened
# here on the box (never over the network). Reads PORT from the agent config.
set -u
CONFIG_FILE="/etc/couchside/config.json"
PORT_DEFAULT=8787
PORT="$(python3 - "$CONFIG_FILE" "$PORT_DEFAULT" <<'PYEOF' 2>/dev/null || echo "$PORT_DEFAULT"
import json, sys
try:
    with open(sys.argv[1]) as f:
        print(json.load(f).get("port") or int(sys.argv[2]))
except Exception:
    print(int(sys.argv[2]))
PYEOF
)"
URL="http://localhost:${PORT}/pair"
echo "Opening ${URL} full-screen…"
# Game Mode (gamescope session): there's no desktop browser, but Steam's own
# built-in browser renders the page: steam://openurl works from a non-Steam
# shortcut tile. This is what makes the "Pair Phone" tile work on stock
# SteamOS with no Chrome/Chromium installed.
if [ "${XDG_CURRENT_DESKTOP:-}" = "gamescope" ] \
   || pgrep -x gamescope-session >/dev/null 2>&1 \
   || pgrep -x gamescope >/dev/null 2>&1; then
    exec steam -ifrunning "steam://openurl/${URL}"
fi
if command -v flatpak >/dev/null 2>&1 && flatpak info com.google.Chrome >/dev/null 2>&1; then
    exec flatpak run com.google.Chrome --app="$URL" --start-fullscreen
elif command -v flatpak >/dev/null 2>&1 && flatpak info org.chromium.Chromium >/dev/null 2>&1; then
    exec flatpak run org.chromium.Chromium --app="$URL" --start-fullscreen
elif command -v xdg-open >/dev/null 2>&1; then
    exec xdg-open "$URL"
elif command -v steam >/dev/null 2>&1; then
    exec steam -ifrunning "steam://openurl/${URL}"
else
    echo "No browser launcher found. Open this URL on the box:"
    echo "  $URL"
fi
PAIREOF
chmod +x "$PAIR_SCRIPT"
note "wrote $PAIR_SCRIPT"

say "Installing the Game-Mode launcher entry ($PAIR_DESKTOP)"
mkdir -p "$(dirname "$PAIR_DESKTOP")"
cat > "$PAIR_DESKTOP" <<DESKTOPEOF
[Desktop Entry]
Type=Application
Name=Couchside — Pair Phone
Comment=Show the Couchside pairing QR full-screen on this TV
Exec=${PAIR_SCRIPT}
Terminal=false
Categories=Utility;
DESKTOPEOF
note "wrote $PAIR_DESKTOP"

# ---------------------------------------------------------------------------
# (h3) Register "Couchside — Pair Phone" as a Steam (non-Steam) shortcut
# ---------------------------------------------------------------------------
# Appends an entry to every Steam account's shortcuts.vdf so the pairing tile
# shows up in Game Mode with no manual "Add a Non-Steam Game" step. Steam only
# reads shortcuts.vdf at startup and REWRITES it on exit, so edits made while
# Steam runs are lost. If it's running we offer to shut it down first.
register_steam_shortcut() {
    local steamroot=""
    for d in "$HOME/.local/share/Steam" "$HOME/.steam/steam" \
             "$HOME/.var/app/com.valvesoftware.Steam/data/Steam"; do
        [ -d "$d/userdata" ] && { steamroot="$(cd "$d" && pwd -P)"; break; }
    done
    if [ -z "$steamroot" ]; then
        note "no Steam userdata found, skipping the Game Mode tile"
        return 0
    fi

    if pgrep -x steam >/dev/null 2>&1; then
        note "Steam is running. It rewrites its shortcut list on exit, so the"
        note "tile can only be added while Steam is closed."
        if ask_yn "Close Steam now to add the 'Couchside — Pair Phone' tile (it will need relaunching)?"; then
            steam -shutdown >/dev/null 2>&1 || true
            local waited=0
            while pgrep -x steam >/dev/null 2>&1 && [ "$waited" -lt 30 ]; do
                sleep 1; waited=$((waited + 1))
            done
            if pgrep -x steam >/dev/null 2>&1; then
                note "Steam didn't exit in time. Skipping. Re-run the installer"
                note "with Steam closed, or add $PAIR_SCRIPT via"
                note "Steam > Add a Non-Steam Game."
                return 0
            fi
        else
            note "skipped. Re-run the installer with Steam closed, or add"
            note "$PAIR_SCRIPT via Steam > Add a Non-Steam Game."
            return 0
        fi
    fi

    PAIR_SCRIPT="$PAIR_SCRIPT" STEAMROOT="$steamroot" python3 - <<'PYVDF'
# Append a non-Steam shortcut to shortcuts.vdf (binary VDF, pure stdlib).
# Idempotent: an existing "Couchside - Pair Phone" entry is updated in place.
# Writes a .couchside-bak backup and replaces the file atomically.
import os, struct, sys, zlib

APPNAME = "Couchside — Pair Phone"
EXE = os.environ["PAIR_SCRIPT"]
STEAMROOT = os.environ["STEAMROOT"]


def parse_map(buf, pos):
    out = {}
    while True:
        t = buf[pos]; pos += 1
        if t == 0x08:
            return out, pos
        end = buf.index(b"\x00", pos)
        key = buf[pos:end].decode("utf-8", "replace"); pos = end + 1
        if t == 0x00:
            val, pos = parse_map(buf, pos)
        elif t == 0x01:
            end = buf.index(b"\x00", pos)
            val = buf[pos:end].decode("utf-8", "replace"); pos = end + 1
        elif t == 0x02:
            val = struct.unpack_from("<i", buf, pos)[0]; pos += 4
        else:
            raise ValueError("unknown VDF field type 0x%02x" % t)
        out[key] = val


def ser_map(m):
    out = bytearray()
    for k, v in m.items():
        kb = k.encode("utf-8")
        if isinstance(v, dict):
            out += b"\x00" + kb + b"\x00" + ser_map(v)
        elif isinstance(v, int):
            out += b"\x02" + kb + b"\x00" + struct.pack("<i", v)
        else:
            out += b"\x01" + kb + b"\x00" + str(v).encode("utf-8") + b"\x00"
    out += b"\x08"
    return bytes(out)


def new_entry():
    # Signed view of crc32(exe+name)|0x80000000: the appid scheme Steam uses.
    appid_u = (zlib.crc32((EXE + APPNAME).encode("utf-8")) & 0xFFFFFFFF) | 0x80000000
    appid = struct.unpack("<i", struct.pack("<I", appid_u))[0]
    return {
        "appid": appid,
        "AppName": APPNAME,
        "Exe": '"%s"' % EXE,
        "StartDir": '"%s"' % os.path.dirname(EXE),
        "icon": "",
        "ShortcutPath": "",
        "LaunchOptions": "",
        "IsHidden": 0,
        "AllowDesktopConfig": 1,
        "AllowOverlay": 1,
        "OpenVR": 0,
        "Devkit": 0,
        "DevkitGameID": "",
        "DevkitOverrideAppID": 0,
        "LastPlayTime": 0,
        "FlatpakAppID": "",
        "tags": {},
    }


def is_ours(entry):
    if not isinstance(entry, dict):
        return False
    name = entry.get("AppName", entry.get("appname", ""))
    return isinstance(name, str) and name.strip().lower() == APPNAME.strip().lower()


added = 0
for acct in sorted(os.listdir(os.path.join(STEAMROOT, "userdata"))):
    if not acct.isdigit() or acct == "0":
        continue
    cfg = os.path.join(STEAMROOT, "userdata", acct, "config")
    if not os.path.isdir(cfg):
        continue
    path = os.path.join(cfg, "shortcuts.vdf")
    root = {"shortcuts": {}}
    if os.path.exists(path):
        with open(path, "rb") as f:
            buf = f.read()
        try:
            root, _ = parse_map(buf, 0)
        except Exception as e:
            print("    ! %s: could not parse (%s), leaving it alone" % (path, e))
            continue
        if not isinstance(root.get("shortcuts"), dict):
            root["shortcuts"] = {}
        # Round-trip guard: never touch a file we can't reproduce byte-for-byte.
        if ser_map(root) != buf:
            print("    ! %s: reserialization mismatch, leaving it alone" % path)
            continue
    shortcuts = root["shortcuts"]

    existing = [k for k, v in shortcuts.items() if is_ours(v)]
    if existing:
        for k in existing:  # heal the path if the install dir moved
            shortcuts[k]["Exe"] = '"%s"' % EXE
            shortcuts[k]["StartDir"] = '"%s"' % os.path.dirname(EXE)
        print("    = account %s: tile already present (path refreshed)" % acct)
    else:
        idx = 0
        while str(idx) in shortcuts:
            idx += 1
        shortcuts[str(idx)] = new_entry()
        print("    + account %s: tile added" % acct)
        added += 1

    data = ser_map(root)
    # Back up ONCE: the pristine pre-Couchside file. On a re-run the on-disk
    # file already contains our entry, so re-copying it would clobber the only
    # good backup; the existence check preserves the original.
    bak = path + ".couchside-bak"
    if os.path.exists(path) and not os.path.exists(bak):
        with open(bak, "wb") as f:
            with open(path, "rb") as orig:
                f.write(orig.read())
    tmp = path + ".couchside-tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)

print("    done (%d added). The tile appears next time Steam starts." % added)
PYVDF
}

say "Registering the 'Couchside — Pair Phone' tile in Steam (Game Mode)"
register_steam_shortcut || note "shortcut registration failed. Add $PAIR_SCRIPT via Steam > Add a Non-Steam Game"

# ---------------------------------------------------------------------------
# (h2) Optional: Decky Loader Game Mode panel
# ---------------------------------------------------------------------------
# If Decky Loader is installed, drop in the Couchside plugin so it appears in
# the Quick Access Menu without the plugin store. The panel is a convenience on
# top of the agent, not the agent itself, so nothing here is allowed to abort
# the install: the whole thing runs inside an `if` condition (set -e is
# suspended there) and any failure just prints a note and moves on. --no-decky
# skips it entirely.
if [ "$NO_DECKY" -eq 0 ] && [ -d "$DECKY_PLUGINS" ]; then
    say "Decky Loader detected: installing the Couchside Game Mode panel"
    decky_tmp="$(mktemp -d)"
    # Decky's plugin dir is root-owned (same as a store install), so place the
    # files with sudo and let plugin_loader load them on restart.
    if curl -fsSL "$PLUGIN_URL" -o "${decky_tmp}/Couchside.tar.gz" \
        && sudo rm -rf "$DECKY_PLUGIN_DIR" \
        && sudo tar -xzf "${decky_tmp}/Couchside.tar.gz" -C "$DECKY_PLUGINS"; then
        # Force root ownership: a release archive built in CI can carry the
        # runner's UID/GID, and `sudo tar -x` preserves it — Decky Loader then
        # skips a plugin it doesn't see as root-owned (no error, just missing
        # from the menu). Store installs are root-owned; match that.
        sudo chown -R root:root "$DECKY_PLUGIN_DIR" 2>/dev/null || true
        sudo systemctl restart plugin_loader.service 2>/dev/null || true
        note "panel installed. Open the Decky menu in Game Mode to see it."
    else
        note "couldn't install the panel (skipping); the agent still works."
    fi
    rm -rf "$decky_tmp"
fi

# ---------------------------------------------------------------------------
# (i) Migration: retire every pre-rename install (rescue-agent, couchpilot)
# ---------------------------------------------------------------------------
# The token was already inherited above (section d). Here we disable+remove the
# old units and sudoers rules for BOTH prior names so they don't linger or fight
# the new couchside.service for /dev/uinput or the listen port.
for entry in "${OLD_INSTALLS[@]}"; do
    old_etc="${entry%%|*}"
    rest="${entry#*|}"
    old_unit="${rest%%|*}"
    old_sudoers="${rest##*|}"
    old_token="${old_etc}/token"
    if sudo test -e "$old_token" || [ -f "/etc/systemd/system/$old_unit" ] \
       || sudo test -e "$old_sudoers"; then
        say "Retiring old install: $old_unit"
        if [ -f "/etc/systemd/system/$old_unit" ]; then
            sudo systemctl disable --now "$old_unit" 2>/dev/null || true
            sudo rm -f "/etc/systemd/system/$old_unit"
            sudo systemctl daemon-reload
            note "removed old $old_unit (replaced by couchside.service)"
        fi
        if sudo test -e "$old_sudoers"; then
            sudo rm -f "$old_sudoers"
            note "removed old $old_sudoers (replaced by $SUDOERS_FILE)"
        fi
        note "($old_etc left in place, its token was already migrated;"
        note " remove it manually when you're satisfied paired phones still work)"
    fi
done

# ---------------------------------------------------------------------------
# (j) Verify + pairing info
# ---------------------------------------------------------------------------
say "Verifying: http://127.0.0.1:${PORT}/api/ping"
# Soft retry with backoff: a slow-binding agent must NOT trip `set -e` and abort
# the script BEFORE we print the pairing token/QR below. Poll a few times, then
# degrade to a warning — the token/QR still print so pairing isn't blocked.
ping_ok=0
for attempt in 1 2 3 4 5 6; do
    if curl -fsS "http://127.0.0.1:${PORT}/api/ping" 2>/dev/null; then
        ping_ok=1
        echo
        break
    fi
    sleep "$attempt"   # 1s,2s,3s,... ~21s total before giving up
done
if [ "$ping_ok" -ne 1 ]; then
    note "agent not answering on :${PORT} yet. It may still be starting; check"
    note "'systemctl status couchside.service' and 'journalctl -u couchside'."
    note "Your pairing token/QR are below and remain valid once it comes up."
fi

TOKEN="$(cat "$TOKEN_FILE")"
# Resolve the hostname WITHOUT the `hostname` command. SteamOS doesn't ship it.
# /proc/sys/kernel/hostname is always present on Linux; strip any domain part.
HOST_SHORT="$(cat /proc/sys/kernel/hostname 2>/dev/null || cat /etc/hostname 2>/dev/null || echo localhost)"
HOST_SHORT="${HOST_SHORT%%.*}"
# LAN IP for the &ip= fallback param (UDP connect trick, nothing is sent).
# The app caches it per box and uses it when mDNS breaks (SteamOS Game Mode).
LAN_IP="$(python3 - <<'PYEOF' 2>/dev/null || true
import socket
try:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.connect(("192.0.2.1", 9))
    ip = s.getsockname()[0]
    s.close()
    print("" if ip.startswith("127.") else ip)
except OSError:
    pass
PYEOF
)"
# HTTPS pair link (couchside.tv/pair relaunches the app). Android cameras
# won't open custom schemes from a QR. Params ride the #fragment so the token
# is never sent to the web server.
PAIR_URL="https://couchside.tv/pair#host=${HOST_SHORT}.local&port=${PORT}&token=${TOKEN}"
[ -n "$LAN_IP" ] && PAIR_URL="${PAIR_URL}&ip=${LAN_IP}"

echo
echo "=================================================================="
echo " Couchside agent is running on ${HOST_SHORT}.local:${PORT}"
echo
echo " TOKEN: ${TOKEN}"
echo
echo " Pair the app by scanning this link with your phone camera:"
echo " ${PAIR_URL}"
echo "=================================================================="
echo
if command -v qrencode >/dev/null 2>&1; then
    qrencode -t ansiutf8 "$PAIR_URL"
elif [ -f "$INSTALL_DIR/qr.py" ] && python3 "$INSTALL_DIR/qr.py" "$PAIR_URL" 2>/dev/null; then
    # Pure-stdlib fallback: works on immutable distros with no qrencode.
    :
elif command -v npx >/dev/null 2>&1; then
    # no -t flag: the qrcode CLI's default renderer draws in the terminal
    npx --yes qrcode "$PAIR_URL" || echo "$PAIR_URL"
else
    echo "(couldn't render a terminal QR here; copy the URL above to pair)"
fi

echo
echo "To re-show the pairing QR later without a terminal: launch the"
echo "'Couchside — Pair Phone' tile from your Steam library (Game Mode included"
echo ", it opens in Steam's built-in browser). If the tile isn't there yet,"
echo "restart Steam once, or add $PAIR_SCRIPT via Steam > Add a Non-Steam Game."
