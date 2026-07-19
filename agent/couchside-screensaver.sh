#!/usr/bin/env bash
# couchside-screensaver: Apple-TV-style aerial screensaver for Couchside boxes.
# Launched THROUGH STEAM (registered as a non-Steam shortcut) because gamescope
# only surfaces windows Steam focuses. Plays shuffled Apple aerials fullscreen
# with ffplay until killed (the agent's screensaver stop TERMs the pidfile pid;
# the trap below forwards that to the current ffplay child).
#
# Playlist: Apple's public aerial catalog (entries.json inside resources.tar).
# Cached for 7 days; refreshed best-effort. 1080p H264 tier: every box decodes
# it, streams light. No key, no account.
#
# Playback is DOUBLE-BUFFERED: each clip is fetched to disk in full, and the
# NEXT clip downloads while the current one plays, so clips cut over with a
# brief flicker instead of seconds of black while ffplay re-buffers a stream.
# At most two clips sit on disk at once.
set -u
# Steam launches non-Steam shortcuts inside its runtime: LD_LIBRARY_PATH /
# LD_PRELOAD point at Steam's bundled libs, which breaks OS binaries (curl,
# tar, python3, ffplay all link the wrong libraries and die). Shed that env —
# we want the plain OS toolchain; gamescope still surfaces the window fine.
unset LD_LIBRARY_PATH LD_PRELOAD
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/couchside"
CATALOG="$CACHE_DIR/aerials.json"
CATALOG_URL="https://sylvan.apple.com/Aerials/resources-15.tar"
PIDFILE="$CACHE_DIR/screensaver.pid"
mkdir -p "$CACHE_DIR"

# Single instance: a stale pidfile whose pid is dead is overwritten.
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
    exit 0
fi
echo "$$" > "$PIDFILE"

# Per-run scratch for the downloaded clips (two at a time). Isolated per run so
# a crashed previous run can't leave us playing its half-written file.
PLAYDIR="$(mktemp -d "$CACHE_DIR/play.XXXXXX")"

# Steam's reaper owns our process group, so a stopper can't signal the pgid —
# it kills THIS pid (the pidfile), and we forward to the current ffplay child
# AND the in-flight download, then clear the scratch dir.
CUR=""      # current ffplay pid
DL=""       # current background download pid
stop() {
    [ -n "$CUR" ] && kill "$CUR" 2>/dev/null
    [ -n "$DL" ]  && kill "$DL"  2>/dev/null
    rm -rf "$PLAYDIR"
    rm -f "$PIDFILE"
    exit 0
}
trap stop TERM INT
trap 'rm -rf "$PLAYDIR"; rm -f "$PIDFILE"' EXIT

fresh() {
    [ -f "$CATALOG" ] || return 1
    local age=$(( $(date +%s) - $(stat -c %Y "$CATALOG" 2>/dev/null || echo 0) ))
    [ "$age" -lt 604800 ]
}

if ! fresh; then
    tmp=$(mktemp -d)
    # Verified TLS first. Fedora's CA bundle can't build Apple's sylvan chain
    # (missing intermediate, AIA-only), so fall back to unverified — the parser
    # below hard-whitelists https://*.apple.com URLs, and ffmpeg's own TLS does
    # not verify either, so this is no weaker than playback itself. Video
    # content only; nothing from this file is executed.
    if ! curl -fsSL -m 60 -o "$tmp/resources.tar" "$CATALOG_URL" 2>/dev/null; then
        curl -fsSLk -m 60 -o "$tmp/resources.tar" "$CATALOG_URL" 2>/dev/null
    fi
    if [ -s "$tmp/resources.tar" ] \
       && tar -xf "$tmp/resources.tar" -C "$tmp" entries.json 2>/dev/null; then
        mv "$tmp/entries.json" "$CATALOG"
    fi
    rm -rf "$tmp"
fi
[ -f "$CATALOG" ] || exit 1

# Conf (~/.config/couchside/screensaver.conf), both optional:
#   TIER=1080-H264 (default; every box decodes it) | 1080-SDR | 4K-SDR | 4K-HDR
#   THEME=all (default) | space | landscapes | cities | underwater
#         (comma-separable, e.g. THEME=space,underwater — Apple TV's categories)
CONF="${XDG_CONFIG_HOME:-$HOME/.config}/couchside/screensaver.conf"
TIER="1080-H264"
THEME="all"
# shellcheck disable=SC1090
[ -f "$CONF" ] && . "$CONF"

