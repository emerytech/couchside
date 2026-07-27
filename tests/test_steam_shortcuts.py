#!/usr/bin/env python3
"""Tests for non-Steam shortcut launchers (shortcuts.vdf).

Run: python3 tests/test_steam_shortcuts.py

WHY THIS EXISTS: on SteamOS/Bazzite, shortcuts.vdf is how everything that is
not a Steam game reaches the TV. Bazzite's own `ujust get-media-app` registers
Netflix/Hulu/Disney+/Max/Prime Video there; EmuDeck registers its launchers
there. MEASURED on the maintainer's Bazzite box 2026-07-26: /api/launchers
returned 5 entries (all installed Steam games) while shortcuts.vdf held 32,
including every streaming service on the machine. The phone could not launch
any of them.

The fixture below is BUILT FROM THAT REAL FILE's layout: a b"\\x02appid\\x00"
field followed by a little-endian uint32, with \\x01AppName\\x00 and \\x01Exe\\x00
string fields in the same record. The appids and names are the ones actually
observed on that box.

SECURITY: this adds a client-selectable id that ends in a subprocess call, which
is exactly the shape CLAUDE.md §3 governs. The id is looked up, never
interpolated: `shortcut:<appid>` must be a digit string AND still present in
shortcuts.vdf, and the argv is rebuilt from the agent's own constants plus the
validated integer. The shortcut's stored Exe -- an arbitrary path -- is never
executed directly; Steam runs it. The rejection tests are the ones to keep if
this file is ever trimmed.
"""
import importlib.util
import os
import struct
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


def entry(appid, name, exe):
    """One shortcuts.vdf record, in the real binary-VDF field layout."""
    return (b"\x00" + b"0" + b"\x00"
            + b"\x02appid\x00" + struct.pack("<I", appid)
            + b"\x01AppName\x00" + name.encode("utf-8") + b"\x00"
            + b"\x01Exe\x00" + exe.encode("utf-8") + b"\x00"
            + b"\x08\x08")


class FakeSteam:
    """A real shortcuts.vdf on disk, at the path the agent globs."""

    def __init__(self, records):
        self.tmp = tempfile.mkdtemp()
        d = os.path.join(self.tmp, ".steam", "steam", "userdata",
                         "92324858", "config")
        os.makedirs(d)
        with open(os.path.join(d, "shortcuts.vdf"), "wb") as f:
            f.write(b"\x00shortcuts\x00" + b"".join(records) + b"\x08\x08")
        self._home = os.environ.get("HOME")
        os.environ["HOME"] = self.tmp

    def close(self):
        if self._home is not None:
            os.environ["HOME"] = self._home
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)


REAL = [
    entry(3266446485, "Netflix", '"/usr/bin/flatpak"'),
    entry(2282431590, "Hulu", '"/usr/bin/flatpak"'),
    entry(2190596466, "Disney+", '"/usr/bin/flatpak"'),
    # The agent's OWN tiles, which must NOT be offered as launchers.
    entry(2456487056, "Couchside — Pair Phone",
          "/home/deck/.local/opt/couchside/couchside-pair"),
]


def main():
    print("shortcuts.vdf enumeration")
    fake = FakeSteam(REAL)
    try:
        got = cs.discover_steam_shortcuts()
        labels = [e["label"] for e in got]
        check("lists the registered shortcuts", labels,
              ["Disney+", "Hulu", "Netflix"])          # sorted by label
        check("id is the shortcut: namespace", got[2]["id"],
              "shortcut:3266446485")
        check("kind is 'shortcut', not 'custom'", got[0]["kind"], "shortcut")
        # Both states of the self-filter: our tile is absent, others present.
        check("the agent's own pair tile is filtered out",
              any("Couchside" in l for l in labels), False)
        check("...while a normal tile in the same file is kept",
              "Netflix" in labels, True)

        print("appid -> rungameid encoding")
        # Non-Steam shortcuts use (appid << 32) | 0x02000000, not the raw appid.
        check("uses the non-Steam gameid encoding",
              cs._ss_gameid(3266446485), 14029280827242708992)

        print("launch resolution (the allowlist)")
        argv = cs._launcher_argv("shortcut:3266446485")
        check("a registered shortcut resolves to a steam:// argv LIST",
              argv, ["steam", "steam://rungameid/14029280827242708992"])
        check("argv is a list, never a shell string", isinstance(argv, list), True)

        print("rejections — an id that is not in the file is not a launcher")
        check("unregistered appid -> None",
              cs._launcher_argv("shortcut:999999999"), None)
        check("non-numeric id -> None",
              cs._launcher_argv("shortcut:netflix"), None)
        check("empty id -> None", cs._launcher_argv("shortcut:"), None)
        # These are the injection shapes: none may reach a command line.
        for bad in ("shortcut:1;reboot", "shortcut:$(id)", "shortcut:../../x",
                    "shortcut:1 2", "shortcut:0x10", "shortcut:-1"):
            check("rejects %r" % bad, cs._launcher_argv(bad), None)
        # The filtered-out tile must also be unlaunchable, not merely unlisted.
        check("a filtered self-tile cannot be launched either",
              cs._launcher_argv("shortcut:2456487056"), None)
    finally:
        fake.close()

    print("degrade closed")
    empty = FakeSteam([])
    try:
        check("no shortcuts -> empty list, not an error",
              cs.discover_steam_shortcuts(), [])
    finally:
        empty.close()

    missing = tempfile.mkdtemp()
    home = os.environ.get("HOME")
    os.environ["HOME"] = missing
    try:
        check("absent shortcuts.vdf -> empty list",
              cs.discover_steam_shortcuts(), [])
        check("...and nothing is launchable from it",
              cs._launcher_argv("shortcut:3266446485"), None)
    finally:
        os.environ["HOME"] = home
        import shutil
        shutil.rmtree(missing, ignore_errors=True)

    print("truncated file does not raise")
    trunc = tempfile.mkdtemp()
    d = os.path.join(trunc, ".steam", "steam", "userdata", "1", "config")
    os.makedirs(d)
    with open(os.path.join(d, "shortcuts.vdf"), "wb") as f:
        f.write(b"\x00shortcuts\x00\x02appid\x00\x01\x02")   # appid cut short
    os.environ["HOME"] = trunc
    try:
        check("truncated record -> empty list", cs.discover_steam_shortcuts(), [])
    finally:
        os.environ["HOME"] = home
        import shutil
        shutil.rmtree(trunc, ignore_errors=True)

    print()
    if FAILURES:
        print("FAILED: %s" % ", ".join(FAILURES))
        return 1
    print("all shortcut-launcher tests passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
