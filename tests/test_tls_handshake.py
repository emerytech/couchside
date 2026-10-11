#!/usr/bin/env python3
"""Bounded TLS handshakes over the production listener, without live devices.

Run: python3 tests/test_tls_handshake.py

The control is a normal authenticated HTTPS request; idle and partial TLS peers
must not prevent that same request from completing. A separate saturation case
proves unfinished handshakes consume the existing connection budget. Temporary
certificates require openssl, as do the other TLS integration suites. Everything
else is stdlib; certificates/configuration never touch the user's agent state.
"""
import base64
import hashlib
import http.client
import importlib.util
import json
import os
import queue
import socket
import ssl
import subprocess
import tempfile
import threading
import time
from contextlib import ExitStack, contextmanager
from pathlib import Path
from unittest.mock import patch

AGENT = Path(__file__).resolve().parents[1] / "agent" / "couchsided.py"
spec = importlib.util.spec_from_file_location("couchsided", AGENT)
cs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cs)
HOST = "127.0.0.1"
TOKEN = "tls-handshake-fixture-token"
_checks = 0
_fail = []


def check(condition, label, detail=""):
    global _checks
    _checks += 1
    print(("PASS" if condition else "FAIL") + "  " + label +
          ("" if condition or not detail else "  <- " + str(detail)), flush=True)
    if not condition:
        _fail.append(label)


class TestHandler(cs.Handler):
    token = TOKEN
    token_file = None
    mock = True
    port = 0
    tls_info = None
    observed_timeouts = queue.Queue()

    def setup(self):
        self.observed_timeouts.put(self.request.gettimeout())
        super().setup()

    def _log(self, *args, **kwargs):
        pass


class Listener:
    def __init__(self, server, thread, handshakes):
        self.server = server
        self.thread = thread
        self.port = server.server_address[1]
        self.handshakes = handshakes
        self.clients = []

    def raw_client(self, data=b""):
        client = socket.create_connection((HOST, self.port), timeout=1)
        self.clients.append(client)
        if data:
            client.sendall(data)
        return client

    def handshake_started(self, timeout=1):
        try:
            return self.handshakes.get(timeout=timeout)
        except queue.Empty:
            return None

    def https(self, path="/api/ping", token=TOKEN, timeout=1):
        conn = http.client.HTTPSConnection(HOST, self.port, timeout=timeout,
                                           context=ssl._create_unverified_context())
        try:
            headers = {"Connection": "close"}
            if token is not None:
                headers["Authorization"] = "Bearer " + token
            conn.request("GET", path, headers=headers)
            response = conn.getresponse()
            return response.status, json.loads(response.read())
        except (OSError, http.client.HTTPException) as error:
            return None, type(error).__name__
        finally:
            conn.close()


@contextmanager
def tls_listener(cert_info, limit=4, deadline=3.0):
    """Use _tls_start itself; only certificate persistence is replaced by a fixture.

    Observe real server handshakes so ordering does not depend on arbitrary
    sleeps. Close every raw peer BEFORE shutdown, including on failing baseline
    code where the accept thread is stuck inside the peer's handshake.
    """
    observed = queue.Queue()
    original_handshake = ssl.SSLSocket.do_handshake

    def observe_handshake(sock, *args, **kwargs):
        if sock.server_side:
            observed.put(threading.current_thread())
        return original_handshake(sock, *args, **kwargs)

    with ExitStack() as stack:
        stack.enter_context(patch.object(cs, "_tls_ensure", return_value=cert_info))
        stack.enter_context(patch.object(cs, "_TLS_SERVER", None))
        stack.enter_context(patch.object(cs, "_TLS_THREAD", None))
        stack.enter_context(patch.object(cs.BoundedThreadingHTTPServer,
                                        "_MAX_CONNECTIONS", limit))
        stack.enter_context(patch.object(cs.BoundedThreadingHTTPServer,
                                        "_TLS_HANDSHAKE_TIMEOUT_S", deadline,
                                        create=True))
        stack.enter_context(patch.object(ssl.SSLSocket, "do_handshake",
                                        observe_handshake))
        stack.enter_context(patch.object(TestHandler, "observed_timeouts", queue.Queue()))
        info = cs._tls_start(HOST, TestHandler, force_enable=True)
        assert info is not None, "production TLS listener did not start"
        listener = Listener(cs._TLS_SERVER, cs._TLS_THREAD, observed)
        try:
            yield listener
        finally:
            for client in listener.clients:
                client.close()
            # Bounded even if a regression prevents serve_forever from exiting.
            shutdown = threading.Thread(target=listener.server.shutdown, daemon=True)
            shutdown.start()
            shutdown.join(timeout=3)
            listener.server.server_close()
            listener.thread.join(timeout=1)
            check(not shutdown.is_alive() and not listener.thread.is_alive(),
                  "TLS listener shuts down after its peers close")


