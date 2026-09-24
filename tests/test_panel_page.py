#!/usr/bin/env python3
"""Tests for the on-box Deck quick panel — GET /panel (docs/memory/project_deck-overlay.md).

Run: python3 tests/test_panel_page.py

WHY THIS EXISTS. /panel EMBEDS the bearer token so the box's own kiosk browser can
call the local API, so — exactly like /pair — it is gated to loopback on TWO axes
(peer IP and Host header, anti-DNS-rebinding). Get either wrong and a LAN peer reads
the box token off /panel. The route-level Host gate below is the point of this file;
the peer-IP gate shares _is_loopback with /pair (covered there). §6: a new endpoint
gets happy-path + rejection coverage.

Server harness mirrors tests/test_pair_page.py:_server.
"""
import http.client
import importlib.util
import os
import sys
import threading
from http.server import ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location(
    "couchsided", os.path.join(ROOT, "agent", "couchsided.py"))
cs = importlib.util.module_from_spec(_spec)
sys.modules["couchsided"] = cs
_spec.loader.exec_module(cs)

FAILURES = []
TOKEN = "t0ken-for-panel-route-tests"


def check(name, got, want):
    if got == want:
        print("  PASS  %s" % name)
    else:
        print("  FAIL  %s (got %r, want %r)" % (name, got, want))
        FAILURES.append(name)


# --- the page itself -------------------------------------------------------

def test_panel_page_embeds_token_and_calls_api():
    print("test_panel_page_embeds_token_and_calls_api")
    tok = "a" * 64
    html = cs.render_panel_page(tok, 8788)
    check("is a full HTML document", html.startswith("<!doctype html>"), True)
    # The token MUST be embedded — that is the whole reason the page is loopback-only.
    check("embeds the bearer token", tok in html, True)
    # It authenticates its API calls with that token.
    check("builds an Authorization: Bearer header", "'Bearer '+T" in html, True)
    check("polls the authed status route", "/api/status" in html, True)
    # Self-contained: no external resources (works on a box with no net).
    check("no external http(s) resources", "http://" not in html and "https://" not in html, True)


def _server():
    """Handler on a random loopback port. Returns (srv, port)."""
    cs.Handler.token = TOKEN
    cs.Handler.token_file = None
    cs.Handler.mock = False
    srv = ThreadingHTTPServer(("127.0.0.1", 0), cs.Handler)
    cs.Handler.port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


def _get(port, path, host_header=None):
    """GET, optionally with a chosen Host header (to exercise the anti-rebinding gate)."""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    conn.putrequest("GET", path, skip_host=(host_header is not None))
    if host_header is not None:
        conn.putheader("Host", host_header)
    conn.endheaders()
    resp = conn.getresponse()
    data = resp.read().decode("utf-8", "replace")
    conn.close()
    return resp.status, data


def test_panel_route_end_to_end():
    print("test_panel_route_end_to_end")
    srv, port = _server()
    try:
        # Happy path: a loopback peer with a loopback Host gets the page + token.
        st, body = _get(port, "/panel")   # http.client sets Host: 127.0.0.1:<port>
        check("loopback GET /panel: 200", st, 200)
        check("loopback GET /panel: serves the token", TOKEN in body, True)
        check("loopback GET /panel: is the panel HTML", "Couchside" in body and "/api/status" in body, True)

        # THE refusal: same loopback socket, but a spoofed Host (DNS-rebinding) —
        # must be 403 and MUST NOT leak the token. This is the gate that keeps the
        # token off a malicious page rebinding attacker.tld -> 127.0.0.1.
        st, body = _get(port, "/panel", host_header="attacker.tld:%d" % port)
        check("foreign Host GET /panel: 403", st, 403)
        check("foreign Host GET /panel: no token leaked", TOKEN in body, False)

        # A trailing slash resolves to the same route (do_GET rstrips it).
        st, _ = _get(port, "/panel/")
        check("GET /panel/ (trailing slash): 200", st, 200)
    finally:
        srv.shutdown()
        srv.server_close()


if __name__ == "__main__":
    for fn in (test_panel_page_embeds_token_and_calls_api,
               test_panel_route_end_to_end):
        fn()
    if FAILURES:
        print("\n%d FAILED: %s" % (len(FAILURES), ", ".join(FAILURES)))
        sys.exit(1)
    print("\nall good")
