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
# Adding a service means adding an arm here. The service table never grants a
# "custom URL" — that is a SEPARATE, box-side-gated tier (project_media-player.md
# §5 tier 3): the agent validates the raw URL with urllib and gates it behind an
# opt-in flag, and the tile only opens what arrives in `url=`, backstopped by
# validate_open_url() below (http/https, a host, nothing structural).
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

# Display names for the hub page. NOT an allowlist and never treated as one —
# service_url() is the gate; this only decides whether the TV reads "Disney+"
# or "disneyplus". An id with no entry falls back to itself, so adding a service
# can never make the hub render a blank tile.
service_label() {
    case "$1" in
        netflix)     echo "Netflix" ;;
        youtube)     echo "YouTube" ;;
        max)         echo "Max" ;;
        hulu)        echo "Hulu" ;;
        disneyplus)  echo "Disney+" ;;
        primevideo)  echo "Prime Video" ;;
        appletv)     echo "Apple TV+" ;;
        paramount)   echo "Paramount+" ;;
        peacock)     echo "Peacock" ;;
        crunchyroll) echo "Crunchyroll" ;;
        twitch)      echo "Twitch" ;;
        plutotv)     echo "Pluto TV" ;;
        plex)        echo "Plex" ;;
        spotify)     echo "Spotify" ;;
        *) echo "$1" ;;
    esac
}

# Extra hosts a service is reachable on, for LINK MATCHING only — never for
# opening, which always uses service_url() above.
#
# MEASURED on a live signed-in box 2026-07-27: opening https://play.max.com/
# lands on play.hbomax.com, and a link shared from the app is
# play.hbomax.com/video/watch/<uuid> (which is exactly the shape in the owner's
# original screenshots). Matching only the canonical host meant a pasted Max
# link — the one service whose deep-link pattern is verified — was rejected as
# "not a link this box knows". Aliases fix that without widening what can be
# OPENED: the host still has to be one of ours, and the path still has to clear
# that service's pattern.
service_hosts() {
    case "$1" in
        max) echo "play.max.com play.hbomax.com" ;;
        *) return 1 ;;
    esac
}

# Icon URL for services whose icon is NOT at the conventional root path.
# Checked, not guessed — each of these was fetched before being listed:
#
#   plex     root /favicon.ico 404s; the real ones live under /desktop/.
#   peacock  root /favicon.ico does not respond at all; the only working URL is
#            VERSION-PINNED (peacock-toolkit/53.2.1/...), so it WILL rot when
#            they bump that toolkit. Listed anyway because rot is harmless here:
#            a failed icon removes itself and the tile falls back to its text
#            label, which is exactly what it does today with no entry at all.
#
# Crunchyroll is deliberately absent: it answers 403 to every icon request,
# browser user-agent and referer included (Cloudflare bot protection), so there
# is no URL to list. It keeps its text tile.
service_icon() {
    case "$1" in
        plex)    echo "https://app.plex.tv/desktop/static/icon-iphone.png" ;;
        peacock) echo "https://www.peacocktv.com/static/peacock-toolkit/53.2.1/peacock/favicons/favicon_32x32.png" ;;
        *) return 1 ;;
    esac
}

# ---------------------------------------------------------------------------
# The hub page: the tile's own screen, written from the frozen table.
#
# THIS IS THE ANSWER TO THE TV-PAD-MODE FAILURE. That mode was demoted to
# opt-in because a browser tile grid has no focus model — a cursor jump lands on
# nothing, so arrow keys accomplish nothing on a streaming site. Our own page
# CAN draw a focus ring, so the phone's d-pad (uinput arrow keys) finally moves
# a highlight instead of a stray pointer.
#
# It exists for the case the phone does not cover: someone opens the tile from
# the Steam library with a controller in hand and no phone. Without it the tile
# would open whatever service was last configured, which is a guess.
#
# Written as a file:// page inside the browser profile directory — the one place
# guaranteed readable inside the flatpak sandbox — rather than served, because a
# bash HTTP server would be a worse idea than any problem it solved. Every href
# comes from service_url(); nothing a client sends reaches this file.
# ---------------------------------------------------------------------------
HUB_FILE="$PROFILE/hub.html"

