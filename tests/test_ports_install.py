#!/usr/bin/env python3
"""Couchside-Ports install path safety (agent side).

Run: python3 tests/test_ports_install.py

WHAT THIS GUARDS (CLAUDE.md §3, §6):

  1. Every /api/ports route needs the bearer token.
  2. A non-allowlisted port id is a 404 and NOTHING runs — proven by patching
     subprocess to explode if touched (the control: it never is).
  3. The install is OFF until the on-box opt-in marker exists (403 needs_optin),
     and the gate is checked before any process is spawned.
  4. When it does run, the argv is a LIST with no shell and no client string:
     a bounded https fetch of the FROZEN bootstrap URL to a tmp file, then
     `bash <that file>`. The executed URL is exactly the recipe's.
  5. One job at a time — a second launch while one runs is refused (409).
"""
import http.client
import importlib.util
import json
import os
import sys
import tempfile
import threading
from http.server import ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location(
    "couchsided", os.path.join(ROOT, "agent", "couchsided.py"))
cs = importlib.util.module_from_spec(_spec)
sys.modules["couchsided"] = cs
_spec.loader.exec_module(cs)

FAILURES = []
TOKEN = "test-secret-token"
BB = "couchside-bbport"
BB_INSTALL_URL = "https://github.com/emerytech/Bloodborne-Android/releases/download/couchside-bbport/bootstrap.sh"


def check(name, got, want):
    if got == want:
        print("  PASS  %s" % name)
    else:
        print("  FAIL  %s (got %r, want %r)" % (name, got, want))
        FAILURES.append(name)


class Patch:
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


def _reset_job():
    cs._PORTS_JOB.update({
        "proc": None, "id": None, "mode": None, "started": 0.0, "finished": 0.0,
        "exit_code": None, "requires_user_files": False, "user_files_prompt": None,
    })


# ---- fakes -----------------------------------------------------------------

class _ExplodingSubprocess:
    """Any use is a test failure: proves a rejected request runs NOTHING."""
    DEVNULL = -3
    STDOUT = -2

    class TimeoutExpired(Exception):
        pass

    def run(self, *a, **k):
        raise AssertionError("subprocess.run called on a path that must run nothing")

    def Popen(self, *a, **k):
        raise AssertionError("subprocess.Popen called on a path that must run nothing")


class _FakeProc:
    def __init__(self):
        self.returncode = None

    def poll(self):
        return None  # still "running"

    def wait(self, timeout=None):
        raise _FakeSubprocess.TimeoutExpired()


class _FakeSubprocess:
    DEVNULL = -3
    STDOUT = -2

    class TimeoutExpired(Exception):
        pass

    def __init__(self, run_rc=0):
        self.run_calls = []
        self.popen_calls = []
        self.run_rc = run_rc

    def run(self, argv, **kw):
        self.run_calls.append(argv)

        class _R:
            pass
        r = _R()
        r.returncode = self.run_rc
        return r

    def Popen(self, argv, **kw):
        self.popen_calls.append(argv)
        return _FakeProc()


# ---- HTTP harness ----------------------------------------------------------

