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


def test_boot_preference_is_armed_only_while_the_box_is_off(tmp):
    """THE KI-051 REBUILD. Setting a boot preference must not leave anything on
    disk that can override a session switch while the box is running.

    THE BUG, measured on the owner's CachyOS box and reproduced on Bazzite: a
    one-shot switch IS a re-autologin — `steamos-session-select` writes the
    distro's own zz-steamos-autologin.conf and ends the session — and our
    drop-in sorts LAST so it won, sending the box straight back to Game Mode.
    That defeated STEAM'S OWN "Switch to Desktop" too, so the owner reasonably
    blamed his distro. Caught red-handed on his machine:

        zz-steamos-autologin.conf  -> Session=plasma.desktop     (his request)
        zzz-couchside-session.conf -> Session=gamescope-session.desktop (ours)
        running session            -> gamescope

    So the drop-in now exists only while the box is OFF: consumed (blanked) at
    agent startup, armed from the stored preference at shutdown. These tests are
    the guard on that lifecycle, and the FIRST one is the regression itself.
    """
    print("test_boot_preference_is_armed_only_while_the_box_is_off")
    real = (cs.subprocess.run, cs._sudo_nopasswd_allows, cs.detect_display_manager,
            cs._greetd_write, cs._installed_session_files, cs.CONFIG_PATH,
            cs._DM_CONF_DIRS, cs._DM_SYS_CONF_DIRS, cs._DM_MAIN_CONFS,
            cs._DM_STATE_FILES, cs._arm_hook_installed)
    try:
        confdir = os.path.join(tmp, "plasmalogin.conf.d")
        os.makedirs(confdir, exist_ok=True)
        cs._DM_CONF_DIRS = {"plasmalogin": confdir, "sddm": confdir}
        cs._DM_SYS_CONF_DIRS, cs._DM_MAIN_CONFS, cs._DM_STATE_FILES = {}, {}, {}
        cs.CONFIG_PATH = os.path.join(tmp, "config.json")
        with open(cs.CONFIG_PATH, "w") as f:
            f.write('{"units": []}')
        cs._sudo_nopasswd_allows = lambda needle: True
        cs._arm_hook_installed = lambda: True
        cs.detect_display_manager = lambda: "plasmalogin"
        cs._installed_session_files = lambda: {cs.GAMESCOPE_SESSION_FILE,
                                               "plasma.desktop"}
        dropin = cs._dm_dropin("plasmalogin")

        # Every sudo tee in this test writes the real file, so the assertions
        # read what a display manager would actually merge.
        def fake_run(argv, **kw):
            class R:
                pass
            r = R()
            r.returncode, r.stdout, r.stderr = 0, "", ""
            if argv[:3] == ["sudo", "-n", "tee"]:
                with open(argv[3], "w") as fh:
                    fh.write(kw.get("input", ""))
            elif argv[:1] == ["steamosctl"]:
                r.stderr = "Error: UnknownInterface"
            return r
        cs.subprocess.run = fake_run

        # The distro's own file, as steamos-session-select would leave it after
        # the user pressed "Switch to Desktop". Sorts BEFORE ours.
        with open(os.path.join(confdir, "zz-steamos-autologin.conf"), "w") as f:
            f.write("[Autologin]\nSession=plasma.desktop\n")

        r = cs.session_default_set("game")
        check("set('game') succeeds", r["ok"], True)
        check("...and STORES the preference", cs.session_default_pref(), "game")
        # THE REGRESSION GUARD. Before the rebuild this wrote
        # Session=gamescope-session.desktop and the box could never leave Game
        # Mode again — from Couchside, from Steam, from anywhere.
        check("...but writes NO Session= while the box is running",
              cs._last_session_line(dropin), "")
        check("...so the distro's own switch still decides",
              cs._dm_current_session_file("plasmalogin"), "plasma.desktop")

        # Shutdown arms it, and only then.
        cs.session_default_arm()
        check("arm (shutdown) writes the preference",
              cs._last_session_line(dropin), cs.GAMESCOPE_SESSION_FILE)
        check("...and now OURS wins the merge, which is the point at boot",
              cs._dm_current_session_file("plasmalogin"),
              cs.GAMESCOPE_SESSION_FILE)

        # Startup consumes it again.
        cs.session_default_consume()
        check("consume (startup) blanks it", cs._last_session_line(dropin), "")
        check("...restoring the platform's own answer",
              cs._dm_current_session_file("plasmalogin"), "plasma.desktop")

        # "last" is the platform's own behaviour: we own nothing.
        r = cs.session_default_set("last")
        check("set('last') succeeds", r["ok"], True)
        cs.session_default_arm()
        check("...and arming writes NOTHING for it",
              cs._last_session_line(dropin), "")

        # Desktop preference: same lifecycle, other target.
        cs.session_default_set("desktop")
        cs.session_default_arm()
        check("arm writes an INSTALLED desktop session",
              cs._last_session_line(dropin) in cs._installed_session_files(), True)

        # The getter answers from the stored preference — the drop-in is blank
        # while running, so reading it would say "unknown" on every box that
        # ever set one.
        cs.session_default_consume()
        cs.session_default_set("game")
        check("get reports the STORED preference, not the blank file",
              cs.session_default_get()["mode"], "game")

        # greetd has no drop-in dir and no competing platform switcher writing
        # its config, so it still writes immediately.
        cs.detect_display_manager = lambda: "greetd"
        gcalls = []
        cs._greetd_write = lambda sf: (gcalls.append(sf), True)[1]
        cs._greetd_session_ok = lambda: True
        r = cs.session_default_set("game")
        check("greetd still writes at set() time", gcalls,
              [cs.GAMESCOPE_SESSION_FILE])
        check("greetd set() reports ok", r["ok"], True)
    finally:
        (cs.subprocess.run, cs._sudo_nopasswd_allows, cs.detect_display_manager,
         cs._greetd_write, cs._installed_session_files, cs.CONFIG_PATH,
         cs._DM_CONF_DIRS, cs._DM_SYS_CONF_DIRS, cs._DM_MAIN_CONFS,
         cs._DM_STATE_FILES, cs._arm_hook_installed) = real


