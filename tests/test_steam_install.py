#!/usr/bin/env python3
"""Tests for "install a game you own but have not downloaded" (Phase 2, agent side).

Run: python3 tests/test_steam_install.py

WHAT THIS GUARDS. The feature adds a NEW client-supplied-appid path — exactly the
shape CLAUDE.md §3 warns about — so the security-critical properties are asserted,
not assumed:

  1. The install allowlist is `_installable_appids()`: digit-named subdirs of
     appcache/librarycache/ MINUS installed MINUS known tools. An INSTALLED game is
     NOT installable (the control below), a tool is excluded, and a non-digit dir is
     ignored.
  2. `install:<appid>` is REFUSED unless the appid is in that set — a non-owned
     appid returns None (-> 404), and NOTHING runs.
  3. When it is allowed, the argv is the agent's own constant + a digits-only appid:
     ["steam", "steam://install/<appid>"]. No client string reaches the command line
     as anything but a validated integer, and there is no shell.
  4. Degrade CLOSED: no Steam root -> empty allowlist, never "everything".

The enumeration reads Steam's own on-disk art cache — NO Steam Web API key, no
account (measured on bazzite 2026-08-08: 1117 cached appids vs 12 installed).
"""
import http.client
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import threading
from http.server import ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location(
    "couchsided", os.path.join(ROOT, "agent", "couchsided.py"))
cs = importlib.util.module_from_spec(_spec)
sys.modules["couchsided"] = cs
_spec.loader.exec_module(cs)

FAILURES = []
TOKEN = "test-secret-token"


def check(name, got, want):
    if got == want:
        print("  PASS  %s" % name)
    else:
        print("  FAIL  %s (got %r, want %r)" % (name, got, want))
        FAILURES.append(name)


def _clear_caches():
    # Fresh roots per fixture already differ, but the install/lib caches are keyed
    # on root+time; clear them so a within-test install change is never masked.
    cs._INSTALLABLE_CACHE.update(root=None, at=0.0, val=None)
    cs._STEAM_LIB_CACHE.update(root=None, at=0.0, val=None)


class Root:
    """A fake Steam root the REAL code walks: some INSTALLED games (appmanifests)
    and a LIBRARY art cache (librarycache/<appid>/) that is a superset of them."""

    def __init__(self, installed=(), cached=()):
        self.dir = tempfile.mkdtemp(prefix="steaminstall-")
        steamapps = os.path.join(self.dir, "steamapps")
        os.makedirs(steamapps)
        for appid in installed:
            with open(os.path.join(steamapps, "appmanifest_%s.acf" % appid), "w") as f:
                f.write('"AppState"\n{\n\t"appid"\t\t"%s"\n\t"name"\t\t"Game %s"\n}\n'
                        % (appid, appid))
        cache = os.path.join(self.dir, "appcache", "librarycache")
        os.makedirs(cache)
        for entry in cached:
            d = os.path.join(cache, entry)
            os.makedirs(d, exist_ok=True)
            # A cached library entry carries art; give it a header so hasArt-style
            # probes (and the cover endpoint) see a real file.
            with open(os.path.join(d, "header.jpg"), "wb") as f:
                f.write(b"\xff\xd8\xff")
        self._old = cs._steam_root
        cs._steam_root = lambda: self.dir
        _clear_caches()

    def close(self):
        cs._steam_root = self._old
        _clear_caches()
        shutil.rmtree(self.dir, ignore_errors=True)


# ---------------------------------------------------------------------------
print("\n_installable_appids — the allowlist")
# ---------------------------------------------------------------------------

def test_excludes_installed_and_tools():
    """The core rule: owned-but-uninstalled = cached MINUS installed MINUS tools."""
    print("test_excludes_installed_and_tools")
    # 440 installed; 620 + 570 owned-uninstalled; 228980 is a known tool; "junk"
    # is not an appid. 440 is ALSO in the cache (installed games are, too).
    r = Root(installed=["440"], cached=["440", "620", "570", "228980", "junk"])
    try:
        got = cs._installable_appids()
        check("owned-uninstalled set", got, {"620", "570"})
        check("installed 440 NOT installable (control)", "440" in got, False)
        check("tool 228980 excluded", "228980" in got, False)
        check("non-digit 'junk' ignored", "junk" in got, False)
    finally:
        r.close()


def test_ignores_non_digit_dirs():
    print("test_ignores_non_digit_dirs")
    r = Root(installed=[], cached=["620", "not-an-id", "12ab", ""])
    try:
        check("only the pure-digit dir", cs._installable_appids(), {"620"})
    finally:
        r.close()


