#!/usr/bin/env python3
"""Tests for the Steam profile + whole-library cards (agent, Phase 1).

Run: python3 tests/test_steam_profile.py

GET /api/steam/profile (persona/avatar/state/now-playing/level) and
GET /api/steam/library (whole-library aggregates: totals, top game, backlog,
recently played). Both read the owner's OWN Steam account via the same opt-in
key, are only-when-configured + degrade-closed, and are bearer-gated. This proves:

  - AGGREGATION is correct (counts, totals, backlog = owned-minus-played, top =
    most-played, recent sorted by 2-week hours) — hand-computed.
  - DEGRADE CLOSED: no key -> {configured:false}; key but Steam unreachable ->
    {configured:true, connected:false}; never raises.
  - §6: bearer-gated (401), happy path (200, observable), and the key is NEVER in
    either payload.
  - No real network: the cached fetchers are stubbed.

Pure stdlib, no pytest.
"""
import http.client
import importlib.util
import json
import os
import threading
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT = os.path.join(HERE, "..", "agent", "couchsided.py")
spec = importlib.util.spec_from_file_location("couchsided", AGENT)
cs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cs)

PASS = "  \033[32mPASS\033[0m"
FAIL = "  \033[31mFAIL\033[0m"
_fail = []
TOKEN = "test-secret-token"
GOOD_ID = "76561197960287930"
GOOD_KEY = "0123456789ABCDEF0123456789ABCDEF"


def check(cond, label, detail=""):
    print((PASS if cond else FAIL) + "  " + label + ("" if cond else "  <- %s" % (detail,)))
    if not cond:
        _fail.append(label)


OWNED = [
    {"appid": 1245620, "name": "Elden Ring", "playtime_forever": 12624, "playtime_2weeks": 126},
    {"appid": 1145350, "name": "Hades II", "playtime_forever": 300, "playtime_2weeks": 192},
    {"appid": 413150, "name": "Stardew Valley", "playtime_forever": 54, "playtime_2weeks": 0},
    {"appid": 2231450, "name": "Pizza Tower", "playtime_forever": 0, "playtime_2weeks": 0},
]


def _configure():
    with cs._STEAM_WEBAPI_LOCK:
        cs._STEAM_WEBAPI["steamid64"] = GOOD_ID
        cs._STEAM_WEBAPI["apikey"] = GOOD_KEY


def _unconfigure():
    with cs._STEAM_WEBAPI_LOCK:
        cs._STEAM_WEBAPI["steamid64"] = None
        cs._STEAM_WEBAPI["apikey"] = None


