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

        # The write itself is guarded, so no future caller can route around it
        # — on BOTH conf-dir managers.
        cs._installed_session_files = lambda: BAZZITE
        check("_dm_write(sddm) refuses a session that is not installed",
              cs._dm_write("sddm", "plasmax11.desktop"), False)
        check("_dm_write(plasmalogin) refuses it too",
              cs._dm_write("plasmalogin", "plasmax11.desktop"), False)
        check("_dm_write refuses an unknown manager outright",
              cs._dm_write("ly", cs.GAMESCOPE_SESSION_FILE), False)
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
    theirs = "zz-steamos-autologin.conf"
    for dm in ("sddm", "plasmalogin"):
        ours = os.path.basename(cs._dm_dropin(dm))
        check("[%s] our drop-in sorts AFTER steamos-session-select's" % dm,
              ours > theirs, True)
        # CONTROL: the old name genuinely lost — proving the test can fail, and
        # documenting the bug rather than just asserting the fix.
        legacy = os.path.basename(cs._dm_dropin_legacy(dm))
        check("[%s] ...and the OLD name genuinely lost" % dm,
              legacy > theirs, False)
        # Both still beat the distro's base config, which is what we always
        # relied on ("cachyos.conf" and "steam-deckify.conf" are verbatim from
        # the CachyOS plasmalogin box, 2026-07-30).
        for base in ("steamos.conf", "steamdeck.conf", "virtualkbd.conf",
                     "cachyos.conf", "steam-deckify.conf"):
            check("[%s] beats %s" % (dm, base), ours > base, True)
        # The live path must not be the legacy path.
        check("[%s] live path differs from legacy" % dm,
              cs._dm_dropin(dm) != cs._dm_dropin_legacy(dm), True)
        # ...and both live inside the DETECTED manager's own conf dir.
        check("[%s] drop-in lives in that manager's conf dir" % dm,
              cs._dm_dropin(dm).startswith(cs._DM_CONF_DIRS[dm] + "/"), True)
    check("an unknown manager has NO drop-in path", cs._dm_dropin("ly"), "")
    # Reading the current session must still consult the legacy file, so a box
    # that has not re-run install.sh is reported correctly. Asserted by actually
    # reading one, not by inspecting a docstring. The mechanism is now the same
    # alphabetical last-wins scan the manager itself does, so the win is the
    # SORT ORDER, exercised for real via a synthetic manager whose conf dir is
    # a temp dir (name chosen so /etc/testdm.conf and /var/lib/testdm/ cannot
    # exist on any box this test runs on).
    import tempfile
    tmp = tempfile.mkdtemp()
    saved_dirs = cs._DM_CONF_DIRS
    try:
        cs._DM_CONF_DIRS = dict(saved_dirs, testdm=tmp)
        with open(os.path.join(tmp, "zz-couchside-session.conf"), "w") as f:
            f.write("[Autologin]\nSession=plasma.desktop\n")
        check("a legacy-only box still reports its session",
              cs._dm_current_session_file("testdm"), "plasma.desktop")
        # ...and the live file WINS when both exist.
        with open(os.path.join(tmp, "zzz-couchside-session.conf"), "w") as f:
            f.write("[Autologin]\nSession=gamescope-session.desktop\n")
        check("the live drop-in wins over the legacy one",
              cs._dm_current_session_file("testdm"), "gamescope-session.desktop")
    finally:
        cs._DM_CONF_DIRS = saved_dirs
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


