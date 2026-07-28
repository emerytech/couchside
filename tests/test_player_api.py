#!/usr/bin/env python3
"""Tests for the player routes (GET/POST /api/player) and the `player` cap.

Run: python3 tests/test_player_api.py

Covers what CLAUDE.md §6 requires of a new endpoint that takes a client id:
happy path, auth failure, and a non-allowlisted input proving that NOTHING RAN.

That last one is asserted, not inferred. `steam` and `steamos-add-to-steam` are
replaced with stub executables that append to a log, so "the request was
refused" and "no process was started" are two separate observations. A test that
only checked the status code would pass against an agent that 404s the caller
while still launching the tile.

The allowlist itself is NOT re-implemented here. The agent validates by asking
the tile (`--print-url`), so these tests drive the real tile through the real
route — which is the point of that design: one copy of the table, and the
validator is the code that will actually run.

The cap check covers all five edit sites (agent CAPS dict + mock tuple; app
BoxCaps + normalizeCaps + capsEqual). Miss the app three and the cap never
persists, so the tab re-probes forever — the specific bug CLAUDE.md §4 names.

Pure stdlib, no pytest.
"""
import http.client
import importlib.util
import json
import os
import re
import struct
import tempfile
import threading
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
AGENT = os.path.join(ROOT, "agent", "couchsided.py")
TILE = os.path.join(ROOT, "agent", "couchside-player.sh")
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


def _stub_steam_tools(tmp):
    """Stub `steam` and `steamos-add-to-steam` on PATH, both logging every call.

    steamos-add-to-steam also writes a realistic binary shortcuts.vdf, so a
    happy-path registration genuinely resolves an appid through _pl_appid() and
    goes on to fire steam:// — the whole chain, not a mocked middle.
    """
    binder = os.path.join(tmp, "bin")
    os.makedirs(binder)
    log = os.path.join(tmp, "calls.log")

    cfg = os.path.join(tmp, ".steam", "steam", "userdata", "1234", "config")
    os.makedirs(cfg)
    vdf = os.path.join(cfg, "shortcuts.vdf")
    # The Exe is the path the tile is INSTALLED at in production, not wherever
    # this test happens to read the script from. _pl_appid() anchors on the
    # install directory, which is the whole reason it cannot collide with the
    # screensaver's lookup — so the fixture has to carry that directory or it
    # would be testing a path shape that never ships.
    entry = (b"\x00shortcuts\x00\x00" + b"0\x00"
             + b"\x02appid\x00" + struct.pack("<I", 4242424242)
             + b"\x01AppName\x00Couchside Player\x00"
             + b"\x01Exe\x00\"/home/u/.local/opt/couchside-player/"
             + b"Couchside Player\"\x00"
             + b"\x08\x08")

    with open(os.path.join(binder, "steamos-add-to-steam"), "w") as f:
        f.write("#!/usr/bin/env bash\n"
                "echo \"add-to-steam $*\" >> %s\n"
                "cat %s > %s\n" % (log, os.path.join(tmp, "entry.vdf"), vdf))
    with open(os.path.join(tmp, "entry.vdf"), "wb") as f:
        f.write(entry)
    with open(os.path.join(binder, "steam"), "w") as f:
        f.write("#!/usr/bin/env bash\necho \"steam $*\" >> %s\n" % log)
    for b in ("steam", "steamos-add-to-steam"):
        os.chmod(os.path.join(binder, b), 0o755)
    os.environ["PATH"] = binder + os.pathsep + os.environ["PATH"]
    return log, vdf


def _server():
    """Handler on a random loopback port, with the player module pointed at an
    isolated HOME/conf/pidfile and the REAL tile."""
    tmp = tempfile.mkdtemp(prefix="couchplayer_")
    log, vdf = _stub_steam_tools(tmp)
    os.environ["HOME"] = tmp                 # _pl_appid globs ~/.steam/...
    cs.PLAYER_TILE = TILE
    cs.PLAYER_GRID_ART = os.path.join(ROOT, "agent", "steam-grid")
    cs.PLAYER_CONF = os.path.join(tmp, "player.conf")
    cs.PLAYER_PIDFILE = os.path.join(tmp, "player.pid")
    cs.PL_REGISTER_WAIT_S = 3
    cs.PL_FIRST_LAUNCH_GAP_S = 0
    cs.PL_MOCK = False
    # Stubbing only the cached PROBE result: CI has no Chrome, and the browser
    # probe is not what these tests are about (test_player_tile.py covers
    # degrade-closed). The service list is still read from the real tile.
    cs.set_player(False)
    cs._PLAYER_BROWSER = "flatpak com.google.Chrome"

    cs.Handler.token = TOKEN
    cs.Handler.token_file = None
    cs.Handler.mock = False
    cs.Handler.port = 0
    srv = ThreadingHTTPServer(("127.0.0.1", 0), cs.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1], tmp, log


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