write_hub() {
    mkdir -p "$PROFILE" 2>/dev/null || return 1
    {
        cat <<'HTMLHEAD'
<!doctype html><html><head><meta charset=utf-8><title>Couchside</title><style>
html,body{margin:0;height:100%;background:#0b1220;color:#e5ecf8;
  font-family:system-ui,sans-serif;overflow:hidden}
h1{font-size:2.2vw;letter-spacing:.4em;margin:5vh 0 1vh;text-align:center;
  color:#e5ecf8;font-weight:800}
p.sub{text-align:center;color:#8b97ad;margin:0 0 5vh;font-size:1.2vw}
span.beta{color:#fbbf24;font-size:.95vw;letter-spacing:.08em}
.grid{display:grid;grid-template-columns:repeat(5,1fr);gap:1.6vw;
  padding:0 6vw}
a.tile{display:flex;align-items:center;justify-content:center;gap:.8vw;height:11vh;
  background:#141c2e;border:2px solid #1e2942;border-radius:1vw;
  color:#e5ecf8;text-decoration:none;font-size:1.4vw;font-weight:600;
  transition:transform .08s ease}
/* The focus ring is the whole point: it is what a d-pad step lands ON. */
a.tile:focus{outline:none;border-color:#34d399;background:#0e1526;
  color:#34d399;transform:scale(1.06)}
/* The service's OWN icon, fetched live by the browser from the service itself.
   Nothing is bundled or redistributed — that is the whole reason it is done
   this way instead of shipping logo files with the app. */
img.ico{width:2.6vw;height:2.6vw;object-fit:contain;border-radius:.4vw;flex:none}
</style></head><body>
<h1>COUCHSIDE</h1><p class=sub>Pick a service &middot; or drive it from your phone<br><span class=beta>experimental &mdash; expect rough edges</span></p>
<div class=grid id=g>
HTMLHEAD
        local svc url host icon
        for svc in $(bash "$0" --list-services 2>/dev/null); do
            url="$(service_url "$svc")" || continue
            host="${url#https://}"; host="${host%%/*}"
            icon="$(service_icon "$svc" 2>/dev/null || true)"
            printf '<a class=tile href="%s"><img class=ico data-host="%s" data-icon="%s">%s</a>\n' \
                "$url" "$host" "$icon" "$(service_label "$svc")"
        done
        cat <<'HTMLTAIL'
</div>
<script>
/* Arrow-key navigation with a real focus model. Five columns, matching the
   CSS grid. Native <a> handles Enter, so there is no click synthesis here. */
/* Load each service's own icon, best effort. apple-touch-icon is the sharp one
   but only some services expose it; favicon is the fallback; a tile whose icon
   404s, is blocked, or is slow just drops the image and keeps its text label.
   The hub must never depend on a third party being reachable. */
[].slice.call(document.querySelectorAll('img.ico')).forEach(function (img) {
  var host = img.getAttribute('data-host');
  var override = img.getAttribute('data-icon');
  /* Chain: an explicit URL for the services whose icon is not at the root,
     then apple-touch-icon (the sharp one), then favicon, then give up and let
     the text label carry the tile. */
  var chain = (override ? [override] : [])
    .concat(['https://' + host + '/apple-touch-icon.png',
             'https://' + host + '/favicon.ico']);
  var at = 0;
  img.onerror = function () {
    at++;
    if (at < chain.length) { img.src = chain[at]; return; }
    img.remove();
  };
  img.src = chain[0];
});
var COLS = 5, tiles = [].slice.call(document.querySelectorAll('a.tile')), at = 0;
function go(i){ at = Math.max(0, Math.min(tiles.length - 1, i)); tiles[at].focus(); }
document.addEventListener('keydown', function (e) {
  var k = e.key;
  if (k === 'ArrowRight') go(at + 1);
  else if (k === 'ArrowLeft') go(at - 1);
  else if (k === 'ArrowDown') go(at + COLS);
  else if (k === 'ArrowUp') go(at - COLS);
  else return;
  e.preventDefault();
});
if (tiles.length) go(0);
</script></body></html>
HTMLTAIL
    } > "$HUB_FILE"
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
    HUB=""
    URL_RAW=""
    [ -f "$CONF" ] || return 0
    # Parse strictly: only these keys, only from `key=value` lines. Anything
    # else in the file is ignored rather than interpreted.
    HUB=$(sed -n 's/^hub=\(.*\)$/\1/p' "$CONF" | tail -1)
    SERVICE=$(sed -n 's/^service=\(.*\)$/\1/p' "$CONF" | tail -1)
    DEEP_PATH=$(sed -n 's/^path=\(.*\)$/\1/p' "$CONF" | tail -1)
    QUERY=$(sed -n 's/^query=\(.*\)$/\1/p' "$CONF" | tail -1)
    URL_RAW=$(sed -n 's/^url=\(.*\)$/\1/p' "$CONF" | tail -1)
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

# Free-URL tier (project_media-player.md §5 tier 3) BACKSTOP. The AGENT does the
# full urllib validation and gates the whole tier behind an opt-in flag; this is
# defense-in-depth at the enforcement point. http/https only, a non-empty host,
# no whitespace/control/backslash/quote. The URL only ever becomes --app=<url> to
# the browser (an argv element) — it is NEVER handed to xdg-open/steam://openurl,
# whose scheme re-dispatch is the actual RCE path.
validate_open_url() {
    local url="$1" rest host
    case "$url" in
        https://?*|http://?*) : ;;
        *) log "refused: url scheme (http/https only)"; return 1 ;;
    esac
    case "$url" in
        *[[:space:][:cntrl:]]*|*'\'*|*'"'*) log "refused: url whitespace/control"; return 1 ;;
    esac
    rest="${url#*://}"; host="${rest%%[/?#]*}"
    [ -n "$host" ] || { log "refused: url has no host"; return 1; }
    case "$host" in
        *[!A-Za-z0-9.:_%[-]-]*) log "refused: url host chars"; return 1 ;;
    esac
    printf '%s' "$url"
}

# --- debug entry points, used by tests/test_player_tile.py -------------------
# They exercise the real functions above; they do not reimplement them.
case "${1:-}" in
    --print-ozone) pick_ozone; exit 0 ;;
    --print-url)   build_url "${2:-}" "${3:-}" || exit 1; exit 0 ;;
    --print-open-url) validate_open_url "${2:-}" || exit 1; exit 0 ;;
    --print-search) build_search_url "${2:-}" "${3:-}" || exit 1; exit 0 ;;
    --print-hub)   write_hub && printf 'file://%s\n' "$HUB_FILE"; exit $? ;;
    --print-hosts) service_hosts "${2:-}" || exit 1; exit 0 ;;
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
if [ "${HUB:-}" = "1" ]; then
    # The hub is the tile's own page, so there is nothing to validate: it is
    # written here from the frozen table and lives inside the browser profile.
    if write_hub; then URL="file://$HUB_FILE"; else URL=""; fi
elif [ -n "${URL_RAW:-}" ]; then
    # Free-URL tier (§5 tier 3): the agent already validated + gated it; the tile
    # backstops the scheme/host before opening. Wins over service/path/query.
    URL="$(validate_open_url "$URL_RAW")" || URL=""
elif [ -n "${QUERY:-}" ]; then
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
