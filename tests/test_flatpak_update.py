#!/usr/bin/env python3
"""Tests for the flatpak update slice of the update hub.

Run: python3 tests/test_flatpak_update.py

THE SECURITY SHAPE IS THE FEATURE (CLAUDE.md §3). There is NO client-supplied
identifier anywhere in this path: the route is a fixed literal and the argv is
one of two FROZEN lists chosen by the agent from the elevation probe. The first
tests assert that shape directly — that the update functions take no argument a
client could reach, and that the elevated path invokes the fixed wrapper path,
never `flatpak` with client-shaped args.

MEASURED background (2026-07-22, real box): a plain `flatpak update` of SYSTEM
installs from the sessionless agent is denied by polkit ("Flatpak system
operation Deploy not allowed for user"), so elevation is via a root-owned
zero-argument wrapper granted by the `couchside allow-system-updates` opt-in.
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
    """Capture the argv instead of running anything."""

    def __init__(self):
        self.argv = None
        self.env = None
        self._real = cs.subprocess.Popen

    def __enter__(self):
        outer = self
        # flatpak_update refuses a second launch while its last child is alive
        # (agent >= 2.9.108) and the handle is MODULE state, so a stub child
        # left by the previous test would make this one a no-op. Start clean.
        cs._FLATPAK_PROC = None

        class P:
            def __init__(self, argv, env=None, **kw):
                outer.argv = list(argv)
                outer.env = env

            def poll(self):
                return None      # "still running" — the success path

            def wait(self, timeout=None):
                # flatpak_update now waits (bounded) instead of sleep+poll; a
                # live child returns None here just as poll() does.
                return self.poll()

        cs.subprocess.Popen = P
        return self

    def __exit__(self, *a):
        cs.subprocess.Popen = self._real
        cs._FLATPAK_PROC = None


def test_takes_no_argument():
    """THE test. If flatpak_update ever grows a parameter (a ref, a package, a
    scope), a client-supplied value can steer what runs as root."""
    print("test_takes_no_argument")
    check("flatpak_update takes zero parameters",
          cs.flatpak_update.__code__.co_argcount, 0)
    check("flatpak_pending_updates takes zero parameters",
          cs.flatpak_pending_updates.__code__.co_argcount, 0)


def test_elevated_runs_exactly_the_wrapper():
    """With the opt-in grant present, the argv must be exactly
    [sudo, -n, <wrapper path>] — the fixed root-owned script, no extra args,
    never `flatpak` itself (whose subcommands include install/run/override)."""
    print("test_elevated_runs_exactly_the_wrapper")
    old = cs.flatpak_can_elevate
    cs.flatpak_can_elevate = lambda: True
    try:
        with SpyPopen() as spy:
            r = cs.flatpak_update()
        check("argv is exactly sudo -n <wrapper>",
              spy.argv, ["sudo", "-n", cs.FLATPAK_UPDATE_WRAPPER])
        check("reports elevated", r.get("elevated"), True)
        check("reports started", r.get("started"), True)
    finally:
        cs.flatpak_can_elevate = old


def test_unelevated_runs_exactly_the_user_update():
    """Without the grant: the frozen --user argv, no sudo anywhere. Observing
    BOTH states — a probe hardwired True would pass the test above and
    silently sudo on every box."""
    print("test_unelevated_runs_exactly_the_user_update")
    old = cs.flatpak_can_elevate
    cs.flatpak_can_elevate = lambda: False
    try:
        with SpyPopen() as spy:
            r = cs.flatpak_update()
        check("argv is the frozen --user list",
              spy.argv, ["flatpak", "update", "--user", "-y",
                         "--noninteractive"])
        check("no sudo in the unelevated argv", "sudo" in spy.argv, False)
        check("reports elevated=False", r.get("elevated"), False)
    finally:
        cs.flatpak_can_elevate = old


def test_second_launch_is_refused_while_one_runs():
    """A re-POST while an update is live (a second phone, an app restart
    mid-drain, a double tap) must NOT spawn a second updater: that truncated
    the live transcript and re-pointed the running-handle at the wrong child.
    Both directions: a live child blocks; a finished one does not."""
    print("test_second_launch_is_refused_while_one_runs")

    class Live:
        def poll(self):
            return None      # still running

    class Done:
        def poll(self):
            return 0         # exited

    old = cs.flatpak_can_elevate
    cs.flatpak_can_elevate = lambda: False
    try:
        with SpyPopen() as spy:
            cs._FLATPAK_PROC = Live()
            r = cs.flatpak_update()
            check("live child -> not started", r.get("started"), False)
            check("live child -> says it is running", r.get("running"), True)
            check("live child -> error names the reason",
                  "already running" in (r.get("error") or ""), True)
            check("live child -> NOTHING was spawned", spy.argv, None)
        with SpyPopen() as spy:
            cs._FLATPAK_PROC = Done()   # CONTROL: a finished child does not block
            r = cs.flatpak_update()
            check("finished child -> a new update starts", r.get("started"), True)
            check("finished child -> the frozen argv ran",
                  spy.argv, ["flatpak", "update", "--user", "-y", "--noninteractive"])
    finally:
        cs.flatpak_can_elevate = old
        cs._FLATPAK_PROC = None


def test_elevation_probe_degrades_closed():
    """_sudo_nopasswd_allows returning False (no grant / probe error) must mean
    no elevation — never a dead sudo attempt."""
    print("test_elevation_probe_degrades_closed")
    old = cs._sudo_nopasswd_allows
    cs._sudo_nopasswd_allows = lambda needle: False
    try:
        check("no grant -> cannot elevate", cs.flatpak_can_elevate(), False)
    finally:
        cs._sudo_nopasswd_allows = old
    # And the probe asks about the WRAPPER, not about flatpak: a grant on raw
    # flatpak must not light this up.
    seen = []
    cs._sudo_nopasswd_allows = lambda needle: (seen.append(needle) or True)
    try:
        cs.flatpak_can_elevate()
        check("probe names the wrapper", seen, ["couchside-flatpak-update"])
    finally:
        cs._sudo_nopasswd_allows = old


def test_installer_wrapper_takes_no_arguments():
    """The install.sh heredoc wrapper must IGNORE its argv: `exec flatpak ...`
    with no "$@". Forwarding args would let the sudoers grant run any flatpak
    subcommand as root — the exact hole the wrapper exists to close."""
    print("test_installer_wrapper_takes_no_arguments")
    with open(os.path.join(ROOT, "install.sh")) as f:
        sh = f.read()
    start = sh.index("couchside-flatpak-update: update SYSTEM flatpaks")
    end = sh.index("FPWRAP", start)
    wrapper = sh[start:end]
    # Strip comments first: the wrapper's own comment EXPLAINS why "$@" is
    # ignored, which the naive check read as a violation. Only code lines count.
    code = "\n".join(ln for ln in wrapper.splitlines()
                     if not ln.lstrip().startswith("#"))
    check("wrapper never forwards argv", '"$@"' in code or "$*" in code,
          False)
    check("wrapper execs the fixed system update",
          "exec flatpak update --system -y --noninteractive" in wrapper, True)
    # The grant must name the wrapper path, not the flatpak binary.
    grant = sh[sh.index("allow-system-updates)"):]
    grant = grant[:grant.index("allow-launchers)")]
    check("grant names the wrapper path",
          "NOPASSWD: $WRAP" in grant, True)
    check("grant never names raw flatpak",
          "NOPASSWD: /usr/bin/flatpak" in grant, False)


def test_log_reader_is_constant_path():
    """read_flatpak_log takes only a limit — no path parameter for a client to
    aim at another file."""
    print("test_log_reader_is_constant_path")
    import inspect
    params = list(inspect.signature(cs.read_flatpak_log).parameters)
    check("only a limit parameter", params, ["limit"])
    # Missing file reads as [] (degrade closed), never an exception.
    old = cs.FLATPAK_UPDATE_LOG
    cs.FLATPAK_UPDATE_LOG = "/nonexistent/definitely-not-here.log"
    try:
        check("missing log reads as empty", cs.read_flatpak_log(), [])
    finally:
        cs.FLATPAK_UPDATE_LOG = old


if __name__ == "__main__":
    for fn in (test_takes_no_argument,
               test_elevated_runs_exactly_the_wrapper,
               test_unelevated_runs_exactly_the_user_update,
               test_second_launch_is_refused_while_one_runs,
               test_elevation_probe_degrades_closed,
               test_installer_wrapper_takes_no_arguments,
               test_log_reader_is_constant_path):
        fn()
    if FAILURES:
        print("\n%d FAILED: %s" % (len(FAILURES), ", ".join(FAILURES)))
        sys.exit(1)
    print("\nall good")
