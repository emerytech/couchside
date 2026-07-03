#!/usr/bin/env bash
# install.sh — CouchPilot box agent installer.
#
# Run this ON the box (SteamOS / Bazzite), as your normal desktop user:
#
#   curl -fsSL https://raw.githubusercontent.com/emerytech/couchpilot/main/install.sh | bash
#
# Or from a git checkout:  ./install.sh
#
# Flags:
#   --no-sudoers   skip installing /etc/sudoers.d/couchpilot (high-danger
#                  actions and system journal reads will fail without it)
#   --uninstall    remove the agent (asks before deleting the token/sudoers)
#   --help         this text
set -euo pipefail

# Raw file sources (used when not running from a git checkout)
DAEMON_URL="https://raw.githubusercontent.com/emerytech/couchpilot/main/agent/couchpilotd.py"
UNIT_URL="https://raw.githubusercontent.com/emerytech/couchpilot/main/agent/couchpilot.service"

PORT_DEFAULT=8787
INSTALL_DIR="${HOME}/.local/opt/couchpilot"
ETC_DIR="/etc/couchpilot"
TOKEN_FILE="${ETC_DIR}/token"
CONFIG_FILE="${ETC_DIR}/config.json"
SUDOERS_FILE="/etc/sudoers.d/couchpilot"
UNIT_DST="/etc/systemd/system/couchpilot.service"
OLD_ETC_DIR="/etc/rescue-agent"
OLD_TOKEN_FILE="${OLD_ETC_DIR}/token"
OLD_UNIT="rescue-agent.service"
OLD_SUDOERS="/etc/sudoers.d/rescue-agent"

NO_SUDOERS=0
UNINSTALL=0

usage() {
    cat <<'USAGE'
CouchPilot box agent installer. Run ON the box as your desktop user.

Usage: install.sh [--no-sudoers] [--uninstall] [--help]

  (no flags)     install/upgrade the agent (idempotent, safe to re-run)
  --no-sudoers   skip installing /etc/sudoers.d/couchpilot (high-danger
                 actions and system journal reads will fail without it)
  --uninstall    remove the agent (asks before deleting the token/sudoers)
  --help         this text
USAGE
}

for arg in "$@"; do
    case "$arg" in
        --no-sudoers) NO_SUDOERS=1 ;;
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

# ---------------------------------------------------------------------------
# (a) Preflight checks
# ---------------------------------------------------------------------------
if [ "$(id -u)" -eq 0 ]; then
    die "do not run this as root. Run it as your normal desktop user (deck,
       bazzite, ...) — the agent runs as that user and the script uses sudo
       only for the few steps that need it."
fi
command -v python3 >/dev/null 2>&1 || die "python3 not found. CouchPilot needs
       python3 (preinstalled on SteamOS and Bazzite). Install it and re-run."
command -v systemctl >/dev/null 2>&1 || die "systemctl not found — CouchPilot requires a systemd distro."

USER_NAME="$(id -un)"
USER_UID="$(id -u)"

# ---------------------------------------------------------------------------
# --uninstall
# ---------------------------------------------------------------------------
if [ "$UNINSTALL" -eq 1 ]; then
    say "Uninstalling CouchPilot agent (sudo may prompt for your password)"
    sudo systemctl disable --now couchpilot.service 2>/dev/null || true
    sudo rm -f "$UNIT_DST"
    sudo systemctl daemon-reload
    note "removed couchpilot.service"
    rm -rf "$INSTALL_DIR"
    note "removed $INSTALL_DIR"
    if sudo test -e "$ETC_DIR"; then
        if ask_yn "Remove $ETC_DIR (pairing token + config — phones will need re-pairing)?"; then
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
    say "CouchPilot agent uninstalled."
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

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/agent/couchpilotd.py" ]; then
    say "Installing from local checkout: $SCRIPT_DIR"
    cp "$SCRIPT_DIR/agent/couchpilotd.py" "$WORK_DIR/couchpilotd.py"
    cp "$SCRIPT_DIR/agent/couchpilot.service" "$WORK_DIR/couchpilot.service"
