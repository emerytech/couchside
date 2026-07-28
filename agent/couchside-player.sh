#!/usr/bin/env bash
# couchside-player: the Couchside Player tile.
#
# Registered as a NON-STEAM SHORTCUT and launched THROUGH STEAM, because
# gamescope only surfaces windows Steam focuses (same hard-won rule as
# couchside-screensaver.sh; the atom tricks were tested and do not work).
# Steam launches this script; this script spawns Chrome as a child and holds the
# process Steam is tracking, so Steam's own reaper stops the whole thing.
#
# It is NOT a browser. It is the session manager: it resolves a Widevine-capable
# browser, picks the right display backend, opens ONE allowlisted service, and
# cleans up. Playback control over CDP arrives in a later phase; the debugging
# port is opened and recorded here so that phase has something to attach to.
#
# WHY NOT just a Chrome --app= Steam shortcut (which is what most boxes already
# have): a raw shortcut is a dead end. Nothing can ask it what is playing, seek
# it, or point it somewhere new. Holding the process ourselves is what makes the
# phone a remote instead of a launcher.
set -u

# Steam launches non-Steam shortcuts INSIDE its runtime: LD_LIBRARY_PATH /
# LD_PRELOAD point at Steam's bundled libs, which breaks OS binaries (grep,
# flatpak, python3 all link the wrong libraries and die). Shed that env — we
# want the plain OS toolchain. gamescope still surfaces the window fine.
# (Measured: this is why the probe logs were full of gameoverlayrenderer.so
# ELFCLASS32 errors.)
unset LD_LIBRARY_PATH LD_PRELOAD

CONF="${XDG_CONFIG_HOME:-$HOME/.config}/couchside/player.conf"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/couchside"
PIDFILE="$CACHE_DIR/player.pid"
PORTFILE="$CACHE_DIR/player.port"
PROFILE="$HOME/.var/app/com.google.Chrome/config/couchside-player"
LOG="$CACHE_DIR/player.log"

# ---------------------------------------------------------------------------
# THE ALLOWLIST. A frozen table, looked up — never interpolated, never widened
# to a pattern. The conf file is written by the agent from a client request, so
# everything in it is treated as untrusted input: an id that is not a case arm
# below exits non-zero and launches NOTHING.
#
# Adding a service means adding an arm here. There is deliberately no "custom
# URL" arm: that tier is a separate, box-side-gated feature (see
# docs/memory/project_media-player.md §5), not something the tile grants.
# ---------------------------------------------------------------------------
service_url() {
    case "$1" in
        netflix)     echo "https://www.netflix.com/" ;;
        youtube)     echo "https://www.youtube.com/" ;;
        max)         echo "https://play.max.com/" ;;
        hulu)        echo "https://www.hulu.com/" ;;
        disneyplus)  echo "https://www.disneyplus.com/" ;;
        primevideo)  echo "https://www.primevideo.com/" ;;
        appletv)     echo "https://tv.apple.com/" ;;
        paramount)   echo "https://www.paramountplus.com/" ;;
        peacock)     echo "https://www.peacocktv.com/" ;;
        crunchyroll) echo "https://www.crunchyroll.com/" ;;
        twitch)      echo "https://www.twitch.tv/" ;;
        plutotv)     echo "https://pluto.tv/" ;;
        plex)        echo "https://app.plex.tv/" ;;
        spotify)     echo "https://open.spotify.com/" ;;
        *) return 1 ;;
    esac
}

# Per-service deep-link path patterns (ERE, anchored at both ends by the caller).
#
# DEGRADE CLOSED: a service with NO pattern here rejects every path and can only
# ever open its home page. Only `max` ships a pattern in this phase, because it
# is the only shape actually OBSERVED (in the owner's own reference screenshots,
# play.hbomax.com/video/watch/<uuid>). The rest are deliberately absent rather
# than guessed — a wrong pattern is either a dead link or a hole, and this repo
# has a house rule against asserting URL shapes without firing them. Fill these
# in one at a time, each with a real link tested against a real box.
service_path_re() {
    case "$1" in
        max) echo '/video/watch/[0-9a-fA-F-]{36}' ;;
        *) return 1 ;;
    esac
}

