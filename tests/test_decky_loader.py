#!/usr/bin/env python3
"""Decky manager, Phase A: the loader state machine, the privilege shim and
the request correlation (spec docs/memory/project_decky-manager.md §14, first
bullet).

Run: python3 tests/test_decky_loader.py

WHAT THIS GUARDS. `POST /api/utilities/decky/run` is the first Couchside route
whose outcome is a ROOT process (the wrapper under couchside-decky-loader@.service
rewrites a systemd unit and swaps a root-owned binary). The agent itself never
runs anything as root here — it only STARTS a pinned unit — so the properties
that matter are all refusals and all zero-spawn:

  1. The mode is an ENUM (`_DECKY_LOADER_OPS`) and the argv element is the VALUE
     of the frozen `_DECKY_UNITS` dict; a client string is never an argv element.
  2. Every refusal (no installer, no opt-in marker, busy, helper predates the
     verb, helper silent) spawns NOTHING and opens no root path — asserted on a
     subprocess spy and a helper-connection counter, never on the return value
     alone (CLAUDE.md §6).
  3. A helper REFUSAL is final (rule 3 of tests/test_helper_shim.py) and a
     helper socket that is present-but-silent is NOT "absent": only a MISSING
     socket file takes the sudo path.
  4. `started` is never trusted from `systemctl start`'s exit code (a
     condition-skipped oneshot exits 0 having run nothing); the verdict is read
     back from the flock + result file and CORRELATED to this request, so a
     previous run's `done` can never render as this run's outcome.
  5. Detection degrades CLOSED: an unreadable /proc/net/tcp is "no loader", a
     non-root listener on 1337 is `running_untrusted` and the token endpoint is
     never contacted, an unknown Steam cause is `running` with steam_ui_up:false
     — never a guessed "Restart Steam".

FIXTURES. Every filesystem root the Decky code consults is a module constant
and is repointed into one temp tree here (`FX`). Two probes read /proc and are
faked by FILE, not by function, so the real parsers run: `/proc/net/tcp` and
`/proc/<pid>/stat`. Neither fixture is a verbatim hardware capture yet — they
are laid out to the kernel's documented formats (net/ipv4/tcp_ipv4.c
get_tcp4_sock, proc(5) /proc/[pid]/stat) and SAY SO; the verbatim captures are
spec §16 items 6 and 8 and this file must be re-pointed at them when they land
(CONVENTIONS §4: a green run on macOS proves nothing about /proc parsing).
"""
import errno
import http.client
import importlib.util
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location(
    "couchsided", os.path.join(ROOT, "agent", "couchsided.py"))
cs = importlib.util.module_from_spec(_spec)
sys.modules["couchsided"] = cs
_spec.loader.exec_module(cs)

# The REAL privileged helper module: its `decky.loader` validator is what the
# agent's capability probe talks to, so the probe test drives the real
# dispatcher rather than a hand-written reply.
_hspec = importlib.util.spec_from_file_location(
    "couchside_helper", os.path.join(ROOT, "agent", "couchside-helper.py"))
H = importlib.util.module_from_spec(_hspec)
sys.modules["couchside_helper"] = H
_hspec.loader.exec_module(H)

FAILURES = []
TOKEN = "test-secret-token"


def check(name, got, want):
    if got == want:
        print("  PASS  %s" % name)
    else:
        print("  FAIL  %s (got %r, want %r)" % (name, got, want))
        FAILURES.append(name)


class Patch:
    """Swap module attributes for the duration of a `with`, restore after."""

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


class _Completed:
    def __init__(self, rc, out, err):
        self.returncode, self.stdout, self.stderr = rc, out, err


class SpyRun:
    """Replace subprocess.run: record EVERY argv, spawn nothing.

    `show` is the property dict a `systemctl show` answers with (rendered as
    Key=Value lines so the agent's real parser runs); `sudo_rc` is the exit code
    of a `sudo ...` argv. Every other argv (pgrep, sudo -l, …) answers rc 1 with
    empty output — "the probe found nothing", the closed value."""

    def __init__(self, show=None, sudo_rc=0):
        self.calls = []
        self.show = show or {}
        self.sudo_rc = sudo_rc
        self._real = None

    def _run(self, argv, **kw):
        argv = list(argv)
        self.calls.append(argv)
        if argv[:2] == ["systemctl", "show"]:
            out = "".join("%s=%s\n" % kv for kv in self.show.items())
            return _Completed(0, out, "")
        if argv and argv[0] == "sudo":
            return _Completed(self.sudo_rc, "", "" if self.sudo_rc == 0
                              else "sudo: a password is required")
        return _Completed(1, "", "")

    def __enter__(self):
        self._real = cs.subprocess.run
        cs.subprocess.run = self._run
        return self

    def __exit__(self, *a):
        cs.subprocess.run = self._real

    @property
    def sudo_calls(self):
        return [c for c in self.calls if c and c[0] == "sudo"]


# ---------------------------------------------------------------------------
# One temp tree for every root the Decky code consults. Repointed ONCE at
# import; `reset()` wipes the state between tests.
# ---------------------------------------------------------------------------
FX = tempfile.mkdtemp(prefix="decky-loader-")
RUN = os.path.join(FX, "run")
LOCK = os.path.join(RUN, "decky-loader.lock")
RESULT = os.path.join(RUN, "decky-loader.result")
LOG = os.path.join(RUN, "decky-loader.log")
HB = os.path.join(FX, "homebrew")
SERVICES = os.path.join(HB, "services")
LOADER_BIN = os.path.join(SERVICES, "PluginLoader")
VERSION_FILE = os.path.join(SERVICES, ".loader.version")
PINNED_UNIT = os.path.join(SERVICES, ".systemd", "plugin_loader-release.service")
SETTINGS = os.path.join(HB, "settings", "loader.json")
PLUGINS = os.path.join(HB, "plugins")
PANEL = os.path.join(PLUGINS, "Couchside")
ETC = os.path.join(FX, "etc")
UNIT = os.path.join(ETC, "plugin_loader.service")
WRAPPER = os.path.join(ETC, "couchside-decky-loader")
TMPL = os.path.join(ETC, "couchside-decky-loader@.service")
MARKER = os.path.join(ETC, "allow-decky")
JOURNAL_WRAPPER = os.path.join(ETC, "couchside-journal")
CLI_BIN = os.path.join(FX, "bin", "couchside")
STEAM = os.path.join(FX, "steam")
PROC = os.path.join(FX, "proc")
TCP = os.path.join(PROC, "net", "tcp")
NOHELPER = os.path.join(FX, "nohelper.sock")     # never created: "absent"
STEAM_PID = 4242


def _closed_port():
    """A loopback port nothing listens on (bound then released), so a probe
    aimed at it gets ECONNREFUSED immediately — the "refuses" state."""
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


CLOSED_TOKEN_URL = "http://127.0.0.1:%d/auth/token" % _closed_port()
CLOSED_CEF_URL = "http://127.0.0.1:%d/json" % _closed_port()

cs._DECKY_RUN = RUN
cs._DECKY_HOMEBREW = HB
cs._DECKY_PLUGINS_DIR = PLUGINS
cs._DECKY_SERVICES_DIR = SERVICES
cs._DECKY_LOADER_BIN = LOADER_BIN
cs._DECKY_LOADER_VERSION_FILE = VERSION_FILE
cs._DECKY_PINNED_UNIT = PINNED_UNIT
cs._DECKY_SETTINGS = SETTINGS
cs._DECKY_PANEL_DIR = PANEL
cs._DECKY_UNIT = UNIT
cs._DECKY_MARKER = MARKER
cs._DECKY_WRAPPER = WRAPPER
cs._DECKY_UNIT_TMPL = TMPL
cs._DECKY_CLI_BIN = CLI_BIN
cs._DECKY_JOURNAL_WRAPPER = JOURNAL_WRAPPER
cs._DECKY_PROC = PROC
cs._DECKY_PROC_NET_TCP = TCP
cs._DECKY_ICON_DIR = os.path.join(FX, "icons")
cs._DECKY_JOB_FILE = os.path.join(FX, "decky-job.json")
cs._DECKY_TOKEN_URL = CLOSED_TOKEN_URL
cs._DECKY_CEF_URL = CLOSED_CEF_URL
cs.HELPER_SOCKET = NOHELPER
cs._steam_root = lambda: STEAM


def reset():
    """Back to "fresh box, nothing installed, no opt-in, no helper": wipe the
    tree, forget every memoised probe and the recorded request."""
    for d in (RUN, HB, ETC, os.path.dirname(CLI_BIN), STEAM, PROC):
        shutil.rmtree(d, ignore_errors=True)
        os.makedirs(d)
    os.makedirs(os.path.join(STEAM, "steamapps"))
    os.makedirs(os.path.join(PROC, "net"))
    cs._steam_root = lambda: STEAM
    cs.HELPER_SOCKET = NOHELPER
    cs._DECKY_TOKEN_URL = CLOSED_TOKEN_URL
    cs._DECKY_CEF_URL = CLOSED_CEF_URL
    with cs._DECKY_REQ_LOCK:
        cs._DECKY_REQ.update(mode=None, requested_at=0.0, unit=None, verdict=None)
    cs._DECKY_LAST_OP["key"] = None
    with cs._DECKY_JOB_LOCK:
        cs._DECKY_JOB["rec"] = None
    with cs._DECKY_CHECK_LOCK:
        cs._DECKY_CHECK["in_flight"] = False
        cs._DECKY_CHECK["val"] = None
    cs._decky_invalidate()


def install_loader(unit=True, binary=True):
    if unit:
        with open(UNIT, "w") as f:
            f.write("[Unit]\nDescription=SteamDeck Plugin Loader\n")
    if binary:
        os.makedirs(SERVICES, exist_ok=True)
        with open(LOADER_BIN, "wb") as f:
            f.write(b"\x7fELF" + b"\0" * 64)


def installer_ready(wrapper=True, tmpl=True, executable=True):
    if wrapper:
        with open(WRAPPER, "w") as f:
            f.write("#!/usr/bin/env bash\nexit 0\n")
        os.chmod(WRAPPER, 0o755 if executable else 0o644)
    if tmpl:
        with open(TMPL, "w") as f:
            f.write("[Unit]\nConditionPathExists=%s\n[Service]\nType=oneshot\n"
                    % MARKER)


def optin():
    with open(MARKER, "w") as f:
        f.write("")


def write_result(d):
    with open(RESULT + ".tmp", "w") as f:
        json.dump(d, f)
    os.replace(RESULT + ".tmp", RESULT)


class hold_lock:
    """Hold the wrapper's flock EXCLUSIVELY from ANOTHER PROCESS (flock is
    per-open-file-description, so an in-process holder would not contend with
    the probe's own open). Mirrors `exec 9>>$LOCK; flock 9` in the wrapper."""

    def __enter__(self):
        self.p = subprocess.Popen(
            [sys.executable, "-c",
             "import fcntl,sys,time\n"
             "f=open(sys.argv[1],'a');fcntl.flock(f,fcntl.LOCK_EX)\n"
             "print('held',flush=True);time.sleep(60)", LOCK],
            stdout=subprocess.PIPE, text=True)
        self.p.stdout.readline()          # "held": the lock is taken
        return self

    def __exit__(self, *a):
        self.p.kill()
        self.p.wait()


