#!/usr/bin/env bash
# Re-running install.sh must put back every root-owned piece an OS update took.
#
# On the maintainer's Steam Deck OLED a SteamOS image update removed
# /etc/couchside/ (token + the sudo-granted journal wrapper), all four
# /etc/udev/rules.d/99-couchside-*.rules and /etc/modules-load.d/couchside-uinput.conf,
# while /etc/systemd/system/couchside.service survived. The repair the app now
# tells the owner to run is "re-run the installer". That advice is only true if
# every one of those writes is UNCONDITIONAL on a full run -- a piece guarded by
# "already installed?" would never come back. And the (g1) manifest the installer
# leaves for the agent's install_health must name exactly what it wrote.
#
# Executable: the REAL (f) sudoers+wrapper, (f2) udev/modules and (g)+(g1)
# unit+manifest blocks are lifted out of install.sh, every literal /etc/ is
# rewritten into a tmp root, `sudo` is a pass-through (dropping install's -o/-g,
# which a non-root runner cannot honour), and udevadm/modprobe/visudo are no-ops.
# Nothing touches the real /etc. Then the AGENT's own install_health reads the
# tmp tree + manifest, so installer and agent are checked against each other.
#
# CONTROL (in-file): the "Deck damage" step deletes the pieces and asserts the
# agent reports them missing BEFORE the re-run and nothing missing AFTER -- the
# same probe observed firing and not firing.
set -u
SRC="${1:?usage: test_installer_restore.sh /path/to/install.sh}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
fails=0
check() { if [ "$2" -eq 0 ]; then echo "  PASS  $1"; else echo "  FAIL  $1"; fails=$((fails+1)); fi; }

section() { # section <start-regex> <stop-regex>
    awk -v a="$1" -v b="$2" '$0 ~ a {f=1} f && $0 ~ b {exit} f' "$SRC"
}
f_block="$(section '^# \\(f\\) Sudoers rule' '^# \\(f1b\\) ')"
f2_block="$(section '^# \\(f2\\) Virtual-gamepad' '^# \\(f3\\) ')"
g_block="$(section '^# \\(g\\) systemd unit' '^# \\(g2\\) ')"
bounded() { # bounded <name> <text>
    local lines
    lines=$(printf '%s\n' "$2" | wc -l | tr -d ' ')
    [ "$lines" -gt 10 ] && [ "$lines" -lt 200 ]
    check "($1) block extracts and is bounded ($lines lines)" $?
}
bounded f "$f_block"
bounded f2 "$f2_block"
bounded g "$g_block"
printf '%s\n' "$g_block" | grep -q 'INSTALL_MANIFEST="$STATE_DIR/install-manifest"'
check "(g1) manifest write rides with the unit block" $?

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
root="$tmp/root"

run_blocks() { # run_blocks <NO_SUDOERS>
    mkdir -p "$root/etc/sudoers.d" "$root/etc/couchside" "$root/etc/systemd/system" \
             "$root/etc/modules-load.d" "$root/var/lib/couchside" "$tmp/work"
    printf '[Service]\nUser=__USER__\nExecStart=__EXEC__ --config __CONFIG__\n' > "$tmp/work/couchside.service"
    {
        echo 'set -euo pipefail'
        echo 'say()  { echo "==> $*"; }'
        echo 'note() { echo "    $*"; }'
        # Pass-through sudo; install's -o/-g need real root, so drop them.
        cat <<'SUDO'
sudo() {
    if [ "$1" = install ]; then
        shift
        local a=()
        while [ $# -gt 0 ]; do
            case "$1" in -o|-g) shift 2 ;; *) a+=("$1"); shift ;; esac
        done
        command install "${a[@]}"
    else
        "$@"
    fi
}
udevadm() { :; }
modprobe() { :; }
visudo() { :; }
usermod() { :; }
getent() { return 1; }
SUDO
        echo "NO_SUDOERS=$1"
        echo "WORK_DIR='$tmp/work'"
        echo "USER_NAME='$(id -un)'"
        echo "USER_UID='$(id -u)'"
        echo "DM_NAME=''"
        echo "ETC_DIR='$root/etc/couchside'"
        echo "JOURNAL_WRAPPER='$root/etc/couchside/couchside-journal'"
        echo "SUDOERS_FILE='$root/etc/sudoers.d/zz-couchside'"
        echo "SUDOERS_FILE_LEGACY='$root/etc/sudoers.d/couchside'"
        echo "UNIT_DST='$root/etc/systemd/system/couchside.service'"
        echo "STATE_DIR='$root/var/lib/couchside'"
        echo "CONFIG_FILE='$root/var/lib/couchside/config.json'"
        echo "INSTALL_DIR='$tmp/home/.local/opt/couchside'"
        # Literal /etc/ paths in the blocks are redirected into the tmp root.
        printf '%s\n%s\n%s\n' "$f_block" "$f2_block" "$g_block" | sed "s#/etc/#$root/etc/#g"
        echo 'echo BLOCKS_DONE'
    } > "$tmp/drive.sh"
    bash "$tmp/drive.sh" > "$tmp/out.txt" 2>&1
}

