#!/usr/bin/env bash
# deploy.sh — deploy the Rescue Remote box agent to the HTPC. Run FROM THE MAC.
# Usage: ./deploy.sh [host|user@host]   (default: bazzite@bazzite.local; fallback IP: 10.1.1.60)
set -euo pipefail

ARG=${1:-bazzite.local}
if [[ "${ARG}" == *@* ]]; then
    DEST="${ARG}"          # ssh/scp destination (user@host)
    HOST="${ARG#*@}"       # bare host for URLs
else
    DEST="bazzite@${ARG}"
    HOST="${ARG}"
fi
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE_APP_DIR='~/.local/opt/rescue-agent'

echo "==> Deploying rescue-agent to ${HOST}"

echo "==> Copying files to ${HOST}"
scp "${SRC_DIR}/rescue_agentd.py" "${SRC_DIR}/rescue-agent.service" "${DEST}:/tmp/"

echo "==> Installing agent, token, sudoers rule, systemd unit, and firewall rule on ${HOST}"
echo "    (sudo on the box may prompt for the bazzite password)"
INSTALL_SCRIPT="$(mktemp)"
trap 'rm -f "${INSTALL_SCRIPT}"' EXIT
cat > "${INSTALL_SCRIPT}" <<'REMOTE'
set -euo pipefail

echo "  -> Installing agent to ~/.local/opt/rescue-agent"
mkdir -p ~/.local/opt/rescue-agent
install -m 0755 /tmp/rescue_agentd.py ~/.local/opt/rescue-agent/rescue_agentd.py

echo "  -> Ensuring /etc/rescue-agent exists"
sudo mkdir -p /etc/rescue-agent

if sudo test -s /etc/rescue-agent/token; then
    echo "  -> Token already exists, keeping it"
else
    echo "  -> Generating new token"
    openssl rand -hex 24 | sudo tee /etc/rescue-agent/token > /dev/null
fi
# Daemon (and this script) read the token as user bazzite — enforce every run.
sudo chmod 600 /etc/rescue-agent/token
sudo chown bazzite /etc/rescue-agent/token

echo "  -> Installing sudoers rule (NOPASSWD for the daemon's privileged commands)"
cat > /tmp/rescue-agent-sudoers <<'SUDOERS'
# rescue-agent: allow the daemon (User=bazzite, no TTY) to run exactly the
# privileged commands the Rescue Remote agent needs, without a password.
bazzite ALL=(root) NOPASSWD: /usr/bin/systemctl restart sddm
bazzite ALL=(root) NOPASSWD: /usr/bin/systemctl reboot
bazzite ALL=(root) NOPASSWD: /usr/bin/systemctl poweroff
bazzite ALL=(root) NOPASSWD: /usr/bin/journalctl *
SUDOERS
sudo visudo -cf /tmp/rescue-agent-sudoers
sudo install -m 0440 -o root -g root /tmp/rescue-agent-sudoers /etc/sudoers.d/rescue-agent
rm -f /tmp/rescue-agent-sudoers

echo "  -> Installing systemd unit"
sudo install -m 0644 /tmp/rescue-agent.service /etc/systemd/system/rescue-agent.service
sudo systemctl daemon-reload
sudo systemctl enable rescue-agent.service
# restart (not `enable --now`) so re-deploys replace the running process too
sudo systemctl restart rescue-agent.service

echo "  -> Opening 8787/tcp in firewalld"
sudo firewall-cmd --add-port=8787/tcp --permanent
sudo firewall-cmd --reload

rm -f /tmp/rescue_agentd.py /tmp/rescue-agent.service /tmp/rescue-agent-install.sh
REMOTE

# Run the install via a real TTY (ssh -t) so sudo can prompt for a password —
# piping a heredoc into `ssh bash -s` gives sudo no terminal and the deploy
# would abort at the first sudo on default (password-required) sudoers.
scp "${INSTALL_SCRIPT}" "${DEST}:/tmp/rescue-agent-install.sh"
ssh -t "${DEST}" 'bash /tmp/rescue-agent-install.sh'

echo "==> Waiting for agent to come up"
sleep 2

echo "==> Probing http://${HOST}:8787/api/ping"
curl -fsS "http://${HOST}:8787/api/ping"
echo

# Token file is owned by bazzite (chown'd above), so no sudo/TTY needed here.
TOKEN=$(ssh "${DEST}" 'cat /etc/rescue-agent/token')
echo
echo "============================================================"
echo " Rescue agent deployed and running on ${HOST}:8787"
echo
echo " TOKEN: ${TOKEN}"
echo
echo " Paste this token into the Rescue Remote app settings"
echo " (Authorization: Bearer <token>)."
echo "============================================================"

PAIR_URL="rescueremote://setup?host=${HOST}&port=8787&token=${TOKEN}"
echo
echo "Scan with iPhone camera to configure the app:"
echo
if command -v npx > /dev/null 2>&1; then
    # no -t flag: the qrcode CLI's default renderer draws in the terminal
    npx --yes qrcode "${PAIR_URL}" || echo "${PAIR_URL}"
else
    echo "${PAIR_URL}"
fi