def test_gamescope_session_resolver():
    """_gamescope_session_for_autologin() picks the gamescope session the box
    ACTUALLY ships, the Game-Mode mirror of _desktop_session_for_autologin.

    Legion Go S, SteamOS 3.8.16 (owner box 10.1.1.195, 2026-08-10) ships the
    Game Mode session as gamescope-WAYLAND.desktop, not gamescope-session.desktop
    — the single hardcoded name refused Couch Mode and would have written an
    autologin entry the box does not have. Degrade closed (None) when neither is
    installed or the dirs cannot be read. Both states with controls (§11.2/3)."""
    print("test_gamescope_session_resolver")
    saved = cs._installed_session_files
    try:
        cs._installed_session_files = lambda: {"gamescope-session.desktop",
                                               "plasma.desktop"}
        check("picks gamescope-session when that is installed",
              cs._gamescope_session_for_autologin(), "gamescope-session.desktop")
        cs._installed_session_files = lambda: {"gamescope-wayland.desktop",
                                               "plasma.desktop", "plasmax11.desktop"}
        check("picks gamescope-wayland when THAT is installed (Legion Go S)",
              cs._gamescope_session_for_autologin(), "gamescope-wayland.desktop")
        cs._installed_session_files = lambda: {"plasma.desktop"}
        check("no gamescope session at all -> None (refuse, do not guess)",
              cs._gamescope_session_for_autologin(), None)
        cs._installed_session_files = lambda: set()
        check("cannot enumerate -> None (refuse)",
              cs._gamescope_session_for_autologin(), None)
    finally:
        cs._installed_session_files = saved


def test_gamescope_wayland_write_and_read(tmp):
    """The WRITE half of the Legion Go S fix. A box that ships the Game Mode
    session as gamescope-wayland.desktop must have THAT name armed into its
    autologin drop-in (writing gamescope-session.desktop would strand it), and
    the getter must read it back as 'game'. Both directions + a refuse control."""
    print("test_gamescope_wayland_write_and_read")
    real = (cs.subprocess.run, cs._sudo_nopasswd_allows, cs.detect_display_manager,
            cs._installed_session_files, cs.CONFIG_PATH, cs._DM_CONF_DIRS,
            cs._DM_SYS_CONF_DIRS, cs._DM_MAIN_CONFS, cs._DM_STATE_FILES,
            cs._arm_hook_installed)
    try:
        confdir = os.path.join(tmp, "sddm.conf.d")
        os.makedirs(confdir, exist_ok=True)
        cs._DM_CONF_DIRS = {"sddm": confdir, "plasmalogin": confdir}
        cs._DM_SYS_CONF_DIRS, cs._DM_MAIN_CONFS, cs._DM_STATE_FILES = {}, {}, {}
        cs.CONFIG_PATH = os.path.join(tmp, "config.json")
        with open(cs.CONFIG_PATH, "w") as f:
            f.write('{"units": []}')
        cs._sudo_nopasswd_allows = lambda needle: True
        cs._arm_hook_installed = lambda: True
        cs.detect_display_manager = lambda: "sddm"
        # Legion Go S session set: gamescope under the WAYLAND name.
        cs._installed_session_files = lambda: {"gamescope-wayland.desktop",
                                               "plasma.desktop", "plasmax11.desktop"}
        dropin = cs._dm_dropin("sddm")

        def fake_run(argv, **kw):
            class R:
                pass
            r = R()
            r.returncode, r.stdout, r.stderr = 0, "", ""
            if argv[:3] == ["sudo", "-n", "tee"]:
                with open(argv[3], "w") as fh:
                    fh.write(kw.get("input", ""))
            elif argv[:1] == ["steamosctl"]:
                r.stderr = "Error: UnknownInterface"  # force the sddm backend
            return r
        cs.subprocess.run = fake_run

        check("set('game') succeeds on a gamescope-wayland box",
              cs.session_default_set("game")["ok"], True)
        cs.session_default_arm()
        check("arm writes the box's REAL gamescope name, not the hardcoded one",
              cs._last_session_line(dropin), "gamescope-wayland.desktop")
        # Force the name-read path (pref 'last', not 'game') so this exercises the
        # filename->mode mapping, not the stored preference short-circuit.
        with cs.CONFIG_LOCK:
            cs._config_set_field(cs.SESSION_DEFAULT_CONFIG_KEY, "last")
        check("get maps a gamescope-wayland record back to 'game'",
              cs.session_default_get()["mode"], "game")
        # CONTROL: a box with NO gamescope session refuses to arm rather than
        # writing a name it does not have (the stranding guard, one layer up).
        cs._installed_session_files = lambda: {"plasma.desktop"}
        with cs.CONFIG_LOCK:
            cs._config_set_field(cs.SESSION_DEFAULT_CONFIG_KEY, "game")
        with open(dropin, "w") as f:
            f.write("")
        cs.session_default_arm()
        check("arm refuses (writes nothing) when no gamescope session exists",
              cs._last_session_line(dropin), "")
    finally:
        (cs.subprocess.run, cs._sudo_nopasswd_allows, cs.detect_display_manager,
         cs._installed_session_files, cs.CONFIG_PATH, cs._DM_CONF_DIRS,
         cs._DM_SYS_CONF_DIRS, cs._DM_MAIN_CONFS, cs._DM_STATE_FILES,
         cs._arm_hook_installed) = real


