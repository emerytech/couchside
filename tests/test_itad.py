#!/usr/bin/env python3
"""Tests for the opt-in IsThereAnyDeal (ITAD) price-history integration (agent 2.9.125).

Run: python3 tests/test_itad.py

ITAD powers the "all-time low" badge on the deals + wishlist rows. It is a SECOND
third-party API behind its OWN opt-in key. These pin:

  - validators reject anything but a well-formed key / ITAD UUID (ASCII, no separators);
  - the secret key rides in the ITAD-API-Key HEADER, NEVER the URL, and never any payload;
  - key stored 0600 in the user's own dir; corrupt/missing file degrades to "off";
  - the historylow response is parsed defensively across ITAD's shape variants;
  - GET /api/itad/lows resolves appids -> ids, batches ONE historylow call, bounds the
    fan-out, caches, omits games with no low, and degrades closed;
  - the appids query param is validated to digits (reject, never sanitise);
  - §6 bearer-gated (401) + happy path (200); the full key never appears anywhere.

No real network. Pure stdlib, no pytest.
"""
import http.client
import importlib.util
import json
import os
import stat
import tempfile
import threading
import urllib.request
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
GOOD_KEY = "0123456789abcdef0123456789abcdef"
UUID_A = "01849783-6a26-7147-ab32-71804ca47e8e"
UUID_B = "0184aaaa-bbbb-cccc-dddd-eeeeeeeeeeee"


def check(cond, label, detail=""):
    print((PASS if cond else FAIL) + "  " + label + ("" if cond else "  <- %s" % (detail,)))
    if not cond:
        _fail.append(label)


# ---------------------------------------------------------------------------
print("\nvalidators — reject anything but a well-formed key / UUID")
# ---------------------------------------------------------------------------
check(cs._valid_itad_apikey(GOOD_KEY), "32-hex key accepted")
check(cs._valid_itad_apikey("A" * 16) and cs._valid_itad_apikey("z9" * 40), "16..80 alnum accepted")
check(not cs._valid_itad_apikey("short"), "too-short rejected")
check(not cs._valid_itad_apikey("has space" + "x" * 20), "space rejected")
check(not cs._valid_itad_apikey("key/with?sep" + "x" * 10), "separator chars rejected")
check(not cs._valid_itad_apikey("٠" * 20), "unicode digits rejected (ASCII-only)")
check(cs._valid_itad_id(UUID_A), "UUID accepted")
check(not cs._valid_itad_id("not-a-uuid"), "non-UUID rejected")
check(not cs._valid_itad_id(UUID_A + "/x"), "UUID with separator rejected")


# ---------------------------------------------------------------------------
print("\n_itad_request — key in the ITAD-API-Key HEADER, never the URL")
# ---------------------------------------------------------------------------
_saved_open = cs._ITAD_OPENER.open
captured = {}


class _Resp:
    status = 200

    def __init__(self, payload):
        self._b = json.dumps(payload).encode()

    def read(self, n=-1):
        return self._b

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


try:
    def _fake_urlopen(req, timeout=None):
        captured["url"] = req.full_url
        captured["headers"] = dict(req.header_items())
        captured["method"] = req.get_method()
        captured["body"] = req.data
        return _Resp({"found": True, "game": {"id": UUID_A}})
    cs._ITAD_OPENER.open = _fake_urlopen

    d = cs._itad_request("GET", "games/lookup/v1", {"appid": "730"}, apikey=GOOD_KEY)
    check(d == {"found": True, "game": {"id": UUID_A}}, "request returns parsed JSON")
    check(GOOD_KEY not in captured["url"], "secret key is NOT in the URL", captured["url"])
    hdrs = {k.lower(): v for k, v in captured["headers"].items()}
    check(hdrs.get("itad-api-key") == GOOD_KEY, "key rides in the ITAD-API-Key header", hdrs)
    check(captured["url"].startswith("https://api.isthereanydeal.com/games/lookup/v1?"),
          "fixed host + fixed path", captured["url"])

    # POST carries the validated JSON list as the body
    cs._itad_request("POST", "games/historylow/v1", {"country": "us"}, json_body=[UUID_A, UUID_B], apikey=GOOD_KEY)
    check(captured["method"] == "POST" and json.loads(captured["body"]) == [UUID_A, UUID_B],
          "POST body is the JSON id list", captured["body"])
    check(GOOD_KEY not in (captured["body"] or b"").decode(), "key never in the POST body")

    # degrade closed on any transport failure
    def _boom(req, timeout=None):
        raise OSError("network down")
    cs._ITAD_OPENER.open = _boom
    check(cs._itad_request("GET", "games/lookup/v1", {"appid": "730"}, apikey=GOOD_KEY) is None,
          "transport failure -> None (degrade closed)")
