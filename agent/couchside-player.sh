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
    [ -f "$CONF" ] || return 0
    # Parse strictly: only these two keys, only from `key=value` lines. Anything
    # else in the file is ignored rather than interpreted.
    SERVICE=$(sed -n 's/^service=\(.*\)$/\1/p' "$CONF" | tail -1)
    DEEP_PATH=$(sed -n 's/^path=\(.*\)$/\1/p' "$CONF" | tail -1)
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
URL="$(build_url "$SERVICE" "$DEEP_PATH")" || {
    log "nothing to open; exiting without launching a browser"
    rm -f "$PIDFILE"
    exit 2
}

if ! resolve_browser; then
    log "no Widevine-capable browser found; refusing to launch (degrade closed)"
    rm -f "$PIDFILE"
    exit 3
fi

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
