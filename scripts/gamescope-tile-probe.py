#!/usr/bin/env python3
"""Phase 0b: the two questions the desktop-mode spike could not answer.

  Q6  Does a WRAPPER tile -- a program Steam launches, which then spawns Chrome
      as a CHILD -- actually surface under gamescope? The screensaver precedent
      says Steam-launched things surface, and the existing Chrome --app= tiles
      work in Game Mode, but neither of those is a wrapper spawning a child.
  Q7  Can Steam's reaper kill a FLATPAK Chrome child, or does Close Game leave
      an orphan browser on the TV? There is no system Chromium on this box, so
      flatpak is not an avoidable case.

Run ON the box, in Game Mode. Leaves the tile running; the caller then captures
the screen and exercises Close Game.

NOTE ON THE INSTALL PATH: the tile deliberately does NOT live in
~/.local/opt/couchside/. The shipped screensaver's _ss_appid() anchors its
shortcuts.vdf lookup on the literal b"couchside/Couchside", which a tile at
~/.local/opt/couchside/Couchside Player would ALSO match -- whichever entry came
first in the file would win and the screensaver's launch would break. Phase 1
inherits this constraint.
"""

import glob
import http.server
import json
import os
import struct
import subprocess
import sys
import threading
import time

CDP_PORT = 9333
HTTP_PORT = 9334
TILE_DIR = os.path.expanduser("~/.local/opt/couchside-player")
TILE = os.path.join(TILE_DIR, "Couchside Player")
VDF_ANCHOR = b"couchside-player/Couchside"
PROFILE = os.path.expanduser(
    "~/.var/app/com.google.Chrome/config/couchside-probe")
PIDFILE = os.path.expanduser("~/.cache/couchside/playertest.pid")

MPD = "https://storage.googleapis.com/shaka-demo-assets/angel-one-widevine/dash.mpd"
LICENSE = "https://cwip-shaka-proxy.appspot.com/no_auth"
SHAKA = "https://cdn.jsdelivr.net/npm/shaka-player@4/dist/shaka-player.compiled.js"

DRM_HTML = """<!doctype html><html><head><meta charset=utf-8>
<title>Couchside Player probe</title>
<script src="%s"></script>
<style>html,body{margin:0;height:100%%;background:#0b1220;overflow:hidden}
#v{width:100vw;height:100vh;object-fit:contain}
#b{position:fixed;left:0;right:0;top:0;font:600 34px system-ui;color:#e5e7eb;
   background:#111827;padding:14px 20px;letter-spacing:.5px}</style></head>
<body><div id="b">COUCHSIDE PLAYER — gamescope surfacing probe</div>
<video id="v" autoplay muted></video>
<script>
window.__st = {stage:"init", err:null, t:0, dur:0};
function go() {
  try {
    shaka.polyfill.installAll();
    var v = document.getElementById('v');
    var p = new shaka.Player(v);
    p.configure({drm: {servers: {'com.widevine.alpha': %s}}});
    window.__st.stage = "loading";
    p.load(%s).then(function () {
      window.__st.stage = "loaded"; return v.play();
    }).then(function () { window.__st.stage = "playing"; })
     .catch(function (e) {
       window.__st.stage = "error";
       window.__st.err = (e && (e.code || e.message || String(e))) + "";
     });
    setInterval(function () {
      window.__st.t = v.currentTime; window.__st.dur = v.duration || 0;
      document.getElementById('b').textContent =
        'COUCHSIDE PLAYER — widevine t=' + v.currentTime.toFixed(1) +
        's / ' + (v.duration || 0).toFixed(0) + 's';
    }, 250);
  } catch (e) { window.__st.stage = "throw"; window.__st.err = String(e); }
}
if (window.shaka) { go(); } else { window.addEventListener('load', go); }
</script></body></html>
""" % (SHAKA, json.dumps(LICENSE), json.dumps(MPD))

