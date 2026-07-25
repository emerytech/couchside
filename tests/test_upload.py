#!/usr/bin/env python3
"""Tests for POST /api/upload — the phone->box file drop.

Run: python3 tests/test_upload.py

This route is HTTP-deep (streams the request body straight to disk, before the
generic in-memory body cap), so it is exercised against a REAL loopback server
rather than by poking a function — a fake self.rfile would prove nothing about
the actual streaming/containment path.

Covers the §6 checklist for a new endpoint:
  - happy path  (authed, valid name -> file lands with exact bytes)
  - auth failure (no/wrong bearer -> 401, nothing written)
  - unknown-input rejection (traversal / subdir / empty name -> 400, contained)
plus the capability wiring on the agent side (file_upload in mock + real CAPS).

Pure stdlib, no pytest — same style as the other agent tests.
"""
import http.client
import importlib.util
import os
import tempfile
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


def check(cond, label):
    print((PASS if cond else FAIL) + "  " + label)
    if not cond:
        _fail.append(label)


def _server():
    """Start Handler on a random loopback port with an isolated drop dir."""
    tmp = tempfile.mkdtemp(prefix="couchdrop_")
    drop = os.path.join(tmp, "drop")
    os.environ["COUCHSIDE_DROP_DIR"] = drop
    cs.Handler.token = TOKEN
    cs.Handler.token_file = None
    cs.Handler.mock = False
    cs.Handler.port = 0
    srv = ThreadingHTTPServer(("127.0.0.1", 0), cs.Handler)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, port, drop, tmp


def _post(port, path, body=b"", token=TOKEN):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    headers = {"Authorization": "Bearer " + token} if token is not None else {}
    conn.request("POST", path, body=body, headers=headers)
    resp = conn.getresponse()
    data = resp.read()
    conn.close()
    return resp.status, data


def test_happy_path():
    print("upload: authed valid name -> file lands with exact bytes")
    srv, port, drop, _ = _server()
    try:
        payload = b"couchside forever unlock rules" * 100
        status, _ = _post(port, "/api/upload?name=save.bin", payload)
        check(status == 200, "200 OK")
        dest = os.path.join(drop, "save.bin")
        check(os.path.exists(dest), "file written into drop dir")
        check(os.path.exists(dest) and open(dest, "rb").read() == payload,
              "bytes match exactly")
        check(not os.path.exists(dest + ".part"), "temp .part cleaned up")
    finally:
        srv.shutdown()


def test_auth_failure():
    print("upload: unauthenticated / wrong token -> 401, nothing written")
    srv, port, drop, _ = _server()
    try:
        status, _ = _post(port, "/api/upload?name=x.bin", b"data", token=None)
        check(status == 401, "no bearer -> 401")
        status, _ = _post(port, "/api/upload?name=x.bin", b"data", token="wrong")
        check(status == 401, "wrong bearer -> 401")
        check(not os.path.exists(os.path.join(drop, "x.bin")),
              "nothing written for unauthenticated upload")
    finally:
        srv.shutdown()


def test_reject_bad_names():
    print("upload: traversal / subdir / empty name rejected + contained")
    srv, port, drop, tmp = _server()
    try:
        # parent-dir traversal (encoded slash decodes to '../evil')
        status, _ = _post(port, "/api/upload?name=..%2Fevil.bin", b"pwned")
        check(status == 400, "'../evil' -> 400")
        check(not os.path.exists(os.path.join(tmp, "evil.bin")),
              "nothing escaped the drop root")
        # nested subdir
        status, _ = _post(port, "/api/upload?name=sub%2Ff.bin", b"x")
        check(status == 400, "'sub/f.bin' -> 400")
        # bare traversal token
        status, _ = _post(port, "/api/upload?name=..", b"x")
        check(status == 400, "'..' -> 400")
        # missing name
        status, _ = _post(port, "/api/upload", b"x")
        check(status == 400, "missing name -> 400")
        # the drop dir holds nothing but (maybe) the dir itself
        leaked = [f for f in os.listdir(drop)] if os.path.isdir(drop) else []
        check(leaked == [], "drop dir empty after all rejects")
    finally:
        srv.shutdown()


def test_capability_wired():
    print("capability: file_upload present in mock + real CAPS")
    cs.set_caps(mock=True)
    check(cs.CAPS.get("file_upload") is True, "mock caps expose file_upload")
    cs.set_caps(mock=False)
    check("file_upload" in cs.CAPS, "real caps compute file_upload")


if __name__ == "__main__":
    test_happy_path()
    test_auth_failure()
    test_reject_bad_names()
    test_capability_wired()
    if _fail:
        print("\n%d check(s) failed" % len(_fail))
        raise SystemExit(1)
    print("\nall upload checks passed")
