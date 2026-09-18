#!/usr/bin/env python3
"""install.ps1 must be pure ASCII.

Run: python3 tests/test_install_ps1_ascii.py

WHY (broke Windows install 2026-09-18). Windows PowerShell 5.1 reads a BOM-less
UTF-8 .ps1 as the system ANSI code page (Windows-1252), so a multi-byte UTF-8
character (an em-dash, curly quote, arrow, ...) is mangled into several bytes.
Inside a string or near code that shifts the parser and the whole script fails to
parse -> install.ps1 exits 1 -> BOTH Windows install paths break (the
`irm | iex` one-liner AND the CouchsideSetup.exe wizard, which bundles this file).
A single em-dash in a -Elevated Write-Host did exactly that. install.ps1 is served
raw and parsed by PS 5.1 in the wild, so it must stay 7-bit ASCII.

Pure stdlib, no pytest.
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
PS1 = os.path.join(HERE, "..", "install.ps1")

PASS = "  \033[32mPASS\033[0m"
FAIL = "  \033[31mFAIL\033[0m"
_fail = []


def check(cond, label):
    print((PASS if cond else FAIL) + "  " + label)
    if not cond:
        _fail.append(label)


def test_install_ps1_is_ascii():
    print("install.ps1: pure ASCII (PS 5.1 mangles UTF-8 in a BOM-less .ps1)")
    data = open(PS1, "rb").read()
    bad = [(i, b) for i, b in enumerate(data) if b > 0x7F]
    if bad:
        # Report the first offender with its 1-based line for a fast fix.
        first = bad[0][0]
        line = data[:first].count(b"\n") + 1
        print("    first non-ASCII byte 0x%02X at offset %d (line %d)"
              % (bad[0][1], first, line))
    check(not bad, "no non-ASCII bytes (%d found)" % len(bad))
    # No UTF-8 BOM either: a BOM at the top of a piped `irm | iex` script prints
    # as stray characters and can trip the first statement.
    check(not data.startswith(b"\xef\xbb\xbf"), "no UTF-8 BOM")


if __name__ == "__main__":
    test_install_ps1_is_ascii()
    print()
    if _fail:
        print("FAILED: %d" % len(_fail))
        for f in _fail:
            print("  - " + f)
        raise SystemExit(1)
    print("install.ps1 ASCII test passed")
