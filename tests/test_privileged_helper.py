#!/usr/bin/env python3
"""The privileged helper's refusal surface.

Run: python3 tests/test_privileged_helper.py

This is root-side code reachable from a process on the box, so the tests that
matter are the ones proving it says NO. Per CLAUDE.md §6, anything taking a
client id owes a test that a non-allowlisted id is refused AND that nothing
runs — so every refusal case below asserts on a spawn counter, not just on the
return value. A handler that returned "error" while still having shelled out
would pass a naive test and fail this one.
"""
import importlib.util
import json
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location(
    "couchside_helper", os.path.join(ROOT, "agent", "couchside-helper.py"))
H = importlib.util.module_from_spec(_spec)
sys.modules["couchside_helper"] = H
_spec.loader.exec_module(H)

FAILURES = []
SPAWNS = []


def check(name, got, want):
    if got == want:
        print("  PASS  %s" % name)
    else:
        print("  FAIL  %s (got %r, want %r)" % (name, got, want))
        FAILURES.append(name)


def fake_run(argv, timeout=25):
    """Record instead of spawning. Every refusal test asserts this stays empty."""
    SPAWNS.append(list(argv))
    return True, "fake-ok"


H._run = fake_run


print("the verb table refuses what is not in it")
for bad in ("", "nope", "session.set-bootx", "SESSION.SET-BOOT", "power;reboot",
            "../../bin/sh", "update.os ", None, 42, {"a": 1}):
    SPAWNS.clear()
    r = H.dispatch({"verb": bad})
    ok = (r.get("ok") is False and r.get("error") == "unknown verb"
          and SPAWNS == [])
    if not ok:
        check("unknown verb %r refused and nothing ran" % (bad,), r, "refusal")
print("  PASS  every unknown verb refused, zero spawns")

print()
print("a KNOWN verb still refuses an argument outside its closed set")
for verb, bad in (
        ("power", "halt"), ("power", "reboot; rm -rf /"), ("power", ""),
        ("power", None), ("power", ["reboot"]),
        # Mode words were v1's argument; the rework moved mode->file selection
        # into the agent, so bare words must be REFUSED at the shape gate.
        ("session.set-boot", "game"), ("session.set-boot", "desktop"),
        ("session.set-boot", "GAME"), ("session.set-boot", None),
        ("session.set-boot", "../evil.desktop"),
        ("session.set-boot", "a/b.desktop"),
        ("session.set-boot", ".hidden.desktop"),
        ("unit.restart", "sshd"), ("unit.restart", "couchside.service"),
        ("unit.restart", "plugin_loader; id"),
):
    SPAWNS.clear()
    r = H.dispatch({"verb": verb, "arg": bad})
    if not (r.get("ok") is False and SPAWNS == []):
        check("%s(%r) refused with no spawn" % (verb, bad), r, "refusal")
print("  PASS  every out-of-set argument refused, zero spawns")

print()
print("the allowlisted arguments DO run — and run the right argv")
SPAWNS.clear()
H.dispatch({"verb": "power", "arg": "reboot"})
check("power reboot spawns systemctl reboot",
      SPAWNS, [["/usr/bin/systemctl", "reboot"]])

SPAWNS.clear()
H.dispatch({"verb": "unit.restart", "arg": "couchside"})
check("couchside restart keeps --no-block",
      SPAWNS, [["/usr/bin/systemctl", "restart", "--no-block",
                "couchside.service"]])

SPAWNS.clear()
H.dispatch({"verb": "unit.restart", "arg": "plugin_loader"})
check("plugin_loader restart argv",
      SPAWNS, [["/usr/bin/systemctl", "restart", "plugin_loader"]])

print()
print("journal: shape-validated, and the option set is ours")
SPAWNS.clear()
r = H.dispatch({"verb": "logs.journal", "arg": {"unit": "couchside.service"}})
check("a real unit runs", SPAWNS and SPAWNS[0][:3],
      ["/usr/bin/journalctl", "-u", "couchside.service"])
check("...with --no-pager", "--no-pager" in SPAWNS[0], True)

for bad in ("couchside", "../../etc/shadow", "a b.service", "x.service;id",
            "--file=/etc/shadow", "", None, 5):
    SPAWNS.clear()
    r = H.dispatch({"verb": "logs.journal", "arg": {"unit": bad}})
    if not (r.get("ok") is False and SPAWNS == []):
        check("journal unit %r refused" % (bad,), r, "refusal")
print("  PASS  every malformed unit refused, zero spawns")

# THE POINT of granting a wrapper rather than journalctl itself: no caller can
# reach --file / --directory, which would be arbitrary root file read.
SPAWNS.clear()
H.dispatch({"verb": "logs.journal",
            "arg": {"unit": "couchside.service", "lines": 10**9}})
check("line count clamped to 2000", "2000" in SPAWNS[0], True)
SPAWNS.clear()
H.dispatch({"verb": "logs.journal",
            "arg": {"unit": "couchside.service", "lines": "nonsense"}})
check("non-numeric line count falls back, still runs", len(SPAWNS), 1)
check("no --file reaches journalctl",
      any(a.startswith("--file") or a.startswith("--directory")
          for a in SPAWNS[0]), False)

print()
print("malformed envelopes never reach a handler")
for req in (None, [], "power", 7, {"arg": "reboot"}, {}):
    SPAWNS.clear()
    r = H.dispatch(req)
    if not (r.get("ok") is False and SPAWNS == []):
        check("envelope %r refused" % (req,), r, "refusal")
print("  PASS  every malformed envelope refused, zero spawns")

