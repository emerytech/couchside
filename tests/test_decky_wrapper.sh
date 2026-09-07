#!/usr/bin/env bash
# Tests the Decky Loader ROOT WRAPPER that install.sh section (f1c) ships as
# /etc/couchside/couchside-decky-loader (project_decky-manager.md §4.1, §14).
#
# Run: bash tests/test_decky_wrapper.sh
#
# WHY THIS EXISTS. This is the only NEW root logic in the Decky manager: a
# fixed install|uninstall procedure that PID 1 runs as root on the phone's
# behalf, writing under the desktop user's home. Every hardening in it exists
# because the alternative is a root script the desktop user can steer:
#   * the target user/home are BAKED, so SUDO_USER/HOME in the environment
#     mean nothing (upstream's installer resolves `/homebrew` without them);
#   * root never follows a symlink under $HOME (exit 6) and never chowns
#     anything there — user-tree writes go through runuser AS THE USER, and
#     the root-owned services/ dir is written only with install(1);
#   * every curl is bounded and https-pinned; the tag comes from one
#     un-followed redirect hop with a real API fallback (a curl FAILURE, not
#     only a mis-shape, reaches it); the download is size+ELF checked BEFORE
#     the box is touched;
#   * services/ is MOVED ASIDE (into the root-only $TMP, never a predictable
#     name under the user tree), not deleted, and the EXIT trap rolls back and
#     re-enables the old loader on any later failure;
#   * the ownership check of ~/homebrew is NOT the invariant — the minutes-long
#     download sits between it and the writes — so the wrapper `cd -P`s into
#     the real inode, re-checks what it is inside, and writes RELATIVE paths:
#     a rename+symlink of ~/homebrew after the check cannot redirect root
#     (the TOCTOU case below swaps it DURING the download and asserts nothing
#     root-made lands under the target);
#   * "came up" means NRestarts==0 AND /auth/token answering — Restart=always
#     makes is-active TRUE between crashes;
#   * the flock has a bounded wait, `refused` is recorded under the lock, and
#     no quote can reach the result JSON.
#
# The heredoc is EXTRACTED from install.sh (the test_decky_restart_guard.sh
# technique) so this exercises the shipped text, never a retyped copy. Every
# external tool the wrapper calls is a stub on PATH that RECORDS its argv, so
# each refusal asserts "and nothing was fetched / nothing under $H was
# touched" rather than only the exit code (CLAUDE.md §6). Controls: the happy
# path must actually install, the curl stub must actually flag a bad argv,
# and the bake-safety check must accept an ordinary home.
#
# Portable to the bash 3.2 a Mac ships (no mapfile, no assoc arrays); the
# kernel-flock contention case runs only where a real flock(1) exists.
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

# --- the shipped text -------------------------------------------------------
awk '/<<'"'"'DECKYWRAP'"'"'$/{f=1;next} /^DECKYWRAP$/{f=0} f' "$SH" > "$T/wrap.tmpl"
[ -s "$T/wrap.tmpl" ] || { echo "FAIL: DECKYWRAP heredoc not found in install.sh"; exit 1; }
bash -n "$T/wrap.tmpl" || { echo "FAIL: the wrapper heredoc does not parse"; exit 1; }
eval "$(awk '/^decky_bake_safe\(\) \{/,/^\}/' "$SH")"
type decky_bake_safe >/dev/null 2>&1 || { echo "FAIL: decky_bake_safe() not found in install.sh"; exit 1; }
# The embedded unit fixture, for the rendered-unit comparison below.
awk '/<<'"'"'U'"'"'$/{f=1;next} /^U$/{f=0} f' "$T/wrap.tmpl" > "$T/unit.fixture"
[ -s "$T/unit.fixture" ] || { echo "FAIL: embedded unit fixture not found in the wrapper"; exit 1; }

# --- stubs ------------------------------------------------------------------
STUB="$T/stub"; mkdir -p "$STUB"
export CALLS="$T/calls" STUB_VIOLATIONS="$T/violations"
export TMPDIR="$T/tmp"; mkdir -p "$TMPDIR"     # the wrapper's mktemp -d lands here, so "TMP cleaned" is checkable

stub() { # name, then the body on stdin
    { echo '#!/usr/bin/env bash'; cat; } > "$STUB/$1"
    chmod +x "$STUB/$1"
}
stub id <<'EOF'
echo "id $*" >> "$CALLS"
case "$*" in
  -u) echo 0 ;;                        # the wrapper's own "am I root" check
  "-u "*) echo "${STUB_UID:-1000}" ;;   # id -u <baked user>
  "-gn "*) echo deckgrp ;;
  *) echo 0 ;;
