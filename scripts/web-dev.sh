#!/usr/bin/env bash
# DEV ONLY. Drive the app's UI in a desktop browser against --mock agent data.
#
# Exports the web bundle, boots a mock agent, and serves both from ONE origin
# (see web-dev-proxy.py for why a proxy rather than CORS on the agent). Prints a
# URL and a localStorage snippet that points the app at itself.
#
#   scripts/web-dev.sh [port]        # default 8099
#
# WHAT THIS IS FOR: presentational work -- card layouts, empty/loading/error
# states, caps gating, theming, impact groupings. It renders payload states the
# hardware cannot produce on demand (a controller battery percentage, a hot GPU,
# a game running) so they can be checked without a TestFlight cycle.
#
# WHAT IT CANNOT COVER -- verify these on a real device:
#   * Pad / trackpad / gamepad: no WebSocket proxying, and mouse != touch
#   * iOS Local Network permission, and the no-UDP behaviour
#   * app backgrounding (iPhone Mirroring suspends WS sends)
#   * safe-area insets, status bar, keyboard avoidance
#   * ROW OVERFLOW. A <Text> inside a flexDirection:'row' gets CSS
#     flex-shrink:1 for free on web, so it always wraps; on NATIVE it does not
#     shrink unless you say flex:1, and a long label shoves its siblings off the
#     edge. Measured 2026-07-22: the setup-guide link overflowed on Android and
#     the harness reported ZERO overflow for the same code, before and after the
#     fix. Row layout has to be checked on a device.
#   * the purchase flow (expo-iap is a no-op on web by design)
# A web build that looks perfect says nothing about any of the above.
set -euo pipefail

PORT="${1:-8099}"
AGENT_PORT=$((PORT + 1))
TOKEN="web-dev-$RANDOM"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/app/dist"

# Ensure a working node/npx is on PATH. This is launched from contexts whose PATH
# may not include node (preview_start, CI, a bare login shell), where it used to
# die with "npx: command not found". Resolve one from the usual spots instead.
if ! command -v npx >/dev/null 2>&1; then
  for _nb in "$HOME"/actions-runner/externals*/node20/bin \
             "$HOME"/.nvm/versions/node/*/bin /opt/homebrew/bin /usr/local/bin; do
    if [ -x "$_nb/npx" ]; then PATH="$_nb:$PATH"; break; fi
  done
  export PATH
fi
command -v npx >/dev/null 2>&1 || {
  echo "error: node/npx not found. Install Node 18-20 or add it to PATH." >&2
  exit 127
}

cleanup() {
  [ -n "${AGENT_PID:-}" ] && kill "$AGENT_PID" 2>/dev/null || true
  [ -n "${PROXY_PID:-}" ] && kill "$PROXY_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "==> exporting the web bundle (this takes a minute)"
(cd "$ROOT/app" && npx expo export -p web >/dev/null)

# Auto-configure the mock box on first load. The box host is taken from
# location.hostname so it ALWAYS matches the origin the page is opened at:
# localhost and 127.0.0.1 are DIFFERENT origins, and since the app fetches an
# absolute http://<host>:<port> URL (lib/api.ts), a mismatch makes every request
# cross-origin -> the dev proxy sends no CORS -> the box shows "unreachable".
# Injected into the exported shell so no manual console paste is needed.
_seed="<script>try{if(!localStorage.getItem('couchpilot.boxes.v1')){localStorage.setItem('couchpilot.boxes.v1',JSON.stringify({boxes:[{id:'web-dev',name:'mock box',host:location.hostname,port:Number(location.port)||80,token:'$TOKEN',padMode:'trackpad'}],activeBoxId:'web-dev'}));location.reload();}}catch(e){}</script>"
DIST="$DIST" SEED="$_seed" python3 - <<'PY'
import glob, os
dist, seed = os.environ["DIST"], os.environ["SEED"]
for f in glob.glob(os.path.join(dist, "**", "*.html"), recursive=True):
    s = open(f, encoding="utf-8").read()
    if "couchpilot.boxes.v1" in s:
        continue                                   # already seeded (idempotent)
    s = s.replace("</body>", seed + "</body>", 1) if "</body>" in s else s + seed
    open(f, "w", encoding="utf-8").write(s)
PY

echo "==> starting mock agent on 127.0.0.1:$AGENT_PORT"
python3 "$ROOT/agent/couchsided.py" --mock --host 127.0.0.1 \
  --port "$AGENT_PORT" --token "$TOKEN" >/tmp/couchside-web-dev-agent.log 2>&1 &
AGENT_PID=$!

for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$AGENT_PORT/api/ping" >/dev/null 2>&1 && break
  sleep 0.3
done

echo "==> serving on http://127.0.0.1:$PORT"
python3 "$ROOT/scripts/web-dev-proxy.py" "$DIST" "$PORT" "127.0.0.1:$AGENT_PORT" "$TOKEN" &
PROXY_PID=$!

cat <<EOF

  Open:  http://127.0.0.1:$PORT   (or http://localhost:$PORT -- either works now)

  The mock box auto-configures on first load: its host is taken from the page's
  own origin, so it is always same-origin -- no console paste, no CORS. To
  re-seed manually, clear site data and reload, or paste:

localStorage.setItem('couchpilot.boxes.v1', JSON.stringify({
  boxes: [{ id: 'web-dev', name: 'mock box', host: location.hostname,
            port: $PORT, token: '$TOKEN', padMode: 'trackpad' }],
  activeBoxId: 'web-dev' }));

  Ctrl-C to stop both processes. Re-run after changing app code (no HMR --
  the bundle is a static export).

EOF

wait $PROXY_PID
