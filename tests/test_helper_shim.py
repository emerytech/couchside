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


# ---------------------------------------------------------------------------
# 6. decky.loader through _decky_loader_start (agent 2.9.105, helper 1.1.0):
# the same three rules, plus the case the older shims never had to face — a
# helper socket that is PRESENT BUT SILENT.
#
# WHY THE SILENT CASE IS DIFFERENT HERE. Section 5 above pins that _dm_write
# treats a dead socket FILE as "absent" and falls back to sudo; that is safe
# for session.set-boot because the sudo fallback enforces every constraint the
# helper does. The decky shim deliberately does NOT do that: on a helper-only
# box (no sudoers grant was ever written for the decky unit), falling through
# to sudo would answer `needs_optin` and tell the owner to run
# `couchside allow-decky on` for a grant the box never had — a wrong
# instruction. So only a MISSING socket file takes the sudo path; a present
# socket that does not answer (busy helper, crashed helper, stale file) is
# `helper_unreachable, retry:true` and sudo is never spawned.
#
# The capability probe is the verb itself with an argument its validator
# rejects ("probe"): a 1.1.0 helper answers "invalid argument for decky.loader"
# (present), a 1.0.0 helper answers "unknown verb" (outdated -> FINAL, rule 3).
# ---------------------------------------------------------------------------
import time


def silent_helper(hold_s=8.0):
    """A helper that ACCEPTS, reads the request, and never answers — the shape
    of a helper busy in a minutes-long verb or wedged. Returns the socket path
    and the list of requests it swallowed."""
    d = tempfile.mkdtemp()
    path = os.path.join(d, "helper.sock")
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(path)
    srv.listen(4)
    seen = []

    def serve():
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
        time.sleep(hold_s)
        conn.close()

    threading.Thread(target=serve, daemon=True).start()
    return path, seen


DECKY_TMP = tempfile.mkdtemp(prefix="shim-decky-")
DECKY_RUN = os.path.join(DECKY_TMP, "run")
os.makedirs(DECKY_RUN)
decky_saved = {
    "run": cs._DECKY_RUN, "wrapper": cs._DECKY_WRAPPER, "tmpl": cs._DECKY_UNIT_TMPL,
    "marker": cs._DECKY_MARKER, "unit_props": cs._unit_props,
    "sudo_allows": cs._sudo_nopasswd_allows, "socket": cs.HELPER_SOCKET,
}
cs._DECKY_RUN = DECKY_RUN
cs._DECKY_WRAPPER = os.path.join(DECKY_TMP, "couchside-decky-loader")
cs._DECKY_UNIT_TMPL = os.path.join(DECKY_TMP, "couchside-decky-loader@.service")
cs._DECKY_MARKER = os.path.join(DECKY_TMP, "allow-decky")
for path_, body in ((cs._DECKY_WRAPPER, "#!/bin/sh\nexit 0\n"),
                    (cs._DECKY_UNIT_TMPL, "[Service]\nType=oneshot\n"),
                    (cs._DECKY_MARKER, "")):
    with open(path_, "w") as f:
        f.write(body)
os.chmod(cs._DECKY_WRAPPER, 0o755)
# `started` is read back from the unit, not from the exit code; answer
# "activating" so the confirmation returns at once instead of polling 3 s.
cs._unit_props = lambda unit, props: {"ActiveState": "activating"}
# The fake subprocess.run above answers `sudo -n -l` with empty output, which
# the real parser reads as "no grant"; the sudo-path cases below need a grant.
cs._sudo_nopasswd_allows = lambda needle: True
DECKY_SUDO_ARGV = ["sudo", "-n", "/usr/bin/systemctl", "start", "--no-block",
                   "couchside-decky-loader@install.service"]

