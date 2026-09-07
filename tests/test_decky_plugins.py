#!/usr/bin/env python3
"""Decky manager Phase B — plugin listing, plugin jobs and the bounded Decky
WebSocket client, driven against a FAKE loopback Decky Loader.

Run: python3 tests/test_decky_plugins.py

WHY THIS FILE EXISTS (spec: docs/memory/project_decky-manager.md §8, §10, §14).
Every plugin op ends in a WebSocket call to a ROOT process (Decky Loader runs
as root out of the user's home; its `/auth/token` is unauthenticated). The
agent's whole safety story is therefore about what it REFUSES before a socket
is ever opened, and about never being pinned or OOMed by whatever answers on
127.0.0.1:1337. So, per CLAUDE.md §6, every refusal test below asserts on a
SOCKET-OPEN COUNTER (WS handshakes + /auth/token requests seen by the fake
loader, plus `_DeckyWS` constructions) and a SPAWN counter, not just on the
status code — a handler that answered 403 after talking to the loader would
pass a naive test and fail this one.

The fake loader (`FakeLoader`) speaks the loader's actual wire protocol as
pinned by the research capture (decky-loader v3.2.8, research localapi facts:
`GET /auth/token` -> bare uuid; `GET /ws?auth=<token>` -> 101; CALL
{"type":0,"route","args","id"} -> REPLY {"type":1,"id","result"} | ERROR
{"type":-1,"id","error":{name,message}} | DISCARD {"type":2,"id"}; the client
acks {"type":3,"id"}; EVENT {"type":5,"event","args"}; the install prompt
event `loader/add_plugin_install_prompt` carries [name, version, request_id,
hash, install_type]). It also enforces RFC 6455's client-masking rule so a
framing regression fails here rather than against the real loader.

Wall clock: the read-back / verify windows are repointed to a few seconds
(module constants), so the whole file runs in about a minute. Nothing here
touches the network, sudo, systemd or the real ~/homebrew.
"""
import base64
import hashlib
import http.client
import importlib.util
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
from http.server import ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location(
    "couchsided", os.path.join(ROOT, "agent", "couchsided.py"))
cs = importlib.util.module_from_spec(_spec)
sys.modules["couchsided"] = cs
_spec.loader.exec_module(cs)

FAILURES = []
TOKEN = "test-token-decky-plugins"


def check(name, got, want):
    if got == want:
        print("  PASS  %s" % name)
    else:
        print("  FAIL  %s (got %r, want %r)" % (name, got, want))
        FAILURES.append(name)


class Patch:
    """Swap module attributes for the duration of a `with`, restore after.
    Jobs run in threads that read these globals, so every `with` stays open
    until the job it started has finished."""

    def __init__(self, **kw):
        self._kw = kw
        self._old = {}

    def __enter__(self):
        for k, v in self._kw.items():
            self._old[k] = getattr(cs, k)
            setattr(cs, k, v)
        return self

    def __exit__(self, *a):
        for k, v in self._old.items():
            setattr(cs, k, v)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

# Two store entries VERBATIM from the plugins.deckbrew.xyz capture of
# 2026-09-06 (research.json, store topic): SteamGridDB (id 36, 21 versions —
# the normaliser must cap at 5) and Animation Changer (id 23, the 52 KB plugin
# the spec's hardware plan installs first). Real ids, names, hashes, dates.
STORE_VERBATIM = [
    {"id": 36, "name": "SteamGridDB", "author": "SteamGridDB", "description": "Customize your library with user-submitted images or local files, and other style tweaks like square capsules, uniform sizing, and more!", "tags": ["artwork", "sgdb"], "versions": [{"name": "1.7.1", "hash": "6d6eca184677dc9ff7736439ee7a575ca8ab386c5ffb1627d446bc43dbd1ecf3", "created": "2026-03-27T16:53:16Z", "downloads": 206912, "updates": 275005}, {"name": "1.7.0", "hash": "f18279dc95b6ee003a7f53a84e8f7eee3a8fdd042ef67e5160c91c31ad12659f", "created": "2025-10-28T02:35:51Z", "downloads": 252110, "updates": 263749}, {"name": "1.6.0", "hash": "6bc09af6ce16bf3437dc100129940310481338bbf2b198ed702854ed193d2e46", "created": "2025-07-07T14:18:55Z", "downloads": 144007, "updates": 250715}, {"name": "1.5.1-loaderv2", "hash": "b84f0a3f83b6e5d7cbc0ba9360bde33cfb400cf5f2a5d5c38f44a488e2c91a57", "created": "2024-09-05T14:49:49Z", "downloads": 491700, "updates": 135392}, {"name": "1.5.0-loaderv2", "hash": "9fac0bdd698c68d3584ef9cc70db891e644566faf4a0bf26ffc452e5c207358a", "created": "2024-08-24T12:11:19Z", "downloads": 82858, "updates": 1567}, {"name": "1.4.0", "hash": "c9243a2e95098899a08e2b2dab4a881fc029527b055a2a7741f8f3772bf7946b", "created": "2024-03-17T18:03:57Z", "downloads": 346649, "updates": 3427}, {"name": "1.3.3-1", "hash": "0b78bac79bb4aac8279c31dedc96e245d0aed176e9a45e0b359b75ac47135939", "created": "2024-01-20T03:59:08Z", "downloads": 78437, "updates": 113106}, {"name": "1.3.3", "hash": "441ecf2738e60129537e617ad3f4e3ccfd1d51d71cc2aa2ca2aab394f2063d86", "created": "2023-11-16T12:44:02Z", "downloads": 45338, "updates": 21689}, {"name": "1.3.2", "hash": "3efefffc47964e2088649f98e53287a3938526424ee71a4a7b7cabf96909b496", "created": "2023-11-14T20:46:32Z", "downloads": 157, "updates": 101}, {"name": "1.3.1", "hash": "30e29dfc52b1a353a50ce020ebf7d1f400b6d27273584678dacac36e488e4ac5", "created": "2023-09-18T13:17:55Z", "downloads": 74, "updates": 39}, {"name": "1.3.0", "hash": "3726585bcc5ab07036a18ac890b0b2642afb0aa3c142d75873399251994772a8", "created": "2023-08-22T23:34:03Z", "downloads": 143, "updates": 71}, {"name": "1.2.5", "hash": "599beab94ce4f6a06d4f7008bcf05a54389508d6258221c209a4e3b92419825e", "created": "2023-05-12T20:46:23Z", "downloads": 68, "updates": 25}, {"name": "1.2.4", "hash": "32e22e0252fe8b16847fa48993b3f22ee42ac2b53202a8740ca71141b4654535", "created": "2023-04-20T14:02:58Z", "downloads": 27, "updates": 27}, {"name": "1.2.3", "hash": "4484b1887b884b3f30eb3bfbe16b4d2f6f01b8f8d52c5c1ca3c26f6b67b5bd08", "created": "2023-04-05T10:22:09Z", "downloads": 11, "updates": 6}, {"name": "1.2.2", "hash": "352c99bf545ef0ddccd17326ff7f0e5c07d3bd5b55356873239f1140614e330d", "created": "2023-03-28T00:06:30Z", "downloads": 7, "updates": 6}, {"name": "1.2.1", "hash": "c3aebdc5fc73fd820e8dfcec7a1b8994b425ebd43c1385e0d5c7a7b2d5665479", "created": "2023-03-19T21:40:37Z", "downloads": 7, "updates": 5}, {"name": "1.2.0", "hash": "9c819693e4c67196ef232f14f7406fa9b7ac7897f425d6660b2382f005fa11bb", "created": "2023-03-07T23:08:57Z", "downloads": 50, "updates": 30}, {"name": "1.1.1", "hash": "6940b8672fce60926216e675cc101466bb55083efaa91010ba33d681c01db288", "created": "2023-02-24T22:58:52Z", "downloads": 220, "updates": 122}, {"name": "1.1.0", "hash": "848b2fff2bdf98d92ebe3450a8679f9bbd5855cf81475e94e3ea575ecef955ef", "created": "2023-02-19T02:23:56Z", "downloads": 15, "updates": 11}, {"name": "1.0.1", "hash": "eebf2093c109ca14fc960b212d101e6ac89102c7a8a8c86dc9d6c653cc179ff2", "created": "2023-01-20T23:28:47Z", "downloads": 8, "updates": 7}, {"name": "1.0.0", "hash": "0567f8a3468b32072692682f10f7d12534a43f0956e648a8f4a0d2b3e59407ab", "created": "2022-12-18T21:21:19Z", "downloads": 89, "updates": 59}], "visible": True, "image_url": "https://cdn.tzatzikiweeb.moe/file/steam-deck-homebrew/artifact_images/SteamGridDB-1a938447c46d3d7816c87181c20b96ca438840cbdbb556c13c37cf1f923b3512.png", "downloads": 1648887, "updates": 1065159, "created": "2022-12-18T21:21:19Z", "updated": "2026-03-27T16:53:16Z"},
    {"id": 23, "name": "Animation Changer", "author": "Justin Marentette", "description": "A boot/suspend animation management plugin.", "tags": ["boot-animation", "utility"], "versions": [{"name": "1.3.2", "hash": "f2c62b90ca60d8a80b6d0f75d8027552b1509c7a05842c6f4a24a9072846d133", "created": "2025-02-10T21:25:10Z", "downloads": 444287, "updates": 239418}, {"name": "1.3.1", "hash": "dfb5a6c6d7ddd5847f247596b3d19bbe937dbf4385c09ab8377526c87de31045", "created": "2024-05-07T17:56:13Z", "downloads": 317140, "updates": 29843}, {"name": "1.3.0-1", "hash": "63ede8fa94441e7917abd6edab4d8ac8317dbe1a49ad48f50a48085ff2039b0e", "created": "2023-05-15T18:53:14Z", "downloads": 100721, "updates": 10213}, {"name": "1.3.0", "hash": "f118f485dbd9a12878b054b2d39ae7a66bfa3b1388b88222f46f6fcaf584a952", "created": "2023-04-19T14:04:24Z", "downloads": 555, "updates": 314}, {"name": "1.2.4", "hash": "f73426674248701d718625c7cc996f4abc25daa5fd2be7625fc7163b1c6548b0", "created": "2023-03-11T03:33:38Z", "downloads": 86, "updates": 37}, {"name": "1.2.3", "hash": "5faeab2338c383e9325fa677f9b3895129d97de2e9804f1dcef870320bd3116d", "created": "2023-02-20T22:42:28Z", "downloads": 12, "updates": 14}, {"name": "1.2.2", "hash": "b36b3090f38913b8561da3bd8f03377879961b6ae53e237023c79d41778f77c1", "created": "2022-12-19T01:04:26Z", "downloads": 30, "updates": 16}, {"name": "1.2.1", "hash": "542bfb5b9ce7d192a238f32aa42a9ad89e7c98c9800cc0e5545d9b95e9fb783f", "created": "2022-11-12T19:03:19Z", "downloads": 15, "updates": 10}, {"name": "1.2.0", "hash": "79903d97be18da341bacc5724fb757d81b2e4429e9a47b1737d619354e0698ad", "created": "2022-10-31T00:24:51Z", "downloads": 49, "updates": 38}, {"name": "1.1.0", "hash": "d3a48d764db85aa7b58e1497942446f2ae6476a7d804d6b078bf9e3bc48f00e0", "created": "2022-10-16T16:11:01Z", "downloads": 8, "updates": 9}, {"name": "1.0.0", "hash": "13f2ecea0591f7928dfa93002ee0b32d664cd5cfd441413aff3c33f3959d8f17", "created": "2022-10-14T03:11:46Z", "downloads": 27, "updates": 30}, {"name": "0.0.1", "hash": "63a2e96ee6fe872b92530fed61a291470bccbd0a21d72af88a6a80c06cb98761", "created": "2022-10-09T22:46:29Z", "downloads": 19, "updates": 15}], "visible": True, "image_url": "https://cdn.tzatzikiweeb.moe/file/steam-deck-homebrew/artifact_images/Animation%20Changer-2f01eb07e607c3ebd99b7e76648bc2486910d33081fa8571a8f18f718727d8bd.png", "downloads": 862949, "updates": 279957, "created": "2022-10-09T22:46:29Z", "updated": "2025-02-10T21:25:10Z"},
]
AC_HASH = "f2c62b90ca60d8a80b6d0f75d8027552b1509c7a05842c6f4a24a9072846d133"
AC_VERSION = "1.3.2"