finally:
    cs._ITAD_OPENER.open = _saved_open


# ---------------------------------------------------------------------------
print("\n_itad_extract_lows — parses ITAD's shape variants, degrades closed")
# ---------------------------------------------------------------------------
keyed = {UUID_A: {"price": {"amount": 4.99, "currency": "USD"}, "shop": {"id": 61, "name": "Steam"}, "timestamp": "2023-11-24T00:00:00Z"}}
nested = {"games": {"historylow": {UUID_B: {"price": {"amount": 9.5, "currency": "EUR"}, "timestamp": "2024-01-02"}}}}
listed = [{"id": UUID_A, "low": {"amount": 1.0, "currency": "USD"}}]
r1 = cs._itad_extract_lows(keyed)
check(r1.get(UUID_A, {}).get("amount") == 4.99 and r1[UUID_A]["shop"] == "Steam" and r1[UUID_A]["date"] == "2023-11-24",
      "object-keyed-by-uuid parsed (amount/shop/date)", r1)
r2 = cs._itad_extract_lows(nested)
check(r2.get(UUID_B, {}).get("amount") == 9.5 and r2[UUID_B]["currency"] == "EUR", "games.historylow form parsed", r2)
r3 = cs._itad_extract_lows(listed)
check(r3.get(UUID_A, {}).get("amount") == 1.0, "list-of-{id,low} form parsed", r3)
check(cs._itad_extract_lows({UUID_A: {"price": {"amount": "bad"}}}) == {}, "non-numeric amount skipped")
check(cs._itad_extract_lows("garbage") == {}, "garbage -> {} (never raises)")
check(cs._itad_extract_lows({UUID_A: {"price": {"amount": float("nan")}}}) == {}, "NaN amount omitted (would poison json)")
check(cs._itad_extract_lows({UUID_A: {"price": {"amount": float("inf")}}}) == {}, "Inf amount omitted")
_mixed = cs._itad_extract_lows({UUID_A: {"price": {"amount": float("nan")}}, UUID_B: {"price": {"amount": 3.5, "currency": "USD"}}})
check(_mixed == {UUID_B: {"amount": 3.5, "currency": "USD"}}, "a bad amount drops ONLY that game, not the whole body", _mixed)
import json as _json
_json.dumps(_mixed)  # must be valid JSON (no NaN/Infinity tokens)