esac
EOF
stub stat <<'EOF'
echo "stat $*" >> "$CALLS"
# `stat -c %u <path>`: STUB_STAT_UID overrides; otherwise anything that
# resolves under $STUB_ROOT_OWNED reads as root's (the TOCTOU target), and
# everything else as the baked user's (1000).
if [ -n "${STUB_STAT_UID:-}" ]; then echo "$STUB_STAT_UID"; exit 0; fi
p="${!#}"
r="$(cd "$p" 2>/dev/null && pwd -P || echo "$p")"
case "$r" in "${STUB_ROOT_OWNED:-/nonexistent}"*) echo 0 ;; *) echo 1000 ;; esac
EOF
# mkdir is recorded (the root-owned services/ dirs must be made WITHOUT -p) and
# delegated to the real one.
stub mkdir <<'EOF'
echo "mkdir $*" >> "$CALLS"
exec /bin/mkdir "$@"
EOF
# mktemp is the last OS-divergent tool: GNU `mktemp -d` honours $TMPDIR (so the
# wrapper's temp lands under $T/tmp, which the path assertions below depend on),
# but macOS BSD `mktemp -d` IGNORES $TMPDIR and uses /var/folders — which broke
# every "aside copy under $T/tmp" check on the Mac while passing on Linux CI.
# Stub it (like every other external tool here) so the temp dir is deterministic
# and under $TMPDIR on both OSes; the wrapper's own `mktemp -d` is unchanged.
stub mktemp <<'EOF'
echo "mktemp $*" >> "$CALLS"
d="${TMPDIR:-/tmp}/wrap.$$.$RANDOM"; /bin/mkdir -p "$d"; echo "$d"
EOF
# mv -T is GNU-only; the Mac's BSD mv lacks it. Delegate to the real GNU mv
# where it exists (Linux CI), else emulate the one semantic the wrapper leans
# on: -T refuses an EXISTING destination instead of nesting into it.
stub mv <<'EOF'
echo "mv $*" >> "$CALLS"
if [ "${1:-}" = -T ]; then
  shift; src="$1"; dst="$2"
  if /bin/mv --version >/dev/null 2>&1; then exec /bin/mv -T "$src" "$dst"; fi
  if [ -e "$dst" ] || [ -L "$dst" ]; then echo "mv: cannot move '$src' to '$dst': destination exists" >&2; exit 1; fi
  exec /bin/mv "$src" "$dst"
fi
exec /bin/mv "$@"
EOF
stub flock <<'EOF'
echo "flock $*" >> "$CALLS"
[ -n "${STUB_FLOCK_BUSY:-}" ] && [ -e "$STUB_FLOCK_BUSY" ] && exit 1
exit 0
EOF
stub runuser <<'EOF'
echo "runuser $*" >> "$CALLS"
shift 2                                 # -u <user>
[ "${1:-}" = "--" ] && shift
exec "$@"
EOF
stub systemctl <<'EOF'
echo "systemctl $*" >> "$CALLS"
case "$*" in
  "show -p NRestarts --value plugin_loader") echo "${STUB_NRESTARTS:-0}" ;;
esac
exit 0
EOF
stub getenforce <<'EOF'
echo "getenforce $*" >> "$CALLS"
echo "${STUB_ENFORCE:-Permissive}"
EOF
stub chcon <<'EOF'
echo "chcon $*" >> "$CALLS"
exit 0
EOF
stub chown <<'EOF'
echo "chown $*" >> "$CALLS"
exit 0
EOF
stub journalctl <<'EOF'
echo "journalctl $*" >> "$CALLS"
echo "-- journal tail (stub) --"
EOF
stub sleep <<'EOF'
exit 0
EOF
stub install <<'EOF'
echo "install $*" >> "$CALLS"
mode=""; dir=0; args=()
while [ $# -gt 0 ]; do
  case "$1" in
    -d) dir=1 ;;
    -m) mode="$2"; shift ;;
    -o|-g) shift ;;                    # ownership is RECORDED above; a test user cannot chown
    *) args+=("$1") ;;
  esac
  shift
done
if [ "$dir" = 1 ]; then
  for d in "${args[@]}"; do mkdir -p "$d"; [ -n "$mode" ] && chmod "$mode" "$d"; done
  exit 0
fi
src="${args[0]}"; dst="${args[1]}"
if [ -n "${STUB_INSTALL_FAIL:-}" ] && [[ "$dst" == *"$STUB_INSTALL_FAIL"* ]]; then
  echo "install: simulated failure writing $dst" >&2; exit 1
fi
rm -f "$dst"; cp "$src" "$dst"; [ -n "$mode" ] && chmod "$mode" "$dst"
exit 0
EOF
stub curl <<'EOF'
echo "curl $*" >> "$CALLS"
all=" $* "
url=""; out=""; want_redirect=0
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
    -w) case "$2" in *redirect_url*) want_redirect=1 ;; esac; shift ;;
    -A|-H|--connect-timeout|--max-time|--retry|--proto|--proto-redir|--max-filesize) shift ;;
    -*) ;;
    *) url="$1" ;;
  esac
  shift
done
# THE FLAG PINS: every call is time-bounded; every call that leaves the box is
# https-only both ways and connect-bounded. (The loopback liveness probe is
# plain http by nature — 127.0.0.1:1337 is Decky's own API.)
case "$all" in *" --max-time "*) ;; *) echo "missing --max-time: $all" >> "$STUB_VIOLATIONS" ;; esac
case "$url" in
  http://127.0.0.1:1337/*) ;;
  *)
    case "$all" in *" --proto =https "*) ;; *) echo "missing --proto =https: $all" >> "$STUB_VIOLATIONS" ;; esac
    case "$all" in *" --proto-redir =https "*) ;; *) echo "missing --proto-redir =https: $all" >> "$STUB_VIOLATIONS" ;; esac
    case "$all" in *" --connect-timeout "*) ;; *) echo "missing --connect-timeout: $all" >> "$STUB_VIOLATIONS" ;; esac
    ;;
