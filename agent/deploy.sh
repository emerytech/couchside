#!/usr/bin/env bash
# deploy.sh: DEVELOPMENT helper: push this checkout to a box and run install.sh
# there. Run FROM YOUR MAC/PC. End users should not use this; they use:
#
#   curl -fsSL https://raw.githubusercontent.com/emerytech/couchside/main/install.sh | bash
#
# Usage: ./deploy.sh user@host [install.sh flags...]
#        e.g. ./deploy.sh deck@steamdeck.local
#             ./deploy.sh bazzite@bazzite.local --no-sudoers
set -euo pipefail

DEST=${1:-}
if [[ -z "${DEST}" ]]; then
    echo "usage: ./deploy.sh user@host [install.sh flags...]" >&2
    exit 2
fi
shift

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # repo root
REMOTE_DIR="/tmp/couchside-deploy"

echo "==> Copying checkout to ${DEST}:${REMOTE_DIR}"
ssh "${DEST}" "rm -rf '${REMOTE_DIR}' && mkdir -p '${REMOTE_DIR}/agent'"
scp "${SRC_DIR}/install.sh" "${DEST}:${REMOTE_DIR}/install.sh"
scp "${SRC_DIR}/agent/couchsided.py" "${SRC_DIR}/agent/couchside.service" \
    "${DEST}:${REMOTE_DIR}/agent/"

# Run install.sh via a real TTY (ssh -t) so sudo on the box can prompt.
echo "==> Running install.sh on ${DEST} (sudo may prompt for your password)"
ssh -t "${DEST}" "bash '${REMOTE_DIR}/install.sh' $*"