# ---------------------------------------------------------------------------
print("\n_steam_library_payload — aggregation is correct")
# ---------------------------------------------------------------------------
_saved = {k: getattr(cs, k) for k in ("_steam_owned_cached", "_steam_summary_cached", "_steam_level_cached")}
try:
    _configure()
    cs._steam_owned_cached = lambda: OWNED
    lib = cs._steam_library_payload()
    check(lib["count"] == 4, "count = 4 owned", lib)
    check(lib["played"] == 3, "played = 3 (>0 minutes)", lib)
    check(lib["backlog"] == 1, "backlog = 1 (owned-never-played)", lib)
    check(abs(lib["total_hours"] - round((12624 + 300 + 54) / 60.0, 1)) < 0.01, "total hours summed", lib)
    check(lib["top"]["name"] == "Elden Ring" and abs(lib["top"]["hours"] - 210.4) < 0.1, "top = most-played (Elden Ring 210.4h)", lib.get("top"))
    check([r["name"] for r in lib["recent"]] == ["Hades II", "Elden Ring"], "recent = 2wk games, sorted by 2wk hours", [r["name"] for r in lib["recent"]])
    check(abs(lib["hours_2weeks"] - round((126 + 192) / 60.0, 1)) < 0.1, "2-week hours summed", lib)
    check(GOOD_KEY not in json.dumps(lib), "library payload never carries the key")

    # degrade closed
    cs._steam_owned_cached = lambda: None
    check(cs._steam_library_payload() == {"configured": True, "connected": False}, "owned unreachable -> connected:false", cs._steam_library_payload())
    _unconfigure()
    check(cs._steam_library_payload() == {"configured": False}, "no key -> {configured:false}")

    print("\n_steam_profile_payload — state/now-playing/level")
    _configure()
    cs._steam_summary_cached = lambda: {"personaname": "Taylor", "avatarfull": "http://a/full.jpg",
                                        "personastate": 1, "gameextrainfo": "Hades II", "gameid": "1145350",
                                        "profileurl": "http://p/"}
    cs._steam_level_cached = lambda: 42
    prof = cs._steam_profile_payload()
    check(prof["connected"] is True and prof["persona"] == "Taylor", "profile persona", prof)
    check(prof["state"] == "Online" and prof["state_code"] == 1, "state mapped 1 -> Online", prof)
    check(prof["playing"] == "Hades II" and prof.get("gameid") == "1145350", "now-playing surfaced", prof)
    check(prof["avatar"] == "http://a/full.jpg" and prof["level"] == 42, "avatarfull + level", prof)
    check(GOOD_KEY not in json.dumps(prof), "profile payload never carries the key")
    cs._steam_summary_cached = lambda: None
    check(cs._steam_profile_payload() == {"configured": True, "connected": False}, "summary unreachable -> connected:false")
    _unconfigure()
    check(cs._steam_profile_payload() == {"configured": False}, "no key -> {configured:false}")
finally:
    for k, v in _saved.items():
        setattr(cs, k, v)
    _unconfigure()


# ===========================================================================
# HTTP — bearer gate + happy path
# ===========================================================================
def _server(mock):
    cs.Handler.token = TOKEN
    cs.Handler.token_file = None
    cs.Handler.mock = mock
    cs.Handler.port = 0
    srv = ThreadingHTTPServer(("127.0.0.1", 0), cs.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


def _get(port, path, token=TOKEN):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    headers = {"Authorization": "Bearer " + token} if token is not None else {}
    conn.request("GET", path, headers=headers)
    resp = conn.getresponse()
    data = resp.read()
    conn.close()
    try:
        return resp.status, json.loads(data or b"{}")
    except ValueError:
        return resp.status, {}


print("\nHTTP — auth gate + mock happy path")
srv, port = _server(mock=True)
try:
    for path in ("/api/steam/profile", "/api/steam/library"):
        st, _ = _get(port, path, token=None)
        check(st == 401, "%s without token -> 401" % path, st)
    st, body = _get(port, "/api/steam/profile")
    check(st == 200 and body.get("persona") == "Taylor" and body.get("playing") == "Hades II" and body.get("level") == 42,
          "mock profile -> 200 (Taylor, playing, level)", (st, body))
    st, body = _get(port, "/api/steam/library")
    check(st == 200 and body.get("count") == 312 and body.get("backlog") == 265 and body.get("top", {}).get("name") == "Elden Ring",
          "mock library -> 200 (312 games, backlog 265, top Elden Ring)", (st, body))
finally:
    srv.shutdown()

print("\nHTTP — real server, degrade-closed (no key)")
srv, port = _server(mock=False)
try:
    _unconfigure()
    st, body = _get(port, "/api/steam/profile")
    check(st == 200 and body == {"configured": False}, "real profile, no key -> {configured:false}", (st, body))
    st, body = _get(port, "/api/steam/library")
    check(st == 200 and body == {"configured": False}, "real library, no key -> {configured:false}", (st, body))
finally:
    srv.shutdown()

print()
if _fail:
    print("FAILURES: %d" % len(_fail))
    for f in _fail:
        print("  - " + f)
    raise SystemExit(1)
print("all steam profile/library tests passed")
