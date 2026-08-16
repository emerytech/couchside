#!/usr/bin/env python3
"""Tests for Steam Remote Play (in-home streaming) discovery — /api/steamlink.

Run: python3 tests/test_steamlink.py

The feature turns the games your gaming PC / another Deck offers to stream (which
Steam caches in config/remoteclients.vdf) into one-tap tiles. Launching
steam://rungameid/<appid> for a host game that is NOT installed locally makes
Steam stream it — verified on real hardware. These tests drive the REAL parsers
with only the file I/O stubbed, so the remoteclients text-VDF scan, the v29
appinfo.vdf name resolver (built as a synthetic fixture below), the most-recent-
host de-dupe, the tool filter, and the launch allowlist gate are all exercised
for real. Pure stdlib, no pytest — same style as the other agent tests.
"""
import importlib.util
import os
import struct

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT = os.path.join(HERE, "..", "agent", "couchsided.py")

spec = importlib.util.spec_from_file_location("couchsided", AGENT)
cs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cs)

PASS = "  \033[32mPASS\033[0m"
FAIL = "  \033[31mFAIL\033[0m"
_failures = []


def check(cond, label):
    print((PASS if cond else FAIL) + "  " + label)
    if not cond:
        _failures.append(label)


# --- synthetic v29 appinfo.vdf (locks the binary name parser) ----------------

def _v29_appinfo(app_names):
    """Build a minimal but real v29 appinfo.vdf: header + one section per
    (appid, name) with an appinfo->common->name string field + a terminating
    appid 0 + the string table. Keys in the KV blob are int32 string-table
    indices.

    The `appinfo` wrapper is NOT decoration. Real files nest the fields at
    appinfo.common.{name,type}, and this fixture used to omit that level —
    emitting common->name at the top. It passed anyway, because the duplicate
    appinfo parser this suite used to call was lenient enough to find a name
    wherever it sat. So the fixture had quietly stopped resembling the format it
    claims to lock, and nothing said so. Corrected 2026-08-16 when the duplicate
    parser was removed and the strict (hardware-measured, 1101/1101) parser
    started rejecting it. Keep the nesting.
    """
    strings = [b"appinfo", b"common", b"name"]   # 0, 1, 2
    appinfo_idx, common_idx, name_idx = 0, 1, 2

    def kv_blob(name):
        b = bytearray()
        b += b"\x00" + struct.pack("<I", appinfo_idx)    # nested "appinfo"
        b += b"\x00" + struct.pack("<I", common_idx)     # nested "common"
        b += b"\x01" + struct.pack("<I", name_idx)       # string "name"
        b += name.encode("utf-8") + b"\x00"
        b += b"\x08"                                     # end common
        b += b"\x08"                                     # end appinfo
        b += b"\x08"                                     # end top map
        return bytes(b)

    sections = bytearray()
    for appid, name in app_names:
        blob = kv_blob(name)
        header = b"\x00" * (4 + 4 + 8 + 20 + 4 + 20)     # 60-byte fixed header
        size = len(header) + len(blob)
        sections += struct.pack("<I", appid) + struct.pack("<I", size) + header + blob
    sections += struct.pack("<I", 0)                     # terminating appid 0

    st_off = 16 + len(sections)
    out = bytearray()
    out += struct.pack("<I", 0x07564429)                 # magic v29
    out += struct.pack("<I", 1)                          # universe
    out += struct.pack("<q", st_off)                     # string table offset
    out += sections
    out += struct.pack("<I", len(strings))
    for s in strings:
        out += s + b"\x00"
    return bytes(out)


REMOTECLIENTS = """
"RemoteClientCache"
{
\t"aaaa1111"
\t{
\t\t"hostname"\t\t"gaming-pc"
\t\t"lastupdated"\t\t"2000"
\t\t"apps"
\t\t{
\t\t\t"0"\t\t"228980"
\t\t\t"1"\t\t"1174180"
\t\t\t"2"\t\t"1086940"
\t\t}
\t}
\t"bbbb2222"
\t{
\t\t"hostname"\t\t"old-deck"
\t\t"lastupdated"\t\t"1000"
\t\t"apps"
\t\t{
\t\t\t"0"\t\t"1174180"
\t\t\t"1"\t\t"570"
\t\t}
\t}
}
"""

