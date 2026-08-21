#!/usr/bin/env python3
"""Live volume events over WebSocket (/ws/volume) — the app-driven volume nudge.

Run: python3 tests/test_volume_events.py

WHY THIS SURFACE EXISTS: on a Steam Machine the box audio is a FIXED
HDMI-passthrough sink (wpctl set-volume is ignored) and a plain TV feature-aborts
CEC Give Audio Status, so the app can't READ an absolute volume level. But it CAN
flash an OSD the moment a change happens: whenever Couchside runs a volume op (the
app's own volume buttons), the agent pushes a relative nudge to every /ws/volume
client. Reliable because the agent performs the change itself — no snooping.

Pins the §6 requirements, pure-stdlib (no box):
  1. NUDGE MAP is a frozen lookup: volume_up/down/mute -> a direction, every other
     op (power_on, garbage, non-string) pushes NOTHING. A nudge fires only for a
     volume op, and only when broadcast to live clients.
  2. AUTH: /ws/volume with no/!wrong token -> 401 and NO session; a valid token
     without a WebSocket Upgrade -> 400; a valid handshake -> 101 + the session
     runs. (Mirrors the /ws/screen + /ws/h264 pre-auth handshake.)
  3. HELLO: a connected client is told volume_events, and de-registers on close.
  4. OUTBOUND ONLY: a broadcast reaches every registered client and a dead socket
     is skipped, never raising. The client's frames are never parsed as commands.
"""
import importlib.util
import json
import os
import sys
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


def ws_text_payload(frames):
    """Decode the JSON of the first server TEXT frame in a list of sendall()
    byte chunks (server frames are unmasked; our payloads are < 126 bytes)."""
    for b in frames:
        if not b or (b[0] & 0x0F) != cs.WS_OP_TEXT:
            continue
        n = b[1] & 0x7F
        try:
            return json.loads(b[2:2 + n].decode("utf-8"))
        except ValueError:
            return None
    return None


class _RecConn:
    def __init__(self):
        self.frames = []

    def sendall(self, b):
        self.frames.append(b)


def with_one_client(fn):
    """Run fn() with a single registered /ws/volume client; return its frames."""
    saved = list(cs.VOLUME_SESSIONS)
    conn = _RecConn()
    try:
        cs.VOLUME_SESSIONS[:] = [{"conn": conn, "slock": threading.Lock()}]
        fn()
        return conn.frames
    finally:
        cs.VOLUME_SESSIONS[:] = saved


# --- 1. NUDGE MAP -----------------------------------------------------------
print("1. _volume_nudge: volume ops push a direction, everything else pushes nothing")
check("volume_up  -> {t:vol,dir:up}",
      ws_text_payload(with_one_client(lambda: cs._volume_nudge("volume_up"))),
      {"t": "vol", "dir": "up"})
check("volume_down -> down",
      ws_text_payload(with_one_client(lambda: cs._volume_nudge("volume_down"))),
      {"t": "vol", "dir": "down"})
check("mute -> mute",
      ws_text_payload(with_one_client(lambda: cs._volume_nudge("mute"))),
      {"t": "vol", "dir": "mute"})
check("power_on -> nothing pushed",
      with_one_client(lambda: cs._volume_nudge("power_on")), [])
check("unknown op -> nothing pushed",
      with_one_client(lambda: cs._volume_nudge("rm -rf")), [])
check("non-string op -> nothing pushed (no crash)",
      with_one_client(lambda: cs._volume_nudge({"x": 1})), [])

# --- 2. + 3. AUTH + HELLO (handler via a stub) ------------------------------
print()
print("2. /ws/volume: auth failure, handshake, hello, de-register on close")


class _WSStub:
    token = "s3cr3t"
    close_connection = False

    _handle_volume_ws = cs.Handler._handle_volume_ws
    _volume_ws_handshake = cs.Handler._volume_ws_handshake
    _volume_session = cs.Handler._volume_session       # real (hello test)

    def __init__(self, headers):
        self.headers = headers
        self.sent = None
        self.session_ran = False
        self._sendall = []
        self.connection = _WSStub._Conn(self._sendall)

    def _send(self, code, body, started, extra_headers=None):
        self.sent = code

    def _log(self, code, started):
        pass

    class _Conn:
        def __init__(self, out):
            self.out = out

        def sendall(self, b):
            self.out.append(b)

        def settimeout(self, t):
            pass

        def recv(self, n):
            return b""      # immediate clean close -> session returns at once


def stub(headers, stub_session=True):
    st = _WSStub(headers)
    if stub_session:
        def _ran():
            st.session_ran = True
        st._volume_session = _ran
    return st


UPGRADE = {"Sec-WebSocket-Key": "dGhlIHNhbXBsZQ==", "Upgrade": "websocket"}

# (a) no token -> 401, no session
st = stub({})
st._handle_volume_ws(urlparse("/ws/volume"), 0.0)
check("no token -> 401", st.sent, 401)
check("no token -> no session", st.session_ran, False)

# (b) wrong token -> 401
st = stub({})
st._handle_volume_ws(urlparse("/ws/volume?token=WRONG"), 0.0)
check("wrong token -> 401", st.sent, 401)

# (c) valid token, no Upgrade -> 400
st = stub({})
st._handle_volume_ws(urlparse("/ws/volume?token=s3cr3t"), 0.0)
check("valid token, no upgrade -> 400", st.sent, 400)

# (d) valid handshake -> 101 sent + session ran
st = stub(UPGRADE)
st._handle_volume_ws(urlparse("/ws/volume?token=s3cr3t"), 0.0)
check("valid handshake -> session ran", st.session_ran, True)
check("valid handshake -> 101 upgrade sent",
      any(b.startswith(b"HTTP/1.1 101") for b in st._sendall), True)

# (e) real session -> hello sent + client de-registered on socket close
_saved_sessions = list(cs.VOLUME_SESSIONS)
try:
    st = stub(UPGRADE, stub_session=False)
    st._handle_volume_ws(urlparse("/ws/volume?token=s3cr3t"), 0.0)
    hello = ws_text_payload(st._sendall)
    check("hello frame sent", hello and hello.get("t"), "hello")
    check("hello advertises volume_events", "volume_events" in (hello or {}), True)
    check("client de-registered after close",
          any(e["conn"] is st.connection for e in cs.VOLUME_SESSIONS), False)
finally:
    cs.VOLUME_SESSIONS[:] = _saved_sessions

# --- 4. BROADCAST (outbound only, dead socket skipped) ----------------------
print()
print("3. _volume_broadcast: reaches live clients, skips a dead socket")


class _DeadConn:
    def sendall(self, b):
        raise OSError("broken pipe")


_saved_sessions = list(cs.VOLUME_SESSIONS)
try:
    live = _RecConn()
    cs.VOLUME_SESSIONS[:] = [
        {"conn": live, "slock": threading.Lock()},
        {"conn": _DeadConn(), "slock": threading.Lock()},
    ]
    cs._volume_broadcast({"t": "vol", "dir": "up"})     # must not raise despite dead
    check("live client received one frame", len(live.frames), 1)
    check("live client got the nudge JSON", ws_text_payload(live.frames),
          {"t": "vol", "dir": "up"})
finally:
    cs.VOLUME_SESSIONS[:] = _saved_sessions

print()
if FAILURES:
    print("FAILED: %s" % ", ".join(FAILURES))
    sys.exit(1)
print("all volume-event tests passed")