def test_degrades_closed_no_root():
    """No Steam at all must be an EMPTY allowlist, never 'everything'."""
    print("test_degrades_closed_no_root")
    old = cs._steam_root
    cs._steam_root = lambda: None
    _clear_caches()
    try:
        check("no root -> empty set", cs._installable_appids(), set())
    finally:
        cs._steam_root = old
        _clear_caches()


def test_installable_games_shape():
    """List is [{'appid': int}] sorted by appid — no invented names."""
    print("test_installable_games_shape")
    r = Root(installed=["440"], cached=["440", "620", "570"])
    try:
        got = cs._installable_games()
        check("sorted, appid-only", got, [{"appid": 570}, {"appid": 620}])
    finally:
        r.close()


# ---------------------------------------------------------------------------
print("\n_launcher_argv('install:<appid>') — the gate")
# ---------------------------------------------------------------------------

def test_install_owned_builds_fixed_argv():
    print("test_install_owned_builds_fixed_argv")
    r = Root(installed=["440"], cached=["440", "620"])
    try:
        argv = cs._launcher_argv("install:620")
        check("argv is the fixed shape", argv, ["steam", "steam://install/620"])
    finally:
        r.close()


def test_install_installed_game_refused_control():
    """CONTROL: an INSTALLED game is not installable, so install:<it> is refused.
    (Without this control, an allowlist that accidentally returned installed games
    too would still pass every other test.)"""
    print("test_install_installed_game_refused_control")
    r = Root(installed=["440"], cached=["440", "620"])
    try:
        check("install:440 (installed) -> None", cs._launcher_argv("install:440"), None)
    finally:
        r.close()


def test_install_unowned_refused_nothing_built():
    print("test_install_unowned_refused_nothing_built")
    r = Root(installed=["440"], cached=["440", "620"])
    try:
        check("install:999999 (not in library) -> None",
              cs._launcher_argv("install:999999"), None)
    finally:
        r.close()


def test_install_nondigit_refused():
    """Reject rather than sanitise (CLAUDE.md §3.6)."""
    print("test_install_nondigit_refused")
    r = Root(installed=[], cached=["620"])
    try:
        for bad in ("install:../440", "install:6 20", "install:", "install:abc",
                    "install:620/../440"):
            check("%r -> None" % bad, cs._launcher_argv(bad), None)
    finally:
        r.close()


def test_argv_has_no_shell_and_only_a_digit_slot():
    """The only client-derived part of the argv is a validated integer."""
    print("test_argv_has_no_shell_and_only_a_digit_slot")
    r = Root(installed=[], cached=["620"])
    try:
        argv = cs._launcher_argv("install:620")
        check("argv[0] is the fixed binary", argv[0], "steam")
        check("argv[1] is constant + digits", argv[1], "steam://install/620")
        check("no shell metachars in the url", any(c in argv[1] for c in ";|&$`>"), False)
        check("exactly two args", len(argv), 2)
    finally:
        r.close()


# ---------------------------------------------------------------------------
print("\nHTTP: GET /api/steam/installable + POST /api/launchers/install:<id>")
# ---------------------------------------------------------------------------

