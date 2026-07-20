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
#   * the purchase flow (expo-iap is a no-op on web by design)
# A web build that looks perfect says nothing about any of the above.
set -euo pipefail

PORT="${1:-8099}"
AGENT_PORT=$((PORT + 1))
TOKEN="web-dev-$RANDOM"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/app/dist"

cleanup() {
  [ -n "${AGENT_PID:-}" ] && kill "$AGENT_PID" 2>/dev/null || true
  [ -n "${PROXY_PID:-}" ] && kill "$PROXY_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "==> exporting the web bundle (this takes a minute)"
(cd "$ROOT/app" && npx expo export -p web >/dev/null)

echo "==> starting mock agent on 127.0.0.1:$AGENT_PORT"
python3 "$ROOT/agent/couchsided.py" --mock --host 127.0.0.1 \
  --port "$AGENT_PORT" --token "$TOKEN" >/tmp/couchside-web-dev-agent.log 2>&1 &
AGENT_PID=$!

for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$AGENT_PORT/api/ping" >/dev/null 2>&1 && break
  sleep 0.3
done

echo "==> serving on http://127.0.0.1:$PORT"
python3 "$ROOT/scripts/web-dev-proxy.py" "$DIST" "$PORT" "127.0.0.1:$AGENT_PORT" &
PROXY_PID=$!

cat <<EOF

  Open:  http://127.0.0.1:$PORT

  The app starts with no box configured. Paste this in the browser console,
  then reload -- it points the app at this same origin, so the proxy forwards
  /api to the mock agent and no CORS is involved:

localStorage.setItem('couchpilot.boxes.v1', JSON.stringify({
  boxes: [{ id: 'web-dev', name: 'mock box', host: '127.0.0.1',
            port: $PORT, token: '$TOKEN', padMode: 'trackpad' }],
  activeBoxId: 'web-dev' }));

  Ctrl-C to stop both processes. Re-run after changing app code (no HMR --
  the bundle is a static export).

EOF

wait $PROXY_PID
