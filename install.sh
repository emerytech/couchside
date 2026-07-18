#!/usr/bin/env bash
# install.sh: Couchside box agent installer.
#
# Run this ON the box (SteamOS / Bazzite), as your normal desktop user:
#
#   curl -fsSL https://couchside.tv/install.sh | bash
#
# Or from a git checkout:  ./install.sh
#
# Flags:
#   --no-sudoers   skip installing /etc/sudoers.d/couchside (high-danger
#                  actions and system journal reads will fail without it)
#   --uninstall    remove the agent (asks before deleting the token/sudoers)
#   --help         this text
set -euo pipefail

# Partial-download guard: the ENTIRE installer runs inside this brace group, so
# `curl … | bash` must have received the closing brace — i.e. the whole file —
# before bash executes a single command. A connection dropped mid-download fails
# to parse (no closing brace) and runs NOTHING, instead of executing a truncated,
# half-configured install. The matching `}` is the last line of this file.
{

# Agent file sources (used when not running from a git checkout). These are the
# maintainer-SIGNED release assets — NOT mutable `main` — so `couchside update`
# fetches a pinned, authenticated agent. releases/latest resolves to the newest
# published release; each carries these files + a SHA256SUMS signed with the
# offline key (see scripts/release-agent.sh). install.sh verifies the signature
# (against RELEASE_PUBKEY_PEM below) AND each file's hash before installing.
AGENT_BASE="https://github.com/emerytech/couchside/releases/latest/download"
DAEMON_URL="${AGENT_BASE}/couchsided.py"
UNIT_URL="${AGENT_BASE}/couchside.service"
# Pure-stdlib terminal QR renderer, so the installer can draw the pairing QR
# without qrencode (immutable distros like Bazzite rarely ship it). Optional:
# a failed fetch just falls back to printing the URL.
QR_URL="${AGENT_BASE}/qr.py"
# Aerial-screensaver player script (agent's /api/screensaver launches it via a
# Steam shortcut). Optional: a failed fetch just means the feature stays absent.
SCREENSAVER_URL="${AGENT_BASE}/couchside-screensaver.sh"
# Signature + checksums for the agent files above, published as sibling assets
# in the SAME release. install.sh verifies the sig (authenticity) + hashes
# (integrity) before installing any fetched agent file.
AGENT_SUMS_URL="${AGENT_BASE}/SHA256SUMS"
AGENT_SIG_URL="${AGENT_BASE}/SHA256SUMS.sig"
# Built Decky Loader plugin, shipped as a tarball because the compiled frontend
# (dist/) isn't checked into git, so raw source wouldn't give a working panel.
PLUGIN_URL="https://github.com/emerytech/couchside-decky/releases/latest/download/Couchside.tar.gz"
# Checksum for the tarball above, published as a sibling asset in the SAME
# release. Verifying against it guards against a corrupted/truncated download,
# transport tampering, or a swapped-in Couchside.tar.gz asset. Note: because the
# sums file comes from the same release, this is integrity, NOT full authenticity
# — a signing key + branch protection would be needed to prove the release itself
# wasn't produced maliciously (out of scope here).
PLUGIN_SUMS_URL="https://github.com/emerytech/couchside-decky/releases/latest/download/SHA256SUMS"
PLUGIN_SIG_URL="https://github.com/emerytech/couchside-decky/releases/latest/download/SHA256SUMS.sig"
# Ed25519 public keys for verifying that SHA256SUMS was signed by the maintainer.
# The matching SECRET keys are held OFFLINE (never in CI), so a compromised
# repo/CI/account cannot forge a signature. These halves are public — safe to
# embed. A signature from EITHER key is accepted: the BACKUP is a cold rollover
# key, so if the primary is ever lost or compromised the maintainer can sign
# with the backup WITHOUT locking out already-installed boxes.
# Signed with: openssl pkeyutl -sign -rawin (see scripts/sign-release.sh).
RELEASE_PUBKEY_PEM='-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA+9aBnheHC7N3J9JNfkP2PoBf89SCkBxmqlZ/2lrcwGA=
-----END PUBLIC KEY-----'
RELEASE_PUBKEY_PEM_BACKUP='-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAtW4oYkhFGiWZ8nM8u3ldwecPekFQHdabdTI807VoUmE=
-----END PUBLIC KEY-----'

# Verify SHA256SUMS file ($1) against its detached signature ($2) using EITHER
# release key. Prints nothing; returns:
#   0 = a good signature from one of the keys (authentic)
#   1 = present but BOTH keys rejected it (tampering) — caller must abort
#   2 = openssl can't do Ed25519 -rawin (too old) — caller falls back to hashes
verify_release_sig() {
    command -v openssl >/dev/null 2>&1 || return 2
    local sums="$1" sig="$2" pub out tmpd saw_fail=0
    tmpd="$(mktemp -d)"
    for pub in "$RELEASE_PUBKEY_PEM" "$RELEASE_PUBKEY_PEM_BACKUP"; do
        [ -n "$pub" ] || continue
        printf '%s\n' "$pub" > "$tmpd/k.pub"
        out="$(openssl pkeyutl -verify -pubin -inkey "$tmpd/k.pub" -rawin \
                -in "$sums" -sigfile "$sig" 2>&1 || true)"
        if printf '%s' "$out" | grep -qi 'Verified Successfully'; then
            rm -rf "$tmpd"; return 0
        elif printf '%s' "$out" | grep -qi 'Verification Failure'; then
            saw_fail=1
        fi
    done
    rm -rf "$tmpd"
    [ "$saw_fail" -eq 1 ] && return 1 || return 2
}

PORT_DEFAULT=8787
INSTALL_DIR="${HOME}/.local/opt/couchside"
ETC_DIR="/etc/couchside"
TOKEN_FILE="${ETC_DIR}/token"
CONFIG_FILE="${ETC_DIR}/config.json"
# Fixed-argument, root-owned wrapper for system-journal reads. The sudoers rule
# grants ONLY this script (no wildcards); it validates its inputs and calls
# journalctl with a locked-down option set, so --file/--directory can't be
# injected to read arbitrary files as root. Lives in the root-owned ETC_DIR so
# the desktop user can execute but never modify it.
JOURNAL_WRAPPER="${ETC_DIR}/couchside-journal"
SUDOERS_FILE="/etc/sudoers.d/couchside"
UNIT_DST="/etc/systemd/system/couchside.service"

# Decky Loader's plugin directory (root-owned). The optional Game Mode panel is
# installed here when Decky is present, and removed from here on --uninstall.
DECKY_PLUGINS="${HOME}/homebrew/plugins"
DECKY_PLUGIN_DIR="${DECKY_PLUGINS}/Couchside"

# Pairing-QR launcher: a script that opens http://localhost:PORT/pair full-screen
# on the box's own display, plus a .desktop entry to add it to Steam (Game Mode).
PAIR_SCRIPT="${INSTALL_DIR}/couchside-pair"
PAIR_DESKTOP="${HOME}/.local/share/applications/couchside-pair.desktop"

# Prior installs to migrate FROM, oldest first. The chain is:
#   rescue-agent  ->  couchpilot  ->  couchside
# Each entry is "etc_dir|unit|sudoers"; the migration step below retires every
# one it finds, copying the first token it sees into TOKEN_FILE (so paired
# phones keep working) and disabling/removing the old unit + sudoers rule.
OLD_INSTALLS=(
    "/etc/rescue-agent|rescue-agent.service|/etc/sudoers.d/rescue-agent"
    "/etc/couchpilot|couchpilot.service|/etc/sudoers.d/couchpilot"
)

NO_SUDOERS=0
UNINSTALL=0
NO_DECKY=0

usage() {
    cat <<'USAGE'
Couchside box agent installer. Run ON the box as your desktop user.

Usage: install.sh [--no-sudoers] [--no-decky] [--uninstall] [--help]

  (no flags)     install/upgrade the agent (idempotent, safe to re-run)
  --no-sudoers   skip installing /etc/sudoers.d/couchside (high-danger
                 actions and system journal reads will fail without it)
  --no-decky     skip the Decky Loader Game Mode panel even if Decky is found
  --uninstall    remove the agent (asks before deleting the token/sudoers)
  --help         this text
USAGE
}

for arg in "$@"; do
    case "$arg" in
        --no-sudoers) NO_SUDOERS=1 ;;
        --no-decky)   NO_DECKY=1 ;;
        --uninstall)  UNINSTALL=1 ;;
        --help|-h)    usage; exit 0 ;;
        *) echo "error: unknown flag: $arg" >&2; usage >&2; exit 2 ;;
    esac
done

say()  { echo "==> $*"; }
note() { echo "    $*"; }
die()  { echo "error: $*" >&2; exit 1; }

