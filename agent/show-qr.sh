#!/usr/bin/env bash
# show-qr.sh: print the Couchside pairing QR code. Run FROM YOUR MAC/PC.
# Reads the agent token over ssh and renders a QR of the app deep link:
#   couchside://setup?host=<host>&port=8787&token=<token>
# Usage: ./show-qr.sh user@host      e.g. ./show-qr.sh deck@steamdeck.local
set -euo pipefail

ARG=${1:-}
if [[ -z "${ARG}" ]]; then
    echo "usage: ./show-qr.sh user@host   (e.g. deck@steamdeck.local)" >&2
    exit 2
fi
if [[ "${ARG}" == *@* ]]; then
    DEST="${ARG}"          # ssh destination (user@host)
    HOST="${ARG#*@}"       # bare host for the URL
else
    DEST="${ARG}"
    HOST="${ARG}"
fi

# Token file is owned by the agent user (mode 600), so a plain cat works: no sudo/TTY.
TOKEN=$(ssh "${DEST}" 'cat /etc/couchside/token')

PAIR_URL="couchside://setup?host=${HOST}&port=8787&token=${TOKEN}"
echo "Scan with your phone camera to configure the app:"
echo
if command -v qrencode > /dev/null 2>&1; then
    qrencode -t ansiutf8 "${PAIR_URL}"
elif command -v npx > /dev/null 2>&1; then
    # no -t flag: the qrcode CLI's default renderer draws in the terminal
    npx --yes qrcode "${PAIR_URL}" || echo "${PAIR_URL}"
else
    echo "${PAIR_URL}"
fi
