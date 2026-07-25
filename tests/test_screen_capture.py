#!/usr/bin/env python3
"""Tests for screen-capture backend selection (GET /api/screen, /api/screen/frame).

Run: python3 tests/test_screen_capture.py

THE BUG THIS LOCKS DOWN, measured on a real box (lenovodesktop, agent 2.9.31):

  couchside.service came up at 09:34:26. The gamescope compositor socket
  (gamescope-0) appeared at 09:35 -- one minute LATER. set_screen() ran once at
  startup, saw no gamescope socket, and cached {session: desktop, backends:
  [spectacle]}. Nothing ever re-evaluated it, so for the rest of the agent's
  uptime every capture fired `spectacle` (a KDE desktop tool) at a gamescope
  session. spectacle wrote no file, so /api/screen/frame returned
  503 "capture failed" forever and the app's SCREEN card sat on "capturing...".

  Verified by hand on the box: spectacle -> no file; gamescopectl -> a 357KB
  PNG. Restarting the service (with gamescope already up) flipped
  /api/screen to {session: gamescope, backends: [gamescopectl, spectacle]} and
  /api/screen/frame to 200 image/jpeg.

  It presented as "screen capture works sometimes" because whether it worked
  depended entirely on which of the agent and the Steam session won the boot
  race. That is why the fix is re-evaluation per call, and why these tests
  drive the socket set CHANGING after startup rather than only checking a
  correct startup.

Pure stdlib, no pytest -- same style as the other agent tests.
"""
import importlib.util
import os

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT = os.path.join(HERE, "..", "agent", "couchsided.py")
spec = importlib.util.spec_from_file_location("couchsided", AGENT)
cs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cs)

PASS = "  \033[32mPASS\033[0m"
FAIL = "  \033[31mFAIL\033[0m"
_fail = []


def check(cond, label):
    print((PASS if cond else FAIL) + "  " + label)
    if not cond:
        _fail.append(label)


def _install(sockets, tools=("gamescopectl", "spectacle"), downscaler=True):
    """Point the agent at a fake compositor socket set + tool set, then run the
    real startup detection. Returns a restore callable."""
    o_socks, o_which, o_dscale = (cs._wayland_display_sockets, cs.shutil.which,
                                  cs._screen_downscaler)
    box = {"sockets": list(sockets)}

    cs._wayland_display_sockets = lambda: list(box["sockets"])
    cs.shutil.which = lambda n: ("/usr/bin/" + n) if n in tools else None
    if downscaler:
        cs._screen_downscaler = lambda: ((lambda src, dst: ["true", src, dst]), "fake")
    else:
        cs._screen_downscaler = lambda: (None, None)
    cs.set_screen(False)

    def restore():
        cs._wayland_display_sockets, cs.shutil.which = o_socks, o_which
        cs._screen_downscaler = o_dscale
    return box, restore


def test_session_appearing_after_startup():
    print("compositor that starts AFTER the agent (the boot race)")
    box, restore = _install([])          # agent boots first: no compositor yet
    try:
        live = cs._screen_live()
        check(live is not None, "desktop-only start still offers a backend")
        check(live["session"] == "desktop", "no gamescope socket -> desktop")
        check(live["backends"] == ["spectacle"], "desktop start selects spectacle")

        # Game Mode comes up a minute later. THIS is what used to be missed.
        box["sockets"] = ["gamescope-0"]
        live = cs._screen_live()
        check(live["session"] == "gamescope",
              "session re-detected as gamescope without a restart")
        check(live["backends"][0] == "gamescopectl",
              "gamescopectl preferred once its socket exists (the regression)")
        check(live["gs_socket"] == "gamescope-0",
              "WAYLAND_DISPLAY target follows the live socket")
    finally:
        restore()


def test_session_disappearing():
    print("compositor that goes away (Game Mode -> desktop)")
    box, restore = _install(["gamescope-0"])
    try:
        check(cs._screen_live()["backends"][0] == "gamescopectl",
              "starts on gamescopectl")
        box["sockets"] = []
        live = cs._screen_live()
        check(live["session"] == "desktop", "falls back to desktop")
        check("gamescopectl" not in live["backends"],
              "gamescopectl dropped with its socket (never grabs a dead socket)")
        check(live["gs_socket"] is None, "stale socket path cleared")
    finally:
        restore()


def test_env_targets_live_socket():
    print("capture env follows the live socket")
    box, restore = _install([])
    try:
        box["sockets"] = ["gamescope-1"]
        env = cs._screen_env(cs._screen_live())
        check(env.get("WAYLAND_DISPLAY") == "gamescope-1",
              "WAYLAND_DISPLAY points at the current compositor")
    finally:
        restore()