# ---------------------------------------------------------------------------
print("\n_itad_lows_payload — resolve, batch, bound, cache, omit, degrade")
# ---------------------------------------------------------------------------
_saved = {k: getattr(cs, k) for k in ("_itad_lookup_id", "_itad_historylow", "_itad_configured")}
try:
    cs._itad_configured = lambda: False
    check(cs._itad_lows_payload(["730"]) == {"configured": False}, "no key -> {configured:false}")

    cs._itad_configured = lambda: True
    cs._ITAD_ID_CACHE.clear()
    cs._ITAD_LOW_CACHE.clear()
    id_for = {"413150": UUID_A, "1245620": UUID_B, "999999": None}
    cs._itad_lookup_id = lambda a: id_for.get(a)
    hits = {"n": 0}

    def _fake_hl(ids, cc):
        hits["n"] += 1
        return {UUID_A: {"amount": 4.99, "currency": "USD"}}  # only A has a low
    cs._itad_historylow = _fake_hl

    body = cs._itad_lows_payload(["413150", "1245620", "999999"])
    check(body["configured"] and body["connected"], "configured+connected", body)
    check("413150" in body["lows"] and body["lows"]["413150"]["amount"] == 4.99, "resolved appid carries its low", body["lows"])
    check("1245620" not in body["lows"], "appid ITAD has no low for is omitted (B)", body["lows"])
    check("999999" not in body["lows"], "unresolvable appid omitted", body["lows"])
    check(hits["n"] == 1, "ONE batched historylow call for all ids", hits["n"])

    # second call served from the low cache (no new historylow)
    cs._itad_lows_payload(["413150", "1245620"])
    check(hits["n"] == 1, "second call hits the low cache (no extra request)", hits["n"])

    # bound the appid->id resolves
    seen = {"n": 0}
    def _count_lookup(a):
        seen["n"] += 1
        return None
    cs._itad_lookup_id = _count_lookup
    cs._ITAD_LOW_CACHE.clear()
    cs._itad_lows_payload([str(1000 + i) for i in range(80)])
    check(seen["n"] <= cs._ITAD_MAX_LOOKUPS, "appid resolves bounded to _ITAD_MAX_LOOKUPS (%d)" % cs._ITAD_MAX_LOOKUPS, seen["n"])

    # degrade closed: historylow request fails, nothing cached to fall back on
    cs._ITAD_ID_CACHE.clear()
    cs._ITAD_LOW_CACHE.clear()
    cs._itad_lookup_id = lambda a: UUID_A if a == "413150" else None
    cs._itad_historylow = lambda ids, cc: None
    check(cs._itad_lows_payload(["413150"]) == {"configured": True, "connected": False},
          "historylow failure -> connected:false")
    check(GOOD_KEY not in json.dumps(cs.mock_itad_lows_payload(["413150"])), "lows payload never carries a key")
finally:
    for k, v in _saved.items():
        setattr(cs, k, v)
    cs._ITAD_ID_CACHE.clear()
    cs._ITAD_LOW_CACHE.clear()


# ---------------------------------------------------------------------------
print("\nkey storage — 0600, corrupt file degrades, round-trip, masked status")
# ---------------------------------------------------------------------------
_sc = cs._ITAD_CONF
_td = tempfile.mkdtemp()
cs._ITAD_CONF = os.path.join(_td, "itad.json")
try:
    cs._itad_clear()
    check(cs._itad_status() == {"configured": False}, "no key -> status configured:false")
    check(cs._itad_save(GOOD_KEY), "save returns True")
    mode = stat.S_IMODE(os.stat(cs._ITAD_CONF).st_mode)
    check(mode == 0o600, "key file is 0600", oct(mode))
    st = cs._itad_status()
    check(st["configured"] and st["apikey_masked"].endswith(GOOD_KEY[-4:]) and GOOD_KEY not in json.dumps(st),
          "status masks the key (last 4 only), never the whole key", st)
    cs._ITAD["apikey"] = None
    cs._itad_load()
    check(cs._itad_configured(), "load() restores the saved key")
    open(cs._ITAD_CONF, "w").write("{ not json")
    cs._ITAD["apikey"] = None
    cs._itad_load()
    check(not cs._itad_configured(), "corrupt file -> stays off (degrade closed)")
    cs._itad_save(GOOD_KEY)
    cs._itad_clear()
    check(not cs._itad_configured() and not os.path.exists(cs._ITAD_CONF), "clear wipes memory + file")
finally:
    cs._ITAD_CONF = _sc
    import shutil
    shutil.rmtree(_td, ignore_errors=True)
    with cs._ITAD_LOCK:
        cs._ITAD["apikey"] = None


# ---------------------------------------------------------------------------
print("\n_itad_request — a redirect is NOT followed (the key never leaves the host)")
# ---------------------------------------------------------------------------
from http.server import BaseHTTPRequestHandler
_leak = {"hit": False, "saw_key": False}