def test_steamosctl_set_uses_mode_arg(tmp):
    """set('game') on a steamosctl box sends the 'game' arg — pins the
    arg-from-mode refactor. The old code derived the arg from
    target == GAMESCOPE_SESSION_FILE; once target resolves to
    gamescope-wayland.desktop that comparison is False, so it would have sent
    'desktop' for a 'game' request. Deriving from `mode` is immune."""
    print("test_steamosctl_set_uses_mode_arg")
    real = (cs.subprocess.run, cs.session_default_backend, cs.session_default_get,
            cs.CONFIG_PATH, cs._installed_session_files)
    try:
        cs.CONFIG_PATH = os.path.join(tmp, "config.json")
        with open(cs.CONFIG_PATH, "w") as f:
            f.write('{"units": []}')
        cs.session_default_backend = lambda: "steamosctl"
        # A wayland-named box: target resolves to gamescope-wayland.desktop, which
        # the OLD arg-from-target logic would have mislabelled 'desktop'.
        cs._installed_session_files = lambda: {"gamescope-wayland.desktop",
                                               "plasma.desktop"}
        calls = []

        def fake_run(argv, **kw):
            calls.append(list(argv))

            class R:
                pass
            r = R()
            r.returncode, r.stdout, r.stderr = 0, "", ""
            return r
        cs.subprocess.run = fake_run
        cs.session_default_get = lambda: {"mode": "game"}  # readback verification
        r = cs.session_default_set("game")
        sent = [c for c in calls if c[:1] == ["steamosctl"]]
        check("steamosctl set('game') sends the 'game' arg (not 'desktop')",
              bool(sent) and sent[-1] == ["steamosctl", "set-default-login-mode", "game"],
              True)
        check("...and set() reports ok", r["ok"], True)
    finally:
        (cs.subprocess.run, cs.session_default_backend, cs.session_default_get,
         cs.CONFIG_PATH, cs._installed_session_files) = real


# ---------------------------------------------------------------------------
# Bazzite 43 -> 44: the OS update that stranded the living-room box.
#
# MEASURED 2026-09-26 on 10.1.1.60 (agent 2.9.114, session_default "game"):
# the ExecStop arm at the update's shutdown wrote Session=gamescope-session
# .desktop (a 43 name), 44 does not ship it, SDDM logged
#     Unable to find autologin session entry "gamescope-session.desktop"
#     Autologin failed!
# and seat0 came up as an sddm GREETER. On 44 `steamosctl` answers, the backend
# flipped to "steamosctl", and consume() walked away from the file it wrote.
#
# Every fixture below is VERBATIM off that box (bazzite-deck 44.20260921.0,
# systemd 259), captured read-only over ssh on 2026-09-26 AFTER the owner had
# recovered it by hand — except where a comment says SYNTHESISED, because the
# state it models no longer existed to capture.
# ---------------------------------------------------------------------------

# ls /usr/share/wayland-sessions   (/usr/share/xsessions is empty on 44)
BAZZITE44_SESSIONS = {"gamescope-session-ogui-steam.desktop",
                      "gamescope-session-steam.desktop", "plasma.desktop"}
# Bazzite 43's session set, as already pinned by the KI-038 test above (the
# same box, captured before the update).
BAZZITE43_SESSIONS = {"gamescope-session.desktop", "gamescope-session-steam.desktop",
                      "plasma.desktop", "plasma-steamos-wayland-oneshot.desktop",
                      "plasma-steamos-oneshot.desktop"}
# /usr/lib/sddm/sddm.conf.d/ — the image's own autologin (sys layer)
BAZZITE44_SYS_CONF = {
    "holo.conf": '[General]\nDisplayServer=wayland\n\n[Autologin]\nRelogin=true\nSession=gamescope-session-ogui-steam.desktop\n',
    "plasma-wayland.conf": '[General]\nDisplayServer=wayland\nGreeterEnvironment=QT_WAYLAND_SHELL_INTEGRATION=layer-shell\nInputMethod=\n\n[Wayland]\nCompositorCommand=kwin_wayland --no-global-shortcuts --no-lockscreen --inputmethod plasma-keyboard --locale1\n',
}
# /etc/sddm.conf.d/ — everything present on 44 after the owner's repair. The
# blank legacy zz-couchside file is OURS (neutralised pre-2.9.64 name).
BAZZITE44_ETC_CONF = {
    "99-plasma-setup.conf": '[Autologin]\nUser=plasma-setup\nSession=plasma\n',
    "virtualkbd.conf": '[General]\nInputMethod=qtvirtualkeyboard\n',
    "zz-bazzite-autologin.conf": '[Autologin]\nUser=bazzite\n',
    "zz-couchside-session.conf": "# Superseded by zzz-couchside-session.conf (Couchside >= 2.9.64).\n# Left blank deliberately: this name sorted BEFORE the display\n# manager's own drop-in and so could never win. Safe to delete.\n",
    "zz-holo-autologin.conf": '[Autologin]\nSession=gamescope-session-ogui-steam.desktop\n',
}
# The stranding drop-in. RECONSTRUCTED: the owner had deleted it before this
# capture. The Session= value is proven by SDDM's own journal line on 44 (above)
# and by the 43 arm log "[session] arm: game -> gamescope-session.desktop (ok)";
# the body is exactly what _dm_write composes.
STRANDING_DROPIN = ("# Written by Couchside. Delete this file to restore the box's\n"
                    "# original boot behaviour; nothing else was modified.\n"
                    "[Autologin]\n"
                    "Session=gamescope-session.desktop\n")

# `loginctl list-sessions --no-legend` and `loginctl show-session <id> -p Class
# -p Seat`, VERBATIM on 44 with the box in its Game Mode user session (session
# 33 is the capturing ssh login).
LOGIND_USER_ON_SEAT = (
    ' 1 1000 bazzite -     2777  manager -    no -\n'
    '15 1000 bazzite seat0 7465  user    tty1 no -\n'
    '33 1000 bazzite -     20572 user    -    no -\n',
    {"1": 'Seat=\nClass=manager\n', "15": 'Seat=seat0\nClass=user\n',
     "33": 'Seat=\nClass=user\n'})
