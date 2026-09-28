#!/usr/bin/env python3
"""Tests for the OPT-IN Steam Web API integration (agent).

Run: python3 tests/test_steam_webapi.py

The box's ONE outbound internet path. The user stores their own SteamID64 (or a
vanity name) + a free Steam Web API key; the agent may then call
api.steampowered.com to enrich What-to-Play and show the user's own data. This
test proves the properties that matter for a SECRET + an outbound call:

  - VALIDATE, never sanitise (§3.6): SteamID64 = 17 digits (7656119...), key = 32
    hex, vanity = strict charset. Anything else is rejected.
  - The key is a SECRET: stored 0600 in the user's own dir, NEVER returned by the
    status (masked to the last 4), cleared on disconnect.
  - DEGRADE CLOSED (§3.7): any urlopen failure / non-200 / bad JSON -> None; a
    key/profile Steam does not accept -> 400 and NOTHING stored.
  - §6 for a new authed endpoint: happy path, auth failure (401), unknown-input
    rejection (400). §11.2: both the stored and the rejected/absent states seen.
  - No real network: urlopen and the summary probe are stubbed.

Pure stdlib, no pytest.
"""
import http.client
import importlib.util
import json
import os
import stat
import tempfile
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


# ---------------------------------------------------------------------------
print("\nvalidators — reject, never sanitise")
# ---------------------------------------------------------------------------
check(cs._valid_steamid64(GOOD_ID), "a real 17-digit 7656119 id is valid")
for bad in ["7656119796028793", "765611979602879300", "x6561197960287930",
            "12345678901234567", "", None, 76561197960287930]:
    check(not cs._valid_steamid64(bad), "steamid64 rejected: %r" % (bad,))
# str.isdigit() accepts non-ASCII digits; the validator must not (docstring: ASCII).
check(not cs._valid_steamid64("7656119" + "\u0660" * 10), "steamid64 rejects non-ASCII (Arabic-Indic) digits")

check(cs._valid_steam_apikey(GOOD_KEY), "a 32-hex key is valid")
check(cs._valid_steam_apikey("abcdef0123456789abcdef0123456789"), "lowercase hex ok")
for bad in ["0123456789ABCDEF0123456789ABCDE", "0123456789ABCDEF0123456789ABCDEFF",
            "0123456789ABCDEF0123456789ABCDEG", "not a key", "", None, 12345]:
    check(not cs._valid_steam_apikey(bad), "apikey rejected: %r" % (bad,))
check(not cs._valid_steam_apikey("\uff10" * 32), "apikey rejects full-width/non-ASCII digits")

check(cs._valid_steam_vanity("gaben"), "a plain vanity is valid")
check(cs._valid_steam_vanity("My_Name-99"), "underscore/dash/digits ok")
for bad in ["a", "has space", "has/slash", "q?x", "x" * 65, "", None]:
    check(not cs._valid_steam_vanity(bad), "vanity rejected: %r" % (bad,))

# The key must NEVER be shown in full.
m = cs._mask_apikey(GOOD_KEY)
check(m is not None and m.endswith("CDEF") and GOOD_KEY[:-4] not in m and "•" in m,
      "mask shows only the last 4, hides the rest", m)
check(cs._mask_apikey("abc") is None and cs._mask_apikey(None) is None, "mask of a too-short/None -> None")


# ---------------------------------------------------------------------------
print("\nsave / load / clear — user-owned, 0600, degrade closed")
# ---------------------------------------------------------------------------
_saved_conf = cs._STEAM_WEBAPI_CONF
_tmpdir = tempfile.mkdtemp()
cs._STEAM_WEBAPI_CONF = os.path.join(_tmpdir, "sub", "steam_webapi.json")
try:
    cs._steam_webapi_clear()
    check(not cs._steam_webapi_configured(), "starts unconfigured")
    check(cs._steam_webapi_save(GOOD_ID, GOOD_KEY) is True, "save returns True (creates dir)")
    check(os.path.exists(cs._STEAM_WEBAPI_CONF), "config file written")
    mode = stat.S_IMODE(os.stat(cs._STEAM_WEBAPI_CONF).st_mode)
    check(mode == 0o600, "config file is 0600 (owner-only)", oct(mode))
    check(cs._steam_webapi_configured(), "now configured in memory")
    # reload from disk into a cleared memory
    with cs._STEAM_WEBAPI_LOCK:
        cs._STEAM_WEBAPI["steamid64"] = None
        cs._STEAM_WEBAPI["apikey"] = None
    cs._steam_webapi_load()
    check(cs._steam_webapi_configured(), "load() re-reads the stored pair")
    # a garbage file leaves the feature OFF (degrade closed), never raises
    with open(cs._STEAM_WEBAPI_CONF, "w") as fh:
        fh.write("{ not json")
    with cs._STEAM_WEBAPI_LOCK:
        cs._STEAM_WEBAPI["steamid64"] = None
        cs._STEAM_WEBAPI["apikey"] = None
    cs._steam_webapi_load()
    check(not cs._steam_webapi_configured(), "garbage config -> stays off (no raise)")
    # an ill-formed but valid-JSON file (bad id) is also rejected on load
    with open(cs._STEAM_WEBAPI_CONF, "w") as fh:
        json.dump({"steamid64": "nope", "apikey": GOOD_KEY}, fh)
    cs._steam_webapi_load()
    check(not cs._steam_webapi_configured(), "invalid stored id -> stays off")
    # clear deletes the file
    cs._steam_webapi_save(GOOD_ID, GOOD_KEY)
    cs._steam_webapi_clear()
    check(not os.path.exists(cs._STEAM_WEBAPI_CONF), "clear() deletes the file")
    check(not cs._steam_webapi_configured(), "clear() wipes memory")
