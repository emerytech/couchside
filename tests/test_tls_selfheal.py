#!/usr/bin/env python3
"""TLS listener self-heal: bind-retry through a restart race + watchdog recovery.

Run: python3 tests/test_tls_selfheal.py

CLAUDE.md §4 protects reachability. TLS is on by default and a paired app is LOCKED
to the TLS port -- api.ts fails closed with NO plaintext fallback (so a killed TLS
port can't downgrade the token onto the wire). The cost of that guarantee: a
listener that misses its bind after an in-place update, or whose serve thread later
dies, strands every secure client in a connect/disconnect loop until a manual box
reboot (observed on a Steam Machine after a 2.9.10x agent update). This proves the
fix that lets the box self-heal instead:

  * _tls_start RETRIES the bind through a busy port (the systemd Restart=always
    race, where the new process can start before the old releases the socket)
    instead of giving up for the life of the process, and binds once the port frees.
  * _tls_supervisor RE-BINDS on its own after the listener is down -- never bound,
    or the serve thread died -- so the box recovers without a reboot, and it
    republishes tls_info so a LATE listener is still advertised for pinning.

DECISIVE control (CLAUDE.md §11, observe-both-states): while the port is held the
listener is DOWN (no HTTPS connect); the ONLY change after freeing it is the SAME
port comes UP -- i.e. genuine recovery, not a new identity or a silent no-op.

Pure stdlib, no pytest.
"""
import http.client
import importlib.util
import os
import socket
import ssl
import threading
import time
from http.server import BaseHTTPRequestHandler

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT = os.path.join(HERE, "..", "agent", "couchsided.py")
spec = importlib.util.spec_from_file_location("couchsided", AGENT)
cs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cs)

HOST = "127.0.0.1"


class DummyHandler(BaseHTTPRequestHandler):
    """Minimal handler: _tls_start only needs a handler_cls to build the server;
    the auth-gated Handler behaviour is proven in test_tls_smoke.py."""
    tls_info = None

    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *a):
        pass


def free_port():
    s = socket.socket()
    s.bind((HOST, 0))
    p = s.getsockname()[1]
    s.close()
    return p