# The STRANDED seat. SYNTHESISED — the box was no longer at the greeter when
# captured — from the stranded boot's logind journal:
#   New session '1' of user 'bazzite' with class 'manager' and type 'unspecified'.
#   New session 'c1' of user 'sddm' with class 'greeter' and type 'wayland'.
#   New session '2' of user 'sddm' with class 'manager-early' and type 'unspecified'.
# (sddm is uid 958 per the same boot's pam_unix line; c1's leader is the
# sddm-helper pid that opened it.) Line layout copied from the verbatim capture.
# Seat=seat0 for c1 is INFERRED (SDDM starts its greeter on seat0); logind's
# journal line does not print the seat.
LOGIND_GREETER_ONLY = (
    ' 1 1000 bazzite -     2777  manager       -    no -\n'
    ' 2  958 sddm    -     2835  manager-early -    no -\n'
    'c1  958 sddm    seat0 2830  greeter       tty1 no -\n',
    {"1": 'Seat=\nClass=manager\n', "2": 'Seat=\nClass=manager-early\n',
     "c1": 'Seat=seat0\nClass=greeter\n'})
# Before the display manager has started: only the linger manager session
# (journal: session '1' existed at 11:40:48.267, sddm started at .298).
LOGIND_EMPTY_SEAT = (' 1 1000 bazzite -     2777  manager -    no -\n',
                     {"1": 'Seat=\nClass=manager\n'})

STOCK_RESTART = {"label": "Restart Session", "description": "x", "danger": "high",
                 "cmd": ["sudo", "systemctl", "restart", "sddm"],
                 "user_env": False, "detached": False}


class Box:
    """A hermetic Bazzite box for the arm/consume/rescue tests: conf layers in a
    temp dir, a fake subprocess.run that PERFORMS `sudo -n tee` on those files
    (so assertions read what SDDM would merge), answers steamosctl the way 43 or
    44 does, replays a scripted sequence of logind states, and RECORDS — never
    runs — anything else. Every identity source the code consults is owned here
    (CONVENTIONS: a fake must own every identity source), including the helper
    socket, so running this file on a real box can never touch the real one."""

    NAMES = ("subprocess.run", "_sudo_nopasswd_allows", "detect_display_manager",
             "_display_manager_unit_name", "_installed_session_files",
             "CONFIG_PATH", "_DM_CONF_DIRS", "_DM_SYS_CONF_DIRS", "_DM_MAIN_CONFS",
             "_DM_STATE_FILES", "_arm_hook_installed", "_helper_call",
             "_OSTREE_STAGED_DEPLOYMENT", "_SESSION_RESCUE_POLL_S",
             "_SESSION_RESCUE_WATCH_S", "ACTIONS")

    def __init__(self, tmp, image=44, pref="game", stale_dropin=True):
        self.tmp = tmp
        self.saved = {}
        for n in self.NAMES:
            obj, attr = (cs.subprocess, "run") if n == "subprocess.run" else (cs, n)
            self.saved[n] = getattr(obj, attr, None)
        self.sysd = os.path.join(tmp, "usr-lib-sddm.conf.d")
        self.etcd = os.path.join(tmp, "etc-sddm.conf.d")
        for d in (self.sysd, self.etcd):
            os.makedirs(d, exist_ok=True)
        for name, body in BAZZITE44_SYS_CONF.items():
            self._write(os.path.join(self.sysd, name), body)
        for name, body in BAZZITE44_ETC_CONF.items():
            self._write(os.path.join(self.etcd, name), body)
        self.dropin = os.path.join(self.etcd, "zzz-couchside-session.conf")
        if stale_dropin:
            self._write(self.dropin, STRANDING_DROPIN)
        self.image = image
        self.seat = [LOGIND_USER_ON_SEAT]
        self.calls = []
        self.tees = []
        self.restarts = []
        self.restart_ok = True
        self.tee_ok = True
        cs.subprocess.run = self.run
        cs._sudo_nopasswd_allows = lambda needle: True
        cs.detect_display_manager = lambda: "sddm"
        cs._display_manager_unit_name = lambda: "sddm"
        self.installed = set(BAZZITE44_SESSIONS if image == 44 else BAZZITE43_SESSIONS)
        cs._installed_session_files = lambda: set(self.installed)
        cs.CONFIG_PATH = os.path.join(tmp, "config.json")
        self._write(cs.CONFIG_PATH, '{"units": [], "session_default": "%s"}' % pref
                    if pref else '{"units": []}')
        cs._DM_CONF_DIRS = {"sddm": self.etcd, "plasmalogin": self.etcd}
        cs._DM_SYS_CONF_DIRS = {"sddm": self.sysd, "plasmalogin": self.sysd}
        cs._DM_MAIN_CONFS = {"sddm": os.path.join(tmp, "absent-sddm.conf"),
                             "plasmalogin": os.path.join(tmp, "absent-pl.conf")}
        cs._DM_STATE_FILES = {}
        cs._arm_hook_installed = lambda: True
        cs._helper_call = lambda *a, **k: None   # no helper: the sudo path
        self.staged = os.path.join(tmp, "run-ostree-staged-deployment")
        cs._OSTREE_STAGED_DEPLOYMENT = self.staged
        cs._SESSION_RESCUE_POLL_S = 0.005
        cs._SESSION_RESCUE_WATCH_S = 1.0
        cs.ACTIONS = dict(self.saved["ACTIONS"] or {}, **{"restart-session": dict(STOCK_RESTART)})
        cs._SESSION_RESCUE_THREAD = None

    @staticmethod
    def _write(path, body):
        with open(path, "w") as f:
            f.write(body)

    def platform_files(self):
        """Bytes of every file that is NOT ours, for the never-touch check."""
        out = {}
        for d in (self.sysd, self.etcd):
            for n in sorted(os.listdir(d)):
                if n in ("zzz-couchside-session.conf", "zz-couchside-session.conf"):
                    continue
                with open(os.path.join(d, n), "rb") as f:
                    out[os.path.join(os.path.basename(d), n)] = f.read()
        return out

    def run(self, argv, **kw):
        argv = list(argv)
        self.calls.append(argv)

        class R:
            pass
        r = R()
        r.returncode, r.stdout, r.stderr = 0, "", ""
        if argv[:3] == ["sudo", "-n", "tee"]:
            self.tees.append(argv[3])
            if not self.tee_ok:
                r.returncode, r.stderr = 1, "sudo: a password is required"
                return r
            with open(argv[3], "w") as fh:
                fh.write(kw.get("input", ""))
        elif argv[:2] == ["steamosctl", "get-default-login-mode"]:
            if self.image == 44:
                r.stdout = "game\n"   # 44: the interface answers
            else:                     # 43: verbatim exit-0 lie (top of file)
                r.stderr = ("Error: org.freedesktop.DBus.Error.UnknownInterface: "
                            "Unknown interface 'com.steampowered.SteamOSManager1."
                            "SessionManagement1'")
        elif argv[:3] == ["loginctl", "list-sessions", "--no-legend"]:
            state = self.seat[0] if len(self.seat) == 1 else self.seat.pop(0)
            self._shown = state[1]
            r.stdout = state[0]
        elif argv[:2] == ["loginctl", "show-session"]:
            body = self._shown.get(argv[2])
            if body is None:
                r.returncode, r.stderr = 1, "No session '%s' known" % argv[2]
            else:
                r.stdout = body
        elif argv[:3] == ["sudo", "systemctl", "restart"]:
            self.restarts.append(argv)
            if not self.restart_ok:
                r.returncode, r.stderr = 1, "sudo: a password is required"
        return r

    def join_rescue(self):
        t = getattr(cs, "_SESSION_RESCUE_THREAD", None)
        if t is not None:
            t.join(10)

    def restore(self):
        for n, v in self.saved.items():
            obj, attr = (cs.subprocess, "run") if n == "subprocess.run" else (cs, n)
            setattr(obj, attr, v)


