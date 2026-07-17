#!/usr/bin/env bash
# release-agent.sh <tag> [secret-key]
#
# Publish the raw agent files as SIGNED assets on the couchside GitHub release
# <tag>, so install.sh (and `couchside update`) can fetch a PINNED, MAINTAINER-
# SIGNED agent instead of mutable `main`. Mirrors scripts/sign-release.sh (which
# does the same for the Decky plugin's release), reusing the same offline
# Ed25519 key and the public half embedded in install.sh.
#
# Run LOCALLY after tagging a release — the secret key never touches CI, so a
# compromised repo/CI/account cannot forge a release.
#
#   scripts/release-agent.sh v2.8.6
#
# Uploads to the release: couchsided.py, couchside.service, qr.py,
# couchside-screensaver.sh, SHA256SUMS, SHA256SUMS.sig.
set -euo pipefail

REPO="emerytech/couchside"
tag="${1:-}"
key="${2:-$HOME/couchside-release.key}"

[ -n "$tag" ] || { echo "usage: $0 <tag> [secret-key]   e.g. $0 v2.8.6" >&2; exit 2; }
[ -f "$key" ] || { echo "error: secret key not found: $key" >&2; exit 2; }
command -v gh >/dev/null 2>&1 || { echo "error: gh (GitHub CLI) not found / not authenticated" >&2; exit 2; }

# Repo root = parent of this script's dir.
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
agent="$root/agent"

# The exact files install.sh fetches. couchsided.py + couchside.service are
# REQUIRED; qr.py + couchside-screensaver.sh are optional at install time but
# always shipped + signed here.
files=(couchsided.py couchside.service qr.py couchside-screensaver.sh)
for f in "${files[@]}"; do
    [ -f "$agent/$f" ] || { echo "error: missing agent/$f" >&2; exit 2; }
done

# Pick an openssl that supports Ed25519 one-shot signing (-rawin).
ossl="openssl"
if ! "$ossl" pkeyutl -help 2>&1 | grep -q -- '-rawin'; then
    if command -v brew >/dev/null 2>&1; then
        cand="$(brew --prefix openssl@3 2>/dev/null)/bin/openssl"
        [ -x "$cand" ] && ossl="$cand"
    fi
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
for f in "${files[@]}"; do cp "$agent/$f" "$tmp/$f"; done

# agent-version.txt: the agent VERSION string, so the box-side update check
# (/api/update/check) can compare cheaply without downloading the whole daemon.
# Signed alongside everything else (it's covered by SHA256SUMS below).
agent_ver="$(grep -m1 '^VERSION' "$agent/couchsided.py" | cut -d'"' -f2)"
[ -n "$agent_ver" ] || { echo "error: couldn't read agent VERSION" >&2; exit 2; }
printf '%s\n' "$agent_ver" > "$tmp/agent-version.txt"
files+=(agent-version.txt)
echo "==> agent version: $agent_ver"

# agent-version-win.txt: same idea for the Windows agent (separate 0.3.x-win
# version track). The Windows agent's /api/update/check compares against this.
win_ver="$(grep -m1 '^VERSION' "$agent/win/couchsided-win.py" | cut -d'"' -f2)"
[ -n "$win_ver" ] || { echo "error: couldn't read Windows agent VERSION" >&2; exit 2; }
printf '%s\n' "$win_ver" > "$tmp/agent-version-win.txt"
files+=(agent-version-win.txt)
echo "==> windows agent version: $win_ver"

echo "==> generating SHA256SUMS over ${#files[@]} agent files"
( cd "$tmp" && { command -v sha256sum >/dev/null 2>&1 \
    && sha256sum "${files[@]}" \
    || shasum -a 256 "${files[@]}"; } > SHA256SUMS )
cat "$tmp/SHA256SUMS"

echo "==> signing SHA256SUMS with $key (via $ossl)"
"$ossl" pkeyutl -sign -inkey "$key" -rawin -in "$tmp/SHA256SUMS" -out "$tmp/SHA256SUMS.sig"

# Self-verify with the public half before uploading — never publish a signature
# install.sh would reject.
"$ossl" pkey -in "$key" -pubout -out "$tmp/pub.pem"
if ! "$ossl" pkeyutl -verify -pubin -inkey "$tmp/pub.pem" -rawin \
        -in "$tmp/SHA256SUMS" -sigfile "$tmp/SHA256SUMS.sig" >/dev/null 2>&1; then
    echo "error: self-verification failed — not uploading" >&2
    exit 1
fi
echo "    signature self-verified OK"

# Ensure a release exists for the tag (create from the tag if not).
if ! gh release view "$tag" --repo "$REPO" >/dev/null 2>&1; then
    echo "==> creating release $tag"
    gh release create "$tag" --repo "$REPO" --title "$tag" \
        --notes "Signed agent assets for install.sh / \`couchside update\`."
fi

echo "==> uploading signed agent assets to $tag"
uploads=()
for f in "${files[@]}"; do uploads+=("$tmp/$f"); done
uploads+=("$tmp/SHA256SUMS" "$tmp/SHA256SUMS.sig")
gh release upload "$tag" --repo "$REPO" --clobber "${uploads[@]}"

echo "OK: signed agent published to $REPO $tag"
echo "    install.sh fetches these from releases/latest/download/ and verifies the sig."