# SYNTHETIC store entries (the real store carries no plugin named Couchside):
# a store row named exactly like the box's own management panel, and one whose
# name is an NFKC homoglyph of it (U+FF23 FULLWIDTH LATIN CAPITAL LETTER C).
# Both must be refused BEFORE any socket — Decky's _install uninstalls the
# same-named plugin first, so accepting either would let a phone remove the
# Couchside panel by "installing" a store plugin.
STORE_SYNTHETIC = [
    {"id": 900001, "name": "Couchside", "author": "Emery Tech", "description": "not the real one",
     "tags": [], "downloads": 1, "created": "2026-09-06T00:00:00Z", "updated": "2026-09-06T00:00:00Z",
     "image_url": None, "versions": [{"name": "0.3.0", "hash": "a" * 64, "created": "2026-09-06T00:00:00Z"}]},
    {"id": 900002, "name": "Ｃouchside", "author": "Emery Tech", "description": "homoglyph",
     "tags": [], "downloads": 1, "created": "2026-09-06T00:00:00Z", "updated": "2026-09-06T00:00:00Z",
     "image_url": None, "versions": [{"name": "0.3.0", "hash": "b" * 64, "created": "2026-09-06T00:00:00Z"}]},
]

# The token the research session's v3.2.8 backend handed out over /auth/token
# (research.json token.txt, verbatim): 36 chars of [0-9a-f-]. The fake loader
# serves exactly this so the agent's shape check runs against a real value.
LOADER_TOKEN = "2a85f0ca-54b8-4a30-a41e-06c4f6f53b91"

# /proc/net/tcp rows in the kernel's column layout (net/ipv4/tcp_ipv4.c
# get_tcp4_sock: sl, local, remote, st, tx:rx, tr:when, retrnsmt, uid, timeout,
# inode, ...). NOT captured on the Bazzite box (spec §16 item 8 is still
# outstanding) — hand-written to the documented layout, with 127.0.0.1:1337
# spelled 0100007F:0539 and LISTEN as 0A. The uid column (index 7 after
# split) is the only thing the agent reads; the row for a REAL loader must
# read 0 and a user-level impostor on a free port 1337 must not.
PROC_NET_TCP_HEADER = ("  sl  local_address rem_address   st tx_queue rx_queue tr tm->when "
                       "retrnsmt   uid  timeout inode\n")
PROC_NET_TCP_ROW = ("   %d: %s %s %s 00000000:00000000 00:00000000 00000000 %5d        0 "
                    "%d 1 0000000000000000 100 0 0 10 0\n")


def proc_net_tcp(rows):
    """rows: list of (local, remote, state_hex, uid, inode)."""
    text = PROC_NET_TCP_HEADER
    for i, (local, remote, st, uid, inode) in enumerate(rows):
        text += PROC_NET_TCP_ROW % (i, local, remote, st, uid, inode)
    return text


TCP_ROOT_LOADER = [("0100007F:0539", "00000000:0000", "0A", 0, 31337),
                   ("0100007F:2253", "00000000:0000", "0A", 1000, 40001)]   # :8787 couchside
TCP_USER_IMPOSTOR = [("0100007F:0539", "00000000:0000", "0A", 1000, 31338)]
TCP_ESTABLISHED_ONLY = [("0100007F:0539", "0100007F:C1A4", "01", 0, 31339)]  # a client, no LISTEN


def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w" if isinstance(data, str) else "wb") as f:
        f.write(data)


def plugin(root, folder, name, version="1.0.0", flags=None, pkg=True):
    """One on-disk plugin folder the way Decky lays it out (plugin.json is
    what makes a folder a plugin; package.json carries the version)."""
    write(os.path.join(root, folder, "plugin.json"),
          json.dumps({"name": name, "author": "a", "flags": flags or []}))
    if pkg:
        write(os.path.join(root, folder, "package.json"), json.dumps({"version": version}))


# ---------------------------------------------------------------------------
# Spies: sockets and spawns
# ---------------------------------------------------------------------------

SOCKETS = {"ws": 0}          # _DeckyWS constructions (client side)
SPAWNS = []                  # subprocess.run / Popen argv + helper verbs
# `cs.subprocess` IS this file's `subprocess` (one module object), so SpyProc
# below blinds every caller; the test's own flock-holder child must use the
# real Popen captured here.
_REAL_POPEN = subprocess.Popen


_RealDeckyWS = cs._DeckyWS          # captured BEFORE Env patches cs._DeckyWS


class CountingWS(_RealDeckyWS):
    """Every socket the agent opens toward the loader goes through here. The
    base class is the captured original (cs._DeckyWS is rebound to THIS class
    inside Env, so naming it here would recurse)."""

    def __init__(self, *a, **kw):
        SOCKETS["ws"] += 1
        _RealDeckyWS.__init__(self, *a, **kw)


class SpyProc:
    """Record instead of spawning anything; nothing here should ever run."""

    def __enter__(self):
        self._run, self._popen, self._helper = (cs.subprocess.run, cs.subprocess.Popen,
                                                cs._helper_call)

        class R:
            returncode = 1
            stdout = ""
            stderr = "spy"

        def run(argv, *a, **kw):
            SPAWNS.append(list(argv))
            return R()

        def popen(argv, *a, **kw):
            SPAWNS.append(list(argv))
            return R()

        def helper(verb, arg=None, timeout=10):
            SPAWNS.append(["helper", verb, arg])
            return None
        cs.subprocess.run, cs.subprocess.Popen, cs._helper_call = run, popen, helper
        return self

    def __exit__(self, *a):
        cs.subprocess.run, cs.subprocess.Popen, cs._helper_call = (self._run, self._popen,
                                                                   self._helper)


# ---------------------------------------------------------------------------
# The fake loopback Decky Loader
# ---------------------------------------------------------------------------

