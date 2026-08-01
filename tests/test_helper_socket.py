#!/usr/bin/env python3
"""The helper's SOCKET gate: SO_PEERCRED decides, and it fails closed.

Run: python3 tests/test_helper_socket.py

LINUX ONLY, and it says so rather than passing vacuously. SO_PEERCRED does not
exist on macOS, so a developer machine cannot exercise this at all — same
situation as the /proc parsers, and the same rule applies: **check CI before
releasing**, because a green run on a Mac has not tested any of this.

The dispatch-level tests in test_privileged_helper.py prove the verb table
refuses bad input. This file proves an unauthorized CALLER never reaches the
verb table in the first place.
"""
import importlib.util
import json
import os
import platform
import socket
import sys
import tempfile
import threading

if platform.system() != "Linux":
    print("SKIP: SO_PEERCRED is Linux-only; this suite is meaningless on %s."
          % platform.system())
    print("      It runs for real in CI (ubuntu-latest). Do not read a local")
    print("      pass as evidence — there was nothing to pass.")
    sys.exit(0)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location(
    "couchside_helper", os.path.join(ROOT, "agent", "couchside-helper.py"))
H = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(H)

FAILURES = []
SPAWNS = []
H._run = lambda argv, timeout=25: (SPAWNS.append(list(argv)) or (True, "ok"))


def check(name, got, want):
    if got == want:
        print("  PASS  %s" % name)
    else:
        print("  FAIL  %s (got %r, want %r)" % (name, got, want))
        FAILURES.append(name)


d = tempfile.mkdtemp()
path = os.path.join(d, "helper.sock")
srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
srv.bind(path)
srv.listen(8)


def _serve(n):
    for _ in range(n):
        conn, _addr = srv.accept()
        H.serve_one(conn)


threading.Thread(target=_serve, args=(6,), daemon=True).start()


def call(req):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.connect(path)
    s.sendall(json.dumps(req).encode() + b"\n")
    data = b""
    while b"\n" not in data:
        chunk = s.recv(4096)
        if not chunk:
            break
        data += chunk
    s.close()
    return json.loads(data.decode().split("\n")[0])


print("an unauthorized caller never reaches the verb table")

# Never configured. "Unknown" must mean refuse, not "allow anybody".
H.ALLOWED_UID = None
SPAWNS.clear()
r = call({"verb": "power", "arg": "reboot"})
check("unconfigured ALLOWED_UID refuses", r.get("error"), "not authorized")
check("...and nothing ran", SPAWNS, [])

# A different uid.
H.ALLOWED_UID = os.getuid() + 12345
SPAWNS.clear()
r = call({"verb": "power", "arg": "reboot"})
check("a uid that is not ours is refused", r.get("error"), "not authorized")
check("...and nothing ran", SPAWNS, [])

# The refusal must come BEFORE parsing, so even a malformed body is rejected
# as unauthorized rather than being decoded first.
SPAWNS.clear()
r = call({"verb": "session.clear-boot"})
check("refusal applies to every verb, not just power",
      r.get("error"), "not authorized")
check("...and nothing ran", SPAWNS, [])

print()
print("the authorized caller does get through")
H.ALLOWED_UID = os.getuid()
SPAWNS.clear()
r = call({"verb": "power", "arg": "reboot"})
check("matching uid is allowed", r.get("ok"), True)
check("...and ran exactly the allowlisted argv",
      SPAWNS, [["/usr/bin/systemctl", "reboot"]])

# Authorized, but still subject to the verb table.
SPAWNS.clear()
r = call({"verb": "power", "arg": "halt"})
check("an authorized caller STILL cannot invent an argument", r.get("ok"), False)
check("...and nothing ran", SPAWNS, [])

print()
if FAILURES:
    print("FAILED: %s" % ", ".join(FAILURES))
    sys.exit(1)
print("all helper socket tests passed")
