#!/usr/bin/env python3
"""Tests for wishlist sale-watch (agent, Phase 1).

Run: python3 tests/test_steam_wishlist.py

GET /api/steam/wishlist: which of the owner's wishlist games are discounted now.
GetWishlist (key) gives appids; ONE batched Storefront appdetails price call finds
the discounted ones; names are fetched only for those, BOUNDED. Proves:

  - only discounted wishlist games are returned, with correct price/discount/name;
  - the fan-out is BOUNDED (WL_CONSIDER price-checked, WL_MAX named) so a huge
    wishlist can't explode into calls;
  - degrade-closed (wishlist unreadable -> connected:false; unconfigured ->
    configured:false); wishlist appids validated to digits;
  - per-account cache wiped on reconfigure (no cross-account bleed);
  - §6 bearer-gated (401) + happy path (200); key never in payload.

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
    cs._STEAM_WISHLIST_CACHE["ts"] = 0.0
    cs._STEAM_WISHLIST_CACHE["val"] = None


WISHLIST = {"response": {"items": [
    {"appid": 1086940}, {"appid": 1174180}, {"appid": 413150}, {"appid": "junk"}, {"nope": 1}]}}
PRICES = {
    "1086940": {"success": True, "data": {"price_overview": {"discount_percent": 20, "final": 4799, "initial": 5999, "currency": "USD"}}},
    "1174180": {"success": True, "data": {"price_overview": {"discount_percent": 67, "final": 1979, "initial": 5999, "currency": "USD"}}},
    "413150": {"success": True, "data": {"price_overview": {"discount_percent": 0, "final": 1499, "initial": 1499, "currency": "USD"}}},
}
NAMES = {"1086940": "Baldur's Gate 3", "1174180": "Red Dead Redemption 2"}


def _fake_store(endpoint, params, timeout=None):
    if endpoint == "appdetails" and params.get("filters") == "price_overview":
        return PRICES
    if endpoint == "appdetails" and params.get("filters") == "basic":
        aid = params["appids"]
        return {aid: {"success": True, "data": {"name": NAMES.get(aid, "?")}}}
    return None


# ---------------------------------------------------------------------------
print("\n_steam_get_wishlist — validated appids")
# ---------------------------------------------------------------------------
_savedapi = cs._steam_api_get
try:
    cs._steam_api_get = lambda i, m, v, params, timeout=None: WISHLIST
    ids = cs._steam_get_wishlist(GOOD_ID, GOOD_KEY)
    check(ids == ["1086940", "1174180", "413150"], "wishlist appids parsed, non-digit/malformed skipped", ids)
    cs._steam_api_get = lambda *a, **k: None
    check(cs._steam_get_wishlist(GOOD_ID, GOOD_KEY) is None, "GetWishlist fails -> None")
finally:
    cs._steam_api_get = _savedapi


# ---------------------------------------------------------------------------
print("\n_steam_wishlist_payload — only-discounted, names, degrade, cache")
# ---------------------------------------------------------------------------
_saved = {k: getattr(cs, k) for k in ("_steam_get_wishlist", "_steam_store_get")}
try:
    _unconfigure()
    check(cs._steam_wishlist_payload() == {"configured": False}, "no key -> {configured:false}")
    _configure()
    cs._STEAM_WISHLIST_CACHE["ts"] = 0.0
    cs._STEAM_WISHLIST_CACHE["val"] = None
    cs._steam_get_wishlist = lambda sid, key: ["1086940", "1174180", "413150"]
    cs._steam_store_get = _fake_store
    body = cs._steam_wishlist_payload()
    check(body["count"] == 3, "count = full wishlist size", body)
    names = [i["name"] for i in body["on_sale"]]
    check(names == ["Baldur's Gate 3", "Red Dead Redemption 2"], "only discounted, with names (413150 at 0% excluded)", names)
    check(body["on_sale"][1]["discount_percent"] == 67 and body["on_sale"][1]["final"] == 1979, "discount + price carried", body["on_sale"][1])
    check(GOOD_KEY not in json.dumps(body), "wishlist payload never carries the key")

    # BOUNDED fan-out: a huge wishlist price-checks at most WL_CONSIDER and names at most WL_MAX
    calls = {"n": 0}
    big = [str(1000000 + i) for i in range(500)]
    cs._steam_get_wishlist = lambda sid, key: big
    def _count_store(endpoint, params, timeout=None):
        calls["n"] += 1
        if params.get("filters") == "price_overview":
            # everything discounted
            return {a: {"success": True, "data": {"price_overview": {"discount_percent": 25, "final": 100, "initial": 200, "currency": "USD"}}} for a in params["appids"].split(",")}
        return {params["appids"]: {"success": True, "data": {"name": "G"}}}
    cs._steam_store_get = _count_store
    cs._STEAM_WISHLIST_CACHE["ts"] = 0.0
    cs._STEAM_WISHLIST_CACHE["val"] = None
    b2 = cs._steam_wishlist_payload()
    check(len(b2["on_sale"]) == cs._STEAM_WL_MAX, "on_sale capped at WL_MAX (%d)" % cs._STEAM_WL_MAX, len(b2["on_sale"]))
    check(calls["n"] <= 1 + cs._STEAM_WL_MAX, "bounded calls: 1 batch + <= WL_MAX names", calls["n"])
    check(b2["count"] == 500, "count still reports the FULL wishlist size", b2["count"])

    # degrade closed
    cs._steam_get_wishlist = lambda sid, key: None
    cs._STEAM_WISHLIST_CACHE["ts"] = 0.0
    cs._STEAM_WISHLIST_CACHE["val"] = None
    check(cs._steam_wishlist_payload() == {"configured": True, "connected": False}, "wishlist unreadable -> connected:false")
finally:
    for k, v in _saved.items():
        setattr(cs, k, v)
    _unconfigure()


# ---------------------------------------------------------------------------
print("\ncache invalidation on reconfigure (no cross-account bleed)")
# ---------------------------------------------------------------------------
import tempfile
_sc = cs._STEAM_WEBAPI_CONF
_td = tempfile.mkdtemp()
cs._STEAM_WEBAPI_CONF = os.path.join(_td, "s.json")
try:
    cs._STEAM_WISHLIST_CACHE["ts"] = 9e9
    cs._STEAM_WISHLIST_CACHE["val"] = {"count": 999}
    cs._steam_webapi_save(GOOD_ID, GOOD_KEY)
    check(cs._STEAM_WISHLIST_CACHE["val"] is None, "save() wipes wishlist cache (no cross-account bleed)")
    cs._STEAM_WISHLIST_CACHE["val"] = {"count": 1}
    cs._steam_webapi_clear()
    check(cs._STEAM_WISHLIST_CACHE["val"] is None, "clear() wipes wishlist cache")
finally:
    cs._STEAM_WEBAPI_CONF = _sc
    import shutil
    shutil.rmtree(_td, ignore_errors=True)
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


print("\nHTTP — auth gate + happy path")
srv, port = _server(mock=True)
try:
    st, _ = _get(port, "/api/steam/wishlist", token=None)
    check(st == 401, "no token -> 401", st)
    st, body = _get(port, "/api/steam/wishlist")
    check(st == 200 and body.get("count") == 41 and body.get("on_sale", [{}])[0].get("name") == "Baldur's Gate 3",
          "mock -> 200 (41 wishlisted, BG3 on sale)", (st, body))
finally:
    srv.shutdown()

srv, port = _server(mock=False)
try:
    _unconfigure()
    st, body = _get(port, "/api/steam/wishlist")
    check(st == 200 and body == {"configured": False}, "real, no key -> {configured:false}", (st, body))
finally:
    srv.shutdown()

print()
if _fail:
    print("FAILURES: %d" % len(_fail))
    for f in _fail:
        print("  - " + f)
    raise SystemExit(1)
print("all steam wishlist tests passed")
