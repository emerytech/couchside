#!/usr/bin/env bash
# Tests install.sh's "don't restart Decky for no reason" guard (KI-037).
#
# Run: bash tests/test_decky_restart_guard.sh
#
# WHY THIS EXISTS. Restarting plugin_loader.service restarts DECKY LOADER, which
# reloads EVERY plugin the user has — SteamGridDB, ProtonDB, LSFG-VK, whatever.
# install.sh used to rm/extract/restart unconditionally, so every agent update
# (including the one the phone's "update the box" button fires) yanked and
# reloaded third-party software we do not own.
#
# It surfaced as a support report: a user saw an unrelated plugin at 27 GiB
# "right after updating your app". The leak was not ours — but our restart reset
# every plugin to zero and re-seeded it, so another plugin's growth looked like
# it began at our update.
#
# BOTH DIRECTIONS ARE TESTED, and that is the point. A guard that always skipped
# would silently stop shipping plugin updates — strictly worse than the bug it
# fixes. So every "skips" case is paired with a "still installs" case.
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

# Extract the two helpers under test from install.sh, so this exercises the
# SHIPPED text rather than a retyped copy that could drift from it.
eval "$(awk '/^    decky_stamp_of\(\) \{/,/^    \}/' "$SH")"
eval "$(awk '/^    decky_up_to_date\(\) \{/,/^    \}/' "$SH")"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
decky_tmp="$tmp"
DECKY_PLUGIN_DIR="$tmp/plugins/Couchside"
DECKY_STAMP="$tmp/stamp.sha256"
# The helpers call `sudo`; in this harness it is a passthrough shim.
sudo() { "$@"; }

HASH_A="aaaa111122223333444455556666777788889999aaaabbbbccccddddeeeeffff"
HASH_B="bbbb111122223333444455556666777788889999aaaabbbbccccddddeeeeffff"

write_sums() { # hash
    # Real SHA256SUMS layout, including the other assets, so the parser has to
    # actually pick OUR line out rather than take the first one.
    cat >"$tmp/SHA256SUMS" <<EOF
0000000000000000000000000000000000000000000000000000000000000000  couchsided.py
$1  Couchside.tar.gz
1111111111111111111111111111111111111111111111111111111111111111  install.sh
EOF
}

echo "parsing our line out of SHA256SUMS"
write_sums "$HASH_A"
check "picks the Couchside.tar.gz hash, not the first line" "$HASH_A" "$(decky_stamp_of)"

# The binary-mode form (`*name`) that sha256sum emits with -b must parse too.
cat >"$tmp/SHA256SUMS" <<EOF
$HASH_B *Couchside.tar.gz
EOF
check "handles the binary-mode '*name' form" "$HASH_B" "$(decky_stamp_of)"

echo
echo "the guard: skips only when the SAME build is genuinely installed"
mkdir -p "$DECKY_PLUGIN_DIR"
write_sums "$HASH_A"
printf '%s\n' "$HASH_A" >"$DECKY_STAMP"
decky_up_to_date && r=skip || r=install
check "same hash + plugin present -> SKIP (no Decky restart)" "skip" "$r"

# CONTROL, the direction that matters most: a NEW build must still install, or
# the guard would quietly stop delivering plugin updates forever.
write_sums "$HASH_B"
decky_up_to_date && r=skip || r=install
check "different hash -> INSTALL (a real update still ships)" "install" "$r"

echo
echo "degrade toward installing whenever the state is not provably identical"
write_sums "$HASH_A"
rm -rf "$DECKY_PLUGIN_DIR"
decky_up_to_date && r=skip || r=install
check "stamp matches but plugin dir gone -> INSTALL" "install" "$r"

mkdir -p "$DECKY_PLUGIN_DIR"
rm -f "$DECKY_STAMP"
decky_up_to_date && r=skip || r=install
check "no stamp (first run, or upgrade from an older installer) -> INSTALL" "install" "$r"

printf '' >"$DECKY_STAMP"
decky_up_to_date && r=skip || r=install
check "empty stamp -> INSTALL" "install" "$r"

printf '%s\n' "$HASH_A" >"$DECKY_STAMP"
rm -f "$tmp/SHA256SUMS"
decky_up_to_date && r=skip || r=install
check "no SHA256SUMS to compare against -> INSTALL" "install" "$r"

write_sums "$HASH_A"
printf 'not-a-hash\n' >"$DECKY_STAMP"
decky_up_to_date && r=skip || r=install
check "garbage stamp -> INSTALL" "install" "$r"

echo
if [ "$fails" -ne 0 ]; then
    echo "FAILED: $fails check(s)"
    exit 1
fi
echo "all decky restart-guard tests passed"
