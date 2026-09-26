#!/usr/bin/env bash
# install.sh step (d): which token does a re-install restore?
#
# The agent (>= 2.9.114) keeps a 0600 MIRROR of the pairing token at
# /var/lib/couchside/token because a SteamOS update took /etc/couchside/token
# away (KI-088). When the canonical file is gone, the mirror IS the token every
# paired phone is using, so (d) restores it. The bug this pins: the loop over
# OLD_INSTALLS (/etc/rescue-agent, /etc/couchpilot -- pre-rename installs whose
# dirs section (i) deliberately LEAVES in place) ran AFTER the mirror check and
# overwrote MIGRATED_TOKEN. A box that still had a couchpilot-era token lying
# around got that DEAD token restored over the live one, and every phone had to
# re-pair -- on exactly the boxes the mirror exists to protect.
#
# Executable, not textual: the REAL (d) + (e0) lines are lifted out of the
# installer and run against a tmp root with `sudo` as a pass-through function
# (the tests/test_decky_optin.sh precedent). Nothing touches the real /etc.
#
# CONTROL: run this against the pre-fix installer
#   git show 380ea1f:install.sh > /tmp/old.sh && bash tests/test_installer_token_order.sh /tmp/old.sh
# and "mirror beats a leftover couchpilot token" FAILS (it restores the
# couchpilot token) -- measured 2026-09-26.
#
# CONTROL for the KI-093 cases below (root I/O through the user-owned mirror):
#   git show d57c573:install.sh > /tmp/pre093.sh && bash tests/test_installer_token_order.sh /tmp/pre093.sh
# the symlink cases FAIL there: canonical receives the link target's bytes and
# the target's mode is changed through the link -- measured 2026-09-26.
set -u
SRC="${1:?usage: test_installer_token_order.sh /path/to/install.sh}"
fails=0
check() { if [ "$2" -eq 0 ]; then echo "  PASS  $1"; else echo "  FAIL  $1"; fails=$((fails+1)); fi; }

# The block: from the (d) header down to (e0)'s mirror sync (inclusive), i.e.
# everything up to the legacy-config migration that follows it.
block="$(awk '/^# \(d\) Token: /{f=1} f&&/^# \(e0\) Which display manager/{exit} f' "$SRC")"
lines=$(printf '%s\n' "$block" | wc -l | tr -d ' ')
[ "$lines" -gt 20 ] && [ "$lines" -lt 260 ]
check "(d)+(e0) block extracts and is bounded ($lines lines)" $?
printf '%s\n' "$block" | grep -q 'MIGRATED_FROM="$STATE_DIR/token"'
check "the block contains the mirror restore" $?
printf '%s\n' "$block" | grep -q 'mv -f -- "$t" "$STATE_DIR/token"'
check "the block contains the (e0) mirror sync" $?

# STATIC pin for section (e) and the config reads, which sit outside the lifted
# block: no privileged command may name $CONFIG_FILE at all. The config lives in
# the user-owned STATE_DIR and install.sh runs as that user, so any `sudo ...
# $CONFIG_FILE` is a root operation through a user-controlled path (KI-093).
# Review 2026-09-26 reproduced GNU install's path-based chmod following a swapped
# symlink 98/3000 times. Pre-fix installers have several such lines -> FAIL.
# The match requires $CONFIG_FILE to be an ARGUMENT of the sudo'd command: no
# `|`, `&&`, `;` or `)` in between. `sudo cat -- "$LEGACY_CONFIG" | ( ... "$CONFIG_FILE" )`
# is root reading root-owned /etc and THIS user writing -- allowed by design.
n_priv="$(grep -vE '^\s*#' "$SRC" | grep -cE '\bsudo\b[^|&;()]*\$CONFIG_FILE' || true)"
[ "${n_priv:-0}" -eq 0 ]
check "no privileged command names \$CONFIG_FILE anywhere in the installer (found $n_priv)" $?

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# run_d <name>: fresh tmp root per scenario; the caller seeds files after.
root=""
new_root() {
    root="$tmp/$1"
    mkdir -p "$root/etc" "$root/var/lib"
}
# Pass-through sudo for the tmp root. Also swallows `sudo -u USER` (the KI-093
# reads/writes ran that way for a while; harmless to keep). A scenario may set
# SUDO_SHIM to a different function body to model an attacker (see the legacy
# config race case).
DEFAULT_SHIM='sudo() { if [ "${1:-}" = -u ]; then shift 2; fi; "$@"; }'
run_d() {
    {
        echo 'set -euo pipefail'
        echo 'say()  { echo "==> $*"; }'
        echo 'note() { echo "    $*"; }'
        echo "${SUDO_SHIM:-$DEFAULT_SHIM}"
        echo "ETC_DIR='$root/etc/couchside'"
        echo "TOKEN_FILE='$root/etc/couchside/token'"
        echo "STATE_DIR='$root/var/lib/couchside'"
        echo "CONFIG_FILE='$root/var/lib/couchside/config.json'"
        echo "USER_NAME='$(id -un)'"
        echo 'FRESH_TOKEN=0'
        echo 'OLD_INSTALLS=('
        echo "    '$root/etc/rescue-agent|rescue-agent.service|/nonexistent/rescue-agent'"
        echo "    '$root/etc/couchpilot|couchpilot.service|/nonexistent/couchpilot'"
        echo ')'
        printf '%s\n' "$block"
        echo 'echo "FRESH_TOKEN=$FRESH_TOKEN"'
    } > "$tmp/drive.sh"
    bash "$tmp/drive.sh" 2>&1
}
put() { mkdir -p "$(dirname "$1")"; printf '%s\n' "$2" > "$1"; }
tok() { tr -d '[:space:]' < "$1" 2>/dev/null; }
mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

