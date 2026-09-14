#!/usr/bin/env python3
"""Tests for the clipboard READ route (GET /api/clipboard) and the `wlclipboard`
cap.

Run: python3 tests/test_clipboard_read.py

Covers what CLAUDE.md §6 requires of a new authed endpoint: happy path, auth
failure, and unknown-input rejection. This route takes NO client id or query
param — the argv is a fixed ["wl-paste","-n"] — so "unknown-input rejection" here
means proving there is no injection surface: a stray query string is ignored
(still 200) and a trailing path segment is not a route (404), so nothing a client
sends can steer the read.

Both states of the availability probe are observed (CLAUDE.md §11.2): the reader
is exercised with wlclipboard_available() stubbed True AND False, and with the
underlying wl-paste stubbed to succeed, to be empty, and to fail.

The cap check covers five of the SIX edit sites (agent CAPS dict + mock tuple;
app BoxCaps + normalizeCaps + capsEqual). The sixth (protocol/protocol.json) is
enforced by tests/test_protocol_parity.py; `wlclipboard` is in
linuxOnlyCapabilities.keys, so that gate is live for this cap.

Pure stdlib, no pytest.
"""
import http.client
import importlib.util
import json
import os
import re
import subprocess
import tempfile
import threading
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
AGENT = os.path.join(ROOT, "agent", "couchsided.py")
API_TS = os.path.join(ROOT, "app", "lib", "api.ts")
SETTINGS_TS = os.path.join(ROOT, "app", "lib", "settings.ts")

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


class FakeProc:
    def __init__(self, rc, out):
        self.returncode = rc
        self.stdout = out


def _server(mock):
    cs.Handler.token = TOKEN
    cs.Handler.token_file = None
    cs.Handler.mock = mock
    cs.Handler.port = 0
    srv = ThreadingHTTPServer(("127.0.0.1", 0), cs.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


def _req(port, method, path, token=TOKEN):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    headers = {"Authorization": "Bearer " + token} if token is not None else {}
    conn.request(method, path, headers=headers)
    resp = conn.getresponse()
    data = resp.read()
    conn.close()
    try:
        return resp.status, json.loads(data or b"{}")
    except ValueError:
        return resp.status, {}


# ---------------------------------------------------------------------------
print("\nclipboard_read() state builder — both probe states")
# ---------------------------------------------------------------------------
mock_payload = cs.clipboard_read(True)
check(mock_payload.get("available") is True, "mock -> available", mock_payload)
check(isinstance(mock_payload.get("text"), str), "mock -> text is a string", mock_payload)

_orig_avail = cs.wlclipboard_available
_orig_run = cs.subprocess.run
try:
    # Real branch, probe says unavailable -> available:false, never a stale read.
    cs.wlclipboard_available = lambda: False
    unavail = cs.clipboard_read(False)
    check(unavail == {"available": False, "text": None},
          "probe false -> {available:false, text:None}", unavail)

    # Probe true + a successful wl-paste read.
    cs.wlclipboard_available = lambda: True
    cs.subprocess.run = lambda *a, **k: FakeProc(0, b"https://couchside.tv\n")
    ok = cs.clipboard_read(False)
    check(ok == {"available": True, "text": "https://couchside.tv\n"},
          "probe true + rc0 -> the clipboard text", ok)

    # Empty clipboard: wl-paste exits non-zero -> available with empty text, so
    # the app can say "empty" rather than "unavailable".
    cs.subprocess.run = lambda *a, **k: FakeProc(1, b"")
    empty = cs.clipboard_read(False)
    check(empty == {"available": True, "text": ""},
          "empty clipboard (rc1) -> available with text ''", empty)

    # wl-paste blows up -> degrade closed, available:false.
    def _boom(*a, **k):
        raise OSError("no wl-paste here")
    cs.subprocess.run = _boom
    dead = cs.clipboard_read(False)
    check(dead == {"available": False, "text": None},
          "wl-paste raises -> {available:false, text:None}", dead)

    # A runaway selection is capped, not returned whole.
    big = b"x" * (cs._CLIPBOARD_READ_MAX + 5000)
    cs.subprocess.run = lambda *a, **k: FakeProc(0, big)
    capped = cs.clipboard_read(False)
    check(len(capped["text"]) == cs._CLIPBOARD_READ_MAX,
          "oversize clipboard truncated to the cap", len(capped["text"]))
finally:
    cs.wlclipboard_available = _orig_avail
    cs.subprocess.run = _orig_run


# ---------------------------------------------------------------------------
print("\nGET /api/clipboard — auth + shape (mock server)")
# ---------------------------------------------------------------------------
srv, port = _server(mock=True)
try:
    status, _ = _req(port, "GET", "/api/clipboard", token=None)
    check(status == 401, "no bearer -> 401")
    status, _ = _req(port, "GET", "/api/clipboard", token="wrong")
    check(status == 401, "wrong bearer -> 401")

    status, info = _req(port, "GET", "/api/clipboard")
    check(status == 200, "authed -> 200", status)
    check(info.get("available") is True, "reports available (mock)", info)
    check("text" in info and isinstance(info["text"], str),
          "carries `text`", info)

    # No injection surface: a stray query string is ignored, still 200.
    status, info2 = _req(port, "GET", "/api/clipboard?x=../../etc/passwd")
    check(status == 200 and info2.get("available") is True,
          "stray query string ignored, still 200", (status, info2))

    # A trailing path segment is a DIFFERENT (nonexistent) route -> 404, never a
    # pass-through: the id-less read cannot be steered by the path either.
    status, _ = _req(port, "GET", "/api/clipboard/evil")
    check(status == 404, "trailing path segment -> 404 (not a route)", status)
finally:
    srv.shutdown()

# Real (non-mock) server with the probe stubbed off -> 200 available:false, the
# other observed state (agent present but no wl-paste here).
_orig_avail = cs.wlclipboard_available
try:
    cs.wlclipboard_available = lambda: False
    srv, port = _server(mock=False)
    try:
        status, info = _req(port, "GET", "/api/clipboard")
        check(status == 200 and info.get("available") is False,
              "no wl-paste -> 200 available:false (not 404)", (status, info))
    finally:
        srv.shutdown()
finally:
    cs.wlclipboard_available = _orig_avail


# ---------------------------------------------------------------------------
print("\nwlclipboard cap — five of six edit sites")
# ---------------------------------------------------------------------------
cs.set_caps(True)
check("wlclipboard" in cs.CAPS, "agent mock CAPS registers wlclipboard", sorted(cs.CAPS))
cs.set_caps(False)
check("wlclipboard" in cs.CAPS, "agent real CAPS registers wlclipboard", sorted(cs.CAPS))

api_src = open(API_TS).read()
settings_src = open(SETTINGS_TS).read()
check(re.search(r"\bwlclipboard\?\s*:\s*boolean", api_src) is not None,
      "app BoxCaps declares wlclipboard")
check("const wlclipboard = bool('wlclipboard')" in settings_src,
      "app normalizeCaps reads wlclipboard")
check(re.search(r"wlclipboard[,\s]", settings_src.split("return {", 1)[1][:400]) is not None,
      "app normalizeCaps returns wlclipboard")
check("a.wlclipboard === b.wlclipboard" in api_src,
      "app capsEqual compares wlclipboard")


if __name__ == "__main__":
    if _fail:
        print("\n%d FAILED: %s" % (len(_fail), ", ".join(_fail)))
        raise SystemExit(1)
    print("\nall good")
