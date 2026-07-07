#!/usr/bin/env bash
# Install the Couchside HDMI-CEC bridge on a Raspberry Pi (or any Debian box
# wired to the TV's HDMI). Run WITH sudo on the Pi:
#
#   sudo ./install-cec-bridge.sh [PORT]     # default port 8799
#
# It installs cec-utils, drops the bridge to /opt/couchside-cec, generates a
# bearer token, and enables a systemd service. Prints the host + token to put
# in the Couchside agent's `cec_bridge` config. Idempotent (keeps the token).
set -euo pipefail

PORT="${1:-8799}"
INSTALL_DIR=/opt/couchside-cec
DATA_DIR=/etc/couchside-cec
UNIT=/etc/systemd/system/couchside-cec-bridge.service
RAW=https://raw.githubusercontent.com/emerytech/couchside/main/cec-bridge/couchside-cec-bridge.py

if [ "$(id -u)" -ne 0 ]; then
  echo "run with sudo: sudo $0 $*" >&2; exit 1
fi

echo "==> installing CEC tooling + python3 (best-effort; cec-ctl ships with RPi OS)"
export DEBIAN_FRONTEND=noninteractive
apt-get update || true
# v4l-utils gives cec-ctl (kernel CEC, the reliable path on a Pi's /dev/cec*);
# cec-utils gives cec-client (libcec). Neither failing is fatal if one exists.
apt-get install -y v4l-utils python3 curl || true
apt-get install -y cec-utils || true

# Prefer the kernel cec-ctl path when a /dev/cec* node + cec-ctl exist (verified
# reliable on the Pi); else let the bridge auto-detect (cec-client/libcec).
TOOL=auto
if command -v cec-ctl >/dev/null 2>&1 && ls /dev/cec* >/dev/null 2>&1; then
  TOOL=cec-ctl
fi
if ! command -v cec-ctl >/dev/null 2>&1 && ! command -v cec-client >/dev/null 2>&1; then
  echo "error: no CEC tool (cec-ctl or cec-client) available" >&2; exit 1
fi
echo "==> CEC tool: $TOOL"

echo "==> installing bridge to $INSTALL_DIR"
install -d "$INSTALL_DIR"
SRC="$(cd "$(dirname "$0")" && pwd)/couchside-cec-bridge.py"
if [ -f "$SRC" ]; then
  install -m 0755 "$SRC" "$INSTALL_DIR/couchside-cec-bridge.py"
else
  curl -fsSL "$RAW" -o "$INSTALL_DIR/couchside-cec-bridge.py"
  chmod 0755 "$INSTALL_DIR/couchside-cec-bridge.py"
fi
python3 -m py_compile "$INSTALL_DIR/couchside-cec-bridge.py"

echo "==> token (kept across reinstalls)"
install -d -m 0755 "$DATA_DIR"
if [ ! -f "$DATA_DIR/token" ]; then
  head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$DATA_DIR/token"
  chmod 600 "$DATA_DIR/token"
fi

echo "==> systemd unit ($UNIT)"
cat > "$UNIT" <<EOF
[Unit]
Description=Couchside HDMI-CEC bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 $INSTALL_DIR/couchside-cec-bridge.py --port $PORT --token-file $DATA_DIR/token --tool $TOOL
Restart=always
RestartSec=3
# CEC needs the /dev/cec* / VideoCore device (group video); root is simplest on
# a single-purpose appliance, but a video-group user works too.
User=root

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now couchside-cec-bridge.service
sleep 1
systemctl --no-pager --lines=0 status couchside-cec-bridge.service || true

echo
echo "=================================================================="
echo " Couchside CEC bridge installed."
echo "   host:  $(hostname).local   (or this Pi's LAN IP)"
echo "   port:  $PORT"
echo "   token: $(cat "$DATA_DIR/token")"
echo
echo " Put these in the Couchside agent's config.json on the box:"
echo '   "cec_bridge": { "host": "'"$(hostname)"'.local", "port": '"$PORT"', "token": "'"$(cat "$DATA_DIR/token")"'" }'
echo " Then restart the agent. Test locally on the Pi:"
echo "   curl -s localhost:$PORT/api/ping"
echo "=================================================================="