# The wrapper tile. This is the proto-player: Steam launches THIS, and it spawns
# Chrome as a child. exec is deliberately NOT used -- the real player needs to
# outlive nothing but also to stay as the process Steam is tracking, so it waits
# on the child and forwards SIGTERM, which is what a reaper will send.
WRAPPER = r"""#!/usr/bin/env bash
# Couchside Player -- Phase 0b wrapper probe (throwaway).
set -u
mkdir -p "$HOME/.cache/couchside"
echo $$ > "%(pidfile)s"

cleanup() {
  # Forward the reaper's signal to the flatpak instance. Q7 measures whether
  # this is NEEDED (i.e. whether the pgid kill alone leaves an orphan).
  echo "[wrapper] SIGTERM received at $(date +%%s)" >> /tmp/couchside-probe/wrapper.log
  exit 0
}
trap cleanup TERM INT

# MEASURED 2026-07-27: the ozone backend CANNOT be hardcoded. Under gamescope,
# Steam launches the tile with DISPLAY=:1 (gamescope's own XWayland) and NO
# WAYLAND_DISPLAY, so --ozone-platform=wayland dies with
#   "Failed to connect to Wayland display: No such file or directory"
# On the Plasma desktop the opposite holds: spawned from a non-graphical parent
# there is no xauth cookie, so the X11 backend dies instead. Pick per environment.
if [ -n "${WAYLAND_DISPLAY:-}" ]; then
  OZONE="--ozone-platform=wayland"
elif [ -n "${DISPLAY:-}" ]; then
  OZONE="--ozone-platform=x11"
else
  OZONE=""
fi

{
  echo "[wrapper] start $(date +%%s)"
  echo "[wrapper] pid=$$ pgid=$(ps -o pgid= -p $$ | tr -d ' ')"
  echo "[wrapper] WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-unset} XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-unset}"
  echo "[wrapper] DISPLAY=${DISPLAY:-unset} -> ozone: ${OZONE:-auto}"
} >> /tmp/couchside-probe/wrapper.log 2>&1

flatpak run com.google.Chrome \
  $OZONE \
  --user-data-dir="%(profile)s" \
  --no-first-run --no-default-browser-check \
  --remote-debugging-port=%(cdp)d \
  --start-fullscreen \
  --app=http://127.0.0.1:%(http)d/ \
  >> /tmp/couchside-probe/chrome.log 2>&1 &

CHILD=$!
echo "[wrapper] chrome child pid=$CHILD" >> /tmp/couchside-probe/wrapper.log
wait $CHILD
echo "[wrapper] chrome exited rc=$? at $(date +%%s)" >> /tmp/couchside-probe/wrapper.log
""" % {"pidfile": PIDFILE, "profile": PROFILE, "cdp": CDP_PORT, "http": HTTP_PORT}


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = DRM_HTML.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def find_appid():
    for p in glob.glob(os.path.expanduser(
            "~/.steam/steam/userdata/*/config/shortcuts.vdf")):
        try:
            with open(p, "rb") as f:
                data = f.read()
        except OSError:
            continue
        i = data.find(VDF_ANCHOR)
        if i < 0:
            continue
        seg = data[max(0, i - 300):i]
        j = seg.rfind(b"\x02appid\x00")
        if j >= 0 and j + 11 <= len(seg):
            return struct.unpack("<I", seg[j + 7:j + 11])[0]
    return None


def main():
    os.makedirs("/tmp/couchside-probe", exist_ok=True)
    os.makedirs(TILE_DIR, exist_ok=True)
    os.makedirs(os.path.dirname(PIDFILE), exist_ok=True)
    with open(TILE, "w") as f:
        f.write(WRAPPER)
    os.chmod(TILE, 0o755)
    print("tile written: %s" % TILE, flush=True)

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", HTTP_PORT), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print("probe page served on 127.0.0.1:%d" % HTTP_PORT, flush=True)

    env = dict(os.environ)
    env["XDG_RUNTIME_DIR"] = "/run/user/1000"

    appid = find_appid()
    fresh = appid is None
    if fresh:
        print("registering with steamos-add-to-steam ...", flush=True)
        subprocess.run(["steamos-add-to-steam", TILE], env=env, timeout=30,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 15
        while appid is None and time.monotonic() < deadline:
            time.sleep(1)
            appid = find_appid()
    if appid is None:
        print("FAIL: registration never appeared in shortcuts.vdf", flush=True)
        return 1
    gameid = (appid << 32) | 0x02000000
    print("appid=%d gameid=%d fresh=%s" % (appid, gameid, fresh), flush=True)

    def fire():
        subprocess.Popen(["steam", "steam://rungameid/%d" % gameid], env=env,
                         start_new_session=True, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL)

    fire()
    if fresh:
        # A shortcut's very first rungameid only opens its page (screensaver
        # lesson, SS_FIRST_LAUNCH_GAP_S).
        time.sleep(5)
        fire()

    print("launched; holding 150s so the caller can capture + reap", flush=True)
    for _ in range(150):
        time.sleep(1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
