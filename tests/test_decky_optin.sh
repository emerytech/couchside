#!/usr/bin/env bash
# Tests the Decky manager OPT-IN: `couchside allow-decky on|off|status` (the
# CLI heredoc in install.sh), the install-time offer in section (k), and the
# two (f1c) install-side gates (project_decky-manager.md §5, §13, §14).
#
# Run: bash tests/test_decky_optin.sh
#
# WHY THIS EXISTS. The opt-in is the consent for root work on the box: its
# `on` writes a sudoers grant and the marker file that the helper, the unit's
# ConditionPathExists= and the wrapper all check. The things that must hold:
#   * it refuses (writing nothing) when the (f1c) pieces are missing, when
#     there is no terminal to ask on, and when visudo rejects the file;
#   * it prints the MATERIAL FACT first — Decky Loader runs as root from your
#     home directory — and says "no checksum" in so many words;
#   * the grant is exactly two `systemctl start --no-block <unit>` lines and
#     the wrapper itself gets none;
#   * the install-time offer asks through ask_yn ONCE (a declined stamp
#     silences it), never when a controlling terminal cannot be OPENED — the
#     app-driven detached update must not "decline" on the owner's behalf.
#
# The CLI text is EXTRACTED from install.sh, eval'ed, and `confirm_tty` is
# then stubbed as a FUNCTION (the `sudo() { "$@"; }` precedent) — the shipped
# text is not rewritten. The no-tty case runs the REAL confirm_tty in a fresh
# session (start_new_session) so it cannot block on a developer's terminal.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SH="$ROOT/install.sh"
fails=0

check() { # name expected actual
    if [ "$2" = "$3" ]; then
        printf '  PASS  %s\n' "$1"
    else
        printf '  FAIL  %s (expected %s, got %s)\n' "$1" "$2" "$3"
        fails=$((fails + 1))
    fi
}

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
export T

# --- the shipped CLI text -----------------------------------------------------
awk '/^cat > "\$CLI" <<'"'"'CLIEOF'"'"'$/{f=1;next} /^CLIEOF$/{f=0} f' "$SH" > "$T/cli"
[ -s "$T/cli" ] || { echo "FAIL: CLI heredoc not found"; exit 1; }
DEFS="$(awk '/^confirm_tty\(\) \{/,/^\}/' "$T/cli")"
[ -n "$DEFS" ] || { echo "FAIL: confirm_tty() not found in the CLI"; exit 1; }
BLOCK="$(awk '/^  allow-decky\)$/,/^    ;;$/' "$T/cli")"
lines=$(printf '%s\n' "$BLOCK" | wc -l | tr -d ' ')
[ "$lines" -gt 20 ] && [ "$lines" -lt 120 ] || { echo "FAIL: allow-decky block not bounded ($lines lines)"; exit 1; }
# Repoint the five hardcoded paths at temp roots and PROVE each substitution took.
BLOCK="$(printf '%s\n' "$BLOCK" | sed \
    -e "s|DECKY_WRAP=\"/etc/couchside/couchside-decky-loader\"|DECKY_WRAP=\"$T/etc/couchside-decky-loader\"|" \
    -e "s|DECKY_UNIT_TMPL=\"/etc/systemd/system/couchside-decky-loader@.service\"|DECKY_UNIT_TMPL=\"$T/etc/couchside-decky-loader@.service\"|" \
    -e "s|DECKY_MARKER=\"/etc/couchside/allow-decky\"|DECKY_MARKER=\"$T/etc/allow-decky\"|" \
    -e "s|DECKY_DECLINED=\"/etc/couchside/decky-optin-declined\"|DECKY_DECLINED=\"$T/etc/decky-optin-declined\"|" \
    -e "s|DECKY_SUDOERS=\"/etc/sudoers.d/zz-couchside-decky\"|DECKY_SUDOERS=\"$T/etc/zz-couchside-decky\"|")"
