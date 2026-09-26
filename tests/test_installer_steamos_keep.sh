#!/usr/bin/env bash
# install.sh (f4): SteamOS must KEEP Couchside's /etc files across image updates.
#
# WHY. A SteamOS atomic update discards every /etc change except the paths on a
# keep-list. Source (Valve steamos-customizations, tag jupiter-20260916.1; full
# citations in docs/memory/steamos-etc-persistence.md):
#   atomic-update/rauc/atomic-update-keep.conf.in:1-2  all /etc changes are lost
#     except the listed paths; :14 drop-ins in /etc/atomic-update.conf.d/*.conf;
#     :38 /etc/systemd/system/*.service
#   misc/libexec/holo-sync-var.in:332,337-340  the include list = keep-list + every
#     drop-in, each with the leading /etc stripped (sed 's#^/etc##');
#     :381-391  rsync ... --prune-empty-dirs --include="*/"
#     --include-from=<list> --exclude="*" <old upper>/ <new upper>/
# That is the Deck OLED's damage exactly: couchside.service (listed) survived;
# /etc/couchside, the udev rules and modules-load (not listed) were dropped.
#
# What this runs: the REAL (f4) block lifted out of install.sh (tmp root, sudo
# pass-through), then Valve's filter reproduced with real rsync over a fake /etc
# overlay upper -- the same include/exclude rules; the -goHA/--checksum flags,
# which do not affect WHICH files pass, are left out so this runs unprivileged.
#
# CONTROL, in-file, both states: the same upper synced WITHOUT our drop-in drops
# every Couchside piece but the unit (the Deck damage, reproduced); WITH it every
# piece the agent's install_health checks survives. A stray non-Couchside file
# and a foreign udev rule are dropped either way (the drop-in keeps only ours).
set -u
SRC="${1:?usage: test_installer_steamos_keep.sh /path/to/install.sh}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
fails=0
check() { if [ "$2" -eq 0 ]; then echo "  PASS  $1"; else echo "  FAIL  $1"; fails=$((fails+1)); fi; }

block="$(awk '/^# \(f4\) SteamOS: /{f=1} f&&/^# \(g\) systemd unit/{exit} f' "$SRC")"
lines=$(printf '%s\n' "$block" | wc -l | tr -d ' ')
[ "$lines" -gt 20 ] && [ "$lines" -lt 90 ]
check "(f4) block extracts and is bounded ($lines lines)" $?

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

run_f4() { # run_f4 <root>
    local root="$1"
    mkdir -p "$tmp/work"
    {
        echo 'set -euo pipefail'
        echo 'say()  { echo "==> $*"; }'
        echo 'note() { echo "    $*"; }'
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
SUDO
        echo "WORK_DIR='$tmp/work'"
        # Redirect ONLY the drop-in dir: a blanket /etc/ rewrite would also
        # rewrite the keep-list CONTENT (the heredoc), which must stay /etc/...
        printf '%s\n' "$block" | sed "s#/etc/atomic-update.conf.d#$root/etc/atomic-update.conf.d#g"
        echo 'echo F4_DONE'
    } > "$tmp/f4.sh"
    bash "$tmp/f4.sh" > "$tmp/f4.out" 2>&1
}

echo "the drop-in is written only where SteamOS reads one"
mkdir -p "$tmp/bazzite/etc"
run_f4 "$tmp/bazzite"; rc=$?
check "runs on a box without /etc/atomic-update.conf.d (rc=$rc)" "$rc"
[ ! -e "$tmp/bazzite/etc/atomic-update.conf.d/couchside.conf" ]
check "no drop-in on a non-SteamOS box" $?
mkdir -p "$tmp/deck/etc/atomic-update.conf.d"
run_f4 "$tmp/deck"; rc=$?
check "runs on SteamOS (rc=$rc)" "$rc"
KEEP="$tmp/deck/etc/atomic-update.conf.d/couchside.conf"
[ -s "$KEEP" ]; check "drop-in written" $?
grep -q '^/etc/\*\*$\|^/etc/\*$\|^/\*\*$' "$KEEP"
[ $? -ne 0 ]; check "drop-in never keeps all of /etc (Valve's DANGEROUS example)" $?
bad=$(grep -v '^#' "$KEEP" | grep -v '^$' | grep -vc 'couchside')
check "every kept path is a Couchside path (found $bad foreign)" "$bad"
grep -q 'atomic-update.conf.d/couchside.conf' <(awk '/^if \[ "\$UNINSTALL" -eq 1 \]; then/,/^fi$/' "$SRC")
check "--uninstall removes the drop-in" $?

