#!/usr/bin/env python3
"""Tests for the "On sale now" deals row (agent, Phase 1).

Run: python3 tests/test_steam_deals.py

GET /api/steam/deals: current Steam specials from the KEYLESS public Storefront
(store.steampowered.com/api/featuredcategories). A second fixed outbound host, no
key, still gated on the Steam integration being ON. Proves:

  - the region is always a safe [a-z]{2} from the box locale (never client input);
  - the Storefront client _steam_store_get uses a FIXED host + fixed endpoint +
    urlencoded params (no SSRF), and degrades closed on any failure;
  - malformed featured items are skipped, nothing raises;
  - only-when-configured; §6 bearer-gated (401) + happy path (200); no key on the
    Storefront path.

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
    cs._STEAM_DEALS_CACHE["ts"] = 0.0
    cs._STEAM_DEALS_CACHE["val"] = None


FEATURED = {"specials": {"items": [
    {"id": 1245620, "name": "Elden Ring", "discount_percent": 30, "final_price": 4199,
     "original_price": 5999, "currency": "USD"},
    {"id": 1091500, "name": "Cyberpunk 2077", "discount_percent": 50, "final_price": 2999,
     "original_price": 5999, "currency": "USD"},
    None,  # malformed -> skipped
    {"name": "no id -> skipped"},
    {"id": 413150, "name": "Stardew Valley", "discount_percent": "x", "final_price": None,
     "original_price": 1499, "currency": "USD"},  # bad numeric fields tolerated
]}}


# ---------------------------------------------------------------------------
print("\n_steam_country — always [a-z]{2}, from locale or 'us'")
# ---------------------------------------------------------------------------
_env = dict(os.environ)
try:
    for var in ("LC_ALL", "LC_MONETARY", "LANG"):
        os.environ.pop(var, None)
    os.environ["LANG"] = "en_US.UTF-8"
    check(cs._steam_country() == "us", "en_US.UTF-8 -> us")
    os.environ["LANG"] = "de_DE.UTF-8"
    check(cs._steam_country() == "de", "de_DE -> de")
    os.environ["LANG"] = "C"
    for v in ("LC_ALL", "LC_MONETARY"):
        os.environ.pop(v, None)
    check(cs._steam_country() == "us", "no country in locale -> us")
    import re as _re
    os.environ["LANG"] = "en_GB.UTF-8"
    cc = cs._steam_country()
    check(bool(_re.fullmatch(r"[a-z]{2}", cc)), "result is always [a-z]{2}", cc)
finally:
    for k in ("LC_ALL", "LC_MONETARY", "LANG"):
        os.environ.pop(k, None)
    os.environ.update({k: v for k, v in _env.items() if k in ("LC_ALL", "LC_MONETARY", "LANG")})


# ---------------------------------------------------------------------------
print("\n_steam_store_get — fixed host, degrade closed")
# ---------------------------------------------------------------------------
class _FakeResp:
    def __init__(self, status, body):
        self.status = status
        self._b = body.encode() if isinstance(body, str) else body
    def read(self, n=-1):
        return self._b
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False


_seen = {}
_real = cs.urllib.request.urlopen
try:
    def _cap(req, timeout=None):
        _seen["url"] = req.full_url
        return _FakeResp(200, json.dumps(FEATURED))
    cs.urllib.request.urlopen = _cap
    d = cs._steam_store_get("featuredcategories", {"cc": "us", "l": "english"})
    check(d is not None and "specials" in d, "store get returns parsed JSON", d and list(d))
    check(_seen["url"].startswith("https://store.steampowered.com/api/featuredcategories?"),
          "fixed HTTPS host + endpoint", _seen.get("url"))
    check("key=" not in _seen["url"] and GOOD_KEY not in _seen["url"], "no key on the Storefront request", _seen.get("url"))
    cs.urllib.request.urlopen = lambda req, timeout=None: (_ for _ in ()).throw(OSError("down"))
    check(cs._steam_store_get("featuredcategories", {"cc": "us"}) is None, "urlopen raises -> None")
    cs.urllib.request.urlopen = lambda req, timeout=None: _FakeResp(500, "err")
    check(cs._steam_store_get("featuredcategories", {"cc": "us"}) is None, "non-200 -> None")
    cs.urllib.request.urlopen = lambda req, timeout=None: _FakeResp(200, "{bad")
    check(cs._steam_store_get("featuredcategories", {"cc": "us"}) is None, "bad JSON -> None")
finally:
    cs.urllib.request.urlopen = _real


# ---------------------------------------------------------------------------
print("\n_steam_featured / _steam_deals_payload")
# ---------------------------------------------------------------------------
_savedsg = cs._steam_store_get
try:
    cs._steam_store_get = lambda endpoint, params, timeout=None: FEATURED
    items = cs._steam_featured("us")
    check([i["name"] for i in items] == ["Elden Ring", "Cyberpunk 2077", "Stardew Valley"],
          "featured skips malformed items (None / no-id)", [i["name"] for i in items])
    check(items[0]["discount_percent"] == 30 and items[0]["final"] == 4199, "prices/discount parsed (cents)", items[0])
    check(items[2]["discount_percent"] == 0 and items[2]["final"] == 0, "bad numeric fields -> 0 (no raise)", items[2])

    _configure()
    cs._STEAM_DEALS_CACHE["ts"] = 0.0
    cs._STEAM_DEALS_CACHE["val"] = None
    body = cs._steam_deals_payload()
    check(body["configured"] is True and body["connected"] is True and len(body["items"]) == 3,
          "deals payload -> items", (body.get("configured"), len(body.get("items", []))))
    check(GOOD_KEY not in json.dumps(body), "deals payload never carries the key")
    # unreachable -> connected:false
    cs._STEAM_DEALS_CACHE["ts"] = 0.0
    cs._STEAM_DEALS_CACHE["val"] = None
    cs._steam_store_get = lambda endpoint, params, timeout=None: None
    check(cs._steam_deals_payload() == {"configured": True, "connected": False}, "Storefront unreachable -> connected:false")
    _unconfigure()
    check(cs._steam_deals_payload() == {"configured": False}, "no key -> {configured:false} (gated on opt-in)")
finally:
    cs._steam_store_get = _savedsg
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
    st, _ = _get(port, "/api/steam/deals", token=None)
    check(st == 401, "/api/steam/deals without token -> 401", st)
    st, body = _get(port, "/api/steam/deals")
    check(st == 200 and body.get("items", [{}])[0].get("name") == "Elden Ring" and body["items"][0]["discount_percent"] == 30,
          "mock deals -> 200 (Elden Ring 30%)", (st, body.get("items", [{}])[0] if body.get("items") else body))
finally:
    srv.shutdown()

srv, port = _server(mock=False)
try:
    _unconfigure()
    st, body = _get(port, "/api/steam/deals")
    check(st == 200 and body == {"configured": False}, "real deals, no key -> {configured:false}", (st, body))
finally:
    srv.shutdown()

print()
if _fail:
    print("FAILURES: %d" % len(_fail))
    for f in _fail:
        print("  - " + f)
    raise SystemExit(1)
print("all steam deals tests passed")