else
    command -v curl >/dev/null 2>&1 || die "curl not found (needed to fetch the agent files)."
    say "Fetching agent files from GitHub"
    note "$DAEMON_URL"
    curl -fsSL "$DAEMON_URL" -o "$WORK_DIR/couchpilotd.py"
    note "$UNIT_URL"
    curl -fsSL "$UNIT_URL" -o "$WORK_DIR/couchpilot.service"
fi
python3 -m py_compile "$WORK_DIR/couchpilotd.py" || die "downloaded couchpilotd.py does not compile — aborting."

# ---------------------------------------------------------------------------
# (c) Install the daemon to ~/.local/opt/couchpilot
# ---------------------------------------------------------------------------
say "Installing daemon to $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
install -m 0755 "$WORK_DIR/couchpilotd.py" "$INSTALL_DIR/couchpilotd.py"

# ---------------------------------------------------------------------------
# (d) Token: /etc/couchpilot/token (sudo from here on)
# ---------------------------------------------------------------------------
say "Setting up $ETC_DIR (sudo may prompt for your password)"
sudo mkdir -p "$ETC_DIR"

if sudo test -s "$TOKEN_FILE"; then
    note "token already exists — keeping it (existing phone pairings keep working)"
elif sudo test -s "$OLD_TOKEN_FILE"; then
    note "migrating token from $OLD_TOKEN_FILE (existing phone pairings keep working)"
    sudo cp "$OLD_TOKEN_FILE" "$TOKEN_FILE"
else
    note "generating new pairing token"
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex 24 | sudo tee "$TOKEN_FILE" > /dev/null
    else
        python3 -c 'import secrets; print(secrets.token_hex(24))' | sudo tee "$TOKEN_FILE" > /dev/null
    fi
fi
# Daemon reads the token as the desktop user — enforce every run.
sudo chmod 600 "$TOKEN_FILE"
sudo chown "$USER_NAME" "$TOKEN_FILE"

# ---------------------------------------------------------------------------
# (e) Initial config.json (only if absent)
# ---------------------------------------------------------------------------
if sudo test -s "$CONFIG_FILE"; then
    say "Config $CONFIG_FILE already exists — keeping it"
else
    say "Generating initial $CONFIG_FILE"
    HAVE_SDDM=0
    if systemctl cat sddm.service >/dev/null 2>&1; then
        HAVE_SDDM=1
        note "found sddm.service — adding it to the watchlist + restart-session action"
    else
        note "no sddm.service on this box — skipping session-restart action"
    fi
    HAVE_KODI=0
    if command -v flatpak >/dev/null 2>&1 && flatpak info tv.kodi.Kodi >/dev/null 2>&1; then
        HAVE_KODI=1
        note "found Kodi flatpak — adding a stop-kodi action"
    fi
    HAVE_SDDM="$HAVE_SDDM" HAVE_KODI="$HAVE_KODI" python3 - > "$WORK_DIR/config.json" <<'PYEOF'
import json, os

have_sddm = os.environ.get("HAVE_SDDM") == "1"
have_kodi = os.environ.get("HAVE_KODI") == "1"

units = []
if have_sddm:
    units.append({"name": "sddm.service", "scope": "system"})
units.append({"name": "couchpilot.service", "scope": "system"})

actions, order = {}, []
if have_sddm:
    actions["restart-session"] = {
        "label": "Restart Session",
        "description": "Restart the display session (sddm) — fixes a wedged/black screen",
        "danger": "high",
        "cmd": ["sudo", "systemctl", "restart", "sddm"],
        "user_env": False, "detached": False,
    }
    order.append("restart-session")