def finish_worker(live, worker):
    # A peer close wakes its worker asynchronously. Wait for cleanup before
    # asserting the permit is reusable; never join the blocked baseline accept
    # thread, which is stopped by the fixture only after closing all peers.
    if worker is not None and worker is not live.thread:
        worker.join(timeout=1)


def closed_within(client, timeout):
    client.settimeout(timeout)
    try:
        return client.recv(1) == b""
    except (ConnectionResetError, BrokenPipeError):
        return True
    except socket.timeout:
        return False


def test_idle_and_partial_peers(cert_info):
    # Partial TLS record header, too short for a ClientHello or a protocol error.
    for label, payload in (("idle", b""), ("partial ClientHello", b"\x16\x03\x01\x00")):
        with tls_listener(cert_info) as live:
            control, _ = live.https("/api/status")
            check(control == 200, label + ": authenticated HTTPS control is healthy")
            live.handshake_started()  # consume the healthy control's observation
            client = live.raw_client(payload)
            worker = live.handshake_started()
            check(worker is not None, label + ": real server handshake has started")
            status, body = live.https("/api/status", timeout=0.8)
            check(status == 200, label + ": another authenticated client stays responsive",
                  (status, body))
            client.close()
            finish_worker(live, worker)
            status, body = live.https()
            check(status == 200 and body.get("ok"), label + ": listener recovers after close",
                  (status, body))


def test_handshake_deadline(cert_info):
    with tls_listener(cert_info, limit=1, deadline=0.25) as live:
        client = live.raw_client()
        worker = live.handshake_started()
        check(worker is not None, "timeout: idle handshake starts")
        check(closed_within(client, 1.2), "timeout: idle TLS peer is closed by deadline")
        finish_worker(live, worker)
        status, body = live.https("/api/status")
        check(status == 200, "timeout: expired handshake releases the only worker slot",
              (status, body))


def test_handshake_budget(cert_info):
    with tls_listener(cert_info, limit=2, deadline=4.0) as live:
        first = live.raw_client()
        first_worker = live.handshake_started()
        check(first_worker is not None, "budget: first handshake starts")
        second = live.raw_client()
        second_worker = live.handshake_started()
        check(second_worker is not None, "budget: second handshake starts")
        excess = live.raw_client()
        check(closed_within(excess, 0.5), "budget: excess TLS peer is rejected promptly")
        check(live.handshakes.empty(), "budget: rejected peer never starts a handshake")
        first.close()
        second.close()
        finish_worker(live, first_worker)
        finish_worker(live, second_worker)
        # Released permits become observable via a real authenticated request.
        status, body = live.https("/api/status")
        check(status == 200, "budget: closing unfinished peers restores service",
              (status, body))


def test_bad_handshakes(cert_info):
    with tls_listener(cert_info, limit=1) as live:
        for label, data in (("plaintext on TLS", b"GET /api/ping HTTP/1.1\r\n\r\n"),
                            ("disconnected TLS peer", b"\x16\x03")):
            client = live.raw_client(data)
            worker = live.handshake_started()
            check(worker is not None, label + ": handshake observed")
            client.close()
            finish_worker(live, worker)
            status, body = live.https("/api/status")
            check(status == 200, label + ": listener and worker slot recover", (status, body))
            # Do not mistake this healthy request's queued observation for the
            # next malformed peer, or race its permit release at limit=1.
            finish_worker(live, live.handshake_started())


def test_thread_start_failure(cert_info):
    with tls_listener(cert_info, limit=1) as live:
        attempted = threading.Event()
        start = threading.Thread.start

        def fail_worker_once(thread):
            target = getattr(thread, "_target", None)
            if getattr(target, "__name__", "") == "process_request_thread":
                attempted.set()
                raise RuntimeError("test worker start failure")
            return start(thread)

        # An expected resource-exhaustion error must not dump a test traceback.
        with patch.object(threading.Thread, "start", fail_worker_once), \
                patch.object(live.server, "handle_error") as error_handler:
            status, failure = live.https()
            check(attempted.is_set(), "thread failure: worker creation really failed")
            check(status is None and failure != "TimeoutError",
                  "thread failure: failed connection closes instead of timing out", failure)
            check(error_handler.call_count == 1, "thread failure: server observes one failure")
        status, body = live.https("/api/status")
        check(status == 200, "thread failure: permit released for next authenticated client",
              (status, body))