def test_bazzite44_session_names():
    """couchmode + autologin resolver on the 44 image, and 43/SteamOS unchanged.

    The resolver must land on the name Bazzite 44's OWN autologin uses
    (holo.conf / zz-holo-autologin.conf, verbatim) — not merely any gamescope
    name — and a 43 box, which has BOTH gamescope-session.desktop and
    gamescope-session-steam.desktop, must resolve exactly as before."""
    print("test_bazzite44_session_names")
    saved = (cs._installed_session_files, cs._GAMESCOPE_SESSION_FILES)
    try:
        distro_own = BAZZITE44_ETC_CONF["zz-holo-autologin.conf"].split("Session=")[1].strip()
        cs._installed_session_files = lambda: set(BAZZITE44_SESSIONS)
        check("bazzite 44 resolves to the name its OWN autologin boots",
              cs._gamescope_session_for_autologin(), distro_own)
        check("...which is gamescope-session-ogui-steam.desktop",
              distro_own, "gamescope-session-ogui-steam.desktop")
        # CONTROL: the pre-fix tuple on the same box. This is the bug — nothing
        # to arm, and (in test_couchmode_gate) no couchmode cap.
        cs._GAMESCOPE_SESSION_FILES = ("gamescope-session.desktop",
                                       "gamescope-wayland.desktop")
        check("CONTROL: the pre-fix name set finds nothing on 44",
              cs._gamescope_session_for_autologin(), None)
        cs._GAMESCOPE_SESSION_FILES = saved[1]
        # Unchanged elsewhere: 43 keeps the name ITS autologin used (steamos.conf
        # Session=gamescope-session.desktop, verbatim in main()), and the
        # SteamOS / Legion Go S sets are untouched.
        cs._installed_session_files = lambda: set(BAZZITE43_SESSIONS)
        check("bazzite 43 still resolves to gamescope-session.desktop",
              cs._gamescope_session_for_autologin(), "gamescope-session.desktop")
        cs._installed_session_files = lambda: {"gamescope-session.desktop",
                                               "plasma.desktop", "plasmax11.desktop"}
        check("steamos still resolves to gamescope-session.desktop",
              cs._gamescope_session_for_autologin(), "gamescope-session.desktop")
        cs._installed_session_files = lambda: {"gamescope-wayland.desktop",
                                               "plasma.desktop", "plasmax11.desktop"}
        check("legion go s still resolves to gamescope-wayland.desktop",
              cs._gamescope_session_for_autologin(), "gamescope-wayland.desktop")
        # Only the plain-steam 44 name installed: still a real Game Mode session.
        cs._installed_session_files = lambda: {"gamescope-session-steam.desktop",
                                               "plasma.desktop"}
        check("gamescope-session-steam alone is accepted",
              cs._gamescope_session_for_autologin(), "gamescope-session-steam.desktop")
    finally:
        cs._installed_session_files, cs._GAMESCOPE_SESSION_FILES = saved


def test_getter_reads_a_bazzite44_record_as_game(tmp):
    """The name->mode reader must know the 44 names too, or a drop-in-backend
    box whose record names gamescope-session-ogui-steam.desktop reads
    "unknown". Verbatim 44 conf layers; control with the pre-fix tuple.

    DELIBERATELY SYNTHETIC COMBINATION: the real 44 box answers steamosctl, so
    its getter never reaches this reader. The 43-style steamosctl failure is
    used here to force the sddm backend and exercise the name->mode mapping on
    44's verbatim layers — i.e. any sddm-backend image that adopts these names."""
    print("test_getter_reads_a_bazzite44_record_as_game")
    box = Box(tmp, image=43, pref="last", stale_dropin=False)
    saved_tuple = cs._GAMESCOPE_SESSION_FILES
    try:
        # sddm backend (43's steamosctl lie), pref "last" -> reads the merged
        # config, which on these verbatim layers names the ogui-steam session.
        check("merged 44 config names ogui-steam",
              cs._dm_current_session_file("sddm"), "gamescope-session-ogui-steam.desktop")
        check("getter maps it to game", cs.session_default_get()["mode"], "game")
        cs._GAMESCOPE_SESSION_FILES = ("gamescope-session.desktop",
                                       "gamescope-wayland.desktop")
        check("CONTROL: the pre-fix name set reads it as unknown",
              cs.session_default_get()["mode"], "unknown")
    finally:
        cs._GAMESCOPE_SESSION_FILES = saved_tuple
        box.restore()