esac
case "$url" in
  https://github.com/SteamDeckHomebrew/decky-loader/releases/latest/download/PluginLoader)
    [ "${STUB_HOP_RC:-0}" = 0 ] || exit "$STUB_HOP_RC"
    [ "$want_redirect" = 1 ] && printf '%s' "${STUB_REDIRECT-https://github.com/SteamDeckHomebrew/decky-loader/releases/download/v3.2.8/PluginLoader}"
    exit 0 ;;
  https://api.github.com/repos/SteamDeckHomebrew/decky-loader/releases/latest)
    [ "${STUB_API_RC:-0}" = 0 ] || exit "$STUB_API_RC"
    cat "$STUB_API_JSON"; exit 0 ;;
  https://github.com/SteamDeckHomebrew/decky-loader/releases/download/*/PluginLoader)
    [ "${STUB_DL_RC:-0}" = 0 ] || exit "$STUB_DL_RC"
    # The TOCTOU hook: something a desktop-user process does WHILE root is
    # busy with the 27 MB download (after the ownership check, before the writes).
    [ -n "${STUB_DL_HOOK:-}" ] && bash "$STUB_DL_HOOK"
    cp "$STUB_BINARY" "$out"; exit 0 ;;
  https://raw.githubusercontent.com/SteamDeckHomebrew/decky-loader/*/dist/plugin_loader-release.service)
    [ -n "${STUB_UNIT_SRC:-}" ] || exit 22
    cp "$STUB_UNIT_SRC" "$out"; exit 0 ;;
  http://127.0.0.1:1337/auth/token)
    exit "${STUB_TOKEN_RC:-0}" ;;
  *) echo "unexpected url: $url" >> "$STUB_VIOLATIONS"; exit 7 ;;
esac
EOF
export PATH="$STUB:$PATH"

# --- fixtures ---------------------------------------------------------------
python3 - "$T" <<'PY'
import os, sys
t = sys.argv[1]
open(os.path.join(t, "elf.bin"), "wb").write(b"\x7fELF" + b"\0" * 4999996)      # exactly 5,000,000 bytes
open(os.path.join(t, "small.bin"), "wb").write(b"\x7fELF" + b"\0" * 1000)
open(os.path.join(t, "notelf.bin"), "wb").write(b"<!DOCTYPE html>" + b"\0" * 5000000)
# A decoy asset FIRST, so the fallback has to pick PluginLoader by name.
open(os.path.join(t, "api.json"), "w").write(
    '{"tag_name":"v3.2.8","assets":[{"name":"SHA256SUMS","browser_download_url":"https://github.com/x/SHA256SUMS"},'
    '{"name":"PluginLoader","browser_download_url":"https://github.com/SteamDeckHomebrew/decky-loader/releases/download/v3.2.8/PluginLoader"}]}')
open(os.path.join(t, "api-evil.json"), "w").write(
    '{"tag_name":"v9","assets":[{"name":"PluginLoader","browser_download_url":"https://evil.example/decky-loader/releases/download/v9/PluginLoader"}]}')
PY
export STUB_BINARY="$T/elf.bin" STUB_API_JSON="$T/api.json"

# --- harness ----------------------------------------------------------------
U=deck
bake() { # $1 = home -> $T/wrap, baked + repointed to temp roots
    python3 - "$T/wrap.tmpl" "$T/wrap" "$U" "$1" "$T" <<'PY'
import sys
src, dst, u, h, t = sys.argv[1:6]
s = open(src).read()
# Python replace (not sed) on purpose: a home containing `&` must survive so
# the rendered-unit case below can exercise the wrapper's own str.replace.
for old, new in (
        ('U="__USER__"; H="__HOME__"', 'U="%s"; H="%s"' % (u, h)),
        ('UNIT=/etc/systemd/system/plugin_loader.service', 'UNIT=%s/etc/plugin_loader.service' % t),
        ('MARK=/etc/couchside/allow-decky', 'MARK=%s/etc/allow-decky' % t),
        ('RUN=/run/couchside', 'RUN=%s/run' % t)):
    assert s.count(old) == 1, old
    s = s.replace(old, new)
open(dst, "w").write(s)
PY
    chmod +x "$T/wrap"
}
reset() { # fresh box: home, etc, run; every knob back to default
    rm -rf "$T/home" "$T/etc" "$T/run" "$T/elsewhere" "$T/target" "$T/tmp"
    mkdir -p "$T/home" "$T/etc" "$T/tmp"
    : > "$CALLS"; : > "$STUB_VIOLATIONS"
    unset STUB_HOP_RC STUB_API_RC STUB_DL_RC STUB_TOKEN_RC STUB_NRESTARTS STUB_INSTALL_FAIL \
          STUB_FLOCK_BUSY STUB_REDIRECT STUB_UNIT_SRC STUB_ENFORCE STUB_STAT_UID STUB_UID \
          STUB_DL_HOOK
    export STUB_ROOT_OWNED="$T/target"
    H="$T/home"; HB="$H/homebrew"
    bake "$H"
}
optin() { printf 'ok\n' > "$T/etc/allow-decky"; }
RC=0
run() { # mode... -> RC, output in $T/out
    "$T/wrap" "$@" > "$T/out" 2>&1; RC=$?
}
result() { # field -> value from the result JSON (empty if none / unparsable)
    python3 -c 'import json,sys
try:
    d = json.load(open(sys.argv[1]))
    v = d[sys.argv[2]]
    print("true" if v is True else "false" if v is False else v)
except Exception:
    print("")' "$T/run/decky-loader.result" "$1" 2>/dev/null
}
json_ok=0; json_bad=0
audit_result() { # every result file written during the suite must parse as JSON with a pinned tag shape
    [ -f "$T/run/decky-loader.result" ] || return 0
    if python3 -c 'import json,re,sys
d = json.load(open(sys.argv[1]))
assert set(d) == {"mode","state","ok","tag","at"}, d
assert d["mode"] in ("install","uninstall") and isinstance(d["ok"], bool) and isinstance(d["at"], int)
assert d["state"] in ("running","done","failed","refused")
assert re.fullmatch(r"(v[0-9]+(\.[0-9]+){1,3})?", d["tag"]), d["tag"]' "$T/run/decky-loader.result" 2>/dev/null; then
        json_ok=$((json_ok + 1))
    else
        json_bad=$((json_bad + 1))
    fi
}
calls() { grep -c -- "$1" "$CALLS" 2>/dev/null | tr -d ' '; }
seed_old_loader() { # a previously installed loader + unit, to protect / roll back to
    mkdir -p "$HB/services" "$HB/plugins/SteamGridDB" "$HB/settings" "$T/etc"
    printf 'OLD LOADER\n' > "$HB/services/PluginLoader"
    printf 'old unit\n' > "$T/etc/plugin_loader.service"
}