class FakeLoader:
    """Loopback HTTP (/auth/token) + WebSocket (/ws) speaking Decky's framing.

    Scripted replies: `script[route](loader, conn, msg)` returns a list of
    JSON messages to send (or the literal "CLOSE" to send a close frame and
    hang up). Records every CALL as (route, args, id) and every ack as
    ("ack", id); counts token requests and WS handshakes (`token_reqs`,
    `opens`) — the socket-open counters every refusal test asserts on — and
    stamps open/close times so "socket closed within the 3 s budget" is a
    measurement, not a hope. Modes: 'hugeframe' announces a 2^62-byte frame,
    'drip' sends one header byte every 300 ms forever, 'badaccept' answers a
    wrong Sec-WebSocket-Accept, 'closeimmediately' reads one frame then closes.
    """
    GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

    def __init__(self, script=None, mode="normal", token=LOADER_TOKEN):
        self.calls = []
        self.opens = 0
        self.token_reqs = 0
        self.open_at = []
        self.closed_at = []
        self.job_file_at_open = []
        self.script = script or {}
        self.mode = mode
        self.token = token
        self.srv = socket.socket()
        self.srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.srv.bind(("127.0.0.1", 0))
        self.srv.listen(8)
        self.port = self.srv.getsockname()[1]
        self.alive = True
        threading.Thread(target=self.loop, daemon=True).start()

    def loop(self):
        while self.alive:
            try:
                c, _ = self.srv.accept()
            except OSError:
                return
            threading.Thread(target=self.handle, args=(c,), daemon=True).start()

    @staticmethod
    def frame(payload, opcode=0x1):
        n = len(payload)
        if n < 126:
            hdr = bytes([0x80 | opcode, n])
        elif n < 65536:
            hdr = bytes([0x80 | opcode, 126]) + struct.pack("!H", n)
        else:
            hdr = bytes([0x80 | opcode, 127]) + struct.pack("!Q", n)
        return hdr + payload

    @staticmethod
    def recv_exact(c, n):
        b = b""
        while len(b) < n:
            ch = c.recv(n - len(b))
            if not ch:
                raise IOError("closed")
            b += ch
        return b

    def read_frame(self, c):
        b0, b1 = self.recv_exact(c, 2)
        op, ln = b0 & 0xF, b1 & 0x7F
        if ln == 126:
            ln = struct.unpack("!H", self.recv_exact(c, 2))[0]
        elif ln == 127:
            ln = struct.unpack("!Q", self.recv_exact(c, 8))[0]
        if not b1 & 0x80:
            raise AssertionError("client frame must be masked (RFC 6455 §5.1)")
        mask = self.recv_exact(c, 4)
        data = self.recv_exact(c, ln)
        return op, bytes(x ^ mask[i % 4] for i, x in enumerate(data))

    def handle(self, c):
        opened = False
        try:
            c.settimeout(15)
            req = b""
            while b"\r\n\r\n" not in req:
                ch = c.recv(1024)
                if not ch:
                    return
                req += ch
            line = req.split(b"\r\n", 1)[0].decode()
            if line.startswith("GET /auth/token"):
                self.token_reqs += 1
                body = self.token.encode()
                c.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: %d\r\nConnection: close\r\n\r\n"
                          % len(body) + body)
                return
            if not line.startswith("GET /ws?auth=" + self.token + " "):
                c.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
                return
            opened = True
            self.opens += 1
            self.open_at.append(time.monotonic())
            self.job_file_at_open.append(os.path.exists(cs._DECKY_JOB_FILE))
            key = [l for l in req.decode().split("\r\n")
                   if l.lower().startswith("sec-websocket-key:")][0].split(":", 1)[1].strip()
            acc = base64.b64encode(hashlib.sha1((key + self.GUID).encode()).digest()).decode()
            if self.mode == "badaccept":
                acc = "AAAA"
            c.sendall(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
                       "Connection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n" % acc).encode())
            if self.mode == "hugeframe":
                # A 2^62-byte TEXT frame header followed by 100 real bytes.
                c.sendall(bytes([0x81, 127]) + struct.pack("!Q", 2 ** 62) + b"x" * 100)
                time.sleep(2)
                return
            if self.mode == "drip":
                while self.alive:
                    c.sendall(b"\x81")             # a header that never completes
                    time.sleep(0.3)
                return
            if self.mode == "closeimmediately":
                self.read_frame(c)
                c.sendall(self.frame(b"", 0x8))
                return
            while True:
                op, data = self.read_frame(c)
                if op == 0x8:
                    return
                msg = json.loads(data.decode())
                if msg.get("type") == 3:
                    self.calls.append(("ack", msg["id"]))
                    continue
                self.calls.append((msg["route"], msg["args"], msg["id"]))
                fn = self.script.get(msg["route"])
                out = fn(self, c, msg) if fn else [{"type": 1, "id": msg["id"], "result": None}]
                for o in (out or []):
                    if o == "CLOSE":
                        c.sendall(self.frame(b"", 0x8))
                        return
                    c.sendall(self.frame(json.dumps(o).encode()))
        except Exception:
            pass
        finally:
            if opened:
                self.closed_at.append(time.monotonic())
            try:
                c.close()
            except Exception:
                pass

    def stop(self):
        self.alive = False
        try:
            self.srv.close()
        except Exception:
            pass


def reply(msg, result=None):
    return {"type": 1, "id": msg["id"], "result": result}


def prompt_event(args, request_id):
    """The loader's `loader/add_plugin_install_prompt` event: args are
    [name, version, request_id, hash, install_type] (research localapi (d));
    request_id is str(time.time()) on the loader side."""
    return {"type": 5, "event": "loader/add_plugin_install_prompt",
            "args": [args[1], args[2], request_id, args[3], args[4]]}


def get_plugins_reply(msg, rows):
    """loader/get_plugins answers [{name, version, load_type, disabled}]
    (loader.py:132-134)."""
    return reply(msg, [{"name": n, "version": v, "load_type": 0, "disabled": d}
                       for (n, v, d) in rows])


# ---------------------------------------------------------------------------
# Environment: every module-constant root repointed at a temp tree
# ---------------------------------------------------------------------------

class Env:
    """A temp tree standing in for the box: plugins dir, settings, job file,
    /run/couchside (empty -> the REAL flock probe says idle), a /proc/net/tcp
    fixture (root loader by default), and the fake loader's port/token URL."""

    def __init__(self, fl=None, tcp_rows=None, **extra):
        self.tmp = tempfile.mkdtemp(prefix="decky-plugins-")
        self.plugins = os.path.join(self.tmp, "homebrew", "plugins")
        os.makedirs(self.plugins)
        self.run = os.path.join(self.tmp, "run")
        os.makedirs(self.run)
        self.job_file = os.path.join(self.tmp, "cache", "decky-job.json")
        self.tcp = os.path.join(self.tmp, "proc-net-tcp")
        write(self.tcp, proc_net_tcp(TCP_ROOT_LOADER if tcp_rows is None else tcp_rows))
        kw = dict(
            _DECKY_PLUGINS_DIR=self.plugins,
            _DECKY_SETTINGS=os.path.join(self.tmp, "homebrew", "settings", "loader.json"),
            _DECKY_JOB_FILE=self.job_file,
            _DECKY_RUN=self.run,
            _DECKY_PROC_NET_TCP=self.tcp,
            _DECKY_ICON_DIR=os.path.join(self.tmp, "icons"),
            _decky_allowed=lambda: True,
            _decky_loader_installed=lambda: True,
            _decky_loader_state=lambda: {"state": "running", "restart_action": "restart-decky",
                                         "stopped_reason": None, "steam_ui_up": True},
            _decky_journal_tail=lambda n=30: ["journal: fake plugin_loader line"],
            _DECKY_INSTALL_READBACK_S=4.0,
            _DECKY_UNINSTALL_VERIFY_S=3.0,
            _DeckyWS=CountingWS,
        )
        if fl is not None:
            kw["_DECKY_WS_PORT"] = fl.port
            kw["_DECKY_TOKEN_URL"] = "http://127.0.0.1:%d/auth/token" % fl.port
        kw.update(extra)
        self.patch = Patch(**kw)

    def __enter__(self):
        self.patch.__enter__()
        reset_state()
        return self

    def __exit__(self, *a):
        self.patch.__exit__(*a)
        reset_state()
        shutil.rmtree(self.tmp, ignore_errors=True)


def reset_state():
    """Forget every memoised probe and the live job slot between cases (the
    30 s / 10 s / 2 s / 0.5 s caches otherwise leak across cases)."""
    cs._decky_invalidate()
    with cs._DECKY_JOB_LOCK:
        cs._DECKY_JOB["rec"] = None
    with cs._DECKY_CHECK_LOCK:
        cs._DECKY_CHECK["val"] = None
        cs._DECKY_CHECK["at"] = 0.0
        cs._DECKY_CHECK["in_flight"] = False
    SOCKETS["ws"] = 0
    SPAWNS[:] = []


def warm_store(extra=()):
    cs._decky_store_install(cs._decky_store_normalise(STORE_VERBATIM + list(extra)),
                            int(time.time()))


def cold_store():
    cs._decky_store_install([], None)
    with cs._DECKY_STORE_LOCK:
        cs._DECKY_STORE["fetched_at"] = None
        cs._DECKY_STORE["stale"] = False


def wait_job(timeout=15):
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        rec = cs._DECKY_JOB["rec"]
        if rec and rec.get("done"):
            return rec
        time.sleep(0.05)
    return cs._DECKY_JOB["rec"]


def calls(fl, route):
    return [c for c in fl.calls if c[0] == route]


# ---------------------------------------------------------------------------
# HTTP plumbing (real Handler, real-mode, Steam root faked)
# ---------------------------------------------------------------------------

