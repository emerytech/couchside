#!/usr/bin/env python3
"""Tests for wishlist price-drop alerts (agent 2.9.127).

Run: python3 tests/test_steam_wl_alerts.py

The box keeps a per-account "last-seen final price" baseline and, on demand, diffs
the current on-sale wishlist against it. Proves:

  - not primed (no baseline yet) -> primed:false, NO alerts (no noisy "everything
    dropped" on first use);
  - primed -> a game cheaper than last-seen OR newly on sale is flagged; an unchanged
    or dearer game is not;
  - at_low is set when the current price is at/below the ITAD all-time low;
  - ack records the CURRENT prices as the new baseline, guarded against an account
    switch mid-write (TOCTOU); baseline stored 0600, corrupt file degrades closed;
  - degrade closed (wishlist unreadable -> connected:false; no key -> configured:false);
  - §6 bearer-gated (401) + mock happy path (200).

No real network. Pure stdlib, no pytest.
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
SID_A = "76561197960287930"
SID_B = "76561198000000009"


def check(cond, label, detail=""):
    print((PASS if cond else FAIL) + "  " + label + ("" if cond else "  <- %s" % (detail,)))
    if not cond:
        _fail.append(label)


def _configure(sid=SID_A):
    with cs._STEAM_WEBAPI_LOCK:
        cs._STEAM_WEBAPI["steamid64"] = sid
        cs._STEAM_WEBAPI["apikey"] = "0123456789abcdef0123456789abcdef"


def _unconfigure():
    with cs._STEAM_WEBAPI_LOCK:
        cs._STEAM_WEBAPI["steamid64"] = None
        cs._STEAM_WEBAPI["apikey"] = None


# current on-sale wishlist the diff runs against
ON_SALE = [
    {"appid": "1086940", "name": "Baldur's Gate 3", "final": 4199, "original": 5999, "discount_percent": 30, "currency": "USD"},
    {"appid": "374320", "name": "DARK SOULS III", "final": 1499, "original": 5999, "discount_percent": 75, "currency": "USD"},
    {"appid": "413150", "name": "Stardew Valley", "final": 1199, "original": 1499, "discount_percent": 20, "currency": "USD"},
]


def _wl(connected=True):
    return {"configured": True, "connected": connected, "count": 40,
            "on_sale": ON_SALE if connected else []}


# ---------------------------------------------------------------------------
print("\nbaseline storage — 0600, corrupt degrades, round-trips")
# ---------------------------------------------------------------------------
_sc = cs._STEAM_WL_WATCH_CONF
_td = tempfile.mkdtemp()
cs._STEAM_WL_WATCH_CONF = os.path.join(_td, "wl.json")
try:
    check(cs._steam_wl_watch_load() == {}, "missing file -> {}")
    cs._steam_wl_watch_save({SID_A: {"374320": 1999}})
    mode = stat.S_IMODE(os.stat(cs._STEAM_WL_WATCH_CONF).st_mode)
    check(mode == 0o600, "baseline file is 0600", oct(mode))
    check(cs._steam_wl_watch_load() == {SID_A: {"374320": 1999}}, "round-trips")
    open(cs._STEAM_WL_WATCH_CONF, "w").write("{ not json")
    check(cs._steam_wl_watch_load() == {}, "corrupt file -> {} (degrade closed)")
finally:
    cs._STEAM_WL_WATCH_CONF = _sc
    import shutil
    shutil.rmtree(_td, ignore_errors=True)


# ---------------------------------------------------------------------------
print("\n_steam_wl_alerts_payload — prime, drop, new, at_low, degrade")
# ---------------------------------------------------------------------------
_saved = {k: getattr(cs, k) for k in ("_steam_wishlist_payload", "_itad_configured", "_itad_lows_payload")}
_sc = cs._STEAM_WL_WATCH_CONF
_td = tempfile.mkdtemp()
cs._STEAM_WL_WATCH_CONF = os.path.join(_td, "wl.json")
try:
    _unconfigure()
    check(cs._steam_wl_alerts_payload() == {"configured": False}, "no key -> {configured:false}")

    _configure()
    cs._itad_configured = lambda: False
    cs._steam_wishlist_payload = lambda: _wl(connected=False)
    check(cs._steam_wl_alerts_payload() == {"configured": True, "connected": False},
          "wishlist unreadable -> connected:false")

    cs._steam_wishlist_payload = lambda: _wl(connected=True)
    # FIRST look: no baseline -> primed:false, NO alerts (no first-use noise)
    b = cs._steam_wl_alerts_payload()
    check(b["primed"] is False and b["count"] == 0, "first look: primed:false, 0 alerts", b)

    # seed the baseline via ack, then a deeper drop + a new game
    cs._steam_wl_ack()
    check(cs._steam_wl_watch_load().get(SID_A, {}).get("374320") == 1499, "ack recorded current finals", cs._steam_wl_watch_load())

    # BG3 gets cheaper (4199 -> 3499), Stardew leaves the seen set then a NEW game appears
    ON_SALE = [
        {"appid": "1086940", "name": "Baldur's Gate 3", "final": 3499, "original": 5999, "discount_percent": 42, "currency": "USD"},
        {"appid": "374320", "name": "DARK SOULS III", "final": 1499, "original": 5999, "discount_percent": 75, "currency": "USD"},
        {"appid": "999999", "name": "New Game", "final": 500, "original": 2000, "discount_percent": 75, "currency": "USD"},
    ]
    b = cs._steam_wl_alerts_payload()
    ids = sorted(a["appid"] for a in b["alerts"])
    check(b["primed"] and ids == ["1086940", "999999"],
          "flags the cheaper game (BG3) + the new one; unchanged (DS3) not flagged", (ids, b))
    bg3 = next(a for a in b["alerts"] if a["appid"] == "1086940")
    check(bg3.get("prev_final") == 4199 and "at_low" not in bg3, "carries prev_final, no at_low without ITAD", bg3)

    # with ITAD: BG3 at/below all-time low -> at_low
    cs._itad_configured = lambda: True
    cs._itad_lows_payload = lambda appids: {"lows": {"1086940": {"amount": 35.00, "currency": "USD"}}}
    b = cs._steam_wl_alerts_payload()
    bg3 = next(a for a in b["alerts"] if a["appid"] == "1086940")
    check(bg3.get("at_low") is True and b["count_low"] == 1, "BG3 at all-time low -> at_low + count_low", b)
finally:
    for k, v in _saved.items():
        setattr(cs, k, v)
    cs._STEAM_WL_WATCH_CONF = _sc
    import shutil
    shutil.rmtree(_td, ignore_errors=True)
    _unconfigure()
    ON_SALE = [
        {"appid": "1086940", "name": "Baldur's Gate 3", "final": 4199, "original": 5999, "discount_percent": 30, "currency": "USD"},
        {"appid": "374320", "name": "DARK SOULS III", "final": 1499, "original": 5999, "discount_percent": 75, "currency": "USD"},
        {"appid": "413150", "name": "Stardew Valley", "final": 1199, "original": 1499, "discount_percent": 20, "currency": "USD"},
    ]


# ---------------------------------------------------------------------------
print("\nack TOCTOU — an account switch mid-ack is not written under the wrong sid")
# ---------------------------------------------------------------------------
_saved2 = {k: getattr(cs, k) for k in ("_steam_wishlist_payload",)}
_sc = cs._STEAM_WL_WATCH_CONF
_td = tempfile.mkdtemp()
cs._STEAM_WL_WATCH_CONF = os.path.join(_td, "wl.json")
try:
    _configure(SID_A)

    def _switch():
        with cs._STEAM_WEBAPI_LOCK:
            cs._STEAM_WEBAPI["steamid64"] = SID_B
        return _wl(connected=True)
    cs._steam_wishlist_payload = _switch
    cs._steam_wl_ack()
    ondisk = cs._steam_wl_watch_load()
    check(SID_A not in ondisk and SID_B not in ondisk,
          "account switched mid-ack -> NOTHING written (sid captured before fetch; guard skips)", ondisk)
finally:
    for k, v in _saved2.items():
        setattr(cs, k, v)
    cs._STEAM_WL_WATCH_CONF = _sc
    import shutil
    shutil.rmtree(_td, ignore_errors=True)
    _unconfigure()


# ===========================================================================
# HTTP — bearer gate + mock
# ===========================================================================
def _server(mock):
    cs.Handler.token = TOKEN
    cs.Handler.token_file = None
    cs.Handler.mock = mock
    cs.Handler.port = 0
    srv = ThreadingHTTPServer(("127.0.0.1", 0), cs.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


def _req(port, method, path, token=TOKEN):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    headers = {"Authorization": "Bearer " + token} if token is not None else {}
    conn.request(method, path, headers=headers)
    resp = conn.getresponse()
    raw = resp.read()
    conn.close()
    try:
        return resp.status, json.loads(raw or b"{}")
    except ValueError:
        return resp.status, {}


print("\nHTTP — auth gate + mock")
srv, port = _server(mock=True)
try:
    st, _ = _req(port, "GET", "/api/steam/wishlist/alerts", token=None)
    check(st == 401, "no token -> 401", st)
    st, b = _req(port, "GET", "/api/steam/wishlist/alerts")
    check(st == 200 and b.get("count") == 2 and b.get("count_low") == 1, "mock alerts 200", (st, b))
    st, b = _req(port, "POST", "/api/steam/wishlist/alerts/ack")
    check(st == 200 and b.get("ok") is True, "mock ack 200", (st, b))
finally:
    srv.shutdown()

srv, port = _server(mock=False)
try:
    _unconfigure()
    st, b = _req(port, "GET", "/api/steam/wishlist/alerts")
    check(st == 200 and b == {"configured": False}, "real, no key -> configured:false", (st, b))
finally:
    srv.shutdown()

print()
if _fail:
    print("FAILURES: %d" % len(_fail))
    for f in _fail:
        print("  - " + f)
    raise SystemExit(1)
print("all wishlist-alert tests passed")