# ============================================================================
echo "argument validation: before anything is fetched or written"
reset; optin
run bogus;         check "unknown mode -> exit 2" 2 "$RC"
run;               check "no argument -> exit 2" 2 "$RC"
run install extra; check "two arguments -> exit 2" 2 "$RC"
run "install;id";  check "an injected mode word -> exit 2" 2 "$RC"
check "...and curl was never called" 0 "$(calls '^curl')"
check "...and no result was written" no "$([ -f "$T/run/decky-loader.result" ] && echo yes || echo no)"

echo
echo "opt-in gate: the marker is checked under the lock, before any work"
reset
run install
check "marker absent -> exit 77" 77 "$RC"
check "result state is 'refused'" refused "$(result state)"
check "result ok is false" false "$(result ok)"
check "nothing fetched" 0 "$(calls '^curl')"
check "nothing under \$H created" no "$([ -e "$HB" ] && echo yes || echo no)"
grep -q 'couchside allow-decky on' "$T/out"; check "the refusal names the opt-in command" 0 $?
audit_result

echo
echo "the lock: a REAL holder wins and its result is left alone"
reset; optin
mkdir -p "$T/run"; printf '{"mode":"install","state":"running","ok":false,"tag":"","at":1}\n' > "$T/run/decky-loader.result"
: > "$T/busy"; export STUB_FLOCK_BUSY="$T/busy"
run install
check "lock held -> exit 75" 75 "$RC"
check "the holder's result file is untouched" '{"mode":"install","state":"running","ok":false,"tag":"","at":1}' "$(cat "$T/run/decky-loader.result")"
check "nothing fetched while busy" 0 "$(calls '^curl')"
unset STUB_FLOCK_BUSY
# CONTROL + the bounded-wait pin: with the lock free the same run proceeds, and
# the wait it asked for is finite (this is what lets the agent's LOCK_SH poll
# overlap the wrapper without failing it as "busy").
reset; optin; run install
check "lock free -> the same run proceeds (control)" 0 "$RC"
check "flock is asked for a BOUNDED wait on fd 9" 1 "$(calls '^flock -w 15 9$')"
if [ -x /usr/bin/flock ] && [ "$(uname -s)" = Linux ]; then
    # Kernel-flock version of the overlap: hold a SHARED lock (what the agent's
    # _decky_op_running() probe takes) while the wrapper starts. Stubs stay on
    # PATH except flock, which is the real one.
    reset; optin
    STUB2="$T/stub2"; mkdir -p "$STUB2"; cp "$STUB"/* "$STUB2"/; rm -f "$STUB2/flock"
    mkdir -p "$T/run"; : > "$T/run/decky-loader.lock"
    ( exec 8<"$T/run/decky-loader.lock"; /usr/bin/flock -s 8; /bin/sleep 1 ) &
    holder=$!
    /bin/sleep 0.2
    PATH="$STUB2:${PATH#$STUB:}" "$T/wrap" install > "$T/out" 2>&1; RC=$?
    wait "$holder" 2>/dev/null
    check "a transient LOCK_SH holder does not fail the op (real flock)" 0 "$RC"
else
    echo "  SKIP  real-flock overlap (no /usr/bin/flock here; runs on Linux CI)"
fi
audit_result

echo
echo "the baked user is the target; the environment is ignored"
reset; optin
SUDO_USER=evil HOME=/evil USER=evil "$T/wrap" install > "$T/out" 2>&1; RC=$?
check "install succeeds with a hostile environment" 0 "$RC"
check "every user-tree op names the BAKED user" "$(calls '^runuser')" "$(calls "^runuser -u $U -- ")"
check "the environment's user never appears in any spawned argv" 0 "$(calls 'evil')"
check "homebrew landed under the baked home" yes "$([ -f "$HB/services/PluginLoader" ] && echo yes || echo no)"
audit_result

echo
echo "symlink refusal (exit 6): root never follows a link under \$HOME"
reset; optin
mkdir -p "$T/elsewhere"; ln -s "$T/elsewhere" "$HB"
run install
check "symlinked ~/homebrew -> exit 6" 6 "$RC"
check "result state is 'failed'" failed "$(result state)"
check "the link's target got no services/" no "$([ -e "$T/elsewhere/services" ] && echo yes || echo no)"
check "no install(1) into services/" 0 "$(calls 'install .*services')"
audit_result
reset; optin
mkdir -p "$HB"; export STUB_STAT_UID=0
run install
check "~/homebrew owned by someone else -> exit 6" 6 "$RC"
check "...nothing fetched" 0 "$(calls '^curl')"
audit_result
reset; optin
seed_old_loader; rm -rf "$HB/services"; mkdir -p "$T/elsewhere"; ln -s "$T/elsewhere" "$HB/services"
run install
check "symlinked services/ -> exit 6" 6 "$RC"
check "the symlink is still a symlink (not moved, not replaced)" yes "$([ -L "$HB/services" ] && echo yes || echo no)"
check "the link's target is still empty" "" "$(ls -A "$T/elsewhere")"
audit_result
reset; optin
rm -rf "$H"; mkdir -p "$T/elsewhere"; ln -s "$T/elsewhere" "$H"
run install
check "symlinked home -> exit 6" 6 "$RC"
audit_result

echo
echo "Steam dirs: the CEF flag is written AS THE USER and a planted symlink is skipped"
reset; optin
mkdir -p "$T/target" "$H/.local/share/Steam" "$H/.steam"
ln -s "$T/target" "$H/.steam/steam"
run install
check "install succeeds" 0 "$RC"
check "the real Steam dir got the flag" yes "$([ -f "$H/.local/share/Steam/.cef-enable-remote-debugging" ] && echo yes || echo no)"
check "...written through runuser as the user" 1 "$(calls "^runuser -u $U -- touch $H/.local/share/Steam/.cef-enable-remote-debugging$")"
check "the symlinked ~/.steam/steam's TARGET was not touched" no "$([ -e "$T/target/.cef-enable-remote-debugging" ] && echo yes || echo no)"
check "user-tree dirs are made as the user (mkdir via runuser)" 1 "$(calls "^runuser -u $U -- mkdir -p $HB $HB/plugins $HB/settings$")"
check "no chown anywhere, ever" 0 "$(calls '^chown')"
audit_result

echo
echo "tag resolution: redirect hop first, API fallback on FAILURE or mis-shape"
reset; optin; run install
check "happy: the un-followed hop resolves the tag" 0 "$RC"
check "...tag recorded" v3.2.8 "$(result tag)"
check "...the API was not needed" 0 "$(calls 'api.github.com')"
audit_result
reset; optin; export STUB_HOP_RC=6
run install
check "curl FAILURE on the hop -> API fallback -> success" 0 "$RC"
check "...the API was consulted" 1 "$(calls 'api.github.com')"
check "...tag from the API's PluginLoader asset (not the decoy)" v3.2.8 "$(result tag)"
audit_result
reset; optin; export STUB_REDIRECT="https://evil.example/releases/download/v3.2.8/PluginLoader" STUB_API_RC=22
seed_old_loader
run install
check "off-host redirect + API down -> exit 4" 4 "$RC"
check "...result 'failed'" failed "$(result state)"
check "...old services/ intact" "OLD LOADER" "$(cat "$HB/services/PluginLoader")"
check "...nothing downloaded" 0 "$(calls 'releases/download/')"
audit_result
reset; optin; export STUB_REDIRECT="https://evil.example/PluginLoader" STUB_API_JSON="$T/api-evil.json"
seed_old_loader
run install
check "API answering an off-host asset url -> exit 4" 4 "$RC"
check "...nothing downloaded from it" 0 "$(calls 'evil.example')"
check "...old services/ intact" "OLD LOADER" "$(cat "$HB/services/PluginLoader")"
export STUB_API_JSON="$T/api.json"
audit_result
reset; optin; export STUB_REDIRECT="https://github.com/SteamDeckHomebrew/decky-loader/releases/download/v3.2.8/../../../evil/PluginLoader" STUB_API_RC=22
run install
check "a traversal-shaped redirect fails the shape pin" 4 "$RC"
audit_result

echo
echo "download verification happens BEFORE the box is touched"
reset; optin; seed_old_loader; export STUB_BINARY="$T/notelf.bin"
run install
check "non-ELF download -> exit 4" 4 "$RC"
check "...old loader intact" "OLD LOADER" "$(cat "$HB/services/PluginLoader")"
check "...plugin_loader was never disabled" 0 "$(calls 'systemctl disable')"
audit_result
reset; optin; seed_old_loader; export STUB_BINARY="$T/small.bin"
run install
check "under-5MB download -> exit 4" 4 "$RC"
check "...old loader intact" "OLD LOADER" "$(cat "$HB/services/PluginLoader")"
audit_result
reset; optin; seed_old_loader; export STUB_DL_RC=28
run install
check "download failure -> exit 4" 4 "$RC"
check "...old loader intact" "OLD LOADER" "$(cat "$HB/services/PluginLoader")"
export STUB_BINARY="$T/elf.bin"
audit_result

echo
echo "the rendered unit: Python str.replace, so a home with '&' renders verbatim"
reset; optin
H="$T/h&me"; HB="$H/homebrew"; mkdir -p "$H"; bake "$H"
run install
check "install succeeds into a home containing '&'" 0 "$RC"
python3 -c 'import sys; open(sys.argv[2],"w").write(open(sys.argv[1]).read().replace("${HOMEBREW_FOLDER}", sys.argv[3]))' \
    "$T/unit.fixture" "$T/unit.expected" "$HB"
check "services/.systemd copy == embedded fixture with HOMEBREW_FOLDER substituted" \
    "$(cat "$T/unit.expected")" "$(cat "$HB/services/.systemd/plugin_loader-release.service")"
check "the live unit is the same bytes" "$(cat "$T/unit.expected")" "$(cat "$T/etc/plugin_loader.service")"
grep -q "^ExecStart=$T/h&me/homebrew/services/PluginLoader$" "$T/etc/plugin_loader.service"
check "ExecStart carries the literal '&' path" 0 $?
grep -q '\${HOMEBREW_FOLDER}' "$T/etc/plugin_loader.service"; check "no unsubstituted placeholder remains" 1 $?
audit_result
# CONTROL: install.sh's bake would REFUSE that home (sed would mangle it), so
# the wrapper can never be shipped with such a value baked into U=/H=.
decky_bake_safe "$T/h&me";        check "install.sh bake refuses a home containing '&'" 1 $?
decky_bake_safe 'a|b';            check "...and '|'" 1 $?
decky_bake_safe 'a\b';            check "...and a backslash" 1 $?
decky_bake_safe '';               check "...and an empty value" 1 $?
decky_bake_safe 'deck';           check "...but accepts a plain user name (control)" 0 $?
decky_bake_safe '/var/home/bazzite'; check "...and an ordinary home path (control)" 0 $?
decky_bake_safe '/home/a.b_c-d';  check "...and dots/underscores/dashes" 0 $?

echo
echo "upstream unit: used only when its shape checks out, else the embedded copy"
reset; optin
printf '[Unit]\nDescription=upstream copy\n[Service]\nUser=root\nExecStart=${HOMEBREW_FOLDER}/services/PluginLoader\n' > "$T/upstream.unit"
export STUB_UNIT_SRC="$T/upstream.unit"
run install
check "install succeeds with an upstream unit" 0 "$RC"
grep -q '^Description=upstream copy$' "$T/etc/plugin_loader.service"; check "the well-shaped upstream unit was used" 0 $?
audit_result
reset; optin
printf '[Unit]\nDescription=tampered\n[Service]\nUser=deck\nExecStart=${HOMEBREW_FOLDER}/services/PluginLoader\n' > "$T/upstream.unit"
export STUB_UNIT_SRC="$T/upstream.unit"
run install
check "install still succeeds" 0 "$RC"
grep -q '^Description=tampered$' "$T/etc/plugin_loader.service"; check "a unit without User=root is NOT used" 1 $?
grep -q '^Description=SteamDeck Plugin Loader$' "$T/etc/plugin_loader.service"; check "...the embedded copy is" 0 $?
unset STUB_UNIT_SRC
audit_result

echo
echo "rollback: services/ is moved aside and comes back on any later failure"
reset; optin; seed_old_loader; export STUB_INSTALL_FAIL="services/PluginLoader"
run install
check "install(1) of the binary failing -> non-zero" no "$([ "$RC" -eq 0 ] && echo yes || echo no)"
check "...result 'failed'" failed "$(result state)"
check "...the OLD loader is back in place" "OLD LOADER" "$(cat "$HB/services/PluginLoader")"
check "...no services.prev.* left behind" "" "$(ls -d "$HB"/services.prev.* 2>/dev/null)"
check "...and plugin_loader was re-enabled" 1 "$(calls '^systemctl enable --now plugin_loader$')"
check "...journal tail appended to the log" 1 "$(calls '^journalctl -u plugin_loader -n 30 --no-pager$')"
grep -q 'rolled back to previous services/' "$T/run/decky-loader.log"; check "...the log says so" 0 $?
check "the aside copy was staged under the wrapper's root-only temp dir (never in the user tree)" 1 "$(calls "^mv -T ./services $T/tmp/.*/services.prev$")"
check "...and restored from there by rename (mv -T), never nested" 1 "$(calls "^mv -T $T/tmp/.*/services.prev ./services$")"
audit_result

