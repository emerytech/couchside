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

# Sanity: verify our own signature with the public half before uploading, so we
# never publish a signature install.sh would reject.
"$ossl" pkey -in "$key" -pubout -out "$tmp/pub.pem"
if ! "$ossl" pkeyutl -verify -pubin -inkey "$tmp/pub.pem" -rawin \
        -in "$tmp/SHA256SUMS" -sigfile "$tmp/SHA256SUMS.sig" >/dev/null 2>&1; then
    echo "error: self-verification failed — not uploading" >&2
    exit 1
fi

echo "==> uploading SHA256SUMS.sig to $tag"
gh release upload "$tag" "$tmp/SHA256SUMS.sig" --repo "$REPO" --clobber

echo "OK: signed + uploaded SHA256SUMS.sig for $tag"
echo "    (verify the embedded key matches: openssl pkey -in $key -pubout)"