if have_kodi:
    actions["stop-kodi"] = {
        "label": "Stop Kodi",
        "description": "Stop the Kodi flatpak — relaunch it from Game Mode",
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
# (f) Sudoers rule — security-sensitive, so here is exactly what gets written
# ---------------------------------------------------------------------------
if [ "$NO_SUDOERS" -eq 1 ]; then
    say "Skipping sudoers rule (--no-sudoers)"
    note "WARNING: without $SUDOERS_FILE, high-danger actions"
    note "(restart-session / reboot / poweroff) and system-journal reads WILL FAIL —"
    note "the daemon has no TTY, so sudo cannot prompt for a password."
else
    say "Installing sudoers rule at $SUDOERS_FILE"
    note "This grants user '$USER_NAME' passwordless sudo for EXACTLY these commands"
    note "(and nothing else) — the daemon needs them because it runs with no TTY:"
    cat > "$WORK_DIR/couchpilot-sudoers" <<SUDOERS
# couchpilot: allow the CouchPilot agent (running as $USER_NAME, no TTY) to run
# exactly the privileged commands it needs, without a password.
$USER_NAME ALL=(root) NOPASSWD: /usr/bin/systemctl restart sddm
$USER_NAME ALL=(root) NOPASSWD: /usr/bin/systemctl reboot
$USER_NAME ALL=(root) NOPASSWD: /usr/bin/systemctl poweroff
$USER_NAME ALL=(root) NOPASSWD: /usr/bin/journalctl *
SUDOERS
    echo "------------------------------------------------------------------"
    cat "$WORK_DIR/couchpilot-sudoers"
    echo "------------------------------------------------------------------"
    sudo visudo -cf "$WORK_DIR/couchpilot-sudoers"
    sudo install -m 0440 -o root -g root "$WORK_DIR/couchpilot-sudoers" "$SUDOERS_FILE"
fi

# ---------------------------------------------------------------------------
# (g) systemd unit
# ---------------------------------------------------------------------------
say "Installing systemd unit $UNIT_DST"
sed -e "s|__USER__|$USER_NAME|g" -e "s|__UID__|$USER_UID|g" \
    "$WORK_DIR/couchpilot.service" > "$WORK_DIR/couchpilot.service.rendered"
sudo install -m 0644 -o root -g root "$WORK_DIR/couchpilot.service.rendered" "$UNIT_DST"
sudo systemctl daemon-reload
sudo systemctl enable couchpilot.service
# restart (not `enable --now`) so re-installs replace the running process too
sudo systemctl restart couchpilot.service

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
    say "No running firewalld detected — skipping firewall step"
    note "(SteamOS ships with no firewall enabled; nothing to open.)"
fi

# ---------------------------------------------------------------------------
# (i) Migration: retire a pre-rename rescue-agent install
# ---------------------------------------------------------------------------
if sudo test -e "$OLD_TOKEN_FILE" || [ -f "/etc/systemd/system/$OLD_UNIT" ]; then
    say "Found a pre-rename Rescue Remote install — migrating"
    if [ -f "/etc/systemd/system/$OLD_UNIT" ]; then
        sudo systemctl disable --now "$OLD_UNIT" 2>/dev/null || true
        sudo rm -f "/etc/systemd/system/$OLD_UNIT"
        sudo systemctl daemon-reload
        note "removed old $OLD_UNIT (replaced by couchpilot.service)"
    fi
    if sudo test -e "$OLD_SUDOERS"; then
        sudo rm -f "$OLD_SUDOERS"
        note "removed old $OLD_SUDOERS (replaced by $SUDOERS_FILE)"
    fi
    note "the old token was copied to $TOKEN_FILE, so paired phones keep working"
    note "($OLD_ETC_DIR left in place — remove it manually when you're satisfied)"
fi

# ---------------------------------------------------------------------------
# (j) Verify + pairing info
# ---------------------------------------------------------------------------
say "Verifying: http://127.0.0.1:${PORT}/api/ping"
sleep 2
curl -fsS "http://127.0.0.1:${PORT}/api/ping"
echo

TOKEN="$(cat "$TOKEN_FILE")"
HOST_SHORT="$(hostname -s 2>/dev/null || hostname)"
PAIR_URL="couchpilot://setup?host=${HOST_SHORT}.local&port=${PORT}&token=${TOKEN}"

echo
echo "=================================================================="
echo " CouchPilot agent is running on ${HOST_SHORT}.local:${PORT}"
echo
echo " TOKEN: ${TOKEN}"
echo
echo " Pair the app by scanning this link with your phone camera:"
echo " ${PAIR_URL}"
echo "=================================================================="
echo
if command -v qrencode >/dev/null 2>&1; then
    qrencode -t ansiutf8 "$PAIR_URL"
elif command -v npx >/dev/null 2>&1; then
    # no -t flag: the qrcode CLI's default renderer draws in the terminal
    npx --yes qrcode "$PAIR_URL" || echo "$PAIR_URL"
else
    echo "(install 'qrencode' for a terminal QR code; for now copy the URL above)"
fi
