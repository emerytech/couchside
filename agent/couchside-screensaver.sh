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
# Steam's reaper owns our process group, so a stopper can't signal the pgid —
# it kills THIS pid (the pidfile), and we forward to the current ffplay child.
CUR=""
stop() { [ -n "$CUR" ] && kill "$CUR" 2>/dev/null; rm -f "$PIDFILE"; exit 0; }
trap stop TERM INT
trap 'rm -f "$PIDFILE"' EXIT

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

while :; do
    while IFS= read -r url; do
        ffplay -fs -an -loglevel quiet -autoexit "$url" &
        CUR=$!
        wait "$CUR"
        rc=$?
        CUR=""
        # 0 = video finished, play the next; anything else = ffplay was killed
        # (Steam's Stop, our stop(), or a decode failure) — exit cleanly.
        [ "$rc" -eq 0 ] || exit 0
    done < <(urls)
done