def test_setter_dispatches_per_backend():
    """set() must write through the backend that was DETECTED.

    Two regressions pinned:
      * greetd: the 2.9.65 getter fix MOVED the greetd dispatch out of the
        setter instead of copying it, so a greetd box read fine and then every
        set fell through to the SDDM writer — which the old unconditional
        install.sh grant could even let SUCCEED, into a dir greetd never reads.
      * plasmalogin: the write must aim at /etc/plasmalogin.conf.d, not the
        hardcoded SDDM path (the 2026-07-30 CachyOS bug).
    """
    print("test_setter_dispatches_per_backend")
    real_run = cs.subprocess.run
    real_sudo = cs._sudo_nopasswd_allows
    real_detect = cs.detect_display_manager
    real_gwrite = cs._greetd_write
    real_inst = cs._installed_session_files
    saved_layers = (cs._DM_CONF_DIRS, cs._DM_SYS_CONF_DIRS, cs._DM_MAIN_CONFS,
                    cs._DM_STATE_FILES)
    base = tempfile.mkdtemp()
    try:
        # Hermetic conf dirs: availability now requires the dir to exist and
        # the main conf to be silent.
        dirs = {dm: os.path.join(base, dm + ".conf.d")
                for dm in ("sddm", "plasmalogin")}
        for d in dirs.values():
            os.makedirs(d)
        cs._DM_CONF_DIRS = dirs
        cs._DM_SYS_CONF_DIRS = {}
        cs._DM_MAIN_CONFS = {}
        cs._DM_STATE_FILES = {}
        cs._sudo_nopasswd_allows = lambda needle: True
        cs._installed_session_files = lambda: {cs.GAMESCOPE_SESSION_FILE,
                                               "plasma.desktop"}
        # steamosctl must keep failing so the DM path is chosen.
        cs.subprocess.run = FakeRun(stderr="Error: UnknownInterface", rc=0)

        cs.detect_display_manager = lambda: "greetd"
        gcalls = []
        cs._greetd_write = lambda sf: (gcalls.append(sf), True)[1]
        r = cs.session_default_set("game")
        check("greetd set() reaches the greetd writer", gcalls,
              [cs.GAMESCOPE_SESSION_FILE])
        check("greetd set() reports ok", r["ok"], True)

        # greetd + mode "last": no conf-dir manager to read, so the target
        # falls back to Game Mode — through the greetd writer, never the tee.
        gcalls[:] = []
        r = cs.session_default_set("last")
        check("greetd set('last') falls back to gamescope via the greetd writer",
              gcalls, [cs.GAMESCOPE_SESSION_FILE])

        # plasmalogin: capture the tee argv end-to-end through set().
        cs.detect_display_manager = lambda: "plasmalogin"
        cs._greetd_write = lambda sf: (_ for _ in ()).throw(
            AssertionError("greetd writer must not run for plasmalogin"))
        teed = []

        def fake_run(argv, **kw):
            class R:
                pass
            r = R()
            r.returncode, r.stdout, r.stderr = 0, "", ""
            if argv[:3] == ["sudo", "-n", "tee"]:
                teed.append(list(argv))
                r.stdout = kw.get("input", "")
            elif argv[:1] == ["steamosctl"]:
                r.stdout, r.stderr = "", "Error: UnknownInterface"
            return r

        cs.subprocess.run = fake_run
        r = cs.session_default_set("game")
        check("plasmalogin set() reports ok", r["ok"], True)
        check("plasmalogin set() tees into PLASMALOGIN's conf dir",
              teed, [["sudo", "-n", "tee", cs._dm_dropin("plasmalogin")]])

        # mode "last" on a conf-dir box: the target is whatever the MERGED
        # config says is running now — here the distro drop-in names the
        # desktop session, so "last" must write plasma.desktop, not gamescope.
        with open(os.path.join(dirs["plasmalogin"],
                               "zz-steamos-autologin.conf"), "w") as f:
            f.write("[Autologin]\nSession=plasma.desktop\n")
        teed[:] = []
        wrote = {}
        def fake_run2(argv, **kw):
            class R:
                pass
            r = R()
            r.returncode, r.stdout, r.stderr = 0, "", ""
            if argv[:3] == ["sudo", "-n", "tee"]:
                wrote["argv"], wrote["body"] = list(argv), kw.get("input", "")
            elif argv[:1] == ["steamosctl"]:
                r.stdout, r.stderr = "", "Error: UnknownInterface"
            return r
        cs.subprocess.run = fake_run2
        r = cs.session_default_set("last")
        check("plasmalogin set('last') reports ok", r["ok"], True)
        check("...and writes the session the merged config names",
              "Session=plasma.desktop" in wrote.get("body", ""), True)
    finally:
        cs.subprocess.run = real_run
        cs._sudo_nopasswd_allows = real_sudo
        cs.detect_display_manager = real_detect
        cs._greetd_write = real_gwrite
        cs._installed_session_files = real_inst
        (cs._DM_CONF_DIRS, cs._DM_SYS_CONF_DIRS, cs._DM_MAIN_CONFS,
         cs._DM_STATE_FILES) = saved_layers
        import shutil
        shutil.rmtree(base, ignore_errors=True)


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
    real_detect = cs.detect_display_manager
    # Hermetic conf-dir layout: _dm_session_ok requires the conf dir to EXIST
    # and the classic main conf to be silent, so the real /etc must not leak in.
    saved_layers = (cs._DM_CONF_DIRS, cs._DM_SYS_CONF_DIRS, cs._DM_MAIN_CONFS,
                    cs._DM_STATE_FILES)
    bdir = tempfile.mkdtemp()
    sddm_dir, pl_dir = os.path.join(bdir, "sddm.conf.d"), os.path.join(bdir, "plasmalogin.conf.d")
    os.makedirs(sddm_dir); os.makedirs(pl_dir)
    cs._DM_CONF_DIRS = {"sddm": sddm_dir, "plasmalogin": pl_dir}
    cs._DM_SYS_CONF_DIRS = {}
    cs._DM_MAIN_CONFS = {"sddm": os.path.join(bdir, "sddm.conf"),
                         "plasmalogin": os.path.join(bdir, "plasmalogin.conf")}
    cs._DM_STATE_FILES = {}
    cs.subprocess.run = FakeRun(stdout="desktop\n", rc=0)
    cs._sudo_nopasswd_allows = lambda needle: True
    cs.detect_display_manager = lambda: "sddm"
    check("steamosctl wins when both are usable",
          cs.session_default_backend(), "steamosctl")
    cs.subprocess.run = FakeRun(stderr="Error: UnknownInterface", rc=0)
    check("Bazzite: detected sddm + grant -> sddm",
          cs.session_default_backend(), "sddm")
    cs.detect_display_manager = lambda: "plasmalogin"
    check("CachyOS: detected plasmalogin + grant -> plasmalogin",
          cs.session_default_backend(), "plasmalogin")
    cs._sudo_nopasswd_allows = lambda needle: False
    check("no grant -> NO backend (degrade closed)",
          cs.session_default_backend(), None)
    check("...so the capability is absent", cs.session_default_available(), False)

    # THE 2026-07-30 BUG, pinned. install.sh wrote the SDDM tee grant
    # UNCONDITIONALLY, and an unidentifiable display manager fell back to
    # "sddm if the grant exists" — so a plasmalogin box (not yet in
    # _KNOWN_DMS then) advertised {"available": true, "backend": "sddm"}
    # and wrote into /etc/sddm.conf.d, which did not exist. VERIFIED on real
    # CachyOS hardware. The grant being present must prove NOTHING when the
    # manager is unknown.
    cs._sudo_nopasswd_allows = lambda needle: True
    cs.detect_display_manager = lambda: None
    check("unidentifiable DM + sddm grant -> NO backend (fail closed)",
          cs.session_default_backend(), None)
    check("...capability absent, card never renders",
          cs.session_default_available(), False)
    # Detected-but-unwritable managers are the same honest absence.
    cs.detect_display_manager = lambda: "gdm"
    check("gdm: detected, no writer -> None", cs.session_default_backend(), None)

    # THE GRANT IS PER-PATH — a needle-blind stub cannot pin that. This is the
    # real CachyOS box TODAY: the old installer wrote only the sddm-path tee
    # grants, the new agent detects plasmalogin. An implementation that checks
    # the SDDM path regardless of dm (the pre-fix shape, one refactor away)
    # fails here and only here.
    sddm_grants = {cs._dm_dropin("sddm"), cs._dm_dropin_legacy("sddm")}
    cs._sudo_nopasswd_allows = lambda needle: needle in sddm_grants
    cs.detect_display_manager = lambda: "plasmalogin"
    check("CachyOS today: sddm-path grants only + plasmalogin detected -> None",
          cs.session_default_backend(), None)
    cs.detect_display_manager = lambda: "sddm"
    check("...same grants on a real sddm box -> sddm (control)",
          cs.session_default_backend(), "sddm")

    # The conf dir must EXIST: the grant names one file and `sudo tee` cannot
    # create parent directories — vanilla Arch SDDM ships without the dir.
    cs._sudo_nopasswd_allows = lambda needle: True
    cs.detect_display_manager = lambda: "plasmalogin"
    import shutil as _sh
    _sh.rmtree(pl_dir)
    check("conf dir missing + full grants -> NO backend (tee cannot mkdir)",
          cs.session_default_backend(), None)
    os.makedirs(pl_dir)
    check("...and it returns once the dir exists (control)",
          cs.session_default_backend(), "plasmalogin")

    # The classic main conf OVERRIDES every drop-in (SDDM applies it last), so
    # a box hand-configured there can never honor our zzz- file: capability off.
    cs.detect_display_manager = lambda: "sddm"
    with open(cs._DM_MAIN_CONFS["sddm"], "w") as f:
        f.write("[Autologin]\nSession=plasma.desktop\n")
    check("main conf names a Session -> NO backend (drop-ins can never win)",
          cs.session_default_backend(), None)
    os.remove(cs._DM_MAIN_CONFS["sddm"])
    check("...and returns once it is silent (control)",
          cs.session_default_backend(), "sddm")

    (cs._DM_CONF_DIRS, cs._DM_SYS_CONF_DIRS, cs._DM_MAIN_CONFS,
     cs._DM_STATE_FILES) = saved_layers
    cs.detect_display_manager = real_detect

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
    test_setter_dispatches_per_backend()

    print("the drop-in body (both conf-dir managers)")
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
    for dm in ("sddm", "plasmalogin"):
        written.clear()
        ok = cs._dm_write(dm, cs.GAMESCOPE_SESSION_FILE)
        check("[%s] write returns ok" % dm, ok, True)
        check("[%s] writes via sudo tee at that manager's FIXED path" % dm,
              written["argv"], ["sudo", "-n", "tee", cs._dm_dropin(dm)])
        check("[%s] body sets the gamescope session" % dm,
              "Session=%s" % cs.GAMESCOPE_SESSION_FILE in written["body"], True)
        check("[%s] body says how to undo it" % dm,
              "Delete this file" in written["body"], True)

    print("reading the current mode — VERBATIM fixtures from real hardware")
    # Every file body below is byte-for-byte what the named box serves
    # (CLAUDE.md §6: fixtures copied verbatim). Captured 2026-07-30.
    CACHYOS_PLASMALOGIN = {
        # ASUS G14, CachyOS deckify, 10.7.1.92 — /etc/plasmalogin.conf.d/
        "cachyos.conf": (
            "[General]\n"
            "HaltCommand=/usr/bin/systemctl poweroff\n"
            "RebootCommand=/usr/bin/systemctl reboot\n"
            "\n"
            "[Theme]\n"
            "Current=breeze\n"
            "\n"
            "[Users]\n"
            "MaximumUid=60000\n"
            "MinimumUid=1000\n"),
        "steam-deckify.conf": (
            "[Autologin]\n"
            "Relogin=true\n"
            "# This is only for first boot as a file that overrides this gets"
            " created once /usr/lib/os-session-select runs\n"
            "Session=gamescope-session.desktop\n"
            "User=deck\n"),
        "zz-steamos-autologin.conf": (
            "[Autologin]\n"
            "Session=gamescope-session.desktop\n"),
    }
    BAZZITE_SDDM = {
        # lenovodesktop, Bazzite, 10.7.0.200 — /etc/sddm.conf.d/
        "steamos.conf": (
            "[General]\n"
            "DisplayServer=wayland\n"
            "\n"
            "[Autologin]\n"
            "Relogin=true\n"
            "Session=gamescope-session.desktop\n"
            "User=bazzite\n"
            "\n"
            "[X11]\n"
            "# Janky workaround for wayland sessions not stopping in sddm, kills\n"
            "# all active sddm-helper sessions on teardown\n"
            "DisplayStopCommand=/usr/bin/gamescope-wayland-teardown-workaround\n"),
        "virtualkbd.conf": (
            "[General]\n"
            "InputMethod=qtvirtualkeyboard\n"),
        "zzz-couchside-session.conf": (
            "# Written by Couchside. Delete this file to restore the box's\n"
            "# original boot behaviour; nothing else was modified.\n"
            "[Autologin]\n"
            "Session=plasma.desktop\n"),
    }

    def fixture_dir(files):
        d = tempfile.mkdtemp()
        for name, body in files.items():
            with open(os.path.join(d, name), "w") as f:
                f.write(body)
        return d

    saved_dirs = cs._DM_CONF_DIRS
    dirs = []
    try:
        # The plasmalogin box that exposed the bug: the distro's own drop-in
        # names the answer, and the old reader (our-drop-in-or-sddm-state-file)
        # reported "unknown" on it. Both states are observed: game as shipped,
        # then desktop once OUR later-sorting file lands (§11.2).
        d = fixture_dir(CACHYOS_PLASMALOGIN)
        dirs.append(d)
        cs._DM_CONF_DIRS = dict(saved_dirs, testdm=d)
        check("CachyOS/plasmalogin fixture reads game (was: unknown)",
              cs._dm_current_session_file("testdm"), "gamescope-session.desktop")
        with open(os.path.join(d, "zzz-couchside-session.conf"), "w") as f:
            f.write("[Autologin]\nSession=plasma.desktop\n")
        check("...and OUR drop-in wins once written (alphabetical last-wins)",
              cs._dm_current_session_file("testdm"), "plasma.desktop")

        # The Bazzite regression control: a box where Couchside already set
        # desktop must keep reading desktop, and without our file must read
        # the distro's game default — fires AND not-fires.
        d2 = fixture_dir(BAZZITE_SDDM)
        dirs.append(d2)
        cs._DM_CONF_DIRS = dict(saved_dirs, testdm=d2)
        check("Bazzite fixture reads desktop (our zzz file present)",
              cs._dm_current_session_file("testdm"), "plasma.desktop")
        os.remove(os.path.join(d2, "zzz-couchside-session.conf"))
        check("Bazzite without our file reads the distro's game default",
              cs._dm_current_session_file("testdm"), "gamescope-session.desktop")

        # Full-path values are basenamed; a dir with no Session= at all reads
        # empty, never a guess.
        d3 = fixture_dir({"zzz-couchside-session.conf":
                          "[Autologin]\nSession=/usr/share/wayland-sessions/"
                          "plasma.desktop\n"})
        dirs.append(d3)
        cs._DM_CONF_DIRS = dict(saved_dirs, testdm=d3)
        check("basenames a full path",
              cs._dm_current_session_file("testdm"), "plasma.desktop")
        d4 = fixture_dir({"cachyos.conf": CACHYOS_PLASMALOGIN["cachyos.conf"]})
        dirs.append(d4)
        cs._DM_CONF_DIRS = dict(saved_dirs, testdm=d4)
        check("no Session anywhere -> empty, not a guess",
              cs._dm_current_session_file("testdm"), "")
        check("unknown manager -> empty, not a guess",
              cs._dm_current_session_file(None), "")
    finally:
        cs._DM_CONF_DIRS = saved_dirs
        cs.subprocess.run = real_run
        cs._sudo_nopasswd_allows = real_sudo
        import shutil
        for d in dirs:
            shutil.rmtree(d, ignore_errors=True)

    print("merge order: sys conf.d < /etc conf.d < classic main conf; state last")
    # SDDM applies the classic /etc/sddm.conf LAST — it OVERRIDES every
    # drop-in, the reverse of the systemd convention (verified in SDDM's
    # ConfigReader; v1 of this reader shipped the order backwards). The sys
    # layer body is VERBATIM /usr/lib/sddm/sddm.conf.d/general.conf's
    # [Autologin] group from the CachyOS box (note: bare "plasma", no
    # .desktop — real distros do that).
    lay = tempfile.mkdtemp()
    sysd = os.path.join(lay, "sys.conf.d")
    etcd = os.path.join(lay, "etc.conf.d")
    os.makedirs(sysd)
    os.makedirs(etcd)
    main_conf = os.path.join(lay, "testdm.conf")
    state_conf = os.path.join(lay, "state.conf")
    saved_layers = (cs._DM_CONF_DIRS, cs._DM_SYS_CONF_DIRS, cs._DM_MAIN_CONFS,
                    cs._DM_STATE_FILES)
    try:
        cs._DM_CONF_DIRS = dict(saved_layers[0], testdm=etcd)
        cs._DM_SYS_CONF_DIRS = {"testdm": sysd}
        cs._DM_MAIN_CONFS = {"testdm": main_conf}
        cs._DM_STATE_FILES = {"testdm": state_conf}
        with open(os.path.join(sysd, "general.conf"), "w") as f:
            f.write("[Autologin]\nRelogin=false\nSession=plasma\n")
        check("sys conf.d alone is read (lowest layer)",
              cs._dm_current_session_file("testdm"), "plasma")
        with open(os.path.join(etcd, "zz-steamos-autologin.conf"), "w") as f:
            f.write("[Autologin]\nSession=gamescope-session.desktop\n")
        check("/etc conf.d overrides the sys layer",
              cs._dm_current_session_file("testdm"), "gamescope-session.desktop")
        with open(main_conf, "w") as f:
            f.write("[Autologin]\nSession=plasmax11.desktop\n")
        check("the classic MAIN conf overrides every drop-in (SDDM applies it last)",
              cs._dm_current_session_file("testdm"), "plasmax11.desktop")
        # state.conf is a LAST resort: consulted only when no config names one.
        with open(state_conf, "w") as f:
            f.write("[Last]\nSession=/usr/share/wayland-sessions/plasma.desktop\n")
        check("state.conf ignored while any config names a session",
              cs._dm_current_session_file("testdm"), "plasmax11.desktop")
        os.remove(main_conf)
        os.remove(os.path.join(etcd, "zz-steamos-autologin.conf"))
        os.remove(os.path.join(sysd, "general.conf"))
        check("state.conf answers only when nothing else does",
              cs._dm_current_session_file("testdm"), "plasma.desktop")
    finally:
        (cs._DM_CONF_DIRS, cs._DM_SYS_CONF_DIRS, cs._DM_MAIN_CONFS,
         cs._DM_STATE_FILES) = saved_layers
        import shutil
        shutil.rmtree(lay, ignore_errors=True)

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
