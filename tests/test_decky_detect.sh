#!/usr/bin/env bash
# Tests install.sh's decky_installed() gate.
#
# Run: bash tests/test_decky_detect.sh
#
# Why this exists: the gate used to be `[ -d "$DECKY_PLUGINS" ]`, i.e.
# ~/homebrew/plugins. Decky Loader's OWN uninstaller removes the systemd unit and
# homebrew/services/PluginLoader but LEAVES homebrew/plugins behind. So a box that
# had uninstalled Decky still tested as "Decky present", took the co-existence
# branch, left couchside.service DORMANT, and handed the agent to a plugin that
# could never load -- ending with no running agent at all.
#
# The function is extracted from install.sh rather than copied, so this test
# fails if the real implementation drifts.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_SH="$HERE/../install.sh"

# Pull the real function out of install.sh (definition through its closing brace).
FN="$(sed -n '/^decky_installed() {/,/^}/p' "$INSTALL_SH")"
if [ -z "$FN" ]; then
    echo "FAIL: decky_installed() not found in install.sh -- did it get renamed?"
    exit 1
fi
eval "$FN"

PASS=$'  \033[32mPASS\033[0m'
FAIL=$'  \033[31mFAIL\033[0m'
fails=0

check() { # check <expected 0|1> <label>
    local want="$1" label="$2" got
    if decky_installed; then got=0; else got=1; fi
    if [ "$got" -eq "$want" ]; then
        echo "$PASS  $label"
    else
        echo "$FAIL  $label (wanted $want, got $got)"
        fails=$((fails + 1))
    fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- the regression: Decky uninstalled, plugins dir left behind ---------------
echo "Decky uninstalled but ~/homebrew/plugins litter remains"
DECKY_PLUGINS="$TMP/home/homebrew/plugins"
DECKY_UNIT="$TMP/no-such-unit.service"
DECKY_LOADER="$TMP/home/homebrew/services/PluginLoader"
mkdir -p "$TMP/home/homebrew/plugins/Couchside"   # the litter the old gate saw
check 1 "not detected (the old -d gate said yes here, and broke the box)"

# --- Decky genuinely installed, via the loader binary ------------------------
echo "Decky installed (homebrew/services/PluginLoader present)"
mkdir -p "$(dirname "$DECKY_LOADER")"
touch "$DECKY_LOADER"
check 0 "detected via the loader binary"

# --- Decky genuinely installed, via the systemd unit only --------------------
echo "Decky installed (unit file only, no loader binary)"
rm -rf "$TMP/home/homebrew/services"
touch "$TMP/plugin_loader.service"
DECKY_UNIT="$TMP/plugin_loader.service"
check 0 "detected via the systemd unit"

# --- nothing at all -----------------------------------------------------------
echo "no Decky anywhere"
DECKY_UNIT="$TMP/absent.service"
DECKY_LOADER="$TMP/absent-loader"
check 1 "not detected"

# --- CONTROL -----------------------------------------------------------------
# Without this, an implementation hardcoded to `return 1` would pass every
# not-detected case above.
echo "control: a fresh Decky install with NO plugins dir must still be detected"
rm -rf "$TMP/home/homebrew/plugins"
DECKY_LOADER="$TMP/home/homebrew/services/PluginLoader"
mkdir -p "$(dirname "$DECKY_LOADER")"
touch "$DECKY_LOADER"
check 0 "detected with no plugins dir (install.sh must mkdir -p before extracting)"

echo
if [ "$fails" -ne 0 ]; then
    echo "FAILED: $fails"
    exit 1
fi
echo "all decky-detect tests passed"