ask_yn() {
    # ask_yn "question" -> returns 0 for yes. Reads from the tty so it works
    # even when the script itself came in on stdin (curl | bash).
    local reply
    if [ -r /dev/tty ]; then
        read -r -p "$1 [y/N] " reply < /dev/tty || reply=""
    else
        reply=""  # non-interactive: default to "no" (keep the files)
    fi
    [[ "$reply" == [yY]* ]]
}

deregister_steam_shortcut() {
    # Remove the "Couchside — Pair Phone" tile from every Steam account's
    # shortcuts.vdf (symmetric with register_steam_shortcut, used on --uninstall).
    # If a pristine .couchside-bak backup exists, restore it verbatim; otherwise
    # surgically drop our entry and reserialize. Steam only reads shortcuts.vdf at
    # startup and rewrites it on exit, so edits while Steam runs are lost — note
    # that and continue (best-effort, never fatal).
    local steamroot=""
    for d in "$HOME/.local/share/Steam" "$HOME/.steam/steam" \
             "$HOME/.var/app/com.valvesoftware.Steam/data/Steam"; do
        [ -d "$d/userdata" ] && { steamroot="$(cd "$d" && pwd -P)"; break; }
    done
    if [ -z "$steamroot" ]; then
        return 0
    fi
    if pgrep -x steam >/dev/null 2>&1; then
        note "Steam is running; it rewrites shortcuts.vdf on exit. Close Steam and"
        note "re-run --uninstall if the 'Couchside — Pair Phone' tile lingers."
    fi

    STEAMROOT="$steamroot" python3 - <<'PYVDF'
# Remove our non-Steam shortcut from shortcuts.vdf (binary VDF, pure stdlib).
# Prefer restoring the pristine .couchside-bak; else drop our entry in place.
import os, struct

APPNAME = "Couchside — Pair Phone"
STEAMROOT = os.environ["STEAMROOT"]


def parse_map(buf, pos):
    out = {}
    while True:
        t = buf[pos]; pos += 1
        if t == 0x08:
            return out, pos
        end = buf.index(b"\x00", pos)
        key = buf[pos:end].decode("utf-8", "replace"); pos = end + 1
        if t == 0x00:
            val, pos = parse_map(buf, pos)
        elif t == 0x01:
            end = buf.index(b"\x00", pos)
            val = buf[pos:end].decode("utf-8", "replace"); pos = end + 1
        elif t == 0x02:
            val = struct.unpack_from("<i", buf, pos)[0]; pos += 4
        else:
            raise ValueError("unknown VDF field type 0x%02x" % t)
        out[key] = val


def ser_map(m):
    out = bytearray()
    for k, v in m.items():
        kb = k.encode("utf-8")
        if isinstance(v, dict):
            out += b"\x00" + kb + b"\x00" + ser_map(v)
        elif isinstance(v, int):
            out += b"\x02" + kb + b"\x00" + struct.pack("<i", v)
        else:
            out += b"\x01" + kb + b"\x00" + str(v).encode("utf-8") + b"\x00"
    out += b"\x08"
    return bytes(out)


def is_ours(entry):
    if not isinstance(entry, dict):
        return False
    name = entry.get("AppName", entry.get("appname", ""))
    return isinstance(name, str) and name.strip().lower() == APPNAME.strip().lower()


udir = os.path.join(STEAMROOT, "userdata")
if not os.path.isdir(udir):
    raise SystemExit(0)
for acct in sorted(os.listdir(udir)):
    if not acct.isdigit() or acct == "0":
        continue
    cfg = os.path.join(udir, acct, "config")
    path = os.path.join(cfg, "shortcuts.vdf")
    bak = path + ".couchside-bak"
    if not os.path.exists(path):
        continue
    # Surgically remove ONLY our entry and reserialize. Do NOT restore the
    # pristine .couchside-bak verbatim as the preferred path: Steam rewrites
    # shortcuts.vdf on exit, so the backup lacks any non-Steam tiles the user
    # added AFTER install — restoring it would silently wipe them. The backup is
    # kept only as a last-resort fallback when the live file can't be parsed.
    with open(path, "rb") as f:
        buf = f.read()
    root = None
    try:
        root, _ = parse_map(buf, 0)
    except Exception as e:
        print("    ! %s: could not parse (%s)" % (path, e))
    # Edit in place only if we parsed it AND can reproduce it byte-for-byte.
    if root is not None and isinstance(root.get("shortcuts"), dict) and ser_map(root) == buf:
        shortcuts = root["shortcuts"]
        ours = [k for k, v in shortcuts.items() if is_ours(v)]
        if ours:
            for k in ours:
                del shortcuts[k]
            # Renumber remaining entries to keep the 0..N-1 index Steam expects.
            kept = [shortcuts[k] for k in sorted(shortcuts, key=lambda x: int(x)
                                                 if x.isdigit() else 1 << 30)]
            root["shortcuts"] = {str(i): v for i, v in enumerate(kept)}
            tmp = path + ".couchside-tmp"
            with open(tmp, "wb") as f:
                f.write(ser_map(root))
            os.replace(tmp, path)
            print("    - account %s: removed the Couchside tile" % acct)
    elif os.path.exists(bak):
        # Live file unparseable/unreproducible: fall back to the pristine backup.
        tmp = path + ".couchside-tmp"
        with open(bak, "rb") as bf, open(tmp, "wb") as tf:
            tf.write(bf.read())
        os.replace(tmp, path)
        print("    = account %s: unparseable live file; restored pre-Couchside backup" % acct)
    else:
        print("    ! %s: could not edit and no backup, leaving it alone" % path)
        continue
    # The pristine backup has served its purpose; drop it so a later reinstall
    # re-captures a fresh one.
    if os.path.exists(bak):
        try:
            os.remove(bak)
        except OSError:
            pass
PYVDF
}

# ---------------------------------------------------------------------------
# (a) Preflight checks
# ---------------------------------------------------------------------------
if [ "$(id -u)" -eq 0 ]; then
    die "do not run this as root. Run it as your normal desktop user (deck,
       bazzite, ...). The agent runs as that user and the script uses sudo
       only for the few steps that need it."
fi
command -v python3 >/dev/null 2>&1 || die "python3 not found. Couchside needs
       python3 (preinstalled on SteamOS and Bazzite). Install it and re-run."
command -v systemctl >/dev/null 2>&1 || die "systemctl not found: Couchside requires a systemd distro."

USER_NAME="$(id -un)"
USER_UID="$(id -u)"

# Heads-up for the Steam Deck's most common snag: a fresh Deck's "deck" user
# has no password, so sudo can't authenticate until one is set.
if ! sudo -n true 2>/dev/null; then
    note "The next steps use sudo and will prompt for your password."
    note "On a fresh Steam Deck the 'deck' user has NO password yet. If sudo"
    note "rejects you, run 'passwd' to set one, then re-run this installer."
fi

# ---------------------------------------------------------------------------
# --uninstall
# ---------------------------------------------------------------------------
if [ "$UNINSTALL" -eq 1 ]; then
    say "Uninstalling Couchside agent (sudo may prompt for your password)"
    sudo systemctl disable --now couchside.service 2>/dev/null || true
    sudo rm -f "$UNIT_DST"
    sudo systemctl daemon-reload
    note "removed couchside.service"
    rm -rf "$INSTALL_DIR"
    note "removed $INSTALL_DIR (incl. the couchside-pair launcher script)"
    rm -f "${HOME}/.local/bin/couchside"
    note "removed the couchside command"
    rm -f "$PAIR_DESKTOP"
    note "removed $PAIR_DESKTOP"
    # Symmetric with install: pull the "Couchside — Pair Phone" tile out of every
    # Steam account's shortcuts.vdf so uninstall doesn't leave a dead tile.
    deregister_steam_shortcut || note "couldn't clean the Steam tile (skipping)"
    sudo rm -f /etc/systemd/network/50-couchside-wol.link
    note "removed the Wake-on-LAN .link file"
    # Drop the journal wrapper explicitly so a KEPT $ETC_DIR doesn't retain it.
    sudo rm -f "$JOURNAL_WRAPPER"
    sudo rm -f /etc/udev/rules.d/99-couchside-uinput.rules \
               /etc/udev/rules.d/99-couchside-rtc.rules \
               /etc/modules-load.d/couchside-uinput.conf
    sudo udevadm control --reload-rules 2>/dev/null || true
    note "removed the udev/modules-load drop-ins"
    if [ "$NO_DECKY" -eq 0 ] && sudo test -d "$DECKY_PLUGIN_DIR"; then
        sudo rm -rf "$DECKY_PLUGIN_DIR"
        sudo systemctl restart plugin_loader.service 2>/dev/null || true
        note "removed the Decky Loader Game Mode panel"
    fi
    if sudo test -e "$ETC_DIR"; then
        if ask_yn "Remove $ETC_DIR (pairing token + config; phones will need re-pairing)?"; then
            sudo rm -rf "$ETC_DIR"
            note "removed $ETC_DIR"
        else
            note "kept $ETC_DIR"
        fi
    fi
    if sudo test -e "$SUDOERS_FILE"; then
        if ask_yn "Remove sudoers rule $SUDOERS_FILE?"; then
            sudo rm -f "$SUDOERS_FILE"
            note "removed $SUDOERS_FILE"
        else
            note "kept $SUDOERS_FILE"
        fi
    fi
    say "Couchside agent uninstalled."
    exit 0