echo
echo "the aside copy cannot be pre-created: a decoy services.prev.<pid> under ~/homebrew is never used"
# The wrapper runs with a KNOWN pid (exec in a subshell whose \$BASHPID we read
# first), so a desktop-user process that guessed the pid and planted the old
# name — as a symlink to a root-only tree, or as a directory carrying its own
# PluginLoader — is exactly what these two runs simulate.
reset; optin; seed_old_loader; mkdir -p "$T/target"
( pid=${BASHPID:-$$}; ln -s "$T/target" "$HB/services.prev.$pid"; exec "$T/wrap" install > "$T/out" 2>&1 ); RC=$?
check "symlink decoy: install succeeds" 0 "$RC"
check "...the symlink's target got nothing (root never moved services/ into it)" "" "$(ls -A "$T/target")"
check "...the new loader is in place" no "$([ "$(cat "$HB/services/PluginLoader")" = "OLD LOADER" ] && echo yes || echo no)"
check "...no mv ever named a services.prev under the user tree" 0 "$(calls "mv .*$HB/services.prev")"
audit_result
reset; optin; seed_old_loader; export STUB_INSTALL_FAIL="services/PluginLoader"
( pid=${BASHPID:-$$}; mkdir -p "$HB/services.prev.$pid"; printf 'EVIL\n' > "$HB/services.prev.$pid/PluginLoader"; exec "$T/wrap" install > "$T/out" 2>&1 ); RC=$?
check "directory decoy + a failing install: non-zero" no "$([ "$RC" -eq 0 ] && echo yes || echo no)"
check "...rollback restored the REAL previous loader, not the decoy's binary" "OLD LOADER" "$(cat "$HB/services/PluginLoader")"
check "...the decoy directory was neither used nor removed" EVIL "$(cat "$HB"/services.prev.*/PluginLoader)"
unset STUB_INSTALL_FAIL
audit_result

