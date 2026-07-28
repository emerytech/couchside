#!/usr/bin/env bash
# Does install.sh make the right call about the Couchside Player add-on?
#
# Runs the REAL gate lines out of install.sh (extracted by marker, not retyped)
# against a throwaway HOME, so this tests the shipped code rather than a copy of
# it. Everything else in the installer — agent, service, root — is untouched.
#
# The policy under test is PRESERVE, never opt in silently:
#   absent  + cannot ask   -> stays absent   (an experimental add-on must not
#                             arrive on every piped `curl | bash`)
#   present + cannot ask   -> stays present  (an unattended update must not rip
#                             it off a box that chose it)
#   explicit 1 / 0         -> wins either way
set -u
INSTALLER="${1:?usage: test_installer_player.sh /path/to/install.sh}"
pass=0; fail=0
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s  <- %s\n' "$1" "$2"; fail=$((fail+1)); }

# The gate, lifted verbatim from the installer.
gate="$(awk '/^PLAYER_INSTALL_DIR=/,/^esac$/' "$INSTALLER")"
[ -n "$gate" ] || { echo "could not extract the gate from $INSTALLER"; exit 2; }

run_gate() {  # $1=home  $2=COUCHSIDE_PLAYER value ("" = unset/ask)  $3=tty?
    local home="$1" envval="$2" tty="$3"
    (
        HOME="$home"
        PLAYER_DEST_NAME="Couchside Player"
        ask_yn() { return 1; }            # if it ever asks here, treat as "no"
        # "" means unset (the ask path); anything else is the env override.
        if [ -n "$envval" ]; then export COUCHSIDE_PLAYER="$envval"; else unset COUCHSIDE_PLAYER; fi
        # The prompt writes to stdout, so send the gate's own output to stderr
        # or it lands in the captured value.
        if [ "$tty" = "no" ]; then
            # Simulate a piped install: nothing readable at /dev/tty.
            eval "$(printf '%s' "$gate" | sed 's#\[ -r /dev/tty \]#false#')" 1>&2
        else
            eval "$gate" 1>&2
        fi
        printf '%s' "${WANT_PLAYER:-unset}"
    )
}

tmp="$(mktemp -d)"
absent="$tmp/absent"; mkdir -p "$absent/.local/opt"
present="$tmp/present"; mkdir -p "$present/.local/opt/couchside-player"
: > "$present/.local/opt/couchside-player/Couchside Player"

r=$(run_gate "$absent" "" no)
[ "$r" = 0 ] && ok "absent + piped install -> NOT installed (no silent opt-in)" \
             || bad "absent + piped install" "WANT_PLAYER=$r"

r=$(run_gate "$present" "" no)
[ "$r" = 1 ] && ok "present + piped update -> kept (never silently dropped)" \
             || bad "present + piped update" "WANT_PLAYER=$r"

r=$(run_gate "$absent" 1 no)
[ "$r" = 1 ] && ok "COUCHSIDE_PLAYER=1 installs it on a fresh box" \
             || bad "explicit opt-in" "WANT_PLAYER=$r"

r=$(run_gate "$present" 0 no)
[ "$r" = 0 ] && ok "COUCHSIDE_PLAYER=0 removes it from a box that had it" \
             || bad "explicit opt-out" "WANT_PLAYER=$r"

r=$(run_gate "$absent" yes no)
[ "$r" = 1 ] && ok "the word forms (yes/no/true/false) are accepted too" \
             || bad "word form" "WANT_PLAYER=$r"

# Declining at the prompt must not install, even on a real terminal.
r=$(run_gate "$absent" "" yes)
[ "$r" = 0 ] && ok "answering no at the prompt leaves it uninstalled" \
             || bad "prompt declined" "WANT_PLAYER=$r"

rm -rf "$tmp"
echo
echo "passed $pass, failed $fail"
exit $(( fail > 0 ))
