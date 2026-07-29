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



def test_autologin_session_must_exist():
    """The stranding bug, 2026-07-27 — and why this is the most important test
    in this file.

    "Boots into: Desktop" wrote an autologin session that did not exist on the
    box. `_default_desktop_session()` asks `steamosctl get-default-desktop-
    session`; on Bazzite that D-Bus interface is absent, so the read returned
    empty and we fell back to the hardcoded "plasmax11.desktop" — a SteamOS
    name. SDDM's own log, from the failing boot:

        Unable to find autologin session entry "plasmax11.desktop"
        Autologin failed!

    The box came up at the GREETER. The owner logged in by hand, SDDM used its
    [Last] session (gamescope), and the setting looked like it had done nothing
    while actually having broken autologin. On a box whose agent is a systemd
    --user service, no login means NO AGENT — so the phone could not reach the
    box to undo it. Stranding a box at a password prompt is precisely the
    failure this product exists to prevent.

    FIXTURES ARE VERBATIM listings from the two real distros (CLAUDE.md §6):
    Bazzite captured off bazzite.local, SteamOS being the x11-name image. The
    same code must be right on BOTH — that is the whole point.
    """
    print("test_autologin_session_must_exist")
    saved_inst = cs._installed_session_files
    saved_cfg = cs._default_desktop_session
    try:
        BAZZITE = {"gamescope-session.desktop", "gamescope-session-steam.desktop",
                   "plasma.desktop", "plasma-steamos-wayland-oneshot.desktop",
                   "plasma-steamos-oneshot.desktop"}
        STEAMOS = {"gamescope-session.desktop", "plasma.desktop",
                   "plasmax11.desktop"}

        def setup(installed, configured):
            cs._installed_session_files = lambda: set(installed)
            cs._default_desktop_session = lambda: (configured, "plasma")

        # THE BUG: Bazzite, with the unreadable steamosctl driving the bad
        # fallback. Must NOT return the missing name.
        setup(BAZZITE, "plasmax11.desktop")
        pick = cs._desktop_session_for_autologin()
        check("bazzite never picks the missing plasmax11", pick != "plasmax11.desktop", True)
        check("bazzite picks a session that EXISTS", pick in BAZZITE, True)

        # CONTROL, the other distro: SteamOS genuinely HAS plasmax11, so the
        # fix must not have broken it by blanket-avoiding that name.
        setup(STEAMOS, "plasmax11.desktop")
        check("steamos still honours its own configured x11 session",
              cs._desktop_session_for_autologin(), "plasmax11.desktop")

        # A Wayland-configured box is honoured on both, not downgraded.
        for label, inst in (("bazzite", BAZZITE), ("steamos", STEAMOS)):
            setup(inst, "plasma.desktop")
            check("%s honours a Wayland-configured desktop" % label,
                  cs._desktop_session_for_autologin(), "plasma.desktop")

        # REFUSE rather than strand: nothing installed, or only Game Mode.
        setup(set(), "plasmax11.desktop")
        check("cannot enumerate -> refuse", cs._desktop_session_for_autologin(), None)
        setup({"gamescope-session.desktop"}, "plasmax11.desktop")
        check("no desktop session at all -> refuse", cs._desktop_session_for_autologin(), None)

        # The write itself is guarded, so no future caller can route around it.
        cs._installed_session_files = lambda: BAZZITE
        check("_sddm_write refuses a session that is not installed",
              cs._sddm_write("plasmax11.desktop"), False)
    finally:
        cs._installed_session_files = saved_inst
        cs._default_desktop_session = saved_cfg



def test_dropin_outranks_the_platforms_own():
    """Our drop-in must WIN against steamos-session-select's (2026-07-27).

    SDDM reads /etc/sddm.conf.d/*.conf alphabetically and the LAST file wins.
    Both SteamOS and Bazzite ship `steamos-session-select`, which writes its own
    autologin drop-in at zz-steamos-autologin.conf. Our old name, zz-couchside-
    session.conf, sorts BEFORE that ("c" < "s") — so the platform's file won and
    the user's "Boots into" choice silently stopped applying. That script runs
    on every Couch Mode switch and every switch-to-desktop action, so it rewrote
    the winning file routinely. MEASURED on a real box: both files present,
    theirs last, effective session theirs.

    We do NOT call steamos-session-select instead: it ends with an unconditional
    `systemctl restart sddm` (verified by running it), which kills the user's
    current session. A preference about the NEXT boot must never log somebody
    out of the one they are in.

    This test is a sort comparison because that is literally the mechanism.
    """
    print("test_dropin_outranks_the_platforms_own")
    ours = os.path.basename(cs.SDDM_DROPIN)
    theirs = "zz-steamos-autologin.conf"
    check("our drop-in sorts AFTER steamos-session-select's", ours > theirs, True)
    # CONTROL: the old name genuinely lost — proving the test can fail, and
    # documenting the bug rather than just asserting the fix.
    legacy = os.path.basename(cs.SDDM_DROPIN_LEGACY)
    check("...and the OLD name genuinely lost", legacy > theirs, False)
    # Both still beat the distro's base config, which is what we always relied on.
    for base in ("steamos.conf", "steamdeck.conf", "virtualkbd.conf"):
        check("beats %s" % base, ours > base, True)
    # The live path must not be the legacy path.
    check("live path differs from legacy", cs.SDDM_DROPIN != cs.SDDM_DROPIN_LEGACY, True)
    # Reading the current session must still consult the legacy file, so a box
    # that has not re-run install.sh is reported correctly. Asserted by actually
    # reading one, not by inspecting a docstring.
    import tempfile
    tmp = tempfile.mkdtemp()
    live, legacy_p = os.path.join(tmp, "zzz.conf"), os.path.join(tmp, "zz.conf")
    saved = (cs.SDDM_DROPIN, cs.SDDM_DROPIN_LEGACY, cs.SDDM_STATE)
    try:
        cs.SDDM_DROPIN, cs.SDDM_DROPIN_LEGACY = live, legacy_p
        cs.SDDM_STATE = os.path.join(tmp, "missing.conf")
        with open(legacy_p, "w") as f:
            f.write("[Autologin]\nSession=plasma.desktop\n")
        check("a legacy-only box still reports its session",
              cs._sddm_current_session_file(), "plasma.desktop")
        # ...and the live file WINS when both exist.
        with open(live, "w") as f:
            f.write("[Autologin]\nSession=gamescope-session.desktop\n")
        check("the live drop-in wins over the legacy one",
              cs._sddm_current_session_file(), "gamescope-session.desktop")
    finally:
        cs.SDDM_DROPIN, cs.SDDM_DROPIN_LEGACY, cs.SDDM_STATE = saved
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)