n=$(printf '%s\n' "$BLOCK" | grep -c "=\"$T/etc/" | tr -d ' ')
[ "$n" -eq 5 ] || { echo "FAIL: expected 5 repointed paths, got $n (the CLI's path lines changed?)"; exit 1; }
RUNNER="allow_decky() { case \"\${1:-}\" in
$BLOCK
esac; }"
export DEFS RUNNER

# --- stubs on PATH (install: a normal user cannot chown to root) --------------
STUB="$T/stub"; mkdir -p "$STUB"
cat > "$STUB/install" <<'EOF'
#!/usr/bin/env bash
echo "install $*" >> "$T/calls"
mode=""; args=()
while [ $# -gt 0 ]; do
  case "$1" in -m) mode="$2"; shift ;; -o|-g) shift ;; -d) ;; *) args+=("$1") ;; esac
  shift
done
rm -f "${args[1]}"; cp "${args[0]}" "${args[1]}"; [ -n "$mode" ] && chmod "$mode" "${args[1]}"
exit 0
EOF
cat > "$STUB/visudo" <<'EOF'
#!/usr/bin/env bash
echo "visudo $*" >> "$T/calls"
exit "${STUB_VISUDO_RC:-0}"
EOF
chmod +x "$STUB"/*
export PATH="$STUB:$PATH"

# --- harness -------------------------------------------------------------------
# One subshell per invocation: `exit` inside the block ends the subshell, not
# this test, and each run gets its own stubs.
cli() { # <on|off|status|...>  -> RC, stdout+stderr in $T/out
    (
        eval "$DEFS"; eval "$RUNNER"
        sudo() { "$@"; }
        confirm_tty() { echo "confirm_tty $*" >> "$T/calls"; return "${STUB_CONFIRM:-1}"; }
        allow_decky allow-decky "$@"
    ) > "$T/out" 2>&1
    RC=$?
}
reset() {
    rm -rf "$T/etc"; mkdir -p "$T/etc"; : > "$T/calls"
    unset STUB_CONFIRM STUB_VISUDO_RC
}
ready() { # the (f1c) pieces are present
    printf '#!/bin/sh\n' > "$T/etc/couchside-decky-loader"; chmod +x "$T/etc/couchside-decky-loader"
    printf '[Unit]\n' > "$T/etc/couchside-decky-loader@.service"
}
calls() { grep -c -- "$1" "$T/calls" 2>/dev/null | tr -d ' '; }
exists() { [ -e "$1" ] && echo yes || echo no; }
RC=0

# ==============================================================================
echo "allow-decky on: refuses without the installer pieces"
reset; cli on
check "no wrapper, no template -> exit 1" 1 "$RC"
grep -q 're-run install.sh' "$T/out"; check "...says to re-run install.sh" 0 $?
check "...never asked" 0 "$(calls confirm_tty)"
check "...wrote no marker" no "$(exists "$T/etc/allow-decky")"
check "...wrote no sudoers" no "$(exists "$T/etc/zz-couchside-decky")"
reset; ready; rm -f "$T/etc/couchside-decky-loader@.service"; cli on
check "wrapper but no template -> exit 1" 1 "$RC"
reset; ready; chmod -x "$T/etc/couchside-decky-loader"; cli on
check "template but non-executable wrapper -> exit 1" 1 "$RC"

echo
echo "allow-decky on: the grant text, in the spec's order"
reset; ready; export STUB_CONFIRM=1; cli on
check "declined at the prompt -> exit 0" 0 "$RC"
grep -q 'Cancelled' "$T/out"; check "...says Cancelled" 0 $?
check "...wrote nothing" no "$(exists "$T/etc/allow-decky")"
grep -q 'Decky Loader runs as root from your home directory' "$T/out"; check "the material fact is printed" 0 $?
grep -qi 'no checksum' "$T/out"; check "says 'no checksum'" 0 $?
grep -q 'from your home directory' "$T/out"; check "says 'from your home directory'" 0 $?
grep -q 'AS ROOT' "$T/out"; check "says root-flagged plugins run as root" 0 $?
grep -q 'including a paired phone' "$T/out"; check "names the paired phone as a way to become root" 0 $?
grep -q "Decky's design, not something Couchside" "$T/out"; check "says it is Decky's design" 0 $?
first=$(grep -n 'Decky Loader runs as root from your home directory' "$T/out" | head -1 | cut -d: -f1)
grant=$(grep -n 'install, repair or remove Decky Loader' "$T/out" | head -1 | cut -d: -f1)
store=$(grep -n 'curated store' "$T/out" | head -1 | cut -d: -f1)
check "the material fact comes BEFORE what is granted" yes "$([ -n "$first" ] && [ -n "$grant" ] && [ "$first" -lt "$grant" ] && echo yes || echo no)"
check "the loader grant comes before the plugin grant" yes "$([ -n "$grant" ] && [ -n "$store" ] && [ "$grant" -lt "$store" ] && echo yes || echo no)"
grep -q 'couchside allow-decky off' "$T/out"; check "tells how to turn it off" 0 $?
check "the prompt went through confirm_tty" 1 "$(calls "^confirm_tty Enable? \[y/N\]$")"

echo
echo "allow-decky on: no terminal -> exit 1, nothing written (the REAL confirm_tty)"
reset; ready
cat > "$T/notty.sh" <<'EOF'
eval "$DEFS"; eval "$RUNNER"
sudo() { "$@"; }
allow_decky allow-decky on
EOF
python3 - "$T/notty.sh" > "$T/out" 2>&1 <<'PY'
import subprocess, sys
# A NEW SESSION with stdin closed: no controlling terminal exists, so the real
# confirm_tty's `read </dev/tty` must fail rather than default to yes — and
# this cannot block on the terminal of whoever runs the suite.
p = subprocess.run(["bash", sys.argv[1]], start_new_session=True,
                   stdin=subprocess.DEVNULL, capture_output=True, timeout=20)
sys.stdout.write(p.stdout.decode() + p.stderr.decode())
sys.exit(p.returncode)
PY
RC=$?
check "no tty -> exit 1" 1 "$RC"
grep -q 'No terminal for the prompt' "$T/out"; check "...explains why" 0 $?
check "...wrote no marker" no "$(exists "$T/etc/allow-decky")"
check "...wrote no sudoers" no "$(exists "$T/etc/zz-couchside-decky")"
check "...the grant text was still shown first" 0 "$(grep -q 'runs as root from your home directory' "$T/out"; echo $?)"

echo
echo "allow-decky on: accepted -> sudoers + marker written, declined stamp removed"
reset; ready; : > "$T/etc/decky-optin-declined"; export STUB_CONFIRM=0; cli on
check "exit 0" 0 "$RC"
grep -q 'Decky management from the app: on' "$T/out"; check "reports on" 0 $?
check "sudoers written" yes "$(exists "$T/etc/zz-couchside-decky")"
check "marker written" yes "$(exists "$T/etc/allow-decky")"
check "declined stamp removed" no "$(exists "$T/etc/decky-optin-declined")"
check "visudo validated the file first" 1 "$(calls '^visudo -cf ')"
check "sudoers installed 0440 root-owned" 1 "$(calls "^install -m 0440 -o root -g root .* $T/etc/zz-couchside-decky$")"
check "marker installed 0644 root-owned (the agent must be able to see it)" 1 "$(calls "^install -m 0644 -o root -g root .* $T/etc/allow-decky$")"
me="$(id -un)"
grants="$(grep -v '^#' "$T/etc/zz-couchside-decky" | grep -v '^$')"
check "exactly two grant lines" 2 "$(printf '%s\n' "$grants" | wc -l | tr -d ' ')"
printf '%s\n' "$grants" | grep -qx "$me ALL=(root) NOPASSWD: /usr/bin/systemctl start --no-block couchside-decky-loader@install.service"
check "grant 1 is the EXACT install-instance start" 0 $?
printf '%s\n' "$grants" | grep -qx "$me ALL=(root) NOPASSWD: /usr/bin/systemctl start --no-block couchside-decky-loader@uninstall.service"
check "grant 2 is the EXACT uninstall-instance start" 0 $?
grep -q 'couchside-decky-loader ' "$T/etc/zz-couchside-decky" && grep -v '^#' "$T/etc/zz-couchside-decky" | grep -q "$T/etc/couchside-decky-loader"
check "the wrapper itself gets NO grant" 1 $?
grep -q 'allow-decky off' "$T/etc/allow-decky"; check "the marker says how to remove it" 0 $?
# Order: validate, then install — a rejected file must never land.
v=$(grep -n '^visudo' "$T/calls" | head -1 | cut -d: -f1)
i=$(grep -n 'zz-couchside-decky' "$T/calls" | head -1 | cut -d: -f1)
check "visudo ran before the sudoers install" yes "$([ "$v" -lt "$i" ] && echo yes || echo no)"

echo
echo "allow-decky on: visudo rejecting the file -> nothing installed"
reset; ready; export STUB_CONFIRM=0 STUB_VISUDO_RC=1; cli on
check "exit 1" 1 "$RC"
grep -q 'sudoers validation failed' "$T/out"; check "...says so" 0 $?
check "no sudoers" no "$(exists "$T/etc/zz-couchside-decky")"
check "no marker either (the two land together or not at all)" no "$(exists "$T/etc/allow-decky")"

echo
echo "allow-decky off / status"
reset; ready; export STUB_CONFIRM=0; cli on
cli status
check "status after on" 0 "$(grep -q 'Decky management from the app: on' "$T/out"; echo $?)"
cli off
check "off exits 0" 0 "$RC"
check "off removes the sudoers" no "$(exists "$T/etc/zz-couchside-decky")"
check "off removes the marker" no "$(exists "$T/etc/allow-decky")"
grep -q 'Decky management from the app: off' "$T/out"; check "off reports off" 0 $?
cli status
grep -q 'Decky management from the app: off' "$T/out"; check "status after off" 0 $?
cli ""
grep -q 'Decky management from the app: off' "$T/out"; check "bare 'allow-decky' is status" 0 $?
cli off; check "off twice is still success" 0 "$RC"
reset; cli status
grep -q 'not installed' "$T/out"; check "status without the pieces says the manager is not installed" 0 $?
reset; cli sideways
check "unknown sub-command -> exit 2" 2 "$RC"
grep -q 'usage: couchside allow-decky on|off|status' "$T/out"; check "...with usage" 0 $?

# ==============================================================================
echo
echo "install-time offer (section k): asks through ask_yn, once, only a person"
OFFER="$(awk '/^decky_steam_root_present\(\) \{/,/^\}/' "$SH")
$(awk '/^decky_have_tty\(\) \{/,/^\}/' "$SH")
$(awk '/^offer_decky_optin\(\) \{/,/^\}/' "$SH")"
printf '%s\n' "$OFFER" | grep -q '^offer_decky_optin() {' || { echo "FAIL: offer_decky_optin() not found in install.sh"; exit 1; }
export OFFER
offer() { # env knobs: STUB_ASK (0=y,1=n) STUB_TTY (0=tty,1=none)
    (
        eval "$OFFER"
        say() { echo "==> $*"; }; note() { echo "    $*"; }
        sudo() { "$@"; }
        ask_yn() { echo "ask_yn $1" >> "$T/calls"; return "${STUB_ASK:-1}"; }
        decky_have_tty() { return "${STUB_TTY:-0}"; }
        DECKY_WRAP="$T/etc/couchside-decky-loader"
        DECKY_UNIT_TMPL="$T/etc/couchside-decky-loader@.service"
        DECKY_MARKER="$T/etc/allow-decky"
        DECKY_DECLINED="$T/etc/decky-optin-declined"
        CLI="$T/fakecli"
        HOME="$T/home"
        offer_decky_optin
    ) > "$T/out" 2>&1
    RC=$?
}
oreset() {
    reset; rm -rf "$T/home"; mkdir -p "$T/home/.steam/steam/steamapps"
    unset STUB_ASK STUB_TTY
    printf '#!/usr/bin/env bash\necho "fakecli $*" >> "$T/calls"\nexit 0\n' > "$T/fakecli"; chmod +x "$T/fakecli"
}
Q='Let the app install and manage Decky Loader and its plugins?'

oreset; ready; export STUB_ASK=1; offer
check "all gates open, answered n -> exit 0" 0 "$RC"
check "asked exactly once, through ask_yn, with the spec's question" 1 "$(calls "^ask_yn $Q$")"
check "n writes the declined stamp" yes "$(exists "$T/etc/decky-optin-declined")"
check "...root-owned 0644" 1 "$(calls "^install -m 0644 -o root -g root .* $T/etc/decky-optin-declined$")"
check "n does not run the CLI" 0 "$(calls '^fakecli')"
check "n writes no marker" no "$(exists "$T/etc/allow-decky")"
grep -q 'couchside allow-decky on' "$T/out"; check "n tells how to enable later" 0 $?

oreset; ready; export STUB_ASK=0; offer
check "answered y -> exit 0" 0 "$RC"
check "y hands off to 'couchside allow-decky on' (the grant text lives there)" 1 "$(calls '^fakecli allow-decky on$')"
check "y writes no stamp" no "$(exists "$T/etc/decky-optin-declined")"
printf '#!/usr/bin/env bash\nexit 1\n' > "$T/fakecli"
oreset; ready; export STUB_ASK=0; printf '#!/usr/bin/env bash\nexit 1\n' > "$T/fakecli"; offer
check "y but the CLI declines/fails -> the installer still exits 0" 0 "$RC"
grep -q 'not enabled' "$T/out"; check "...and says it was not enabled" 0 $?

oreset; ready; : > "$T/etc/allow-decky"; export STUB_ASK=1; offer
check "marker present -> not asked" 0 "$(calls '^ask_yn')"
check "...no stamp written" no "$(exists "$T/etc/decky-optin-declined")"
oreset; ready; : > "$T/etc/decky-optin-declined"; export STUB_ASK=1; offer
check "declined stamp present -> not asked again" 0 "$(calls '^ask_yn')"
oreset; ready; rm -rf "$T/home/.steam"; export STUB_ASK=1; offer
check "no Steam root -> not asked" 0 "$(calls '^ask_yn')"
check "...no stamp written" no "$(exists "$T/etc/decky-optin-declined")"
oreset; export STUB_ASK=1; offer
check "installer pieces missing (f1c skipped) -> not asked" 0 "$(calls '^ask_yn')"
# THE DETACHED-UPDATE TRAP: no controlling terminal must mean no offer AND no
# stamp — otherwise the app-driven update would silently decline for the owner.
oreset; ready; export STUB_ASK=1 STUB_TTY=1; offer
check "no controlling terminal -> not asked" 0 "$(calls '^ask_yn')"
check "...and NO declined stamp (the detached update must not decline for the owner)" no "$(exists "$T/etc/decky-optin-declined")"
check "...exit 0 either way" 0 "$RC"

echo
echo "the offer's gates, in isolation"
( eval "$OFFER"; HOME="$T/home"; mkdir -p "$T/home/.local/share/Steam/steamapps"; rm -rf "$T/home/.steam"; decky_steam_root_present )
check "steam root via ~/.local/share/Steam" 0 $?
( eval "$OFFER"; HOME="$T/home"; mkdir -p "$T/home/.var/app/com.valvesoftware.Steam/data/Steam/steamapps"; rm -rf "$T/home/.steam" "$T/home/.local"; decky_steam_root_present )
check "steam root via the flatpak Steam" 0 $?
( eval "$OFFER"; HOME="$T/home"; rm -rf "$T/home"; mkdir -p "$T/home/.steam/steam"; decky_steam_root_present )
check "a Steam dir WITHOUT steamapps does not count (control: the agent's rule)" 1 $?
( eval "$OFFER"; HOME="$T/home"; rm -rf "$T/home"; mkdir -p "$T/home"; decky_steam_root_present )
check "no Steam at all" 1 $?
python3 - <<'PY' > "$T/out" 2>&1
import os, subprocess, sys
script = os.environ["OFFER"] + "\ndecky_have_tty\n"
p = subprocess.run(["bash", "-c", script], start_new_session=True,
                   stdin=subprocess.DEVNULL, capture_output=True, timeout=20)
sys.exit(p.returncode)
PY
check "decky_have_tty is false in a session with no controlling terminal (real function)" 1 $?
grep -q '{ true </dev/tty; } 2>/dev/null' "$SH"; check "...and it OPENS /dev/tty rather than testing -r (0666 node, always readable)" 0 $?

# ==============================================================================
echo
echo "(f1c) old-helper refusal: no wrapper for a helper that cannot start it"
OLD="$(awk '/^decky_helper_too_old\(\) \{/,/^\}/' "$SH")"
printf '%s\n' "$OLD" | grep -q '^decky_helper_too_old() {' || { echo "FAIL: decky_helper_too_old() not found"; exit 1; }
export OLD
too_old() { # $1 = installed helper VERSION ("none"/"absent"); $2 = VERSION of a helper fetched THIS run into WORK_DIR (empty = none fetched)
    (
        eval "$OLD"
        sudo() { "$@"; }
        WORK_DIR="$T/work"; rm -rf "$WORK_DIR"; mkdir -p "$WORK_DIR"
        # A fetched helper is judged by ITS OWN VERSION line (the whole point of
        # the 2026-09-06 fix): seed a real one, not an empty file — an empty file
        # reads as unreadable and correctly degrades to "too old".
        [ -n "${2:-}" ] && printf '#!/usr/bin/env python3\nimport os\nVERSION = "%s"\n' "$2" > "$WORK_DIR/couchside-helper.py"
        DECKY_HELPER_CANDIDATES="$T/nowhere/couchside-helper.py $T/helper.py"
        rm -f "$T/helper.py"
        case "$1" in
            absent) ;;
            none) printf '#!/usr/bin/env python3\nimport os\n' > "$T/helper.py" ;;
            *) printf '#!/usr/bin/env python3\nimport os\nVERSION = "%s"\n' "$1" > "$T/helper.py" ;;
        esac
        DECKY_OLD_HELPER=""
        decky_helper_too_old; rc=$?
        echo "$DECKY_OLD_HELPER"
        exit $rc
    ) > "$T/out" 2>&1
    RC=$?
}
too_old 1.0.0;   check "helper 1.0.0 installed, none fetched -> refuse" 0 "$RC"
grep -q 'VERSION 1.0.0' "$T/out"; check "...and the reason names the version" 0 $?
too_old 1.0.9;   check "helper 1.0.9 -> refuse" 0 "$RC"
too_old none;    check "helper with no VERSION line -> refuse (degrade closed)" 0 "$RC"
grep -q 'unreadable' "$T/out"; check "...reported as unreadable" 0 $?
too_old 1.1.0;   check "helper 1.1.0 -> proceed (control)" 1 "$RC"
too_old 1.2.3;   check "helper 1.2.3 -> proceed" 1 "$RC"
too_old 2.0.0;   check "helper 2.0.0 -> proceed" 1 "$RC"
too_old absent;  check "no helper installed at all -> proceed (sudo path box)" 1 "$RC"
too_old 1.0.0 1.1.0; check "old helper but a NEW 1.1.0 landing THIS run -> proceed" 1 "$RC"
too_old 1.1.0 1.0.0; check "new helper installed but a stale 1.0.0 landing THIS run -> refuse (fetched wins)" 0 "$RC"
too_old absent 1.0.0; check "no installed helper, a 1.0.0 landing THIS run -> refuse" 0 "$RC"

echo
if [ "$fails" -ne 0 ]; then
    echo "FAILED: $fails check(s)"
    exit 1
fi
echo "all decky-optin tests passed"
