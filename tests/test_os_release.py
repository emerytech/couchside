#!/usr/bin/env python3
"""What the Console header says the box is running.

Run: python3 tests/test_os_release.py

Every fixture below is VERBATIM from a real box (CLAUDE.md §6). The point of
the test is that the SHAPE differs by distro and the reader must not assume one
of them:

    Bazzite   PRETTY_NAME="Bazzite"  VERSION_ID=43  BUILD_ID="Stable (F43...)"
    CachyOS   PRETTY_NAME="CachyOS"  BUILD_ID=rolling      (NO VERSION_ID)

A rolling release has no VERSION_ID at all, so a reader that only looks there
shows a nameless blank on CachyOS; one that only looks at BUILD_ID loses
Bazzite's clean "43". Both are sent, and absence is always omission — never a
null the app has to special-case.
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


BAZZITE = '''NAME="Bazzite"
VERSION="43.20260420 (Forty Three)"
ID=bazzite
ID_LIKE="fedora"
VERSION_ID=43
PRETTY_NAME="Bazzite"
BUILD_ID="Stable (F43.20260420)"
HOME_URL="https://bazzite.gg"
'''

CACHYOS = '''NAME="CachyOS Linux"
PRETTY_NAME="CachyOS"
ID=cachyos
ID_LIKE=arch
BUILD_ID=rolling
ANSI_COLOR="38;2;23;147;209"
HOME_URL="https://cachyos.org/"
'''

# SteamOS ships a VERSION_ID and a build; the Deck is the reference handheld.
STEAMOS = '''NAME="SteamOS"
PRETTY_NAME="SteamOS"
ID=steamos
ID_LIKE=arch
VERSION_ID=3.8.21
BUILD_ID=20260318.1
'''


def read_with(text):
    d = tempfile.mkdtemp()
    p = os.path.join(d, "os-release")
    with open(p, "w") as f:
        f.write(text)
    saved = cs._OS_RELEASE
    try:
        cs._OS_RELEASE = p
        return cs.read_os_release()
    finally:
        cs._OS_RELEASE = saved


print("real fixtures, three distro shapes")
b = read_with(BAZZITE)
check("bazzite name", b.get("name"), "Bazzite")
check("bazzite version prefers VERSION_ID", b.get("version"), "43")
check("bazzite keeps the build string too", b.get("build"), "Stable (F43.20260420)")

c = read_with(CACHYOS)
check("cachyos name", c.get("name"), "CachyOS")
# THE TRAP: no VERSION_ID at all. A VERSION_ID-only reader shows nothing here.
check("cachyos falls back to BUILD_ID", c.get("version"), "rolling")
check("...and does not duplicate it into build", "build" in c, False)

s = read_with(STEAMOS)
check("steamos name", s.get("name"), "SteamOS")
check("steamos version", s.get("version"), "3.8.21")
check("steamos build", s.get("build"), "20260318.1")

print()
print("kernel comes from uname, not the file")
check("kernel present", bool(b.get("kernel")), True)

print()
print("degrades to omission, never to a null")
missing = read_with("")  # empty file: nothing to report but uname
check("no name key when the file says nothing", "name" in missing, False)
check("no version key either", "version" in missing, False)
saved = cs._OS_RELEASE
try:
    cs._OS_RELEASE = "/nonexistent-couchside-test/os-release"
    gone = cs.read_os_release()
    check("unreadable file -> no name", "name" in gone, False)
finally:
    cs._OS_RELEASE = saved

print()
print("quoting is stripped (values arrive quoted on every real distro)")
q = read_with('PRETTY_NAME="Quoted Name"\nVERSION_ID=\'7\'\n')
check("double quotes stripped", q.get("name"), "Quoted Name")
check("single quotes stripped", q.get("version"), "7")

print()
if FAILURES:
    print("FAILED: %s" % ", ".join(FAILURES))
    sys.exit(1)
print("all os-release tests passed")
