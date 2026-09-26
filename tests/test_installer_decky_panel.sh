#!/usr/bin/env bash
# The sandbox variables below are read by installer code this file eval()s,
# which shellcheck cannot see.
# shellcheck disable=SC2034
# Does install.sh respect an owner who REMOVED the Couchside Decky panel?
#
# Run: bash tests/test_installer_decky_panel.sh install.sh [baseline-install.sh]
#
# WHY THIS EXISTS (2026-09-26, a user going Decky-free). Removing the Couchside
# plugin from Decky Loader's own Settings > Plugins list is safe on its own: the
# plugin defines no _uninstall, Decky just deletes ~/homebrew/plugins/Couchside,
# and couchside.service keeps running. But install.sh's Decky gate tests for
# Decky LOADER, not for our panel, so every plain run afterwards -- and that
# includes `couchside update` and the app's update button, which pass no flags
# -- (1) put couchside.service back into the DORMANT hand-off (disable --now),
# (2) REINSTALLED the panel ("stamp matches but the plugin is gone (user removed
# it) -> reinstall"), and (3) relied on that plugin's take-over, the 20 s h3
# safety net and the EXIT trap to bring the service back. That disable/enable
# hand-off has already raced a real box offline (inapp-update-decky-race).
# --no-decky existed but was not remembered, so the next update undid it.
#
# The fix persists the choice in /var/lib/couchside/no-decky-panel (STATE_DIR,
# which survived the SteamOS update that dropped /etc/couchside, KI-088) and
# takes the plain standalone branch while it exists. --decky is the way back.
#
# BOTH DIRECTIONS are asserted. The removal cases are paired with controls
# proving the coexistence path is UNCHANGED for owners who never removed the
# panel: dormant hand-off, KI-037 no-needless-restart guard, fresh install,
# new-build reinstall, the ambiguous stamp-and-panel-both-gone case.
#
# Runs the REAL code lifted out of install.sh by marker (functions, the flag
# loop, the service co-existence block, sections h2+h3, the EXIT trap) under
# `set -euo pipefail` like the installer itself, against a throwaway tree.
# sudo is a passthrough shim that REFUSES any absolute path outside the sandbox;
# systemctl and curl are stubs that record every call and model the service's
# enabled/active state; the panel tarball + SHA256SUMS are real, so the h2
# checksum gate does real work. Nothing on this machine is touched.
#
# CONTROL: pass the pre-fix installer as the first argument and the removal /
# --decky cases FAIL (panel reinstalled, dormant hand-off, --decky rejected).
# Pass it as the optional SECOND argument and every "never removed" case is also
# re-run against it and must produce the byte-identical call log and output.
set -u
INSTALLER="${1:?usage: test_installer_decky_panel.sh /path/to/install.sh [baseline-install.sh]}"
BASELINE="${2:-}"
fails=0; passes=0
check() { # name expected actual
    if [ "$2" = "$3" ]; then
        printf '  PASS  %s\n' "$1"; passes=$((passes + 1))
    else
        printf '  FAIL  %s (expected %s, got %s)\n' "$1" "$2" "$3"; fails=$((fails + 1))
    fi
}

# Every fixture path hangs off $T, and the sandboxed installer code runs rm -rf
# on some of them: refuse to start without a real, non-empty temp dir.
T="$(mktemp -d)" && [ -n "$T" ] && [ -d "$T" ] || { echo "mktemp failed"; exit 2; }
trap 'rm -rf "${T:?}"' EXIT

