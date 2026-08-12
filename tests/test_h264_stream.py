#!/usr/bin/env python3
"""Agent side of the P4b H.264 Annex-B stream relay (/ws/h264, the WebCodecs tier).

Run: python3 tests/test_h264_stream.py

Pins the §6 requirements for the new surface, all pure-stdlib (no box, no gi):
  1. _portal_stream_h264(): PRESENT helper -> a socket carrying the `stream_h264`
     verb + the profile; ABSENT -> None (the "fall back to MJPEG/poller" case).
  2. /ws/h264: auth FAILURE (bad/absent token -> 401, no session); bad Upgrade
     -> 400; an UNKNOWN ?profile is replaced by the DEFAULT (never a client
     string reaches the helper); a KNOWN profile passes through; and over the
     concurrency cap the socket is closed with NO portal session opened.
  3. The /ws/h264 profile allowlist mirrors the helper's _H264_PROFILES set, and
     the default is a member of it (a client id is looked up, never interpolated).

The helper (couchside-portal.py) binds Gio at import so it can't run in CI; its
own stream_h264 argument validation is a mirror of these keys and is exercised on
hardware. This file pins the agent boundary that a bad client value never becomes
a helper request.
"""
import importlib.util
import json
import os
import socket
import sys
import tempfile
import threading
from urllib.parse import urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location(
    "couchsided", os.path.join(ROOT, "agent", "couchsided.py"))
cs = importlib.util.module_from_spec(_spec)
sys.modules["couchsided"] = cs
_spec.loader.exec_module(cs)

FAILURES = []


def check(name, got, want):
    if got == want:
        print("  PASS  %s" % name)
    else:
        print("  FAIL  %s (got %r, want %r)" % (name, got, want))
        FAILURES.append(name)


def fake_portal_stream():
    """A one-shot portal helper for the stream verb: accepts one connection,
    records the request line, and holds the socket open (a real stream_h264 never
    JSON-replies — it switches to raw bytes). Returns (socket_path, seen)."""
    d = tempfile.mkdtemp()
    path = os.path.join(d, "portal.sock")
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(path)
    srv.listen(4)
    seen = []
    held = []

    def serve():
        try:
            conn, _ = srv.accept()
        except OSError:
            return
        held.append(conn)                            # keep the peer open
        buf = b""
        while b"\n" not in buf:
            chunk = conn.recv(4096)
            if not chunk:
                break
            buf += chunk
        try:
            seen.append(json.loads(buf.split(b"\n", 1)[0].decode()))
        except ValueError:
            seen.append(None)

    threading.Thread(target=serve, daemon=True).start()
    return path, seen


saved_portal_socket = cs.PORTAL_SOCKET
try:
    # --- 1. _portal_stream_h264() -------------------------------------------
    print("1. _portal_stream_h264: sends the `stream_h264` verb, absent -> None")
    path, seen = fake_portal_stream()
    cs.PORTAL_SOCKET = path
    s = cs._portal_stream_h264("720p30")
    check("present helper -> a socket", s is not None, True)
    if s is not None:
        for _ in range(50):
            if seen:
                break
            threading.Event().wait(0.02)
        check("helper saw verb=stream_h264", seen and seen[0].get("verb"),
              "stream_h264")
        check("helper saw the profile", seen and seen[0].get("arg"),
              {"profile": "720p30"})
        try:
            s.close()
        except OSError:
            pass
    cs.PORTAL_SOCKET = "/nonexistent-couchside-test/portal.sock"
    check("absent helper -> None", cs._portal_stream_h264("720p30"), None)

    # --- 2. /ws/h264 auth + profile allowlist + cap -------------------------
    print()
    print("2. /ws/h264: auth failure + profile allowlist + concurrency cap")

    class _WSStub:
        token = "s3cr3t"
        close_connection = False

        def __init__(self, headers):
            self.headers = headers
            self.sent = None
            self.session_profile = "UNSET"
            self._sendall = []

        _handle_h264_ws = cs.Handler._handle_h264_ws
        _h264_session = cs.Handler._h264_session       # real (cap test)

        def _send(self, code, body, started, extra_headers=None):
            self.sent = code

        def _log(self, code, started):
            pass

        class _Conn:
            def __init__(self, out):
                self.out = out

            def sendall(self, b):
                self.out.append(b)

        def _session_stub(self, profile):
            self.session_profile = profile

    def ws_stub(headers, stub_session=True):
        st = _WSStub(headers)
        st.connection = _WSStub._Conn(st._sendall)
        if stub_session:
            st._h264_session = st._session_stub
        return st

    # (a) absent token -> 401, no session
    st = ws_stub({})
    st._handle_h264_ws(urlparse("/ws/h264"), 0.0)
    check("no token -> 401", st.sent, 401)
    check("no token -> no session", st.session_profile, "UNSET")

    # (b) wrong token -> 401
    st = ws_stub({})
    st._handle_h264_ws(urlparse("/ws/h264?token=WRONG"), 0.0)
    check("wrong token -> 401", st.sent, 401)

    # (c) right token, no Upgrade header -> 400
    st = ws_stub({})
    st._handle_h264_ws(urlparse("/ws/h264?token=s3cr3t"), 0.0)
    check("valid token, no upgrade -> 400", st.sent, 400)

    # (d) valid handshake + BOGUS profile -> the DEFAULT, never the client string
    st = ws_stub({"Sec-WebSocket-Key": "dGhlIHNhbXBsZQ==", "Upgrade": "websocket"})
    st._handle_h264_ws(urlparse("/ws/h264?token=s3cr3t&profile=rm -rf"), 0.0)
    check("bogus profile replaced by default", st.session_profile,
          cs._H264_STREAM_DEFAULT)

    # (e) valid handshake + KNOWN profile -> passed through
    st = ws_stub({"Sec-WebSocket-Key": "dGhlIHNhbXBsZQ==", "Upgrade": "websocket"})
    st._handle_h264_ws(urlparse("/ws/h264?token=s3cr3t&profile=1080p60"), 0.0)
    check("known profile passed through", st.session_profile, "1080p60")

    # (f) over the concurrency cap -> the socket is CLOSED and NO session opens.
    portal_calls = []
    real_portal_call = cs._portal_call
    cs._portal_call = lambda verb, arg=None, timeout=10: portal_calls.append(verb)
    acquired = cs._h264_stream_sema.acquire(blocking=False)
    try:
        st = ws_stub({}, stub_session=False)           # real _h264_session
        st._h264_session(cs._H264_STREAM_DEFAULT)
        check("over cap -> nothing sent to the portal (no ensure)", portal_calls, [])
        check("over cap -> a WS frame was sent (CLOSE, app falls back)",
              len(st._sendall) >= 1, True)
    finally:
        if acquired:
            cs._h264_stream_sema.release()
        cs._portal_call = real_portal_call

    # --- 3. profile allowlist discipline (§3.1) -----------------------------
    print()
    print("3. profile allowlist: default is a member; closed set, looked up")
    check("default profile is in the allowlist",
          cs._H264_STREAM_DEFAULT in cs._H264_STREAM_PROFILES, True)
    check("allowlist is exactly the four H.264 profiles",
          cs._H264_STREAM_PROFILES,
          frozenset(("720p30", "720p60", "1080p30", "1080p60")))

finally:
    cs.PORTAL_SOCKET = saved_portal_socket

print()
if FAILURES:
    print("FAILED: %s" % ", ".join(FAILURES))
    sys.exit(1)
print("all h264-stream tests passed")