def test_dead_socket_file_is_not_a_live_compositor():
    """A LEFTOVER socket FILE must never be mistaken for a running compositor.

    THE BUG, measured on a Bazzite box (agent 2.9.55): leaving Game Mode leaves
    /run/user/1000/gamescope-0 behind in tmpfs with nothing listening. Presence
    was treated as proof, so _screen_live() reported "gamescope" on a Plasma
    desktop AND _screen_env() pinned WAYLAND_DISPLAY to the corpse -- which broke
    the spectacle FALLBACK too ("Authorization required"). Result: 10/10 requests
    503 after ~8.7s each, permanently, until reboot.

    Drives the REAL _wayland_display_sockets() against REAL AF_UNIX files (the
    other tests here stub that function, so they cannot see this bug), and
    asserts the resulting ENV -- not just the session string. A fix that only
    corrects the session decision still leaves the env pointing at the dead
    socket, which is the half that broke the fallback.
    """
    print("a leftover socket file is not a live compositor")
    import fcntl as _fcntl
    import tempfile
    tmp = tempfile.mkdtemp(prefix="couchsock_")
    real_dir, real_env = cs.XDG_RUNTIME_DIR, dict(os.environ)
    held_fd = None
    try:
        cs.XDG_RUNTIME_DIR = tmp

        # Reproduce the real layout: a wayland display is <sock> + <sock>.lock,
        # and a RUNNING compositor holds an exclusive flock on the lock file.
        # Verified against a live Bazzite box: wayland-0.lock was held while
        # kwin_wayland ran, gamescope-0.lock was NOT while gamescope was gone.
        for n in ("gamescope-0", "wayland-0"):
            open(os.path.join(tmp, n), "w").close()          # the socket file
            open(os.path.join(tmp, n + ".lock"), "w").close()  # its lock
        # LIVE: hold wayland-0's lock the way a compositor does.
        held_fd = os.open(os.path.join(tmp, "wayland-0.lock"), os.O_RDWR)
        _fcntl.flock(held_fd, _fcntl.LOCK_EX | _fcntl.LOCK_NB)
        # DEAD: gamescope-0.lock is left unlocked -- the Game Mode corpse.

        socks = cs._wayland_display_sockets()
        check("gamescope-0" not in socks, "dead gamescope-0 filtered out")
        check("wayland-0" in socks, "live wayland-0 still reported")

        # CONTROL for the flaw that a connect()-based probe had: probing must be
        # REPEATABLE. A connect() probe consumed the listen backlog, so the
        # SECOND call reported the live compositor as dead. flock does not.
        again = cs._wayland_display_sockets()
        check(again == socks, "repeated probe gives the same answer (no side effects)")

        # The env half: it must NOT pin the corpse. Before the fix this returned
        # WAYLAND_DISPLAY=gamescope-0 and poisoned the spectacle fallback, which
        # is why fixing only the session decision would not have been enough.
        os.environ.pop("WAYLAND_DISPLAY", None)
        env = cs._screen_env(None)
        check(env.get("WAYLAND_DISPLAY") != "gamescope-0",
              "env NOT pinned to the dead socket")
        check(env.get("WAYLAND_DISPLAY") == "wayland-0",
              "env pinned to the one LIVE socket")
    finally:
        cs.XDG_RUNTIME_DIR = real_dir
        os.environ.clear()
        os.environ.update(real_env)
        if held_fd is not None:
            try:
                os.close(held_fd)
            except OSError:
                pass
        for n in ("gamescope-0", "wayland-0"):
            for p in (os.path.join(tmp, n), os.path.join(tmp, n + ".lock")):
                try:
                    os.unlink(p)
                except OSError:
                    pass
        try:
            os.rmdir(tmp)
        except OSError:
            pass


def test_probe_and_appear_preserved():
    print("probe-and-appear: a box that cannot capture stays hidden")
    # No downscaler at all -> the card must never appear, however many
    # compositors show up later.
    box, restore = _install(["gamescope-0"], downscaler=False)
    try:
        check(cs._SCREEN is None, "no downscaler -> no capability at startup")
        check(cs._screen_live() is None, "and none later either")
        check(cs.screen_info() is None, "/api/screen 404s (card hidden)")
    finally:
        restore()

    # Tools present, downscaler present, but no compositor AND no desktop tool:
    # nothing can grab right now, so the card hides until something can.
    box, restore = _install([], tools=("gamescopectl",))
    try:
        check(cs._screen_live() is None,
              "gamescopectl installed but no socket -> nothing to capture")
        check(cs.screen_info() is None, "card hidden while unusable")
        box["sockets"] = ["gamescope-0"]
        check(cs.screen_info() is not None,
              "card appears once the compositor is up (no restart needed)")
    finally:
        restore()


def test_no_tools():
    print("degrades safely")
    box, restore = _install(["gamescope-0"], tools=())
    try:
        check(cs._SCREEN is None, "no capture tool -> no capability")
        check(cs._screen_live() is None, "no raise, just unavailable")
    finally:
        restore()


if __name__ == "__main__":
    test_session_appearing_after_startup()
    test_session_disappearing()
    test_env_targets_live_socket()
    test_dead_socket_file_is_not_a_live_compositor()
    test_probe_and_appear_preserved()
    test_no_tools()
    print()
    if _fail:
        print("FAILED: %d" % len(_fail))
        for f in _fail:
            print("  - " + f)
        raise SystemExit(1)
    print("all screen-capture tests passed")
