#!/usr/bin/env bash
# An OPTIONAL step must never abort an app-triggered update (KI-064).
#
# install.sh runs `set -euo pipefail`. The phone's update runs it DETACHED, so on
# a box whose desktop user has a sudo password there is no tty to type it into
# and no way to become root. An unguarded `sudo` in an OPTIONAL step therefore
# killed the whole run BEFORE the service restart, leaving the freshly-downloaded
# agent on disk and the OLD one still serving. Observed on a real Legion Go
# (2026-08-16): the OpenPuck firmware seed did exactly this.
#
# install.sh already had the right idea one screen further down -- the
# CAN_PRIVILEGE fast-path, whose own comment cites the same stall on a Legion Go
# S in 2026-07-23. The seed just ran BEFORE that gate could save it.
#
# These pins are textual (what lands on boxes is this text), plus one executable
# check: the seed block is driven with a `sudo` that always fails, exactly as a
# detached no-password run sees it, and must NOT abort.
set -u
SRC="${1:?usage: test_update_no_root.sh /path/to/install.sh}"
fails=0
check() { if [ "$2" -eq 0 ]; then echo "  PASS  $1"; else echo "  FAIL  $1"; fails=$((fails+1)); fi; }

echo "the privilege probe is available to the optional steps"
# The probe must be computed BEFORE the first optional sudo, not at the
# fast-path gate -- that ordering is the whole bug.
probe_line=$(grep -n '^CAN_PRIVILEGE=0' "$SRC" | head -1 | cut -d: -f1)
seed_line=$(grep -n 'sudo install .*OPENPUCK_FW_DEST' "$SRC" | head -1 | cut -d: -f1)
[ -n "$probe_line" ]; check "CAN_PRIVILEGE probe exists" $?
[ -n "$probe_line" ] && [ -n "$seed_line" ] && [ "$probe_line" -lt "$seed_line" ]
check "probe is computed BEFORE the optional seed (probe=$probe_line seed=$seed_line)" $?

echo "the optional seed cannot abort the run"
grep -q 'skipping the OpenPuck seed' "$SRC"
check "seed skips (with a note) when root is unavailable" $?
# Every sudo in the seed block must be non-fatal: gated on CAN_PRIVILEGE and
# carrying its own || fallback.
seed_block=$(awk '/^if \[ -f "\$WORK_DIR\/\$OPENPUCK_FW_NAME" \]; then/,/^fi$/' "$SRC")
bare=$(printf '%s\n' "$seed_block" | grep -c 'sudo install' || true)
guarded=$(printf '%s\n' "$seed_block" | grep -A1 'sudo install' | grep -c '|| note' || true)
[ "$bare" -gt 0 ] && [ "$guarded" -ge 2 ]
check "each sudo install in the seed has a || note fallback ($guarded/$bare)" $?

echo "executable check: a sudo that cannot prompt must not kill the run"
tmp="$(mktemp -d)"
mkdir -p "$tmp/bin"
# Exactly what a detached run sees from a password-sudo box.
cat > "$tmp/bin/sudo" <<'EOF'
#!/bin/sh
if [ "$1" = "-n" ] && [ "$2" = "true" ]; then exit 1; fi
echo "sudo: a terminal is required to read the password" >&2
echo "sudo: a password is required" >&2
exit 1
EOF
chmod +x "$tmp/bin/sudo"
# Drive ONLY the seed block, with the same strictness install.sh runs under.
{
  echo 'set -euo pipefail'
  echo 'note() { echo "    $*"; }'
  echo "OPENPUCK_FW_NAME=fw.uf2"
  echo "OPENPUCK_FW_DEST=$tmp/dest/fw.uf2"
  echo "WORK_DIR=$tmp/work"
  # Make the sha match so we reach the sudo path rather than the mismatch note.
  echo "OPENPUCK_FW_SHA256=\$( { command -v sha256sum >/dev/null 2>&1 && sha256sum $tmp/work/fw.uf2 || shasum -a 256 $tmp/work/fw.uf2; } | cut -d' ' -f1)"
  awk '/^# Can we get root at all\?/,/^fi$/' "$SRC" | head -14   # the probe
  awk '/^if \[ -f "\$WORK_DIR\/\$OPENPUCK_FW_NAME" \]; then/,/^fi$/' "$SRC"
  echo 'echo REACHED_END'
} > "$tmp/drive.sh"
mkdir -p "$tmp/work"; echo firmware > "$tmp/work/fw.uf2"
out="$(PATH="$tmp/bin:$PATH" bash "$tmp/drive.sh" 2>&1)"; rc=$?
printf '%s\n' "$out" | grep -q REACHED_END
check "the run CONTINUES past an unanswerable sudo (rc=$rc)" $?
printf '%s\n' "$out" | grep -q 'skipping the OpenPuck seed'
check "and says why, instead of failing silently" $?
rm -rf "$tmp"

echo
if [ "$fails" -gt 0 ]; then echo "FAILED: $fails"; exit 1; fi
echo "all no-root update pins passed"
