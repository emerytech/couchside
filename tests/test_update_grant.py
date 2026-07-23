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
    """The couchside-sudoers heredoc body (the rules that become the file)."""
    m = re.search(r'cat > "\$WORK_DIR/couchside-sudoers" <<SUDOERS\n(.*?)\nSUDOERS\n',
                  SRC, re.S)
    assert m, "could not find the couchside-sudoers heredoc"
    return m.group(1)


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


if __name__ == "__main__":
    for fn in (test_restart_grant_is_present_and_exact,
               test_no_wildcard_in_any_couchside_grant,
               test_restart_is_no_block,
               test_fastpath_is_gated_and_short_circuits_before_root_setup):
        fn()
    if FAILURES:
        print("\n%d FAILED: %s" % (len(FAILURES), ", ".join(FAILURES)))
        sys.exit(1)
    print("\nall good")