def _server():
    cs.Handler.token = TOKEN
    cs.Handler.token_file = None
    cs.Handler.mock = False
    cs.Handler.port = 0
    srv = ThreadingHTTPServer(("127.0.0.1", 0), cs.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


def _req(port, method, path, token=TOKEN, body=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    headers = {"Authorization": "Bearer " + token} if token is not None else {}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    conn.request(method, path, body=data, headers=headers)
    resp = conn.getresponse()
    raw = resp.read()
    conn.close()
    try:
        return resp.status, json.loads(raw or b"{}")
    except ValueError:
        return resp.status, {}


PHASE_B_ROUTES = [
    ("GET", "/api/decky/plugins"), ("GET", "/api/decky/store"), ("GET", "/api/decky/jobs"),
    ("GET", "/api/decky/store/icon/36"),
    ("POST", "/api/decky/store/refresh"), ("POST", "/api/decky/loader/check"),
    ("POST", "/api/decky/plugins/install"), ("POST", "/api/decky/plugins/uninstall"),
    ("POST", "/api/decky/plugins/reload"),
]


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_http_auth_every_route():
    """CLAUDE.md §3.4: every Phase B route is bearer-gated — no bearer and a
    wrong bearer are both 401, on the icon route also with a wrong ?token=.
    Control: the right token reaches the handler (200 on jobs/plugins), and
    without a Steam root the same authed route is a 404 (probe-and-appear,
    never an `unsupported` state). The 401 must come before any loader
    contact: the fake loader sees zero handshakes and zero token requests."""
    print("test_http_auth_every_route")
    fl = FakeLoader()
    fake_root = tempfile.mkdtemp(prefix="steam-root-")
    srv, port = _server()
    try:
        with Env(fl, _steam_root=lambda: fake_root):
            warm_store()
            for method, path in PHASE_B_ROUTES:
                body = {"id": 23} if path.endswith("/install") else (
                    {"name": "x"} if path.endswith(("/uninstall", "/reload")) else None)
                check("%s %s no bearer -> 401" % (method, path),
                      _req(port, method, path, token=None, body=body)[0], 401)
                check("%s %s wrong bearer -> 401" % (method, path),
                      _req(port, method, path, token="nope", body=body)[0], 401)
            check("icon route wrong ?token= -> 401",
                  _req(port, "GET", "/api/decky/store/icon/36?token=nope", token=None)[0], 401)
            check("no loader contact behind a 401", (fl.opens, fl.token_reqs, SOCKETS["ws"]),
                  (0, 0, 0))
            # Controls: the right token reaches the handlers.
            st, body = _req(port, "GET", "/api/decky/jobs")
            check("right bearer -> 200 jobs (control)", (st, body.get("job")), (200, None))
            st, body = _req(port, "GET", "/api/decky/plugins")
            check("right bearer -> 200 plugins listing (control)",
                  (st, body.get("available"), body.get("source")), (200, True, "fs"))
            # Marker absent over HTTP: 403 with nothing opened.
            with Patch(_decky_allowed=lambda: False):
                st, body = _req(port, "POST", "/api/decky/plugins/install", body={"id": 23})
                check("HTTP install without marker -> 403 needs_optin",
                      (st, body.get("needs_optin")), (403, True))
                st, body = _req(port, "POST", "/api/decky/store/refresh")
                check("HTTP store refresh without marker -> 403", st, 403)
            check("...zero sockets, zero token requests, no job record",
                  (fl.opens, fl.token_reqs, SOCKETS["ws"], os.path.exists(cs._DECKY_JOB_FILE)),
                  (0, 0, 0, False))
        with Env(fl, _steam_root=lambda: None):
            check("no Steam root -> authed plugins route is 404 (control)",
                  _req(port, "GET", "/api/decky/plugins")[0], 404)
            check("no Steam root -> authed install POST is 404 (control)",
                  _req(port, "POST", "/api/decky/plugins/install", body={"id": 23})[0], 404)
    finally:
        cold_store()
        srv.shutdown()
        fl.stop()
        shutil.rmtree(fake_root, ignore_errors=True)


def test_listener_uid_fixture():
    """`_decky_loader_is_root()` reads the /proc/net/tcp fixture: a uid-0
    LISTEN row on 0100007F:0539 is root; a uid-1000 impostor is 'other'; an
    ESTABLISHED-only row (a client, not a listener) and an unreadable file are
    None -> False (degrade closed, §3.7). And the token is fetched ONLY behind
    a root listener: with the impostor row the fake loader sees zero token
    requests even though it would happily answer."""
    print("test_listener_uid_fixture")
    fl = FakeLoader()
    try:
        with Env(fl) as env:
            check("root LISTEN row -> 'root'", cs._decky_listener_uid(), "root")
            check("...loader_is_root True", cs._decky_loader_is_root(), True)
            check("token fetched behind a root listener (control)",
                  cs._decky_fetch_token(), LOADER_TOKEN)
            check("...one token request", fl.token_reqs, 1)
            write(env.tcp, proc_net_tcp(TCP_USER_IMPOSTOR))
            check("uid 1000 LISTEN row -> 'other'", cs._decky_listener_uid(), "other")
            check("...loader_is_root False", cs._decky_loader_is_root(), False)
            check("impostor -> no token fetched", cs._decky_fetch_token(), None)
            check("...and the loader saw no request", fl.token_reqs, 1)
            write(env.tcp, proc_net_tcp(TCP_ESTABLISHED_ONLY))
            check("ESTABLISHED-only row -> None (no listener)", cs._decky_listener_uid(), None)
            write(env.tcp, proc_net_tcp([]))
            check("header only -> None", cs._decky_listener_uid(), None)
            os.unlink(env.tcp)
            check("unreadable /proc/net/tcp -> None, never root",
                  (cs._decky_listener_uid(), cs._decky_loader_is_root()), (None, False))
            # The token shape gate: a loader answering garbage yields no token.
            write(env.tcp, proc_net_tcp(TCP_ROOT_LOADER))
            fl.token = "<html>not a token</html>"
            check("mis-shaped token refused", cs._decky_fetch_token(), None)
            fl.token = LOADER_TOKEN
    finally:
        fl.stop()


def test_refusals_open_no_socket():
    """Every refusal in the §10 precondition chain and the §3 lookups happens
    BEFORE a socket: marker absent -> 403; names not in the enumerated set,
    `../x`, non-str, empty, 65 chars, an NFKC homoglyph of Couchside -> 404;
    Couchside itself (and a homoglyph folder on disk) -> 409; store entry
    named Couchside / homoglyph -> 409; unknown id / true / "36" / 0 / 1e9 ->
    404/400; 63-char or uppercase hash -> 422; cold store -> 503;
    loader_stopped -> 409 naming the restart action with NO restart spawned;
    non-root listener -> 503 loader_down. The fake loader counts zero
    handshakes and zero token requests across all of it, nothing spawns, and
    no job record is written."""
    print("test_refusals_open_no_socket")
    fl = FakeLoader()
    try:
        with Env(fl) as env, SpyProc():
            warm_store(STORE_SYNTHETIC)
            plugin(env.plugins, "Couchside", "Couchside", "0.2.9", flags=["root"])
            plugin(env.plugins, "Homoglyph", "Ｃouchside", "0.1.0")
            plugin(env.plugins, "Real", "Animation Changer", "1.3.0")
            with Patch(_decky_allowed=lambda: False):
                check("install without marker -> 403", cs.decky_plugin_install({"id": 23})[0], 403)
                check("uninstall without marker -> 403",
                      cs.decky_plugin_op("uninstall", {"name": "Animation Changer"})[0], 403)
                check("reload without marker -> 403",
                      cs.decky_plugin_op("reload", {"name": "Animation Changer"})[0], 403)
                check("loader check without marker -> 403", cs.decky_loader_check()[0], 403)
            # Shape gate (400) vs membership gate (404): a printable 1-64 char
            # string that is simply not a plugin.json name on disk is 404 —
            # including a traversal-shaped one, which is never used as a path.
            for bad, why in (("nope", "not in the enumerated set"), ("../x", "traversal shape"),
                             ("Animation Changer ", "trailing space"),
                             ("animation changer", "case differs")):
                check("uninstall %r (%s) -> 404 by membership" % (bad, why),
                      cs.decky_plugin_op("uninstall", {"name": bad})[0], 404)
            for bad, why in (("", "empty"), ("x" * 65, "65 chars"), ("a\x00b", "NUL, not printable")):
                check("uninstall %r (%s) -> 400 by shape" % (bad, why),
                      cs.decky_plugin_op("uninstall", {"name": bad})[0], 400)
            check("uninstall non-str name -> 400",
                  cs.decky_plugin_op("uninstall", {"name": 5})[0], 400)
            check("uninstall list name -> 400",
                  cs.decky_plugin_op("uninstall", {"name": ["Animation Changer"]})[0], 400)
            check("uninstall non-object body -> 400",
                  cs.decky_plugin_op("uninstall", ["Animation Changer"])[0], 400)
            check("bad op literal -> 404",
                  cs.decky_plugin_op("disable", {"name": "Animation Changer"})[0], 404)
            check("uninstall Couchside -> 409 protected",
                  cs.decky_plugin_op("uninstall", {"name": "Couchside"})[1].get("error"), "protected")
            check("reload Couchside -> 409 protected",
                  cs.decky_plugin_op("reload", {"name": "Couchside"})[0], 409)
            check("homoglyph folder on disk is marked protected in the listing",
                  cs._decky_plugins_on_disk()["Ｃouchside"]["protected"], True)
            check("uninstall NFKC homoglyph on disk -> 409",
                  cs.decky_plugin_op("uninstall", {"name": "Ｃouchside"})[0], 409)
            shutil.rmtree(os.path.join(env.plugins, "Homoglyph"))
            check("uninstall NFKC homoglyph NOT on disk -> 404",
                  cs.decky_plugin_op("uninstall", {"name": "Ｃouchside"})[0], 404)
            check("store entry named Couchside -> 409 before any socket",
                  cs.decky_plugin_install({"id": 900001})[0], 409)
            check("store entry homoglyph of Couchside -> 409",
                  cs.decky_plugin_install({"id": 900002})[0], 409)
            for bad in (True, False, "36", 0, -1, 10 ** 9, 3.0, None, [36]):
                check("install id %r -> 400" % (bad,), cs.decky_plugin_install({"id": bad})[0], 400)
            check("install non-object body -> 400", cs.decky_plugin_install([23])[0], 400)
            check("install unknown id -> 404", cs.decky_plugin_install({"id": 5})[0], 404)
            with cs._DECKY_STORE_LOCK:
                cs._DECKY_STORE["by_id"][23]["versions"][0]["hash"] = AC_HASH[:63]
            check("63-char hash -> 422 no verifiable hash",
                  cs.decky_plugin_install({"id": 23})[1].get("error"), "no verifiable hash")
            with cs._DECKY_STORE_LOCK:
                cs._DECKY_STORE["by_id"][23]["versions"][0]["hash"] = AC_HASH.upper()
            check("uppercase hash -> 422", cs.decky_plugin_install({"id": 23})[0], 422)
            with cs._DECKY_STORE_LOCK:
                cs._DECKY_STORE["by_id"][23]["versions"][0]["hash"] = AC_HASH
            cold_store()
            check("cold store -> 503 store_unavailable",
                  cs.decky_plugin_install({"id": 23})[1].get("error"), "store_unavailable")
            warm_store(STORE_SYNTHETIC)
            stopped = {"state": "installed_stopped", "restart_action": "restart-decky",
                       "stopped_reason": "self_stop_recent", "steam_ui_up": False}
            with Patch(_decky_loader_state=lambda: stopped):
                code, body = cs.decky_plugin_install({"id": 23})
                check("loader stopped -> 409 loader_stopped naming the restart action",
                      (code, body.get("error"), body.get("restart_action"), body.get("repair"),
                       body.get("stopped_reason")),
                      (409, "loader_stopped", "restart-decky", True, "self_stop_recent"))
                check("reload on a stopped loader -> 409 too",
                      cs.decky_plugin_op("reload", {"name": "Animation Changer"})[0], 409)
            for st in ("running_untrusted", "running_unreachable"):
                with Patch(_decky_loader_state=lambda st=st: {"state": st}):
                    code, body = cs.decky_plugin_install({"id": 23})
                    check("%s -> 503 loader_down" % st, (code, body.get("error")),
                          (503, "loader_down"))
            with Patch(_decky_loader_state=lambda: {"state": "not_installed"}):
                code, body = cs.decky_plugin_op("reload", {"name": "Animation Changer"})
                check("not_installed -> 503 loader_down installed:false",
                      (code, body.get("error"), body.get("installed")), (503, "loader_down", False))
            with Patch(_decky_loader_state=lambda: {"state": "installing"}):
                check("loader installing -> 409 busy loader_op",
                      cs.decky_plugin_install({"id": 23})[1].get("what"), "loader_op")
            # THE point of this whole function:
            check("zero WS handshakes across every refusal", fl.opens, 0)
            check("zero /auth/token requests across every refusal", fl.token_reqs, 0)
            check("zero _DeckyWS constructions", SOCKETS["ws"], 0)
            check("nothing spawned (no restart, no helper verb)", SPAWNS, [])
            check("no job record written by any refusal", os.path.exists(env.job_file), False)
            check("job slot still free", cs._decky_busy(), None)
            # Non-root listener at JOB time (the state machine said running but
            # /proc/net/tcp disagrees): the job fails loader_down with zero sockets.
            write(env.tcp, proc_net_tcp(TCP_USER_IMPOSTOR))
            code, body = cs.decky_plugin_op("reload", {"name": "Animation Changer"})
            rec = wait_job()
            check("impostor on 1337 at job time -> job fails loader_down",
                  (code, rec.get("outcome"), rec.get("error"), rec.get("loader_down")),
                  (200, "failed", "loader_down", True))
            check("...and zero sockets, zero token requests", (fl.opens, fl.token_reqs), (0, 0))
    finally:
        cold_store()
        fl.stop()


def _install_script(env, folder="AnimationChanger", request_id="1757178000.123456",
                    appear_after=0.8, listed=True):
    """A cooperative loader: install_plugin -> reply + prompt event; confirm
    -> reply, then the folder 'appears' on disk; get_plugins lists it."""
    def install_plugin(loader, c, msg):
        return [reply(msg), prompt_event(msg["args"], request_id)]

    def confirm(loader, c, msg):
        threading.Timer(appear_after, lambda: plugin(env.plugins, folder, "Animation Changer",
                                                     AC_VERSION)).start()
        return [reply(msg)]

    def get_plugins(loader, c, msg):
        rows = [("Animation Changer", AC_VERSION, False)] if listed else []
        return [get_plugins_reply(msg, rows)]
    return {"utilities/install_plugin": install_plugin,
            "utilities/confirm_plugin_install": confirm,
            "loader/get_plugins": get_plugins}


def test_install_job_happy_path():
    """The one write burst (§10): install_plugin args are EXACTLY
    [CDN+hash+'.zip', store name, store version, hash, install_type] — nothing
    from the request body; the confirm carries the prompt event's request_id;
    the job record hits disk BEFORE the first handshake; the socket is closed
    within the 3 s session budget; the job finishes done/verified after the
    folder appears AND get_plugins lists it (two sessions total); the hash
    never reaches the public record; while it runs a second install is 409
    plugin_job and `_decky_busy()` says so. Then the four install_type cases
    (+ unparsable installed version -> REINSTALL) drive the enum value."""
    print("test_install_job_happy_path")
    fl = None
    try:
        with Env() as env:
            fl = FakeLoader(_install_script(env))
            with Patch(_DECKY_WS_PORT=fl.port,
                       _DECKY_TOKEN_URL="http://127.0.0.1:%d/auth/token" % fl.port):
                warm_store()
                code, body = cs.decky_plugin_install({"id": 23})
                check("install accepted as a job",
                      (code, body["ok"], body["job"]["kind"], body["job"]["name"]),
                      (200, True, "install", "Animation Changer"))
                check("public job carries no hash / request_id",
                      ("hash" in body["job"], "request_id" in body["job"]), (False, False))
                check("second install while running -> 409 plugin_job",
                      cs.decky_plugin_install({"id": 36})[1].get("what"), "plugin_job")
                check("the single mutex reports plugin_job", cs._decky_busy(), "plugin_job")
                rec = wait_job()
                check("job done, verified", (rec["outcome"], rec["ok"], rec["verified"], rec["error"]),
                      ("done", True, True, None))
                check("record on disk before the first handshake", fl.job_file_at_open, [True, True])
                ip = calls(fl, "utilities/install_plugin")
                check("exactly one install_plugin", len(ip), 1)
                check("install_plugin args exact (INSTALL=0)", ip[0][1],
                      [cs._DECKY_CDN + AC_HASH + ".zip", "Animation Changer", AC_VERSION, AC_HASH, 0])
                cf = calls(fl, "utilities/confirm_plugin_install")
                check("confirm uses the prompt event's request_id", [c[1] for c in cf],
                      [["1757178000.123456"]])
                check("burst session closed within 3 s",
                      len(fl.closed_at) >= 1 and (fl.closed_at[0] - fl.open_at[0]) < 3.0, True)
                check("two sessions: burst + get_plugins read-back", fl.opens, 2)
                check("every reply acked", any(c[0] == "ack" for c in fl.calls), True)
                check("call ids from the 2^40..2^52 range",
                      all(2 ** 40 <= c[2] < 2 ** 52 for c in fl.calls if c[0] != "ack"), True)
                check("slot freed after done", cs._decky_busy(), None)
                pub = cs.decky_jobs_payload()["job"]
                check("jobs payload shows the finished job", (pub["outcome"], pub["done"]),
                      ("done", True))
                check("disk record agrees", cs._decky_job_read()["outcome"], "done")
                # install_type enum from the installed version (strict semver).
                for installed, want_kind, want_type, label in (
                        ("1.3.0", "update", 2, "older installed -> UPDATE"),
                        ("9.0.0", "update", 3, "newer installed -> DOWNGRADE"),
                        (AC_VERSION, "update", 1, "equal -> REINSTALL"),
                        ("dev", "update", 1, "unparsable installed -> REINSTALL"),
                        ("2.0.17-f57f127", "update", 1, "hash-suffixed installed -> REINSTALL, never a phantom UPDATE")):
                    shutil.rmtree(os.path.join(env.plugins, "AnimationChanger"), ignore_errors=True)
                    plugin(env.plugins, "AnimationChanger", "Animation Changer", installed)
                    fl.calls[:] = []
                    reset_state()
                    code, body = cs.decky_plugin_install({"id": 23})
                    rec = wait_job()
                    ip = calls(fl, "utilities/install_plugin")
                    check(label, (code, body["job"]["kind"], body["job"]["old_version"],
                                  ip[0][1][4], rec["outcome"]),
                          (200, want_kind, installed, want_type, "done"))
    finally:
        cold_store()
        if fl:
            fl.stop()


def test_install_job_failures():
    """Failure shapes that must never be reported as a false success or a
    false loader_down: (a) the loader answers install_plugin but never emits
    the prompt -> failed with retry:true inside the budget, and NO cancel is
    sent because no request_id was ever learned; (b) spec §10/§14: the prompt
    arrived but the confirm reply never does -> `retry` and a
    cancel_plugin_install in a fresh session; (c) folder appears but
    get_plugins never lists it -> failed 'extracted but not loaded' with the
    journal tail; (d) an UPDATE whose old copy Decky removed and never
    replaced -> the removal message + reinstall_id; (e) the socket closes
    after install_plugin was accepted -> outcome unknown, then the read-back
    settles it to done."""
    print("test_install_job_failures")
    fl = None
    try:
        with Env() as env:
            warm_store()
            # (a) prompt never arrives
            fl = FakeLoader({"utilities/install_plugin": lambda l, c, m: [reply(m)]})
            with Patch(_DECKY_WS_PORT=fl.port,
                       _DECKY_TOKEN_URL="http://127.0.0.1:%d/auth/token" % fl.port):
                t0 = time.monotonic()
                cs.decky_plugin_install({"id": 23})
                rec = wait_job()
                check("no prompt -> failed with retry:true",
                      (rec["outcome"], rec["retry"], rec["ok"]), ("failed", True, False))
                check("...within the session budget (+slack)", time.monotonic() - t0 < 6.0, True)
                check("...no cancel without a request_id",
                      calls(fl, "utilities/cancel_plugin_install"), [])
                check("...slot freed", cs._decky_busy(), None)
            fl.stop()
            # (b) KI-074 (HARDWARE-CONFIRMED 2026-09-07): the prompt arrives, the
            # confirm FRAME is sent, but its REPLY is lost past the budget (the
            # Steam frontend reconnected and displaced our socket) — AND Decky
            # installs the plugin anyway. This must NOT report retry/"nothing
            # installed": confirm_sent -> read back from disk (unknown -> done),
            # and NEVER send cancel (cancelling a confirmed install is wrong).
            reset_state()

            def install_prompt_only(l, c, m):
                return [reply(m), prompt_event(m["args"], "1757178001.5")]

            def confirm_no_reply(l, c, m):
                # Decky got the confirm and installs (folder appears), but its
                # reply never comes back to us — our confirm call times out.
                threading.Timer(0.8, lambda: plugin(env.plugins, "AnimationChanger",
                                                    "Animation Changer", AC_VERSION)).start()
                return []

            def get_plugins(l, c, m):
                return [get_plugins_reply(m, [("Animation Changer", AC_VERSION, False)])]
            fl = FakeLoader({"utilities/install_plugin": install_prompt_only,
                             "utilities/confirm_plugin_install": confirm_no_reply,
                             "loader/get_plugins": get_plugins})
            with Patch(_DECKY_WS_PORT=fl.port,
                       _DECKY_TOKEN_URL="http://127.0.0.1:%d/auth/token" % fl.port):
                cs.decky_plugin_install({"id": 23})
                rec = wait_job(20)
                check("KI-074: confirm sent + reply lost + folder appears -> done via read-back",
                      (rec["done"], rec["outcome"]), (True, "done"))
                check("KI-074: NOT reported as retry",
                      rec.get("retry", False), False)
                check("KI-074: NO cancel_plugin_install after the confirm was sent",
                      calls(fl, "utilities/cancel_plugin_install"), [])
                check("...slot freed", cs._decky_busy(), None)
            fl.stop()
            # (c) extracted but not loaded
            reset_state()
            fl = FakeLoader(_install_script(env, listed=False))
            with Patch(_DECKY_WS_PORT=fl.port,
                       _DECKY_TOKEN_URL="http://127.0.0.1:%d/auth/token" % fl.port):
                shutil.rmtree(os.path.join(env.plugins, "AnimationChanger"), ignore_errors=True)
                cs.decky_plugin_install({"id": 23})
                rec = wait_job()
                check("folder on disk but not listed -> failed 'extracted but not loaded'",
                      (rec["outcome"], rec["error"], rec["verified"]),
                      ("failed", "extracted but not loaded", False))
                check("...log carries the journal tail",
                      "journal: fake plugin_loader line" in rec["log"], True)
            fl.stop()
            # (d) update failure after removal: Decky emits download_start,
            # removes the old copy (its _install uninstalls first) and never installs.
            reset_state()

            def confirm_remove(l, c, m):
                shutil.rmtree(os.path.join(env.plugins, "AnimationChanger"), ignore_errors=True)
                return [{"type": 5, "event": "loader/plugin_download_start", "args": ["Animation Changer"]},
                        reply(m)]
            fl = FakeLoader({"utilities/install_plugin": lambda l, c, m: [reply(m), prompt_event(m["args"], "1757178002.0")],
                             "utilities/confirm_plugin_install": confirm_remove})
            with Patch(_DECKY_WS_PORT=fl.port,
                       _DECKY_TOKEN_URL="http://127.0.0.1:%d/auth/token" % fl.port):
                plugin(env.plugins, "AnimationChanger", "Animation Changer", "1.3.0")
                code, body = cs.decky_plugin_install({"id": 23})
                check("kind is update with old_version", (body["job"]["kind"], body["job"]["old_version"]),
                      ("update", "1.3.0"))
                rec = wait_job(20)
                check("failed update whose old copy is gone -> removal message + reinstall_id",
                      (rec["outcome"], rec["reinstall_id"],
                       "Animation Changer 1.3.0 was removed by Decky Loader" in (rec["error"] or ""),
                       "reinstall from the Store" in (rec["error"] or "")),
                      ("failed", 23, True, True))
                check("...old copy really gone (the trigger)", cs._decky_folder_for("Animation Changer"), None)
            fl.stop()
            # control for (d): a failed FRESH install carries no reinstall_id
            reset_state()
            fl = FakeLoader({"utilities/install_plugin": lambda l, c, m: [reply(m), prompt_event(m["args"], "1757178003.0")],
                             "utilities/confirm_plugin_install": lambda l, c, m: [reply(m)]})
            with Patch(_DECKY_WS_PORT=fl.port,
                       _DECKY_TOKEN_URL="http://127.0.0.1:%d/auth/token" % fl.port):
                cs.decky_plugin_install({"id": 23})
                rec = wait_job(20)
                check("fresh install that never appears -> failed, no reinstall_id (control)",
                      (rec["outcome"], rec["reinstall_id"], "appeared" in (rec["error"] or "")),
                      ("failed", None, True))
            fl.stop()
            # (e) socket closed after install_plugin accepted, before the confirm
            reset_state()

            def install_then_close(l, c, m):
                threading.Timer(0.5, lambda: plugin(env.plugins, "AnimationChanger", "Animation Changer",
                                                    AC_VERSION)).start()
                return [reply(m), prompt_event(m["args"], "1757178004.0"), "CLOSE"]
            fl = FakeLoader({"utilities/install_plugin": install_then_close,
                             "loader/get_plugins": lambda l, c, m: [get_plugins_reply(m, [("Animation Changer", AC_VERSION, False)])]})
            with Patch(_DECKY_WS_PORT=fl.port,
                       _DECKY_TOKEN_URL="http://127.0.0.1:%d/auth/token" % fl.port):
                shutil.rmtree(os.path.join(env.plugins, "AnimationChanger"), ignore_errors=True)
                cs.decky_plugin_install({"id": 23})
                seen_unknown = False
                for _ in range(100):
                    rec = cs._DECKY_JOB["rec"]
                    if rec and rec.get("outcome") == "unknown" and not rec.get("done"):
                        seen_unknown = True
                        break
                    if rec and rec.get("done"):
                        break
                    time.sleep(0.05)
                rec = wait_job()
                check("mid-call close -> outcome unknown first, never failed/loader_down",
                      seen_unknown, True)
                check("...then the read-back settles it to done",
                      (rec["outcome"], rec["verified"], rec["loader_down"] if "loader_down" in rec else None),
                      ("done", True, None))
            fl.stop()
            fl = None
    finally:
        cold_store()
        if fl:
            fl.stop()


def test_uninstall_and_reload_jobs():
    """uninstall/reload are JOBS (the app's 4 s request timeout would turn a
    6 s Decky reply into a reported failure otherwise). Uninstall: the fake
    loader closes the socket 1 s after the call and removes the folder 3 s
    later -> done, verified:true — never loader_down (reserved for the token
    failing); the arg handed to Decky is the listing's own key. Folder stays
    -> failed. Reload: done with verified:null on the reply; unknown when the
    loader closes instead of replying."""
    print("test_uninstall_and_reload_jobs")
    fl = None
    try:
        with Env(_DECKY_UNINSTALL_VERIFY_S=6.0) as env:
            def uninstall_close(l, c, m):
                threading.Timer(3.0, lambda: shutil.rmtree(os.path.join(env.plugins, "AC"),
                                                           ignore_errors=True)).start()
                time.sleep(1.0)
                return ["CLOSE"]
            fl = FakeLoader({"utilities/uninstall_plugin": uninstall_close})
            with Patch(_DECKY_WS_PORT=fl.port,
                       _DECKY_TOKEN_URL="http://127.0.0.1:%d/auth/token" % fl.port):
                plugin(env.plugins, "AC", "Animation Changer", AC_VERSION)
                code, body = cs.decky_plugin_op("uninstall", {"name": "Animation Changer"})
                check("uninstall accepted as a job", (code, body["job"]["kind"], body["job"]["version"]),
                      (200, "uninstall", AC_VERSION))
                rec = wait_job()
                check("close after 1 s + folder gone after 3 s -> done verified:true",
                      (rec["outcome"], rec["verified"], rec["error"]), ("done", True, None))
                check("uninstall_plugin arg is the dict key",
                      [c[1] for c in calls(fl, "utilities/uninstall_plugin")], [["Animation Changer"]])
                check("one session only", fl.opens, 1)
            fl.stop()
            reset_state()
            fl = FakeLoader()          # replies to everything, does nothing
            with Patch(_DECKY_WS_PORT=fl.port,
                       _DECKY_TOKEN_URL="http://127.0.0.1:%d/auth/token" % fl.port):
                plugin(env.plugins, "AC", "Animation Changer", AC_VERSION)
                cs.decky_plugin_op("uninstall", {"name": "Animation Changer"})
                rec = wait_job()
                check("uninstall acknowledged but folder stays -> failed",
                      (rec["outcome"], rec["verified"], "still on disk" in rec["error"]),
                      ("failed", False, True))
                reset_state()
                code, body = cs.decky_plugin_op("reload", {"name": "Animation Changer"})
                rec = wait_job()
                check("reload -> done, verified:null", (code, rec["outcome"], rec["verified"]),
                      (200, "done", None))
                check("reload route + arg",
                      [c[1] for c in calls(fl, "loader/reload_plugin")], [["Animation Changer"]])
            fl.stop()
            reset_state()
            fl = FakeLoader({"loader/reload_plugin": lambda l, c, m: ["CLOSE"]})
            with Patch(_DECKY_WS_PORT=fl.port,
                       _DECKY_TOKEN_URL="http://127.0.0.1:%d/auth/token" % fl.port):
                cs.decky_plugin_op("reload", {"name": "Animation Changer"})
                rec = wait_job()
                check("reload closed instead of a reply -> unknown, never failed",
                      (rec["outcome"], rec["verified"]), ("unknown", None))
            fl.stop()
            fl = None
    finally:
        if fl:
            fl.stop()


def test_ws_client_bounds():
    """`_DeckyWS` is the agent's own bounded client because a user-level
    impostor on a free port 1337 could otherwise pin the job thread or OOM the
    agent: (1) a route outside the frozenset raises BEFORE any byte is sent
    (positive control: an allowlisted route reaches the fake); (2) a frame
    header announcing 2^62 bytes is refused in well under a second with the
    socket closed — the payload is never allocated or awaited; (3) a
    byte-drip that never completes a header is cut off by the ONE session
    deadline; (4) a bad Sec-WebSocket-Accept is rejected. (2) and (3) are then
    run as real reload JOBS: the slot must be freed within the budget."""
    print("test_ws_client_bounds")
    fl = None
    try:
        with Env() as env:
            plugin(env.plugins, "AC", "Animation Changer", AC_VERSION)
            fl = FakeLoader({"utilities/ping": lambda l, c, m: [
                {"type": 5, "event": "loader/notify_updates", "args": []}, reply(m, "pong")],
                "loader/get_plugins": lambda l, c, m: [
                    {"type": 1, "id": 12345, "result": "wrong-id"}, reply(m, [1])],
                "loader/reload_plugin": lambda l, c, m: [
                    {"type": -1, "id": m["id"], "error": {"name": "RouteNotFoundError", "message": "nope"}}]})
            with Patch(_DECKY_WS_PORT=fl.port,
                       _DECKY_TOKEN_URL="http://127.0.0.1:%d/auth/token" % fl.port):
                ws = cs._DeckyWS(LOADER_TOKEN, 3.0)
                check("allowlisted route reaches the loader (control)", ws.call("utilities/ping"), "pong")
                check("event collected alongside the reply", ws.events[0]["event"], "loader/notify_updates")
                check("a reply with a foreign id is skipped, ours returned",
                      ws.call("loader/get_plugins"), [1])
                time.sleep(0.2)                 # let the fake log our ack first
                before = len(fl.calls)
                try:
                    ws.call("updater/do_update")
                    check("route outside the frozenset -> RuntimeError", "no raise", "RuntimeError")
                except RuntimeError:
                    check("route outside the frozenset -> RuntimeError", "RuntimeError", "RuntimeError")
                try:
                    ws.call("utilities/settings/set", "developer.enabled", True)
                    check("a real Decky route outside the frozenset -> RuntimeError", "no raise", "RuntimeError")
                except RuntimeError:
                    check("a real Decky route outside the frozenset -> RuntimeError", "RuntimeError", "RuntimeError")
                time.sleep(0.2)
                check("...and nothing was sent for either", len(fl.calls), before)
                try:
                    ws.call("loader/reload_plugin", "x")
                    check("ERROR reply raises _DeckyWSError", "no raise", "raised")
                except cs._DeckyWSError as e:
                    check("ERROR reply raises _DeckyWSError", str(e), "nope")
                ws.close()
                check("frozenset is exactly the eight routes the spec names",
                      sorted(cs._DECKY_WS_ROUTES),
                      sorted(["utilities/ping", "loader/get_plugins", "loader/reload_plugin",
                              "utilities/install_plugin", "utilities/confirm_plugin_install",
                              "utilities/cancel_plugin_install", "utilities/uninstall_plugin",
                              "updater/get_version_info"]))
            fl.stop()
            fl = FakeLoader(mode="hugeframe")
            with Patch(_DECKY_WS_PORT=fl.port,
                       _DECKY_TOKEN_URL="http://127.0.0.1:%d/auth/token" % fl.port):
                ws = cs._DeckyWS(LOADER_TOKEN, 3.0)
                t0 = time.monotonic()
                try:
                    ws.call("utilities/ping")
                    check("2^62-byte frame header refused", "no raise", "IOError")
                except IOError as e:
                    check("2^62-byte frame header refused", "over cap" in str(e), True)
                check("...refused fast, socket closed (payload never awaited)",
                      (time.monotonic() - t0 < 1.0, ws.sock is None), (True, True))
                # As a JOB: the slot is freed, not pinned.
                reset_state()
                t0 = time.monotonic()
                cs.decky_plugin_op("reload", {"name": "Animation Changer"})
                rec = wait_job()
                check("hugeframe loader: reload job slot freed within budget",
                      (rec["done"], rec["outcome"] in ("unknown", "failed"), time.monotonic() - t0 < 4.0,
                       cs._decky_busy()),
                      (True, True, True, None))
            fl.stop()
            fl = FakeLoader(mode="drip")
            with Patch(_DECKY_WS_PORT=fl.port,
                       _DECKY_TOKEN_URL="http://127.0.0.1:%d/auth/token" % fl.port,
                       _DECKY_WS_SESSION_S=1.5):
                ws = cs._DeckyWS(LOADER_TOKEN, 1.5)
                t0 = time.monotonic()
                try:
                    ws.call("utilities/ping")
                    check("byte-drip bounded by the session deadline", "no raise", "timeout")
                except socket.timeout:
                    check("byte-drip bounded by the session deadline",
                          1.2 < time.monotonic() - t0 < 2.5, True)
                ws.close()
                reset_state()
                t0 = time.monotonic()
                cs.decky_plugin_op("reload", {"name": "Animation Changer"})
                rec = wait_job()
                check("drip loader: reload job slot freed within budget",
                      (rec["done"], rec["outcome"], time.monotonic() - t0 < 4.0, cs._decky_busy()),
                      (True, "unknown", True, None))
            fl.stop()
            fl = FakeLoader(mode="badaccept")
            with Patch(_DECKY_WS_PORT=fl.port,
                       _DECKY_TOKEN_URL="http://127.0.0.1:%d/auth/token" % fl.port):
                try:
                    cs._DeckyWS(LOADER_TOKEN, 2.0)
                    check("wrong Sec-WebSocket-Accept rejected", "no raise", "IOError")
                except IOError:
                    check("wrong Sec-WebSocket-Accept rejected", "IOError", "IOError")
            fl.stop()
            fl = None
    finally:
        if fl:
            fl.stop()


def _hold_flock(path):
    """Hold an EXCLUSIVE kernel flock on `path` from ANOTHER process (the way
    the root wrapper does) until the child is killed."""
    child = _REAL_POPEN(
        [sys.executable, "-c",
         "import fcntl,os,sys,time\n"
         "fd=os.open(sys.argv[1], os.O_RDWR|os.O_CREAT, 0o644)\n"
         "fcntl.flock(fd, fcntl.LOCK_EX)\n"
         "print('held', flush=True)\n"
         "time.sleep(60)\n", path],
        stdout=subprocess.PIPE)
    line = child.stdout.readline()
    if line.strip() != b"held":
        child.kill()
        raise RuntimeError("flock holder did not start")
    return child


def test_busy_both_directions():
    """ONE mutex across loader ops and plugin jobs (`_decky_busy()`), asserted
    in both directions with real primitives: (1) the wrapper's flock — held
    EXCLUSIVELY by another process on /run/couchside/decky-loader.lock — makes
    every plugin op 409 {busy, what:'loader_op'} with zero sockets; (2) a
    running plugin job makes `_decky_loader_start` answer busy plugin_job
    with ZERO spawns (no helper verb, no sudo); (3) an in-flight loader check
    counts as plugin_job for both. Control: with the lock released the
    op is accepted."""
    print("test_busy_both_directions")
    fl = None
    holder = None
    try:
        with Env() as env, SpyProc():
            warm_store()
            plugin(env.plugins, "AC", "Animation Changer", "1.3.0")
            slow_install = {"utilities/install_plugin": lambda l, c, m: (time.sleep(2.0), [reply(m)])[1]}
            fl = FakeLoader(slow_install)
            with Patch(_DECKY_WS_PORT=fl.port,
                       _DECKY_TOKEN_URL="http://127.0.0.1:%d/auth/token" % fl.port,
                       _decky_installer_ready=lambda: True):
                lock = os.path.join(env.run, "decky-loader.lock")
                holder = _hold_flock(lock)
                check("held flock reads as a running loader op", cs._decky_op_running(), True)
                check("...the mutex says loader_op", cs._decky_busy(), "loader_op")
                code, body = cs.decky_plugin_install({"id": 23})
                check("plugin install under a held flock -> 409 loader_op",
                      (code, body.get("busy"), body.get("what")), (409, True, "loader_op"))
                check("reload under a held flock -> 409 loader_op",
                      cs.decky_plugin_op("reload", {"name": "Animation Changer"})[1].get("what"), "loader_op")
                check("loader check under a held flock -> 409 loader_op",
                      cs.decky_loader_check()[1].get("what"), "loader_op")
                r = cs._decky_loader_start("install")
                check("loader op under a held flock -> busy loader_op (no double start)",
                      (r.get("started"), r.get("busy"), r.get("what")), (False, True, "loader_op"))
                check("...zero sockets, zero spawns", (fl.opens, fl.token_reqs, SPAWNS), (0, 0, []))
                # Tight-loop probe while the lock is held: the shared probe must
                # never claim the lock for itself.
                check("100 probes in a tight loop all say held",
                      all(cs._decky_op_running() for _ in range(100)), True)
                holder.kill()
                holder.wait()
                holder = None
                check("lock released -> idle (control)", cs._decky_op_running(), False)
                # (2) a job running -> the loader op refuses with zero spawns
                code, body = cs.decky_plugin_install({"id": 23})
                check("install accepted once the lock is free (control)", code, 200)
                r = cs._decky_loader_start("install")
                check("loader op while a plugin job runs -> busy plugin_job",
                      (r.get("started"), r.get("busy"), r.get("what")), (False, True, "plugin_job"))
                check("...zero spawns (no helper verb, no sudo)", SPAWNS, [])
                check("second plugin op while a job runs -> 409 plugin_job",
                      cs.decky_plugin_op("reload", {"name": "Animation Changer"})[1].get("what"),
                      "plugin_job")
                wait_job()
                # (3) an in-flight check holds the one socket
                with cs._DECKY_CHECK_LOCK:
                    cs._DECKY_CHECK["in_flight"] = True
                check("in-flight loader check -> busy plugin_job for a plugin op",
                      cs.decky_plugin_install({"id": 23})[1].get("what"), "plugin_job")
                r = cs._decky_loader_start("install")
                check("in-flight loader check -> loader op busy plugin_job",
                      (r.get("busy"), r.get("what")), (True, "plugin_job"))
                with cs._DECKY_CHECK_LOCK:
                    cs._DECKY_CHECK["in_flight"] = False
                check("...zero spawns throughout", SPAWNS, [])
    finally:
        cold_store()
        if holder:
            holder.kill()
        if fl:
            fl.stop()


def test_persist_and_resume():
    """install.sh restarts the agent routinely mid-job: the record is on disk
    before any socket (asserted above), `GET /api/decky/jobs` reads it back
    when this process has no live copy, a record younger than 180 s resumes
    its read-back (fs + get_plugins) to a real verdict, an older one is
    `interrupted`, a garbled record is null, and `--mock` resumes nothing
    (control)."""
    print("test_persist_and_resume")
    fl = None
    try:
        with Env() as env:
            plugin(env.plugins, "AC", "Animation Changer", AC_VERSION)
            fl = FakeLoader({"loader/get_plugins": lambda l, c, m: [
                get_plugins_reply(m, [("Animation Changer", AC_VERSION, False)])]})
            with Patch(_DECKY_WS_PORT=fl.port,
                       _DECKY_TOKEN_URL="http://127.0.0.1:%d/auth/token" % fl.port):
                rec = cs._decky_new_job("install", "Animation Changer", version=AC_VERSION,
                                        hash_=AC_HASH, store_id=23, install_type="install")
                rec["phase"] = "readback"
                cs._decky_job_write(rec)
                reset_state()
                check("record readable from disk with no live copy",
                      cs.decky_jobs_payload()["job"]["phase"], "readback")
                check("...and it carries no hash", "hash" in cs.decky_jobs_payload()["job"], False)
                cs._decky_jobs_resume(False)
                got = wait_job()
                check("resume < 180 s finishes the read-back to done/verified",
                      (got["outcome"], got["verified"], "resuming read-back" in " ".join(got["log"])),
                      ("done", True, True))
                check("...one get_plugins session", fl.opens, 1)
                rec = cs._decky_new_job("uninstall", "Animation Changer")
                rec["started_at"] = int(time.time()) - 400
                cs._decky_job_write(rec)
                reset_state()
                cs._decky_jobs_resume(False)
                check("resume >= 180 s -> interrupted (memory + disk)",
                      (cs._DECKY_JOB["rec"]["outcome"], cs._decky_job_read()["outcome"],
                       cs._DECKY_JOB["rec"]["done"]),
                      ("interrupted", "interrupted", True))
                reset_state()
                check("jobs payload from disk shows interrupted",
                      cs.decky_jobs_payload()["job"]["outcome"], "interrupted")
                rec = cs._decky_new_job("reload", "Animation Changer")
                cs._decky_job_write(rec)
                reset_state()
                cs._decky_jobs_resume(True)
                check("--mock resumes nothing (control)", cs._DECKY_JOB["rec"], None)
                write(env.job_file, "{garbage")
                reset_state()
                check("garbled record -> job null", cs.decky_jobs_payload()["job"], None)
                write(env.job_file, json.dumps({"kind": "install", "name": 5, "started_at": 1}))
                check("record with a non-str name -> null (shape-validated on read)",
                      cs.decky_jobs_payload()["job"], None)
                write(env.job_file, json.dumps({"kind": "bogus", "name": "x", "started_at": 1}))
                check("record with an unknown kind -> null", cs.decky_jobs_payload()["job"], None)
                write(env.job_file, json.dumps({"kind": "install", "name": "x", "started_at": True}))
                check("record with a bool started_at -> null", cs.decky_jobs_payload()["job"], None)
                # A traversal-SHAPED name is a plain printable string to the
                # reader: names are refused by MEMBERSHIP in the fs listing at
                # op time, never by shape, and the record's name is only ever a
                # dict key (never a path) — so this one reads back (control).
                write(env.job_file, json.dumps({"kind": "install", "name": "../x", "started_at": 1}))
                check("traversal-shaped name reads back as a string (membership gates it, control)",
                      cs.decky_jobs_payload()["job"]["name"], "../x")
    finally:
        if fl:
            fl.stop()


def test_listing_fs():
    """The listing is filesystem-only (§8) with resolved-vs-resolved
    containment (§3): a symlinked ~/homebrew (SD card) and a Bazzite-style
    /home -> /var/home symlink both list EXACTLY what the plain tree lists
    (control), a folder that is a symlink OUT of the tree is dropped, a
    plugin.json one byte over 64 KiB is `unreadable` (counted, omitted) while
    one of exactly 64 KiB is listed (control), a torn loader.json makes flags
    unknown (null, never 'enabled') and `update` null, and `running` stays
    null with running_probe:'unknown' — the /proc cmdline probe is a Phase B
    precondition (`test_running_from_proc_fixture`, VERBATIM fixtures) that
    does not exist yet, so even a python process whose argv names main.py
    changes nothing."""
    print("test_listing_fs")
    tmp = tempfile.mkdtemp(prefix="decky-listing-")
    try:
        real = os.path.join(tmp, "var", "home", "deck", "homebrew", "plugins")
        plugin(real, "AnimationChanger", "Animation Changer", AC_VERSION)
        plugin(real, "SteamGridDB", "SteamGridDB", "1.7.0", flags=["root"])
        plugin(real, "Couchside", "Couchside", "0.2.9", flags=["root"])
        plugin(real, "NoPkg", "Passive", pkg=False)
        os.makedirs(os.path.join(real, "junk"))                        # no plugin.json
        big = {"name": "Big", "author": "a", "flags": [], "pad": ""}
        body = json.dumps(big)
        body = body.replace('"pad": ""', '"pad": "%s"' % ("x" * (64 * 1024 + 1 - len(body))))
        assert len(body) == 64 * 1024 + 1
        write(os.path.join(real, "Big", "plugin.json"), body)          # one byte over the cap
        exact = {"name": "Exact", "author": "a", "flags": [], "pad": ""}
        body = json.dumps(exact)
        body = body.replace('"pad": ""', '"pad": "%s"' % ("y" * (64 * 1024 - len(body))))
        assert len(body) == 64 * 1024
        write(os.path.join(real, "Exact", "plugin.json"), body)        # exactly the cap: listed
        write(os.path.join(real, "Torn", "plugin.json"), '{"name": "To')
        outside = os.path.join(tmp, "outside")
        plugin(outside, "Evil", "Evil", "9.9.9")
        os.symlink(os.path.join(outside, "Evil"), os.path.join(real, "EvilLink"))
        os.symlink(os.path.join(tmp, "var", "home"), os.path.join(tmp, "home"))   # /home -> /var/home
        sd = os.path.join(tmp, "run", "media", "sdcard", "homebrew")
        os.makedirs(os.path.dirname(sd))
        os.symlink(os.path.join(tmp, "var", "home", "deck", "homebrew"), sd)     # ~/homebrew -> SD card
        want = ["Animation Changer", "Couchside", "Exact", "Passive", "SteamGridDB"]
        with Patch(_DECKY_PLUGINS_DIR=real):
            d, unread = cs._decky_scan_plugins()
        check("plain tree lists the five readable plugins", sorted(d), want)
        check("over-cap + torn plugin.json counted as unreadable", unread, 2)
        check("exactly-64 KiB plugin.json listed (control)", d["Exact"]["folder"], "Exact")
        check("escaping symlink dropped", "Evil" in d, False)
        check("root flag from plugin.json flags", (d["SteamGridDB"]["root"], d["Animation Changer"]["root"]),
              (True, False))
        check("Couchside marked protected", d["Couchside"]["protected"], True)
        check("no package.json -> version null", d["Passive"]["version"], None)
        via_home = os.path.join(tmp, "home", "deck", "homebrew", "plugins")
        with Patch(_DECKY_PLUGINS_DIR=via_home):
            d2, u2 = cs._decky_scan_plugins()
        check("/var/home-style home symlink lists the same set (control)", (sorted(d2), u2),
              (want, 2))
        with Patch(_DECKY_PLUGINS_DIR=os.path.join(sd, "plugins")):
            d3, u3 = cs._decky_scan_plugins()
        check("symlinked ~/homebrew (SD card) lists the same set (control)", (sorted(d3), u3),
              (want, 2))
        check("folder names come from listdir, names from plugin.json",
              (d3["Animation Changer"]["folder"], d3["Passive"]["folder"]), ("AnimationChanger", "NoPkg"))
        with Patch(_DECKY_PLUGINS_DIR=os.path.join(tmp, "absent")):
            check("absent plugins dir -> empty, no raise", cs._decky_scan_plugins(), ({}, 0))
        # loader.json torn -> flags unknown, update null; good -> flags + order
        settings = os.path.join(tmp, "var", "home", "deck", "homebrew", "settings", "loader.json")
        write(settings, '{"pluginOrder": ["SteamGridDB", "Animation Cha')
        warm_store()
        try:
            with Patch(_DECKY_PLUGINS_DIR=real, _DECKY_SETTINGS=settings,
                       _decky_loader_installed=lambda: True, decky_jobs_payload=lambda: {"job": None}):
                p = cs.decky_plugins_payload()
            by = {r["name"]: r for r in p["plugins"]}
            check("torn loader.json -> flags_available false", p["flags_available"], False)
            check("...disabled/hidden/frozen null, never false",
                  (by["SteamGridDB"]["disabled"], by["SteamGridDB"]["hidden"], by["SteamGridDB"]["frozen"]),
                  (None, None, None))
            check("...update null even though the store has 1.7.1 > 1.7.0",
                  (by["SteamGridDB"]["update"], p["updates"]), (None, None))
            check("...unreadable count surfaced", p["unreadable"], 2)
            write(settings, json.dumps({"pluginOrder": ["SteamGridDB", "Animation Changer"],
                                        "disabled_plugins": ["Passive"], "hiddenPlugins": ["Couchside"],
                                        "frozenPlugins": [], "branch": 0}))
            with Patch(_DECKY_PLUGINS_DIR=real, _DECKY_SETTINGS=settings,
                       _decky_loader_installed=lambda: True, decky_jobs_payload=lambda: {"job": None}):
                p = cs.decky_plugins_payload()
            by = {r["name"]: r for r in p["plugins"]}
            check("good loader.json -> update for SteamGridDB 1.7.0 -> 1.7.1 (control)",
                  by["SteamGridDB"]["update"],
                  {"version": "1.7.1", "hash": "6d6eca184677dc9ff7736439ee7a575ca8ab386c5ffb1627d446bc43dbd1ecf3"})
            check("...updates count 1", p["updates"], 1)
            check("...sorted by pluginOrder then name",
                  [r["name"] for r in p["plugins"]],
                  ["SteamGridDB", "Animation Changer", "Couchside", "Exact", "Passive"])
            check("...disabled/hidden from the lists",
                  (by["Passive"]["disabled"], by["Couchside"]["hidden"]), (True, True))
            # running: null until the VERBATIM /proc fixture test exists.
            proc = os.path.join(tmp, "proc")
            write(os.path.join(proc, "4242", "cmdline"),
                  "/usr/bin/python3\x00" + os.path.join(real, "SteamGridDB", "main.py") + "\x00")
            with Patch(_DECKY_PLUGINS_DIR=real, _DECKY_SETTINGS=settings, _DECKY_PROC=proc,
                       _decky_loader_installed=lambda: True, decky_jobs_payload=lambda: {"job": None}):
                p = cs.decky_plugins_payload()
            check("running stays null for every row even with a main.py process in /proc",
                  [r["running"] for r in p["plugins"]], [None] * 5)
            check("running_probe reads 'unknown'", p["running_probe"], "unknown")
            check("the precondition test does not exist yet (running must stay null until it does)",
                  "test_running_from_proc_fixture" in globals(), False)
            with Patch(_decky_loader_installed=lambda: False, decky_jobs_payload=lambda: {"job": None}):
                p = cs.decky_plugins_payload()
            check("loader not installed -> available:false, 200 shape intact",
                  (p["available"], p["plugins"], p["updates"], p["running_probe"]),
                  (False, [], None, "unknown"))
        finally:
            cold_store()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    for fn in (test_http_auth_every_route,
               test_listener_uid_fixture,
               test_refusals_open_no_socket,
               test_install_job_happy_path,
               test_install_job_failures,
               test_uninstall_and_reload_jobs,
               test_ws_client_bounds,
               test_busy_both_directions,
               test_persist_and_resume,
               test_listing_fs):
        fn()
    if FAILURES:
        print("\n%d FAILED: %s" % (len(FAILURES), ", ".join(FAILURES)))
        sys.exit(1)
    print("\nall decky-plugins tests passed")