echo "the live mirror beats a leftover pre-rename token (THE bug)"
new_root mirror_vs_old
put "$root/var/lib/couchside/token" "live-mirror-token"
put "$root/etc/couchpilot/token" "dead-couchpilot-token"
put "$root/etc/rescue-agent/token" "dead-rescue-agent-token"
out="$(run_d)"; rc=$?
check "the block ran (rc=$rc)" "$rc"
[ "$(tok "$root/etc/couchside/token")" = "live-mirror-token" ]
check "mirror beats a leftover couchpilot token" $?
printf '%s\n' "$out" | grep -q "migrating token from $root/var/lib/couchside/token"
check "and says it restored from the mirror" $?
[ "$(tok "$root/var/lib/couchside/token")" = "live-mirror-token" ]
check "mirror still holds the live token afterwards" $?
printf '%s\n' "$out" | grep -q 'FRESH_TOKEN=0'
check "not treated as a fresh install (no pairing tutorial)" $?

echo "old installs still migrate when there is NO mirror (the upgrade path)"
new_root old_only
put "$root/etc/couchpilot/token" "couchpilot-token"
put "$root/etc/rescue-agent/token" "rescue-agent-token"
run_d >/dev/null; rc=$?
check "the block ran (rc=$rc)" "$rc"
[ "$(tok "$root/etc/couchside/token")" = "couchpilot-token" ]
check "couchpilot (newest pre-rename) token is inherited" $?
[ "$(tok "$root/var/lib/couchside/token")" = "couchpilot-token" ]
check "and mirrored" $?

echo "an existing canonical token is never replaced"
new_root canonical
put "$root/etc/couchside/token" "canonical-token"
put "$root/var/lib/couchside/token" "stale-mirror-token"
put "$root/etc/couchpilot/token" "dead-couchpilot-token"
run_d >/dev/null; rc=$?
check "the block ran (rc=$rc)" "$rc"
[ "$(tok "$root/etc/couchside/token")" = "canonical-token" ]
check "canonical kept (it is what every rotation path writes)" $?
[ "$(tok "$root/var/lib/couchside/token")" = "canonical-token" ]
check "stale mirror re-synced TO canonical (rotation honoured)" $?

echo "nothing anywhere -> a fresh token, flagged as a fresh install"
new_root fresh
out="$(run_d)"; rc=$?
check "the block ran (rc=$rc)" "$rc"
t="$(tok "$root/etc/couchside/token")"
printf '%s' "$t" | grep -Eq '^[0-9a-f]{48}$'
check "minted a 24-byte hex token" $?
printf '%s\n' "$out" | grep -q 'FRESH_TOKEN=1'
check "FRESH_TOKEN=1 only here" $?

echo "idempotent: a second full run changes nothing"
before="$t"
run_d >/dev/null; rc=$?
check "second run ok (rc=$rc)" "$rc"
[ "$(tok "$root/etc/couchside/token")" = "$before" ]
check "same token after a re-run (no re-pair)" $?
[ "$(mode "$root/etc/couchside/token")" = "600" ] && [ "$(mode "$root/var/lib/couchside/token")" = "600" ]
check "both copies stay 0600" $?

echo "the Deck case: /etc/couchside GONE, mirror survived"
new_root deck
put "$root/var/lib/couchside/token" "deck-live-token-0001"
run_d >/dev/null; rc=$?
check "the block ran (rc=$rc)" "$rc"
[ "$(tok "$root/etc/couchside/token")" = "deck-live-token-0001" ]
check "canonical restored from the mirror (phones stay paired)" $?

