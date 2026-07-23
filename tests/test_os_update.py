#!/usr/bin/env python3
"""Tests for the OS-update slice of the update hub.

Run: python3 tests/test_os_update.py

Atomic OS updates (SteamOS / Bazzite) STAGE a new image for the next boot. Two
things this file pins:

1. THE SECURITY SHAPE (CLAUDE.md §3): no client-supplied identifier. os_update_
   apply takes no argument, the argv is a frozen [sudo, -n, <wrapper>, apply],
   and the installer wrapper validates its mode to exactly check|apply and
   never forwards it — so the grant can't reach another rpm-ostree subcommand
   (which can layer packages, override, rebase).
2. THE HONESTY (§11.4): os_status reads the STAGED state back from
   `rpm-ostree status --json`, so the app says "reboot to apply" and never
   reports an atomic update as done when it has only been staged.

MEASURED 2026-07-22: `rpm-ostree upgrade --check` from the sessionless agent is
denied by polkit ("AutomaticUpdateTrigger not allowed for user"); root via the
wrapper bypasses it. Elevation is the same opt-in as the flatpak slice.
"""
import importlib.util
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location(
    "couchsided", os.path.join(ROOT, "agent", "couchsided.py"))
cs = importlib.util.module_from_spec(_spec)
sys.modules["couchsided"] = cs
_spec.loader.exec_module(cs)

FAILURES = []


def check(name, got, want):
    if got == want:
        print("  PASS  %s" % name)
    else:
        print("  FAIL  %s (got %r, want %r)" % (name, got, want))
        FAILURES.append(name)


class SpyPopen:
    def __init__(self):
        self.argv = None
        self._real = cs.subprocess.Popen

    def __enter__(self):
        outer = self

        class P:
            def __init__(self, argv, env=None, **kw):
                outer.argv = list(argv)

            def poll(self):
                return None

        cs.subprocess.Popen = P
        return self

    def __exit__(self, *a):
        cs.subprocess.Popen = self._real


def test_apply_takes_no_argument():
    print("test_apply_takes_no_argument")
    check("os_update_apply takes zero parameters",
          cs.os_update_apply.__code__.co_argcount, 0)


def test_apply_runs_exactly_the_wrapper():
    """The frozen argv: sudo -n <wrapper> apply. 'apply' is a literal here, not
    a client value; the wrapper re-validates it anyway."""
    print("test_apply_runs_exactly_the_wrapper")
    ok = cs.os_updater_kind, cs.os_can_elevate
    cs.os_updater_kind = lambda: "rpm-ostree"
    cs.os_can_elevate = lambda: True
    try:
        with SpyPopen() as spy:
            r = cs.os_update_apply()
        check("argv is sudo -n <wrapper> apply",
              spy.argv, ["sudo", "-n", cs.OS_UPDATE_WRAPPER, "apply"])
        check("started", r.get("started"), True)
    finally:
        cs.os_updater_kind, cs.os_can_elevate = ok


def test_apply_without_grant_refuses_no_fallback():
    """Unlike flatpak there is NO --user fallback for an OS image: without the
    grant it must refuse and say so, never silently do nothing that looks like
    success."""
    print("test_apply_without_grant_refuses_no_fallback")
    ok = cs.os_updater_kind, cs.os_can_elevate
    cs.os_updater_kind = lambda: "rpm-ostree"
    cs.os_can_elevate = lambda: False
    try:
        with SpyPopen() as spy:
            r = cs.os_update_apply()
        check("not started", r.get("started"), False)
        check("flags needs_optin", r.get("needs_optin"), True)
        check("ran nothing", spy.argv, None)
    finally:
        cs.os_updater_kind, cs.os_can_elevate = ok


def test_apply_on_non_atomic_box_refuses():
    print("test_apply_on_non_atomic_box_refuses")
    ok = cs.os_updater_kind
    cs.os_updater_kind = lambda: None
    try:
        with SpyPopen() as spy:
            r = cs.os_update_apply()
        check("not started", r.get("started"), False)
        check("ran nothing", spy.argv, None)
    finally:
        cs.os_updater_kind = ok