def test_consume_removes_an_orphaned_dropin(tmp):
    """Orphan cleanup, both directions, and the platform's files never touched.

    THE BUG: on 44 the backend is steamosctl, and consume() returned before
    looking at our file — so the zzz- drop-in armed under 43 (naming a session
    44 lacks) survived every boot. Seat is a user session here, so this test
    isolates the cleanup from the rescue."""
    print("test_consume_removes_an_orphaned_dropin")
    box = Box(tmp, image=44, pref="game", stale_dropin=True)
    try:
        before = box.platform_files()
        check("precondition: backend on 44 is steamosctl",
              cs.session_default_backend(), "steamosctl")
        check("precondition: our drop-in names the missing 43 session",
              cs._last_session_line(box.dropin), "gamescope-session.desktop")
        cs.session_default_consume()
        box.join_rescue()
        check("consume removes our orphaned Session= whatever the backend",
              cs._last_session_line(box.dropin), "")
        check("...leaving the platform's own autologin in charge",
              cs._dm_current_session_file("sddm"), "gamescope-session-ogui-steam.desktop")
        check("...wrote ONLY our two paths (zzz- and the legacy zz-)",
              sorted(set(os.path.basename(p) for p in box.tees)),
              ["zz-couchside-session.conf", "zzz-couchside-session.conf"])
        check("...and every platform file is byte-identical", box.platform_files(), before)
        check("...and the stored preference survives", cs.session_default_pref(), "game")
        check("user session on seat0 -> no display-manager restart", box.restarts, [])

        # Direction 2: nothing of ours present -> nothing written at all.
        box.tees[:] = []
        os.remove(box.dropin)
        cs.session_default_consume()
        box.join_rescue()
        check("absent drop-in: consume writes nothing to it",
              [p for p in box.tees if p.endswith("zzz-couchside-session.conf")], [])
        check("absent drop-in: platform files still byte-identical",
              box.platform_files(), before)

        # Migration rule kept: a preference that only lives in the drop-in is
        # adopted into config BEFORE the blanking, on a steamosctl box too.
        Box._write(box.dropin, STRANDING_DROPIN)
        Box._write(cs.CONFIG_PATH, '{"units": []}')
        cs.session_default_consume()
        box.join_rescue()
        check("drop-in-only preference is adopted into config first",
              cs.session_default_pref(), "game")
        check("...and only then blanked", cs._last_session_line(box.dropin), "")

        # ...and if that save FAILS, the file that still holds it is left alone.
        Box._write(box.dropin, STRANDING_DROPIN)
        Box._write(cs.CONFIG_PATH, '{"units": []}')
        real_set = cs._config_set_field

        def boom(*a, **k):
            raise OSError("read-only config")
        cs._config_set_field = boom
        try:
            cs.session_default_consume()
            box.join_rescue()
        finally:
            cs._config_set_field = real_set
        check("unsaved preference -> drop-in NOT blanked (no data loss)",
              cs._last_session_line(box.dropin), "gamescope-session.desktop")
    finally:
        box.restore()


def test_staged_os_update_is_never_armed(tmp):
    """A staged image update -> arm writes NOTHING (disarms instead); no staged
    update -> arm writes as before. The 43 box: sddm backend, pref game."""
    print("test_staged_os_update_is_never_armed")
    box = Box(tmp, image=43, pref="game", stale_dropin=False)
    try:
        check("precondition: 43 backend is sddm", cs.session_default_backend(), "sddm")
        # Not staged: the ordinary shutdown still arms (the feature still works).
        cs.session_default_arm()
        check("not staged -> arm writes the 43 session",
              cs._last_session_line(box.dropin), "gamescope-session.desktop")
        # Staged: the next boot is 44. The 2026-09-26 stranding, prevented.
        Box._write(box.dropin, "")
        Box._write(box.staged, "")
        cs.session_default_arm()
        check("staged -> arm writes NO Session= (platform decides that boot)",
              cs._last_session_line(box.dropin), "")
        # A stale armed file (e.g. from an agent restart's ExecStop) is cleared,
        # not left to name a session the new image may not have.
        Box._write(box.dropin, STRANDING_DROPIN)
        cs.session_default_arm()
        check("staged -> an already-armed drop-in is DISARMED",
              cs._last_session_line(box.dropin), "")
        # Same for desktop.
        with cs.CONFIG_LOCK:
            cs._config_set_field(cs.SESSION_DEFAULT_CONFIG_KEY, "desktop")
        cs.session_default_arm()
        check("staged -> desktop preference is not armed either",
              cs._last_session_line(box.dropin), "")
        check("...and the preference itself is kept for the next shutdown",
              cs.session_default_pref(), "desktop")
        # Update applied/cleared: arming resumes, from the stored preference.
        os.remove(box.staged)
        cs.session_default_arm()
        check("staged marker gone -> arm resumes",
              cs._last_session_line(box.dropin) in BAZZITE43_SESSIONS, True)
    finally:
        box.restore()


def test_seat_parser_on_verbatim_logind():
    """_seat_session_classes on the verbatim systemd-259 output, plus the shapes
    that must degrade to UNKNOWN (never to a decision)."""
    print("test_seat_parser_on_verbatim_logind")
    if not hasattr(cs, "_seat_session_classes"):
        check("_seat_session_classes exists", False, True)
        return
    real = cs.subprocess.run
    tmp = tempfile.mkdtemp()
    box = Box(tmp)
    try:
        box.seat = [LOGIND_USER_ON_SEAT]
        check("verbatim 44 user seat -> [user]", cs._seat_session_classes(), ["user"])
        check("...classified occupied",
              cs._seat_state(cs._seat_session_classes()), "occupied")
        box.seat = [LOGIND_GREETER_ONLY]
        check("stranded seat -> [greeter] (manager/manager-early have no seat)",
              cs._seat_session_classes(), ["greeter"])
        check("...classified greeter-only",
              cs._seat_state(cs._seat_session_classes()), "greeter-only")
        box.seat = [LOGIND_EMPTY_SEAT]
        check("before the DM starts -> [] (empty)", cs._seat_session_classes(), [])
        check("...classified empty", cs._seat_state([]), "empty")
        # A greeter next to a user session (fast-user-switch, lock screen...) is
        # someone on the seat.
        check("greeter + user -> occupied", cs._seat_state(["greeter", "user"]), "occupied")
        check("a class never seen -> occupied, not greeter-only",
              cs._seat_state(["lock-screen"]), "occupied")
        # Unknown shapes are None — the watcher never decides on them.
        box.seat = [("weird;id 1000 x seat0\n", {})]
        check("non-alphanumeric session id -> None (reject, not sanitise)",
              cs._seat_session_classes(), None)
        box.seat = [("c9  958 sddm seat0 1 greeter tty1 no -\n", {})]
        check("show-session fails (session vanished) -> None",
              cs._seat_session_classes(), None)
        check("None classifies as unknown", cs._seat_state(None), "unknown")

        def failing(argv, **kw):
            class R:
                pass
            r = R()
            r.returncode, r.stdout, r.stderr = 1, "", "Failed to connect to bus"
            return r
        cs.subprocess.run = failing
        check("loginctl failing -> None", cs._seat_session_classes(), None)

        def raising(argv, **kw):
            raise FileNotFoundError("loginctl")
        cs.subprocess.run = raising
        check("no loginctl binary -> None (never raises)", cs._seat_session_classes(), None)
    finally:
        cs.subprocess.run = real
        box.restore()
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