echo
echo "TOCTOU: ~/homebrew swapped for a symlink DURING the download -> exit 6, nothing root-made under the target"
# Passes the ownership check (real, user-owned), then — while root waits on
# curl — a user process renames it away and plants a symlink to a root-owned
# tree. rename+symlink needs only write on \$H, not on homebrew itself.
reset; optin; seed_old_loader; mkdir -p "$T/target"
cat > "$T/hook.sh" <<EOF
mv "$HB" "$HB.real"; ln -s "$T/target" "$HB"
EOF
export STUB_DL_HOOK="$T/hook.sh"
run install
check "swap after the check -> exit 6" 6 "$RC"
check "...result 'failed'" failed "$(result state)"
check "...no services/ under the swapped-in target" no "$([ -e "$T/target/services" ] && echo yes || echo no)"
check "...no root write (install/mkdir -m/chcon) ever named the target" 0 "$(grep -cE "^(install|mkdir -m|chcon) .*$T/target" "$CALLS" | tr -d ' ')"
check "...the real tree's old loader is intact" "OLD LOADER" "$(cat "$HB.real/services/PluginLoader")"
check "...and the download DID happen before the swap (the window is real, control)" 1 "$(calls 'releases/download/')"
unset STUB_DL_HOOK
audit_result
# CONTROL: the same hook that swaps to a USER-owned directory is followed
# (that is the user's own tree; no boundary is crossed) — the refusal above
# is about ownership of what root is inside, not about the swap itself.
reset; optin; seed_old_loader; mkdir -p "$T/elsewhere"
cat > "$T/hook.sh" <<EOF
mv "$HB" "$HB.real"; ln -s "$T/elsewhere" "$HB"
EOF
export STUB_DL_HOOK="$T/hook.sh"
run install
check "swap to a USER-owned dir -> refused all the same (the path is a symlink at pin time)" 6 "$RC"
unset STUB_DL_HOOK
audit_result

