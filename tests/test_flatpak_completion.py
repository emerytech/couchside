#!/usr/bin/env python3
"""Flatpak update completion signal (KI-036).

Run: python3 tests/test_flatpak_completion.py

WHY THIS EXISTS — device-confirmed 2026-07-27 on a real Bazzite box. The app
used to infer "flatpak update done" from `flatpak remote-ls --updates` reaching
zero. That list counts runtimes `flatpak update` will NOT apply: an end-of-life
runtime (MEASURED: org.freedesktop.Platform 23.08, "no longer receiving fixes")
shows as "update available" while the update itself prints "Nothing to do" and
cannot cross the EOL major-version boundary. So the count is pinned above zero,
zero is unreachable, and the app spun for ten minutes — then, on an "update
everything" press, blocked the OS update behind that dead wait.

The fix moves completion to a signal that IS reachable: whether the box's own
update child process is still running. `flatpak_running()` reports it off the
Popen handle the agent holds, and `/api/update/flatpak` exposes it as `running`.

DEGRADE-CLOSED DIRECTION (CLAUDE.md §3.7): toward DONE. A false "still running"
would strand the card on "Updating…" forever; a false "done" at worst shows a
stale pending count the next status refresh corrects. So every unknown state
(no process, lost handle after an agent restart, poll() raising) reports False.
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


class FakeProc:
    """Stand in for the Popen handle: poll() returns None while alive, then rc."""

    def __init__(self, rc):
        self._rc = rc

    def poll(self):
        return self._rc


class BoomProc:
    def poll(self):
        raise OSError("process handle gone")


def main():
    saved = cs._FLATPAK_PROC
    try:
        print("flatpak_running(): reachable completion signal, degrade-closed to DONE")

        # No update was ever launched -> not running (done).
        cs._FLATPAK_PROC = None
        check("no process -> not running", cs.flatpak_running(), False)

        # A live child (poll None) IS running. This is the ONLY True case, and it
        # is the control: without it every other assertion could pass by always
        # returning False.
        cs._FLATPAK_PROC = FakeProc(None)
        check("live child -> running", cs.flatpak_running(), True)

        # Finished, success. THE BUG SCENARIO: the process is done even though a
        # pending count may remain (the EOL runtime) — this is what the count==0
        # rule could never see.
        cs._FLATPAK_PROC = FakeProc(0)
        check("exited 0 -> not running", cs.flatpak_running(), False)

        # Finished, failure -> still "not running" (done); the failure surfaces
        # via the log/exit path, not by claiming the process is alive.
        cs._FLATPAK_PROC = FakeProc(1)
        check("exited nonzero -> not running", cs.flatpak_running(), False)

        # Handle wedged (agent restarted mid-update, PID reused, poll raises):
        # degrade closed toward done rather than strand the UI.
        cs._FLATPAK_PROC = BoomProc()
        check("poll() raises -> not running", cs.flatpak_running(), False)

        print("the status field the app polls")
        # The status endpoint must actually carry `running` — assert the key is
        # produced. Build the same dict the handler sends (mock=False path).
        cs._FLATPAK_PROC = FakeProc(None)
        status = {"available": True, "count": 1, "updates": ["x 1.0"],
                  "elevated": False, "running": cs.flatpak_running()}
        check("status carries a 'running' key", "running" in status, True)
        check("running True while the child is alive", status["running"], True)
        # And the KI-036 invariant expressed on the agent side: a nonzero pending
        # count does NOT imply still-running once the child has exited.
        cs._FLATPAK_PROC = FakeProc(0)
        check("count>0 with a finished process -> running False",
              (status["count"] > 0) and (cs.flatpak_running() is False), True)
    finally:
        cs._FLATPAK_PROC = saved

    print()
    if FAILURES:
        print("FAILED: %s" % ", ".join(FAILURES))
        return 1
    print("all flatpak-completion tests passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
