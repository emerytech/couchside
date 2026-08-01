#!/usr/bin/env python3
"""The agent-side helper shim: helper first, sudo fallback, refusals are final.

Run: python3 tests/test_helper_shim.py

The spec (project_privileged-helper.md §7) names three behaviours and this file
pins all of them:

  1. helper PRESENT  -> used, and the sudo path is NOT touched
  2. helper ABSENT   -> the sudo fallback runs, unchanged
  3. helper REFUSES  -> the refusal is final; sudo is NOT tried as a second ask

(3) is the one a lazy shim gets wrong. A helper refusal means root-side
validation said no; falling back to sudo would re-ask the same question through
the exact surface the helper exists to retire, and would turn every refusal
into a bypass attempt.
"""
import importlib.util
import json
import os
import socket
import sys
import tempfile
import threading

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location(
    "couchsided", os.path.join(ROOT, "agent", "couchsided.py"))
cs = importlib.util.module_from_spec(_spec)
sys.modules["couchsided"] = cs
_spec.loader.exec_module(cs)

FAILURES = []
SUDO_CALLS = []


def check(name, got, want):
    if got == want:
        print("  PASS  %s" % name)
    else:
        print("  FAIL  %s (got %r, want %r)" % (name, got, want))
        FAILURES.append(name)


class FakeRun:
    """Stands in for subprocess.run on the SUDO path only."""
    def __init__(self):
        self.returncode = 0
        self.stdout = ""
        self.stderr = ""


def fake_subprocess_run(argv, **kw):
    SUDO_CALLS.append(list(argv))
    return FakeRun()


cs.subprocess.run = fake_subprocess_run


def fake_helper(replies):
    """A one-shot helper: serves len(replies) connections then stops. Returns
    the socket path and a list that accumulates the requests it saw."""
    d = tempfile.mkdtemp()
    path = os.path.join(d, "helper.sock")
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(path)
    srv.listen(4)
    seen = []

    def serve():
        for reply in replies:
            conn, _ = srv.accept()
            buf = b""
            while b"\n" not in buf:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                buf += chunk
            try:
                seen.append(json.loads(buf.split(b"\n", 1)[0].decode()))
            except ValueError:
                seen.append(None)
            conn.sendall(json.dumps(reply).encode() + b"\n")
            conn.close()

    threading.Thread(target=serve, daemon=True).start()
    return path, seen


# _dm_write needs its guards satisfied: a writable-looking dm, a session that
# counts as installed, and a silent main conf.
saved = {
    "installed": cs._installed_session_files,
    "main": dict(cs._DM_MAIN_CONFS),
    "socket": cs.HELPER_SOCKET,
    "neutralise": cs._dm_neutralise_legacy,
}
cs._installed_session_files = lambda: {"plasma.desktop",
                                       "gamescope-session.desktop"}
cs._DM_MAIN_CONFS = {"sddm": "/nonexistent-couchside-test/sddm.conf",
                     "plasmalogin": "/nonexistent-couchside-test/pl.conf"}
cs._dm_neutralise_legacy = lambda dm: None

try:
    print("1. helper PRESENT -> used; sudo untouched")
    path, seen = fake_helper([{"ok": True, "detail": "written"}])
    cs.HELPER_SOCKET = path
    SUDO_CALLS.clear()
    ok = cs._dm_write("sddm", "plasma.desktop")
    check("write succeeds through the helper", ok, True)
    check("helper saw the verb", seen[0].get("verb"), "session.set-boot")
    check("helper saw the session file", seen[0].get("arg"), "plasma.desktop")
    check("sudo was NOT called", SUDO_CALLS, [])

    print()
    print("2. helper ABSENT -> sudo fallback, unchanged")
    cs.HELPER_SOCKET = "/nonexistent-couchside-test/helper.sock"
    SUDO_CALLS.clear()
    ok = cs._dm_write("sddm", "plasma.desktop")
    check("write succeeds via sudo", ok, True)
    check("exactly one sudo call", len(SUDO_CALLS), 1)
    check("...and it is the fixed-path tee",
          SUDO_CALLS[0][:3], ["sudo", "-n", "tee"])

    print()
    print("3. helper REFUSES -> final; sudo NOT tried as a second ask")
    path, seen = fake_helper([{"ok": False,
                               "detail": "session 'x' is not installed"}])
    cs.HELPER_SOCKET = path
    SUDO_CALLS.clear()
    ok = cs._dm_write("sddm", "plasma.desktop")
    check("the refusal is returned", ok, False)
    check("sudo was NOT tried afterwards", SUDO_CALLS, [])

    print()
    print("4. disarm: same three behaviours through clear-boot")
    # Present:
    path, seen = fake_helper([{"ok": True, "detail": "cleared"}])
    cs.HELPER_SOCKET = path
    SUDO_CALLS.clear()
    # _dm_disarm returns early unless the drop-in exists with a Session= line,
    # so point the dropin resolver at a real file for this test.
    d = tempfile.mkdtemp()
    dropin = os.path.join(d, "zzz-couchside-session.conf")
    with open(dropin, "w") as f:
        f.write("[Autologin]\nSession=plasma.desktop\n")
    saved_dropin = cs._dm_dropin
    cs._dm_dropin = lambda dm: dropin
    try:
        ok = cs._dm_disarm("sddm")
        check("disarm via helper", ok, True)
        check("helper saw clear-boot", seen[0].get("verb"), "session.clear-boot")
        check("sudo untouched", SUDO_CALLS, [])

        # Absent:
        with open(dropin, "w") as f:
            f.write("[Autologin]\nSession=plasma.desktop\n")
        cs.HELPER_SOCKET = "/nonexistent-couchside-test/helper.sock"
        SUDO_CALLS.clear()
        ok = cs._dm_disarm("sddm")
        check("disarm via sudo when absent", ok, True)
        check("the sudo call is the blanking tee",
              SUDO_CALLS and SUDO_CALLS[0][:3], ["sudo", "-n", "tee"])
    finally:
        cs._dm_dropin = saved_dropin

    print()
    print("5. a dead socket FILE is 'absent', not an error")
    # The stale-socket lesson from screen capture (2.9.56): a file that exists
    # but has no listener must mean fallback, never a hang or a crash.
    d = tempfile.mkdtemp()
    stale = os.path.join(d, "helper.sock")
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.bind(stale)
    s.close()  # bound then closed: the path exists, nothing listens
    cs.HELPER_SOCKET = stale
    SUDO_CALLS.clear()
    ok = cs._dm_write("sddm", "plasma.desktop")
    check("falls back to sudo on a dead socket", ok, True)
    check("exactly one sudo call", len(SUDO_CALLS), 1)

finally:
    cs._installed_session_files = saved["installed"]
    cs._DM_MAIN_CONFS = saved["main"]
    cs.HELPER_SOCKET = saved["socket"]
    cs._dm_neutralise_legacy = saved["neutralise"]

print()
if FAILURES:
    print("FAILED: %s" % ", ".join(FAILURES))
    sys.exit(1)
print("all helper-shim tests passed")
