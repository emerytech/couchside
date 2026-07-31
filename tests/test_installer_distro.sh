#!/usr/bin/env bash
# Distro-neutrality pins for install.sh (CachyOS/Arch pass, 2026-07-31).
#
# The installer's job is the same on every systemd distro; what varies is the
# firewall backend and the package-manager hint. These pins keep the two
# distro-aware spots capability-probed (never distro-named) and keep the
# firewall mutation gated on a RUNNING firewall — an installed-but-disabled
# one is the owner's choice.
#
# Textual, like tests/test_update_grant.py: what lands on the box is this text.
set -u
SRC="${1:?usage: test_installer_distro.sh /path/to/install.sh}"
fails=0
check() { # name, condition-result (0/1)
    if [ "$2" -eq 0 ]; then echo "  PASS  $1"; else echo "  FAIL  $1"; fails=$((fails+1)); fi
}

body=$(cat "$SRC")

# firewalld: unchanged, still gated on --state (running), still fixed-port.
echo "firewalld branch"
grep -q 'firewall-cmd --state' "$SRC"; check "gated on a RUNNING firewalld (--state)" $?
grep -q 'firewall-cmd --add-port="${PORT}/tcp" --permanent' "$SRC"; check "opens exactly the agent port" $?

# ufw: present, gated on 'Status: active', opens exactly the agent port.
echo "ufw branch"
grep -q '"^Status: active"' "$SRC"; check "gated on an ACTIVE ufw, not merely installed" $?
grep -q 'ufw allow "${PORT}/tcp"' "$SRC"; check "opens exactly the agent port" $?

# The skip message must not claim every box is SteamOS.
echo "honest skip"
grep -q 'No running firewall (firewalld/ufw) detected' "$SRC"; check "skip names what was checked" $?

# python3 hint: package-manager-aware by PRESENCE, never by distro name.
echo "python3 hint"
grep -q 'pacman -S python' "$SRC"; check "Arch hint exists" $?
grep -q 'dnf install python3' "$SRC"; check "Fedora hint exists" $?
grep -qE 'command -v pacman' "$SRC"; check "hint chosen by command presence" $?

# No feature in the installer may be gated on a distro NAME. The only
# os-release-shaped strings allowed are inside comments/messages. (The
# display-manager allowlist is unit-name-based and exempt.)
echo "no distro-name gating"
gating=$(grep -nE '^\s*(if|elif).*(/etc/os-release|ID_LIKE|ID=)' "$SRC" | grep -cv '^\s*#')
check "no if/elif branches on os-release contents (found $gating)" "$gating"

echo
if [ "$fails" -gt 0 ]; then echo "FAILED: $fails"; exit 1; fi
echo "all installer-distro pins passed"
