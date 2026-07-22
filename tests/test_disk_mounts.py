#!/usr/bin/env python3
"""Tests for which filesystems the dashboard reports.

Run: python3 tests/test_disk_mounts.py

The bug this exists to stop: a Steam Deck owner was shown "3.5 / 5.0 GB, 69%"
on a machine with far more space. read_disks() only ever looked at ("/", "/var"),
and on SteamOS "/" is a small READ-ONLY rootfs -- so the dashboard reported a
filesystem the user cannot write to, at a fill level that reads as nearly full,
while their actual storage (/home) was never mentioned at all.

Two rules come out of that, and both are tested here in BOTH directions:
  - a read-only filesystem is not the user's storage, so it is not reported;
  - the same filesystem reached by two paths is reported once, not twice.

The second is not hypothetical either: on a machine with a sealed system volume,
the old code listed "/" and "/var" as two rows with identical numbers.

The environment primitives are stubbed rather than the logic reimplemented, so
the real read_disks() is what runs. Pure stdlib, no pytest.
"""
import importlib.util
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location(
    "couchsided", os.path.join(ROOT, "agent", "couchsided.py"))
cs = importlib.util.module_from_spec(_spec)
sys.modules["couchsided"] = cs
_spec.loader.exec_module(cs)

FAILURES = []
MB = 1024 ** 2
GB = 1024 ** 3


def check(name, got, want):
    if got == want:
        print("  PASS  %s" % name)
    else:
        print("  FAIL  %s (got %r, want %r)" % (name, got, want))
        FAILURES.append(name)


class _Usage:
    def __init__(self, total, used, free=None):
        self.total = total
        self.used = used
        # free defaults to "everything not used", but REAL filesystems reserve
        # blocks an unprivileged user can never touch, so free < total - used.
        # That gap is the whole subject of test_percent_excludes_reserved.
        self.free = total - used if free is None else free


class _Statvfs:
    def __init__(self, ro):
        self.f_flag = os.ST_RDONLY if ro else 0


def _run(layout):
    """Drive the REAL read_disks() against a fake mount table.

    layout: {mount: (total_bytes, used_bytes, device_id, read_only)}
    A mount absent from the layout raises OSError, like a path that isn't there.
    """
    def fake_stat(path):
        if path not in layout:
            raise OSError("no such mount: %s" % path)
        class S:
            st_dev = layout[path][2]
        return S()

    def fake_statvfs(path):
        if path not in layout:
            raise OSError("no such mount: %s" % path)
        return _Statvfs(layout[path][3])

    def fake_usage(path):
        if path not in layout:
            raise OSError("no such mount: %s" % path)
        entry = layout[path]
        total, used, _dev, _ro = entry[:4]
        free = entry[4] if len(entry) > 4 else None
        return _Usage(total, used, free)

    real = (os.stat, os.statvfs, shutil.disk_usage)
    os.stat, os.statvfs, shutil.disk_usage = fake_stat, fake_statvfs, fake_usage
    try:
        return cs.read_disks()
    finally:
        os.stat, os.statvfs, shutil.disk_usage = real


def test_steamos_shape():
    """The reported bug: read-only 5GB rootfs + the real /home beside it."""
    print("test_steamos_shape")
    disks = _run({
        "/":     (5 * GB, 3 * GB, 1, True),    # small, READ-ONLY: not the user's
        "/home": (512 * GB, 100 * GB, 2, False),
    })
    check("only one filesystem reported", len(disks), 1)
    check("and it is /home, not /", disks[0]["mount"] if disks else None, "/home")
    check("size is the real one", disks[0]["total_gb"] if disks else None, 512.0)
    check("not the alarming 69%", disks[0]["pct"] if disks else None, 20)


def test_percent_excludes_reserved():
    """Percent full must be used/(used+free), NOT used/total.

    VERBATIM from a Legion Go S, 2026-07-22: /home is 1812 GB with 1653.8 GB
    used and only 66.1 GB available -- 92 GB is root-reserved. Dividing by total
    reported 91% while df said 97%. A storage warning that reads LOW exactly
    when the disk is nearly full is worse than no warning, which is why this is
    asserted rather than left to the obvious-looking arithmetic.
    """
    print("test_percent_excludes_reserved")
    disks = _run({
        "/home": (1812 * GB, 1654 * GB, 2, False, 66 * GB),
    })
    got = {d["mount"]: d["pct"] for d in disks}
    check("/home is 97%, not 91%", got.get("/home"), 97)


def test_percent_rounds_up_like_df():
    """df rounds up; so do we. This number drives a warning colour and the
    conservative direction is the honest one for 'how full am I'."""
    print("test_percent_rounds_up_like_df")
    disks = _run({
        # 80.4% by exact arithmetic -> must present as 81, not 80.
        "/": (5 * GB, 3500 * MB, 1, False, 850 * MB),
    })
    check("80.4% presents as 81", disks[0]["pct"], 81)