class FakeHelper:
    """A helper socket with a scripted reply per connection.

    `replies` entries are dicts (sent as JSON), or None for "accept, read the
    request, then never answer" (the busy/crashed helper). `dispatch` instead
    routes each request through a callable — used to put the REAL helper
    dispatcher behind the socket. `seen` accumulates parsed requests and
    `connections` counts accepts, which is what the zero-socket assertions
    read."""

    def __init__(self, replies=None, dispatch=None, hold_s=8.0):
        self.path = os.path.join(tempfile.mkdtemp(prefix="decky-helper-"),
                                 "helper.sock")
        self.seen = []
        self.connections = 0
        self._replies = list(replies or [])
        self._dispatch = dispatch
        self._hold_s = hold_s
        self._srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._srv.bind(self.path)
        self._srv.listen(8)
        self._srv.settimeout(0.5)
        self._stop = False
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        while not self._stop:
            try:
                conn, _ = self._srv.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            self.connections += 1
            buf = b""
            try:
                conn.settimeout(5)
                while b"\n" not in buf:
                    chunk = conn.recv(4096)
                    if not chunk:
                        break
                    buf += chunk
                try:
                    req = json.loads(buf.split(b"\n", 1)[0].decode())
                except ValueError:
                    req = None
                self.seen.append(req)
                if self._dispatch is not None:
                    reply = self._dispatch(req)
                elif self._replies:
                    reply = self._replies.pop(0)
                else:
                    reply = {"ok": False, "error": "fake helper: no reply scripted"}
                if reply is None:
                    time.sleep(self._hold_s)     # silent: hold, never answer
                else:
                    conn.sendall(json.dumps(reply).encode() + b"\n")
            except OSError:
                pass
            finally:
                try:
                    conn.close()
                except OSError:
                    pass

    def close(self):
        self._stop = True
        try:
            self._srv.close()
        except OSError:
            pass