# Per-service SEARCH prefix: the query, percent-encoded, is appended to this.
#
# This is what "search from the phone" actually is — the box opens the
# service's OWN search results, so nobody types a title on a TV with a d-pad.
# There is no metadata service behind it and no API key: the phone sends text,
# the box searches the service the user picked. Nothing leaves the LAN except
# the browser's own request to the service, which it would make anyway.
#
# DEGRADE CLOSED, same rule as the deep-link patterns: a service with no entry
# here simply cannot be searched, and the app hides the option for it. Only
# shapes VERIFIED against the live service belong here — a guessed search URL
# is a dead end that looks like a broken feature.
service_search() {
    case "$1" in
        youtube)     echo "https://www.youtube.com/results?search_query=" ;;
        netflix)     echo "https://www.netflix.com/search?q=" ;;
        twitch)      echo "https://www.twitch.tv/search?term=" ;;
        crunchyroll) echo "https://www.crunchyroll.com/search?q=" ;;
        *) return 1 ;;
    esac
}

# Percent-encode a search query for use as a query-string VALUE.
#
# Structurally-bad input is REJECTED (control characters, over-length) rather
# than cleaned up. What is left is then encoded losslessly: every byte outside
# RFC3986's unreserved set becomes %XX, so accented titles survive as UTF-8 and
# nothing can terminate the value early or add a second parameter. Encoding is
# transport, not sanitising — the rule that matters is that no input reaches the
# URL in a form that could change its STRUCTURE, and after this none can.
encode_query() {
    # LC_ALL=C for the whole function so ${#raw} and ${raw:i:1} count BYTES.
    # Without it a UTF-8 title is walked per character and printf emits only the
    # first byte of each, producing mojibake. Byte-wise is also what makes the
    # accent case work at all: each byte becomes its own %XX and the service
    # reassembles the UTF-8.
    local LC_ALL=C raw="$1" out="" i c
    [ ${#raw} -ge 1 ] && [ ${#raw} -le 80 ] || return 1
    # Reject CONTROL bytes only. An earlier version rejected anything outside
    # [:print:], which under this same C locale excludes every byte >= 0x80 —
    # so "Amélie" was refused outright and no non-English title could be
    # searched. Structure is what must be rejected, not non-ASCII.
    case "$raw" in
        *[$'\001'-$'\037']* | *$'\177'*) return 1 ;;
    esac
    # At least one non-space character. The agent rejects a blank query too, but
    # the tile is the enforcement point and must not depend on a caller's check:
    # "   " otherwise became search_query=%20%20%20, an empty search that looks
    # like the feature failed.
    case "$raw" in
        *[![:space:]]*) : ;;
        *) return 1 ;;
    esac
    local n
    for (( i = 0; i < ${#raw}; i++ )); do
        c="${raw:i:1}"
        case "$c" in
            [A-Za-z0-9.~_-]) out="$out$c" ;;
            *)
                # & 0xFF because printf "'$c" SIGN-EXTENDS any byte >= 0x80:
                # "Amélie" came out as %FFFFFFFFFFFFFFC3 instead of %C3.
                n=$(printf '%d' "'$c")
                out="$out$(printf '%%%02X' $(( n & 0xFF )))"
                ;;
        esac
    done
    printf '%s' "$out"
}

log() { printf '[player] %s\n' "$*" >> "$LOG" 2>/dev/null; }

mkdir -p "$CACHE_DIR"

# ---------------------------------------------------------------------------
# Browser resolution. DEGRADE CLOSED (CLAUDE.md §3 rule 7): if no browser with a
# Widevine CDM is present we report unavailable and exit, rather than launching
# something that renders a black rectangle where the film should be.
#
# The flatpak is listed first because it is what these boxes actually have —
# measured on the reference Bazzite box, com.google.Chrome was the ONLY
# Widevine-capable browser present, with no system Chromium at all.
# ---------------------------------------------------------------------------
BROWSER_KIND=""
BROWSER_BIN=""

resolve_browser() {
    if command -v flatpak >/dev/null 2>&1 \
       && flatpak info com.google.Chrome >/dev/null 2>&1 \
       && [ -n "$(find /var/lib/flatpak/app/com.google.Chrome -name libwidevinecdm.so \
                  -print -quit 2>/dev/null)" ]; then
        BROWSER_KIND="flatpak"
        BROWSER_BIN="com.google.Chrome"
        return 0
    fi
    for b in google-chrome-stable google-chrome chromium chromium-browser; do
        p="$(command -v "$b" 2>/dev/null)" || continue
        # A Chromium build without a bundled CDM plays nothing DRM-protected.
        for cdm in /opt/google/chrome/WidevineCdm \
                   /usr/lib64/chromium-browser/WidevineCdm \
                   /usr/lib/chromium/WidevineCdm; do
            if [ -d "$cdm" ]; then
                BROWSER_KIND="native"
                BROWSER_BIN="$p"
                return 0
            fi
        done
    done
    return 1
}

