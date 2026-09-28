#!/usr/bin/env python3
"""Tests for achievement progress (agent, Phase 1).

Run: python3 tests/test_steam_achievements.py

GET /api/steam/achievements?appid=<digits>: the owner's progress for one game +
their rarest unlocked (global % from the KEY-FREE percentages endpoint). This is
the FIRST Steam GET route that takes a client value (appid), so it proves:

  - appid is VALIDATED to digits (reject, never sanitise) BEFORE any outbound call;
  - progress + rarest computed correctly, degrade-closed, per-appid cache 60s;
  - the per-account cache is wiped on reconfigure (no cross-account bleed);
  - §6 bearer-gated (401), bad appid -> 400, happy path (200); key never in payload.

No real network. Pure stdlib, no pytest.
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


def _configure():
    with cs._STEAM_WEBAPI_LOCK:
        cs._STEAM_WEBAPI["steamid64"] = GOOD_ID
        cs._STEAM_WEBAPI["apikey"] = GOOD_KEY


def _unconfigure():
    with cs._STEAM_WEBAPI_LOCK:
        cs._STEAM_WEBAPI["steamid64"] = None
        cs._STEAM_WEBAPI["apikey"] = None
    cs._STEAM_ACH_CACHE.clear()


PLAYER = {"playerstats": {"success": True, "achievements": [
    {"apiname": "A1", "achieved": 1, "name": "First"},
    {"apiname": "A2", "achieved": 1, "name": "Isolated"},
    {"apiname": "A3", "achieved": 0, "name": "Locked"},
]}}
GLOBAL = {"achievementpercentages": {"achievements": [
    {"name": "A1", "percent": 78.5}, {"name": "A2", "percent": 2.4}, {"name": "A3", "percent": 40.0}]}}


def _fake_api(interface, method, version, params, timeout=None):
    if method == "GetPlayerAchievements":
        return PLAYER
    if method == "GetGlobalAchievementPercentagesForApp":
        return GLOBAL
    return None


# ---------------------------------------------------------------------------
print("\n_valid_appid — digits only")
# ---------------------------------------------------------------------------
for good in ("1", "1145350", "440"):
    check(cs._valid_appid(good), "valid appid: %s" % good)
for bad in ("", "12345678", "abc", "12a", "-5", None, 440):
    check(not cs._valid_appid(bad), "rejected appid: %r" % (bad,))


# ---------------------------------------------------------------------------
print("\n_steam_achievements_payload — progress, rarest, degrade, cache")
# ---------------------------------------------------------------------------
_saved = cs._steam_api_get
try:
    _unconfigure()
    check(cs._steam_achievements_payload("1145350") == {"configured": False}, "no key -> {configured:false}")
    _configure()
    cs._STEAM_ACH_CACHE.clear()
    cs._steam_api_get = _fake_api
    p = cs._steam_achievements_payload("1145350")
    check(p["unlocked"] == 2 and p["total"] == 3 and p["percent"] == 67, "2/3 unlocked -> 67%", p)
    check(p["rarest"]["name"] == "Isolated" and abs(p["rarest"]["global_pct"] - 2.4) < 0.01,
          "rarest unlocked = lowest global % (Isolated 2.4%)", p.get("rarest"))
    check(GOOD_KEY not in json.dumps(p), "payload never carries the key")

    # cache: change the underlying; within TTL the cached value is returned
    cs._steam_api_get = lambda *a, **k: None
    p2 = cs._steam_achievements_payload("1145350")
    check(p2["unlocked"] == 2, "second call within TTL is cached (not re-fetched)", p2)

    # success:false -> has_achievements:false (game w/o achievements or private)
    cs._STEAM_ACH_CACHE.clear()
    cs._steam_api_get = lambda i, m, v, params, timeout=None: {"playerstats": {"success": False, "error": "no stats"}}
    p3 = cs._steam_achievements_payload("999")
    check(p3 == {"configured": True, "connected": True, "appid": "999", "has_achievements": False},
          "no-achievements game -> has_achievements:false", p3)

    # network failure -> connected:false
    cs._STEAM_ACH_CACHE.clear()
    cs._steam_api_get = lambda *a, **k: None
    p4 = cs._steam_achievements_payload("888")
    check(p4 == {"configured": True, "connected": False, "appid": "888"}, "call fails -> connected:false", p4)
finally:
    cs._steam_api_get = _saved
    _unconfigure()


# ---------------------------------------------------------------------------
print("\ncache invalidation on reconfigure (no cross-account bleed)")
# ---------------------------------------------------------------------------
import tempfile
_sc = cs._STEAM_WEBAPI_CONF
_td = tempfile.mkdtemp()
cs._STEAM_WEBAPI_CONF = os.path.join(_td, "s.json")
try:
    cs._STEAM_ACH_CACHE["1145350"] = {"ts": 9e9, "val": {"unlocked": 99}}
    cs._steam_webapi_save(GOOD_ID, GOOD_KEY)
    check(len(cs._STEAM_ACH_CACHE) == 0, "save() wipes the achievement cache")
    cs._STEAM_ACH_CACHE["1"] = {"ts": 9e9, "val": {}}
    cs._steam_webapi_clear()
    check(len(cs._STEAM_ACH_CACHE) == 0, "clear() wipes the achievement cache")
finally:
    cs._STEAM_WEBAPI_CONF = _sc
    import shutil
    shutil.rmtree(_td, ignore_errors=True)
    _unconfigure()


# ===========================================================================
# HTTP — bearer gate + appid validation + happy path
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


print("\nHTTP — auth + appid validation + happy path")
srv, port = _server(mock=True)
try:
    st, _ = _get(port, "/api/steam/achievements?appid=1145350", token=None)
    check(st == 401, "no token -> 401", st)
    st, _ = _get(port, "/api/steam/achievements")
    check(st == 400, "missing appid -> 400", st)
    st, _ = _get(port, "/api/steam/achievements?appid=abc")
    check(st == 400, "non-digit appid -> 400", st)
    st, _ = _get(port, "/api/steam/achievements?appid=12345678")
    check(st == 400, "8-digit appid -> 400 (max 7)", st)
    st, body = _get(port, "/api/steam/achievements?appid=1145350")
    check(st == 200 and body.get("unlocked") == 18 and body.get("total") == 33 and body.get("rarest", {}).get("global_pct") == 2.4,
          "mock -> 200 (18/33, rarest 2.4%)", (st, body))
finally:
    srv.shutdown()

srv, port = _server(mock=False)
try:
    _unconfigure()
    st, body = _get(port, "/api/steam/achievements?appid=440")
    check(st == 200 and body == {"configured": False}, "real, no key -> {configured:false}", (st, body))
finally:
    srv.shutdown()

print()
if _fail:
    print("FAILURES: %d" % len(_fail))
    for f in _fail:
        print("  - " + f)
    raise SystemExit(1)
print("all steam achievements tests passed")