def _server(root_dir):
    cs._steam_root = lambda: root_dir
    _clear_caches()
    cs.Handler.token = TOKEN
    cs.Handler.token_file = None
    cs.Handler.mock = False
    cs.Handler.port = 0
    srv = ThreadingHTTPServer(("127.0.0.1", 0), cs.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


def _req(port, method, path, token=TOKEN):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    headers = {"Authorization": "Bearer " + token} if token is not None else {}
    conn.request(method, path, headers=headers)
    resp = conn.getresponse()
    data = resp.read()
    conn.close()
    try:
        return resp.status, json.loads(data or b"{}")
    except ValueError:
        return resp.status, {}


def test_http_endpoints():
    print("test_http_endpoints")
    r = Root(installed=["440"], cached=["440", "620", "570"])
    old = cs._steam_root
    srv, port = _server(r.dir)
    try:
        # Happy path: the owned-uninstalled list, appids only.
        status, body = _req(port, "GET", "/api/steam/installable")
        check("GET installable -> 200", status, 200)
        check("count", body.get("count"), 2)
        check("games sorted appid-only", body.get("games"),
              [{"appid": 570}, {"appid": 620}])

        # Auth failure: no bearer -> 401 (same gate as every other /api route).
        check("no bearer -> 401", _req(port, "GET", "/api/steam/installable",
                                       token=None)[0], 401)
        check("wrong bearer -> 401", _req(port, "GET", "/api/steam/installable",
                                          token="nope")[0], 401)

        # Unknown-input rejection: install a game NOT in the library -> 404, and by
        # construction nothing is launched (the argv resolver returns None first).
        st, bd = _req(port, "POST", "/api/launchers/install:999999")
        check("install unowned -> 404", st, 404)
        check("404 body says unknown", bd.get("error"), "unknown launcher")

        # An INSTALLED game is also not installable -> 404 (control, over the wire).
        check("install an installed game -> 404",
              _req(port, "POST", "/api/launchers/install:440")[0], 404)
    finally:
        srv.shutdown()
        cs._steam_root = old
        r.close()


# ---------------------------------------------------------------------------
print("\ncap wiring")
# ---------------------------------------------------------------------------

def test_cap_present_in_mock_and_real():
    print("test_cap_present_in_mock_and_real")
    cs.set_caps(True)
    check("mock CAPS has steaminstall=True", cs.CAPS.get("steaminstall"), True)
    # real: with a Steam root present the cap is True; with none, False.
    r = Root(installed=[], cached=["620"])
    try:
        cs.set_caps(False)
        check("real CAPS steaminstall True when steam present",
              cs.CAPS.get("steaminstall"), True)
    finally:
        r.close()
    old = cs._steam_root
    cs._steam_root = lambda: None
    try:
        cs.set_caps(False)
        check("real CAPS steaminstall False when no steam",
              cs.CAPS.get("steaminstall"), False)
    finally:
        cs._steam_root = old


# ---------------------------------------------------------------------------
print("\nappinfo.vdf names — offline name+type for the installable list")
# ---------------------------------------------------------------------------
# The list used to ship appid-only ("appinfo.vdf is a partial cache" — DISPROVEN
# by measurement: 100% coverage of a real 1101-app library). These fixtures are
# SYNTHETIC (the real file is 4.2MB, too big to commit); the parser was also
# verified against the real bazzite file (1560 apps, controls Portal 2 / Dota 2).

import struct


def _bvdf_bytes(d, strtab):
    """Serialize a dict as binary VDF. strtab None -> v27/28 inline-cstring keys;
    a list -> v29 (keys appended, encoded as u32 indices)."""
    out = b""
    for k, v in d.items():
        if strtab is None:
            key = k.encode() + b"\x00"
        else:
            if k not in strtab:
                strtab.append(k)
            key = struct.pack("<I", strtab.index(k))
        if isinstance(v, dict):
            out += b"\x00" + key + _bvdf_bytes(v, strtab) + b"\x08"
        elif isinstance(v, str):
            out += b"\x01" + key + v.encode() + b"\x00"
        else:
            out += b"\x02" + key + struct.pack("<I", v)
    return out


def _appinfo_file(apps, version=29):
    """Write a synthetic appinfo.vdf: {appid: {"name":..., "type":...}}."""
    magic = {27: 0x07564427, 28: 0x07564428, 29: 0x07564429}[version]
    strtab = [] if version == 29 else None
    blobs = b""
    for appid, meta in apps.items():
        kv = {"appinfo": {"common": dict(meta)}}
        vdf = _bvdf_bytes(kv, strtab) + b"\x08"
        hdr = struct.pack("<IIQ", 1, 0, 0) + b"\x00" * 20 + struct.pack("<I", 0)
        if version >= 28:
            hdr += b"\x00" * 20
        body = hdr + vdf
        blobs += struct.pack("<II", appid, len(body)) + body
    blobs += struct.pack("<I", 0)  # terminator appid
    if version == 29:
        head = struct.pack("<II", magic, 1)
        table_off = len(head) + 8 + len(blobs)
        head += struct.pack("<q", table_off)
        table = struct.pack("<I", len(strtab)) + b"".join(
            s.encode() + b"\x00" for s in strtab)
        data = head + blobs + table
    else:
        data = struct.pack("<II", magic, 1) + blobs
    fd, p = tempfile.mkstemp(suffix=".vdf")
    os.write(fd, data)
    os.close(fd)
    return p


def _root_with_appinfo(apps, version=29, installed=(), cached=()):
    r = Root(installed=installed, cached=cached)
    os.makedirs(os.path.join(r.dir, "appcache"), exist_ok=True)
    p = _appinfo_file(apps, version)
    shutil.move(p, os.path.join(r.dir, "appcache", "appinfo.vdf"))
    cs._APPINFO_CACHE.update(key=None, val=None)
    return r


def test_appinfo_names_v29_and_v28():
    print("test_appinfo_names_v29_and_v28")
    apps = {620: {"name": "Portal 2", "type": "Game"},
            1234: {"name": "Some DLC", "type": "DLC"}}
    for ver in (29, 28):
        r = _root_with_appinfo(apps, version=ver)
        try:
            got = cs._appinfo_names()
            check("v%d: name" % ver, got.get(620), {"name": "Portal 2", "type": "game"})
            check("v%d: type lowercased" % ver, got.get(1234)["type"], "dlc")
        finally:
            r.close()
            cs._APPINFO_CACHE.update(key=None, val=None)


def test_appinfo_degrades_closed():
    """Garbage/missing/truncated appinfo -> {}, and the list ships appid-only."""
    print("test_appinfo_degrades_closed")
    r = Root(installed=[], cached=["620"])
    try:
        check("no appinfo file -> {}", cs._appinfo_names(), {})
        # Garbage magic.
        os.makedirs(os.path.join(r.dir, "appcache"), exist_ok=True)
        with open(os.path.join(r.dir, "appcache", "appinfo.vdf"), "wb") as f:
            f.write(b"NOTVDF\x00\x00garbage")
        cs._APPINFO_CACHE.update(key=None, val=None)
        check("bad magic -> {}", cs._appinfo_names(), {})
        # Truncated real-shaped file.
        p = _appinfo_file({620: {"name": "Portal 2", "type": "game"}})
        data = open(p, "rb").read()[:20]
        os.unlink(p)
        with open(os.path.join(r.dir, "appcache", "appinfo.vdf"), "wb") as f:
            f.write(data)
        cs._APPINFO_CACHE.update(key=None, val=None)
        check("truncated -> {} (degrade closed)", cs._appinfo_names(), {})
        games = cs._installable_games()
        check("list still ships appid-only", games, [{"appid": 620}])
    finally:
        r.close()
        cs._APPINFO_CACHE.update(key=None, val=None)


def test_installable_games_carry_names():
    """When appinfo parses, entries gain name+type; entries it lacks stay
    appid-only (both states observed)."""
    print("test_installable_games_carry_names")
    r = _root_with_appinfo({620: {"name": "Portal 2", "type": "Game"}},
                           installed=["440"], cached=["440", "620", "570"])
    try:
        games = {g["appid"]: g for g in cs._installable_games()}
        check("620 named", games[620],
              {"appid": 620, "name": "Portal 2", "type": "game"})
        check("570 (absent from appinfo) appid-only", games[570], {"appid": 570})
        check("installed 440 still excluded (control)", 440 in games, False)
    finally:
        r.close()
        cs._APPINFO_CACHE.update(key=None, val=None)


def test_http_installable_carries_names():
    print("test_http_installable_carries_names")
    r = _root_with_appinfo({620: {"name": "Portal 2", "type": "Game"}},
                           installed=[], cached=["620"])
    old = cs._steam_root
    srv, port = _server(r.dir)
    try:
        cs._APPINFO_CACHE.update(key=None, val=None)
        status, body = _req(port, "GET", "/api/steam/installable")
        check("GET -> 200", status, 200)
        check("names over the wire", body.get("games"),
              [{"appid": 620, "name": "Portal 2", "type": "game"}])
    finally:
        srv.shutdown()
        cs._steam_root = old
        r.close()
        cs._APPINFO_CACHE.update(key=None, val=None)


def test_mock_installable_has_names():
    """Harness renders titles immediately + exercises the type=game filter."""
    print("test_mock_installable_has_names")
    for g in cs.MOCK_INSTALLABLE:
        check("mock %d has name+type" % g["appid"],
              bool(g.get("name")) and g.get("type") == "game", True)


if __name__ == "__main__":
    for fn in (test_excludes_installed_and_tools,
               test_ignores_non_digit_dirs,
               test_degrades_closed_no_root,
               test_installable_games_shape,
               test_install_owned_builds_fixed_argv,
               test_install_installed_game_refused_control,
               test_install_unowned_refused_nothing_built,
               test_install_nondigit_refused,
               test_argv_has_no_shell_and_only_a_digit_slot,
               test_http_endpoints,
               test_appinfo_names_v29_and_v28,
               test_appinfo_degrades_closed,
               test_installable_games_carry_names,
               test_http_installable_carries_names,
               test_mock_installable_has_names,
               test_cap_present_in_mock_and_real):
        fn()
    if FAILURES:
        print("\n%d FAILED: %s" % (len(FAILURES), ", ".join(FAILURES)))
        sys.exit(1)
    print("\nall good")
