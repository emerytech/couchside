#!/usr/bin/env python3
"""Tests for _unreadable_reason() — why a controller cannot be read.

Run: python3 tests/test_guide_unreadable_reason.py

WHY THIS EXISTS: the app told every user with an unreadable controller to
"re-run install.sh". On a Lenovo Legion Go S that advice cannot work, and
sending someone to do something that cannot work is worse than saying nothing.

MEASURED on that box, 2026-07-22:

    $ ls -l /dev/input/event2          # the built-in pad
    c---------+ 1 root root
    $ getfacl /dev/input/event2
    user:deck:rw-   #effective:---
    mask::---                          <-- nullifies the grant

The ACL entry granting the user is present and intact. Mode 000 is what kills
it: with a POSIX ACL present the group bits ARE the mask, so mode 000 collapses
the mask and every named-user entry becomes ineffective. `inputplumber` was
active and Steam ships its own input rules; masking a source device and
presenting a composite is what that stack does deliberately.

install.sh adds udev rules and group membership. NEITHER can override a zeroed
mask. So the two cases need different answers, and this is where they are told
apart.
"""
import importlib.util
import os
import shutil
import stat
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


class Nodes:
    """A fake /dev/input the REAL function stats."""

    def __init__(self):
        self.dir = tempfile.mkdtemp(prefix="devinput-")
        self._old = cs._DEV_INPUT
        cs._DEV_INPUT = self.dir

    def make(self, name, mode):
        p = os.path.join(self.dir, name)
        with open(p, "w") as f:
            f.write("")
        os.chmod(p, mode)
        return p

    def close(self):
        for f in os.listdir(self.dir):
            try:
                os.chmod(os.path.join(self.dir, f), 0o600)
            except OSError:
                pass
        cs._DEV_INPUT = self._old
        shutil.rmtree(self.dir, ignore_errors=True)


def test_mode_000_is_masked():
    """THE Legion Go S case: deliberately hidden, NOT an install problem."""
    print("test_mode_000_is_masked")
    n = Nodes()
    try:
        n.make("event2", 0o000)
        check("masked", cs._unreadable_reason("event2"), {"reason": "masked"})
    finally:
        n.close()


def test_unreadable_but_normal_mode_is_permission():
    """A real 0660-style node this user is not in the group for IS install-fixable."""
    print("test_unreadable_but_normal_mode_is_permission")
    n = Nodes()
    try:
        n.make("event9", 0o220)      # writable, not readable -> ordinary perms
        check("permission", cs._unreadable_reason("event9"),
              {"reason": "permission"})
    finally:
        n.close()


def test_readable_node_reports_nothing():
    """No reason on a node that works — the field must stay absent, not empty."""
    print("test_readable_node_reports_nothing")
    n = Nodes()
    try:
        n.make("event0", 0o644)
        check("no reason key", cs._unreadable_reason("event0"), {})
    finally:
        n.close()


def test_missing_node_degrades_closed():
    """A node that vanished between enumeration and stat must not raise, and
    must not invent a cause."""
    print("test_missing_node_degrades_closed")
    n = Nodes()
    try:
        check("gone -> no claim", cs._unreadable_reason("event404"), {})
    finally:
        n.close()


if __name__ == "__main__":
    if os.geteuid() == 0:
        # root can read anything, so mode-based unreadability never triggers.
        print("SKIP: running as root makes every node readable")
        sys.exit(0)
    for fn in (test_mode_000_is_masked,
               test_unreadable_but_normal_mode_is_permission,
               test_readable_node_reports_nothing,
               test_missing_node_degrades_closed):
        fn()
    if FAILURES:
        print("\n%d FAILED: %s" % (len(FAILURES), ", ".join(FAILURES)))
        sys.exit(1)
    print("\nall good")