def _calls(log):
    return open(log).read() if os.path.exists(log) else ""


def _settle(pred, timeout=8.0):
    """Wait for the background launch thread. Polls instead of sleeping a fixed
    amount so a slow CI box does not flake."""
    import time
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pred():
            return True
        time.sleep(0.1)
    return False


# ---------------------------------------------------------------------------
print("\nGET /api/player")
# ---------------------------------------------------------------------------
srv, port, tmp, log = _server()
try:
    status, _ = _req(port, "GET", "/api/player", token=None)
    check(status == 401, "no bearer -> 401")
    status, _ = _req(port, "GET", "/api/player", token="wrong")
    check(status == 401, "wrong bearer -> 401")

    status, info = _req(port, "GET", "/api/player")
    check(status == 200, "authed -> 200", status)
    check(info.get("available") is True, "reports available", info)
    check(info.get("running") is False, "reports not running", info)
    services = info.get("services") or []
    check("max" in services and "netflix" in services,
          "services come from the tile, not a second copy in the agent",
          services)
    check("custom" not in services and "" not in services,
          "no catch-all service id is offered", services)
    # The transport fields must be present in BOTH branches of player_info().
    # They were added to the real branch only, and the harness rendered no
    # transport at all until the mock matched — a narrower mock is how a UI gets
    # built against a payload the box never sends.
    for field in ("services", "service_urls", "seek_secs", "picture_steps"):
        check(field in info, "GET carries `%s`" % field, sorted(info))
    check("playback" in info, "GET carries `playback` (may be null)", sorted(info))
    cs.PL_MOCK = True
    try:
        mock_keys = set(cs.player_info())
    finally:
        cs.PL_MOCK = False
    check(mock_keys == set(info),
          "mock and real player_info() return the SAME keys",
          mock_keys.symmetric_difference(info))
finally:
    srv.shutdown()

# Probe-and-appear: a box without the tile must 404, so the app hides the tab.
srv, port, tmp, log = _server()
try:
    cs.PLAYER_TILE = os.path.join(tmp, "not-installed")
    cs.set_player(False)
    status, _ = _req(port, "GET", "/api/player")
    check(status == 404, "tile not installed -> 404 (probe-and-appear)", status)
finally:
    srv.shutdown()

# ---------------------------------------------------------------------------
print("\nPOST /api/player — happy path")
# ---------------------------------------------------------------------------
srv, port, tmp, log = _server()
try:
    status, r = _req(port, "POST", "/api/player",
                     json.dumps({"op": "open", "service": "hulu"}))
    check(status == 200, "open an allowlisted service -> 200", (status, r))
    check(os.path.exists(cs.PLAYER_CONF), "conf written")
    conf = open(cs.PLAYER_CONF).read() if os.path.exists(cs.PLAYER_CONF) else ""
    check("service=hulu" in conf, "conf names the requested service", conf)
    check(_settle(lambda: "add-to-steam" in _calls(log)),
          "fresh tile is registered with steamos-add-to-steam", _calls(log))
    check(_settle(lambda: "steam steam://rungameid/" in _calls(log)),
          "and then launched via rungameid", _calls(log))

    # A deep link on the one service that has a verified pattern.
    status, r = _req(port, "POST", "/api/player", json.dumps(
        {"op": "open", "service": "max",
         "path": "/video/watch/6d3c4b1d-9b3a-4a1e-8c2f-0d1e2f3a4b5c"}))
    check(status == 200, "allowlisted deep link -> 200", (status, r))
    conf = open(cs.PLAYER_CONF).read()
    check("service=max" in conf and "path=/video/watch/" in conf,
          "conf carries the deep-link path", conf)

    status, r = _req(port, "POST", "/api/player", json.dumps({"op": "close"}))
    check(status == 200 and r.get("running") is False, "close -> 200", r)