def test_percent_never_exceeds_100():
    """A full filesystem must not render 101% on a bar clamped to 100."""
    print("test_percent_never_exceeds_100")
    disks = _run({"/": (5 * GB, 5 * GB, 1, False, 0)})
    check("clamped", disks[0]["pct"], 100)


def test_steam_library_drive_is_included():
    """A Deck's SD card holds the games and was invisible: _DISK_MOUNTS is a
    fixed list. Library drives come from Steam's OWN library list rather than
    globbing /run/media, so a box with no Steam gets nothing extra."""
    print("test_steam_library_drive_is_included")
    old_root, old_libs = cs._steam_root, cs._steam_libraries_cached
    cs._steam_root = lambda: "/home/deck/.steam/steam"
    cs._steam_libraries_cached = lambda root: [
        "/home/deck/.steam/steam/steamapps",
        "/run/media/deck/SD1T5/steamapps",
    ]
    try:
        disks = _run({
            "/home": (512 * GB, 100 * GB, 2, False),
            "/home/deck/.steam/steam": (512 * GB, 100 * GB, 2, False),   # same dev as /home
            "/run/media/deck/SD1T5": (1400 * GB, 10 * GB, 9, False),
        })
        mounts = [d["mount"] for d in disks]
        check("SD card listed", "/run/media/deck/SD1T5" in mounts, True)
        check("library on the same device as /home is not duplicated",
              mounts.count("/home"), 1)
        check("no duplicate device entries", len(mounts), len(set(mounts)))
    finally:
        cs._steam_root, cs._steam_libraries_cached = old_root, old_libs


def test_no_steam_adds_nothing():
    """A box without Steam must not gain phantom drives."""
    print("test_no_steam_adds_nothing")
    old_root = cs._steam_root
    cs._steam_root = lambda: None
    try:
        check("no library mounts", cs._steam_library_mounts(), [])
    finally:
        cs._steam_root = old_root


def test_read_only_root_is_hidden():
    """Both directions: identical filesystem, only the ro flag differs."""
    print("test_read_only_root_is_hidden")
    ro = _run({"/": (500 * GB, 250 * GB, 1, True)})
    check("read-only root omitted", ro, [])
    rw = _run({"/": (500 * GB, 250 * GB, 1, False)})
    check("the same filesystem writable IS reported", len(rw), 1)
    check("with the right numbers", rw[0]["pct"] if rw else None, 50)


def test_same_device_reported_once():
    """/ and /var on one filesystem is one row, not two identical ones."""
    print("test_same_device_reported_once")
    disks = _run({
        "/":    (900 * GB, 800 * GB, 7, False),
        "/var": (900 * GB, 800 * GB, 7, False),   # same st_dev
    })
    check("deduped to a single row", len(disks), 1)
    check("keeps the first candidate", disks[0]["mount"] if disks else None, "/")


def test_distinct_devices_all_reported():
    """The dedupe must not swallow genuinely separate storage."""
    print("test_distinct_devices_all_reported")
    disks = _run({
        "/":     (100 * GB, 50 * GB, 1, False),
        "/home": (900 * GB, 100 * GB, 2, False),
    })
    check("both reported", [d["mount"] for d in disks], ["/", "/home"])


def test_tiny_synthetic_mount_skipped():
    """The composefs case the size guard was written for still works."""
    print("test_tiny_synthetic_mount_skipped")
    disks = _run({
        "/":     (200 * 1024 ** 2, 200 * 1024 ** 2, 1, False),  # 200MB, 100% used
        "/home": (256 * GB, 8 * GB, 2, False),
    })
    check("tiny mount omitted", [d["mount"] for d in disks], ["/home"])


def test_missing_mount_is_not_fatal():
    """A box with no /home or /var must still report what it has."""
    print("test_missing_mount_is_not_fatal")
    disks = _run({"/": (64 * GB, 32 * GB, 1, False)})
    check("still returns the root", [d["mount"] for d in disks], ["/"])


if __name__ == "__main__":
    for fn in (test_steamos_shape,
               test_percent_excludes_reserved,
               test_percent_rounds_up_like_df,
               test_percent_never_exceeds_100,
               test_steam_library_drive_is_included,
               test_no_steam_adds_nothing,
               test_read_only_root_is_hidden,
               test_same_device_reported_once,
               test_distinct_devices_all_reported,
               test_tiny_synthetic_mount_skipped,
               test_missing_mount_is_not_fatal):
        fn()
    if FAILURES:
        print("\n%d FAILED: %s" % (len(FAILURES), ", ".join(FAILURES)))
        sys.exit(1)
    print("\nall good")