# --- lift the real code out of an installer ------------------------------------
load_regions() { # $1 = installer path
    FN_DETECT="$(sed -n '/^decky_installed() {/,/^}/p' "$1")"
    FN_MARK="$(sed -n '/^decky_panel_mark_off() {/,/^}/p' "$1")"   # absent pre-fix
    FN_RESOLVE="$(sed -n '/^decky_panel_resolve() {/,/^}/p' "$1")" # absent pre-fix
    FN_TRAP="$(sed -n '/^_cs_cleanup() {/,/^}/p' "$1")"
    PARSE="$(awk '/^for arg in "\$@"; do$/,/^done$/' "$1")"
    CONFLICT="$(awk '/^# Reject rather than guess which one was meant\.$/,/^fi$/' "$1")" # absent pre-fix
    SERVICE="$(awk '/^# Decky co-existence:/,/^fi$/' "$1")"
    PANEL="$(awk '/^# \(h2\) Optional: Decky Loader Game Mode panel$/,/^# \(i\) Migration/' "$1")"
    MARKER_LINE="$(grep -m1 '^DECKY_PANEL_OFF=' "$1" || true)"
    local name v n
    for name in FN_DETECT FN_TRAP PARSE SERVICE PANEL; do
        eval "v=\$$name"
        [ -n "$v" ] || { echo "could not extract $name from $1"; exit 2; }
    done
    # A range that ran away (a marker renamed) would let the scenarios exercise
    # far more of the installer than intended -- bound them.
    n=$(printf '%s\n' "$SERVICE" | wc -l | tr -d ' ')
    [ "$n" -gt 8 ] && [ "$n" -lt 60 ] || { echo "service block not bounded ($n lines)"; exit 2; }
    n=$(printf '%s\n' "$PANEL" | wc -l | tr -d ' ')
    [ "$n" -gt 80 ] && [ "$n" -lt 260 ] || { echo "h2/h3 block not bounded ($n lines)"; exit 2; }
}

# --- sandbox paths (the installer's own names, repointed) -----------------------
# Several are read only by the eval'ed installer code (see SC2034 at the top).
HOME_T="$T/home"
DECKY_PLUGINS="$HOME_T/homebrew/plugins"
DECKY_PLUGIN_DIR="$DECKY_PLUGINS/Couchside"
DECKY_UNIT="$T/etc/systemd/system/plugin_loader.service"
DECKY_LOADER="$HOME_T/homebrew/services/PluginLoader"
ETC_DIR="$T/etc/couchside"
DECKY_STAMP="$ETC_DIR/decky-plugin.sha256"
STATE_DIR="$T/var/lib/couchside"
PLUGIN_URL="https://example.invalid/Couchside.tar.gz"
PLUGIN_SUMS_URL="https://example.invalid/SHA256SUMS"
PLUGIN_SIG_URL="https://example.invalid/SHA256SUMS.sig"

