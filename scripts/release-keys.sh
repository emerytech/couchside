#!/usr/bin/env bash
# release-keys.sh — verify a release signature against the keys A BOX ACTUALLY
# TRUSTS, i.e. the RELEASE_PUBKEY_PEM / _BACKUP blocks embedded in install.sh.
#
# WHY THIS EXISTS. release-agent.sh and sign-release.sh both used to "self-
# verify" like this:
#
#     openssl pkey -in "$key" -pubout -out pub.pem      # <- from the SIGNING key
#     openssl pkeyutl -verify -pubin -inkey pub.pem ...
#
# That derives the public half from the very key that just produced the
# signature, so it succeeds BY CONSTRUCTION for any key whatsoever. It cannot
# detect the one failure it claimed to ("never publish a signature install.sh
# would reject"): sign with a wrong or rotated key and it passes, uploads
# cleanly, and is then rejected on EVERY user's box — after the release is
# public, which is the worst possible moment to find out.
#
# The accept rule below is install.sh's verify_release_sig, deliberately
# reproduced rather than approximated: a good signature from EITHER key is
# authentic, and the verdict is taken from openssl's OUTPUT STRING, not its exit
# code, because that is what the box does.
#
# Sourced, not executed:  . "$(dirname "$0")/release-keys.sh"

# Extract the two embedded PEM blocks from an install.sh.
# Python, not sed: release-agent.sh already documents BSD/GNU sed drift biting
# this repo, and this must not be the place it bites next.
release_pubkeys() {   # $1 = path to install.sh; prints PEMs separated by a NUL-ish marker
    python3 - "$1" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
pat = r"^RELEASE_PUBKEY_PEM(?:_BACKUP)?='(-----BEGIN PUBLIC KEY-----.*?-----END PUBLIC KEY-----)'"
for m in re.finditer(pat, src, re.MULTILINE | re.DOTALL):
    print(m.group(1))
    print("---KEYSEP---")
PY
}

# verify_against_installer <installer> <sums> <sig> <openssl>
#   0 = a box would ACCEPT this signature
#   1 = both embedded keys REJECT it  (never publish)
#   2 = could not check               (never publish either — see below)
#
# The asymmetry with install.sh is deliberate. A BOX treats "cannot check" as
# degrade-to-checksums, which is right for a machine on an ancient openssl. On
# the RELEASE side, publishing something we were unable to verify is precisely
# the failure this function exists to prevent, so the caller must abort on 2 as
# well as 1.
verify_against_installer() {
    local installer="$1" sums="$2" sig="$3" ossl="${4:-openssl}"
    local keys tmpd pub out saw_fail=0 n=0

    [ -r "$installer" ] || { echo "release-keys: cannot read $installer" >&2; return 2; }
    keys="$(release_pubkeys "$installer")" || {
        echo "release-keys: failed to parse keys out of $installer" >&2; return 2; }

    tmpd="$(mktemp -d)" || return 2
    # Split on the marker and try each key.
    while IFS= read -r -d '' pub; do
        pub="$(printf '%s' "$pub" | sed -e 's/^[[:space:]]*$//' )"
        [ -n "$(printf '%s' "$pub" | tr -d '[:space:]')" ] || continue
        n=$((n + 1))
        printf '%s\n' "$pub" > "$tmpd/k.pub"
        out="$("$ossl" pkeyutl -verify -pubin -inkey "$tmpd/k.pub" -rawin \
                -in "$sums" -sigfile "$sig" 2>&1 || true)"
        if printf '%s' "$out" | grep -qi 'Verified Successfully'; then
            rm -rf "$tmpd"
            RELEASE_KEY_MATCHED="$n"     # 1 = primary, 2 = backup
            return 0
        elif printf '%s' "$out" | grep -qi 'Verification Failure'; then
            saw_fail=1
        fi
    done < <(printf '%s' "$keys" | awk 'BEGIN{RS="---KEYSEP---\n"} NF{printf "%s%c", $0, 0}')
    rm -rf "$tmpd"

    # Zero keys found is a HARD failure, never "nothing to check, proceed" —
    # otherwise a rename or reformat of the PEM block in install.sh silently
    # restores the tautological no-op this whole file replaces.
    if [ "$n" -eq 0 ]; then
        echo "release-keys: no RELEASE_PUBKEY_PEM blocks found in $installer" >&2
        return 2
    fi
    [ "$saw_fail" -eq 1 ] && return 1 || return 2
}