# The agent's own verdict on the tmp tree (sudo -n -l stubbed as "granted" when
# the grant file exists -- the file is what (f) writes; whether sudo honours it
# is the agent test's job, tests/test_install_health.py).
health() {
    ROOTFS="$root" AGENT="$ROOT_DIR/agent/couchsided.py" python3 - <<'PY'
import importlib.util, json, os, sys
root = os.environ["ROOTFS"]
spec = importlib.util.spec_from_file_location("couchsided", os.environ["AGENT"])
cs = importlib.util.module_from_spec(spec); sys.modules["couchsided"] = cs
spec.loader.exec_module(cs)
for pid, p in list(cs._INSTALL_PIECE_PATHS.items()):
    cs._INSTALL_PIECE_PATHS[pid] = root + p
cs.INSTALL_MANIFEST = root + cs.INSTALL_MANIFEST
grant = root + "/etc/sudoers.d/zz-couchside"
cs._sudo_nopasswd_state = lambda needle: os.path.exists(grant)
print(json.dumps(cs.install_health_compute(), sort_keys=True))
PY
}
sha() { find "$root/etc" "$root/var/lib/couchside/install-manifest" -type f -print0 | sort -z \
        | xargs -0 cat | { command -v sha256sum >/dev/null && sha256sum || shasum -a 256; } | cut -d' ' -f1; }

echo "first full run lays down every piece"
run_blocks 0; rc=$?
check "blocks ran (rc=$rc)" "$rc"
grep -q BLOCKS_DONE "$tmp/out.txt"; check "reached the end" $?
for f in etc/couchside/couchside-journal etc/sudoers.d/zz-couchside \
         etc/udev/rules.d/99-couchside-uinput.rules etc/udev/rules.d/99-couchside-rtc.rules \
         etc/udev/rules.d/99-couchside-cec.rules etc/udev/rules.d/99-couchside-openpuck.rules \
         etc/modules-load.d/couchside-uinput.conf etc/systemd/system/couchside.service \
         var/lib/couchside/install-manifest; do
    [ -s "$root/$f" ]; check "wrote /$f" $?
done
ids="$(grep -v '^#' "$root/var/lib/couchside/install-manifest" | tr '\n' ' ')"
[ "$ids" = "token_canonical sudoers_grant journal_wrapper udev_uinput modules_uinput udev_rtc udev_cec udev_openpuck systemd_unit " ]
check "manifest names all nine pieces ($ids)" $?
# The token is (d)'s job (tests/test_installer_token_order.sh); give it one here
# so the agent's verdict is about the pieces THESE blocks own.
printf 'tok\n' > "$root/etc/couchside/token"
[ "$(health)" = '{"missing": [], "ok": true, "unknown": []}' ]
check "the agent reads the fresh install as healthy" $?

echo "every manifest id is one the agent knows (no drift)"
AGENT="$ROOT_DIR/agent/couchsided.py" IDS="$ids" python3 - <<'PY'
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("couchsided", os.environ["AGENT"])
cs = importlib.util.module_from_spec(spec); sys.modules["couchsided"] = cs
spec.loader.exec_module(cs)
ids = os.environ["IDS"].split()
sys.exit(0 if ids and set(ids) <= set(cs._INSTALL_PIECE_IDS) and len(ids) == len(set(ids)) else 1)
PY
check "manifest ids are a subset of _INSTALL_PIECE_IDS" $?

echo "the Deck damage, then a re-run restores it"
before="$(sha)"
rm -rf "$root/etc/couchside"
rm -f "$root"/etc/udev/rules.d/99-couchside-*.rules "$root/etc/modules-load.d/couchside-uinput.conf"
h="$(health)"
[ "$h" = '{"missing": ["token_canonical", "journal_wrapper", "udev_uinput", "modules_uinput", "udev_rtc", "udev_cec", "udev_openpuck"], "ok": false, "unknown": []}' ]
check "CONTROL: agent reports the damage before the re-run ($h)" $?
run_blocks 0; rc=$?
check "re-run ok (rc=$rc)" "$rc"
printf 'tok\n' > "$root/etc/couchside/token"      # (d) restores this one from the mirror
[ "$(health)" = '{"missing": [], "ok": true, "unknown": []}' ]
check "after the re-run nothing is missing" $?
[ "$(sha)" = "$before" ]
check "restored files are byte-identical to the first install" $?

echo "idempotent: a run over a healthy box changes nothing"
run_blocks 0; rc=$?
check "third run ok (rc=$rc)" "$rc"
[ "$(sha)" = "$before" ]
check "no content drift on a healthy re-run" $?

echo "--no-sudoers: no grant, no wrapper, and the manifest says so"
rm -rf "$root"
run_blocks 1; rc=$?
check "--no-sudoers run ok (rc=$rc)" "$rc"
[ ! -e "$root/etc/sudoers.d/zz-couchside" ] && [ ! -e "$root/etc/couchside/couchside-journal" ]
check "no grant and no wrapper written" $?
ids="$(grep -v '^#' "$root/var/lib/couchside/install-manifest" | tr '\n' ' ')"
[ "$ids" = "token_canonical udev_uinput modules_uinput udev_rtc udev_cec udev_openpuck systemd_unit " ]
check "manifest omits sudoers_grant + journal_wrapper ($ids)" $?
printf 'tok\n' > "$root/etc/couchside/token"
[ "$(health)" = '{"missing": [], "ok": true, "unknown": []}' ]
check "the agent does not call a --no-sudoers box damaged" $?

echo "uninstall drops the manifest"
grep -q 'sudo rm -f "$STATE_DIR/install-manifest"' "$SRC"
check "--uninstall removes STATE_DIR/install-manifest" $?

echo
if [ "$fails" -gt 0 ]; then echo "FAILED: $fails"; exit 1; fi
echo "all installer restore checks passed"