fi

# ---------------------------------------------------------------------------
# (b) Get the agent files: local checkout, or fetch from GitHub
# ---------------------------------------------------------------------------
WORK_DIR="$(mktemp -d)"
_cs_cleanup() {
    rm -rf "$WORK_DIR"
    # Fail-safe against a stranded Decky box. On a Decky install we DISABLE the
    # standalone couchside.service for the plugin to own (see the service block),
    # then re-arm it later via the plugin or the h3 poll. If we reach this trap
    # with DECKY_OWNS_AGENT set but the service still not running — which includes
    # an install ABORTED by `set -e` between those two points — enable it now so
    # setup never ends with a box that has no agent to pair against. On the normal
    # path the service is already active here (plugin or h3 armed it) so this is a
    # no-op; the plugin's on-load takeover reconciles the version later regardless.
    if [ "${DECKY_OWNS_AGENT:-0}" -eq 1 ] \
        && ! systemctl is-active --quiet couchside.service 2>/dev/null; then
        sudo systemctl enable --now couchside.service >/dev/null 2>&1 || true
    fi
}
trap _cs_cleanup EXIT

SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]:-}" ]; then
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/agent/couchsided.py" ]; then
    say "Installing from local checkout: $SCRIPT_DIR"
    cp "$SCRIPT_DIR/agent/couchsided.py" "$WORK_DIR/couchsided.py"
    cp "$SCRIPT_DIR/agent/couchside.service" "$WORK_DIR/couchside.service"
    # Optional QR helper: present in a checkout, harmless if not.
    [ -f "$SCRIPT_DIR/agent/qr.py" ] && cp "$SCRIPT_DIR/agent/qr.py" "$WORK_DIR/qr.py"
    # Optional aerial-screensaver player (the agent's /api/screensaver drives it).
    [ -f "$SCRIPT_DIR/agent/couchside-screensaver.sh" ] && \
        cp "$SCRIPT_DIR/agent/couchside-screensaver.sh" "$WORK_DIR/couchside-screensaver.sh"
else
    command -v curl >/dev/null 2>&1 || die "curl not found (needed to fetch the agent files)."
    say "Fetching agent files from GitHub"
    note "$DAEMON_URL"
    curl -fsSL "$DAEMON_URL" -o "$WORK_DIR/couchsided.py"
    note "$UNIT_URL"
    curl -fsSL "$UNIT_URL" -o "$WORK_DIR/couchside.service"
    # Optional: don't abort the install if only the QR helper fails to fetch.
    curl -fsSL "$QR_URL" -o "$WORK_DIR/qr.py" 2>/dev/null || true
    # Optional aerial-screensaver player, same policy.
    curl -fsSL "$SCREENSAVER_URL" -o "$WORK_DIR/couchside-screensaver.sh" 2>/dev/null || true

    # --- Supply-chain gate (FAIL CLOSED): the fetched agent must be SIGNED by
    # the maintainer's offline Ed25519 key AND match its SHA256SUMS before we
    # install it. The signature proves authenticity even against a
    # repo/CI/account compromise (the secret key is never in CI); the hashes
    # catch corruption/transport tampering. Same gate the Decky panel uses below.
    curl -fsSL "$AGENT_SUMS_URL" -o "$WORK_DIR/SHA256SUMS" \
        || die "couldn't fetch the agent SHA256SUMS — refusing to install unverified."
    if curl -fsSL "$AGENT_SIG_URL" -o "$WORK_DIR/SHA256SUMS.sig" 2>/dev/null; then
        verify_release_sig "$WORK_DIR/SHA256SUMS" "$WORK_DIR/SHA256SUMS.sig"
        case "$?" in
            0) note "agent signature: verified (maintainer offline key)." ;;
            1) die "agent signature INVALID — refusing to install (possible tampering)." ;;
            *) note "can't verify agent signature (openssl lacks Ed25519); checksum only." ;;
        esac
    else
        note "no agent signature available; checksum only."
    fi
    # Hash every fetched file against SHA256SUMS. Build the check list from only
    # the files that actually landed (the optional ones may not have), but the
    # two REQUIRED files must be present + listed, else fail closed.
    (
        cd "$WORK_DIR" || exit 1
        : > SUMS.check
        while read -r h f; do
            [ -n "$f" ] && [ -f "$f" ] && printf '%s  %s\n' "$h" "$f" >> SUMS.check
        done < SHA256SUMS
        grep -qF ' couchsided.py' SUMS.check && grep -qF ' couchside.service' SUMS.check || exit 1
        if command -v sha256sum >/dev/null 2>&1; then
            sha256sum -c SUMS.check >/dev/null 2>&1
        elif command -v shasum >/dev/null 2>&1; then
            shasum -a 256 -c SUMS.check >/dev/null 2>&1
        else
            exit 1
        fi
    ) || die "agent checksum verification FAILED (corrupt/tampered/missing) — refusing to install."
fi
# Secondary sanity gate: even a correctly-signed file must actually parse (a
# git-checkout install skips the crypto above, and this catches a bad local
# tree too). py_compile also rejects a truncated read or an HTML error page.
python3 -m py_compile "$WORK_DIR/couchsided.py" || die "downloaded couchsided.py does not compile, aborting."
# The unit is not Python; sanity-check it's a non-empty [Service] file so a
# failed/HTML fetch can't be installed as the systemd unit.
if ! grep -q '^\[Service\]' "$WORK_DIR/couchside.service" 2>/dev/null; then
    die "downloaded couchside.service is missing/invalid (no [Service] section), aborting."
fi

# ---------------------------------------------------------------------------
# (c) Install the daemon to ~/.local/opt/couchside
# ---------------------------------------------------------------------------
say "Installing daemon to $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
install -m 0755 "$WORK_DIR/couchsided.py" "$INSTALL_DIR/couchsided.py"
# The aerial-screensaver player is optional: install only if it fetched and
# parses (bash -n), so a failed/HTML fetch can't land as an executable script.
if [ -f "$WORK_DIR/couchside-screensaver.sh" ] \
   && bash -n "$WORK_DIR/couchside-screensaver.sh" 2>/dev/null \
   && head -1 "$WORK_DIR/couchside-screensaver.sh" | grep -q '^#!'; then
    install -m 0755 "$WORK_DIR/couchside-screensaver.sh" "$INSTALL_DIR/couchside-screensaver.sh"
fi
# The QR helper is optional: install it only if it fetched and compiles, so the
# terminal pairing QR works without qrencode. Its absence just prints the URL.
if [ -f "$WORK_DIR/qr.py" ] && python3 -m py_compile "$WORK_DIR/qr.py" 2>/dev/null; then
    install -m 0755 "$WORK_DIR/qr.py" "$INSTALL_DIR/qr.py"
fi

# ---------------------------------------------------------------------------
# (d) Token: /etc/couchside/token (sudo from here on)
# ---------------------------------------------------------------------------
say "Setting up $ETC_DIR (sudo may prompt for your password)"
sudo mkdir -p "$ETC_DIR"

MIGRATED_TOKEN=""
if sudo test -s "$TOKEN_FILE"; then
    note "token already exists, keeping it (existing phone pairings keep working)"
else
    # Look for a token to inherit from any prior install (newest-named first so
    # couchpilot wins over rescue-agent if somehow both are present).
    for entry in "${OLD_INSTALLS[@]}"; do
        old_etc="${entry%%|*}"
        old_token="${old_etc}/token"
        if sudo test -s "$old_token"; then
            MIGRATED_TOKEN="$old_token"
        fi
    done
fi
if sudo test -s "$TOKEN_FILE"; then
    :
elif [ -n "$MIGRATED_TOKEN" ]; then
    note "migrating token from $MIGRATED_TOKEN (existing phone pairings keep working)"
    sudo cp "$MIGRATED_TOKEN" "$TOKEN_FILE"
