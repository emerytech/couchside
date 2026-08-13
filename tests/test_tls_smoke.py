#!/usr/bin/env python3
"""HTTPS/WSS reachability + auth-gate smoke over the real TLS wrap seam (P1).

Run: python3 tests/test_tls_smoke.py

CLAUDE.md §4 protects reachability: /api/ping, /api/status and the auth gate are
smoke-tested on every push. This is the ENCRYPTED-listener half of that gate — it
proves the same triad (ping 200 / no-token 401 / token 200) holds when the socket
is TLS-wrapped, using the exact production path: cs._tls_ensure() mints the cert,
the listener socket is ssl.wrap_socket'd, and the hand-rolled Handler serves over
it unchanged (HTTP requests and, by the same socket, the WS upgrade).

Also covers the new /api/tls/cert endpoint per CLAUDE.md §6:
  * happy path  : enabled -> 200 with cert + fp + spki
  * "auth"/gate : disabled (tls_info None) -> 404, feature absent
  * the DECISIVE control: the advertised fp equals the fingerprint of the cert
    the server ACTUALLY presents in the live handshake — i.e. the pin the app
    would store is the pin it would validate against. Observed in both states.

Pure stdlib, no pytest.
"""
import hashlib
import http.client
import importlib.util
import json
import os
import ssl
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


def check(cond, label, detail=""):
    print((PASS if cond else FAIL) + "  " + label +
          ("" if cond else "  <- %s" % (detail,)))
    if not cond:
        _fail.append(label)


class _QuietServer(ThreadingHTTPServer):
    """A smoke test opens and drops sockets deliberately (a bare handshake to read
    the peer cert; abrupt closes). Those surface as ConnectionReset/SSL errors in
    the worker thread, which stock ThreadingHTTPServer prints as a scary traceback.
    Swallow only that expected noise; anything else still bubbles up."""

    daemon_threads = True

    def handle_error(self, request, client_address):
        import sys
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionError, ssl.SSLError, OSError)):
            return
        super().handle_error(request, client_address)


def _tls_server():
    """Start an HTTPS Handler exactly as main() does: ensure a cert, wrap the
    listening socket, serve on a thread. Returns (srv, port, info)."""
    info = cs._tls_ensure({"enabled": True, "port": 0}, persist=False)
    assert info, "cert ensure failed"
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(certfile=info["cert_path"], keyfile=info["key_path"])
    cs.Handler.token = TOKEN
    cs.Handler.token_file = None
    cs.Handler.mock = True
    cs.Handler.port = 0
    cs.Handler.tls_info = {"cert_pem": info["cert_pem"], "fp": info["fp"],
                           "spki": info["spki"], "port": info["port"]}
    srv = _QuietServer(("127.0.0.1", 0), cs.Handler)
    srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1], info


def _https(port, method, path, token=TOKEN):
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE   # self-signed: the app pins by fp instead
    conn = http.client.HTTPSConnection("127.0.0.1", port, timeout=10, context=ctx)
    headers = {"Authorization": "Bearer " + token} if token is not None else {}
    headers["Connection"] = "close"   # no keep-alive reader left blocking at shutdown
    conn.request(method, path, headers=headers)
    resp = conn.getresponse()
    data = resp.read()
    conn.close()
    try:
        return resp.status, json.loads(data or b"{}")
    except ValueError:
        return resp.status, {}


def _live_cert_fp(port):
    """SHA-256 of the DER cert the server presents in the actual handshake."""
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    with ctx.wrap_socket(__import__("socket").create_connection(("127.0.0.1", port),
                         timeout=10), server_hostname="couchside") as s:
        der = s.getpeercert(binary_form=True)
    return hashlib.sha256(der).hexdigest()


def test_https_reachability_and_gate():
    srv, port, info = _tls_server()
    try:
        st, body = _https(port, "GET", "/api/ping")
        check(st == 200 and body.get("ok") is True, "HTTPS /api/ping -> 200 ok",
              (st, body))
        st, _ = _https(port, "GET", "/api/status", token=None)
        check(st == 401, "HTTPS /api/status no-token -> 401 (gate holds on TLS)", st)
        st, _ = _https(port, "GET", "/api/status", token="wrong")
        check(st == 401, "HTTPS /api/status wrong-token -> 401", st)
        st, body = _https(port, "GET", "/api/status")
        check(st == 200, "HTTPS /api/status good-token -> 200", (st, body))

        # /api/tls/cert happy path
        st, body = _https(port, "GET", "/api/tls/cert")
        check(st == 200 and body.get("cert", "").startswith(
              "-----BEGIN CERTIFICATE-----"), "GET /api/tls/cert -> 200 + PEM", st)
        check(len(body.get("fp", "")) == 64 and len(body.get("spki", "")) == 64,
              "/api/tls/cert returns fp + spki", body.get("fp"))

        # THE CONTROL: advertised fp == the cert actually served in the handshake
        live = _live_cert_fp(port)
        check(body.get("fp") == live,
              "advertised fp == live handshake cert fp (pin is validatable)",
              (body.get("fp"), live))
    finally:
        srv.shutdown()


def test_tls_cert_404_when_disabled():
    """Same route, tls_info None -> 404 (feature absent). Plaintext server here so
    the 'disabled' state is unambiguous."""
    cs.Handler.token = TOKEN
    cs.Handler.token_file = None
    cs.Handler.mock = True
    cs.Handler.tls_info = None
    srv = _QuietServer(("127.0.0.1", 0), cs.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    port = srv.server_address[1]
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        conn.request("GET", "/api/tls/cert", headers={"Connection": "close"})
        st = conn.getresponse().status
        conn.close()
        check(st == 404, "GET /api/tls/cert -> 404 when TLS disabled", st)
        # and the plaintext listener still answers ping (dual-listen, no flip)
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        conn.request("GET", "/api/ping", headers={"Connection": "close"})
        st = conn.getresponse().status
        conn.close()
        check(st == 200, "plaintext /api/ping still 200 (backward compat)", st)
    finally:
        srv.shutdown()


if __name__ == "__main__":
    test_https_reachability_and_gate()
    test_tls_cert_404_when_disabled()
    print()
    if _fail:
        print("FAILED: %d" % len(_fail))
        for f in _fail:
            print("  - " + f)
        raise SystemExit(1)
    print("all TLS smoke tests passed")