class _RedirHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/leak"):
            _leak["hit"] = True
            _leak["saw_key"] = self.headers.get("ITAD-API-Key") is not None
            self.send_response(200); self.end_headers(); self.wfile.write(b"{}")
            return
        # anything else -> redirect to another path on this host
        self.send_response(302)
        self.send_header("Location", "http://%s:%d/leak" % self.server.server_address)
        self.end_headers()

    def log_message(self, *a):
        pass


_rsrv = ThreadingHTTPServer(("127.0.0.1", 0), _RedirHandler)
threading.Thread(target=_rsrv.serve_forever, daemon=True).start()
_savedhost = cs._ITAD_HOST
try:
    cs._ITAD_HOST = "http://127.0.0.1:%d" % _rsrv.server_address[1]
    out = cs._itad_request("GET", "games/lookup/v1", {"appid": "730"}, apikey=GOOD_KEY)
    check(out is None, "3xx -> None (redirect refused, degrade closed)", out)
    check(not _leak["hit"], "the redirect target was NEVER requested (key not re-sent)", _leak)
finally:
    cs._ITAD_HOST = _savedhost
    _rsrv.shutdown()


# ===========================================================================
# HTTP — bearer gate + happy path + set/disconnect
# ===========================================================================
def _server(mock):
    cs.Handler.token = TOKEN
    cs.Handler.token_file = None
    cs.Handler.mock = mock
    cs.Handler.port = 0
    srv = ThreadingHTTPServer(("127.0.0.1", 0), cs.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


def _req(port, method, path, token=TOKEN, body=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    headers = {"Authorization": "Bearer " + token} if token is not None else {}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    conn.request(method, path, body=data, headers=headers)
    resp = conn.getresponse()
    raw = resp.read()
    conn.close()
    try:
        return resp.status, json.loads(raw or b"{}")
    except ValueError:
        return resp.status, {}


print("\nHTTP — auth gate + mock happy path")
srv, port = _server(mock=True)
try:
    st, _ = _req(port, "GET", "/api/itad", token=None)
    check(st == 401, "GET /api/itad no token -> 401", st)
    st, b = _req(port, "GET", "/api/itad")
    check(st == 200 and b.get("configured") is True and "CD34" in (b.get("apikey_masked") or ""), "mock status 200", (st, b))
    st, b = _req(port, "GET", "/api/itad/lows?appids=413150,1245620")
    check(st == 200 and "413150" in b.get("lows", {}), "mock lows 200", (st, b))
    st, b = _req(port, "GET", "/api/itad/lows?appids=abc")
    check(st == 400, "non-numeric appid -> 400 (reject, not sanitise)", (st, b))
    st, b = _req(port, "GET", "/api/itad/lows?appids=")
    check(st == 400, "empty appids -> 400", (st, b))
    st, b = _req(port, "POST", "/api/itad", body={"apikey": GOOD_KEY})
    check(st == 200 and b.get("configured") is True, "mock POST set key 200", (st, b))
    st, b = _req(port, "POST", "/api/itad", body={"apikey": "short"})
    check(st == 400, "POST bad key -> 400", (st, b))
    st, b = _req(port, "POST", "/api/itad/disconnect")
    check(st == 200 and b == {"configured": False}, "disconnect 200 configured:false", (st, b))
finally:
    srv.shutdown()

srv, port = _server(mock=False)
try:
    with cs._ITAD_LOCK:
        cs._ITAD["apikey"] = None
    st, b = _req(port, "GET", "/api/itad")
    check(st == 200 and b == {"configured": False}, "real, no key -> configured:false", (st, b))
    st, b = _req(port, "GET", "/api/itad/lows?appids=730")
    check(st == 200 and b == {"configured": False}, "real lows, no key -> configured:false", (st, b))
finally:
    srv.shutdown()

print()
if _fail:
    print("FAILURES: %d" % len(_fail))
    for f in _fail:
        print("  - " + f)
    raise SystemExit(1)
print("all ITAD tests passed")