echo "Valve's filter, reproduced with rsync over a fake /etc upper"
command -v rsync >/dev/null 2>&1; check "rsync is available (the filter is rsync's)" $?
upper="$tmp/upper"
# Every root-owned piece the agent checks, at its real /etc path, plus the unit,
# the drop-in itself, a stray file and a FOREIGN udev rule as controls.
PIECES="$(AGENT="$ROOT_DIR/agent/couchsided.py" python3 - <<'PY'
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("couchsided", os.environ["AGENT"])
cs = importlib.util.module_from_spec(spec); sys.modules["couchsided"] = cs
spec.loader.exec_module(cs)
print("\n".join(sorted(cs._INSTALL_PIECE_PATHS.values())))
PY
)"
extra="/etc/sudoers.d/zz-couchside /etc/couchside/openpuck/firmware.uf2 /etc/systemd/network/50-couchside-wol.link"
for p in $PIECES $extra /etc/atomic-update.conf.d/couchside.conf /etc/stray-user-edit.conf \
         /etc/udev/rules.d/70-someone-else.rules; do
    mkdir -p "$upper$(dirname "${p#/etc}")"
    echo "x" > "$upper${p#/etc}"
done
cp "$KEEP" "$upper/atomic-update.conf.d/couchside.conf"

sync_upper() { # sync_upper <dst> <with-dropin 0/1>
    local cfg="$tmp/filter.$2"
    # The two default keep-list lines this test relies on (keep-conf.in:14, :38).
    printf '%s\n' '/etc/atomic-update.conf.d/*.conf' '/etc/systemd/system/*.service' \
        | sed 's#^/etc##' > "$cfg"
    if [ "$2" = 1 ]; then
        printf '\n%s' "$(sed 's#^/etc##' "$upper/atomic-update.conf.d/couchside.conf")" >> "$cfg"
    fi
    rm -rf "$1"; mkdir -p "$1"
    rsync -rlpD --delete --one-file-system --prune-empty-dirs \
        --include="*/" --include-from="$cfg" --exclude="*" "$upper/" "$1/"
}

sync_upper "$tmp/after-without" 0; rc=$?
check "rsync ran without the drop-in (rc=$rc)" "$rc"
sync_upper "$tmp/after-with" 1; rc=$?
check "rsync ran with the drop-in (rc=$rc)" "$rc"

for p in $PIECES; do
    [ -e "$tmp/after-with${p#/etc}" ]; check "WITH drop-in: $p survives the update" $?
done
[ -e "$tmp/after-with/couchside/openpuck/firmware.uf2" ]; check "WITH: nested /etc/couchside file survives (**)" $?
[ -e "$tmp/after-with/systemd/network/50-couchside-wol.link" ]; check "WITH: WoL .link survives" $?
[ -e "$tmp/after-with/sudoers.d/zz-couchside" ]; check "WITH: the sudoers grant file survives (sudoers_grant)" $?
[ ! -e "$tmp/after-without/sudoers.d/zz-couchside" ]; check "WITHOUT: the sudoers grant file is dropped" $?
[ -e "$tmp/after-with/atomic-update.conf.d/couchside.conf" ]; check "WITH: the drop-in keeps itself (keep-conf.in:14)" $?
[ ! -e "$tmp/after-with/stray-user-edit.conf" ]; check "WITH: a stray /etc edit is still dropped" $?
[ ! -e "$tmp/after-with/udev/rules.d/70-someone-else.rules" ]; check "WITH: a foreign udev rule is still dropped" $?

echo "CONTROL: without the drop-in the Deck's damage reproduces"
[ -e "$tmp/after-without/systemd/system/couchside.service" ]; check "WITHOUT: the unit survives (on Valve's list)" $?
lost=0
for p in $PIECES; do
    case "$p" in /etc/systemd/system/*) continue ;; esac
    [ -e "$tmp/after-without${p#/etc}" ] && lost=$((lost+1))
done
check "WITHOUT: every other Couchside piece is dropped ($lost survived)" "$lost"
[ ! -e "$tmp/after-without/couchside" ]; check "WITHOUT: /etc/couchside is gone entirely" $?

echo
if [ "$fails" -gt 0 ]; then echo "FAILED: $fails"; exit 1; fi
echo "all SteamOS keep-list checks passed"