def test_rescue_fires_only_when_stranded_at_the_greeter(tmp_root):
    """The rescue, end to end through consume(): it restarts the display manager
    through the EXISTING restart-session argv only when our drop-in named a
    missing session AND seat0 holds nothing but a greeter — and never twice."""
    print("test_rescue_fires_only_when_stranded_at_the_greeter")
    import shutil
    n = [0]

    def fresh(**kw):
        n[0] += 1
        d = os.path.join(tmp_root, "case%d" % n[0])
        os.makedirs(d)
        return Box(d, **kw)

    # 1. THE MEASURED FAILURE: 44, stale 43 drop-in, seat0 = greeter.
    box = fresh(image=44)
    try:
        box.seat = [LOGIND_GREETER_ONLY]
        cs.session_default_consume()
        box.join_rescue()
        check("stranded at the greeter -> ONE display-manager restart",
              box.restarts, [["sudo", "systemctl", "restart", "sddm"]])
        check("...through the stock restart-session argv, nothing new",
              box.restarts[:1] == [STOCK_RESTART["cmd"]], True)
        check("...and only AFTER our drop-in was cleared",
              cs._last_session_line(box.dropin), "")
        # Idempotent: the next start (the agent restarts, or the box reboots
        # into the fixed config) finds nothing to rescue.
        cs._SESSION_RESCUE_THREAD = None
        cs.session_default_consume()
        box.join_rescue()
        check("a second consume cannot fire again (file already clear)",
              len(box.restarts), 1)
    finally:
        box.restore()

    # 2. User session on seat0 -> never, even with the missing-session drop-in.
    box = fresh(image=44)
    try:
        box.seat = [LOGIND_USER_ON_SEAT]
        cs.session_default_consume()
        box.join_rescue()
        check("user session on seat0 -> NO restart", box.restarts, [])
        check("...but the orphan is still removed", cs._last_session_line(box.dropin), "")
    finally:
        box.restore()

    # 3. Greeter, but our drop-in named an INSTALLED session (a normal armed
    # boot where the user has since logged out) -> not ours to rescue.
    box = fresh(image=44)
    try:
        Box._write(box.dropin, STRANDING_DROPIN.replace(
            "gamescope-session.desktop", "gamescope-session-ogui-steam.desktop"))
        box.seat = [LOGIND_GREETER_ONLY]
        cs.session_default_consume()
        box.join_rescue()
        check("greeter + drop-in naming an INSTALLED session -> NO restart",
              box.restarts, [])
    finally:
        box.restore()

    # 4. The DM has not started yet when the agent does (measured: agent 120 ms
    # ahead of sddm) -> keep watching, then fire once the greeter shows.
    box = fresh(image=44)
    try:
        box.seat = [LOGIND_EMPTY_SEAT, LOGIND_EMPTY_SEAT, LOGIND_GREETER_ONLY]
        cs.session_default_consume()
        box.join_rescue()
        check("empty seat, then greeter -> waits, then ONE restart",
              len(box.restarts), 1)
    finally:
        box.restore()

    # 5. A greeter seen once, then the user logs in -> never fire (two
    # consecutive greeter-only reads are required).
    box = fresh(image=44)
    try:
        box.seat = [LOGIND_GREETER_ONLY, LOGIND_USER_ON_SEAT]
        cs.session_default_consume()
        box.join_rescue()
        check("greeter once then a user session -> NO restart", box.restarts, [])
    finally:
        box.restore()

    # 6. logind unreadable the whole window -> gives up, never guesses.
    box = fresh(image=44)
    try:
        box.seat = [("weird;id\n", {})]
        cs.session_default_consume()
        box.join_rescue()
        check("logind unknown for the whole window -> NO restart", box.restarts, [])
    finally:
        box.restore()

    # 7. No stock restart-session action (no grant, or owner-customised) ->
    # blocked, loudly; never a new command.
    for label, actions in (("absent", {}),
                           ("owner-customised", {"restart-session": dict(
                               STOCK_RESTART, cmd=["/usr/local/bin/my-restart"])}),
                           ("aimed at another manager", {"restart-session": dict(
                               STOCK_RESTART, cmd=["sudo", "systemctl", "restart",
                                                   "plasmalogin"])})):
        box = fresh(image=44)
        try:
            cs.ACTIONS = actions
            box.seat = [LOGIND_GREETER_ONLY]
            cs.session_default_consume()
            box.join_rescue()
            check("restart-session %s -> nothing runs" % label,
                  box.restarts + [c for c in box.calls if c[:1] == ["/usr/local/bin/my-restart"]],
                  [])
            check("...the orphan is still removed (%s)" % label,
                  cs._last_session_line(box.dropin), "")
        finally:
            box.restore()

    # 8. Could not clear the drop-in -> a restart would fail autologin again.
    box = fresh(image=44)
    try:
        box.tee_ok = False
        box.seat = [LOGIND_GREETER_ONLY]
        cs.session_default_consume()
        box.join_rescue()
        check("drop-in not cleared -> NO restart", box.restarts, [])
    finally:
        box.restore()

    # 9. The platform's own config names nothing installed either -> a restart
    # autologins nowhere; do not kill a greeter someone may be typing into.
    box = fresh(image=44)
    try:
        os.remove(os.path.join(box.sysd, "holo.conf"))
        os.remove(os.path.join(box.etcd, "zz-holo-autologin.conf"))
        box.installed.discard("plasma.desktop")  # 99-plasma-setup's "plasma"
        box.seat = [LOGIND_GREETER_ONLY]
        cs.session_default_consume()
        box.join_rescue()
        check("platform names no installed session -> NO restart", box.restarts, [])
    finally:
        box.restore()

    # 10. Session dirs unreadable -> "missing" is unknown, not absent.
    box = fresh(image=44)
    try:
        box.installed = set()
        box.seat = [LOGIND_GREETER_ONLY]
        cs.session_default_consume()
        box.join_rescue()
        check("unreadable session dirs -> NO restart", box.restarts, [])
    finally:
        box.restore()

    # 11. The bare-name normalisation SDDM does: platform "plasma" (verbatim
    # 99-plasma-setup.conf) counts as the installed plasma.desktop.
    box = fresh(image=44)
    try:
        os.remove(os.path.join(box.sysd, "holo.conf"))
        os.remove(os.path.join(box.etcd, "zz-holo-autologin.conf"))
        box.seat = [LOGIND_GREETER_ONLY]
        cs.session_default_consume()
        box.join_rescue()
        check("platform names bare 'plasma' (installed as plasma.desktop) -> restart",
              len(box.restarts), 1)
    finally:
        box.restore()

    # 13. The rescue can never take agent startup down: main() calls consume
    # unguarded before the server binds.
    box = fresh(image=44)
    real_start = getattr(cs, "_session_rescue_start", None)
    try:
        def explode(*a, **k):
            raise RuntimeError("can't start new thread")
        cs._session_rescue_start = explode
        raised = None
        try:
            cs.session_default_consume()
        except Exception as e:
            raised = e
        check("a failing rescue launch never escapes consume()", raised, None)
        check("...and the orphan was still removed first",
              cs._last_session_line(box.dropin), "")
    finally:
        if real_start is not None:
            cs._session_rescue_start = real_start
        box.restore()

    # 12. --mock never runs any of it.
    box = fresh(image=44)
    try:
        box.seat = [LOGIND_GREETER_ONLY]
        cs.session_default_consume(mock=True)
        box.join_rescue()
        check("mock consume touches nothing",
              (box.restarts, box.tees, cs._last_session_line(box.dropin)),
              ([], [], "gamescope-session.desktop"))
    finally:
        box.restore()


