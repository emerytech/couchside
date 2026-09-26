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
set -u
SRC="${1:?usage: test_installer_token_order.sh /path/to/install.sh}"
fails=0
check() { if [ "$2" -eq 0 ]; then echo "  PASS  $1"; else echo "  FAIL  $1"; fails=$((fails+1)); fi; }

# The block: from the (d) header down to (e0)'s mirror sync (inclusive), i.e.
# everything up to the legacy-config migration that follows it.
block="$(awk '/^# \(d\) Token: /{f=1} f&&/^LEGACY_CONFIG=/{exit} f' "$SRC")"
lines=$(printf '%s\n' "$block" | wc -l | tr -d ' ')
[ "$lines" -gt 20 ] && [ "$lines" -lt 140 ]
check "(d)+(e0) block extracts and is bounded ($lines lines)" $?
printf '%s\n' "$block" | grep -q 'MIGRATED_TOKEN="$STATE_DIR/token"'
check "the block contains the mirror restore" $?
printf '%s\n' "$block" | grep -q 'sudo cp "$TOKEN_FILE" "$STATE_DIR/token"'
check "the block contains the (e0) mirror sync" $?

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# run_d <name>: fresh tmp root per scenario; the caller seeds files after.
root=""
new_root() {
    root="$tmp/$1"
    mkdir -p "$root/etc" "$root/var/lib"
}
run_d() {
    {
        echo 'set -euo pipefail'
        echo 'say()  { echo "==> $*"; }'
        echo 'note() { echo "    $*"; }'
        echo 'sudo() { "$@"; }'
        echo "ETC_DIR='$root/etc/couchside'"
        echo "TOKEN_FILE='$root/etc/couchside/token'"
        echo "STATE_DIR='$root/var/lib/couchside'"
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
put "$root/var/lib/couchside/token" "deck-live-token"
run_d >/dev/null; rc=$?
check "the block ran (rc=$rc)" "$rc"
[ "$(tok "$root/etc/couchside/token")" = "deck-live-token" ]
check "canonical restored from the mirror (phones stay paired)" $?

echo
if [ "$fails" -gt 0 ]; then echo "FAILED: $fails"; exit 1; fi
echo "all installer token-order checks passed"
