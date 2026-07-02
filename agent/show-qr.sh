#!/usr/bin/env bash
# show-qr.sh — print the Rescue Remote pairing QR code. Run FROM THE MAC.
# Reads the agent token over ssh and renders a QR of the app deep link:
#   rescueremote://setup?host=<host>&port=8787&token=<token>
# Usage: ./show-qr.sh [host|user@host]   (default: bazzite@bazzite.local)
set -euo pipefail

ARG=${1:-bazzite.local}
if [[ "${ARG}" == *@* ]]; then
    DEST="${ARG}"          # ssh destination (user@host)
    HOST="${ARG#*@}"       # bare host for the URL
else
    DEST="bazzite@${ARG}"
    HOST="${ARG}"
fi

# Token file is owned by user bazzite (mode 600), so a plain cat works — no sudo/TTY.
TOKEN=$(ssh "${DEST}" 'cat /etc/rescue-agent/token')

PAIR_URL="rescueremote://setup?host=${HOST}&port=8787&token=${TOKEN}"
echo "Scan with iPhone camera to configure the app:"
echo
if command -v npx > /dev/null 2>&1; then
    # no -t flag: the qrcode CLI's default renderer draws in the terminal
    npx --yes qrcode "${PAIR_URL}" || echo "${PAIR_URL}"
else
    echo "${PAIR_URL}"
fi
