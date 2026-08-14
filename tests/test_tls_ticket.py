#!/usr/bin/env python3
"""Short-lived TLS tickets (P5) — POST /api/ticket + ?ticket= on un-pinnable loads.

Run: python3 tests/test_tls_ticket.py

The app pins its own TLS socket for the API/WS, but the native <Image> loader and
the streamed uploader cannot pin a self-signed cert. Rather than put the bearer
token on those cleartext requests, the app mints a SHORT-LIVED ticket over the
pinned channel and passes ?ticket=. This proves the ticket is a strictly weaker
credential than the token:

  * mint is BEARER-GATED (401 without the token) — a ticket can't bootstrap a ticket.
  * a valid ticket authorizes an IMAGE GET (?ticket=) but NOT a control route.
  * a single-use ('once') ticket is BURNED on first use — a sniffed upload URL
    cannot be replayed.
  * expired / unknown / empty tickets are refused (degrade closed).

Pure stdlib, no pytest.
"""
import http.client
import importlib.util
import json
import os
import threading
import time
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


def check(cond, label, detail=""):
    print((PASS if cond else FAIL) + "  " + label + ("" if cond else "  <- %s" % (detail,)))
    if not cond:
        _fail.append(label)


# ---- ticket lifecycle (pure) -----------------------------------------------

def test_ticket_lifecycle():
    t = cs._mint_ticket(once=False)
    check(cs._ticket_ok(t) and cs._ticket_ok(t), "multi-use ticket validates repeatedly", t)

    o = cs._mint_ticket(once=True)
    first = cs._ticket_ok(o)
    second = cs._ticket_ok(o)
    check(first and not second, "single-use ticket is CONSUMED after one use", (first, second))

    check(not cs._ticket_ok(""), "empty ticket refused")
    check(not cs._ticket_ok("deadbeef" * 4), "unknown ticket refused")

    # Expired: mint then force its expiry into the past.
    e = cs._mint_ticket()
    with cs._TICKETS_LOCK:
        cs._TICKETS[e]["exp"] = time.time() - 1
    check(not cs._ticket_ok(e), "expired ticket refused")
    with cs._TICKETS_LOCK:
        check(e not in cs._TICKETS, "expired ticket is pruned on access")


# ---- live endpoint + image-route acceptance --------------------------------

class _QuietServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        import ssl
        import sys
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionError, ssl.SSLError, OSError)):
            return
        super().handle_error(request, client_address)


def _serve():
    cs.Handler.token = TOKEN
    cs.Handler.token_file = None
    cs.Handler.mock = True
    cs.Handler.tls_info = None
    srv = _QuietServer(("127.0.0.1", 0), cs.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


def _req(port, method, path, token=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    headers = {"Connection": "close"}
    if token:
        headers["Authorization"] = "Bearer " + token
    conn.request(method, path, headers=headers)
    resp = conn.getresponse()
    body = resp.read()
    conn.close()
    try:
        return resp.status, json.loads(body or b"{}")
    except ValueError:
        return resp.status, {}


def test_endpoint_and_image_auth():
    srv, port = _serve()
    try:
        # mint is bearer-gated
        st, _ = _req(port, "POST", "/api/ticket", token=None)
        check(st == 401, "POST /api/ticket without token -> 401", st)
        st, body = _req(port, "POST", "/api/ticket", token=TOKEN)
        ticket = body.get("ticket", "")
        check(st == 200 and len(ticket) == 32, "POST /api/ticket with token -> 200 + ticket", (st, body))

        # a valid ticket authorizes an IMAGE GET (?ticket=): _authorized_image
        # passes, so we DON'T get a 401 (404/200 depending on cover presence).
        st, _ = _req(port, "GET", "/api/steam/123/cover?ticket=" + ticket)
        check(st != 401, "valid ticket authorizes /api/steam/<id>/cover (not 401)", st)
        # a garbage ticket does NOT authorize the image
        st, _ = _req(port, "GET", "/api/steam/123/cover?ticket=" + ("00" * 16))
        check(st == 401, "garbage ticket on cover -> 401", st)

        # a ticket must NOT satisfy a control route (state-changing): the query
        # form is scoped to image GETs only.
        st, _ = _req(port, "GET", "/api/status?ticket=" + ticket)
        check(st == 401, "ticket does NOT authorize /api/status (control) -> 401", st)

        # single-use upload ticket: valid once (upload handler runs), then burned.
        st, b = _req(port, "POST", "/api/ticket?once=1", token=TOKEN)
        up = b.get("ticket", "")
        st1, _ = _req(port, "POST", "/api/upload?name=x.bin&ticket=" + up)
        st2, _ = _req(port, "POST", "/api/upload?name=x.bin&ticket=" + up)
        # first use is NOT a 401 (handler reached); the second, burned, IS a 401.
        check(st1 != 401 and st2 == 401,
              "single-use upload ticket accepted once then refused (no replay)", (st1, st2))
    finally:
        srv.shutdown()


if __name__ == "__main__":
    test_ticket_lifecycle()
    test_endpoint_and_image_auth()
    print()
    if _fail:
        print("FAILED: %d" % len(_fail))
        for f in _fail:
            print("  - " + f)
        raise SystemExit(1)
    print("all TLS ticket tests passed")