echo "KI-093: a SYMLINK planted at the mirror is refused, never copied through"
new_root mirror_symlink
put "$root/victim" "VICTIM-CONTENTS-must-not-move"
chmod 644 "$root/victim"
mkdir -p "$root/var/lib/couchside"
ln -s "$root/victim" "$root/var/lib/couchside/token"
out="$(run_d)"; rc=$?
check "the block ran (rc=$rc)" "$rc"
[ "$(tok "$root/etc/couchside/token")" != "VICTIM-CONTENTS-must-not-move" ]
check "canonical did NOT receive the link target's contents" $?
[ "$(tok "$root/victim")" = "VICTIM-CONTENTS-must-not-move" ]
check "the link target's contents are untouched (no write through the link)" $?
[ "$(mode "$root/victim")" = "644" ]
check "the link target's mode is untouched (no chmod through the link)" $?
[ ! -L "$root/var/lib/couchside/token" ] && [ -f "$root/var/lib/couchside/token" ]
check "the mirror is now a regular file, not the planted link" $?
[ "$(tok "$root/var/lib/couchside/token")" = "$(tok "$root/etc/couchside/token")" ]
check "and it mirrors the (fresh) canonical token" $?
printf '%s\n' "$out" | grep -q 'FRESH_TOKEN=1'
check "a refused mirror with nothing else to inherit = fresh install" $?

echo "KI-093: a mirror that is not token-shaped is refused"
new_root mirror_garbage
put "$root/var/lib/couchside/token" "not a token: has spaces"
out="$(run_d)"; rc=$?
check "the block ran (rc=$rc)" "$rc"
t="$(tok "$root/etc/couchside/token")"
printf '%s' "$t" | grep -Eq '^[0-9a-f]{48}$'
check "garbage rejected -> a fresh hex token was minted" $?
[ "$(tok "$root/var/lib/couchside/token")" = "$t" ]
check "mirror re-synced to the fresh canonical" $?

echo "KI-093: legacy /etc config migration survives a mv->chown race (attacker swaps a symlink in)"
# The hole (review 2026-09-26, reproduced 5/5 in a container): the old trio
# `sudo mv LEGACY CONFIG; sudo chown; sudo chmod` ran as root THROUGH the
# user-owned dir. Between mv landing the file and chown/chmod, the user swaps
# config.json for a symlink; chmod/chown follow it. The shim below plays that
# attacker: right after any root `mv` lands, it replaces the destination with a
# link to a victim. The fixed block never runs a root op on that path (root only
# reads /etc; THIS user writes via temp+mv), so the hook is inert and the
# victim stays untouched.
new_root legacy_config_race
put "$root/etc/couchside/token" "canonical-token-value-1"
put "$root/etc/couchside/config.json" '{"legacy": true}'
put "$root/victim3" "CONFIG-VICTIM"
chmod 644 "$root/victim3"
mkdir -p "$root/var/lib/couchside"
SUDO_SHIM="sudo() { if [ \"\${1:-}\" = -u ]; then shift 2; fi; if [ \"\$1\" = mv ]; then command mv \"\${@:2}\" || return \$?; ln -sfn '$root/victim3' \"\${@: -1}\"; return 0; fi; \"\$@\"; }"
out="$(SUDO_SHIM="$SUDO_SHIM" run_d)"; rc=$?
unset SUDO_SHIM
check "the block ran (rc=$rc)" "$rc"
[ ! -L "$root/var/lib/couchside/config.json" ] && [ "$(tok "$root/var/lib/couchside/config.json")" = '{"legacy":true}' ]
check "config.json is a regular file holding the legacy config (no root mv for the attacker to race)" $?
[ "$(tok "$root/victim3")" = "CONFIG-VICTIM" ] && [ "$(mode "$root/victim3")" = "644" ]
check "the victim's content and mode are untouched (no chmod/chown through a swapped link)" $?
[ ! -e "$root/etc/couchside/config.json" ]
check "the legacy /etc copy was removed after a successful migration" $?
[ "$(mode "$root/var/lib/couchside/config.json")" = "600" ]
check "migrated config is 0600" $?

echo "KI-093: a symlink AT the canonical path is damage, rebuilt from the mirror"
new_root canonical_symlink
put "$root/victim2" "CANON-VICTIM"
put "$root/var/lib/couchside/token" "live-mirror-token-value"
mkdir -p "$root/etc/couchside"
ln -s "$root/victim2" "$root/etc/couchside/token"
run_d >/dev/null; rc=$?
check "the block ran (rc=$rc)" "$rc"
[ ! -L "$root/etc/couchside/token" ] && [ "$(tok "$root/etc/couchside/token")" = "live-mirror-token-value" ]
check "canonical is a real file holding the mirror's token (link replaced, not followed)" $?
[ "$(tok "$root/victim2")" = "CANON-VICTIM" ]
check "the canonical link's target is untouched" $?

echo
if [ "$fails" -gt 0 ]; then echo "FAILED: $fails"; exit 1; fi
echo "all installer token-order checks passed"