class FakeHTTP:
    """A loopback HTTP server answering fixed bytes per path (Steam's :8080/json
    CEF debugger, Decky's /auth/token). `hits` records every path requested, so
    "the token endpoint was never contacted" is measurable."""

    def __init__(self, routes):
        outer = self
        self.hits = []

        class Hd(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                outer.hits.append(self.path)
                status, body = routes.get(self.path, (404, b"{}"))
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self._srv = ThreadingHTTPServer(("127.0.0.1", 0), Hd)
        self.port = self._srv.server_address[1]
        threading.Thread(target=self._srv.serve_forever, daemon=True).start()

    def url(self, path):
        return "http://127.0.0.1:%d%s" % (self.port, path)

    def close(self):
        self._srv.shutdown()
        self._srv.server_close()


CEF_WITH_SHARED = json.dumps([
    {"title": "SharedJSContext", "type": "page", "url": "https://steamloopback.host/index.html"},
    {"title": "Steam Big Picture Mode", "type": "page", "url": "https://steamloopback.host/routes/library/home"},
]).encode()
CEF_WITHOUT_SHARED = json.dumps([
    {"title": "Steam", "type": "page", "url": "https://steamloopback.host/index.html"},
]).encode()
FAKE_TOKEN = b"0c2f4a1e-7b3d-4c5e-9f10-2a3b4c5d6e7f"


# /proc/net/tcp — SYNTHETIC, laid out to the kernel's get_tcp4_sock format
# ("%4d: %08X:%04X %08X:%04X %02X %08X:%08X %02X:%08lX %08X %5u %8d %lu ...").
# 0100007F:0539 is 127.0.0.1:1337 little-endian; st 0A is LISTEN. The verbatim
# capture off the box (real loader → uid 0; user-level fake → uid 1000) is
# spec §16 item 8 and replaces this block when it lands.
TCP_HEADER = ("  sl  local_address rem_address   st tx_queue rx_queue tr tm->when "
              "retrnsmt   uid  timeout inode\n")


def tcp_fixture(kind):
    rows = {
        "root":  "   0: 0100007F:0539 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 31337 1 0000000000000000 100 0 0 10 0\n",
        "other": "   0: 0100007F:0539 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 31337 1 0000000000000000 100 0 0 10 0\n",
        # An ESTABLISHED row on 1337 (st 01) with no LISTEN row: not a listener.
        "established": "   0: 0100007F:0539 0100007F:9C40 01 00000000:00000000 00:00000000 00000000     0        0 31337 1 0000000000000000 20 4 30 10 -1\n",
        # A root LISTEN on a DIFFERENT port (8888) and a user LISTEN on 1337 — the
        # parser must key on the local address, not "first root row".
        "other_with_root_elsewhere": (
            "   0: 0100007F:22B8 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 31000 1 0000000000000000 100 0 0 10 0\n"
            "   1: 0100007F:0539 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 31337 1 0000000000000000 100 0 0 10 0\n"),
        "none": "",
    }
    with open(TCP, "w") as f:
        f.write(TCP_HEADER + rows[kind])


# /proc/<pid>/stat + /proc/stat — SYNTHETIC per proc(5): field 2 is the comm in
# parentheses (may itself contain spaces and parentheses, which is why the
# parser splits AFTER the last ')'), field 22 is starttime in clock ticks since
# boot; btime in /proc/stat is the boot epoch. Verbatim capture: spec §16 item 6.
BTIME = 1_757_100_000


def proc_fixture(start_ticks, comm="steam", uptime_s=90_000.0, pid=STEAM_PID):
    with open(os.path.join(PROC, "stat"), "w") as f:
        f.write("cpu  1 2 3 4 5 6 7 0 0 0\nctxt 12345\nbtime %d\nprocesses 999\n" % BTIME)
    with open(os.path.join(PROC, "uptime"), "w") as f:
        f.write("%.2f %.2f\n" % (uptime_s, uptime_s * 3))
    os.makedirs(os.path.join(PROC, str(pid)), exist_ok=True)
    rest = ["S", "1", str(pid), str(pid), "0", "-1", "4194560", "12345", "678", "0",
            "0", "100", "50", "0", "0", "20", "0", "30", "0", str(start_ticks),
            "123456789", "45678901", "18446744073709551615", "1", "1", "0", "0",
            "0", "0", "0", "0", "0", "0", "0", "0", "0", "17", "3", "0", "0", "0",
            "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0"]
    with open(os.path.join(PROC, str(pid), "stat"), "w") as f:
        f.write("%d (%s) %s\n" % (pid, comm, " ".join(rest)))


def steam_start_epoch(start_ticks):
    hz = os.sysconf("SC_CLK_TCK")
    return BTIME + start_ticks / float(hz)


def _server():
    """The REAL (non-mock) handler: token-gated, Steam root = the fixture."""
    cs.Handler.token = TOKEN
    cs.Handler.token_file = None
    cs.Handler.mock = False
    cs.Handler.port = 0
    srv = ThreadingHTTPServer(("127.0.0.1", 0), cs.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


def _req(port, method, path, token=TOKEN):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
    headers = {"Authorization": "Bearer " + token} if token is not None else {}
    if method == "POST":
        headers["Content-Length"] = "0"
    conn.request(method, path, headers=headers)
    resp = conn.getresponse()
    data = resp.read()
    conn.close()
    try:
        return resp.status, json.loads(data or b"{}")
    except ValueError:
        return resp.status, {}


PHASE_A_ROUTES = (("GET", "/api/decky/loader"),
                  ("GET", "/api/decky/loader/log"),
                  ("POST", "/api/decky/loader/check"),
                  ("POST", "/api/utilities/decky/run?op=install"))


# ---------------------------------------------------------------------------
print("\nauth + Steam-root gates on every Phase A route")
# ---------------------------------------------------------------------------

def test_every_phase_a_route_is_bearer_gated():
    """No bearer → 401, wrong bearer → 401, on all four Phase A routes; the
    control is that the RIGHT bearer gets past the gate (anything but 401)."""
    print("test_every_phase_a_route_is_bearer_gated")
    reset()
    srv, port = _server()
    try:
        with SpyRun():
            for method, path in PHASE_A_ROUTES:
                check("%s %s no bearer -> 401" % (method, path),
                      _req(port, method, path, token=None)[0], 401)
                check("%s %s wrong bearer -> 401" % (method, path),
                      _req(port, method, path, token="nope")[0], 401)
                st = _req(port, method, path)[0]
                check("%s %s right bearer passes the gate (control)" % (method, path),
                      st != 401, True)
    finally:
        srv.shutdown()


def test_no_steam_root_hides_the_whole_surface():
    """Degrade closed (§3.7): without a Steam root every /api/decky/* route and
    the decky run 404 like an old agent, even WITH the token — no client ever
    sees an `unsupported` state. Control: with a root they answer."""
    print("test_no_steam_root_hides_the_whole_surface")
    reset()
    srv, port = _server()
    try:
        with SpyRun(), Patch(_steam_root=lambda: None):
            for method, path in PHASE_A_ROUTES:
                check("%s %s without a Steam root -> 404" % (method, path),
                      _req(port, method, path)[0], 404)
        with SpyRun():
            check("GET loader with a Steam root -> 200 (control)",
                  _req(port, "GET", "/api/decky/loader")[0], 200)
    finally:
        srv.shutdown()


# ---------------------------------------------------------------------------
print("\nPOST /api/utilities/decky/run — refusals spawn nothing")
# ---------------------------------------------------------------------------

def test_run_without_marker_is_403_and_spawns_nothing():
    """Installer present, opt-in marker absent: 403 needs_optin for BOTH modes,
    zero subprocess spawns and the helper socket never even probed (the marker
    gate precedes the helper probe — a helper that is not asked can not be
    tricked)."""
    print("test_run_without_marker_is_403_and_spawns_nothing")
    reset()
    installer_ready()
    helper = FakeHelper([{"ok": True}] * 4)
    cs.HELPER_SOCKET = helper.path
    srv, port = _server()
    try:
        with SpyRun() as spy:
            for op in ("install", "uninstall"):
                st, body = _req(port, "POST", "/api/utilities/decky/run?op=" + op)
                check("?op=%s without marker -> 403" % op, st, 403)
                check("...body says needs_optin",
                      (body.get("ok"), body.get("needs_optin"), body.get("error")),
                      (False, True, "needs_optin"))
                check("...stderr names the opt-in command (old present() renders it)",
                      "couchside allow-decky on" in body.get("stderr", ""), True)
            check("zero spawns across both refusals", spy.calls, [])
            check("helper never contacted", helper.connections, 0)
    finally:
        srv.shutdown()
        helper.close()


def test_run_op_is_an_enum_and_a_missing_op_is_a_human_string():
    """`?op=` outside the enum is REJECTED (400, nothing consulted); a MISSING
    `?op=` is a pre-2.9.58 app pressing the row's run button and gets 200
    {ok:false} with the update-the-app string in BOTH `error` and `stderr`
    (old present() renders stderr) — never a 400 dead button."""
    print("test_run_op_is_an_enum_and_a_missing_op_is_a_human_string")
    reset()
    installer_ready()
    optin()
    helper = FakeHelper([{"ok": True}] * 4)
    cs.HELPER_SOCKET = helper.path
    srv, port = _server()
    try:
        with SpyRun() as spy:
            for bad in ("bogus", "repair", "Install", "install%20", "install;id",
                        "%00install"):
                st, body = _req(port, "POST", "/api/utilities/decky/run?op=" + bad)
                check("?op=%r -> 400" % bad, st, 400)
            # `?op=` PRESENT with an empty value is "present and not in the
            # enum" per spec §3 -> 400. (parse_qs drops blank values unless
            # keep_blank_values=True, which would read this as "missing" and
            # answer the update-the-app string instead; harmless — nothing
            # runs either way — but it is sanitising, not rejecting.)
            st, body = _req(port, "POST", "/api/utilities/decky/run?op=")
            check("?op= with an EMPTY value -> 400 (spec: present, not in the enum)", st, 400)
            check("...and nothing was started either way", body.get("started"), None)
            st, body = _req(port, "POST", "/api/utilities/decky/run")
            check("missing ?op= -> 200", st, 200)
            check("...ok:false with the human string in error AND stderr",
                  (body.get("ok"),
                   body.get("error"), body.get("stderr")),
                  (False, "Update the Couchside app to manage Decky Loader",
                   "Update the Couchside app to manage Decky Loader"))
            check("...nothing was started", body.get("started"), None)
            check("zero spawns for every rejected/missing op", spy.calls, [])
            check("helper never contacted", helper.connections, 0)
        check("_DECKY_LOADER_OPS is exactly install|uninstall",
              tuple(cs._DECKY_LOADER_OPS), ("install", "uninstall"))
        check("_DECKY_UNITS maps each op to its pinned template instance",
              dict(cs._DECKY_UNITS),
              {"install": "couchside-decky-loader@install.service",
               "uninstall": "couchside-decky-loader@uninstall.service"})
    finally:
        srv.shutdown()
        helper.close()


def test_run_busy_409_for_both_whats():
    """The ONE mutex: a held wrapper flock → 409 what:loader_op; a plugin job
    record not yet done → 409 what:plugin_job; an in-flight loader check →
    409 what:plugin_job. Zero spawns, helper never asked, in every case."""
    print("test_run_busy_409_for_both_whats")
    reset()
    installer_ready()
    optin()
    helper = FakeHelper([{"ok": True}] * 4)
    cs.HELPER_SOCKET = helper.path
    srv, port = _server()
    try:
        with SpyRun(show={"ActiveState": "activating"}) as spy:
            with hold_lock():
                st, body = _req(port, "POST", "/api/utilities/decky/run?op=install")
                check("flock held -> 409", st, 409)
                check("...what:loader_op",
                      (body.get("busy"), body.get("what")), (True, "loader_op"))
            with cs._DECKY_JOB_LOCK:
                cs._DECKY_JOB["rec"] = {"kind": "install", "name": "x", "done": False}
            st, body = _req(port, "POST", "/api/utilities/decky/run?op=uninstall")
            check("plugin job running -> 409", st, 409)
            check("...what:plugin_job",
                  (body.get("busy"), body.get("what")), (True, "plugin_job"))
            with cs._DECKY_JOB_LOCK:
                cs._DECKY_JOB["rec"] = None
            with cs._DECKY_CHECK_LOCK:
                cs._DECKY_CHECK["in_flight"] = True
            st, body = _req(port, "POST", "/api/utilities/decky/run?op=install")
            check("loader check in flight -> 409 plugin_job",
                  (st, body.get("what")), (409, "plugin_job"))
            with cs._DECKY_CHECK_LOCK:
                cs._DECKY_CHECK["in_flight"] = False
            check("zero spawns across the three busy refusals", spy.calls, [])
            check("helper never contacted", helper.connections, 0)
            # CONTROL: with nothing busy the same request proceeds past the
            # mutex (to the helper probe, then the verb).
            st, body = _req(port, "POST", "/api/utilities/decky/run?op=install")
            check("nothing busy -> the helper IS asked and the op starts (control)",
                  (st, body.get("started"), helper.connections), (200, True, 2))
    finally:
        srv.shutdown()
        helper.close()


def test_run_reports_installer_and_helper_state_over_http():
    """The 200 ok:false shapes the app reads: needs_installer (wrapper missing),
    helper_outdated (a 1.0.0 helper answers `unknown verb`; sudo NOT tried),
    helper_unreachable+retry; and the happy path: a 1.1.0 helper starts the
    unit → ok:true started via:helper with the constant log path."""
    print("test_run_reports_installer_and_helper_state_over_http")
    reset()
    optin()
    srv, port = _server()
    try:
        with SpyRun(show={"ActiveState": "activating"}) as spy:
            st, body = _req(port, "POST", "/api/utilities/decky/run?op=install")
            check("no wrapper -> 200 ok:false needs_installer",
                  (st, body.get("ok"), body.get("needs_installer")), (200, False, True))
            check("...stderr tells the owner to re-run the installer",
                  "re-run the Couchside installer" in body.get("stderr", ""), True)
            check("...zero spawns", spy.calls, [])

            installer_ready()
            old = FakeHelper([{"ok": False, "error": "unknown verb"}])
            cs.HELPER_SOCKET = old.path
            cs._decky_invalidate()
            st, body = _req(port, "POST", "/api/utilities/decky/run?op=install")
            check("1.0.0 helper -> 200 ok:false helper_outdated",
                  (st, body.get("ok"), body.get("helper_outdated")), (200, False, True))
            check("...stderr names the privileged helper",
                  "privileged helper" in body.get("stderr", ""), True)
            check("...sudo NOT tried after the refusal (rule 3)", spy.sudo_calls, [])
            old.close()

            new = FakeHelper([{"ok": False, "error": "invalid argument for decky.loader"},
                              {"ok": True, "detail": "fake-ok"}])
            cs.HELPER_SOCKET = new.path
            cs._decky_invalidate()
            st, body = _req(port, "POST", "/api/utilities/decky/run?op=install")
            check("1.1.0 helper -> 200 ok:true started via helper",
                  (st, body.get("ok"), body.get("started"), body.get("via")),
                  (200, True, True, "helper"))
            check("...log is the constant transcript path",
                  body.get("log"), os.path.join(RUN, "decky-loader.log"))
            check("...the verb call carried the enum VALUE, not the query",
                  [(r.get("verb"), r.get("arg")) for r in new.seen],
                  [("decky.loader", "probe"), ("decky.loader", "install")])
            check("...sudo untouched", spy.sudo_calls, [])
            new.close()
    finally:
        srv.shutdown()


# ---------------------------------------------------------------------------
print("\n_decky_loader_installed / result parser / log reader")
# ---------------------------------------------------------------------------

def test_loader_installed_fixtures_both_ways():
    """Unit-only and binary-only both count as installed (install.sh
    decky_installed() parity); a plugins dir full of litter does NOT — uninstall
    keeps plugins/, so its presence proves nothing."""
    print("test_loader_installed_fixtures_both_ways")
    reset()
    check("fresh tree -> not installed", cs._decky_loader_installed(), False)
    os.makedirs(os.path.join(PLUGINS, "SteamGridDB"))
    with open(os.path.join(PLUGINS, "SteamGridDB", "plugin.json"), "w") as f:
        f.write('{"name":"SteamGridDB"}')
    check("plugins-dir litter only -> NOT installed (control)",
          cs._decky_loader_installed(), False)
    install_loader(unit=True, binary=False)
    check("unit file only -> installed", cs._decky_loader_installed(), True)
    os.remove(UNIT)
    install_loader(unit=False, binary=True)
    check("loader binary only -> installed", cs._decky_loader_installed(), True)
    install_loader(unit=True, binary=True)
    check("both -> installed", cs._decky_loader_installed(), True)
    # A unit path that is a DIRECTORY is not a unit file.
    os.remove(UNIT)
    os.remove(LOADER_BIN)
    os.makedirs(UNIT)
    check("a directory at the unit path is not an install", cs._decky_loader_installed(), False)


def test_result_parser_accepts_only_the_wrapper_shape():
    """The result file is root-written but a torn/half-moved copy must read as
    'no result', never as a verdict: every field is type-checked, `tag` outside
    the tag shape is BLANKED (display-only), anything else is rejected."""
    print("test_result_parser_accepts_only_the_wrapper_shape")
    reset()
    check("absent -> None", cs._decky_read_result(), None)
    good = {"mode": "install", "state": "done", "ok": True, "tag": "v3.2.8", "at": 1757100000}
    write_result(good)
    check("the wrapper's own shape parses", cs._decky_read_result(), good)
    write_result(dict(good, at=1757100000.9))
    check("float `at` is truncated to int", cs._decky_read_result()["at"], 1757100000)
    for label, bad in (
            ("mode outside the enum", dict(good, mode="repair")),
            ("state outside the enum", dict(good, state="finished")),
            ("non-bool ok", dict(good, ok="true")),
            ("bool at", dict(good, at=True)),
            ("string at", dict(good, at="1757100000")),
            ("missing at", {k: v for k, v in good.items() if k != "at"}),
    ):
        write_result(bad)
        check("%s -> None" % label, cs._decky_read_result(), None)
    write_result(dict(good, tag="$(rm -rf /)"))
    check("odd tag -> blanked, entry kept", cs._decky_read_result()["tag"], "")
    write_result(dict(good, tag=""))
    check("empty tag (refused/running) -> kept as ''", cs._decky_read_result()["tag"], "")
    write_result(dict(good, tag="v3.3.0-pre1"))
    check("prerelease-shaped tag kept", cs._decky_read_result()["tag"], "v3.3.0-pre1")
    with open(RESULT, "w") as f:
        f.write('{"mode":"install","state":"done","ok":tr')
    check("truncated JSON -> None", cs._decky_read_result(), None)
    with open(RESULT, "w") as f:
        f.write('["install","done"]')
    check("non-object JSON -> None", cs._decky_read_result(), None)
    with open(RESULT, "wb") as f:
        f.write(b"\xff\xfe" + b"\0" * 10)
    check("binary garbage -> None", cs._decky_read_result(), None)


def test_log_reader_is_a_bounded_tail_at_a_constant_path():
    """`_decky_loader_log(n)` reads the tail of the constant transcript, n
    clamped 1..400, missing file -> {"lines": []}; the route REJECTS a
    non-integer ?n= (400) rather than sanitising it."""
    print("test_log_reader_is_a_bounded_tail_at_a_constant_path")
    reset()
    import inspect
    check("only an `n` parameter (no path a client could aim)",
          list(inspect.signature(cs._decky_loader_log).parameters), ["n"])
    check("missing log -> empty", cs._decky_loader_log(5), {"lines": []})
    with open(LOG, "w") as f:
        f.write("\n".join("line %d" % i for i in range(1000)) + "\n")
    check("n=3 -> the last three lines", cs._decky_loader_log(3)["lines"],
          ["line 997", "line 998", "line 999"])
    check("n=9999 clamps to 400", len(cs._decky_loader_log(9999)["lines"]), 400)
    check("n=0 clamps to 1", cs._decky_loader_log(0)["lines"], ["line 999"])
    check("n=-5 clamps to 1", len(cs._decky_loader_log(-5)["lines"]), 1)
    check("n=None -> the default", len(cs._decky_loader_log(None)["lines"]),
          cs._DECKY_LOG_DEFAULT_LINES)
    check("a non-numeric n falls back to the default (function level)",
          len(cs._decky_loader_log("abc")["lines"]), cs._DECKY_LOG_DEFAULT_LINES)
    # A runaway log: only the last 64 KiB are read, and the partial first line
    # of that window is dropped rather than shown torn.
    with open(LOG, "w") as f:
        for i in range(20000):
            f.write("entry-%05d padding padding padding padding\n" % i)
    tail = cs._decky_loader_log(400)["lines"]
    check("huge log -> still 400 whole lines", len(tail), 400)
    check("...ending with the real last line", tail[-1].startswith("entry-19999"), True)
    check("...every line is whole", all(t.startswith("entry-") for t in tail), True)

    srv, port = _server()
    try:
        with SpyRun():
            for bad in ("abc", "1e3", "5x", "%C2%B2", "%D9%A3", "--1", "1.0"):
                check("?n=%s -> 400 (rejected, not sanitised)" % bad,
                      _req(port, "GET", "/api/decky/loader/log?n=" + bad)[0], 400)
            st, body = _req(port, "GET", "/api/decky/loader/log?n=5")
            check("?n=5 -> five lines", (st, len(body.get("lines", []))), (200, 5))
            st, body = _req(port, "GET", "/api/decky/loader/log?n=9999")
            check("?n=9999 -> clamped to 400", len(body.get("lines", [])), 400)
            st, body = _req(port, "GET", "/api/decky/loader/log")
            check("no ?n= -> the default", len(body.get("lines", [])),
                  cs._DECKY_LOG_DEFAULT_LINES)
    finally:
        srv.shutdown()


# ---------------------------------------------------------------------------
print("\n_decky_loader_start — the shim: enum in, unit VALUE out, refusals are free")
# ---------------------------------------------------------------------------

def test_loader_start_takes_only_the_module_enum():
    """The only parameter is `mode`, and a value outside `_DECKY_LOADER_OPS`
    (which the route has already enforced) can never reach the helper or sudo:
    with every gate open, a stray mode is a did_not_start with ZERO spawns and
    ZERO helper connections."""
    print("test_loader_start_takes_only_the_module_enum")
    reset()
    installer_ready()
    optin()
    check("exactly one parameter", cs._decky_loader_start.__code__.co_argcount, 1)
    check("...named mode", cs._decky_loader_start.__code__.co_varnames[:1], ("mode",))
    helper = FakeHelper([{"ok": True}] * 4)
    cs.HELPER_SOCKET = helper.path
    with SpyRun() as spy, Patch(_sudo_nopasswd_allows=lambda needle: True):
        for bad in ("repair", "install ", "Install", "", None, ["install"], 0):
            r = cs._decky_loader_start(bad)
            check("mode %r -> not started" % (bad,), r.get("started"), False)
        check("zero spawns for every stray mode", spy.calls, [])
        check("helper never contacted for a stray mode", helper.connections, 0)
    helper.close()


def test_loader_start_refusals_spawn_nothing():
    """Each gate in order, each observed in BOTH directions where it is cheap:
    wrapper absent / template absent / wrapper not executable -> needs_installer;
    marker absent -> needs_optin; flock held -> busy loader_op; job slot ->
    busy plugin_job. A helper with a scripted OK sits behind every case and is
    never asked; sudo is never spawned."""
    print("test_loader_start_refusals_spawn_nothing")
    reset()
    helper = FakeHelper([{"ok": True}] * 8)
    cs.HELPER_SOCKET = helper.path
    with SpyRun() as spy, Patch(_sudo_nopasswd_allows=lambda needle: True):
        check("nothing installed -> needs_installer",
              cs._decky_loader_start("install"), {"started": False, "needs_installer": True})
        installer_ready(wrapper=True, tmpl=False)
        check("wrapper without the unit template -> needs_installer",
              cs._decky_loader_start("install"), {"started": False, "needs_installer": True})
        installer_ready(wrapper=True, tmpl=True, executable=False)
        check("template + non-executable wrapper -> needs_installer",
              cs._decky_loader_start("uninstall"), {"started": False, "needs_installer": True})
        installer_ready()
        check("installer ready but no marker -> needs_optin",
              cs._decky_loader_start("install"), {"started": False, "needs_optin": True})
        optin()
        with hold_lock():
            check("flock held -> busy loader_op",
                  cs._decky_loader_start("install"),
                  {"started": False, "busy": True, "what": "loader_op"})
        with cs._DECKY_JOB_LOCK:
            cs._DECKY_JOB["rec"] = {"kind": "reload", "name": "PowerTools", "done": False}
        check("plugin job slot taken -> busy plugin_job",
              cs._decky_loader_start("install"),
              {"started": False, "busy": True, "what": "plugin_job"})
        with cs._DECKY_JOB_LOCK:
            cs._DECKY_JOB["rec"] = {"kind": "reload", "name": "PowerTools", "done": True}
        check("a DONE job record does not hold the slot (control)",
              cs._decky_busy(), None)
        check("zero spawns across every refusal", spy.calls, [])
        check("helper never contacted by any refusal", helper.connections, 0)
        check("no request was recorded by a refusal",
              cs._DECKY_REQ["requested_at"], 0.0)
    helper.close()


def test_loader_start_helper_present_uses_the_verb_and_not_sudo():
    """A 1.1.0 helper (probe answered `invalid argument for decky.loader`) is
    handed the verb with the enum VALUE; the sudo grant is never consulted and
    never spawned, even when it would allow. The request is recorded for
    correlation."""
    print("test_loader_start_helper_present_uses_the_verb_and_not_sudo")
    reset()
    installer_ready()
    optin()
    asked = []
    for mode in ("install", "uninstall"):
        helper = FakeHelper([{"ok": False, "error": "invalid argument for decky.loader"},
                             {"ok": True, "detail": "fake-ok"}])
        cs.HELPER_SOCKET = helper.path
        cs._decky_invalidate()
        with SpyRun(show={"ActiveState": "activating"}) as spy, \
                Patch(_sudo_nopasswd_allows=lambda needle: asked.append(needle) or True):
            t0 = time.time()
            r = cs._decky_loader_start(mode)
            check("%s: started via helper" % mode,
                  (r.get("started"), r.get("via")), (True, "helper"))
            check("%s: helper saw probe then the verb with the enum value" % mode,
                  [(x.get("verb"), x.get("arg")) for x in helper.seen],
                  [("decky.loader", "probe"), ("decky.loader", mode)])
            check("%s: sudo never spawned" % mode, spy.sudo_calls, [])
            check("%s: the sudoers probe was not even consulted" % mode, asked, [])
            check("%s: request recorded (mode, unit)" % mode,
                  (cs._DECKY_REQ["mode"], cs._DECKY_REQ["unit"]),
                  (mode, cs._DECKY_UNITS[mode]))
            check("%s: requested_at is now" % mode,
                  abs(cs._DECKY_REQ["requested_at"] - t0) < 5, True)
        helper.close()

    # A 1.1.0 helper that REFUSES the verb (marker removed under it, or the
    # wrapper gone): the refusal is final and surfaced as `detail`.
    helper = FakeHelper([{"ok": False, "error": "invalid argument for decky.loader"},
                         {"ok": False, "detail": "decky management not enabled (couchside allow-decky on)"}])
    cs.HELPER_SOCKET = helper.path
    cs._decky_invalidate()
    with SpyRun() as spy, Patch(_sudo_nopasswd_allows=lambda needle: True):
        r = cs._decky_loader_start("install")
        check("helper refusal -> started:false via helper with its detail",
              (r.get("started"), r.get("via"), r.get("detail")),
              (False, "helper", "decky management not enabled (couchside allow-decky on)"))
        check("...sudo NOT tried as a second ask", spy.sudo_calls, [])
    helper.close()


def test_loader_start_outdated_helper_is_final():
    """A 1.0.0 helper answers `unknown verb` to the probe: helper_outdated,
    FINAL — the sudo grant is not consulted even when it would allow, and the
    verb is never sent (one connection: the probe)."""
    print("test_loader_start_outdated_helper_is_final")
    reset()
    installer_ready()
    optin()
    helper = FakeHelper([{"ok": False, "error": "unknown verb"}] * 3)
    cs.HELPER_SOCKET = helper.path
    asked = []
    with SpyRun() as spy, \
            Patch(_sudo_nopasswd_allows=lambda needle: asked.append(needle) or True):
        r = cs._decky_loader_start("install")
        check("unknown verb -> helper_outdated", r, {"started": False, "helper_outdated": True})
        check("exactly one helper connection (the probe)", helper.connections, 1)
        check("the probe argument is 'probe'", helper.seen[0].get("arg"), "probe")
        check("sudo never spawned", spy.sudo_calls, [])
        check("sudoers not consulted", asked, [])
        check("no request recorded (nothing was started)", cs._DECKY_REQ["requested_at"], 0.0)
        # The verdict is cached 30 s: a second start within the window does not
        # re-probe (the poll must not stack helper round trips).
        r2 = cs._decky_loader_start("install")
        check("second call within the cache window -> same answer, no new probe",
              (r2, helper.connections), ({"started": False, "helper_outdated": True}, 1))
    helper.close()


def test_loader_start_silent_helper_is_unreachable_not_absent():
    """Socket FILE present, helper accepts and never answers (busy/crashed): the
    probe times out (5 s) -> helper_unreachable+retry, and the sudo path is NOT
    taken — on a helper-only box that would tell the owner to run allow-decky
    for a grant the box never had. Same for a dead socket file (bound, then
    closed): still not 'absent'."""
    print("test_loader_start_silent_helper_is_unreachable_not_absent")
    reset()
    installer_ready()
    optin()
    silent = FakeHelper([None])
    cs.HELPER_SOCKET = silent.path
    asked = []
    with SpyRun() as spy, \
            Patch(_sudo_nopasswd_allows=lambda needle: asked.append(needle) or True):
        t0 = time.monotonic()
        r = cs._decky_loader_start("install")
        dt = time.monotonic() - t0
        check("silent helper -> helper_unreachable, retry",
              r, {"started": False, "helper_unreachable": True, "retry": True})
        check("...bounded by the 5 s probe timeout (%.1f s)" % dt, 4.0 <= dt < 9.0, True)
        check("...sudo never spawned", spy.sudo_calls, [])
        check("...sudoers not consulted", asked, [])
        check("...no request recorded", cs._DECKY_REQ["requested_at"], 0.0)
    silent.close()

    d = tempfile.mkdtemp(prefix="decky-dead-")
    dead = os.path.join(d, "helper.sock")
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.bind(dead)
    s.close()                                   # path exists, nothing listens
    cs.HELPER_SOCKET = dead
    cs._decky_invalidate()
    with SpyRun() as spy, Patch(_sudo_nopasswd_allows=lambda needle: True):
        r = cs._decky_loader_start("install")
        check("dead socket FILE -> helper_unreachable (not the sudo path)",
              r, {"started": False, "helper_unreachable": True, "retry": True})
        check("...sudo never spawned", spy.sudo_calls, [])
    # And the shape the helper verdict itself reports:
    cs._decky_invalidate()
    check("_decky_helper_verb on a dead socket file -> 'unreachable'",
          cs._decky_helper_verb(), "unreachable")
    cs.HELPER_SOCKET = NOHELPER
    cs._decky_invalidate()
    check("_decky_helper_verb with NO socket file -> 'absent' (control)",
          cs._decky_helper_verb(), "absent")


def test_loader_start_helper_absent_runs_exactly_the_sudo_argv():
    """Only a MISSING socket takes the sudo path, and then only when sudoers
    actually grants the exact argv: `[sudo, -n, /usr/bin/systemctl, start,
    --no-block, couchside-decky-loader@install.service]` — the wrapper path is
    never in the argv, the mode word is never in the argv."""
    print("test_loader_start_helper_absent_runs_exactly_the_sudo_argv")
    reset()
    installer_ready()
    optin()
    cs.HELPER_SOCKET = NOHELPER
    asked = []
    with SpyRun() as spy, \
            Patch(_sudo_nopasswd_allows=lambda needle: asked.append(needle) or False):
        r = cs._decky_loader_start("install")
        check("no grant -> needs_optin", r, {"started": False, "needs_optin": True})
        check("...the probe asked about the install INSTANCE, not the wrapper",
              asked, ["couchside-decky-loader@install.service"])
        check("...zero spawns (the sudo -l probe is faked here)", spy.calls, [])
    for mode in ("install", "uninstall"):
        cs._decky_invalidate()
        with SpyRun(show={"ActiveState": "activating"}) as spy, \
                Patch(_sudo_nopasswd_allows=lambda needle: needle == cs._DECKY_UNITS[mode]):
            r = cs._decky_loader_start(mode)
            check("%s: exactly one sudo spawn with the exact argv" % mode, spy.sudo_calls,
                  [["sudo", "-n", "/usr/bin/systemctl", "start", "--no-block",
                    "couchside-decky-loader@%s.service" % mode]])
            check("%s: started via sudo" % mode, (r.get("started"), r.get("via")), (True, "sudo"))
            check("%s: the wrapper path is not in any argv" % mode,
                  any(WRAPPER in a for c in spy.calls for a in c), False)
    # sudo itself failing (grant deleted between the probe and the start):
    cs._decky_invalidate()
    with SpyRun(sudo_rc=1) as spy, Patch(_sudo_nopasswd_allows=lambda needle: True):
        r = cs._decky_loader_start("install")
        check("sudo exit 1 -> started:false via sudo with exit_code and detail",
              (r.get("started"), r.get("via"), r.get("exit_code"),
               "password" in r.get("detail", "")),
              (False, "sudo", 1, True))
        check("...exactly one sudo attempt, no retry", len(spy.sudo_calls), 1)


def test_helper_probe_against_the_real_validator():
    """The probe is `decky.loader` with the argument "probe", which the REAL
    helper validator refuses BEFORE any handler runs: put the real dispatcher
    behind a socket with `_run` spied and prove (a) the reply is the
    invalid-argument shape → 'present', (b) nothing spawned, (c) the marker and
    wrapper gates were never reached. Control: a 1.0.0 dispatcher table without
    the verb → 'unknown verb' → 'outdated'."""
    print("test_helper_probe_against_the_real_validator")
    reset()
    spawns = []
    saved_run = H._run
    H._run = lambda argv, timeout=25: (spawns.append(list(argv)) or (True, "fake-ok"))
    saved_marker, saved_wrapper = H._DECKY_MARKER, H._DECKY_WRAPPER
    H._DECKY_MARKER = os.path.join(FX, "never-there-marker")
    H._DECKY_WRAPPER = os.path.join(FX, "never-there-wrapper")
    real = FakeHelper(dispatch=H.dispatch)
    cs.HELPER_SOCKET = real.path
    try:
        check("the helper module carries the verb", "decky.loader" in H.VERBS, True)
        cs._decky_invalidate()
        check("real 1.1.0 dispatcher -> 'present'", cs._decky_helper_verb(), "present")
        check("the probe sent {verb: decky.loader, arg: probe}",
              real.seen, [{"verb": "decky.loader", "arg": "probe"}])
        check("the real validator refused it with zero spawns", spawns, [])
        # A direct dispatch shows the exact refusal string the shim keys on is
        # NOT 'unknown verb' (which would read as outdated).
        reply = H.dispatch({"verb": "decky.loader", "arg": "probe"})
        check("refusal is the invalid-argument shape",
              (reply.get("ok"), reply.get("error")),
              (False, "invalid argument for decky.loader"))
        check("...still zero spawns", spawns, [])
        # Cached 30 s: a second verdict does not reconnect.
        cs._decky_helper_verb()
        check("verdict cached: one connection for two calls", real.connections, 1)
    finally:
        H._run = saved_run
        H._DECKY_MARKER, H._DECKY_WRAPPER = saved_marker, saved_wrapper
        real.close()

    # CONTROL: a 1.0.0-shaped table (no decky.loader) answers unknown verb.
    verbs_100 = {k: v for k, v in H.VERBS.items() if k != "decky.loader"}
    saved_verbs = H.VERBS
    H.VERBS = verbs_100
    old = FakeHelper(dispatch=H.dispatch)
    cs.HELPER_SOCKET = old.path
    try:
        cs._decky_invalidate()
        check("1.0.0 table -> 'unknown verb' -> 'outdated'", cs._decky_helper_verb(), "outdated")
        check("...its reply was the unknown-verb refusal",
              old.seen and H.dispatch(old.seen[0]).get("error"), "unknown verb")
    finally:
        H.VERBS = saved_verbs
        old.close()


# ---------------------------------------------------------------------------
print("\n_decky_confirm_started / _decky_op_status — started is READ BACK, never assumed")
# ---------------------------------------------------------------------------

def test_confirm_started_reads_the_unit_not_the_exit_code():
    """`systemctl start --no-block` exits 0 for a condition-skipped unit. With
    NO lock and the real `_unit_props` parser fed by SpyRun: ConditionResult=no
    → needs_optin; ExecMainStatus=75 → busy; a plain failure → did_not_start
    naming the unit. Positive paths: ActiveState=activating → started; the
    flock held by the wrapper → started even when systemctl says nothing."""
    print("test_confirm_started_reads_the_unit_not_the_exit_code")
    reset()
    unit = cs._DECKY_UNITS["install"]
    with SpyRun(show={"ActiveState": "inactive", "ConditionResult": "no",
                      "Result": "success", "ExecMainStatus": "0"}) as spy:
        r = cs._decky_confirm_started(unit, "helper")
        check("ConditionResult=no -> needs_optin", r, {"started": False, "needs_optin": True})
        check("...every spawn was `systemctl show` of the pinned instance",
              all(c[:2] == ["systemctl", "show"] and c[-1] == unit for c in spy.calls)
              and len(spy.calls) > 0, True)
    with SpyRun(show={"ActiveState": "inactive", "ConditionResult": "yes",
                      "Result": "success", "ExecMainStatus": "77"}):
        check("exit 77 (wrapper's not-opted-in) -> needs_optin",
              cs._decky_confirm_started(unit, "sudo"), {"started": False, "needs_optin": True})
    with SpyRun(show={"ActiveState": "failed", "ConditionResult": "yes",
                      "Result": "exit-code", "ExecMainStatus": "75"}):
        r = cs._decky_confirm_started(unit, "sudo")
        check("exit 75 -> busy loader_op",
              (r.get("started"), r.get("busy"), r.get("what")), (False, True, "loader_op"))
    with SpyRun(show={"ActiveState": "failed", "ConditionResult": "yes",
                      "Result": "exit-code", "ExecMainStatus": "4"}):
        r = cs._decky_confirm_started(unit, "helper")
        check("exit 4 -> did_not_start naming unit/result/status",
              (r.get("started"), r.get("did_not_start"),
               unit in r.get("detail", ""), "result=exit-code" in r.get("detail", ""),
               "status=4" in r.get("detail", "")),
              (False, True, True, True, True))
    with SpyRun(show={"ActiveState": "activating"}):
        r = cs._decky_confirm_started(unit, "helper")
        check("activating -> started with the constant log path",
              r, {"started": True, "via": "helper", "log": os.path.join(RUN, "decky-loader.log")})
    with SpyRun() as spy, hold_lock():
        r = cs._decky_confirm_started(unit, "sudo")
        check("flock held (wrapper running) -> started even with systemctl silent",
              (r.get("started"), r.get("via")), (True, "sudo"))


def test_op_status_is_correlated_to_this_request():
    """The stale-result hole: an old `done` on disk + a NEW request reads
    `starting`, never `done`. Then: lock held → running; lock free + `running`
    → interrupted; a result with `at` ≥ the request → its verdict; no request
    in this process → only `interrupted` is reported, never an old verdict."""
    print("test_op_status_is_correlated_to_this_request")
    reset()
    now = int(time.time())
    old_done = {"mode": "install", "state": "done", "ok": True, "tag": "v3.2.8",
                "at": now - 3600}
    write_result(old_done)
    with SpyRun() as spy:
        check("old done, no request in this process -> op None",
              cs._decky_op_status(False, cs._decky_read_result()), None)
        with cs._DECKY_REQ_LOCK:
            cs._DECKY_REQ.update(mode="install", requested_at=time.time(),
                                 unit=cs._DECKY_UNITS["install"], verdict=None)
        op = cs._decky_op_status(False, cs._decky_read_result())
        check("STALE-RESULT CONTROL: old done + new request -> starting, never done",
              (op["state"], op["mode"], op["ok"]), ("starting", "install", None))
        check("...nothing spawned while starting (< 20 s)", spy.calls, [])
        op = cs._decky_op_status(True, cs._decky_read_result())
        check("lock held -> running (the flock outranks the stale file)",
              (op["state"], op["mode"]), ("running", "install"))
        write_result({"mode": "install", "state": "running", "ok": False, "tag": "", "at": now})
        op = cs._decky_op_status(True, cs._decky_read_result())
        check("lock held + fresh running -> running", op["state"], "running")
        op = cs._decky_op_status(False, cs._decky_read_result())
        check("lock free + fresh running -> interrupted, ok:false",
              (op["state"], op["ok"], "without recording" in op["detail"]),
              ("interrupted", False, True))
        for state, ok, tag in (("done", True, "v3.2.8"), ("failed", False, ""),
                               ("refused", False, "")):
            write_result({"mode": "install", "state": state, "ok": ok, "tag": tag, "at": now})
            op = cs._decky_op_status(False, cs._decky_read_result())
            check("fresh %s -> the verdict" % state,
                  (op["state"], op["ok"], op["tag"], op["at"]),
                  (state, ok, tag or None, now))
        # Boundary: floor(requested_at) - 1 counts as fresh (the wrapper's
        # `date +%s` can land one second behind the agent's time.time()).
        req_at = cs._DECKY_REQ["requested_at"]
        write_result({"mode": "install", "state": "done", "ok": True, "tag": "v3.2.8",
                      "at": int(req_at) - 1})
        check("at == floor(request) - 1 is still this request's",
              cs._decky_op_status(False, cs._decky_read_result())["state"], "done")
        write_result({"mode": "install", "state": "done", "ok": True, "tag": "v3.2.8",
                      "at": int(req_at) - 2})
        check("at == floor(request) - 2 is a previous run's -> starting",
              cs._decky_op_status(False, cs._decky_read_result())["state"], "starting")
        # Lock free + an OLD `running` result with no request in this process:
        # the one case reported without a request (SIGKILL before a restart).
        with cs._DECKY_REQ_LOCK:
            cs._DECKY_REQ.update(mode=None, requested_at=0.0, unit=None, verdict=None)
        write_result({"mode": "uninstall", "state": "running", "ok": False, "tag": "",
                      "at": now - 500})
        op = cs._decky_op_status(False, cs._decky_read_result())
        check("no request + stale running + lock free -> interrupted (mode from the file)",
              (op["state"], op["mode"]), ("interrupted", "uninstall"))
        write_result(old_done)
        check("no request + an old verdict -> None (not resurrected as news)",
              cs._decky_op_status(False, cs._decky_read_result()), None)


def test_op_status_after_20s_asks_systemctl_once():
    """Twenty seconds in `starting` with no lock and no fresh result: the unit
    decides — ConditionResult=no / 77 → did_not_start+needs_optin; 75 →
    did_not_start+busy; else did_not_start with the unit's Result; activating →
    still starting. The verdict is MEMOISED so the 2 s poll never re-spawns
    `systemctl show` for a request that never ran."""
    print("test_op_status_after_20s_asks_systemctl_once")
    reset()
    unit = cs._DECKY_UNITS["install"]

    def request(age):
        with cs._DECKY_REQ_LOCK:
            cs._DECKY_REQ.update(mode="install", requested_at=time.time() - age,
                                 unit=unit, verdict=None)

    request(25)
    with SpyRun(show={"ConditionResult": "no", "ExecMainStatus": "0",
                      "Result": "success", "ActiveState": "inactive"}) as spy:
        op = cs._decky_op_status(False, None)
        check("ConditionResult=no -> did_not_start + needs_optin",
              (op["state"], op.get("needs_optin"), op["ok"]), ("did_not_start", True, False))
        check("...one systemctl show, on the pinned instance",
              spy.calls, [["systemctl", "show", "-p", "Result", "-p", "ExecMainStatus",
                           "-p", "ConditionResult", "-p", "ActiveState", unit]])
        op2 = cs._decky_op_status(False, None)
        check("verdict memoised: second poll spawns nothing", len(spy.calls), 1)
        check("...and is the same block", op2 is op, True)
    request(25)
    with SpyRun(show={"ConditionResult": "yes", "ExecMainStatus": "77",
                      "Result": "exit-code", "ActiveState": "failed"}):
        op = cs._decky_op_status(False, None)
        check("exit 77 -> did_not_start + needs_optin", op.get("needs_optin"), True)
    request(25)
    with SpyRun(show={"ConditionResult": "yes", "ExecMainStatus": "75",
                      "Result": "exit-code", "ActiveState": "failed"}):
        op = cs._decky_op_status(False, None)
        check("exit 75 -> did_not_start + busy", (op["state"], op.get("busy")),
              ("did_not_start", True))
    request(25)
    with SpyRun(show={"ConditionResult": "yes", "ExecMainStatus": "5",
                      "Result": "exit-code", "ActiveState": "failed"}):
        op = cs._decky_op_status(False, None)
        check("exit 5 -> did_not_start naming the unit's Result",
              (op["state"], "result=exit-code" in op["detail"], "status=5" in op["detail"]),
              ("did_not_start", True, True))
    request(25)
    with SpyRun(show={"ActiveState": "activating"}) as spy:
        op = cs._decky_op_status(False, None)
        check("still activating after 20 s -> starting (slow download)", op["state"], "starting")
        check("...not memoised as a verdict", cs._DECKY_REQ["verdict"], None)
    request(5)
    with SpyRun() as spy:
        check("5 s in -> starting with no spawn (control)",
              (cs._decky_op_status(False, None)["state"], spy.calls), ("starting", []))
    # A fresh result arriving AFTER a memoised verdict is not shadowed by it:
    # the wrapper eventually ran (queued start) and its verdict wins.
    request(25)
    with SpyRun(show={"ConditionResult": "no", "ExecMainStatus": "0",
                      "Result": "success", "ActiveState": "inactive"}):
        cs._decky_op_status(False, None)
    write_result({"mode": "install", "state": "done", "ok": True, "tag": "v3.2.8",
                  "at": int(time.time())})
    with SpyRun():
        check("a fresh result after a memoised verdict -> the result wins",
              cs._decky_op_status(False, cs._decky_read_result())["state"], "done")


def test_flock_probe_under_contention():
    """The running flag IS the flock. A held lock in another process reads
    `running` on every one of 300 tight probes without an exception (the probe
    is LOCK_SH|LOCK_NB and released at once), and reads idle the moment the
    holder dies; an unheld file and a missing file are idle."""
    print("test_flock_probe_under_contention")
    reset()
    check("no lock file -> idle", cs._decky_op_running(), False)
    with open(LOCK, "w"):
        pass
    check("lock file present but unheld -> idle", cs._decky_op_running(), False)
    with hold_lock():
        probes = [cs._decky_op_running() for _ in range(300)]
        check("300 tight probes against a held lock -> all running",
              (len(probes), all(probes)), (300, True))
        check("_decky_busy -> loader_op", cs._decky_busy(), "loader_op")
        # The probe must not have LEFT a shared lock behind: an exclusive
        # non-blocking flock from a third process fails only because the
        # holder exists, not because of us — proven below after the holder dies.
    t0 = time.monotonic()
    while cs._decky_op_running() and time.monotonic() - t0 < 5:
        time.sleep(0.01)
    check("holder gone -> idle again", cs._decky_op_running(), False)
    # ...and nothing lingers: another process can take it EXCLUSIVELY now.
    r = subprocess.run([sys.executable, "-c",
                        "import fcntl,sys;f=open(sys.argv[1],'a');"
                        "fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB);print('ok')", LOCK],
                       capture_output=True, text=True, timeout=10)
    check("the probe left no shared lock behind", r.stdout.strip(), "ok")
    check("an unreadable lock dir is idle, never 'running' (no fcntl -> idle)",
          cs._decky_op_running(), False)
    with Patch(fcntl=None):
        check("no fcntl module (non-POSIX agent) -> idle", cs._decky_op_running(), False)


# ---------------------------------------------------------------------------
print("\ndetection overlays: stopped_reason, installed_by, unit_pinned, version, channel")
# ---------------------------------------------------------------------------

def test_stopped_reason_from_a_faked_systemctl_show():
    """The loader's OWN `systemctl stop` after a steamwebhelper crash loop
    (main.py do_shutdown) exits Result=success and Restart=always never fires.
    Driving the real `_decky_fast_facts`: inactive + Result=success + exit
    < 60 s ago (per /proc/uptime) → self_stop_recent; the same 5 min ago → null;
    Result=exit-code → null; active → null."""
    print("test_stopped_reason_from_a_faked_systemctl_show")
    reset()
    proc_fixture(start_ticks=100, uptime_s=90_000.0)         # uptime 90 000 s
    exit_recent_us = int((90_000.0 - 30.0) * 1e6)             # 30 s ago
    exit_old_us = int((90_000.0 - 300.0) * 1e6)               # 5 min ago

    def facts(props):
        cs._decky_invalidate()
        with Patch(_unit_props=lambda unit, p: props,
                   _steam_client_running=lambda: False):
            return cs._decky_fast_facts()

    f = facts({"ActiveState": "inactive", "Result": "success",
               "ActiveExitTimestampMonotonic": str(exit_recent_us)})
    check("inactive + success + 30 s ago -> self_stop_recent",
          (f["active"], f["stopped_reason"]), (False, "self_stop_recent"))
    f = facts({"ActiveState": "inactive", "Result": "success",
               "ActiveExitTimestampMonotonic": str(exit_old_us)})
    check("...5 min ago -> null (control)", f["stopped_reason"], None)
    f = facts({"ActiveState": "failed", "Result": "exit-code",
               "ActiveExitTimestampMonotonic": str(exit_recent_us)})
    check("Result=exit-code (a crash) -> null", f["stopped_reason"], None)
    f = facts({"ActiveState": "inactive", "Result": "success",
               "ActiveExitTimestampMonotonic": "0"})
    check("never exited (stamp 0) -> null", f["stopped_reason"], None)
    f = facts({"ActiveState": "inactive", "Result": "success",
               "ActiveExitTimestampMonotonic": "garbage"})
    check("unparsable stamp -> null (degrade closed)", f["stopped_reason"], None)
    f = facts({"ActiveState": "active", "Result": "success",
               "ActiveExitTimestampMonotonic": str(exit_recent_us)})
    check("active -> null, and no listener check needed for the reason",
          (f["active"], f["stopped_reason"]), (True, None))
    os.remove(os.path.join(PROC, "uptime"))
    f = facts({"ActiveState": "inactive", "Result": "success",
               "ActiveExitTimestampMonotonic": str(exit_recent_us)})
    check("/proc/uptime unreadable -> null, never a guessed reason", f["stopped_reason"], None)


def test_installed_by_three_values():
    """install.sh leaves BOTH the CLI and the journal wrapper; a Decky-plugin-only
    install (KI-050) leaves the panel and neither; anything else is unknown.
    `couchside.service` being enabled is deliberately not a signal."""
    print("test_installed_by_three_values")
    reset()
    check("bare tree -> unknown", cs._decky_installed_by(), "unknown")
    os.makedirs(PANEL)
    check("panel folder only -> plugin", cs._decky_installed_by(), "plugin")
    with open(CLI_BIN, "w") as f:
        f.write("#!/bin/sh\n")
    check("panel + CLI but no journal wrapper -> unknown (half an install.sh)",
          cs._decky_installed_by(), "unknown")
    with open(JOURNAL_WRAPPER, "w") as f:
        f.write("#!/bin/sh\n")
    check("CLI + journal wrapper -> install.sh", cs._decky_installed_by(), "install.sh")
    shutil.rmtree(PANEL)
    check("...with or without the panel", cs._decky_installed_by(), "install.sh")
    os.remove(CLI_BIN)
    check("journal wrapper alone -> unknown", cs._decky_installed_by(), "unknown")


def test_unit_pinned_equal_drifted_unreadable():
    """`unit_pinned` compares the LIVE unit byte-for-byte with the copy the
    wrapper installed: equal → true; any drift (Decky's updater rewrote it from
    main) → false; either side unreadable → null, never a guess."""
    print("test_unit_pinned_equal_drifted_unreadable")
    reset()
    check("neither file -> null", cs._decky_unit_pinned(), None)
    text = ("[Unit]\nDescription=SteamDeck Plugin Loader\n[Service]\nUser=root\n"
            "ExecStart=%s/services/PluginLoader\n" % HB)
    os.makedirs(os.path.dirname(PINNED_UNIT))
    with open(PINNED_UNIT, "w") as f:
        f.write(text)
    check("pinned copy without a live unit -> null", cs._decky_unit_pinned(), None)
    with open(UNIT, "w") as f:
        f.write(text)
    check("byte-equal -> true", cs._decky_unit_pinned(), True)
    with open(UNIT, "w") as f:
        f.write(text + "Environment=LOG_LEVEL=DEBUG\n")
    check("one extra line -> false (drifted)", cs._decky_unit_pinned(), False)
    with open(UNIT, "w") as f:
        f.write(text.replace("\n", "\r\n"))
    check("CRLF vs LF -> false (byte-equal means byte-equal)", cs._decky_unit_pinned(), False)
    os.remove(PINNED_UNIT)
    check("pinned copy gone (a Decky-installer box) -> null", cs._decky_unit_pinned(), None)


def test_version_and_channel_are_read_not_trusted():
    """`.loader.version` is 'as recorded' and only a tag-shaped value is shown;
    `branch` from loader.json is the channel only when it is 0|1|2 — an
    unparsable/torn file is null (unknown is never reported as stable)."""
    print("test_version_and_channel_are_read_not_trusted")
    reset()
    check("no version file -> null", cs._decky_recorded_version(), None)
    os.makedirs(SERVICES)
    for raw, want in (("v3.2.8\n", "v3.2.8"), ("3.2.8", "3.2.8"), ("v3.3.0-pre1\n", "v3.3.0-pre1"),
                      ("  v3.2.8  \n", "v3.2.8"), ("latest\n", None), ("v3.2.8; rm -rf /\n", None),
                      ("", None), ("\n", None)):
        with open(VERSION_FILE, "w") as f:
            f.write(raw)
        check("version file %r -> %r" % (raw, want), cs._decky_recorded_version(), want)
    check("no loader.json -> channel null", cs._decky_channel(), None)
    os.makedirs(os.path.dirname(SETTINGS))
    for raw, want in (('{"branch": 0}', 0), ('{"branch": 1}', 1), ('{"branch": 2}', 2),
                      ('{"branch": 3}', None), ('{"branch": true}', None),
                      ('{"branch": "0"}', None), ('{"pluginOrder": []}', None),
                      ('{"branch": 0', None), ('[0]', None), ('', None)):
        with open(SETTINGS, "w") as f:
            f.write(raw)
        check("loader.json %r -> channel %r" % (raw, want), cs._decky_channel(), want)


# ---------------------------------------------------------------------------
print("\n/proc fixtures: listener uid, process start time")
# ---------------------------------------------------------------------------

def test_listener_uid_from_proc_net_tcp():
    """Who owns 127.0.0.1:1337 LISTEN: uid 0 → root; another uid → other; no
    LISTEN row (established only, or a root LISTEN on another port) → None;
    unreadable → None. None/other are never 'root' (degrade closed)."""
    print("test_listener_uid_from_proc_net_tcp")
    reset()
    tcp_fixture("root")
    check("uid 0 LISTEN on 1337 -> root", cs._decky_listener_uid(), "root")
    check("_decky_loader_is_root -> True", cs._decky_loader_is_root(), True)
    tcp_fixture("other")
    check("uid 1000 LISTEN on 1337 -> other", cs._decky_listener_uid(), "other")
    check("_decky_loader_is_root -> False", cs._decky_loader_is_root(), False)
    tcp_fixture("other_with_root_elsewhere")
    check("root LISTEN on another port does not vouch for 1337", cs._decky_listener_uid(), "other")
    tcp_fixture("established")
    check("ESTABLISHED row only (st 01) -> None", cs._decky_listener_uid(), None)
    tcp_fixture("none")
    check("header only -> None", cs._decky_listener_uid(), None)
    os.remove(TCP)
    check("unreadable /proc/net/tcp -> None, never root", cs._decky_listener_uid(), None)
    check("_decky_loader_is_root on unreadable -> False", cs._decky_loader_is_root(), False)


def test_proc_start_epoch_parser():
    """`/proc/<pid>/stat` field 22 (starttime, ticks since boot) + btime →
    epoch. The comm can contain spaces and parentheses, so fields are counted
    from the LAST ')'. Missing pid / btime → None."""
    print("test_proc_start_epoch_parser")
    reset()
    proc_fixture(start_ticks=123_456, comm="steam")
    check("plain comm -> btime + ticks/HZ",
          cs._decky_proc_start_epoch(STEAM_PID), steam_start_epoch(123_456))
    proc_fixture(start_ticks=123_456, comm="steam (bootstrap) x)")
    check("comm with spaces and parens -> the same start",
          cs._decky_proc_start_epoch(STEAM_PID), steam_start_epoch(123_456))
    check("unknown pid -> None", cs._decky_proc_start_epoch(99_999_999), None)
    check("non-numeric pid -> None", cs._decky_proc_start_epoch("4242; id"), None)
    with open(os.path.join(PROC, "stat"), "w") as f:
        f.write("cpu  1 2 3\n")
    check("no btime -> None", cs._decky_proc_start_epoch(STEAM_PID), None)


# ---------------------------------------------------------------------------
print("\nstate precedence + the three-way Steam split (real compute, faked probes)")
# ---------------------------------------------------------------------------

def test_state_precedence_and_three_way_steam_split():
    """Drives the REAL `_decky_compute_state` + `_decky_fast_facts` with: a
    faked `systemctl show`, a faked `pgrep steam` (running or not), the
    /proc/net/tcp fixture, a loopback /auth/token server (counted), a loopback
    :8080/json server in BOTH states, and the /proc/<pid>/stat fixture for the
    flag-mtime-vs-Steam-start rule. Every state in §7's precedence is observed
    to fire AND not fire."""
    print("test_state_precedence_and_three_way_steam_split")
    reset()
    installer_ready()
    optin()
    token = FakeHTTP({"/auth/token": (200, FAKE_TOKEN)})
    cef_shared = FakeHTTP({"/json": (200, CEF_WITH_SHARED)})
    cef_plain = FakeHTTP({"/json": (200, CEF_WITHOUT_SHARED)})
    proc_fixture(start_ticks=500_000)
    steam_started = steam_start_epoch(500_000)
    flag = os.path.join(STEAM, cs._DECKY_CEF_FLAG)

    def state(active=True, steam=True, tcp="root", token_url=None, cef_url=None,
              keep_caches=False):
        """One poll. `token.hits` is cleared first so every assertion on it is
        about THIS poll; `keep_caches` leaves the 10 s CEF memo alone (only the
        whole-state memo and the 2 s facts are dropped) to observe the cache."""
        if keep_caches:
            for c in (cs._DECKY_STATE_CACHE, cs._DECKY_FAST_CACHE):
                c["at"], c["val"] = 0.0, None
        else:
            cs._decky_invalidate()
        del token.hits[:]
        tcp_fixture(tcp)
        cs._DECKY_TOKEN_URL = token_url or token.url("/auth/token")
        cs._DECKY_CEF_URL = cef_url or CLOSED_CEF_URL
        props = {"ActiveState": "active" if active else "inactive",
                 "Result": "success", "ActiveExitTimestampMonotonic": "0"}
        with Patch(_unit_props=lambda unit, p: props,
                   _steam_client_running=lambda: steam,
                   _decky_steam_pid=lambda: STEAM_PID):
            return cs._decky_loader_state()

    try:
        s = state(active=False)
        check("nothing installed -> not_installed", s["state"], "not_installed")
        check("...overlays still reported (allowed, installer_ready)",
              (s["allowed"], s["installer_ready"], s["installed"]), (True, True, False))
        check("...token endpoint never contacted while not installed", token.hits, [])
        with hold_lock():
            check("flock held while not installed -> installing (order note)",
                  state(active=False)["state"], "installing")
            with cs._DECKY_REQ_LOCK:
                cs._DECKY_REQ.update(mode="uninstall", requested_at=time.time(),
                                     unit=cs._DECKY_UNITS["uninstall"], verdict=None)
            s = state(active=False)
            check("flock held + this process asked for uninstall -> uninstalling",
                  (s["state"], s["op"]["state"], s["op"]["mode"]),
                  ("uninstalling", "running", "uninstall"))
        with cs._DECKY_REQ_LOCK:
            cs._DECKY_REQ.update(mode=None, requested_at=0.0, unit=None, verdict=None)

        install_loader()
        s = state(active=False)
        check("installed + unit inactive -> installed_stopped",
              (s["state"], s["installed"], s["active"]), ("installed_stopped", True, False))
        check("...token endpoint not contacted for a stopped loader", token.hits, [])

        s = state(tcp="other")
        check("active but 1337 owned by uid 1000 -> running_untrusted",
              (s["state"], s["loader_is_root"], s["api_reachable"]),
              ("running_untrusted", False, False))
        check("...and the token endpoint was NEVER contacted (refuse to talk to it)",
              token.hits, [])
        s = state(tcp="none")
        check("active but nothing listens on 1337 -> running_unreachable (no listener)",
              (s["state"], s["loader_is_root"]), ("running_unreachable", False))
        check("...token still not contacted without a root listener", token.hits, [])

        s = state(token_url=CLOSED_TOKEN_URL)
        check("root listener, /auth/token refuses -> running_unreachable",
              (s["state"], s["loader_is_root"], s["api_reachable"]),
              ("running_unreachable", True, False))

        s = state(steam=False)
        check("root + token answers + Steam closed -> running_no_steam",
              (s["state"], s["api_reachable"], s["steam_running"]),
              ("running_no_steam", True, False))
        check("...the token endpoint WAS contacted this time (control)",
              token.hits[-1:], ["/auth/token"])
        # Steam-absent CONTROL for the split: flag missing AND CEF refusing must
        # still read running_no_steam — never "Restart Steam" or "Run Repair".
        check("Steam absent + no flag + CEF down -> still running_no_steam (control)",
              state(steam=False)["state"], "running_no_steam")

        s = state()
        check("Steam up, no CEF flag in the resolved root -> installed_cef_flag_missing",
              (s["state"], s["cef_flag_present"]), ("installed_cef_flag_missing", False))

        with open(flag, "w"):
            pass
        os.utime(flag, (steam_started + 600, steam_started + 600))     # flag NEWER than Steam
        s = state(cef_url=cef_plain.url("/json"))
        check("flag newer than Steam's start + no SharedJSContext -> installed_steam_needs_restart",
              (s["state"], s["steam_ui_up"], s["cef_flag_present"]),
              ("installed_steam_needs_restart", False, True))
        s = state(cef_url=CLOSED_CEF_URL)
        check("...same with :8080 refusing outright", s["state"], "installed_steam_needs_restart")

        os.utime(flag, (steam_started - 600, steam_started - 600))     # flag OLDER than Steam
        s = state(cef_url=cef_plain.url("/json"))
        check("flag older than Steam's start + no SharedJSContext -> running, steam_ui_up:false "
              "(cause unknown: no guessed Restart Steam)",
              (s["state"], s["steam_ui_up"]), ("running", False))
        os.utime(flag, (steam_started + 600, steam_started + 600))
        with Patch(_decky_proc_start_epoch=lambda pid: None):
            cs._decky_invalidate()
            s = state(cef_url=cef_plain.url("/json"))
        check("Steam start time unreadable -> running, steam_ui_up:false (degrade closed)",
              (s["state"], s["steam_ui_up"]), ("running", False))

        s = state(cef_url=cef_shared.url("/json"))
        check("SharedJSContext listed -> running, steam_ui_up:true",
              (s["state"], s["steam_ui_up"], s["loader_is_root"], s["api_reachable"],
               s["steam_running"], s["cef_flag_present"]),
              ("running", True, True, True, True, True))
        check("...every field of the §6 table is present",
              sorted(s.keys()), sorted(cs._decky_base_payload().keys()))
        check("...loader_update is null until a check ran", s["loader_update"], None)
        check("...restart_action null when the action is not injected",
              s["restart_action"], None)
        check("...panel missing, installed_by unknown on this tree",
              (s["panel"], s["installed_by"]), ("missing", "unknown"))
        # The :8080 probe is cached 10 s: a second poll does not re-hit it
        # (the 2 s facts and the whole-state memo ARE re-probed here).
        hits = len(cef_shared.hits)
        s = state(cef_url=cef_shared.url("/json"), keep_caches=True)
        check("CEF probe cached across polls (state still running)",
              (len(cef_shared.hits), s["state"], s["steam_ui_up"]), (hits, "running", True))
        check("...while the token endpoint WAS re-probed (2 s cache dropped)",
              token.hits, ["/auth/token"])
        # Overlays ride along once installed.
        with open(VERSION_FILE, "w") as f:
            f.write("v3.2.8\n")
        os.makedirs(os.path.dirname(SETTINGS))
        with open(SETTINGS, "w") as f:
            f.write('{"branch": 1}')
        os.makedirs(PANEL)
        s = state(cef_url=cef_shared.url("/json"))
        check("version / channel / panel overlays",
              (s["version"], s["channel"], s["panel"]), ("v3.2.8", 1, "installed"))
        # Whole-state memo: two calls inside 500 ms share one computation.
        cs._decky_invalidate()
        calls = []
        with Patch(_decky_compute_state=lambda: calls.append(1) or cs._decky_base_payload()):
            cs._decky_loader_state()
            cs._decky_loader_state()
        check("two polls inside the memo window -> one computation", len(calls), 1)
    finally:
        token.close()
        cef_shared.close()
        cef_plain.close()


def test_state_never_raises_and_degrades_closed():
    """A probe that explodes must not take the route down: the payload keeps
    its shape and reads the CLOSED value (not_installed when nothing is
    installed, running_unreachable when something is)."""
    print("test_state_never_raises_and_degrades_closed")
    reset()

    def boom():
        raise RuntimeError("probe exploded")

    with Patch(_decky_slow_facts=boom):
        cs._decky_invalidate()
        s = cs._decky_loader_state()
        check("exploding probe, nothing installed -> not_installed, every §6 field present",
              (s["state"], set(cs._decky_base_payload().keys()) <= set(s.keys())),
              ("not_installed", True))
        check("...the exception is named in an add-only `detail`",
              "probe exploded" in s.get("detail", ""), True)
        install_loader()
        cs._decky_invalidate()
        s = cs._decky_loader_state()
        check("exploding probe, loader installed -> running_unreachable (never running)",
              s["state"], "running_unreachable")


def test_memoisation_two_concurrent_polls_one_probe_set():
    """Six concurrent state calls share ONE probe set (the 2 s poll from a
    phone plus the Utilities row must not stack `systemctl show` spawns); after
    an invalidate the next call probes again (control)."""
    print("test_memoisation_two_concurrent_polls_one_probe_set")
    reset()
    calls = []

    def counting_fast():
        calls.append(1)
        time.sleep(0.2)
        return {"active": False, "stopped_reason": None, "steam_running": False,
                "listener": None, "api_reachable": False, "lock_held": False}

    with Patch(_decky_fast_facts=counting_fast,
               _decky_slow_facts=lambda: {"allowed": False, "installer_ready": False,
                                          "helper": "absent", "elevated": False,
                                          "installed_by": "unknown"}):
        cs._decky_invalidate()
        results = []
        ths = [threading.Thread(target=lambda: results.append(cs._decky_loader_state()))
               for _ in range(6)]
        for t in ths:
            t.start()
        for t in ths:
            t.join()
        check("six concurrent polls -> one probe set", len(calls), 1)
        check("...all six got the same payload", len(results) == 6
              and all(r is results[0] for r in results), True)
        cs._decky_invalidate()
        cs._decky_loader_state()
        check("after invalidate the next poll probes again (control)", len(calls), 2)


# ---------------------------------------------------------------------------
print("\nactions resync + the Utilities row")
# ---------------------------------------------------------------------------

def test_actions_resync_injects_and_pops():
    """After an install `restart-decky` is injected (unit + grant present);
    after an uninstall it is popped — but only when the agent injected it: a
    config-defined action of the same id stays."""
    print("test_actions_resync_injects_and_pops")
    reset()
    saved = (cs.ACTIONS, cs.ACTION_ORDER, cs._DECKY_ACTION_INJECTED)
    real_exists = cs.os.path.exists
    real_unit = "/etc/systemd/system/plugin_loader.service"
    try:
        cs.ACTIONS = {k: dict(v) for k, v in cs.DEFAULT_ACTIONS.items()}
        cs.ACTION_ORDER = list(cs.DEFAULT_ACTION_ORDER)
        cs._DECKY_ACTION_INJECTED = False
        cs.ACTIONS.pop("restart-decky", None)
        # _inject_decky_action checks the LITERAL unit path; answer for it only.
        cs.os.path.exists = lambda p: True if p == real_unit else real_exists(p)
        with Patch(_can_sudo_decky_restart=lambda: False, _decky_loader_installed=lambda: True):
            cs._decky_actions_resync(False)
            check("installed but no restart grant -> NOT injected (dead button)",
                  "restart-decky" in cs.ACTIONS, False)
        with Patch(_can_sudo_decky_restart=lambda: True, _decky_loader_installed=lambda: True):
            cs._decky_actions_resync(False)
            check("installed + grant -> restart-decky injected",
                  ("restart-decky" in cs.ACTIONS, "restart-decky" in cs.ACTION_ORDER,
                   cs._DECKY_ACTION_INJECTED), (True, True, True))
            cs._decky_actions_resync(False)
            check("idempotent: injected once", cs.ACTION_ORDER.count("restart-decky"), 1)
        cs.os.path.exists = real_exists
        with Patch(_decky_loader_installed=lambda: False):
            cs._decky_actions_resync(False)
            check("uninstalled -> restart-decky popped from ACTIONS and ACTION_ORDER",
                  ("restart-decky" in cs.ACTIONS, "restart-decky" in cs.ACTION_ORDER,
                   cs._DECKY_ACTION_INJECTED), (False, False, False))
            cs.ACTIONS["restart-decky"] = {"label": "Restart Decky", "argv": ["true"]}
            cs.ACTION_ORDER.append("restart-decky")
            cs._decky_actions_resync(False)
            check("a config-defined restart-decky is the user's and stays",
                  "restart-decky" in cs.ACTIONS, True)
        # The loader payload names the action only while it exists.
        with Patch(_decky_slow_facts=lambda: {"allowed": False, "installer_ready": False,
                                              "helper": "absent", "elevated": False,
                                              "installed_by": "unknown"},
                   _decky_fast_facts=lambda: {"active": False, "stopped_reason": None,
                                              "steam_running": False, "listener": None,
                                              "api_reachable": False, "lock_held": False}):
            cs._decky_invalidate()
            check("restart_action names it while present",
                  cs._decky_loader_state()["restart_action"], "restart-decky")
            cs.ACTIONS.pop("restart-decky")
            cs._decky_invalidate()
            check("...and is null once gone", cs._decky_loader_state()["restart_action"], None)
    finally:
        cs.os.path.exists = real_exists
        cs.ACTIONS, cs.ACTION_ORDER, cs._DECKY_ACTION_INJECTED = saved


def test_done_transition_refreshes_before_reporting_running():
    """On the op's transition into `done` the fast/CEF caches are dropped so
    `running` is only reported after a FRESH /auth/token answer, and the hook
    fires once per completed op (the poll must not re-resync every 2 s)."""
    print("test_done_transition_refreshes_before_reporting_running")
    reset()
    install_loader()
    fast_calls = []
    resyncs = []

    def fast():
        fast_calls.append(1)
        return {"active": True, "stopped_reason": None, "steam_running": False,
                "listener": "root", "api_reachable": True, "lock_held": False}

    with Patch(_decky_fast_facts=fast, _decky_actions_resync=lambda mock: resyncs.append(mock),
               _decky_slow_facts=lambda: {"allowed": True, "installer_ready": True,
                                          "helper": "present", "elevated": True,
                                          "installed_by": "install.sh"}):
        with cs._DECKY_REQ_LOCK:
            cs._DECKY_REQ.update(mode="install", requested_at=time.time() - 30,
                                 unit=cs._DECKY_UNITS["install"], verdict=None)
        write_result({"mode": "install", "state": "done", "ok": True, "tag": "v3.2.8",
                      "at": int(time.time())})
        cs._decky_invalidate()
        s = cs._decky_loader_state()
        check("fresh done -> op.done and the state is re-probed", s["op"]["state"], "done")
        check("...fast facts probed TWICE (once, then again after the cache drop)",
              len(fast_calls), 2)
        check("...actions resync fired once", resyncs, [False])
        cs._decky_invalidate()
        cs._decky_loader_state()
        check("the next poll does not fire the hook again", resyncs, [False])


def test_no_steam_root_means_no_decky_row():
    """The Utilities row exists only on a Steam box (degrade closed: no client
    ever sees `unsupported`); with a root it carries the loader state."""
    print("test_no_steam_root_means_no_decky_row")
    reset()
    with Patch(_steam_root=lambda: None), SpyRun():
        ids = [r["id"] for r in cs.utilities_state(mock=False)]
        check("no Steam root -> no decky row", "decky" in ids, False)
        check("...the other tenants are unaffected", ids[:2], ["openpuck", "cec"])
    with Patch(_decky_loader_state=lambda: {"state": "installed_stopped"}), SpyRun():
        rows = {r["id"]: r for r in cs.utilities_state(mock=False)}
        check("Steam root -> decky row with the loader state (control)",
              (rows["decky"]["state"], rows["decky"]["label"]),
              ("installed_stopped", cs._UTILITY_META["decky"]["label"]))
    check("decky is in both frozen sets",
          ("decky" in cs._UTILITY_IDS, "decky" in cs._UTILITY_RUN_IDS), (True, True))
    with Patch(_decky_loader_state=lambda: (_ for _ in ()).throw(RuntimeError("x"))):
        check("an exploding state reads running_unreachable in the row (never raises)",
              cs._decky_util_state(False), "running_unreachable")


if __name__ == "__main__":
    for fn in (test_every_phase_a_route_is_bearer_gated,
               test_no_steam_root_hides_the_whole_surface,
               test_run_without_marker_is_403_and_spawns_nothing,
               test_run_op_is_an_enum_and_a_missing_op_is_a_human_string,
               test_run_busy_409_for_both_whats,
               test_run_reports_installer_and_helper_state_over_http,
               test_loader_installed_fixtures_both_ways,
               test_result_parser_accepts_only_the_wrapper_shape,
               test_log_reader_is_a_bounded_tail_at_a_constant_path,
               test_loader_start_takes_only_the_module_enum,
               test_loader_start_refusals_spawn_nothing,
               test_loader_start_helper_present_uses_the_verb_and_not_sudo,
               test_loader_start_outdated_helper_is_final,
               test_loader_start_silent_helper_is_unreachable_not_absent,
               test_loader_start_helper_absent_runs_exactly_the_sudo_argv,
               test_helper_probe_against_the_real_validator,
               test_confirm_started_reads_the_unit_not_the_exit_code,
               test_op_status_is_correlated_to_this_request,
               test_op_status_after_20s_asks_systemctl_once,
               test_flock_probe_under_contention,
               test_stopped_reason_from_a_faked_systemctl_show,
               test_installed_by_three_values,
               test_unit_pinned_equal_drifted_unreadable,
               test_version_and_channel_are_read_not_trusted,
               test_listener_uid_from_proc_net_tcp,
               test_proc_start_epoch_parser,
               test_state_precedence_and_three_way_steam_split,
               test_state_never_raises_and_degrades_closed,
               test_memoisation_two_concurrent_polls_one_probe_set,
               test_actions_resync_injects_and_pops,
               test_done_transition_refreshes_before_reporting_running,
               test_no_steam_root_means_no_decky_row):
        fn()
    shutil.rmtree(FX, ignore_errors=True)
    if FAILURES:
        print("\n%d FAILED: %s" % (len(FAILURES), ", ".join(FAILURES)))
        sys.exit(1)
    print("\nall decky-loader tests passed")