def main():
    real_run = cs.subprocess.run
    real_sudo = cs._sudo_nopasswd_allows
    # HERMETIC, for every test in this file. arm() now reads libostree's
    # staged-update marker, so point it at a path that cannot exist (on an
    # ostree box with an update staged, the real one would flip every arm test).
    # And never let a test reach a REAL couchside-helper socket: on a box that
    # runs one, clear-boot/set-boot would edit the real /etc drop-in. On CI
    # neither exists, so this changes nothing there.
    _hermetic = tempfile.mkdtemp()
    cs._OSTREE_STAGED_DEPLOYMENT = os.path.join(_hermetic, "never-staged")
    cs._helper_call = lambda *a, **k: None

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
    # The arming hook is a PRECONDITION from 2.9.67: without the ExecStop line
    # in the unit nothing can write the preference for the next boot, so the
    # capability must not be offered. Controlled explicitly here, and exercised
    # both ways below.
    real_hook = cs._arm_hook_installed
    cs._arm_hook_installed = lambda: True
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

    # THE DELIVERY GAP, pinned. install.sh's phone-update fast path replaces
    # couchsided.py and exits ~450 lines before the unit install, with no
    # daemon-reload — so an app-updated box runs the new agent under the OLD
    # unit and NOTHING can arm the preference. Advertising it there would be a
    # setting that silently does nothing, which is what this whole rewrite was
    # for. Hide it instead.
    cs.detect_display_manager = lambda: "sddm"
    cs._arm_hook_installed = lambda: False
    check("no ExecStop arming hook -> NO backend (the card hides)",
          cs.session_default_backend(), None)
    check("...capability absent", cs.session_default_available(), False)
    cs._arm_hook_installed = lambda: True
    check("...and present again once the unit carries it (control)",
          cs.session_default_backend(), "sddm")

    (cs._DM_CONF_DIRS, cs._DM_SYS_CONF_DIRS, cs._DM_MAIN_CONFS,
     cs._DM_STATE_FILES) = saved_layers
    cs.detect_display_manager = real_detect
    cs._arm_hook_installed = real_hook

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
    _t = tempfile.mkdtemp()
    try:
        test_boot_preference_is_armed_only_while_the_box_is_off(_t)
    finally:
        import shutil
        shutil.rmtree(_t, ignore_errors=True)

    print()
    print("gamescope session filename varies by image (Legion Go S / SteamOS 3.8)")
    test_gamescope_session_resolver()
    _g = tempfile.mkdtemp()
    try:
        test_gamescope_wayland_write_and_read(_g)
        test_steamosctl_set_uses_mode_arg(_g)
    finally:
        import shutil
        shutil.rmtree(_g, ignore_errors=True)

    print()
    print("Bazzite 43 -> 44: the OS update that stranded the living-room box")
    test_bazzite44_session_names()
    test_seat_parser_on_verbatim_logind()
    for fn in (test_getter_reads_a_bazzite44_record_as_game,
               test_consume_removes_an_orphaned_dropin,
               test_staged_os_update_is_never_armed,
               test_rescue_fires_only_when_stranded_at_the_greeter):
        _d = tempfile.mkdtemp()
        try:
            fn(_d)
        finally:
            import shutil
            shutil.rmtree(_d, ignore_errors=True)

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