def test_status_reports_staged_from_rpm_ostree():
    """THE honesty test. A staged deployment in the json must surface as
    staged:True so the app says 'reboot to apply'. Fixture shape is verbatim
    rpm-ostree status --json (measured on the Bazzite box)."""
    print("test_status_reports_staged_from_rpm_ostree")
    ok = cs.os_updater_kind, cs._rpm_ostree_status
    cs.os_updater_kind = lambda: "rpm-ostree"
    cs._rpm_ostree_status = lambda: {"deployments": [
        {"staged": True, "booted": False, "version": "43.20260501"},
        {"staged": False, "booted": True, "version": "43.20260420"},
    ]}
    try:
        s = cs.os_status()
        check("kind", s.get("kind"), "rpm-ostree")
        check("current is the BOOTED version", s.get("current"), "43.20260420")
        check("staged reported true", s.get("staged"), True)
    finally:
        cs.os_updater_kind, cs._rpm_ostree_status = ok


def test_status_not_staged_when_nothing_pending():
    """Observe BOTH states — a status that always said staged:True would fail
    to the safe side but hide a never-updating box behind a perpetual 'reboot'
    nag."""
    print("test_status_not_staged_when_nothing_pending")
    ok = cs.os_updater_kind, cs._rpm_ostree_status
    cs.os_updater_kind = lambda: "rpm-ostree"
    cs._rpm_ostree_status = lambda: {"deployments": [
        {"staged": False, "booted": True, "version": "43.20260420"},
    ]}
    try:
        s = cs.os_status()
        check("not staged", s.get("staged"), False)
        check("current present", s.get("current"), "43.20260420")
    finally:
        cs.os_updater_kind, cs._rpm_ostree_status = ok


def test_elevation_probe_names_the_wrapper():
    print("test_elevation_probe_names_the_wrapper")
    seen = []
    ok = cs._sudo_nopasswd_allows
    cs._sudo_nopasswd_allows = lambda needle: (seen.append(needle) or False)
    try:
        check("cannot elevate without the grant", cs.os_can_elevate(), False)
        check("probe names the OS wrapper", seen, ["couchside-os-update"])
    finally:
        cs._sudo_nopasswd_allows = ok


def test_installer_wrapper_validates_mode_and_never_forwards():
    """The install.sh wrapper must accept ONLY check|apply and never pass its
    argv through to rpm-ostree/steamos-update — else the grant runs any
    subcommand as root."""
    print("test_installer_wrapper_validates_mode_and_never_forwards")
    with open(os.path.join(ROOT, "install.sh")) as f:
        sh = f.read()
    start = sh.index("couchside-os-update [check|apply]")
    end = sh.index("OSWRAP\n", start)
    wrapper = sh[start:end]
    code = "\n".join(ln for ln in wrapper.splitlines()
                     if not ln.lstrip().startswith("#"))
    check("mode validated to check|apply",
          'mode must be check or apply' in wrapper, True)
    # The ONLY expansions passed to the updaters are the fixed arrays, never $@.
    check("never forwards raw argv", '"$@"' in code or "$*" in code, False)
    check("execs rpm-ostree via the fixed array",
          'exec rpm-ostree "${rpm[@]}"' in wrapper, True)
    check("execs steamos-update via the fixed array",
          'exec steamos-update "${steamos[@]}"' in wrapper, True)
    # The opt-in grant names the OS wrapper path, never rpm-ostree.
    grant = sh[sh.index("allow-system-updates)"):sh.index("allow-launchers)")]
    check("grant names the OS wrapper", "NOPASSWD: $OSWRAP" in grant, True)
    check("grant never names rpm-ostree",
          "NOPASSWD: /usr/bin/rpm-ostree" in grant, False)


if __name__ == "__main__":
    for fn in (test_apply_takes_no_argument,
               test_apply_runs_exactly_the_wrapper,
               test_apply_without_grant_refuses_no_fallback,
               test_apply_on_non_atomic_box_refuses,
               test_status_reports_staged_from_rpm_ostree,
               test_status_not_staged_when_nothing_pending,
               test_elevation_probe_names_the_wrapper,
               test_installer_wrapper_validates_mode_and_never_forwards):
        fn()
    if FAILURES:
        print("\n%d FAILED: %s" % (len(FAILURES), ", ".join(FAILURES)))
        sys.exit(1)
    print("\nall good")
