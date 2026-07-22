#!/usr/bin/env python3
"""Tests for stop_running_game() — closing the game from the phone.

Run: python3 tests/test_game_stop.py

THE SECURITY SHAPE IS THE FEATURE. This function takes NO ARGUMENT: the caller
cannot name a pid, an appid, or anything else. The agent re-resolves the target
itself at the moment of the call, so a client that cannot name a process cannot
be steered into killing one. Accepting a pid "to be explicit" would turn a
close-my-game button into a remote kill-anything primitive.

The first test asserts that signature directly, because a future refactor that
"helpfully" adds a pid parameter is exactly how this becomes a hole, and it
would look like a convenience at review time.
"""
import importlib.util
import os
import signal
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


class Killed:
    """Capture what would have been signalled, instead of signalling."""

    def __init__(self, game, exc=None):
        self.sent = []
        self._game, self._exc = game, exc
        self._old_kill, self._old_running = os.kill, cs._running_game

    def __enter__(self):
        outer = self

        def fake_kill(pid, sig):
            outer.sent.append((pid, sig))
            if outer._exc:
                raise outer._exc
        os.kill = fake_kill
        cs._running_game = lambda: outer._game
        return self

    def __exit__(self, *a):
        os.kill, cs._running_game = self._old_kill, self._old_running


def test_takes_no_argument():
    """THE test. If this ever accepts a pid, the button becomes a remote
    kill-anything primitive (CLAUDE.md 3.1)."""
    print("test_takes_no_argument")
    check("zero parameters", cs.stop_running_game.__code__.co_argcount, 0)


def test_sends_sigterm_to_the_resolved_pid():
    """SIGTERM, never SIGKILL: Steam's reaper forwards it so the game saves."""
    print("test_sends_sigterm_to_the_resolved_pid")
    game = {"appid": 570, "label": "Dota 2", "pid": 4242}
    with Killed(game) as k:
        res = cs.stop_running_game()
        check("stopped", res.get("stopped"), True)
        check("one signal", len(k.sent), 1)
        check("to the resolved pid", k.sent[0][0], 4242)
        check("SIGTERM not SIGKILL", k.sent[0][1], signal.SIGTERM)


def test_nothing_running_signals_nothing():
    """Degrade closed: no game must not become a sweep of anything
    game-shaped."""
    print("test_nothing_running_signals_nothing")
    with Killed(None) as k:
        res = cs.stop_running_game()
        check("not stopped", res.get("stopped"), False)
        check("signalled nothing", len(k.sent), 0)


def test_game_without_a_pid_signals_nothing():
    """An older detector, or a race, can yield a game with no pid. That must
    not fall through to signalling something arbitrary."""
    print("test_game_without_a_pid_signals_nothing")
    with Killed({"appid": 570, "label": "Dota 2"}) as k:
        res = cs.stop_running_game()
        check("not stopped", res.get("stopped"), False)
        check("signalled nothing", len(k.sent), 0)


def test_already_exited_reads_as_success():
    """It exited between resolve and signal. That is what the caller wanted."""
    print("test_already_exited_reads_as_success")
    with Killed({"appid": 570, "pid": 99}, exc=ProcessLookupError()):
        res = cs.stop_running_game()
        check("stopped", res.get("stopped"), True)
        check("noted", res.get("note"), "already exited")


def test_permission_denied_is_reported_not_raised():
    """A pid we may not signal must be an answer, not a traceback."""
    print("test_permission_denied_is_reported_not_raised")
    with Killed({"appid": 570, "pid": 1}, exc=PermissionError()):
        res = cs.stop_running_game()
        check("not stopped", res.get("stopped"), False)
        check("reason", res.get("reason"), "not permitted")


def test_uptime_parses_a_comm_containing_spaces_and_parens():
    """/proc/<pid>/stat's comm field can contain ') (' — splitting the whole
    line puts the fields out by however many spaces the name has, which would
    silently report a nonsense runtime."""
    print("test_uptime_parses_a_comm_containing_spaces_and_parens")
    import tempfile
    d = tempfile.mkdtemp(prefix="proc-")
    os.makedirs(os.path.join(d, "1234"))
    # Real shape: pid (comm) state ppid ... field 22 is starttime.
    # The remaining line starts at STATE, so index 19 of what the parser sees
    # is fields[18] here -- the leading "S" occupies slot 0. Getting this wrong
    # is precisely the off-by-one the parser has to avoid.
    fields = ["0"] * 50
    fields[18] = "6000"
    with open(os.path.join(d, "1234", "stat"), "w") as f:
        f.write("1234 (My Game (x86) :) S " + " ".join(fields) + "\n")
    with open(os.path.join(d, "uptime"), "w") as f:
        f.write("1000.0 900.0\n")

    real_open = open

    def fake_open(path, *a, **kw):
        if path == "/proc/1234/stat":
            return real_open(os.path.join(d, "1234", "stat"), *a, **kw)
        if path == "/proc/uptime":
            return real_open(os.path.join(d, "uptime"), *a, **kw)
        return real_open(path, *a, **kw)

    import builtins
    builtins.open = fake_open
    try:
        hz = os.sysconf("SC_CLK_TCK") or 100
        want = int(1000.0 - 6000 / float(hz))
        check("runtime from field 22", cs._proc_uptime_s(1234), want)
    finally:
        builtins.open = real_open
        import shutil as _sh
        _sh.rmtree(d, ignore_errors=True)


if __name__ == "__main__":
    for fn in (test_takes_no_argument,
               test_sends_sigterm_to_the_resolved_pid,
               test_nothing_running_signals_nothing,
               test_game_without_a_pid_signals_nothing,
               test_already_exited_reads_as_success,
               test_permission_denied_is_reported_not_raised,
               test_uptime_parses_a_comm_containing_spaces_and_parens):
        fn()
    if FAILURES:
        print("\n%d FAILED: %s" % (len(FAILURES), ", ".join(FAILURES)))
        sys.exit(1)
    print("\nall good")
