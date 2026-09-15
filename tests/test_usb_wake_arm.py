#!/usr/bin/env python3
"""Tests for the USB-wake ARM endpoint (POST /api/usb-wake/arm, cap `usbwake`).

Run: python3 tests/test_usb_wake_arm.py

This is the agent side of the product's first client-id -> root-owned-sysfs-path
write. The safety property: the client id is accepted ONLY if it is a member of
the box's own enumeration, and the actual write goes through the privileged
helper's usb.wake-arm verb (tested separately in test_privileged_helper.py). Here
we prove: auth is required; an unknown id is a 404 with the helper NEVER called
(asserted on a spy); a known id reaches the helper with the exact {id,on}; and
five of the six cap edit sites are wired (the sixth, protocol.json, is in the
parity test). The read-only enumeration is covered by test_usb_wake.py.

Pure stdlib, no pytest.
"""
import http.client
import importlib.util
import json
import os
import re
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
    print((PASS if cond else FAIL) + "  " + label + ("" if cond else "  <- %s" % (detail,)))
    if not cond:
        _fail.append(label)


def _server(mock):
    cs.Handler.token = TOKEN
    cs.Handler.token_file = None
    cs.Handler.mock = mock
    cs.Handler.port = 0
    srv = ThreadingHTTPServer(("127.0.0.1", 0), cs.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


def _req(port, method, path, body=None, token=TOKEN):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    headers = {"Authorization": "Bearer " + token} if token is not None else {}
    if body is not None:
        headers["Content-Type"] = "application/json"
    conn.request(method, path, body=body, headers=headers)
    resp = conn.getresponse()
    data = resp.read()
    conn.close()
    try:
        return resp.status, json.loads(data or b"{}")
    except ValueError:
        return resp.status, {}


# ---------------------------------------------------------------------------
print("\nPOST /api/usb-wake/arm — mock server (auth + shape)")
# ---------------------------------------------------------------------------
srv, port = _server(mock=True)
try:
    status, _ = _req(port, "POST", "/api/usb-wake/arm",
                     body=json.dumps({"id": "1-2", "on": True}), token=None)
    check(status == 401, "no bearer -> 401")
    status, r = _req(port, "POST", "/api/usb-wake/arm",
                     body=json.dumps({"id": "1-2", "on": True}))
    check(status == 200 and r.get("ok") is True and r.get("armed") is True,
          "arm known mock device -> 200 ok", (status, r))
    status, r = _req(port, "POST", "/api/usb-wake/arm",
                     body=json.dumps({"id": "usb1", "on": False}))
    check(status == 200 and r.get("ok") is True, "disarm known mock device -> 200", (status, r))
    status, r = _req(port, "POST", "/api/usb-wake/arm",
                     body=json.dumps({"id": "not-a-device", "on": True}))
    check(status == 404, "unknown device -> 404", (status, r))
    status, r = _req(port, "POST", "/api/usb-wake/arm", body=json.dumps({"id": "1-2"}))
    check(status == 400, "missing `on` -> 400", (status, r))
    status, r = _req(port, "POST", "/api/usb-wake/arm",
                     body=json.dumps({"id": 1, "on": True}))
    check(status == 400, "non-string id -> 400", (status, r))
    status, r = _req(port, "POST", "/api/usb-wake/arm", body="{not json")
    check(status == 400, "bad json -> 400", (status, r))
finally:
    srv.shutdown()


# ---------------------------------------------------------------------------
print("\nPOST /api/usb-wake/arm — real server: membership + helper spy")
# ---------------------------------------------------------------------------
_orig_devs = cs.usb_wake_devices
_orig_helper = cs._helper_call
helper_calls = []
try:
    cs.usb_wake_devices = lambda: [{"id": "1-3", "name": "Puck"}, {"id": "usb1", "name": "hub"}]
    cs._helper_call = lambda verb, arg=None, timeout=10: (
        helper_calls.append((verb, arg)) or {"ok": True, "detail": "1-3 wake enabled"})
    srv, port = _server(mock=False)
    try:
        # Unknown id -> 404, helper NEVER called (traversal/injection shapes too).
        for bad in ("nope", "../../etc/passwd", "1-3:1.0", "1-3/../usb1", "", "usb9"):
            helper_calls.clear()
            status, r = _req(port, "POST", "/api/usb-wake/arm",
                             body=json.dumps({"id": bad, "on": True}))
            check(status == 404 and not helper_calls,
                  "unknown id %r -> 404, helper not called" % (bad,), (status, helper_calls))
        # Known id -> helper called with the EXACT {id,on}, nothing interpolated.
        helper_calls.clear()
        status, r = _req(port, "POST", "/api/usb-wake/arm",
                         body=json.dumps({"id": "1-3", "on": True}))
        check(status == 200 and r.get("ok") is True, "known id -> 200 ok", (status, r))
        check(helper_calls == [("usb.wake-arm", {"id": "1-3", "on": True})],
              "helper called with exact verb + {id,on}", helper_calls)
    finally:
        srv.shutdown()

    # No helper present -> 503, nothing armed.
    cs._helper_call = lambda *a, **k: None
    srv, port = _server(mock=False)
    try:
        status, r = _req(port, "POST", "/api/usb-wake/arm",
                         body=json.dumps({"id": "1-3", "on": True}))
        check(status == 503, "no helper -> 503", (status, r))
    finally:
        srv.shutdown()
finally:
    cs.usb_wake_devices = _orig_devs
    cs._helper_call = _orig_helper


# ---------------------------------------------------------------------------
print("\nusbwake cap — five of six edit sites")
# ---------------------------------------------------------------------------
cs.set_caps(True)
check("usbwake" in cs.CAPS, "agent mock CAPS registers usbwake")
cs.set_caps(False)
check("usbwake" in cs.CAPS, "agent real CAPS registers usbwake")
api_src = open(API_TS).read()
settings_src = open(SETTINGS_TS).read()
check(re.search(r"\busbwake\?\s*:\s*boolean", api_src) is not None, "app BoxCaps declares usbwake")
check("const usbwake = bool('usbwake')" in settings_src, "app normalizeCaps reads usbwake")
check(re.search(r"usbwake[,\s]", settings_src.split("return {", 1)[1][:520]) is not None,
      "app normalizeCaps returns usbwake")
check("a.usbwake === b.usbwake" in api_src, "app capsEqual compares usbwake")


if __name__ == "__main__":
    if _fail:
        print("\n%d FAILED: %s" % (len(_fail), ", ".join(_fail)))
        raise SystemExit(1)
    print("\nall good")