finally:
    srv.shutdown()

# ---------------------------------------------------------------------------
print("\nPOST /api/player — refusals leave NOTHING written and NOTHING running")
# ---------------------------------------------------------------------------
BAD = [
    ("unknown id", {"op": "open", "service": "evilcorp"}),
    ("empty id", {"op": "open", "service": ""}),
    ("missing id", {"op": "open"}),
    ("non-string id", {"op": "open", "service": 42}),
    ("shell metacharacters", {"op": "open", "service": "hulu; rm -rf /"}),
    ("command substitution", {"op": "open", "service": "$(id)"}),
    ("path traversal id", {"op": "open", "service": "../../etc/passwd"}),
    ("case variant", {"op": "open", "service": "NETFLIX"}),
    ("bad path on a patterned service",
     {"op": "open", "service": "max", "path": "/video/watch/nope"}),
    ("protocol-relative path",
     {"op": "open", "service": "max", "path": "//evil.example.com/x"}),
    ("path on a service with no verified pattern",
     {"op": "open", "service": "netflix", "path": "/watch/12345"}),
    ("non-string path", {"op": "open", "service": "max", "path": 42}),
]
for label, payload in BAD:
    srv, port, tmp, log = _server()
    try:
        status, body = _req(port, "POST", "/api/player", json.dumps(payload))
        ok = (status == 404
              and not os.path.exists(cs.PLAYER_CONF)
              and _calls(log) == "")
        check(ok, "refused: %s" % label,
              "status=%s conf=%s calls=%r" % (
                  status, os.path.exists(cs.PLAYER_CONF), _calls(log)))
        # Do not reflect the rejected value back to the caller. Only meaningful
        # when a non-empty string was actually supplied — an empty/absent id has
        # nothing to echo, and asserting on it would be vacuously true or, for
        # "", vacuously FALSE (every string contains "").
        svc = payload.get("service")
        if isinstance(svc, str) and svc:
            check(svc not in json.dumps(body),
                  "    refusal does not echo the rejected value", body)
    finally:
        srv.shutdown()

srv, port, tmp, log = _server()
try:
    status, _ = _req(port, "POST", "/api/player",
                     json.dumps({"op": "open", "service": "hulu"}), token=None)
    check(status == 401, "unauthenticated open -> 401")
    check(not os.path.exists(cs.PLAYER_CONF) and _calls(log) == "",
          "unauthenticated open wrote nothing and ran nothing", _calls(log))
    status, _ = _req(port, "POST", "/api/player", json.dumps({"op": "nope"}))
    check(status == 400, "unknown op -> 400")
    status, _ = _req(port, "POST", "/api/player", b"not json")
    check(status == 400, "malformed body -> 400")
finally:
    srv.shutdown()

# ---------------------------------------------------------------------------
print("\nthe `player` cap is wired at all five edit sites")
# ---------------------------------------------------------------------------
cs.set_player(True)
cs.set_caps(True)
check(cs.CAPS.get("player") is True, "1/5 agent mock tuple carries `player`")

cs.set_player(False)
cs.PLAYER_TILE = "/nonexistent/tile"
cs.set_player(False)
cs.set_caps(False)
check("player" in cs.CAPS, "2/5 agent CAPS dict carries `player`")
check(cs.CAPS.get("player") is False,
      "    and it is False when the tile is absent (a real answer, not a gap)")

api_src = open(API_TS).read()
settings_src = open(SETTINGS_TS).read()
check(re.search(r"player\?\s*:\s*boolean", api_src) is not None,
      "3/5 app BoxCaps declares `player`")
check("const player = bool('player')" in settings_src
      and re.search(r"return\s*\{[^}]*\bplayer\b", settings_src, re.S) is not None,
      "4/5 app normalizeCaps reads AND returns `player` (persist trap)")
check("a.player === b.player" in api_src,
      "5/5 app capsEqual compares `player`")

print("\n%d checks failed" % len(_fail))
raise SystemExit(1 if _fail else 0)
