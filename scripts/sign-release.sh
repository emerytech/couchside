#!/usr/bin/env bash
# sign-release.sh <tag> [secret-key]
#
# Sign a couchside-decky release's SHA256SUMS with the maintainer's OFFLINE
# Ed25519 key and upload SHA256SUMS.sig to that release. install.sh verifies it
# against the public key embedded there.
#
# Run this LOCALLY after a release is cut — never in CI. The whole point is that
# the secret key never touches GitHub, so a compromised repo/CI/account cannot
# forge a release. Requires: gh (authenticated) and an openssl with Ed25519
# (macOS system LibreSSL 3.3+ works; else `brew install openssl@3`).
#
#   scripts/sign-release.sh v0.2.6
#
set -euo pipefail

REPO="emerytech/couchside-decky"
tag="${1:-}"
key="${2:-$HOME/couchside-release.key}"

[ -n "$tag" ] || { echo "usage: $0 <tag> [secret-key]   e.g. $0 v0.2.6" >&2; exit 2; }
[ -f "$key" ] || { echo "error: secret key not found: $key" >&2; exit 2; }
command -v gh >/dev/null 2>&1 || { echo "error: gh (GitHub CLI) not found / not authenticated" >&2; exit 2; }

# Pick an openssl that supports Ed25519 one-shot signing (-rawin): try the one on
# PATH, then Homebrew's openssl@3.
ossl="openssl"
if ! "$ossl" pkeyutl -help 2>&1 | grep -q -- '-rawin'; then
    if command -v brew >/dev/null 2>&1; then
        cand="$(brew --prefix openssl@3 2>/dev/null)/bin/openssl"
        [ -x "$cand" ] && ossl="$cand"
    fi
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "==> downloading SHA256SUMS from $REPO $tag"
gh release download "$tag" --repo "$REPO" --pattern SHA256SUMS --dir "$tmp" --clobber

echo "==> signing with $key (via $ossl)"
"$ossl" pkeyutl -sign -inkey "$key" -rawin -in "$tmp/SHA256SUMS" -out "$tmp/SHA256SUMS.sig"

# Verify against the keys A BOX ACTUALLY TRUSTS before uploading.
#
# This used to derive the public half from "$key" itself, which succeeds by
# construction for any key and therefore could never catch a wrong or rotated
# one — the failure it claimed to prevent. See scripts/release-keys.sh.
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
. "$here/release-keys.sh"
# `|| _rc=$?` is load-bearing: both scripts run under `set -e`, so calling the
# function bare would abort the moment it returns non-zero and the case below
# would never print WHY. Measured: the first version of this exited 1 silently.
_rc=0
verify_against_installer "$root/install.sh" \
    "$tmp/SHA256SUMS" "$tmp/SHA256SUMS.sig" "$ossl" || _rc=$?
case "$_rc" in
    0) echo "    verifies against the key embedded in install.sh (key #$RELEASE_KEY_MATCHED)" ;;
    1) echo "error: BOTH keys embedded in install.sh reject this signature." >&2
       echo "       Every box would refuse it. Not uploading." >&2
       exit 1 ;;
    *) echo "error: could not verify against install.sh's embedded keys." >&2
       echo "       Publishing something unverifiable is the failure this check" >&2
       echo "       exists to prevent. Not uploading." >&2
       exit 1 ;;
esac

echo "==> uploading SHA256SUMS.sig to $tag"
gh release upload "$tag" "$tmp/SHA256SUMS.sig" --repo "$REPO" --clobber

echo "OK: signed + uploaded SHA256SUMS.sig for $tag"
echo "    (checked against install.sh's embedded release key, not against \$key —"
echo "     so a wrong or rotated key aborts above instead of shipping.)"