# --- stubs ------------------------------------------------------------------------
# sudo: run as the test user, but never on a path outside the sandbox.
sudo() {
    local a
    for a in "$@"; do
        case "$a" in
            "$T"/*) ;;
            /*) echo "SANDBOX-ESCAPE sudo $*" >> "$T/calls"; return 97 ;;
        esac
    done
    "$@"
}
# systemctl: log, and model couchside.service's enabled/active state. A CURRENT
# plugin takes the agent over when plugin_loader (re)loads it (_arm_on_load) --
# only possible when the panel is actually on disk.
systemctl() {
    echo "systemctl $*" >> "$T/calls"
    case "$*" in
        "disable --now couchside.service") rm -f "$T/svc/enabled" "$T/svc/active" ;;
        "enable couchside.service")        : > "$T/svc/enabled" ;;
        "restart couchside.service")       : > "$T/svc/active" ;;
        "enable --now couchside.service")  : > "$T/svc/enabled"; : > "$T/svc/active" ;;
        "is-active --quiet couchside.service") [ -e "$T/svc/active" ]; return ;;
        "restart plugin_loader.service")
            if [ "${PLUGIN_ARMS:-1}" = 1 ] && [ -d "$DECKY_PLUGIN_DIR" ]; then
                : > "$T/svc/enabled"; : > "$T/svc/active"
            fi ;;
        "is-active --quiet plugin_loader.service") return 0 ;;
        *) echo "UNEXPECTED systemctl $*" >> "$T/calls"; return 1 ;;
    esac
    return 0
}
# curl: serve the fake release; no signature is published (checksum-only path).
curl() {
    local out="" url=""
    while [ $# -gt 0 ]; do
        case "$1" in -o) out="$2"; shift ;; -*) ;; *) url="$1" ;; esac
        shift
    done
    echo "curl $url" >> "$T/calls"
    [ "${CURL_FAIL:-0}" = 1 ] && return 22
    case "$url" in
        "$PLUGIN_URL")      cp "$T/rel/Couchside.tar.gz" "$out" ;;
        "$PLUGIN_SUMS_URL") cp "$T/rel/SHA256SUMS" "$out" ;;
        *) return 22 ;;
    esac
}
sleep() { :; }
mktemp() { rm -rf "$T/dtmp"; mkdir -p "$T/dtmp"; echo "$T/dtmp"; }   # deterministic call log
verify_release_sig() { return 2; }

# --- fixtures ---------------------------------------------------------------------
hash_of() { # file -> "hash  name" line
    if command -v sha256sum >/dev/null 2>&1; then (cd "$(dirname "$1")" && sha256sum "$(basename "$1")")
    else (cd "$(dirname "$1")" && shasum -a 256 "$(basename "$1")"); fi
}
build_release() { # $1 = build label (a new label = a new tarball hash)
    rm -rf "$T/rel"; mkdir -p "$T/rel/src/Couchside"
    printf '{"name":"Couchside","build":"%s"}\n' "$1" > "$T/rel/src/Couchside/plugin.json"
    (cd "$T/rel/src" && command tar -czf "$T/rel/Couchside.tar.gz" Couchside)
    {
        echo "0000000000000000000000000000000000000000000000000000000000000000  couchsided.py"
        hash_of "$T/rel/Couchside.tar.gz"
    } > "$T/rel/SHA256SUMS"
}
release_hash() { awk '$2 == "Couchside.tar.gz" {print $1}' "$T/rel/SHA256SUMS"; }
fresh_box() {
    rm -rf "${T:?}/home" "${T:?}/etc" "${T:?}/var" "${T:?}/svc" "${T:?}/work" "${T:?}/dtmp"
    mkdir -p "$HOME_T" "$ETC_DIR" "$STATE_DIR" "$T/svc" "$(dirname "$DECKY_UNIT")"
    unset CURL_FAIL PLUGIN_ARMS
}
with_decky()   { : > "$DECKY_UNIT"; }
with_panel()   { mkdir -p "$DECKY_PLUGINS"; (cd "$DECKY_PLUGINS" && command tar -xzf "$T/rel/Couchside.tar.gz"); }
with_stamp()   { release_hash > "$DECKY_STAMP"; }
svc_running()  { : > "$T/svc/enabled"; : > "$T/svc/active"; }

# --- one installer run ------------------------------------------------------------
run() { # flags...  -> RC; stdout+stderr in $T/out; calls in $T/calls; $T/owns
    : > "$T/calls"; rm -f "$T/owns"
    (
        set -euo pipefail
        HOME="$HOME_T"
        say()  { echo "==> $*"; }
        note() { echo "    $*"; }
        usage() { echo "(usage)"; }
        NO_DECKY=0; DECKY_OPTIN=0; DECKY_PANEL=1
        if [ -n "$MARKER_LINE" ]; then eval "$MARKER_LINE"; else DECKY_PANEL_OFF="$STATE_DIR/no-decky-panel"; fi
        eval "$FN_DETECT"; eval "$FN_MARK"; eval "$FN_RESOLVE"; eval "$FN_TRAP"
        parse() { eval "$PARSE"; }
        parse "$@"
        eval "$CONFLICT"
        WORK_DIR="$T/work"; mkdir -p "$WORK_DIR"
        trap _cs_cleanup EXIT
        eval "$SERVICE"
        eval "$PANEL"
        echo "${DECKY_OWNS_AGENT:-unset}" > "$T/owns"
    ) > "$T/out" 2>&1
    RC=$?
}
calls()   { grep -cxF -- "$1" "$T/calls" | tr -d ' '; }
curls()   { grep -c '^curl ' "$T/calls" | tr -d ' '; }
svc()     { local e=off a=down; [ -e "$T/svc/enabled" ] && e=enabled; [ -e "$T/svc/active" ] && a=active; echo "$e+$a"; }
exists()  { [ -e "$1" ] && echo yes || echo no; }
owns()    { cat "$T/owns" 2>/dev/null || echo "none(rc=$RC)"; }
said()    { grep -qF -- "$1" "$T/out" && echo yes || echo no; }
escapes() { grep -c 'SANDBOX-ESCAPE\|UNEXPECTED' "$T/calls" | tr -d ' '; }

load_regions "$INSTALLER"
MARKER="$STATE_DIR/no-decky-panel"
if [ -n "$MARKER_LINE" ]; then MARKER="$(DECKY_PANEL_OFF=; eval "$MARKER_LINE"; echo "$DECKY_PANEL_OFF")"; fi

# ==================================================================================
echo "where the choice lives"
check "the marker is defined in install.sh" yes "$([ -n "$MARKER_LINE" ] && echo yes || echo no)"
case "$MARKER" in "$STATE_DIR"/*) r=STATE_DIR ;; "$ETC_DIR"/*) r=ETC_DIR ;; *) r=elsewhere ;; esac
check "...under STATE_DIR, not /etc/couchside (a SteamOS update dropped /etc/couchside, KI-088)" STATE_DIR "$r"
grep -q '^STATE_DIR="/var/lib/couchside"$' "$INSTALLER"
check "...and STATE_DIR is /var/lib/couchside" 0 $?
cli_path="$(awk '/^cat > "\$CLI" <<'"'"'CLIEOF'"'"'$/{f=1;next} /^CLIEOF$/{f=0} f' "$INSTALLER" \
    | grep -o '/var/lib/couchside/no-decky-panel' | head -1)"
check "couchside update reads the same marker path" /var/lib/couchside/no-decky-panel "$cli_path"

# ==================================================================================
echo
echo "panel removed in Decky's own plugin list (stamp present, panel gone), plain run"
fresh_box; build_release v1; with_decky; with_stamp; svc_running
run
check "installer run succeeds" 0 "$RC"
check "the removal is RECORDED (marker written)" yes "$(exists "$MARKER")"
check "the panel is NOT reinstalled" no "$(exists "$DECKY_PLUGIN_DIR")"
check "...not even downloaded" 0 "$(curls)"
check "Decky Loader is not restarted (other plugins untouched)" 0 "$(calls 'systemctl restart plugin_loader.service')"
check "NO dormant hand-off (couchside.service never disabled)" 0 "$(calls 'systemctl disable --now couchside.service')"
check "the service is restarted in place (loads the new agent)" 1 "$(calls 'systemctl restart couchside.service')"
check "couchside.service ends enabled + active" enabled+active "$(svc)"
check "the installer does not think a plugin owns the agent" 0 "$(owns)"
check "no h3 poll / exit-trap re-arm waiting on a plugin" 0 "$(calls 'systemctl is-active --quiet couchside.service')"
check "the output says it will not be reinstalled" yes "$(said 'will NOT be reinstalled')"
check "the output names the way back (--decky)" yes "$(said 'bash -s -- --decky')"
check "nothing outside the sandbox was touched" 0 "$(escapes)"

echo
echo "...the next plain run (couchside update / the app's update button, no flags)"
run
check "installer run succeeds" 0 "$RC"
check "still NOT reinstalled" no "$(exists "$DECKY_PLUGIN_DIR")"
check "no download, no Decky restart" "0/0" "$(curls)/$(calls 'systemctl restart plugin_loader.service')"
check "still no dormant hand-off" 0 "$(calls 'systemctl disable --now couchside.service')"
check "couchside.service ends enabled + active" enabled+active "$(svc)"
check "the marker survives" yes "$(exists "$MARKER")"
check "the output still names --decky" yes "$(said 'bash -s -- --decky')"

echo
echo "...and after /etc/couchside (and with it the stamp) is lost (KI-088)"
rm -f "$DECKY_STAMP"
run
check "the marker still wins over the ambiguous stamp-less state" no "$(exists "$DECKY_PLUGIN_DIR")"
check "still standalone, no hand-off" "0/enabled+active" "$(calls 'systemctl disable --now couchside.service')/$(svc)"

# ==================================================================================
echo
echo "--decky turns it back on"
run --decky
check "installer run succeeds" 0 "$RC"
check "the marker is removed" no "$(exists "$MARKER")"
check "the panel is installed again" yes "$(exists "$DECKY_PLUGIN_DIR/plugin.json")"
check "the stamp records the build installed" "$(release_hash)" "$(cat "$DECKY_STAMP" 2>/dev/null)"
check "Decky Loader restarted once to load it" 1 "$(calls 'systemctl restart plugin_loader.service')"
check "coexistence resumes (dormant hand-off to the plugin)" "1/1" "$(calls 'systemctl disable --now couchside.service')/$(owns)"
check "the plugin took the agent over: enabled + active" enabled+active "$(svc)"
check "the output confirms it" yes "$(said 'is ON for this box again')"
run
check "...and a later plain run keeps it on (no marker, KI-037: no needless restart)" \
    "no/0/1" "$(exists "$MARKER")/$(calls 'systemctl restart plugin_loader.service')/$(owns)"

echo
echo "--decky while the download fails does not flip back to 'removed' next run"
fresh_box; build_release v1; with_decky; with_stamp; svc_running
run                                   # owner removed it -> marker
check "setup: removal recorded" yes "$(exists "$MARKER")"
CURL_FAIL=1 run --decky
check "installer run still succeeds" 0 "$RC"
check "the marker is removed" no "$(exists "$MARKER")"
check "the stale stamp is dropped with it" no "$(exists "$DECKY_STAMP")"
check "the box is not left without an agent (h3 fallback)" enabled+active "$(svc)"
unset CURL_FAIL
run
check "next run with the network back: panel installed, NOT re-marked" \
    "yes/no" "$(exists "$DECKY_PLUGIN_DIR/plugin.json")/$(exists "$MARKER")"

# ==================================================================================
echo
echo "--no-decky is remembered"
fresh_box; build_release v1; with_decky; with_panel; with_stamp; svc_running
run --no-decky
check "installer run succeeds" 0 "$RC"
check "the choice is written" yes "$(exists "$MARKER")"
check "standalone: no dormant hand-off, enabled + active" "0/enabled+active" \
    "$(calls 'systemctl disable --now couchside.service')/$(svc)"
check "an existing panel is left alone (not deleted)" yes "$(exists "$DECKY_PLUGIN_DIR/plugin.json")"
check "...and not reinstalled or Decky restarted" "0/0" "$(curls)/$(calls 'systemctl restart plugin_loader.service')"
check "the output says the panel is still in Decky's list" yes "$(said "still in Decky's plugin list")"
run
check "a later plain run stays standalone" "0/0/enabled+active" \
    "$(calls 'systemctl disable --now couchside.service')/$(curls)/$(svc)"
check "the choice survives" yes "$(exists "$MARKER")"

echo
echo "--decky with --no-decky is refused"
fresh_box; build_release v1; with_decky; svc_running
run --decky --no-decky
check "exit 2" 2 "$RC"
check "nothing written, nothing run" "no/0" "$(exists "$MARKER")/$(grep -c . "$T/calls" | tr -d ' ')"

# ==================================================================================
# CONTROLS: never removed -> exactly today's behaviour. With a baseline installer
# as the second argument each of these is also replayed against it and must
# produce the identical call log + output.
replay() { # label -- rerun the snapshotted box against the baseline installer
    [ -n "$BASELINE" ] || return 0
    cp "$T/calls" "$T/calls.new"; cp "$T/out" "$T/out.new"
    # Subshell: the baseline's regions must not leak into later scenarios.
    (   load_regions "$BASELINE"
        rm -rf "${T:?}/home" "${T:?}/etc" "${T:?}/var" "${T:?}/svc"
        cp -R "$T/snap/home" "$T/snap/etc" "$T/snap/var" "$T/snap/svc" "$T/"
        run
        cmp -s "$T/calls" "$T/calls.new" && cmp -s "$T/out" "$T/out.new" ) \
        && r=identical || r=DIFFERENT
    check "$1: identical to the baseline installer" identical "$r"
}
snap() { rm -rf "$T/snap"; mkdir -p "$T/snap"; cp -R "$T/home" "$T/etc" "$T/var" "$T/svc" "$T/snap/"; }

echo
echo "CONTROL never removed, panel up to date"
fresh_box; build_release v1; with_decky; with_panel; with_stamp; svc_running; snap
run
check "installer run succeeds" 0 "$RC"
check "no marker" no "$(exists "$MARKER")"
check "dormant hand-off exactly as before" "1/1" "$(calls 'systemctl disable --now couchside.service')/$(owns)"
check "KI-037: panel current -> Decky NOT restarted" 0 "$(calls 'systemctl restart plugin_loader.service')"
check "says up to date" yes "$(said 'panel already up to date')"
check "the box ends with a running agent" enabled+active "$(svc)"
replay "up to date"

echo
echo "CONTROL fresh Decky box, panel never installed (no stamp, no panel)"
fresh_box; build_release v1; with_decky; svc_running; snap
run
check "the panel IS installed" yes "$(exists "$DECKY_PLUGIN_DIR/plugin.json")"
check "stamp written, no marker" "$(release_hash)/no" "$(cat "$DECKY_STAMP" 2>/dev/null)/$(exists "$MARKER")"
check "dormant hand-off to the new plugin" "1/1" "$(calls 'systemctl disable --now couchside.service')/$(owns)"
check "the box ends with a running agent" enabled+active "$(svc)"
replay "fresh"

echo
echo "CONTROL a new panel build is published"
fresh_box; build_release v1; with_decky; with_panel; with_stamp; svc_running
build_release v2; snap
run
check "the new build is installed" "$(release_hash)" "$(cat "$DECKY_STAMP" 2>/dev/null)"
check "Decky restarted once, no marker" "1/no" "$(calls 'systemctl restart plugin_loader.service')/$(exists "$MARKER")"
replay "new build"

echo
echo "CONTROL ambiguous: Decky installed, stamp AND panel both gone (/etc lost)"
fresh_box; build_release v1; with_decky; svc_running; snap
run
check "keeps today's behaviour: the panel is installed" yes "$(exists "$DECKY_PLUGIN_DIR/plugin.json")"
check "no marker" no "$(exists "$MARKER")"
replay "ambiguous"

echo
echo "CONTROL no Decky Loader at all"
fresh_box; build_release v1; svc_running; snap
run
check "standalone as before, nothing downloaded, no marker" "enabled+active/0/no" "$(svc)/$(curls)/$(exists "$MARKER")"
replay "no Decky"

echo
echo "CONTROL Decky Loader uninstalled, our stamp left behind, panel gone"
fresh_box; build_release v1; with_stamp; svc_running; snap
run
check "no marker: only a box WITH Decky can have had the panel removed through it" no "$(exists "$MARKER")"
check "standalone as before" "0/enabled+active" "$(calls 'systemctl disable --now couchside.service')/$(svc)"
replay "Decky uninstalled"

echo
echo "flags are documented"
grep -q -- '--decky           turn the panel back ON' "$INSTALLER"
check "--help documents --decky" 0 $?
grep -q -- '--no-decky        turn the Decky Loader Game Mode panel OFF for this box and' "$INSTALLER"
check "--help documents the persisted --no-decky" 0 $?
grep -q '^#   --decky ' "$INSTALLER" && grep -q '^#   --no-decky ' "$INSTALLER"
check "the header comment lists both" 0 $?

echo
echo "passed $passes, failed $fails"
[ "$fails" -eq 0 ] || { echo "FAILED: $fails"; exit 1; }
echo "all installer decky-panel checks passed"