# ---------------------------------------------------------------------------
# Display backend. MEASURED 2026-07-27, and it is the INVERSE between the two
# sessions, so it must never be hardcoded:
#
#   Game Mode (gamescope): Steam gives DISPLAY=:1 and NO WAYLAND_DISPLAY.
#       --ozone-platform=wayland dies with
#       "Failed to connect to Wayland display: No such file or directory".
#   Plasma desktop, spawned from a non-graphical parent (systemd user service,
#       ssh): there is no xauth cookie, so the X11 backend dies with
#       "Missing X server or $DISPLAY ... The platform failed to initialize".
#
# Either way Chrome exits rc=1 BEFORE binding the debugging port, which reads as
# "the player is broken" rather than "the wrong flag".
# ---------------------------------------------------------------------------
pick_ozone() {
    if [ -n "${WAYLAND_DISPLAY:-}" ]; then
        echo "--ozone-platform=wayland"
    elif [ -n "${DISPLAY:-}" ]; then
        echo "--ozone-platform=x11"
    else
        echo ""
    fi
}

# A loopback debugging port, randomised per launch. CDP is an arbitrary-code
# primitive (Runtime.evaluate is arbitrary JS; file:// navigation plus a DOM read
# is local file exfiltration), so it binds 127.0.0.1 only and is NEVER proxied
# through an agent LAN route. The port is recorded for the local control path.
pick_port() {
    local p
    p=$(( 20000 + ($(od -An -N2 -tu2 < /dev/urandom | tr -d ' ') % 40000) ))
    echo "$p"
}

read_conf() {
    SERVICE=""
    DEEP_PATH=""
    QUERY=""
    [ -f "$CONF" ] || return 0
    # Parse strictly: only these keys, only from `key=value` lines. Anything
    # else in the file is ignored rather than interpreted.
    SERVICE=$(sed -n 's/^service=\(.*\)$/\1/p' "$CONF" | tail -1)
    DEEP_PATH=$(sed -n 's/^path=\(.*\)$/\1/p' "$CONF" | tail -1)
    QUERY=$(sed -n 's/^query=\(.*\)$/\1/p' "$CONF" | tail -1)
}

# Build a SEARCH url: frozen prefix from the table + the encoded query.
# The host and the parameter name are ours; only the value varies, and after
# encode_query it cannot contain a '&', a '#', or anything else structural.
build_search_url() {
    local svc="$1" raw="$2" prefix encoded
    prefix="$(service_search "$svc")" || {
        log "refused: service '$svc' has no verified search url"
        return 1
    }
    encoded="$(encode_query "$raw")" || {
        log "refused: query rejected (empty, too long, or non-printable)"
        return 1
    }
    printf '%s%s' "$prefix" "$encoded"
}