finally:
    cs._STEAM_WEBAPI_CONF = _saved_conf
    import shutil
    shutil.rmtree(_tmpdir, ignore_errors=True)


# ---------------------------------------------------------------------------
print("\nclient — degrade closed, no key ever surfaced")
# ---------------------------------------------------------------------------
class _FakeResp:
    def __init__(self, status, body):
        self.status = status
        self._body = body.encode() if isinstance(body, str) else body
    def read(self, n=-1):
        return self._body
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False


_real_urlopen = cs.urllib.request.urlopen
try:
    cs.urllib.request.urlopen = lambda req, timeout=None: (_ for _ in ()).throw(OSError("network down"))
    check(cs._steam_api_get("ISteamUser", "GetPlayerSummaries", "0002", {"key": GOOD_KEY, "steamids": GOOD_ID}) is None,
          "urlopen raises -> None (degrade closed)")
    cs.urllib.request.urlopen = lambda req, timeout=None: _FakeResp(500, "err")
    check(cs._steam_api_get("ISteamUser", "GetPlayerSummaries", "0002", {"key": GOOD_KEY}) is None,
          "non-200 -> None")
    cs.urllib.request.urlopen = lambda req, timeout=None: _FakeResp(200, "{ not json")
    check(cs._steam_api_get("ISteamUser", "GetPlayerSummaries", "0002", {"key": GOOD_KEY}) is None,
          "bad JSON -> None")
    cs.urllib.request.urlopen = lambda req, timeout=None: _FakeResp(
        200, json.dumps({"response": {"players": [{"steamid": GOOD_ID, "personaname": "Taylor",
                                                   "avatarmedium": "http://a/x.jpg"}]}}))
    p = cs._steam_get_summary(GOOD_ID, GOOD_KEY)
    check(p is not None and p.get("personaname") == "Taylor", "summary parses the owner's player", p)
    cs.urllib.request.urlopen = lambda req, timeout=None: _FakeResp(
        200, json.dumps({"response": {"success": 1, "steamid": GOOD_ID}}))
    check(cs._steam_resolve_vanity("gaben", GOOD_KEY) == GOOD_ID, "vanity resolves to the id")
    cs.urllib.request.urlopen = lambda req, timeout=None: _FakeResp(
        200, json.dumps({"response": {"success": 42}}))
    check(cs._steam_resolve_vanity("nope", GOOD_KEY) is None, "no-match vanity -> None")
finally:
    cs.urllib.request.urlopen = _real_urlopen


# ---------------------------------------------------------------------------
print("\nstatus — masks the key, both states observed")
# ---------------------------------------------------------------------------
_saved_conf = cs._STEAM_WEBAPI_CONF
_tmpdir = tempfile.mkdtemp()
cs._STEAM_WEBAPI_CONF = os.path.join(_tmpdir, "steam_webapi.json")
_real_summary = cs._steam_get_summary
try:
    cs._steam_webapi_clear()
    check(cs._steam_webapi_status() == {"configured": False}, "unconfigured -> {configured:false}")
    cs._steam_get_summary = lambda sid, key: {"personaname": "Taylor", "avatarmedium": "http://a/x.jpg"}
    cs._steam_webapi_save(GOOD_ID, GOOD_KEY)
    cs._STEAM_SUMMARY_CACHE["ts"] = 0.0
    st = cs._steam_webapi_status()
    blob = json.dumps(st)
    check(st.get("configured") is True and st.get("connected") is True, "configured + connected", st)
    check(st.get("persona") == "Taylor", "persona surfaced", st)
    check(GOOD_KEY not in blob, "FULL KEY never appears in the status", blob)
    check(st.get("apikey_masked", "").endswith("CDEF"), "status carries only the masked key", st)
finally:
    cs._steam_get_summary = _real_summary
    cs._steam_webapi_clear()
    cs._STEAM_WEBAPI_CONF = _saved_conf
    import shutil
    shutil.rmtree(_tmpdir, ignore_errors=True)