NAMES = {228980: "Steamworks Common Redistributables",
         1174180: "Red Dead Redemption 2",
         1086940: "Baldur's Gate 3",
         570: "Dota 2"}


def with_fixtures(fn):
    """Run fn with the agent pointed at in-memory remoteclients + appinfo."""
    import tempfile
    d = tempfile.mkdtemp()
    rc = os.path.join(d, "remoteclients.vdf")
    ai = os.path.join(d, "appinfo.vdf")
    with open(rc, "w") as f:
        f.write(REMOTECLIENTS)
    with open(ai, "wb") as f:
        f.write(_v29_appinfo(list(NAMES.items())))
    orig_rc, orig_ai, orig_root, orig_which = (
        cs._remoteclients_path, cs._appinfo_path, cs._steam_root, cs.shutil.which)
    cs._remoteclients_path = lambda: rc
    cs._appinfo_path = lambda: ai
    cs._steam_root = lambda: d
    cs.shutil.which = lambda x: "/usr/bin/steam" if x == "steam" else orig_which(x)
    cs._APPINFO_CACHE["key"] = None  # force re-parse of the fixture
    try:
        return fn()
    finally:
        cs._remoteclients_path, cs._appinfo_path = orig_rc, orig_ai
        cs._steam_root, cs.shutil.which = orig_root, orig_which


def test_appinfo_v29_names():
    """The v29 name parse, exercised through the PUBLIC entry point.

    This used to call cs._parse_appinfo_names(bytes) — an internal of a SECOND,
    duplicate appinfo parser that has since been removed (it redefined the real
    parser's module-level cache at import, so the two evicted each other). The
    surviving parser reads a file rather than a buffer, so the fixture is
    installed and _steam_appinfo_names() is driven end to end. Testing the
    shipped path rather than a helper is the better assertion anyway.
    """
    print("v29 appinfo name parser")

    def body():
        names = cs._steam_appinfo_names()
        check(names.get(1174180) == "Red Dead Redemption 2", "extracts RDR2 name")
        check(names.get(1086940) == "Baldur's Gate 3", "extracts BG3 name (apostrophe)")
        check(len(names) == len(NAMES), "every app named")
        return True

    with_fixtures(body)

    # Degrade CLOSED on a malformed file: {} rather than a raise. Same property
    # the old buffer-level check pinned, now at the file level.
    import tempfile
    d = tempfile.mkdtemp()
    bad = os.path.join(d, "appinfo.vdf")
    with open(bad, "wb") as f:
        f.write(b"garbage")
    orig_ai, orig_root = cs._appinfo_path, cs._steam_root
    cs._appinfo_path, cs._steam_root = (lambda: bad), (lambda: d)
    cs._APPINFO_CACHE["key"] = None
    try:
        check(cs._steam_appinfo_names() == {}, "garbage -> {} not raise")
    finally:
        cs._appinfo_path, cs._steam_root = orig_ai, orig_root
        cs._APPINFO_CACHE["key"] = None


