#!/usr/bin/env python3
"""Agent side of the P4b H.264/WebRTC signaling relay (/ws/webrtc).

Run: python3 tests/test_webrtc_relay.py

Pins the §6 requirements for the new surface, all pure-stdlib (no box, no gi):
  1. screenstream_h264_available(): reachable + ok + h264 -> True; ok but NO
     h264 -> False; absent -> False (degrade closed).
  2. _portal_webrtc(): PRESENT helper -> a socket carrying the `webrtc` verb;
     ABSENT -> None (the "fall back to MJPEG/poller" case).
  3. _webrtc_app_msg(): the app->box allowlist boundary (§3). Only answer/ice/bye
     with well-typed fields forward; unknown types, malformed args, and extra
     client fields are DROPPED/stripped -- no arbitrary client JSON reaches the
     helper (and thus never reaches webrtcbin/gst).
  4. /ws/webrtc: auth FAILURE (bad/absent token -> 401, no session); bad Upgrade
     -> 400; an UNKNOWN ?profile is replaced by the DEFAULT (never a client
     string reaches the helper); a KNOWN profile passes through; and over the
     concurrency cap the socket is closed with NO portal session opened.
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


def fake_portal(replies):
    """A one-shot portal helper: serves len(replies) JSON connections then stops.
    Returns (socket_path, seen_requests)."""
    d = tempfile.mkdtemp()
    path = os.path.join(d, "portal.sock")
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(path)
    srv.listen(4)
    seen = []

    def serve():
        for reply in replies:
            try:
                conn, _ = srv.accept()
            except OSError:
                return
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
            conn.sendall(json.dumps(reply).encode() + b"\n")
            conn.close()

    threading.Thread(target=serve, daemon=True).start()
    return path, seen


saved_portal_socket = cs.PORTAL_SOCKET
try:
    # --- 1. screenstream_h264_available() -----------------------------------
    print("1. screenstream_h264_available: needs ok AND h264")
    path, _ = fake_portal([{"ok": True, "h264": True, "h264_profiles": []}])
    cs.PORTAL_SOCKET = path
    check("reachable + h264 -> True", cs.screenstream_h264_available(), True)
    path, _ = fake_portal([{"ok": True, "h264": False}])
    cs.PORTAL_SOCKET = path
    check("ok but NO h264 -> False (honest cap)", cs.screenstream_h264_available(), False)
    cs.PORTAL_SOCKET = "/nonexistent-couchside-test/portal.sock"
    check("absent helper -> False (degrade closed)", cs.screenstream_h264_available(), False)

    # --- 2. _portal_webrtc() ------------------------------------------------
    print()
    print("2. _portal_webrtc: sends the `webrtc` verb, absent -> None")
    path, seen = fake_portal([{"ignored": True}])   # helper never JSON-replies here
    cs.PORTAL_SOCKET = path
    s = cs._portal_webrtc("720p60")
    check("present helper -> a socket", s is not None, True)
    if s is not None:
        # give the fake helper a moment to read the verb line
        s.settimeout(1.0)
        for _ in range(50):
            if seen:
                break
            threading.Event().wait(0.02)
        check("helper saw verb=webrtc", seen and seen[0].get("verb"), "webrtc")
        check("helper saw the profile", seen and seen[0].get("arg"), {"profile": "720p60"})
        try:
            s.close()
        except OSError:
            pass
    cs.PORTAL_SOCKET = "/nonexistent-couchside-test/portal.sock"
    check("absent helper -> None", cs._portal_webrtc("720p60"), None)

    # --- 3. _webrtc_app_msg(): the app->box allowlist boundary (§3) ----------
    print()
    print("3. _webrtc_app_msg: allowlist + field discipline")
    check("answer with sdp forwards {t,sdp} only",
          cs._webrtc_app_msg({"t": "answer", "sdp": "v=0...", "evil": 1}),
          {"t": "answer", "sdp": "v=0..."})
    check("ice with candidate+mline forwards known fields",
          cs._webrtc_app_msg({"t": "ice", "candidate": "cand", "sdpMLineIndex": 0, "x": 9}),
          {"t": "ice", "candidate": "cand", "sdpMLineIndex": 0})
    check("bye forwards {t:bye}", cs._webrtc_app_msg({"t": "bye"}), {"t": "bye"})
    check("unknown type dropped", cs._webrtc_app_msg({"t": "offer", "sdp": "x"}), None)
    check("hello (box-drives-nego) dropped", cs._webrtc_app_msg({"t": "hello"}), None)
    check("answer without sdp dropped", cs._webrtc_app_msg({"t": "answer"}), None)
    check("answer with non-string sdp dropped",
          cs._webrtc_app_msg({"t": "answer", "sdp": 123}), None)
    check("ice without candidate dropped",
          cs._webrtc_app_msg({"t": "ice", "sdpMLineIndex": 0}), None)
    check("ice with non-int mline dropped",
          cs._webrtc_app_msg({"t": "ice", "candidate": "c", "sdpMLineIndex": "0"}), None)
    check("non-dict dropped", cs._webrtc_app_msg("bye"), None)
    check("missing t dropped", cs._webrtc_app_msg({"sdp": "x"}), None)

    # --- 4. /ws/webrtc auth + profile allowlist + cap ------------------------
    print()
    print("4. /ws/webrtc: auth failure + profile allowlist + concurrency cap")

    class _WSStub:
        token = "s3cr3t"
        close_connection = False

        def __init__(self, headers):
            self.headers = headers
            self.sent = None
            self.session_profile = "UNSET"
            self._sendall = []

        _handle_webrtc_ws = cs.Handler._handle_webrtc_ws
        _webrtc_relay_session = cs.Handler._webrtc_relay_session  # real (cap test)

        def _send(self, code, body, started, extra_headers=None):
            self.sent = code

        def _log(self, code, started):
            pass

        class _Conn:
            def __init__(self, out):
                self.out = out

            def sendall(self, b):
                self.out.append(b)

        def _relay_stub(self, profile):
            self.session_profile = profile

    def ws_stub(headers, stub_relay=True):
        st = _WSStub(headers)
        st.connection = _WSStub._Conn(st._sendall)
        if stub_relay:
            st._webrtc_relay_session = st._relay_stub
        return st

    # (a) absent token -> 401, no session
    st = ws_stub({})
    st._handle_webrtc_ws(urlparse("/ws/webrtc"), 0.0)
    check("no token -> 401", st.sent, 401)
    check("no token -> no session", st.session_profile, "UNSET")

    # (b) wrong token -> 401
    st = ws_stub({})
    st._handle_webrtc_ws(urlparse("/ws/webrtc?token=WRONG"), 0.0)
    check("wrong token -> 401", st.sent, 401)

    # (c) right token, no Upgrade header -> 400
    st = ws_stub({})
    st._handle_webrtc_ws(urlparse("/ws/webrtc?token=s3cr3t"), 0.0)
    check("valid token, no upgrade -> 400", st.sent, 400)

    # (d) valid handshake + BOGUS profile -> the DEFAULT, never the client string
    st = ws_stub({"Sec-WebSocket-Key": "dGhlIHNhbXBsZQ==", "Upgrade": "websocket"})
    st._handle_webrtc_ws(urlparse("/ws/webrtc?token=s3cr3t&profile=rm -rf"), 0.0)
    check("bogus profile replaced by default", st.session_profile, cs._WEBRTC_DEFAULT)
    check("default profile is in the allowlist",
          cs._WEBRTC_DEFAULT in cs._WEBRTC_PROFILES, True)

    # (e) valid handshake + KNOWN profile -> passed through
    st = ws_stub({"Sec-WebSocket-Key": "dGhlIHNhbXBsZQ==", "Upgrade": "websocket"})
    st._handle_webrtc_ws(urlparse("/ws/webrtc?token=s3cr3t&profile=1080p60"), 0.0)
    check("known profile passed through", st.session_profile, "1080p60")

    # (f) over the concurrency cap -> the socket is CLOSED and NO session opens.
    #     Exhaust the sema, point PORTAL at a recorder, run the REAL relay.
    portal_calls = []
    real_portal_call = cs._portal_call
    cs._portal_call = lambda verb, arg=None, timeout=10: portal_calls.append(verb)
    acquired = cs._webrtc_sema.acquire(blocking=False)
    try:
        st = ws_stub({}, stub_relay=False)          # real _webrtc_relay_session
        st._webrtc_relay_session(cs._WEBRTC_DEFAULT)
        check("over cap -> nothing sent to the portal (no ensure)", portal_calls, [])
        check("over cap -> a WS frame was sent (CLOSE, app falls back)",
              len(st._sendall) >= 1, True)
    finally:
        if acquired:
            cs._webrtc_sema.release()
        cs._portal_call = real_portal_call

finally:
    cs.PORTAL_SOCKET = saved_portal_socket

print()
if FAILURES:
    print("FAILED: %s" % ", ".join(FAILURES))
    sys.exit(1)
print("all webrtc-relay tests passed")