def occupy(port):
    """Hold `port` with a real LISTENING socket so a second bind gets EADDRINUSE
    (SO_REUSEADDR rebinds a TIME_WAIT socket, not an active listener)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind((HOST, port))
    s.listen(1)
    return s


def https_ping_ok(port, timeout=2.0):
    ctx = ssl._create_unverified_context()
    try:
        c = http.client.HTTPSConnection(HOST, port, context=ctx, timeout=timeout)
        c.request("GET", "/x")
        r = c.getresponse()
        r.read()
        c.close()
        return r.status == 200
    except Exception:
        return False


def reset_tls_globals():
    srv = cs._TLS_SERVER
    if srv is not None:
        for close in (srv.shutdown, srv.server_close):
            try:
                close()
            except Exception:
                pass
    cs._TLS_SERVER = None
    cs._TLS_THREAD = None


def _require_cert_or_skip():
    """These tests need a mintable cert (openssl). If cert generation is
    unavailable on this host, _tls_start returns None even with a free port --
    skip rather than false-fail (CI mints one on Linux; test_tls_smoke covers it)."""
    port = free_port()
    cs.CONFIG_TLS = {"enabled": True, "port": port}
    serve = cs._tls_start(HOST, DummyHandler, force_enable=True)
    reset_tls_globals()
    return serve is not None


def test_bind_retry_then_success():
    port = free_port()
    cs.CONFIG_TLS = {"enabled": True, "port": port}
    DummyHandler.tls_info = None
    reset_tls_globals()
    cs._TLS_BIND_ATTEMPTS = 6
    cs._TLS_BIND_BACKOFF_S = 0.15

    occ = occupy(port)
    t0 = time.time()
    serve = cs._tls_start(HOST, DummyHandler, force_enable=True)
    elapsed = time.time() - t0
    assert serve is None, "expected None while the port is busy"
    assert elapsed >= 0.3, "did not actually retry (returned in %.3fs)" % elapsed
    assert not https_ping_ok(port), "listener should be down while the port is busy"

    occ.close()
    serve = cs._tls_start(HOST, DummyHandler, force_enable=True)
    assert serve is not None and serve["port"] == port, "bind failed after port freed"
    assert cs._TLS_SERVER is not None and cs._TLS_THREAD.is_alive(), "server not tracked/alive"
    assert https_ping_ok(port), "listener should be up on the same port after it freed"
    reset_tls_globals()
    print("ok bind-retry-then-success")


def test_watchdog_recovers_late():
    port = free_port()
    cs.CONFIG_TLS = {"enabled": True, "port": port}
    DummyHandler.tls_info = None
    reset_tls_globals()
    cs._TLS_BIND_ATTEMPTS = 2
    cs._TLS_BIND_BACKOFF_S = 0.05
    cs._TLS_WATCH_INTERVAL_S = 0.2

    occ = occupy(port)
    serve = cs._tls_start(HOST, DummyHandler, force_enable=True)
    assert serve is None
    cs._tls_apply_serve(DummyHandler, serve)  # None -> tls_info cleared (TLS dark)
    assert DummyHandler.tls_info is None

    threading.Thread(target=cs._tls_supervisor, args=(HOST, DummyHandler, True),
                     daemon=True).start()
    time.sleep(cs._TLS_WATCH_INTERVAL_S * 3)
    assert not https_ping_ok(port), "listener must stay DOWN while the port is held"
    assert cs._TLS_SERVER is None, "must not claim a live server while down"

    occ.close()
    deadline = time.time() + 5
    while time.time() < deadline and not https_ping_ok(port):
        time.sleep(0.1)
    assert https_ping_ok(port), "watchdog did not recover the listener after the port freed"
    assert cs._TLS_SERVER is not None, "recovered server not tracked"
    assert DummyHandler.tls_info is not None and DummyHandler.tls_info["port"] == port, \
        "a late listener must be re-advertised (tls_info republished)"
    reset_tls_globals()
    print("ok watchdog-recovers-late")


def test_watchdog_restarts_dead_thread():
    port = free_port()
    cs.CONFIG_TLS = {"enabled": True, "port": port}
    reset_tls_globals()
    cs._TLS_BIND_ATTEMPTS = 4
    cs._TLS_BIND_BACKOFF_S = 0.1
    cs._TLS_WATCH_INTERVAL_S = 0.2

    serve = cs._tls_start(HOST, DummyHandler, force_enable=True)
    assert serve is not None and https_ping_ok(port), "initial listener should be up"
    old = cs._TLS_SERVER

    threading.Thread(target=cs._tls_supervisor, args=(HOST, DummyHandler, True),
                     daemon=True).start()
    # Simulate the serve thread dying: serve_forever returns, the daemon thread
    # ends, but the socket stays bound until the watchdog's server_close.
    old.shutdown()

    deadline = time.time() + 6
    ok = False
    while time.time() < deadline:
        if cs._TLS_SERVER is not None and cs._TLS_SERVER is not old and https_ping_ok(port):
            ok = True
            break
        time.sleep(0.1)
    assert ok, "watchdog did not restart a dead listener on the same port"
    reset_tls_globals()
    print("ok watchdog-restarts-dead-thread")


if __name__ == "__main__":
    if not _require_cert_or_skip():
        print("SKIP: TLS cert generation unavailable on this host (need openssl); "
              "run in CI where test_tls_smoke also mints one")
        raise SystemExit(0)
    test_bind_retry_then_success()
    test_watchdog_recovers_late()
    test_watchdog_restarts_dead_thread()
    print("ALL TLS SELF-HEAL TESTS PASSED")