# Build the URL to open. This is the ONE place client-influenced data becomes a
# URL, so it is the one place that has to be right.
build_url() {
    local svc="$1" path="$2" base re
    base="$(service_url "$svc")" || {
        log "refused: unknown service id '$svc'"
        return 1
    }
    if [ -z "$path" ]; then
        echo "$base"
        return 0
    fi
    re="$(service_path_re "$svc")" || {
        log "refused: service '$svc' has no deep-link pattern; path rejected"
        return 1
    }
    # Reject, never sanitise (CLAUDE.md §3 rule 6). Anchored both ends. A path
    # must start with exactly one '/', and may not contain a scheme, a host, a
    # backslash, whitespace or control characters — so it cannot smuggle a
    # second URL past the host, which is never client-supplied.
    case "$path" in
        //*|*[[:space:]]*|*'\'*|*'..'*) log "refused: malformed path"; return 1 ;;
        /*) : ;;
        *) log "refused: path must begin with /"; return 1 ;;
    esac
    if ! printf '%s' "$path" | grep -Eq "^${re}$"; then
        log "refused: path does not match the pattern for '$svc'"
        return 1
    fi
    # base already ends in '/', path already begins with one.
    echo "${base%/}$path"
}

# --- debug entry points, used by tests/test_player_tile.py -------------------
# They exercise the real functions above; they do not reimplement them.
case "${1:-}" in
    --print-ozone) pick_ozone; exit 0 ;;
    --print-url)   build_url "${2:-}" "${3:-}" || exit 1; exit 0 ;;
    --print-search) build_search_url "${2:-}" "${3:-}" || exit 1; exit 0 ;;
    --list-searchable)
        for s in youtube netflix twitch crunchyroll; do
            service_search "$s" >/dev/null 2>&1 && echo "$s"
        done
        exit 0 ;;
    --print-browser)
        if resolve_browser; then echo "$BROWSER_KIND $BROWSER_BIN"; exit 0; fi
        echo "unavailable"; exit 1 ;;
    --list-services)
        for s in netflix youtube max hulu disneyplus primevideo appletv \
                 paramount peacock crunchyroll twitch plutotv plex spotify; do
            echo "$s"
        done
        exit 0 ;;
esac

# --- single instance ---------------------------------------------------------
# A stale pidfile whose pid is dead is overwritten; a live one means the tile is
# already up and this launch is a no-op (Steam can fire rungameid twice).
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
    log "already running (pid $(cat "$PIDFILE")), exiting"
    exit 0
fi
echo "$$" > "$PIDFILE"

read_conf
SERVICE="${SERVICE:-netflix}"
# A query in the conf means "open this service's search results"; it wins over
# a deep-link path, and the two are never combined.
if [ -n "${QUERY:-}" ]; then
    URL="$(build_search_url "$SERVICE" "$QUERY")" || URL=""
else
    URL="$(build_url "$SERVICE" "$DEEP_PATH")" || URL=""
fi
if [ -z "$URL" ]; then
    log "nothing to open; exiting without launching a browser"
    rm -f "$PIDFILE"
    exit 2
fi

if ! resolve_browser; then
    log "no Widevine-capable browser found; refusing to launch (degrade closed)"
    rm -f "$PIDFILE"
    exit 3
fi

# Wait for a previous Chrome to release the profile before launching.
#
# MEASURED 2026-07-27, switching services on a live box: the agent stops the
# tile and relaunches, but Chrome outlives the wrapper by a few seconds. A
# second `flatpak run` against a --user-data-dir that is still owned DEFERS to
# the running instance — it opens a window there and exits, so the new
# --remote-debugging-port never binds. The visible symptom is the transport
# reading about:blank forever while the service plays fine on the TV, which
# looks like a CDP bug and is not one.
#
# The lock is a symlink Chrome removes on a clean exit; a stale one from a
# crash is ignored after the timeout rather than blocking the launch, because
# refusing to start is worse than racing.
for _ in $(seq 1 20); do
    [ -e "$PROFILE/SingletonLock" ] || break
    sleep 0.5
done

OZONE="$(pick_ozone)"
PORT="$(pick_port)"
echo "$PORT" > "$PORTFILE"
log "start service=$SERVICE browser=$BROWSER_KIND ozone=${OZONE:-auto} port=$PORT"
log "display: WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-unset} DISPLAY=${DISPLAY:-unset}"

# Steam's reaper owns our process group, so a stopper signals THIS pid (the
# pidfile) and we forward to the browser child — the same discipline the
# screensaver uses. The flatpak instance is also asked to stop explicitly:
# `flatpak run` reparents through the portal, so killing the child pid alone is
# not guaranteed to take the sandbox with it.
CHILD=""
stop() {
    log "stopping"
    [ -n "$CHILD" ] && kill "$CHILD" 2>/dev/null
    if [ "$BROWSER_KIND" = "flatpak" ]; then
        flatpak kill com.google.Chrome >/dev/null 2>&1
    fi
    rm -f "$PIDFILE" "$PORTFILE"
    exit 0
}
trap stop TERM INT
trap 'rm -f "$PIDFILE" "$PORTFILE"' EXIT

# --app= gives a chromeless window: no tab strip, no omnibox, nothing on a TV
# that a phone would have to drive. Every argument here is chosen by this
# script; the only client-influenced value is $URL, built by build_url above.
CHROME_ARGS=(
    --user-data-dir="$PROFILE"
    --no-first-run
    --no-default-browser-check
    --remote-debugging-port="$PORT"
    --start-fullscreen
    --app="$URL"
)
[ -n "$OZONE" ] && CHROME_ARGS=("$OZONE" "${CHROME_ARGS[@]}")

if [ "$BROWSER_KIND" = "flatpak" ]; then
    flatpak run "$BROWSER_BIN" "${CHROME_ARGS[@]}" >> "$LOG" 2>&1 &
else
    "$BROWSER_BIN" "${CHROME_ARGS[@]}" >> "$LOG" 2>&1 &
fi
CHILD=$!
log "browser child pid=$CHILD"
wait "$CHILD"
log "browser exited rc=$? — tile ending"