def _server(mock=True):
    cs.Handler.token = TOKEN
    cs.Handler.token_file = None
    cs.Handler.mock = mock
    cs.Handler.port = 0
    srv = ThreadingHTTPServer(("127.0.0.1", 0), cs.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


def _req(port, method, path, token=TOKEN, body=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    headers = {"Authorization": "Bearer " + token} if token is not None else {}
    data = None
    if body is not None:
        data = body if isinstance(body, (bytes, str)) else json.dumps(body)
        headers["Content-Type"] = "application/json"
    conn.request(method, path, body=data, headers=headers)
    resp = conn.getresponse()
    out = resp.read()
    conn.close()
    try:
        return resp.status, json.loads(out or b"{}")
    except ValueError:
        return resp.status, {}


# ---------------------------------------------------------------------------
print("\nHTTP: auth + catalogue + rejection")
# ---------------------------------------------------------------------------

def test_http_auth_and_catalog():
    print("test_http_auth_and_catalog")
    srv, port = _server(mock=True)
    try:
        check("GET no bearer -> 401", _req(port, "GET", "/api/ports", token=None)[0], 401)
        check("GET wrong bearer -> 401", _req(port, "GET", "/api/ports", token="nope")[0], 401)
        st, body = _req(port, "GET", "/api/ports")
        check("GET -> 200", st, 200)
        ids = [p["id"] for p in body.get("ports", [])]
        check("lists bbport", BB in ids, True)
        check("mock allowed True", body.get("allowed"), True)
        check("mock install None", body.get("install"), None)
    finally:
        srv.shutdown()


def test_http_install_auth_and_unknown_id():
    print("test_http_install_auth_and_unknown_id")
    srv, port = _server(mock=True)
    try:
        check("POST install no bearer -> 401",
              _req(port, "POST", "/api/ports/install", token=None, body={"id": BB})[0], 401)
        check("unknown id -> 404",
              _req(port, "POST", "/api/ports/install", body={"id": "no-such-port"})[0], 404)
        check("missing id -> 404",
              _req(port, "POST", "/api/ports/install", body={})[0], 404)
        check("non-object body -> 400",
              _req(port, "POST", "/api/ports/install", body="not json")[0], 400)
    finally:
        srv.shutdown()


def test_http_install_mock_started_runs_nothing():
    """Mock path returns a started job with the byo-dump prompt and spawns no
    process (subprocess would explode if touched)."""
    print("test_http_install_mock_started_runs_nothing")
    with Patch(subprocess=_ExplodingSubprocess()):
        srv, port = _server(mock=True)
        try:
            st, body = _req(port, "POST", "/api/ports/install", body={"id": BB})
            check("mock install -> 200", st, 200)
            check("started True", body.get("started"), True)
            check("requires_user_files True", body.get("requires_user_files"), True)
            check("carries the dump prompt", bool(body.get("user_files_prompt")), True)
            st2, b2 = _req(port, "POST", "/api/ports/uninstall", body={"id": BB})
            check("mock uninstall -> 200", st2, 200)
            check("uninstall started True", b2.get("started"), True)
        finally:
            srv.shutdown()


# ---------------------------------------------------------------------------
print("\nports_run: opt-in gate, frozen argv, concurrency")
# ---------------------------------------------------------------------------

def test_unknown_id_runs_nothing():
    print("test_unknown_id_runs_nothing")
    _reset_job()
    with Patch(subprocess=_ExplodingSubprocess()):
        payload, code = cs.ports_run("no-such-port", "install")
    check("unknown id -> 404", code, 404)
    check("unknown id not started", payload.get("started"), False)


def test_optin_gate_blocks_before_spawning():
    print("test_optin_gate_blocks_before_spawning")
    _reset_job()
    missing = os.path.join(tempfile.mkdtemp(prefix="ports-nomark-"), "allow-ports")
    with Patch(_PORTS_MARKER=missing, subprocess=_ExplodingSubprocess()):
        payload, code = cs.ports_run(BB, "install")
    check("not opted in -> 403", code, 403)
    check("needs_optin flagged", payload.get("needs_optin"), True)
    check("not started", payload.get("started"), False)


def test_install_builds_frozen_argv_list():
    print("test_install_builds_frozen_argv_list")
    _reset_job()
    d = tempfile.mkdtemp(prefix="ports-mark-")
    marker = os.path.join(d, "allow-ports")
    open(marker, "w").close()
    logf = os.path.join(d, "ports-install.log")
    fake = _FakeSubprocess(run_rc=0)
    try:
        with Patch(_PORTS_MARKER=marker, PORTS_INSTALL_LOG=logf, subprocess=fake):
            payload, code = cs.ports_run(BB, "install")
        check("opted-in install -> 200", code, 200)
        check("started True", payload.get("started"), True)
        check("install reports byo-dump", payload.get("requires_user_files"), True)
        # Step 1: curl of the FROZEN url to a tmp file, argv list, https pinned.
        check("one curl fetch", len(fake.run_calls), 1)
        fetch = fake.run_calls[0]
        check("fetch is argv list", isinstance(fetch, list), True)
        check("fetch is curl", fetch[0], "curl")
        check("fetch pins https", "--proto" in fetch and "=https" in fetch, True)
        check("fetch URL is the frozen one", BB_INSTALL_URL in fetch, True)
        check("fetch writes to a tmp bootstrap.sh",
              fetch[-1] == BB_INSTALL_URL and fetch[-2].endswith("bootstrap.sh"), True)
        # Step 2: bash <that same file>, argv list, no shell, no url.
        check("one bash spawn", len(fake.popen_calls), 1)
        popen = fake.popen_calls[0]
        check("spawn is argv list", isinstance(popen, list), True)
        check("spawn runs bash on the fetched script",
              popen[0] == "bash" and popen[1] == fetch[-2], True)
        check("spawn argv carries no url", BB_INSTALL_URL not in popen, True)
    finally:
        _reset_job()


def test_second_install_while_running_is_refused():
    print("test_second_install_while_running_is_refused")
    _reset_job()
    d = tempfile.mkdtemp(prefix="ports-mark2-")
    marker = os.path.join(d, "allow-ports")
    open(marker, "w").close()
    logf = os.path.join(d, "ports-install.log")
    fake = _FakeSubprocess(run_rc=0)
    try:
        with Patch(_PORTS_MARKER=marker, PORTS_INSTALL_LOG=logf, subprocess=fake):
            p1, c1 = cs.ports_run(BB, "install")
            check("first starts", (c1, p1.get("started")), (200, True))
            # The held _FakeProc.poll() returns None -> still running.
            p2, c2 = cs.ports_run(BB, "install")
            check("second -> 409", c2, 409)
            check("second not started", p2.get("started"), False)
            check("no extra spawn", len(fake.popen_calls), 1)
    finally:
        _reset_job()


def test_uninstall_uses_uninstall_url():
    print("test_uninstall_uses_uninstall_url")
    _reset_job()
    d = tempfile.mkdtemp(prefix="ports-unmark-")
    marker = os.path.join(d, "allow-ports")
    open(marker, "w").close()
    logf = os.path.join(d, "ports-install.log")
    fake = _FakeSubprocess(run_rc=0)
    uninstall_url = (cs._PORTS_BY_ID[BB]["uninstall"]["bootstrap_url"])
    try:
        with Patch(_PORTS_MARKER=marker, PORTS_INSTALL_LOG=logf, subprocess=fake):
            payload, code = cs.ports_run(BB, "uninstall")
        check("uninstall -> 200", code, 200)
        check("uninstall fetched the uninstall url", uninstall_url in fake.run_calls[0], True)
        check("uninstall does not claim byo-dump", payload.get("requires_user_files"), False)
    finally:
        _reset_job()


def test_download_failure_is_502_and_not_started():
    print("test_download_failure_is_502_and_not_started")
    _reset_job()
    d = tempfile.mkdtemp(prefix="ports-dlfail-")
    marker = os.path.join(d, "allow-ports")
    open(marker, "w").close()
    logf = os.path.join(d, "ports-install.log")
    fake = _FakeSubprocess(run_rc=22)  # curl -f on a 404
    try:
        with Patch(_PORTS_MARKER=marker, PORTS_INSTALL_LOG=logf, subprocess=fake):
            payload, code = cs.ports_run(BB, "install")
        check("download failure -> 502", code, 502)
        check("not started", payload.get("started"), False)
        check("never reached the bash spawn", len(fake.popen_calls), 0)
    finally:
        _reset_job()


if __name__ == "__main__":
    for fn in (test_http_auth_and_catalog,
               test_http_install_auth_and_unknown_id,
               test_http_install_mock_started_runs_nothing,
               test_unknown_id_runs_nothing,
               test_optin_gate_blocks_before_spawning,
               test_install_builds_frozen_argv_list,
               test_second_install_while_running_is_refused,
               test_uninstall_uses_uninstall_url,
               test_download_failure_is_502_and_not_started):
        fn()
    if FAILURES:
        print("\n%d FAILED: %s" % (len(FAILURES), ", ".join(FAILURES)))
        sys.exit(1)
    print("\nall good")