print()
print("display-manager detection degrades CLOSED")
saved_link = H._DM_UNIT_LINK
try:
    H._DM_UNIT_LINK = "/nonexistent-couchside-test/display-manager.service"
    check("no link -> None", H.detect_display_manager(), None)
    SPAWNS.clear()
    r = H.dispatch({"verb": "session.set-boot", "arg": "game"})
    check("set-boot refuses with no DM", r.get("ok"), False)
    check("...and nothing ran", SPAWNS, [])
    r = H.dispatch({"verb": "dm.restart"})
    check("dm.restart refuses with no DM", r.get("ok"), False)
    check("...and nothing ran", SPAWNS, [])
finally:
    H._DM_UNIT_LINK = saved_link

print()
print("SDDM's main conf OVERRIDES drop-ins — refuse rather than write a file")
print("that will be silently ignored (the trap that made v1 fail open)")
d = tempfile.mkdtemp()
main_conf = os.path.join(d, "sddm.conf")
with open(main_conf, "w") as f:
    f.write("[Autologin]\nSession=plasma.desktop\n")
saved_main, saved_dirs = dict(H._DM_MAIN_CONFS), dict(H._DM_CONF_DIRS)
saved_detect = H.detect_display_manager
try:
    H._DM_MAIN_CONFS["sddm"] = main_conf
    H._DM_CONF_DIRS["sddm"] = os.path.join(d, "sddm.conf.d")
    H.detect_display_manager = lambda: "sddm"
    # A fake session dir stands in for /usr/share/wayland-sessions with the two
    # files a real box carries. The validator is a listdir membership check, so
    # this drives the REAL code path rather than stubbing it out.
    sess_dir = os.path.join(d, "wayland-sessions")
    os.makedirs(sess_dir)
    for f_ in ("plasma.desktop", "gamescope-session.desktop"):
        with open(os.path.join(sess_dir, f_), "w") as fh:
            fh.write("[Desktop Entry]\n")
    saved_sess = H._SESSION_DIRS
    H._SESSION_DIRS = (sess_dir,)
    r = H.dispatch({"verb": "session.set-boot", "arg": "gamescope-session.desktop"})
    check("refused when the main conf names a Session", r.get("ok"), False)
    check("...and no drop-in was written",
          os.path.exists(os.path.join(d, "sddm.conf.d", H._DROPIN_NAME)), False)

    # With the main conf silent, the write is allowed and lands in the right file.
    with open(main_conf, "w") as f:
        f.write("[General]\n")
    r = H.dispatch({"verb": "session.set-boot", "arg": "plasma.desktop"})
    check("allowed when the main conf is silent", r.get("ok"), True)
    body = open(os.path.join(d, "sddm.conf.d", H._DROPIN_NAME)).read()
    check("drop-in names the desktop session", "plasma.desktop" in body, True)
    # The stranding rule survives the transport: a session the box does not
    # have refuses even with the main conf silent.
    r = H.dispatch({"verb": "session.set-boot", "arg": "plasmax11.desktop"})
    check("a session missing from the box refuses (the stranding rule)",
          r.get("ok"), False)
    check("drop-in is the zzz- name (sorts after zz-steamos-autologin)",
          H._DROPIN_NAME.startswith("zzz-"), True)

    # clear-boot removes it, and clearing twice is success both times.
    r = H.dispatch({"verb": "session.clear-boot"})
    check("clear removes the drop-in",
          os.path.exists(os.path.join(d, "sddm.conf.d", H._DROPIN_NAME)), False)
    r2 = H.dispatch({"verb": "session.clear-boot"})
    check("clearing again is still ok", r2.get("ok"), True)
finally:
    H._DM_MAIN_CONFS.clear(); H._DM_MAIN_CONFS.update(saved_main)
    H._DM_CONF_DIRS.clear(); H._DM_CONF_DIRS.update(saved_dirs)
    H.detect_display_manager = saved_detect
    H._SESSION_DIRS = saved_sess

print()
print("gdm3 vs gdm: the FAMILY is collapsed, the real unit name is not")
saved_unit = H._dm_unit_name
try:
    H._dm_unit_name = lambda: "gdm3"
    check("gdm3 -> family gdm", H.detect_display_manager(), "gdm")
    SPAWNS.clear()
    H.dispatch({"verb": "dm.restart"})
    check("dm.restart uses the REAL unit name, not the family",
          SPAWNS, [["/usr/bin/systemctl", "restart", "gdm3"]])
    # gdm is recognised but we do not write its autologin config.
    H.detect_display_manager_saved = H.detect_display_manager
    r = H.dispatch({"verb": "session.set-boot", "arg": "gamescope-session.desktop"})
    check("set-boot refuses on gdm rather than guessing", r.get("ok"), False)
finally:
    H._dm_unit_name = saved_unit

print()
print("no verb accepts a path, a unit name, or a command from the caller")
# Structural: every validator either takes no argument, or maps into a closed
# set, or (journal) validates by shape and builds the argv itself.
for verb, (handler, validate) in H.VERBS.items():
    if validate is None:
        continue
    if verb == "logs.journal":
        continue
    for probe in ("/etc/shadow", "sh", "systemctl", "reboot ", " reboot"):
        if validate(probe) is not None and probe not in (
                H._POWER_ACTIONS + tuple(H._RESTARTABLE)):
            check("%s must not accept %r" % (verb, probe), probe, "rejected")
print("  PASS  no closed-set verb accepts a path or a bare binary name")

print()
print("the verb table is small enough to audit")
check("eight verbs, no more", len(H.VERBS), 8)

print()
if FAILURES:
    print("FAILED: %s" % ", ".join(FAILURES))
    sys.exit(1)
print("all privileged-helper tests passed")