def test_appinfo_cache_is_shared_not_thrashed():
    """The bug the duplicate parser caused, pinned so it cannot come back.

    Two parsers shared one module-level cache dict under INCOMPATIBLE key shapes
    — (path, mtime, size) vs (mtime, size) — so alternating between the two
    consumers (/api/steam/installable and /api/steamlink) invalidated the cache
    every single time and paid a full re-parse of a multi-MB file (~80ms on real
    hardware). Nothing measured it, so it was invisible.

    Counts actual file reads: alternating the two views must parse ONCE.
    """
    print("appinfo cache is shared, not thrashed")

    def body():
        cs._APPINFO_CACHE["key"] = None
        reads = []
        real_open = cs.open if hasattr(cs, "open") else open
        import builtins
        orig = builtins.open

        def counting_open(path, *a, **kw):
            if isinstance(path, str) and path.endswith("appinfo.vdf"):
                reads.append(path)
            return orig(path, *a, **kw)

        builtins.open = counting_open
        try:
            for _ in range(3):
                cs._appinfo_names()          # the installable view
                cs._steam_appinfo_names()    # the Steam Link view
        finally:
            builtins.open = orig
        check(len(reads) == 1,
              "6 alternating calls parse appinfo.vdf exactly once (got %d)"
              % len(reads))
        # Both views agree on the same underlying parse.
        rich = cs._appinfo_names()
        flat = cs._steam_appinfo_names()
        check(set(rich) == set(flat), "both views cover the same appids")
        check(all(flat[a] == rich[a]["name"] for a in flat),
              "the flat view is exactly the rich view's names")
        return True

    with_fixtures(body)


def test_discovery():
    print("stream game discovery")

    def body():
        games = cs.discover_stream_games()
        by_id = {g["appid"]: g for g in games}
        check(228980 not in by_id, "tool (Steamworks redist) filtered out")
        check(by_id.get(1174180, {}).get("label") == "Red Dead Redemption 2",
              "RDR2 present with real name")
        # RDR2 is on both hosts; gaming-pc (last=2000) beats old-deck (1000).
        check(by_id.get(1174180, {}).get("host") == "gaming-pc",
              "dup appid resolves to the most-recently-seen host")
        check(by_id.get(570, {}).get("host") == "old-deck",
              "old-deck-only game still listed")
        check(all(g["kind"] == "stream" and g["id"].startswith("stream:")
                  for g in games), "all tagged kind=stream")
        return games

    with_fixtures(body)


def test_info_grouping():
    print("steamlink_info host grouping")

    def body():
        info = cs.steamlink_info()
        check(info["available"] is True, "available when hosts offer games")
        hosts = {h["host"]: h for h in info["hosts"]}
        check("gaming-pc" in hosts and "old-deck" in hosts, "both hosts present")
        check(info["hosts"][0]["host"] == "gaming-pc",
              "newest host (gaming-pc) sorted first")
        # gaming-pc offers RDR2 + BG3 (redist filtered); old-deck offers Dota 2
        # (RDR2 dup went to gaming-pc).
        check(len(hosts["gaming-pc"]["games"]) == 2, "gaming-pc has 2 games")
        check(len(hosts["old-deck"]["games"]) == 1, "old-deck has 1 game")
        return info

    with_fixtures(body)


def test_launch_gate():
    print("launch allowlist gate")

    def body():
        argv = cs._launcher_argv("stream:1174180")
        check(argv == ["steam", "steam://rungameid/1174180"],
              "streamable appid -> rungameid argv")
        check(cs._launcher_argv("stream:999999999") is None,
              "unknown appid -> None (404)")
        check(cs._launcher_argv("stream:228980") is None,
              "a filtered tool is not streamable")
        check(cs._launcher_argv("stream:notanumber") is None,
              "non-numeric -> None")
        return True

    with_fixtures(body)


def test_available_false_when_empty():
    print("probe-and-appear")
    # No remoteclients file -> not available (app hides the surface).
    orig = cs._remoteclients_path
    cs._remoteclients_path = lambda: None
    try:
        check(cs.discover_stream_games() == [], "no cache -> no games")
        check(cs.steamlink_info()["available"] is False, "info reports unavailable")
    finally:
        cs._remoteclients_path = orig


if __name__ == "__main__":
    test_appinfo_v29_names()
    test_appinfo_cache_is_shared_not_thrashed()
    test_discovery()
    test_info_grouping()
    test_launch_gate()
    test_available_false_when_empty()
    print()
    if _failures:
        print("FAILED: %d" % len(_failures))
        for f in _failures:
            print("  - " + f)
        raise SystemExit(1)
    print("all steamlink tests passed")