# ===========================================================================
# HTTP endpoint — auth + reject + happy (mock and real servers)
# ===========================================================================
def _server(mock):
    cs.Handler.token = TOKEN
    cs.Handler.token_file = None
    cs.Handler.mock = mock
    cs.Handler.port = 0
    srv = ThreadingHTTPServer(("127.0.0.1", 0), cs.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


def _req(method, port, path, obj=None, token=TOKEN):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    headers = {"Content-Type": "application/json"}
    if token is not None:
        headers["Authorization"] = "Bearer " + token
    conn.request(method, path, body=(json.dumps(obj) if obj is not None else None), headers=headers)
    resp = conn.getresponse()
    data = resp.read()
    conn.close()
    try:
        return resp.status, json.loads(data or b"{}")
    except ValueError:
        return resp.status, {}


print("\nHTTP — auth gate (401 without a token)")
srv, port = _server(mock=True)
try:
    st, _ = _req("GET", port, "/api/steam/webapi", token=None)
    check(st == 401, "GET /api/steam/webapi without token -> 401", st)
    st, _ = _req("POST", port, "/api/steam/webapi", {"apikey": GOOD_KEY, "steamid64": GOOD_ID}, token=None)
    check(st == 401, "POST /api/steam/webapi without token -> 401", st)
    st, _ = _req("POST", port, "/api/steam/webapi/disconnect", {}, token=None)
    check(st == 401, "POST disconnect without token -> 401", st)

    print("\nHTTP — mock server: GET shows the setup form, POST connects, disconnect clears")
    st, body = _req("GET", port, "/api/steam/webapi")
    check(st == 200 and body == {"configured": False}, "mock GET -> not configured (setup form)", (st, body))
    st, body = _req("POST", port, "/api/steam/webapi", {"apikey": GOOD_KEY, "steamid64": GOOD_ID})
    check(st == 200 and body.get("connected") is True and body.get("persona") == "Taylor",
          "mock POST valid -> 200 connected", (st, body))
    check(GOOD_KEY not in json.dumps(body), "mock POST response never carries the full key", body)
    st, body = _req("POST", port, "/api/steam/webapi", "not-json-object")
    check(st == 400, "POST with a non-object body -> 400", (st, body))
    st, body = _req("POST", port, "/api/steam/webapi", {"steamid64": GOOD_ID, "apikey": "short"})
    check(st == 400, "POST with a malformed apikey -> 400", (st, body))
    st, body = _req("POST", port, "/api/steam/webapi/disconnect", {})
    check(st == 200 and body == {"configured": False}, "disconnect -> not configured", (st, body))
finally:
    srv.shutdown()

print("\nHTTP — REAL server: stores + masks, rejects a bad pair, never leaks the key")
_saved_conf = cs._STEAM_WEBAPI_CONF
_tmpdir = tempfile.mkdtemp()
cs._STEAM_WEBAPI_CONF = os.path.join(_tmpdir, "steam_webapi.json")
_real_summary = cs._steam_get_summary
srv, port = _server(mock=False)
try:
    cs._steam_webapi_clear()
    # Steam ACCEPTS the pair (stub the probe so there is no real network).
    cs._steam_get_summary = lambda sid, key: {"personaname": "Taylor", "avatarmedium": "http://a/x.jpg"}
    st, body = _req("POST", port, "/api/steam/webapi", {"apikey": GOOD_KEY, "steamid64": GOOD_ID})
    check(st == 200 and body.get("configured") is True and body.get("connected") is True,
          "real POST valid -> 200 stored + connected", (st, body))
    check(GOOD_KEY not in json.dumps(body), "real POST response masks the key", body)
    check(cs._steam_webapi_configured(), "the key is now stored on the box")
    st, body = _req("GET", port, "/api/steam/webapi")
    check(st == 200 and body.get("configured") is True and GOOD_KEY not in json.dumps(body),
          "real GET -> configured, masked (full key absent)", (st, body))
    # provide neither a valid id nor a vanity -> 400, nothing changes
    cs._steam_webapi_clear()
    st, body = _req("POST", port, "/api/steam/webapi", {"apikey": GOOD_KEY})
    check(st == 400 and not cs._steam_webapi_configured(), "no id and no vanity -> 400, nothing stored", (st, body))
    # Steam REJECTS the pair (probe returns None) -> 400, nothing stored
    cs._steam_get_summary = lambda sid, key: None
    st, body = _req("POST", port, "/api/steam/webapi", {"apikey": GOOD_KEY, "steamid64": GOOD_ID})
    check(st == 400 and not cs._steam_webapi_configured(), "Steam rejects the pair -> 400, nothing stored", (st, body))
finally:
    cs._steam_get_summary = _real_summary
    srv.shutdown()
    cs._steam_webapi_clear()
    cs._STEAM_WEBAPI_CONF = _saved_conf
    import shutil
    shutil.rmtree(_tmpdir, ignore_errors=True)


print()
if _fail:
    print("FAILURES: %d" % len(_fail))
    for f in _fail:
        print("  - " + f)
    raise SystemExit(1)
print("all steam webapi tests passed")