echo
echo "liveness: NRestarts==0 AND /auth/token answering — never is-active alone"
reset; optin; seed_old_loader; export STUB_TOKEN_RC=7
run install
check "unit up but /auth/token silent -> exit 5" 5 "$RC"
check "...result 'failed'" failed "$(result state)"
check "...rolled back to the old loader" "OLD LOADER" "$(cat "$HB/services/PluginLoader")"
audit_result
reset; optin; seed_old_loader; export STUB_NRESTARTS=3
run install
check "NRestarts=3 (crash-looping behind Restart=always) -> exit 5" 5 "$RC"
check "...rolled back" "OLD LOADER" "$(cat "$HB/services/PluginLoader")"
grep -q 'NRestarts=3' "$T/run/decky-loader.log"; check "...the log names the restart count" 0 $?
audit_result

echo
echo "happy path: everything verified, then installed, then proven live"
reset; optin; seed_old_loader; export STUB_ENFORCE=Enforcing
run install
check "exit 0" 0 "$RC"
check "result 'done'" done "$(result state)"
check "result ok true" true "$(result ok)"
check "result tag" v3.2.8 "$(result tag)"
check "result mode" install "$(result mode)"
check "the new loader is in place" no "$([ "$(cat "$HB/services/PluginLoader")" = "OLD LOADER" ] && echo yes || echo no)"
check ".loader.version records the tag" v3.2.8 "$(cat "$HB/services/.loader.version")"
check ".loader.version installed root-owned AND world-readable (0644)" 1 "$(calls "^install -m 0644 -o root -g root .*/loader.version ./services/.loader.version$")"
check "services/ made 0755 with mkdir WITHOUT -p (EEXIST on a planted entry, never followed), relative to the pinned cwd" 1 "$(calls "^mkdir -m 0755 ./services$")"
check "...and .systemd likewise" 1 "$(calls "^mkdir -m 0755 ./services/.systemd$")"
check "...services/ really is 0755" 0o755 "$(python3 -c 'import os,sys; print(oct(os.stat(sys.argv[1]).st_mode & 0o777))' "$HB/services")"
check "the binary installed 0755 root-owned, by a RELATIVE path" 1 "$(calls "^install -m 0755 -o root -g root .*/PluginLoader ./services/PluginLoader$")"
check "plugins/ survived (existing dir untouched)" yes "$([ -d "$HB/plugins/SteamGridDB" ] && echo yes || echo no)"
check "the moved-aside copy was cleaned up" "" "$(ls -d "$HB"/services.prev.* 2>/dev/null)"
check "the wrapper's temp dir was removed" "" "$(ls -A "$T/tmp")"
check "chcon applied under Enforcing" 1 "$(calls "^chcon -t bin_t ./services/PluginLoader$")"
check "plugin_loader enabled + started" 1 "$(calls '^systemctl enable --now plugin_loader$')"
check "the token probe was made" 1 "$(calls 'http://127.0.0.1:1337/auth/token')"
grep -q '^installed v3.2.8$' "$T/run/decky-loader.log"; check "the log ends with the tag" 0 $?
check "the run dir is created 0755 (the agent must read the log/result)" 1 "$(calls "^install -d -m 0755 $T/run$")"
check "the result file is 0644 (chmod before the atomic mv)" 0o644 \
    "$(python3 -c 'import os,sys; print(oct(os.stat(sys.argv[1]).st_mode & 0o777))' "$T/run/decky-loader.result")"
audit_result
reset; optin; run install
check "no chcon when not Enforcing (control)" 0 "$(calls '^chcon')"
audit_result

