#!/usr/bin/env python3
"""Tests for the actions routes (GET/POST /api/actions/<id>) and its allowlist.

Run: python3 tests/test_actions_endpoint.py

Covers what CLAUDE.md §6 requires of an endpoint that takes a client id, which
this route had NO test for until now (the injection GATES are tested in
test_actions_inject.py, but the route dispatch itself was not):
  * happy path — a listed id returns the ActionResult shape,
  * auth failure — no bearer is 401 on both GET and POST,
  * a NON-allowlisted id is refused AND nothing runs.

That last one is asserted, not inferred: `mock_action` is spied, so "the request
was 404'd" and "no action was dispatched" are two separate observations. A test
that only checked the status code would pass against an agent that 404s the
caller while still running the command.

Driven in --mock so no real reboot/session binary is touched; the allowlist
membership check (`action_id not in ACTIONS`) is identical in mock and real mode.
Pure stdlib, no pytest.
"""
import http.client
import importlib.util
import json
import os
import sys
import threading
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT = os.path.join(HERE, "..", "agent", "couchsided.py")
spec = importlib.util.spec_from_file_location("couchsided", AGENT)
cs = importlib.util.module_from_spec(spec)
sys.modules["couchsided"] = cs
spec.loader.exec_module(cs)

PASS = "  \033[32mPASS\033[0m"
FAIL = "  \033[31mFAIL\033[0m"
_fail = []
TOKEN = "test-secret-token"


def check(cond, label, detail=""):
    print((PASS if cond else FAIL) + "  " + label + ("" if cond else "  <- %s" % (detail,)))
    if not cond:
        _fail.append(label)


def _server():
    cs.Handler.token = TOKEN
    cs.Handler.token_file = None
    cs.Handler.mock = True
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


class SpyAction:
    """Records every action id actually dispatched, so 'nothing ran' is an
    observation and not an inference."""

    def __init__(self):
        self.ids = []
        self._orig = cs.mock_action

    def __enter__(self):
        def spy(action_id):
            self.ids.append(action_id)
            return self._orig(action_id)
        cs.mock_action = spy
        return self

    def __exit__(self, *exc):
        cs.mock_action = self._orig


def test_get_requires_bearer():
    print("GET /api/actions requires the bearer token")
    srv, port = _server()
    try:
        status, _ = _req(port, "GET", "/api/actions", token=None)
        check(status == 401, "no token -> 401", status)
    finally:
        srv.shutdown()


def test_get_lists_actions():
    print("GET /api/actions lists the allowlisted actions")
    srv, port = _server()
    try:
        status, body = _req(port, "GET", "/api/actions")
        acts = body.get("actions")
        check(status == 200, "authorised GET -> 200", status)
        check(isinstance(acts, list) and len(acts) > 0, "returns a non-empty actions list")
        first = acts[0] if acts else {}
        check({"id", "label", "danger"} <= set(first), "each action has id/label/danger",
              sorted(first))
    finally:
        srv.shutdown()


def test_known_id_runs_and_shape():
    print("POST a listed id runs and returns the ActionResult shape")
    srv, port = _server()
    try:
        _, body = _req(port, "GET", "/api/actions")
        aid = body["actions"][0]["id"]
        with SpyAction() as spy:
            status, result = _req(port, "POST", "/api/actions/" + aid, body="{}")
        check(status == 200, "listed id -> 200", status)
        check({"ok", "exit_code", "stdout", "stderr", "duration_ms"} <= set(result),
              "result carries the ActionResult keys", sorted(result))
        check(spy.ids == [aid], "the dispatched action was exactly the one requested", spy.ids)
    finally:
        srv.shutdown()


def test_unknown_id_refused_and_nothing_runs():
    print("POST a non-allowlisted id is refused AND nothing runs")
    srv, port = _server()
    try:
        with SpyAction() as spy:
            status, body = _req(port, "POST", "/api/actions/not-a-real-action", body="{}")
        check(status == 404, "unknown id -> 404", status)
        check(body.get("error") == "unknown action", "error names the refusal", body)
        check(spy.ids == [], "NOTHING was dispatched for the unknown id", spy.ids)
    finally:
        srv.shutdown()


def test_post_requires_bearer():
    print("POST /api/actions/<id> requires the bearer token")
    srv, port = _server()
    try:
        with SpyAction() as spy:
            status, _ = _req(port, "POST", "/api/actions/reboot", body="{}", token=None)
        check(status == 401, "no token -> 401", status)
        check(spy.ids == [], "an unauthorised POST dispatched nothing", spy.ids)
    finally:
        srv.shutdown()


if __name__ == "__main__":
    for fn in (test_get_requires_bearer,
               test_get_lists_actions,
               test_known_id_runs_and_shape,
               test_unknown_id_refused_and_nothing_runs,
               test_post_requires_bearer):
        fn()
    if _fail:
        print("\n%d FAILED: %s" % (len(_fail), ", ".join(_fail)))
        sys.exit(1)
    print("\nall good")