# ffplay flags. -noborder/-alwaysontop are no-ops under -fs+gamescope but keep
# the window clean on a plain desktop. -window_title names the X11 window (NOT
# the Steam tile — that comes from the shortcut basename). The idle cursor is
# hidden by gamescope, which is the only compositor this ever runs under.
FF=(ffplay -fs -an -noborder -alwaysontop -loglevel quiet -autoexit
    -window_title "Couchside Screensaver")

# Fetch $1 to $2 in the BACKGROUND; sets DL to the download pid. Only ever fed
# URLs from urls() below, which hard-whitelists https://*.apple.com — never a
# client- or catalog-controlled address.
prefetch() {
    ( curl -fsSL -m 120 -o "$2" "$1" 2>/dev/null \
      || curl -fsSLk -m 120 -o "$2" "$1" 2>/dev/null ) &
    DL=$!
}

# Shuffled URL list, one per line. Re-shuffled each full pass.
urls() {
    TIER="$TIER" THEME="$THEME" python3 - "$CATALOG" <<'PY'
import json, os, random, sys
from urllib.parse import urlparse
d = json.load(open(sys.argv[1]))
tier = "url-" + os.environ.get("TIER", "1080-H264")
# Theme names -> category ids, matched against AerialCategory<Name> keys at
# runtime so a future catalog reshuffle of UUIDs keeps working.
want = {t.strip().lower() for t in os.environ.get("THEME", "all").split(",") if t.strip()}
cat_ids = None
if want and "all" not in want:
    cat_ids = {c["id"] for c in d.get("categories", [])
               if c.get("localizedNameKey", "").lower().removeprefix("aerialcategory") in want}
u = []
for a in d.get("assets", []):
    if cat_ids is not None and not (set(a.get("categories", [])) & cat_ids):
        continue
    x = a.get(tier) or a.get("url-1080-H264")
    if not x:
        continue
    # Whitelist: https + apple.com hosts only. The catalog fetch may have been
    # unverified (see above), so never let it point the player anywhere else.
    p = urlparse(x)
    if p.scheme == "https" and (p.hostname or "").endswith(".apple.com"):
        u.append(x)
# An unmatched theme name would yield an empty list — fall back to everything
# rather than a black screen.
if not u:
    u = [a.get(tier) or a.get("url-1080-H264") for a in d.get("assets", [])]
    u = [x for x in u if x and urlparse(x).scheme == "https"
         and (urlparse(x).hostname or "").endswith(".apple.com")]
random.shuffle(u)
print("\n".join(u))
PY
}

A="$PLAYDIR/a.mp4"
B="$PLAYDIR/b.mp4"
while :; do
    mapfile -t list < <(urls)
    n=${#list[@]}
    # No playable URLs (network down, catalog odd) — wait and retry the pass
    # rather than spin or die.
    [ "$n" -eq 0 ] && { sleep 2; continue; }

    # Prime slot A: download the first clip fully before the first frame, so we
    # never open the window on a black buffering screen.
    prefetch "${list[0]}" "$A"
    wait "$DL" 2>/dev/null
    DL=""

    for ((i = 0; i < n; i++)); do
        [ -s "$A" ] || continue        # this clip failed to download; skip it
        # Start fetching the NEXT clip while this one plays (double-buffer).
        nxt=$(( (i + 1) % n ))
        prefetch "${list[$nxt]}" "$B"

        "${FF[@]}" "$A" &
        CUR=$!
        wait "$CUR"
        rc=$?
        CUR=""
        # 0 = clip finished, advance; anything else = ffplay was killed (Steam's
        # Stop, our stop(), or a decode failure) — exit cleanly.
        if [ "$rc" -ne 0 ]; then
            [ -n "$DL" ] && kill "$DL" 2>/dev/null
            exit 0
        fi

        wait "$DL" 2>/dev/null          # make sure B finished downloading
        DL=""
        rm -f "$A"
        mv -f "$B" "$A"                 # B becomes the next A
    done
done