echo
echo "uninstall: mirrors upstream, keeps plugins/ and settings, no /tmp/plugin_loader"
reset; optin; seed_old_loader
mkdir -p "$H/.steam/steam"; : > "$H/.steam/steam/.cef-enable-remote-debugging"
run uninstall
check "exit 0" 0 "$RC"
check "result 'done'" done "$(result state)"
check "result mode" uninstall "$(result mode)"
check "services/ removed" no "$([ -e "$HB/services" ] && echo yes || echo no)"
check "the unit removed" no "$([ -e "$T/etc/plugin_loader.service" ] && echo yes || echo no)"
check "plugins/ kept" yes "$([ -d "$HB/plugins/SteamGridDB" ] && echo yes || echo no)"
check "settings/ kept" yes "$([ -d "$HB/settings" ] && echo yes || echo no)"
check "the CEF flag removed AS THE USER" 1 "$(calls "^runuser -u $U -- rm -f $H/.steam/steam/.cef-enable-remote-debugging$")"
check "...and it is gone" no "$([ -e "$H/.steam/steam/.cef-enable-remote-debugging" ] && echo yes || echo no)"
check "plugin_loader disabled" 1 "$(calls '^systemctl disable --now plugin_loader.service$')"
check "daemon-reload (which upstream forgets)" 1 "$(calls '^systemctl daemon-reload$')"
check "nothing fetched" 0 "$(calls '^curl')"
check "/tmp/plugin_loader never touched" 0 "$(calls '/tmp/plugin_loader')"
# (comments stripped: the wrapper's own comment NAMES the upstream line it omits)
sed 's/[[:space:]]#.*$//' "$T/wrap.tmpl" | grep -q 'rm -rf /tmp/plugin_loader'; check "...and no code line does it" 1 $?
audit_result
reset; optin; run uninstall
check "uninstall with nothing installed is still success" 0 "$RC"
audit_result

echo
echo "structural pins on the shipped text"
grep -q '^set -euo pipefail$' "$T/wrap.tmpl"; check "set -euo pipefail" 0 $?
grep -q 'SUDO_USER' "$T/wrap.tmpl"; check "never reads SUDO_USER" 1 $?
grep -qE '(^|[^_A-Za-z])HOME([^_A-Za-z]|$)' "$T/wrap.tmpl"; check "never reads \$HOME (only the baked H)" 1 $?
grep -q 'TAG="${BASH_REMATCH\[1\]}"' "$T/wrap.tmpl"; check "the tag comes from the regex capture, nowhere else" 0 $?
grep -q "^CURL=(curl -fsS --proto '=https' --proto-redir '=https' --connect-timeout 20 --max-time 300 --retry 2 " "$T/wrap.tmpl"
check "the bounded curl argv is exactly the pinned one" 0 $?
grep -q 'ConditionPathExists=/etc/couchside/allow-decky' "$SH"; check "the unit template gates on the same marker path" 0 $?
grep -q '^TimeoutStartSec=900$' "$SH"; check "the unit template bounds a hung run (oneshot default is infinite)" 0 $?
grep -q '^ExecStart=/etc/couchside/couchside-decky-loader %i$' "$SH"; check "the unit passes only %i to the wrapper" 0 $?
grep -q 'chmod 777' "$T/wrap.tmpl"; check "no chmod 777 (upstream's updater does that; we never do)" 1 $?
# The cwd-pinning invariant, as text: after pin_hb no write names "$HB/…";
# the aside copy is under $TMP; the restore and the aside move are mv -T.
grep -q '^pin_hb(){ .*cd -P "\$HB"' "$T/wrap.tmpl"; check "pin_hb cd -Ps into ~/homebrew" 0 $?
grep -qE '(rm -rf|install|mkdir|chcon).*"\$HB/services' "$T/wrap.tmpl"; check "no rm/install/mkdir/chcon names \$HB/services (all relative after pin_hb)" 1 $?
grep -q 'PREV="\$TMP/services.prev"' "$T/wrap.tmpl"; check "the aside copy is staged under \$TMP" 0 $?
grep -q 'services.prev.\$\$' "$T/wrap.tmpl"; check "...never under a pid-predictable name in the user tree" 1 $?
grep -q 'mv -T ./services "\$PREV"' "$T/wrap.tmpl"; check "aside move is mv -T" 0 $?
grep -q 'mv -T "\$PREV" ./services' "$T/wrap.tmpl"; check "restore is mv -T" 0 $?
grep -q 'mkdir -m 0755 ./services; mkdir -m 0755 ./services/.systemd' "$T/wrap.tmpl"; check "services/ dirs are made without -p" 0 $?

echo
echo "cross-cutting: curl flags and result JSON, over every run above"
check "every curl call carried the bounded/https flags (violations)" "" "$(cat "$STUB_VIOLATIONS")"
# CONTROL: the stub really does flag a bad argv, so the empty list above means something.
: > "$STUB_VIOLATIONS"
"$STUB/curl" -o /dev/null https://api.github.com/repos/SteamDeckHomebrew/decky-loader/releases/latest >/dev/null 2>&1
# (four pins: --max-time, --proto, --proto-redir, --connect-timeout)
check "the curl stub flags an unbounded call (control)" 4 "$(grep -c missing "$STUB_VIOLATIONS" | tr -d ' ')"
check "every result file parsed as JSON with the pinned shape" 0 "$json_bad"
check "...and there were results to audit" yes "$([ "$json_ok" -gt 10 ] && echo yes || echo no)"
check "no chown in the whole suite" 0 "$(calls '^chown')"

echo
if [ "$fails" -ne 0 ]; then
    echo "FAILED: $fails check(s)"
    exit 1
fi
echo "all decky-wrapper tests passed"