else
    note "generating new pairing token"
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex 24 | sudo tee "$TOKEN_FILE" > /dev/null
    else
        python3 -c 'import secrets; print(secrets.token_hex(24))' | sudo tee "$TOKEN_FILE" > /dev/null
    fi
fi
# Daemon reads the token as the desktop user, so enforce every run.
sudo chmod 600 "$TOKEN_FILE"
sudo chown "$USER_NAME" "$TOKEN_FILE"

# ---------------------------------------------------------------------------
# (e) Initial config.json (only if absent)
# ---------------------------------------------------------------------------
if sudo test -s "$CONFIG_FILE"; then
    say "Config $CONFIG_FILE already exists, keeping it"
else
    say "Generating initial $CONFIG_FILE"
    HAVE_SDDM=0
    if systemctl cat sddm.service >/dev/null 2>&1; then
        HAVE_SDDM=1
        note "found sddm.service, adding it to the watchlist + restart-session action"
    else
        note "no sddm.service on this box, skipping session-restart action"
    fi
    HAVE_KODI=0
    if command -v flatpak >/dev/null 2>&1 && flatpak info tv.kodi.Kodi >/dev/null 2>&1; then
        HAVE_KODI=1
        note "found Kodi flatpak, adding a stop-kodi action"
    fi
    HAVE_SDDM="$HAVE_SDDM" HAVE_KODI="$HAVE_KODI" python3 - > "$WORK_DIR/config.json" <<'PYEOF'
import json, os

have_sddm = os.environ.get("HAVE_SDDM") == "1"
have_kodi = os.environ.get("HAVE_KODI") == "1"

units = []
if have_sddm:
    units.append({"name": "sddm.service", "scope": "system"})
units.append({"name": "couchside.service", "scope": "system"})

actions, order = {}, []
if have_sddm:
    actions["restart-session"] = {
        "label": "Restart Session",
        "description": "Restart the display session (sddm), fixes a wedged/black screen",
        "danger": "high",
        "cmd": ["sudo", "systemctl", "restart", "sddm"],
        "user_env": False, "detached": False,
    }
    order.append("restart-session")
if have_kodi:
    actions["stop-kodi"] = {
        "label": "Stop Kodi",
        "description": "Stop the Kodi flatpak, relaunch it from Game Mode",
        "danger": "medium",
        "cmd": ["flatpak", "kill", "tv.kodi.Kodi"],
        "user_env": True, "detached": False,
    }
    order.append("stop-kodi")
actions["reboot"] = {
    "label": "Reboot", "description": "Reboot the box", "danger": "high",
    "cmd": ["sudo", "systemctl", "reboot"], "user_env": False, "detached": True,
}
actions["poweroff"] = {
    "label": "Power Off", "description": "Power off the box", "danger": "high",
    "cmd": ["sudo", "systemctl", "poweroff"], "user_env": False, "detached": True,
}
order += ["reboot", "poweroff"]

print(json.dumps({"units": units, "actions": actions, "action_order": order}, indent=2))
PYEOF
    sudo install -m 0644 -o root -g root "$WORK_DIR/config.json" "$CONFIG_FILE"
fi

# ---------------------------------------------------------------------------
# (f) Sudoers rule: security-sensitive, so here is exactly what gets written
# ---------------------------------------------------------------------------
if [ "$NO_SUDOERS" -eq 1 ]; then
    say "Skipping sudoers rule (--no-sudoers)"
    note "WARNING: without $SUDOERS_FILE, high-danger actions"
    note "(restart-session / reboot / poweroff) and system-journal reads WILL FAIL:"
    note "the daemon has no TTY, so sudo cannot prompt for a password."
else
    say "Installing sudoers rule at $SUDOERS_FILE"
    note "This grants user '$USER_NAME' passwordless sudo for EXACTLY these commands"
    note "(and nothing else). The daemon needs them because it runs with no TTY:"
    # Install the fixed-arg journal wrapper that the sudoers rule below grants.
    # Root-owned, in the root-owned ETC_DIR, so the desktop user can execute but
    # never modify it (modifiable => root-code injection via the sudo grant).
    cat > "$WORK_DIR/couchside-journal" <<'JWRAP'