def test_established_connections(cert_info):
    with tls_listener(cert_info, deadline=0.3) as live:
        conn = http.client.HTTPSConnection(HOST, live.port, timeout=2,
                                           context=ssl._create_unverified_context())
        try:
            conn.request("GET", "/api/ping")
            response = conn.getresponse()
            response.read()
            check(response.status == 200, "keepalive: initial ping succeeds")
            original_socket = conn.sock
            # Deliberately outlast the handshake-only deadline, then reuse TLS.
            time.sleep(0.5)
            conn.request("GET", "/api/status", headers={"Authorization": "Bearer " + TOKEN})
            response = conn.getresponse()
            response.read()
            check(response.status == 200 and conn.sock is original_socket,
                  "keepalive: same established TLS connection survives handshake deadline")
        except (OSError, http.client.HTTPException) as error:
            check(False, "keepalive: established TLS connection remains usable", error)
        finally:
            conn.close()
        observed = []
        while not TestHandler.observed_timeouts.empty():
            observed.append(TestHandler.observed_timeouts.get_nowait())
        check(observed and all(value is None for value in observed),
              "keepalive: original blocking timeout restored before HTTP handler", observed)
        for token, expected in ((None, 401), ("wrong", 401), (TOKEN, 200)):
            status, body = live.https("/api/status", token=token)
            check(status == expected, "HTTPS auth: %s token returns %s" %
                  ("missing" if token is None else "valid" if token == TOKEN else "wrong", expected),
                  (status, body))


def test_wss_auth_and_upgrade(cert_info):
    with tls_listener(cert_info) as live, \
            patch.object(cs, "_volume_events_available", return_value=False):
        for token, expected in (("wrong", 401), (TOKEN, 101)):
            client = ssl._create_unverified_context().wrap_socket(
                socket.create_connection((HOST, live.port), timeout=2),
                server_hostname="localhost")
            live.clients.append(client)
            worker = live.handshake_started()
            key = base64.b64encode(b"couchside-fixture").decode("ascii")
            request = ("GET /ws/volume?token=%s HTTP/1.1\r\nHost: localhost\r\n"
                       "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                       "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: %s\r\n\r\n")
            client.sendall((request % (token, key)).encode("ascii"))
            data = b""
            while b"\r\n\r\n" not in data:
                chunk = client.recv(4096)
                if not chunk:
                    break
                data += chunk
            head, _, payload = data.partition(b"\r\n\r\n")
            check(head.startswith(("HTTP/1.1 %s" % expected).encode()),
                  "WSS auth: %s token returns %s" %
                  ("valid" if token == TOKEN else "wrong", expected), head)
            if expected == 101 and head.startswith(b"HTTP/1.1 101"):
                accept = base64.b64encode(hashlib.sha1((key + cs.WS_GUID).encode()).digest())
                check(b"Sec-WebSocket-Accept: " + accept in head,
                      "WSS upgrade retains the RFC6455 accept value")
                try:
                    while len(payload) < 2 or len(payload) < 2 + (payload[1] & 127):
                        chunk = client.recv(4096)
                        if not chunk:
                            raise EOFError("connection closed before hello")
                        payload += chunk
                    frame = json.loads(payload[2:2 + (payload[1] & 127)])
                    check(frame == {"t": "hello", "volume_events": False},
                          "WSS receive-only hello preserves its real payload", frame)
                except (OSError, ValueError, EOFError) as error:
                    check(False, "WSS receive-only hello preserves its real payload", error)
            client.close()
            finish_worker(live, worker)
        check(live.https("/api/status")[0] == 200,
              "authenticated HTTPS remains available after WSS sessions")


def main():
    with tempfile.TemporaryDirectory(prefix="couchside-handshake-test-") as root:
        cert, key = os.path.join(root, "cert.pem"), os.path.join(root, "key.pem")
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                        "-days", "1", "-subj", "/CN=localhost", "-keyout", key,
                        "-out", cert], check=True, capture_output=True, timeout=15)
        os.chmod(key, 0o600)
        cert_pem = Path(cert).read_text()
        info = {"port": 0, "cert_path": cert, "key_path": key, "cert_pem": cert_pem,
                "fp": cs._tls_fp(cert_pem), "spki": None}
        for test in (test_idle_and_partial_peers, test_handshake_deadline,
                     test_handshake_budget, test_bad_handshakes,
                     test_thread_start_failure, test_established_connections,
                     test_wss_auth_and_upgrade):
            test(info)
    print("\n%d checks; %d failures" % (_checks, len(_fail)), flush=True)
    return bool(_fail)


if __name__ == "__main__":
    raise SystemExit(main())
