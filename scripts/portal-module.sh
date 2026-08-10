#!/usr/bin/env bash
# Couchside remote-desktop PORTAL MODULE — opt-in install / uninstall.
#
# The base agent stays pure-stdlib and the base install.sh is untouched; this is
# the SEPARATE opt-in step (like the privileged helper / a ujust recipe) that
# turns on absolute tap-to-point + fluid /ws/screen streaming. It runs as the
# USER (no root, no sudo): the portal, PipeWire and Wayland are all the user's.
#
#   scripts/portal-module.sh install     # verify deps, install helper + user unit, enable
#   scripts/portal-module.sh uninstall   # disable + remove everything it installed
#   scripts/portal-module.sh status      # is it installed + running?
#
# On immutable distros (Bazzite/SteamOS) there is no usable package step, so this
# VERIFIES the system deps (which the KDE desktop already ships) and refuses
# honestly if any are missing — it never pretends to install what it cannot.
set -euo pipefail

INSTALL_DIR="${HOME}/.local/opt/couchside"
UNIT_DIR="${HOME}/.config/systemd/user"
UNIT="couchside-portal.service"
HELPER="couchside-portal.py"
RUNTIME="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
SOCK="${RUNTIME}/couchside/portal.sock"

# Where the module files (couchside-portal.py + couchside-portal.service) live:
# next to this script (a released bundle), else <repo>/agent.
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${PORTAL_SRC:-}"
if [ -z "${SRC}" ]; then
  if [ -f "${SELF_DIR}/${HELPER}" ]; then SRC="${SELF_DIR}"
  elif [ -f "${SELF_DIR}/../agent/${HELPER}" ]; then SRC="$(cd "${SELF_DIR}/../agent" && pwd)"
  else SRC="${SELF_DIR}"; fi
fi

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

check_deps() {
  local missing=()
  python3 -c 'import gi; gi.require_version("Gio","2.0"); from gi.repository import GLib, Gio' 2>/dev/null \
    || missing+=("python3 gobject bindings (python3-gobject / gi + Gio)")
  command -v gst-launch-1.0 >/dev/null 2>&1 || missing+=("gstreamer (gst-launch-1.0)")
  gst-inspect-1.0 pipewiresrc >/dev/null 2>&1 || missing+=("gstreamer pipewiresrc (gstreamer1-plugin-pipewire)")
  gst-inspect-1.0 jpegenc   >/dev/null 2>&1 || missing+=("gstreamer jpegenc (gstreamer1-plugins-good)")
  # PipeWire: a running socket under the runtime dir is the honest signal.
  ls "${RUNTIME}"/pipewire-* >/dev/null 2>&1 || missing+=("a running PipeWire (pipewire)")
  if [ "${#missing[@]}" -ne 0 ]; then
    say "This box is missing system dependencies the portal module needs:"
    printf '  - %s\n' "${missing[@]}"
    say ""
    say "On a KDE desktop (Bazzite/SteamOS Desktop Mode) these normally ship already."
    say "Install them with your distro's package manager (they are NOT bundled), then re-run."
    die "dependencies missing"
  fi
}

cmd_install() {
  [ -f "${SRC}/${HELPER}" ] || die "cannot find ${HELPER} (looked in ${SRC}); set PORTAL_SRC"
  [ -f "${SRC}/${UNIT}" ]   || die "cannot find ${UNIT} (looked in ${SRC}); set PORTAL_SRC"
  say "Verifying dependencies..."
  check_deps
  say "Installing helper -> ${INSTALL_DIR}/${HELPER}"
  install -Dm0755 "${SRC}/${HELPER}" "${INSTALL_DIR}/${HELPER}"
  say "Installing user unit -> ${UNIT_DIR}/${UNIT}"
  mkdir -p "${UNIT_DIR}"
  sed "s#__PORTAL__#${INSTALL_DIR}/${HELPER}#g" "${SRC}/${UNIT}" > "${UNIT_DIR}/${UNIT}"
  systemctl --user daemon-reload
  systemctl --user enable --now "${UNIT}"
  # The helper binds its socket a moment after start (gi import + D-Bus connect);
  # wait briefly so `status` below reports honestly rather than racing the bind.
  for _ in 1 2 3 4 5 6; do [ -S "${SOCK}" ] && break; sleep 0.5; done
  say ""
  say "Portal module installed and running."
  say "The FIRST time the phone opens the fluid desktop view, your box will show a"
  say "'Remote Control' dialog (See what's on the screen + Control input devices) —"
  say "click Approve. On this KDE version consent is asked once per session."
  cmd_status || true
}

cmd_uninstall() {
  systemctl --user disable --now "${UNIT}" 2>/dev/null || true
  rm -f "${UNIT_DIR}/${UNIT}"
  rm -f "${INSTALL_DIR}/${HELPER}"
  rm -f "${SOCK}"
  systemctl --user daemon-reload 2>/dev/null || true
  say "Portal module removed (helper, user unit, socket)."
}

cmd_status() {
  local active; active="$(systemctl --user is-active "${UNIT}" 2>/dev/null || echo inactive)"
  say "unit ${UNIT}: ${active}"
  if [ -S "${SOCK}" ]; then say "socket: ${SOCK} present"; else say "socket: absent"; fi
  [ "${active}" = "active" ]
}

case "${1:-}" in
  install)   cmd_install ;;
  uninstall) cmd_uninstall ;;
  status)    cmd_status ;;
  *) die "usage: $0 {install|uninstall|status}" ;;
esac
