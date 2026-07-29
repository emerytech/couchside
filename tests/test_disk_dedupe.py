#!/usr/bin/env python3
"""Two paths into one filesystem must produce ONE disk row.

Run: python3 tests/test_disk_dedupe.py

THE BUG (found 2026-07-28 on a real Bazzite box). The DISKS card listed /home
and /var as two rows with byte-identical numbers:

    /home   163.8 / 464.2 GB   36%
    /var    163.8 / 464.2 GB   36%

read_disks() deduped on os.stat().st_dev, and btrfs gives every SUBVOLUME its
own st_dev. MEASURED on the box, 10.1.1.60:

    /home  st_dev=49    498GB total, 322GB free
    /var   st_dev=44    498GB total, 322GB free

Same filesystem (/dev/nvme0n1p3), two st_devs, so the guard never fired. /home
is a SYMLINK to var/home on Fedora Atomic derivatives and /var/home is its own
subvolume, which is how the two paths diverge. The card read as ~928GB of
storage on a 464GB disk.

This is not an edge case: Bazzite and SteamOS both default to btrfs with this
layout, so it was the default DISKS card on the project's two primary targets.

The fixture below is COPIED VERBATIM from /proc/self/mountinfo on that box
(CLAUDE.md §6: fixtures for /proc parsing come from real hardware, not from
imagination). The subvol= options and the composefs / line are exactly as the
kernel wrote them.
"""
import importlib.util
import os
import sys
import tempfile

_spec = importlib.util.spec_from_file_location(
    "couchsided",
    os.path.join(os.path.dirname(os.path.abspath(__file__)),
                 "..", "agent", "couchsided.py"))
cs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cs)

FAILURES = []


def check(name, got, want):
    if got == want:
        print("  PASS  %s" % name)
    else:
        print("  FAIL  %s (got %r, want %r)" % (name, got, want))
        FAILURES.append(name)


# VERBATIM from bazzite 10.1.1.60, 2026-07-28.
MOUNTINFO = """\
79 2 0:38 / / ro,relatime shared:1 - overlay composefs ro,seclabel,lowerdir+=/run/ostree/.private/cfsroot-lower,datadir+=/sysroot/ostree/repo/objects,redirect_dir=on,metacopy=on
52 79 0:34 /var /var rw,noatime shared:112 - btrfs /dev/nvme0n1p3 rw,seclabel,ssd,discard=async,space_cache=v2,subvolid=256,subvol=/var
56 79 259:2 / /boot rw,relatime shared:116 - ext4 /dev/nvme0n1p2 rw,seclabel
64 52 0:34 /home /var/home rw,noatime shared:124 - btrfs /dev/nvme0n1p3 rw,seclabel,ssd,discard=async,space_cache=v2,subvolid=257,subvol=/home
"""


def main():
    tmp = tempfile.mkdtemp()
    mi = os.path.join(tmp, "mountinfo")
    with open(mi, "w") as f:
        f.write(MOUNTINFO)

    real_open = cs.open if hasattr(cs, "open") else open
    real_realpath = os.path.realpath

    # Redirect only the mountinfo read; leave every other open() alone.
    import builtins
    real_builtins_open = builtins.open

    def fake_open(path, *a, **kw):
        if path == "/proc/self/mountinfo":
            return real_builtins_open(mi, *a, **kw)
        return real_builtins_open(path, *a, **kw)

    # /home is a symlink to var/home on Fedora Atomic; model that exactly.
    def fake_realpath(p):
        return {"/home": "/var/home"}.get(p, p)

    builtins.open = fake_open
    os.path.realpath = fake_realpath
    try:
        print("the btrfs subvolume collision")
        home = cs._mount_fs_key("/home")
        var = cs._mount_fs_key("/var")
        check("/home resolves to the btrfs filesystem", home, "0:34")
        check("/var resolves to the same filesystem", var, "0:34")
        check("/home and /var dedupe to one key", home == var, True)

        # CONTROL: distinct filesystems must NOT be merged. Without this, a key
        # function that returned a constant would pass everything above and the
        # card would show a single row for a box with real separate disks.
        check("/ (composefs) stays distinct", cs._mount_fs_key("/"), "0:38")
        check("/boot (ext4) stays distinct", cs._mount_fs_key("/boot"), "259:2")
        check("/ and /boot are not merged",
              cs._mount_fs_key("/") != cs._mount_fs_key("/boot"), True)

        # Longest-prefix wins: /var/home must key to its own entry, not /var's
        # parent line. Both are 0:34 here, so assert the resolution directly.
        check("a path inside /var/home resolves, not to / ",
              cs._mount_fs_key("/var/home"), "0:34")

        print()
        print("degrade closed")
    finally:
        builtins.open = real_builtins_open
        os.path.realpath = real_realpath

    # Unreadable mountinfo -> None, so the caller falls back to st_dev rather
    # than merging rows it cannot prove are the same filesystem (§3.7).
    def broken_open(path, *a, **kw):
        if path == "/proc/self/mountinfo":
            raise OSError("boom")
        return real_builtins_open(path, *a, **kw)

    builtins.open = broken_open
    try:
        check("unreadable mountinfo -> None (never a false merge)",
              cs._mount_fs_key("/home"), None)
    finally:
        builtins.open = real_builtins_open

    import shutil
    shutil.rmtree(tmp, ignore_errors=True)

    print()
    if FAILURES:
        print("FAILED: %s" % ", ".join(FAILURES))
        return 1
    print("all disk-dedupe tests passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
