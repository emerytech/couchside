#!/usr/bin/env python3
"""Tests for read_mem_pressure() — Linux PSI memory pressure.

Run: python3 tests/test_mem_pressure.py

WHY PSI AND NOT used/total: a used-percentage says how much memory is SPOKEN
FOR, not whether anything is hurting. A handheld with a big page cache reads
"26% used" while a game stutters, and "90% used" while everything is fine. PSI
measures the share of time work was actually STALLED waiting on memory.

MEASURED on a Legion Go S, 2026-07-22. Idle memory pressure read all zeros, so
to prove the mechanism reports non-zero at all, CPU pressure was driven with a
bounded load on the same kernel:

    before  some avg10=0.00
    under   some avg10=30.21
    after   some avg10=24.74   (decaying)

That is the "seen it fire AND not fire" control. Real MEMORY stall was not
induced -- filling 32 GB on someone's live box risks OOM-killing Steam -- so the
parser is exercised here with fixtures in the exact kernel format instead, and
the absent-file case is asserted because it must not look like "no pressure".
"""
import importlib.util
import os
import shutil
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


class Pressure:
    """Point the reader at a fake /proc/pressure/memory."""

    def __init__(self, text=None):
        self.dir = tempfile.mkdtemp(prefix="psi-")
        self.path = os.path.join(self.dir, "memory")
        if text is not None:
            with open(self.path, "w") as f:
                f.write(text)
        self._real_open = open
        outer = self

        def fake_open(path, *a, **kw):
            if path == "/proc/pressure/memory":
                return outer._real_open(outer.path, *a, **kw)
            return outer._real_open(path, *a, **kw)
        import builtins
        self._builtins = builtins
        builtins.open = fake_open

    def close(self):
        self._builtins.open = self._real_open
        shutil.rmtree(self.dir, ignore_errors=True)


# VERBATIM kernel format, from the Legion Go S.
IDLE = ("some avg10=0.00 avg60=0.00 avg300=0.00 total=366363677\n"
        "full avg10=0.00 avg60=0.00 avg300=0.00 total=366279414\n")
UNDER_PRESSURE = ("some avg10=30.21 avg60=8.40 avg300=1.89 total=129989666\n"
                  "full avg10=12.05 avg60=3.10 avg300=0.44 total=129994524\n")


def test_idle_reads_zeros():
    print("test_idle_reads_zeros")
    p = Pressure(IDLE)
    try:
        check("all zero", cs.read_mem_pressure(),
              {"some10": 0.0, "some60": 0.0, "full10": 0.0, "full60": 0.0})
    finally:
        p.close()


def test_under_pressure_reports_the_numbers():
    """The firing state, in the kernel's exact format."""
    print("test_under_pressure_reports_the_numbers")
    p = Pressure(UNDER_PRESSURE)
    try:
        got = cs.read_mem_pressure()
        check("some10", got.get("some10"), 30.21)
        check("some60", got.get("some60"), 8.4)
        check("full10", got.get("full10"), 12.05)
        check("full60", got.get("full60"), 3.1)
    finally:
        p.close()


def test_missing_file_is_EMPTY_not_zero():
    """THE distinction that matters. A kernel without CONFIG_PSI cannot tell us
    anything, and reporting 0.00 would claim 'no pressure' — a confident answer
    we do not have."""
    print("test_missing_file_is_EMPTY_not_zero")
    old = os.path.exists
    p = Pressure(None)          # directory exists, file does not
    try:
        check("empty dict", cs.read_mem_pressure(), {})
        check("and NOT zeros", cs.read_mem_pressure() == {"some10": 0.0}, False)
    finally:
        p.close()
        os.path.exists = old


def test_garbage_lines_are_skipped_not_fatal():
    """A kernel that adds a field, or a truncated read, must not raise."""
    print("test_garbage_lines_are_skipped_not_fatal")
    p = Pressure("some avg10=notanumber avg60=1.50\nnonsense\n\nfull avg10=2.00\n")
    try:
        got = cs.read_mem_pressure()
        check("bad value skipped", "some10" in got, False)
        check("good value kept", got.get("some60"), 1.5)
        check("other line parsed", got.get("full10"), 2.0)
    finally:
        p.close()


if __name__ == "__main__":
    for fn in (test_idle_reads_zeros,
               test_under_pressure_reports_the_numbers,
               test_missing_file_is_EMPTY_not_zero,
               test_garbage_lines_are_skipped_not_fatal):
        fn()
    if FAILURES:
        print("\n%d FAILED: %s" % (len(FAILURES), ", ".join(FAILURES)))
        sys.exit(1)
    print("\nall good")
