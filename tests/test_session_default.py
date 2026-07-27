#!/usr/bin/env python3
"""Tests for the boot session default (game / desktop / last).

Run: python3 tests/test_session_default.py

WHY THIS EXISTS: the obvious implementation is wrong on Bazzite. MEASURED on a
real Bazzite box 2026-07-27:

    $ steamosctl get-default-login-mode
    Error: org.freedesktop.DBus.Error.UnknownInterface: Unknown interface
      'com.steampowered.SteamOSManager1.SessionManagement1'
    $ echo $?
    0

The binary ships, the D-Bus interface behind it does not, AND IT EXITS 0. A
probe that trusts the exit status reports this backend working on every Bazzite
box and then silently does nothing — the exact "confident wrong claim" shape
CLAUDE.md §11 is about. So the probe reads OUTPUT, and the first test here is
that specific lie.

SECURITY: the mode is a client-supplied string that ends in a root-owned file
write. It is membership-checked against a frozen tuple and then only ever
COMPARED — the session filename written comes from the agent's own table. The
rejection tests are the ones to keep if this file is ever trimmed.
"""
import importlib.util
import os
import sys
import tempfile

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


class FakeRun:
    """Stand in for subprocess.run with a scripted (stdout, stderr, rc)."""

    def __init__(self, stdout="", stderr="", rc=0):
        self.out, self.err, self.rc = stdout, stderr, rc
        self.calls = []

    def __call__(self, argv, **kw):
        self.calls.append(list(argv))

        class R:
            pass
        r = R()
        r.stdout, r.stderr, r.returncode = self.out, self.err, self.rc
        return r


def main():
    real_run = cs.subprocess.run
    real_sudo = cs._sudo_nopasswd_allows

    print("the exit-0 lie (Bazzite)")
    # Verbatim from the real box, including the 0 exit status.
    cs.subprocess.run = FakeRun(
        stderr=("Error: org.freedesktop.DBus.Error.UnknownInterface: Unknown "
                "interface 'com.steampowered.SteamOSManager1.SessionManagement1'"),
        rc=0)
    check("steamosctl backend refused despite exit 0",
          cs._steamosctl_session_ok(), False)
    # Control: a healthy SteamOS box answers with a mode and IS accepted.
    cs.subprocess.run = FakeRun(stdout="game\n", rc=0)
    check("...and a real answer is accepted", cs._steamosctl_session_ok(), True)
    # An empty answer is not an answer.
    cs.subprocess.run = FakeRun(stdout="", rc=0)
    check("empty output is refused", cs._steamosctl_session_ok(), False)

    print("backend selection")
    cs.subprocess.run = FakeRun(stdout="desktop\n", rc=0)
    cs._sudo_nopasswd_allows = lambda needle: True
    check("steamosctl wins when both are usable",
          cs.session_default_backend(), "steamosctl")
    cs.subprocess.run = FakeRun(stderr="Error: UnknownInterface", rc=0)
    check("falls back to sddm on Bazzite", cs.session_default_backend(), "sddm")
    cs._sudo_nopasswd_allows = lambda needle: False
    check("no grant -> NO backend (degrade closed)",
          cs.session_default_backend(), None)
    check("...so the capability is absent", cs.session_default_available(), False)

    print("the route's allowlist")
    # Membership is what the route checks; anything outside is a 400.
    for bad in ("gamemode", "GAME", "", None, "desktop; reboot", "../../x",
                "last;rm -rf /", 1, True):
        check("rejects %r" % (bad,), bad in cs.SESSION_DEFAULT_MODES, False)
    for good in ("game", "desktop", "last"):
        check("accepts %r" % good, good in cs.SESSION_DEFAULT_MODES, True)

    print("no backend -> set fails rather than pretending")
    cs.subprocess.run = FakeRun(stderr="Error: UnknownInterface", rc=0)
    cs._sudo_nopasswd_allows = lambda needle: False
    check("set() reports failure", cs.session_default_set("game")["ok"], False)

    print("the sddm drop-in body")
    # We must NEVER edit the box's own steamos.conf; we write our own file.
    check("drop-in sorts after the distro's own file",
          os.path.basename(cs.SDDM_DROPIN) > "steamos.conf", True)
    check("drop-in is a separate file from the distro's",
          cs.SDDM_DROPIN.endswith("zz-couchside-session.conf"), True)

    written = {}

    def fake_tee(argv, **kw):
        written["argv"] = list(argv)
        written["body"] = kw.get("input", "")

        class R:
            pass
        r = R()
        r.returncode, r.stdout, r.stderr = 0, "", ""
        return r

    cs.subprocess.run = fake_tee
    cs._sudo_nopasswd_allows = lambda needle: True
    # force the sddm path
    ok = cs._sddm_write(cs.GAMESCOPE_SESSION_FILE)
    check("write returns ok", ok, True)
    check("writes via sudo tee at the FIXED path",
          written["argv"], ["sudo", "-n", "tee", cs.SDDM_DROPIN])
    check("body sets the gamescope session",
          "Session=%s" % cs.GAMESCOPE_SESSION_FILE in written["body"], True)
    check("body says how to undo it",
          "Delete this file" in written["body"], True)

    print("reading the current mode")
    tmp = tempfile.mkdtemp()
    drop = os.path.join(tmp, "zz.conf")
    with open(drop, "w") as f:
        f.write("[Autologin]\nSession=gamescope-session.desktop\n")
    old = cs.SDDM_DROPIN
    cs.SDDM_DROPIN = drop
    try:
        check("reads game from our drop-in",
              cs._sddm_current_session_file(), "gamescope-session.desktop")
        with open(drop, "w") as f:
            f.write("[Autologin]\nSession=/usr/share/wayland-sessions/plasma.desktop\n")
        check("basenames a full path", cs._sddm_current_session_file(),
              "plasma.desktop")
        with open(drop, "w") as f:
            f.write("[Autologin]\n")
        cs.SDDM_STATE = os.path.join(tmp, "missing.conf")
        check("no Session anywhere -> empty, not a guess",
              cs._sddm_current_session_file(), "")
    finally:
        cs.SDDM_DROPIN = old
        cs.subprocess.run = real_run
        cs._sudo_nopasswd_allows = real_sudo
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)

    print()
    if FAILURES:
        print("FAILED: %s" % ", ".join(FAILURES))
        return 1
    print("all session-default tests passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