def test_greetd_get_reads_never_writes(tmp):
    """The greetd GETTER must answer, and must not call the writer.

    THE BUG (found 2026-07-28): session_default_get's greetd branch held a paste
    of session_default_SET's body — `if _greetd_write(target): return done(True)`.
    `target` is not defined in that scope and is not a global, so
    GET /api/session/default raised NameError on EVERY greetd box: exactly the
    machines greetd support was written for. The BOOTS INTO card never loaded.

    Two things are pinned here: that the call returns at all (the NameError),
    and that a READ never reaches the WRITE path.
    """
    sessions = os.path.join(tmp, "wayland-sessions")
    os.makedirs(sessions, exist_ok=True)
    with open(os.path.join(sessions, cs.GAMESCOPE_SESSION_FILE), "w") as f:
        f.write("[Desktop Entry]\nExec=/usr/bin/gamescope-session %U\n")
    with open(os.path.join(sessions, "plasma.desktop"), "w") as f:
        f.write("[Desktop Entry]\nExec=/usr/bin/startplasma-wayland\n")

    cfg = os.path.join(tmp, "greetd.toml")
    real_dirs, real_cfg = cs._SESSION_DIRS, cs.GREETD_CONFIG
    real_dm, real_write = cs.detect_display_manager, cs._greetd_write
    real_sudo = cs._sudo_nopasswd_allows
    wrote = []
    try:
        cs._SESSION_DIRS = (sessions,)
        cs.GREETD_CONFIG = cfg
        cs.detect_display_manager = lambda: "greetd"
        cs._sudo_nopasswd_allows = lambda *a, **k: True
        # A getter that calls this has failed, whatever it returns.
        cs._greetd_write = lambda *a, **k: (wrote.append(a), True)[1]

        def cfgfile(cmd):
            with open(cfg, "w") as f:
                f.write('[initial_session]\ncommand = "%s"\nuser = "deck"\n' % cmd)

        cfgfile("/usr/bin/gamescope-session")
        check("greetd get -> game", cs.session_default_get()["mode"], "game")
        check("greetd get did not write (game)", wrote, [])

        cfgfile("/usr/bin/startplasma-wayland")
        check("greetd get -> desktop", cs.session_default_get()["mode"], "desktop")

        # CONTROL: an unrecognised hand-written command degrades closed to
        # "unknown" rather than guessing. Without this, a getter that always
        # returned "desktop" would pass the test above.
        cfgfile("/usr/local/bin/something-else")
        check("greetd get -> unknown for a foreign command",
              cs.session_default_get()["mode"], "unknown")

        # CONTROL: an unreadable/absent config is "unknown", not a crash.
        os.remove(cfg)
        check("greetd get -> unknown with no config",
              cs.session_default_get()["mode"], "unknown")

        check("greetd get NEVER called the writer", wrote, [])
    finally:
        cs._SESSION_DIRS, cs.GREETD_CONFIG = real_dirs, real_cfg
        cs.detect_display_manager, cs._greetd_write = real_dm, real_write
        cs._sudo_nopasswd_allows = real_sudo


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

    test_autologin_session_must_exist()
    test_dropin_outranks_the_platforms_own()

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
    print("greetd getter (reads, never writes)")
    _tmp = tempfile.mkdtemp()
    try:
        test_greetd_get_reads_never_writes(_tmp)
    finally:
        import shutil
        shutil.rmtree(_tmp, ignore_errors=True)

    print()
    if FAILURES:
        print("FAILED: %s" % ", ".join(FAILURES))
        return 1
    print("all session-default tests passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
