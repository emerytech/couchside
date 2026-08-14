#!/usr/bin/env python3
"""Agent side of the opt-in remote-desktop portal module (couchside-portal.py).

Run: python3 tests/test_portal_module.py

Pins the §6 requirements for the new surface, all pure-stdlib (no box, no gi):
  1. _portal_call shim: helper PRESENT -> reply; ABSENT / DEAD socket -> None
     (the only "degrade to the still-frame poller" case), like the helper shim.
  2. screenstream_available(): reachable + ok -> True; absent -> False.
  3. Absolute pointer input {t:'ma'}/{t:'mbp'} on /ws/gamepad:
       - a NON-HOLDER's frame is DROPPED (the holder gate), nothing reaches the portal;
       - a bad coordinate / unknown button is DROPPED (allowlist), nothing runs;
       - a good frame forwards the validated verb+arg to _portal_call.
  4. /ws/screen: auth FAILURE (bad/absent token -> 401, no session); bad Upgrade
     -> 400; and an UNKNOWN ?profile is replaced by the default (never a client
     string reaches the helper).
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

# --- 1. _portal_call shim ---------------------------------------------------
print("1. _portal_call: present -> reply, absent/dead -> None")
try:
    path, seen = fake_portal([{"ok": True, "w": 1920, "h": 1080, "node": 7}])
    cs.PORTAL_SOCKET = path
    r = cs._portal_call("ensure")
    check("present helper returns the reply dict", r and r.get("ok"), True)
    check("helper saw the verb", seen[0].get("verb"), "ensure")

    cs.PORTAL_SOCKET = "/nonexistent-couchside-test/portal.sock"
    check("absent socket -> None", cs._portal_call("ensure"), None)

    d = tempfile.mkdtemp()
    stale = os.path.join(d, "portal.sock")
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.bind(stale)
    s.close()  # path exists, nothing listens
    cs.PORTAL_SOCKET = stale
    check("dead socket FILE -> None (not a hang/crash)", cs._portal_call("ensure"), None)

    # --- 2. screenstream_available() ---------------------------------------
    print()
    print("2. screenstream_available: reachable+ok -> True, absent -> False")
    path, _ = fake_portal([{"ok": True, "session": False}])
    cs.PORTAL_SOCKET = path
    check("reachable helper -> cap True", cs.screenstream_available(), True)
    cs.PORTAL_SOCKET = "/nonexistent-couchside-test/portal.sock"
    check("absent helper -> cap False (degrade closed)", cs.screenstream_available(), False)

    # --- 2b. fluid caps gated on a REAL portal backend (the game-mode fix) --
    # A reachable helper is NOT enough: Steam Game Mode has no ScreenCast/
    # RemoteDesktop backend, so /ws/screen would 101-then-close. The helper reports
    # `screencast`; the agent must report screenstream[_h264] False when it is False,
    # or the app burns a connect timeout on each dead fluid tier before the poller.
    print()
    print("2b. screenstream[_h264] honest: no portal backend -> caps False")

    def one_status(reply):
        path, _ = fake_portal([reply])
        cs.PORTAL_SOCKET = path

    # desktop: backend present -> both caps True
    one_status({"ok": True, "screencast": True, "h264": True})
    check("backend present -> screenstream True", cs.screenstream_available(), True)
    one_status({"ok": True, "screencast": True, "h264": True})
    check("backend present + h264 -> screenstream_h264 True",
          cs.screenstream_h264_available(), True)

    # game mode: reachable helper but NO backend -> both caps False
    one_status({"ok": True, "screencast": False, "h264": True})
    check("no backend -> screenstream False (game-mode fix)",
          cs.screenstream_available(), False)
    one_status({"ok": True, "screencast": False, "h264": True})
    check("no backend -> screenstream_h264 False even with h264",
          cs.screenstream_h264_available(), False)

    # legacy helper that predates the field -> trust `ok` (no regression)
    one_status({"ok": True, "h264": True})
    check("legacy helper (no field) -> screenstream True (trust ok)",
          cs.screenstream_available(), True)
    one_status({"ok": True, "h264": True})
    check("legacy helper (no field) -> screenstream_h264 True (trust ok)",
          cs.screenstream_h264_available(), True)

    cs.PORTAL_SOCKET = saved_portal_socket

    # --- 3. absolute pointer input on /ws/gamepad --------------------------
    print()
    print("3. {t:'ma'}/{t:'mbp'}: holder gate + allowlist")
    cs._wsend_json = lambda entry, obj: None
    cs._wsend_op = lambda entry, op, payload=b"": None
    PORTAL_CALLS = []
    cs._portal_call = lambda verb, arg=None, timeout=10: PORTAL_CALLS.append((verb, arg))

    class _Stub:
        mock = True
        _MOUSE_TYPES = cs.Handler._MOUSE_TYPES
        _KEYBOARD_TYPES = cs.Handler._KEYBOARD_TYPES
        _CONTROL_TYPES = cs.Handler._CONTROL_TYPES
        _PORTAL_BTNS = cs.Handler._PORTAL_BTNS
        _handle_portal_abs = cs.Handler._handle_portal_abs
        _handle_portal_btn = cs.Handler._handle_portal_btn
        _handle_kt = cs.Handler._handle_kt
        _gamepad_message = cs.Handler._gamepad_message

    def feed(entry, msg):
        PORTAL_CALLS.clear()
        return _Stub()._gamepad_message(None, entry, json.dumps(msg).encode())

    held = {"held": True}
    waiter = {"held": False}

    # holder gate: a non-holder's absolute frame reaches the portal never
    feed(waiter, {"t": "ma", "x": 0.5, "y": 0.5})
    check("non-holder {ma} dropped (nothing to portal)", PORTAL_CALLS, [])

    # good move forwards move + normalized coords
    feed(held, {"t": "ma", "x": 0.25, "y": 0.75})
    check("holder {ma} forwards move", PORTAL_CALLS, [("move", {"x": 0.25, "y": 0.75})])

    # out-of-range coord is dropped (never reaches the portal)
    feed(held, {"t": "ma", "x": 5, "y": 0.5})
    check("out-of-range {ma} dropped", PORTAL_CALLS, [])

    # good button maps l->left and forwards
    feed(held, {"t": "mbp", "k": "r", "v": 1})
    check("holder {mbp r,1} forwards right button",
          PORTAL_CALLS, [("button", {"button": "right", "state": 1})])

    # unknown button name is dropped
    feed(held, {"t": "mbp", "k": "boop", "v": 1})
    check("unknown button dropped", PORTAL_CALLS, [])

    # bad button state is dropped
    feed(held, {"t": "mbp", "k": "l", "v": 9})
    check("bad button state dropped", PORTAL_CALLS, [])

    # the session stays alive across all of these (returns True, never closes)
    check("{ma} keeps the session alive", feed(held, {"t": "ma", "x": 0.1, "y": 0.1}), True)

    # --- 4. /ws/screen auth + profile allowlist ----------------------------
    print()
    print("4. /ws/screen: auth failure + profile allowlist")

    class _WSStub:
        token = "s3cr3t"
        close_connection = False

        def __init__(self, headers):
            self.headers = headers
            self.sent = None
            self.session_profile = "UNSET"
            self._sendall = []

        # real handler under test:
        _handle_screen_ws = cs.Handler._handle_screen_ws

        # collaborators stubbed:
        def _send(self, code, body, started, extra_headers=None):
            self.sent = code

        def _log(self, code, started):
            pass

        class _Conn:
            def __init__(self, out):
                self.out = out

            def sendall(self, b):
                self.out.append(b)

        def _screen_session(self, profile):
            self.session_profile = profile

    # (a) absent token -> 401, no session
    st = _WSStub({})
    st.connection = _WSStub._Conn(st._sendall)
    st._handle_screen_ws(urlparse("/ws/screen"), 0.0)
    check("no token -> 401", st.sent, 401)
    check("no token -> no session", st.session_profile, "UNSET")

    # (b) wrong token -> 401
    st = _WSStub({})
    st.connection = _WSStub._Conn(st._sendall)
    st._handle_screen_ws(urlparse("/ws/screen?token=WRONG"), 0.0)
    check("wrong token -> 401", st.sent, 401)

    # (c) right token but no Upgrade header -> 400
    st = _WSStub({})
    st.connection = _WSStub._Conn(st._sendall)
    st._handle_screen_ws(urlparse("/ws/screen?token=s3cr3t"), 0.0)
    check("valid token, no upgrade -> 400", st.sent, 400)

    # (d) valid handshake + BOGUS profile -> _screen_session gets the DEFAULT,
    #     never the client string.
    st = _WSStub({"Sec-WebSocket-Key": "dGhlIHNhbXBsZQ==", "Upgrade": "websocket"})
    st.connection = _WSStub._Conn(st._sendall)
    st._handle_screen_ws(urlparse("/ws/screen?token=s3cr3t&profile=rm -rf"), 0.0)
    check("bogus profile replaced by default", st.session_profile, cs._SCREEN_STREAM_DEFAULT)
    check("default profile is in the allowlist",
          cs._SCREEN_STREAM_DEFAULT in cs._SCREEN_STREAM_PROFILES, True)

    # (e) valid handshake + KNOWN profile -> passed through
    st = _WSStub({"Sec-WebSocket-Key": "dGhlIHNhbXBsZQ==", "Upgrade": "websocket"})
    st.connection = _WSStub._Conn(st._sendall)
    st._handle_screen_ws(urlparse("/ws/screen?token=s3cr3t&profile=540p25"), 0.0)
    check("known profile passed through", st.session_profile, "540p25")

finally:
    cs.PORTAL_SOCKET = saved_portal_socket

print()
if FAILURES:
    print("FAILED: %s" % ", ".join(FAILURES))
    sys.exit(1)
print("all portal-module tests passed")
