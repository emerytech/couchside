#!/usr/bin/env python3
"""Security-shape tests for the app-triggered-update sudo grant + fast-path.

Run: python3 tests/test_update_grant.py

WHY THIS EXISTS (CLAUDE.md §3). A real box (Legion Go S, system-service install,
2026-07-23) took a phone-triggered update that downloaded the new agent and then
STALLED: the detached installer had no terminal to type a sudo password into, so
it never restarted the service and the old version kept running.

The fix adds ONE NOPASSWD grant so the detached update can restart the service —
and a grant in the sudo path is exactly where this project's zero-tolerance rule
applies. These assertions pin the grant's SHAPE so a future edit can't widen it:

  * it is EXACTLY-argument (fixed unit, fixed --no-block) — no wildcard, no bare
    `systemctl` that would let any unit be restarted;
  * it adds no privilege (couchside.service runs the user's own code as the
    user), which is why restarting it is safe to grant;
  * the detached fast-path is gated (existing install, token present, not Decky)
    and short-circuits BEFORE the general-root setup it cannot perform.

This reads install.sh as text — the grant lives in a heredoc, and the point is
the literal rule that lands in /etc/sudoers.d, so text is the right level.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = open(os.path.join(ROOT, "install.sh"), encoding="utf-8").read()

FAILURES = []


def check(name, got, want):
    if got == want:
        print("  PASS  %s" % name)
    else:
        print("  FAIL  %s (got %r, want %r)" % (name, got, want))
        FAILURES.append(name)


def _sudoers_block():
    """The couchside-sudoers heredoc bodies, concatenated in order.

    Since 2.9.66 the file is assembled from several appends — the
    display-manager grants are conditional on the manager DETECTED at install
    time — and what lands in /etc/sudoers.d is the concatenation, so the shape
    tests read that same union. (The conditional lines carry $DM_NAME, which is
    allowlisted to sddm|plasmalogin before the heredoc runs; these tests treat
    it as the literal text it is.)"""
    parts = re.findall(
        r'cat >>? "\$WORK_DIR/couchside-sudoers" <<SUDOERS\n(.*?)\nSUDOERS\n',
        SRC, re.S)
    assert parts, "could not find the couchside-sudoers heredocs"
    return "\n".join(parts)


def test_restart_grant_is_present_and_exact():
    print("test_restart_grant_is_present_and_exact")
    block = _sudoers_block()
    grant = "$USER_NAME ALL=(root) NOPASSWD: /usr/bin/systemctl restart --no-block couchside.service"
    check("exact restart grant present", grant in block, True)
    # Absolute binary path (never a bare `systemctl` sudo could resolve loosely).
    check("grant uses the absolute systemctl path",
          "/usr/bin/systemctl restart --no-block couchside.service" in block, True)


def test_no_wildcard_in_any_couchside_grant():
    """A wildcard on systemctl (e.g. `restart *`) would let ANY unit be
    restarted as root. Every couchside command grant must be fixed-argument."""
    print("test_no_wildcard_in_any_couchside_grant")
    block = _sudoers_block()
    cmd_lines = [ln for ln in block.splitlines()
                 if "NOPASSWD:" in ln and not ln.lstrip().startswith("#")]
    check("there are command grants to check", len(cmd_lines) >= 5, True)
    # The command is everything after 'NOPASSWD:'. None may contain a glob.
    offenders = [ln for ln in cmd_lines if "*" in ln.split("NOPASSWD:", 1)[1]]
    check("no '*' in any granted command", offenders, [])


def test_restart_is_no_block():
    """The detached updater lives in couchside.service's OWN cgroup; a blocking
    restart would SIGTERM it mid-wait. The grant AND the call must be --no-block,
    and they must match (sudoers matches the full argv)."""
    print("test_restart_is_no_block")
    check("grant carries --no-block",
          "systemctl restart --no-block couchside.service" in _sudoers_block(), True)
    check("the fast-path calls exactly that",
          "sudo -n systemctl restart --no-block couchside.service" in SRC, True)


def test_fastpath_is_gated_and_short_circuits_before_root_setup():
    print("test_fastpath_is_gated_and_short_circuits_before_root_setup")
    # Gated: only when we cannot get root (CAN_PRIVILEGE=0), on an existing
    # install (token present), and only when couchside.service is the LIVE system
    # agent (is-active) -- so restarting it reloads the new binary. Gating on
    # is-active (NOT "Decky absent") is deliberate: the reported box ran
    # couchside.service active WITH Decky installed, and a "! decky_installed"
    # gate wrongly skipped it. A pure/dormant Decky setup is inactive -> skipped.
    check("CAN_PRIVILEGE gate present", "CAN_PRIVILEGE" in SRC, True)
    check("requires an existing token", '[ -s "$TOKEN_FILE" ]' in SRC, True)
    check("gated on couchside.service being active",
          "systemctl is-active --quiet couchside.service" in SRC, True)
    # It must short-circuit (exit 0) BEFORE the first general-root command,
    # `sudo mkdir -p "$ETC_DIR"`. Otherwise `set -e` aborts there exactly as the
    # bug did. Assert ordering by source position.
    i_fastpath = SRC.index("restart --no-block couchside.service 2>/dev/null")
    i_mkdir = SRC.index('sudo mkdir -p "$ETC_DIR"')
    check("fast-path restart comes before the sudo mkdir", i_fastpath < i_mkdir, True)
    # And there is an `exit 0` between the fast-path and that mkdir.
    between = SRC[i_fastpath:i_mkdir]
    check("fast-path exits before the root setup", "exit 0" in between, True)


def test_dm_name_is_allowlisted_before_it_reaches_sudoers():
    """The $DM_NAME sudoers lines are safe ONLY because of shell control flow:
    a `case` allowlist collapses anything but sddm|plasmalogin to "", and a
    non-empty guard keeps the whole grant heredoc out when it is "". That
    control flow IS the security property (§3: reject, don't sanitise), so it
    gets pinned as text exactly like the grants themselves — a future edit that
    loosens the case to a pattern or drops the empty arm must fail here."""
    print("test_dm_name_is_allowlisted_before_it_reaches_sudoers")
    check("detection uses the systemd alias probe",
          "systemctl show -p Id --value display-manager" in SRC, True)
    m = re.search(r'case "\$DM_NAME" in\n(.*?)\nesac', SRC, re.S)
    check("the case allowlist exists", bool(m), True)
    body = m.group(1) if m else ""
    check("it allowlists exactly sddm|plasmalogin", "sddm|plasmalogin)" in body, True)
    check("everything else collapses to EMPTY (no pass-through)",
          'DM_NAME=""' in body, True)
    check("no pattern arm in the allowlist", "*dm)" in body or "*login)" in body, False)
    i_case = SRC.index('case "$DM_NAME" in')
    i_grant = SRC.index("NOPASSWD: /usr/bin/systemctl restart $DM_NAME")
    check("allowlist runs before the grant heredoc", i_case < i_grant, True)
    i_guard = SRC.rfind('if [ -n "$DM_NAME" ]', 0, i_grant)
    check("the grant heredoc sits inside a non-empty guard",
          i_guard != -1 and i_guard > i_case, True)
    # And nothing ELSE unexpanded may reach a granted command: the only
    # variables inside NOPASSWD command text are the allowlisted DM name and
    # the fixed journal-wrapper path.
    cmds = [ln for ln in _sudoers_block().splitlines()
            if "NOPASSWD:" in ln and not ln.lstrip().startswith("#")]
    seen = set()
    for ln in cmds:
        seen |= set(re.findall(r"\$[A-Za-z_][A-Za-z0-9_]*",
                               ln.split("NOPASSWD:", 1)[1]))
    check("only $DM_NAME and $JOURNAL_WRAPPER expand inside granted commands",
          seen <= {"$DM_NAME", "$JOURNAL_WRAPPER"}, True)


if __name__ == "__main__":
    for fn in (test_restart_grant_is_present_and_exact,
               test_no_wildcard_in_any_couchside_grant,
               test_restart_is_no_block,
               test_fastpath_is_gated_and_short_circuits_before_root_setup,
               test_dm_name_is_allowlisted_before_it_reaches_sudoers):
        fn()
    if FAILURES:
        print("\n%d FAILED: %s" % (len(FAILURES), ", ".join(FAILURES)))
        sys.exit(1)
    print("\nall good")