try:
    print()
    print("6. decky.loader: rule 1 — helper PRESENT -> the verb; sudo untouched")
    cs._decky_invalidate()
    path, seen = fake_helper([{"ok": False, "error": "invalid argument for decky.loader"},
                              {"ok": True, "detail": "fake-ok"}])
    cs.HELPER_SOCKET = path
    SUDO_CALLS.clear()
    r = cs._decky_loader_start("install")
    check("started via the helper", (r.get("started"), r.get("via")), (True, "helper"))
    check("the probe carried the rejected argument 'probe'",
          (seen[0].get("verb"), seen[0].get("arg")), ("decky.loader", "probe"))
    check("the verb carried the enum value", (seen[1].get("verb"), seen[1].get("arg")),
          ("decky.loader", "install"))
    check("sudo was NOT called", SUDO_CALLS, [])

    print()
    print("6. decky.loader: rule 2 — helper ABSENT -> the exact sudo argv")
    cs._decky_invalidate()
    cs.HELPER_SOCKET = "/nonexistent-couchside-test/helper.sock"
    SUDO_CALLS.clear()
    r = cs._decky_loader_start("install")
    check("started via sudo", (r.get("started"), r.get("via")), (True, "sudo"))
    check("exactly one sudo call, the pinned unit start", SUDO_CALLS, [DECKY_SUDO_ARGV])
    check("the wrapper path is not in the argv",
          any(cs._DECKY_WRAPPER in a for a in SUDO_CALLS[0]), False)

    print()
    print("6. decky.loader: rule 3 — helper REFUSES -> final; sudo NOT tried")
    # (a) a 1.0.0 helper: the probe itself is refused as an unknown verb.
    cs._decky_invalidate()
    path, seen = fake_helper([{"ok": False, "error": "unknown verb"}])
    cs.HELPER_SOCKET = path
    SUDO_CALLS.clear()
    r = cs._decky_loader_start("install")
    check("unknown verb -> helper_outdated (final)",
          r, {"started": False, "helper_outdated": True})
    check("sudo was NOT tried afterwards", SUDO_CALLS, [])
    check("only the probe reached the helper", len(seen), 1)
    # (b) a 1.1.0 helper that refuses the verb (marker/wrapper gone under it).
    cs._decky_invalidate()
    path, seen = fake_helper([{"ok": False, "error": "invalid argument for decky.loader"},
                              {"ok": False,
                               "detail": "decky management not enabled (couchside allow-decky on)"}])
    cs.HELPER_SOCKET = path
    SUDO_CALLS.clear()
    r = cs._decky_loader_start("install")
    check("a verb refusal is returned as the answer",
          (r.get("started"), r.get("via"), r.get("detail")),
          (False, "helper", "decky management not enabled (couchside allow-decky on)"))
    check("sudo was NOT tried as a second ask", SUDO_CALLS, [])

    print()
    print("6. decky.loader: socket PRESENT BUT SILENT -> unreachable, never sudo")
    cs._decky_invalidate()
    path, seen = silent_helper()
    cs.HELPER_SOCKET = path
    SUDO_CALLS.clear()
    t0 = time.monotonic()
    r = cs._decky_loader_start("install")
    dt = time.monotonic() - t0
    check("silent helper -> helper_unreachable, retry",
          r, {"started": False, "helper_unreachable": True, "retry": True})
    check("bounded by the 5 s probe timeout (took %.1f s)" % dt, 4.0 <= dt < 9.0, True)
    check("sudo was NOT called", SUDO_CALLS, [])
    check("the helper had swallowed the probe", len(seen), 1)
    # A dead socket FILE: section 5's "absent" for _dm_write is deliberately
    # NOT the decky answer — only a MISSING file is absent here.
    cs._decky_invalidate()
    d = tempfile.mkdtemp()
    stale = os.path.join(d, "helper.sock")
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.bind(stale)
    s.close()
    cs.HELPER_SOCKET = stale
    SUDO_CALLS.clear()
    r = cs._decky_loader_start("install")
    check("dead socket file -> helper_unreachable (not the sudo path)",
          r, {"started": False, "helper_unreachable": True, "retry": True})
    check("sudo was NOT called for a dead socket file", SUDO_CALLS, [])
finally:
    cs._DECKY_RUN = decky_saved["run"]
    cs._DECKY_WRAPPER = decky_saved["wrapper"]
    cs._DECKY_UNIT_TMPL = decky_saved["tmpl"]
    cs._DECKY_MARKER = decky_saved["marker"]
    cs._unit_props = decky_saved["unit_props"]
    cs._sudo_nopasswd_allows = decky_saved["sudo_allows"]
    cs.HELPER_SOCKET = decky_saved["socket"]
    cs._decky_invalidate()

print()
if FAILURES:
    print("FAILED: %s" % ", ".join(FAILURES))
    sys.exit(1)
print("all helper-shim tests passed")