#!/usr/bin/env bash
# couchside-journal <unit> <lines>: read ONE system unit's journal, safely.
# The Couchside sudoers rule grants ONLY this script. It validates its inputs
# and calls journalctl with a fixed option set, so --file/--directory can never
# be injected (arbitrary-file read as root) the way a wildcard rule on
# journalctl itself would allow.
set -euo pipefail
unit="${1:-}"
lines="${2:-200}"
# Unit: a strict systemd unit name — no leading dash, slash, space, or option.
case "$unit" in
    ''|-*|*/*|*[[:space:]]*) echo "couchside-journal: invalid unit" >&2; exit 2 ;;
esac
case "$unit" in
    *.service|*.socket|*.target|*.timer|*.mount|*.scope|*.slice|*.path|*.device|*.swap|*.automount) : ;;
    *) echo "couchside-journal: invalid unit" >&2; exit 2 ;;
esac
# Lines: positive integer, clamped to 1..2000.
case "$lines" in ''|*[!0-9]*) lines=200 ;; esac
if [ "$lines" -lt 1 ]; then lines=1; fi
if [ "$lines" -gt 2000 ]; then lines=2000; fi
exec journalctl -u "$unit" -n "$lines" --no-pager -o short-iso
JWRAP
    sudo install -m 0755 -o root -g root "$WORK_DIR/couchside-journal" "$JOURNAL_WRAPPER"

    cat > "$WORK_DIR/couchside-sudoers" <<SUDOERS
# couchside: allow the Couchside agent (running as $USER_NAME, no TTY) to run
# exactly the privileged commands it needs, without a password.
$USER_NAME ALL=(root) NOPASSWD: /usr/bin/systemctl restart sddm
$USER_NAME ALL=(root) NOPASSWD: /usr/bin/systemctl reboot
$USER_NAME ALL=(root) NOPASSWD: /usr/bin/systemctl poweroff
$USER_NAME ALL=(root) NOPASSWD: /usr/bin/systemctl suspend
# System-journal reads go through a fixed-argument, root-owned wrapper that
# validates the unit + line count and calls journalctl with a locked-down
# option set. Granting the wrapper (never journalctl itself) is the only way to
# block --file/--directory injection, which ANY wildcard rule on journalctl
# would permit (arbitrary-file read as root).
$USER_NAME ALL=(root) NOPASSWD: $JOURNAL_WRAPPER
SUDOERS
    echo "------------------------------------------------------------------"
    cat "$WORK_DIR/couchside-sudoers"
    echo "------------------------------------------------------------------"
    sudo visudo -cf "$WORK_DIR/couchside-sudoers"
    sudo install -m 0440 -o root -g root "$WORK_DIR/couchside-sudoers" "$SUDOERS_FILE"
fi

# ---------------------------------------------------------------------------
# (f2) Virtual-gamepad device access (/dev/uinput)
# ---------------------------------------------------------------------------
# The gamepad needs the daemon to write /dev/uinput. On seat-based desktops
# (Bazzite in Game Mode) udev's uaccess tag grants the active user; on a
# headless box there is no seat, so grant access explicitly: a udev rule puts
# the node in group "input" mode 0660 (+autoload the module), and the agent
# user joins that group (the unit also sets SupplementaryGroups=input).
say "Granting the agent access to /dev/uinput (virtual gamepad)"
sudo install -d /etc/udev/rules.d
printf '%s\n' 'KERNEL=="uinput", SUBSYSTEM=="misc", GROUP="input", MODE="0660", OPTIONS+="static_node=uinput"' \
    | sudo tee /etc/udev/rules.d/99-couchside-uinput.rules >/dev/null
printf '%s\n' 'uinput' | sudo tee /etc/modules-load.d/couchside-uinput.conf >/dev/null
sudo modprobe uinput 2>/dev/null || note "uinput module not loadable now (loads on next boot)"
if getent group input >/dev/null 2>&1; then
    sudo usermod -aG input "$USER_NAME"
fi

# Scheduled-wake RTC access: the agent sets an RTC alarm via ioctl on /dev/rtc0,
# which is root:clock by default. Add it to group input (which the agent is
# already in) — no sudoers needed. Kernel-verified: RTC_WKALM_SET carries no
# capability check; only RTC_SET_TIME needs CAP_SYS_TIME, so this grants
# scheduling a wake, NOT skewing the clock.
say "Granting the agent access to /dev/rtc0 (scheduled wake)"
printf '%s\n' 'KERNEL=="rtc0", SUBSYSTEM=="rtc", GROUP="input", MODE="0660"' \
    | sudo tee /etc/udev/rules.d/99-couchside-rtc.rules >/dev/null

# Apply the rules to the already-present nodes so no reboot is needed.
sudo udevadm control --reload-rules 2>/dev/null || true
sudo udevadm trigger --name-match=uinput 2>/dev/null || true
sudo udevadm trigger --subsystem-match=rtc --action=change 2>/dev/null || true

# ---------------------------------------------------------------------------
# (f3) Wake-on-LAN: arm the wired NIC so the phone can wake the box from suspend
# ---------------------------------------------------------------------------
# The app's power control suspends the box over the LAN and wakes it with a
# Wake-on-LAN magic packet. That works only on wired Ethernet with WoL armed, so
# arm it here on the wired default-route interface: a systemd .link file makes it
# persist (udev applies it every boot, no ethtool needed) and ethtool arms it now
# if present. WoL must also be enabled in the box's BIOS/firmware, which software
# cannot set. WiFi boxes are skipped (WoL over WiFi is unreliable).
WOL_IFACE="$(python3 - <<'PYEOF' 2>/dev/null || true
import os
def default_iface():
    try:
        with open("/proc/net/route") as f:
            next(f)
            for line in f:
                c = line.split()
                if len(c) > 1 and c[1] == "00000000":
                    return c[0]
    except Exception:
        return ""
    return ""
i = default_iface()
# Wired only: a wireless NIC has a /sys/class/net/<if>/wireless directory.
if i and not os.path.isdir("/sys/class/net/%s/wireless" % i):
    print(i)
PYEOF
)"
if [ -n "$WOL_IFACE" ]; then
    WOL_MAC="$(cat "/sys/class/net/$WOL_IFACE/address" 2>/dev/null || true)"
    if [ -n "$WOL_MAC" ]; then
        say "Arming Wake-on-LAN on $WOL_IFACE ($WOL_MAC)"
        sudo install -d /etc/systemd/network
        printf '[Match]\nMACAddress=%s\n\n[Link]\nWakeOnLan=magic\n' "$WOL_MAC" \
            | sudo tee /etc/systemd/network/50-couchside-wol.link >/dev/null
        if command -v ethtool >/dev/null 2>&1; then
            sudo ethtool -s "$WOL_IFACE" wol g 2>/dev/null \
                || note "ethtool could not arm WoL now; it applies on the next boot"
        else
            note "ethtool not installed; WoL arms on the next boot via the .link file"
        fi
        note "Enable Wake-on-LAN in the box's BIOS/firmware too if it isn't already."
    fi
else
    note "No wired interface found; skipping Wake-on-LAN arming (WiFi cannot wake)."
fi

# ---------------------------------------------------------------------------
# (g) systemd unit
# ---------------------------------------------------------------------------
say "Installing systemd unit $UNIT_DST"
# Inject the RESOLVED daemon path (never a hardcoded /home): $HOME may be
# /var/home on Bazzite/ostree, a systemd-homed image, or an LDAP path, so a
# literal /home/$USER ExecStart would silently never start there. Substitute the
# __EXEC__ placeholder (current template) AND rewrite the old hardcoded
# /home/__USER__/.local/opt/couchside/couchsided.py path so a raw-fetched older
# unit is healed the same way.
DAEMON_PATH="$INSTALL_DIR/couchsided.py"
sed -e "s|/home/__USER__/.local/opt/couchside/couchsided.py|__EXEC__|g" \
    -e "s|__EXEC__|$DAEMON_PATH|g" \
    -e "s|__USER__|$USER_NAME|g" -e "s|__UID__|$USER_UID|g" \
    "$WORK_DIR/couchside.service" > "$WORK_DIR/couchside.service.rendered"
sudo install -m 0644 -o root -g root "$WORK_DIR/couchside.service.rendered" "$UNIT_DST"
sudo systemctl daemon-reload
# Decky co-existence: when Decky Loader is present, the Couchside Decky plugin
# owns the agent — it installs its own (no-downgrade) bundle to the SAME run
# location and activates the service. Leave the standalone service DORMANT here
# so the two installs don't fight over the file + port; the plugin block below
# (or the plugin itself) activates it. Without Decky, this service is the sole
# supervisor and is enabled + started normally.
if [ "$NO_DECKY" -eq 0 ] && [ -d "$DECKY_PLUGINS" ]; then
    DECKY_OWNS_AGENT=1
    sudo systemctl disable --now couchside.service 2>/dev/null || true
    note "Decky Loader detected → standalone couchside.service left DORMANT (the Couchside plugin manages the agent)."
else
    DECKY_OWNS_AGENT=0
    sudo systemctl enable couchside.service
    # restart (not `enable --now`) so re-installs replace the running process too
    sudo systemctl restart couchside.service
fi

# ---------------------------------------------------------------------------
# (h) Firewall (Bazzite/Fedora ships firewalld; SteamOS generally has none)
# ---------------------------------------------------------------------------
PORT="$(sudo cat "$CONFIG_FILE" 2>/dev/null | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("port") or '"$PORT_DEFAULT"')
except Exception: print('"$PORT_DEFAULT"')' 2>/dev/null || echo "$PORT_DEFAULT")"

if command -v firewall-cmd >/dev/null 2>&1 && sudo firewall-cmd --state >/dev/null 2>&1; then
    say "Opening ${PORT}/tcp in firewalld"
    sudo firewall-cmd --add-port="${PORT}/tcp" --permanent
    sudo firewall-cmd --reload
else
    say "No running firewalld detected, skipping firewall step"
    note "(SteamOS ships with no firewall enabled; nothing to open.)"
fi

# ---------------------------------------------------------------------------
# (h2) Pairing-QR launcher: browser opener script + Steam/Game-Mode .desktop
# ---------------------------------------------------------------------------
# These let the user re-show the pairing QR full-screen on the TV with no
# terminal: add the .desktop once via Steam > Add a Non-Steam Game, then launch
# the "Pair Phone" tile in Game Mode. The script opens http://localhost:PORT/pair
# full-screen, preferring a Flatpak Chrome/Chromium app-window, then xdg-open.
say "Installing the pairing-QR launcher ($PAIR_SCRIPT)"
mkdir -p "$INSTALL_DIR"
cat > "$PAIR_SCRIPT" <<'PAIREOF'
#!/usr/bin/env bash
# couchside-pair: open the Couchside pairing QR full-screen on this box.
# The /pair page is served LOCALHOST-ONLY by the agent, so it must be opened
# here on the box (never over the network). Reads PORT from the agent config.
set -u
CONFIG_FILE="/etc/couchside/config.json"
PORT_DEFAULT=8787
PORT="$(python3 - "$CONFIG_FILE" "$PORT_DEFAULT" <<'PYEOF' 2>/dev/null || echo "$PORT_DEFAULT"
import json, sys
try:
    with open(sys.argv[1]) as f:
        print(json.load(f).get("port") or int(sys.argv[2]))
except Exception:
    print(int(sys.argv[2]))
PYEOF
)"
URL="http://localhost:${PORT}/pair"
echo "Opening ${URL} full-screen…"
# Game Mode (gamescope session): there's no desktop browser, but Steam's own
# built-in browser renders the page: steam://openurl works from a non-Steam
# shortcut tile. This is what makes the "Pair Phone" tile work on stock
# SteamOS with no Chrome/Chromium installed.
if [ "${XDG_CURRENT_DESKTOP:-}" = "gamescope" ] \
   || pgrep -x gamescope-session >/dev/null 2>&1 \
   || pgrep -x gamescope >/dev/null 2>&1; then
    exec steam -ifrunning "steam://openurl/${URL}"
fi
if command -v flatpak >/dev/null 2>&1 && flatpak info com.google.Chrome >/dev/null 2>&1; then
    exec flatpak run com.google.Chrome --app="$URL" --start-fullscreen
elif command -v flatpak >/dev/null 2>&1 && flatpak info org.chromium.Chromium >/dev/null 2>&1; then
    exec flatpak run org.chromium.Chromium --app="$URL" --start-fullscreen
elif command -v xdg-open >/dev/null 2>&1; then
    exec xdg-open "$URL"
elif command -v steam >/dev/null 2>&1; then
    exec steam -ifrunning "steam://openurl/${URL}"
else
    echo "No browser launcher found. Open this URL on the box:"
    echo "  $URL"
fi
PAIREOF
chmod +x "$PAIR_SCRIPT"
note "wrote $PAIR_SCRIPT"

# ---------------------------------------------------------------------------
# couchside CLI: a one-word manager on PATH so updating never needs the full
# curl one-liner again. `couchside update` re-runs THIS installer, which pulls
# the latest agent + Decky plugin, re-verifies, and restarts — an in-place
# upgrade. ~/.local/bin is on PATH under systemd user sessions (SteamOS/Bazzite
# included); if it isn't, we note it.
CLI_DIR="${HOME}/.local/bin"
CLI="${CLI_DIR}/couchside"
say "Installing the couchside command ($CLI)"
mkdir -p "$CLI_DIR"
cat > "$CLI" <<'CLIEOF'
#!/usr/bin/env bash
# couchside — manage the Couchside agent on this box.
set -u
INSTALL_URL="https://couchside.tv/install.sh"
RELEASE_API="https://api.github.com/repos/emerytech/couchside/releases/latest"
# The AGENT version of the latest release (a signed release asset). This is the
# right number to compare against — the release TAG is the APP version, a
# separate numbering scheme, so tag-vs-agent looks mismatched. Same asset the
# box-side update check (couchsided.py) uses.
AGENT_VER_URL="https://github.com/emerytech/couchside/releases/latest/download/agent-version.txt"
DIR="${HOME}/.local/opt/couchside"
DAEMON="${DIR}/couchsided.py"

case "${1:-help}" in
  update|upgrade)
    yes=0; force=0
    for a in "$@"; do
      case "$a" in
        -y|--yes) yes=1 ;;
        -f|--force|--reinstall) force=1 ;;
      esac
    done
    installed="$(grep -m1 '^VERSION' "$DAEMON" 2>/dev/null | cut -d'"' -f2 || echo unknown)"
    echo "Couchside agent — installed ${installed}"

    # Latest AGENT version, from the signed release asset (NOT the release tag,
    # which is the app version). Best-effort: empty on a failed fetch.
    latest="$(curl -fsSL -m 10 "$AGENT_VER_URL" 2>/dev/null | tr -d '[:space:]')"

    # Release tag + notes for the human-readable preview (tab-separated so we can
    # reassemble and splice in the agent version). Best-effort.
    info="$(curl -fsSL -m 10 -H 'Accept: application/vnd.github+json' "$RELEASE_API" 2>/dev/null \
      | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin)
    tag=d.get("tag_name") or "?"
    body=(d.get("body") or "").strip() or "(no release notes published)"
    print(tag+"\t"+body)
except Exception:
    sys.exit(1)' 2>/dev/null)"
    tag="${info%%$'\t'*}"; body="${info#*$'\t'}"
    [ -n "$tag" ] || tag="?"

    # Decide whether a NEWER agent is actually published. Compare agent-to-agent
    # as integer tuples (2.9.10 > 2.9.9). If we couldn't fetch the latest version,
    # fall through and let the user decide (best-effort, as before).
    available=1
    if [ -n "$latest" ] && [ "$installed" != "unknown" ]; then
      if python3 - "$installed" "$latest" <<'PY'
import re, sys
def t(s): return tuple(int(x) for x in re.findall(r'\d+', s))
sys.exit(0 if t(sys.argv[2]) > t(sys.argv[1]) else 1)
PY
      then available=1; else available=0; fi
    fi

    verline="Latest release: ${tag}"
    [ -n "$latest" ] && verline="${verline} (agent ${latest})"

    # Already current (and not forced): say so plainly and stop. No misleading
    # prompt, no needless reinstall.
    if [ "$available" -eq 0 ] && [ "$force" -ne 1 ]; then
      echo
      echo "$verline"
      echo "You're on the latest agent (${installed}). Nothing to update."
      echo "Re-run with --force to reinstall the current version anyway."
      exit 0
    fi

    # An update is available (or --force). Show the notes BEFORE confirming.
    echo
    echo "$verline"
    if [ -n "$body" ]; then
      echo
      echo "Changes:"
      printf '%s\n' "$body"
    else
      echo "(could not fetch release notes; you can still proceed)"
    fi
    echo

    if [ "$yes" -ne 1 ]; then
      printf 'Update now? [y/N] '
      # Read from the terminal. If there's no tty (piped / non-interactive),
      # DON'T block on stdin — default to cancel; use `couchside update -y`.
      ans=""
      read -r ans </dev/tty 2>/dev/null || { echo; echo "No terminal for the prompt — re-run as: couchside update -y"; exit 0; }
      case "$ans" in y|Y|yes|YES) ;; *) echo "Cancelled."; exit 0 ;; esac
    fi
    # On a Decky box the Couchside plugin owns the agent; the installer is
    # Decky-aware (it refreshes the plugin and leaves the standalone service
    # dormant for the plugin to run), so `couchside update` still does the right
    # thing — it just updates the plugin rather than the standalone service.
    if [ -d "$HOME/homebrew/plugins" ]; then
      echo "Decky Loader detected — updating the Couchside plugin (it owns the agent on this box)."
    fi
    echo "Updating from ${INSTALL_URL} ..."
    # exec so THIS couchside process is replaced by the updater: the installer
    # overwrites this very script, and a still-running bash would then read the
    # new file's bytes at its old offset and error out. exec frees our file.
    exec bash -c "curl -fsSL '$INSTALL_URL' | bash"
    ;;
  pair)
    exec "${DIR}/couchside-pair"
    ;;
  version|-v|--version)
    grep -m1 '^VERSION' "$DAEMON" 2>/dev/null | cut -d'"' -f2 || echo "unknown"
    ;;
  status)
    systemctl --user status couchside.service 2>/dev/null \
      || systemctl status couchside.service 2>/dev/null || true
    ;;
  allow-updates)
    # Opt-in: let the phone app trigger an update (POST /api/update/apply).
    # OFF by default. Must be set HERE on the box (not by the app), so the
    # capability only exists when you consciously enable it. Edits config.json
    # (root-owned) + restarts the agent.
    case "${2:-}" in
      on|off)
        val="false"; [ "$2" = "on" ] && val="true"
        sudo python3 - "$val" <<'PY' || { echo "failed to update config" >&2; exit 1; }
import json, os, sys
p = "/etc/couchside/config.json"
val = sys.argv[1] == "true"
try:
    with open(p) as f: d = json.load(f)
    if not isinstance(d, dict): d = {}
except Exception:
    d = {}
d["allow_app_update"] = val
os.makedirs(os.path.dirname(p), exist_ok=True)
tmp = p + ".tmp"
with open(tmp, "w") as f: json.dump(d, f, indent=2)
os.replace(tmp, p)
PY
        sudo systemctl restart couchside 2>/dev/null \
          || systemctl --user restart couchside 2>/dev/null || true
        echo "App-triggered updates: ${2}"
        ;;
      ""|status)
        grep -q '"allow_app_update"[[:space:]]*:[[:space:]]*true' /etc/couchside/config.json 2>/dev/null \
          && echo "App-triggered updates: on" || echo "App-triggered updates: off"
        ;;
      *) echo "usage: couchside allow-updates on|off" >&2; exit 2 ;;
    esac
    ;;
  help|-h|--help|"")
    cat <<USAGE
couchside — manage the Couchside agent on this box
  couchside update          show the release notes, then update on confirm
  couchside update -y       update without the prompt
  couchside allow-updates on|off   let (or stop) the phone app trigger updates
  couchside pair            show the pairing QR on this box's screen
  couchside version         print the installed agent version
  couchside status          show the agent service status
USAGE
    ;;
  *)
    echo "couchside: unknown command '${1}'  (try: couchside help)" >&2
    exit 2
    ;;
esac
CLIEOF
chmod +x "$CLI"
note "wrote $CLI"
# Ensure ~/.local/bin is on PATH so `couchside` runs by name. Bazzite already
# has it; SteamOS's `deck` user often doesn't — append to ~/.bashrc once so a
# new terminal (or SSH) session picks it up. Idempotent.
case ":$PATH:" in
    *":$CLI_DIR:"*)
        note "update anytime with:  couchside update" ;;
    *)
        if ! grep -qs '\.local/bin' "${HOME}/.bashrc" 2>/dev/null; then
            printf '\n# Added by the Couchside installer: put ~/.local/bin on PATH\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "${HOME}/.bashrc"
        fi
        note "added ~/.local/bin to PATH — open a new terminal (or: source ~/.bashrc), then:  couchside update" ;;
esac

say "Installing the Game-Mode launcher entry ($PAIR_DESKTOP)"
mkdir -p "$(dirname "$PAIR_DESKTOP")"
cat > "$PAIR_DESKTOP" <<DESKTOPEOF
[Desktop Entry]
Type=Application
Name=Couchside — Pair Phone
Comment=Show the Couchside pairing QR full-screen on this TV
Exec=${PAIR_SCRIPT}
Terminal=false
Categories=Utility;
DESKTOPEOF
note "wrote $PAIR_DESKTOP"

# ---------------------------------------------------------------------------
# (h3) Register "Couchside — Pair Phone" as a Steam (non-Steam) shortcut
# ---------------------------------------------------------------------------
# Appends an entry to every Steam account's shortcuts.vdf so the pairing tile
# shows up in Game Mode with no manual "Add a Non-Steam Game" step. Steam only
# reads shortcuts.vdf at startup and REWRITES it on exit, so edits made while
# Steam runs are lost. If it's running we offer to shut it down first.
register_steam_shortcut() {
    local steamroot=""
    for d in "$HOME/.local/share/Steam" "$HOME/.steam/steam" \
             "$HOME/.var/app/com.valvesoftware.Steam/data/Steam"; do
        [ -d "$d/userdata" ] && { steamroot="$(cd "$d" && pwd -P)"; break; }
    done
    if [ -z "$steamroot" ]; then
        note "no Steam userdata found, skipping the Game Mode tile"
        return 0
    fi

    if pgrep -x steam >/dev/null 2>&1; then
        note "Steam is running. It rewrites its shortcut list on exit, so the"
        note "tile can only be added while Steam is closed."
        if ask_yn "Close Steam now to add the 'Couchside — Pair Phone' tile (it will need relaunching)?"; then
            steam -shutdown >/dev/null 2>&1 || true
            local waited=0
            while pgrep -x steam >/dev/null 2>&1 && [ "$waited" -lt 30 ]; do
                sleep 1; waited=$((waited + 1))
            done
            if pgrep -x steam >/dev/null 2>&1; then
                note "Steam didn't exit in time. Skipping. Re-run the installer"
                note "with Steam closed, or add $PAIR_SCRIPT via"
                note "Steam > Add a Non-Steam Game."
                return 0
            fi
        else
            note "skipped. Re-run the installer with Steam closed, or add"
            note "$PAIR_SCRIPT via Steam > Add a Non-Steam Game."
            return 0
        fi
    fi

    PAIR_SCRIPT="$PAIR_SCRIPT" STEAMROOT="$steamroot" python3 - <<'PYVDF'
# Append a non-Steam shortcut to shortcuts.vdf (binary VDF, pure stdlib).
# Idempotent: an existing "Couchside - Pair Phone" entry is updated in place.
# Writes a .couchside-bak backup and replaces the file atomically.
import os, struct, sys, zlib

APPNAME = "Couchside — Pair Phone"
EXE = os.environ["PAIR_SCRIPT"]
STEAMROOT = os.environ["STEAMROOT"]


def parse_map(buf, pos):
    out = {}
    while True:
        t = buf[pos]; pos += 1
        if t == 0x08:
            return out, pos
        end = buf.index(b"\x00", pos)
        key = buf[pos:end].decode("utf-8", "replace"); pos = end + 1
        if t == 0x00:
            val, pos = parse_map(buf, pos)
        elif t == 0x01:
            end = buf.index(b"\x00", pos)
            val = buf[pos:end].decode("utf-8", "replace"); pos = end + 1
        elif t == 0x02:
            val = struct.unpack_from("<i", buf, pos)[0]; pos += 4
        else:
            raise ValueError("unknown VDF field type 0x%02x" % t)
        out[key] = val


def ser_map(m):
    out = bytearray()
    for k, v in m.items():
        kb = k.encode("utf-8")
        if isinstance(v, dict):
            out += b"\x00" + kb + b"\x00" + ser_map(v)
        elif isinstance(v, int):
            out += b"\x02" + kb + b"\x00" + struct.pack("<i", v)
        else:
            out += b"\x01" + kb + b"\x00" + str(v).encode("utf-8") + b"\x00"
    out += b"\x08"
    return bytes(out)


def new_entry():
    # Signed view of crc32(exe+name)|0x80000000: the appid scheme Steam uses.
    appid_u = (zlib.crc32((EXE + APPNAME).encode("utf-8")) & 0xFFFFFFFF) | 0x80000000
    appid = struct.unpack("<i", struct.pack("<I", appid_u))[0]
    return {
        "appid": appid,
        "AppName": APPNAME,
        "Exe": '"%s"' % EXE,
        "StartDir": '"%s"' % os.path.dirname(EXE),
        "icon": "",
        "ShortcutPath": "",
        "LaunchOptions": "",
        "IsHidden": 0,
        "AllowDesktopConfig": 1,
        "AllowOverlay": 1,
        "OpenVR": 0,
        "Devkit": 0,
        "DevkitGameID": "",
        "DevkitOverrideAppID": 0,
        "LastPlayTime": 0,
        "FlatpakAppID": "",
        "tags": {},
    }


def is_ours(entry):
    if not isinstance(entry, dict):
        return False
    name = entry.get("AppName", entry.get("appname", ""))
    return isinstance(name, str) and name.strip().lower() == APPNAME.strip().lower()


added = 0
for acct in sorted(os.listdir(os.path.join(STEAMROOT, "userdata"))):
    if not acct.isdigit() or acct == "0":
        continue
    cfg = os.path.join(STEAMROOT, "userdata", acct, "config")
    if not os.path.isdir(cfg):
        continue
    path = os.path.join(cfg, "shortcuts.vdf")
    root = {"shortcuts": {}}
    if os.path.exists(path):
        with open(path, "rb") as f:
            buf = f.read()
        try:
            root, _ = parse_map(buf, 0)
        except Exception as e:
            print("    ! %s: could not parse (%s), leaving it alone" % (path, e))
            continue
        if not isinstance(root.get("shortcuts"), dict):
            root["shortcuts"] = {}
        # Round-trip guard: never touch a file we can't reproduce byte-for-byte.
        if ser_map(root) != buf:
            print("    ! %s: reserialization mismatch, leaving it alone" % path)
            continue
    shortcuts = root["shortcuts"]

    existing = [k for k, v in shortcuts.items() if is_ours(v)]
    if existing:
        for k in existing:  # heal the path if the install dir moved
            shortcuts[k]["Exe"] = '"%s"' % EXE
            shortcuts[k]["StartDir"] = '"%s"' % os.path.dirname(EXE)
        print("    = account %s: tile already present (path refreshed)" % acct)
    else:
        idx = 0
        while str(idx) in shortcuts:
            idx += 1
        shortcuts[str(idx)] = new_entry()
        print("    + account %s: tile added" % acct)
        added += 1

    data = ser_map(root)
    # Back up ONCE: the pristine pre-Couchside file. On a re-run the on-disk
    # file already contains our entry, so re-copying it would clobber the only
    # good backup; the existence check preserves the original.
    bak = path + ".couchside-bak"
    if os.path.exists(path) and not os.path.exists(bak):
        with open(bak, "wb") as f:
            with open(path, "rb") as orig:
                f.write(orig.read())
    tmp = path + ".couchside-tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)

print("    done (%d added). The tile appears next time Steam starts." % added)
PYVDF
}

say "Registering the 'Couchside — Pair Phone' tile in Steam (Game Mode)"
register_steam_shortcut || note "shortcut registration failed. Add $PAIR_SCRIPT via Steam > Add a Non-Steam Game"

# ---------------------------------------------------------------------------
# (h2) Optional: Decky Loader Game Mode panel
# ---------------------------------------------------------------------------
# If Decky Loader is installed, drop in the Couchside plugin so it appears in
# the Quick Access Menu without the plugin store. The panel is a convenience on
# top of the agent, not the agent itself, so nothing here is allowed to abort
# the install: the whole thing runs inside an `if` condition (set -e is
# suspended there) and any failure just prints a note and moves on. --no-decky
# skips it entirely.
if [ "$NO_DECKY" -eq 0 ] && [ -d "$DECKY_PLUGINS" ]; then
    say "Decky Loader detected: installing the Couchside Game Mode panel"
    decky_tmp="$(mktemp -d)"
    # Decky's plugin dir is root-owned (same as a store install), so place the
    # files with sudo and let plugin_loader load them on restart.
    #
    # Supply-chain gate: verify the release is (1) SIGNED by the maintainer's
    # offline Ed25519 key and (2) matches its SHA256SUMS, before extracting. The
    # signature proves authenticity even against a repo/CI/account compromise (the
    # secret key is never in CI); the checksum catches corruption/transport
    # tampering. A present-but-invalid signature or a checksum mismatch aborts the
    # panel install (non-fatal: the agent is already installed above). An older,
    # UNSIGNED release, or a box whose openssl lacks Ed25519, falls back to
    # checksum-only with a warning rather than breaking the install.
    decky_verify_ok() {
        curl -fsSL "$PLUGIN_URL" -o "${decky_tmp}/Couchside.tar.gz" || {
            note "couldn't download the panel tarball (skipping)."
            return 1
        }
        curl -fsSL "$PLUGIN_SUMS_URL" -o "${decky_tmp}/SHA256SUMS" || {
            note "couldn't download SHA256SUMS for the panel; refusing to install unverified (skipping)."
            return 1
        }
        # (1) Authenticity: verify SHA256SUMS.sig against EITHER embedded key.
        if curl -fsSL "$PLUGIN_SIG_URL" -o "${decky_tmp}/SHA256SUMS.sig" 2>/dev/null; then
            verify_release_sig "${decky_tmp}/SHA256SUMS" "${decky_tmp}/SHA256SUMS.sig"
            case "$?" in
                0) note "release signature: verified (maintainer offline key)." ;;
                1) note "release signature INVALID — refusing to install the panel (skipping)."
                   return 1 ;;
                *) note "can't verify release signature (openssl lacks Ed25519); checksum only." ;;
            esac
        else
            note "no release signature found (older/unsigned release); checksum only."
        fi
        # Verify only our tarball's line. `-c` checks entries whose filename
        # exists in the cwd, so run it from the temp dir. Prefer sha256sum, fall
        # back to `shasum -a 256` (present on Bazzite / most distros).
        (
            cd "$decky_tmp" || exit 1
            grep -F ' Couchside.tar.gz' SHA256SUMS > SHA256SUMS.tarball || exit 1
            if command -v sha256sum >/dev/null 2>&1; then
                sha256sum -c SHA256SUMS.tarball >/dev/null 2>&1
            elif command -v shasum >/dev/null 2>&1; then
                shasum -a 256 -c SHA256SUMS.tarball >/dev/null 2>&1
            else
                exit 1
            fi
        ) || {
            note "panel checksum verification FAILED (corrupt/tampered/missing entry); refusing to install (skipping)."
            return 1
        }
        return 0
    }
    if decky_verify_ok \
        && sudo rm -rf "$DECKY_PLUGIN_DIR" \
        && sudo tar -xzf "${decky_tmp}/Couchside.tar.gz" -C "$DECKY_PLUGINS"; then
        # Force root ownership: a release archive built in CI can carry the
        # runner's UID/GID, and `sudo tar -x` preserves it — Decky Loader then
        # skips a plugin it doesn't see as root-owned (no error, just missing
        # from the menu). Store installs are root-owned; match that.
        sudo chown -R root:root "$DECKY_PLUGIN_DIR" 2>/dev/null || true
        sudo systemctl restart plugin_loader.service 2>/dev/null || true
        note "panel installed. Open the Decky menu in Game Mode to see it."
    else
        note "couldn't install the panel (skipping); the agent still works."
    fi
    rm -rf "$decky_tmp"
fi

# ---------------------------------------------------------------------------
# (h3) Decky hand-off safety net
# ---------------------------------------------------------------------------
# With Decky present we left couchside.service DORMANT for the plugin to own.
# A current plugin activates the service from its on-load install hook (async,
# after plugin_loader restarts above). Give it a moment; if the service is still
# not up (an older plugin without the take-over step), enable it ourselves so the
# box is never left without a running agent.
if [ "${DECKY_OWNS_AGENT:-0}" -eq 1 ]; then
    _armed=0
    for _ in $(seq 1 20); do
        if systemctl is-active --quiet couchside.service; then _armed=1; break; fi
        sleep 1
    done
    if [ "$_armed" -eq 0 ]; then
        sudo systemctl enable --now couchside.service
        note "the Couchside plugin didn't activate the agent — enabled couchside.service as a fallback (update the plugin in Decky for it to take over)."
    else
        note "the Couchside plugin is running the agent."
    fi
fi

# ---------------------------------------------------------------------------
# (i) Migration: retire every pre-rename install (rescue-agent, couchpilot)
# ---------------------------------------------------------------------------
# The token was already inherited above (section d). Here we disable+remove the
# old units and sudoers rules for BOTH prior names so they don't linger or fight
# the new couchside.service for /dev/uinput or the listen port.
for entry in "${OLD_INSTALLS[@]}"; do
    old_etc="${entry%%|*}"
    rest="${entry#*|}"
    old_unit="${rest%%|*}"
    old_sudoers="${rest##*|}"
    old_token="${old_etc}/token"
    if sudo test -e "$old_token" || [ -f "/etc/systemd/system/$old_unit" ] \
       || sudo test -e "$old_sudoers"; then
        say "Retiring old install: $old_unit"
        if [ -f "/etc/systemd/system/$old_unit" ]; then
            sudo systemctl disable --now "$old_unit" 2>/dev/null || true
            sudo rm -f "/etc/systemd/system/$old_unit"
            sudo systemctl daemon-reload
            note "removed old $old_unit (replaced by couchside.service)"
        fi
        if sudo test -e "$old_sudoers"; then
            sudo rm -f "$old_sudoers"
            note "removed old $old_sudoers (replaced by $SUDOERS_FILE)"
        fi
        note "($old_etc left in place, its token was already migrated;"
        note " remove it manually when you're satisfied paired phones still work)"
    fi
done

# ---------------------------------------------------------------------------
# (j) Verify + pairing info
# ---------------------------------------------------------------------------
say "Verifying: http://127.0.0.1:${PORT}/api/ping"
# Soft retry with backoff: a slow-binding agent must NOT trip `set -e` and abort
# the script BEFORE we print the pairing token/QR below. Poll a few times, then
# degrade to a warning — the token/QR still print so pairing isn't blocked.
ping_ok=0
for attempt in 1 2 3 4 5 6; do
    if curl -fsS "http://127.0.0.1:${PORT}/api/ping" 2>/dev/null; then
        ping_ok=1
        echo
        break
    fi
    sleep "$attempt"   # 1s,2s,3s,... ~21s total before giving up
done
if [ "$ping_ok" -ne 1 ]; then
    note "agent not answering on :${PORT} yet. It may still be starting; check"
    note "'systemctl status couchside.service' and 'journalctl -u couchside'."
    note "Your pairing token/QR are below and remain valid once it comes up."
fi

TOKEN="$(cat "$TOKEN_FILE")"
# Resolve the hostname WITHOUT the `hostname` command. SteamOS doesn't ship it.
# /proc/sys/kernel/hostname is always present on Linux; strip any domain part.
HOST_SHORT="$(cat /proc/sys/kernel/hostname 2>/dev/null || cat /etc/hostname 2>/dev/null || echo localhost)"
HOST_SHORT="${HOST_SHORT%%.*}"
# LAN IP for the &ip= fallback param (UDP connect trick, nothing is sent).
# The app caches it per box and uses it when mDNS breaks (SteamOS Game Mode).
LAN_IP="$(python3 - <<'PYEOF' 2>/dev/null || true
import socket
try:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.connect(("192.0.2.1", 9))
    ip = s.getsockname()[0]
    s.close()
    print("" if ip.startswith("127.") else ip)
except OSError:
    pass
PYEOF
)"
# HTTPS pair link (couchside.tv/pair relaunches the app). Android cameras
# won't open custom schemes from a QR. Params ride the #fragment so the token
# is never sent to the web server.
PAIR_URL="https://couchside.tv/pair#host=${HOST_SHORT}.local&port=${PORT}&token=${TOKEN}"
[ -n "$LAN_IP" ] && PAIR_URL="${PAIR_URL}&ip=${LAN_IP}"

echo
echo "=================================================================="
echo " Couchside agent is running on ${HOST_SHORT}.local:${PORT}"
echo
echo " TOKEN: ${TOKEN}"
echo
echo " Pair the app by scanning this link with your phone camera:"
echo " ${PAIR_URL}"
echo "=================================================================="
echo
if command -v qrencode >/dev/null 2>&1; then
    qrencode -t ansiutf8 "$PAIR_URL"
elif [ -f "$INSTALL_DIR/qr.py" ] && python3 "$INSTALL_DIR/qr.py" "$PAIR_URL" 2>/dev/null; then
    # Pure-stdlib fallback: works on immutable distros with no qrencode.
    :
elif command -v npx >/dev/null 2>&1; then
    # no -t flag: the qrcode CLI's default renderer draws in the terminal
    npx --yes qrcode "$PAIR_URL" || echo "$PAIR_URL"
else
    echo "(couldn't render a terminal QR here; copy the URL above to pair)"
fi

echo
echo "To re-show the pairing QR later without a terminal: launch the"
echo "'Couchside — Pair Phone' tile from your Steam library (Game Mode included"
echo ", it opens in Steam's built-in browser). If the tile isn't there yet,"
echo "restart Steam once, or add $PAIR_SCRIPT via Steam > Add a Non-Steam Game."

} # end partial-download guard — see the matching `{` near the top
