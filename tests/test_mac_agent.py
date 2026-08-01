#!/usr/bin/env python3
"""The macOS agent's first slice: the contract and the refusals.

Run: python3 tests/test_mac_agent.py

Runs anywhere (the probes are patched), but the LIVE numbers it pins were
measured on a real Mac — Mac15,6 / macOS 27.0 — because a first slice that has
only ever run in a test is exactly what this project's rules forbid.

What matters here is the same thing that matters in the siblings:
  * /api/ping is the ONLY pre-auth endpoint; everything else is 401 without
    the token, and 401 for a WRONG token;
  * caps never claim what has not been measured — every unimplemented
    capability is explicitly False, not omitted (omitted reads as "unknown,
    probe me", which is a different claim);
  * unimplemented routes 404 rather than returning a stub, so the app's
    probe-and-appear gating stays truthful.
"""
import importlib.util
import json
import os
import platform
import sys
import threading
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location(
    "couchsided_mac", os.path.join(ROOT, "agent", "mac", "couchsided-mac.py"))
M = importlib.util.module_from_spec(_spec)
sys.modules["couchsided_mac"] = M
_spec.loader.exec_module(M)

FAILURES = []


def check(name, got, want):
    if got == want:
        print("  PASS  %s" % name)
    else:
        print("  FAIL  %s (got %r, want %r)" % (name, got, want))
        FAILURES.append(name)


# --- the payload shape ------------------------------------------------------

print("caps answer EVERY canonical key explicitly (False is a real answer)")
M.set_caps(mock=False)
caps = dict(M.CAPS)
with open(os.path.join(ROOT, "protocol", "protocol.json")) as f:
    canonical = set(json.load(f)["capabilities"]["keys"])
missing = canonical - set(caps)
check("no canonical cap is silently omitted", sorted(missing), [])
check("every value is a real bool",
      all(isinstance(v, bool) for v in caps.values()), True)
# The ones we KNOW macOS cannot do in this slice must be False, not absent.
for k in ("gamepad", "tv", "screen", "couchmode", "desktop", "screensaver",
          "power_schedule", "media"):
    check("%s is explicitly False" % k, caps.get(k), False)

print()
print("the OS line keeps name and version SEPARATE")
# The app joins them; a name that already carried the version is the Nobara
# bug (#331), so pin that macOS cannot regress into it.
#
# Driven from a FIXTURE, not the live command. CI is ubuntu, where sw_vers does
# not exist, so the live read returns no version at all and `"" in "macOS"` is
# True — this block failed in CI on its first run for that reason and for no
# reason involving the agent. A skip would have been the other option and it
# would have tested nothing; the fixture exercises the real parser everywhere.
#
# Verbatim from the Mac this slice was built and measured on (Mac15,6):
#
#   $ sw_vers
#   ProductName:		macOS
#   ProductVersion:		27.0
#   BuildVersion:		26A5368g
_SW_VERS = {"-productVersion": "27.0\n", "-buildVersion": "26A5368g\n"}
_real_run = M._run


def _fixture_run(argv, timeout=5):
    if argv[:1] == ["/usr/bin/sw_vers"] and argv[1:2] and argv[1] in _SW_VERS:
        return 0, _SW_VERS[argv[1]], ""
    return -1, "", ""


M._run = _fixture_run
osi = M.read_os_info()
M._run = _real_run
check("name is bare", osi.get("name"), "macOS")
check("version is parsed off ProductVersion", osi.get("version"), "27.0")
check("build is its own field", osi.get("build"), "26A5368g")
check("name does not contain the version",
      osi.get("version", "") in osi.get("name", ""), False)

# The other state: sw_vers missing or failing. Absent is the honest answer —
# a "version" of "" would render as a trailing space in the Console header.
M._run = lambda argv, timeout=5: (-1, "", "")
osi_none = M.read_os_info()
M._run = _real_run
check("no version key when sw_vers cannot be read", "version" in osi_none, False)
check("no build key either", "build" in osi_none, False)
check("name survives with no probe at all", osi_none.get("name"), "macOS")

# And the live read, where there is one to do.
if platform.system() == "Darwin":
    live = M.read_os_info()
    check("live sw_vers yields a version", bool(live.get("version")), True)
    check("live name stays bare", live.get("name"), "macOS")
    check("live name does not contain the version",
          live.get("version", "") in live.get("name", ""), False)
else:
    print("  SKIP  live sw_vers read (not a Mac) — the fixture above covers the")
    print("        parser; the live path is verified on hardware before release.")

print()
print("status carries the keys the app reads, and no nulls")
st = M.real_status()
for k in ("hostname", "time", "uptime_s", "agent_version", "caps", "os"):
    check("status has %s" % k, k in st, True)
check("no null values anywhere in status",
      any(v is None for v in st.values()), False)
check("agent_version is the -mac train", st["agent_version"].endswith("-mac"), True)

print()
print("memory: reported as the LINUX definition, or omitted")
# Never a bar that says 99% because macOS counts cache as used — see the long
# comment in _mem(). If we cannot compute it honestly we omit it.
mem = st.get("mem")
if mem is not None:
    check("total_mb present", "total_mb" in mem, True)
    if "used_mb" in mem:
        pct = 100 * mem["used_mb"] / mem["total_mb"]
        check("used is a sane fraction, not ~100%", 0 < pct < 95, True)
        check("available_mb sent alongside (Linux parity)",
              "available_mb" in mem, True)
        check("used + available == total (no double counting)",
              mem["used_mb"] + mem["available_mb"], mem["total_mb"])
else:
    print("  SKIP  no mem on this platform (expected off-Mac)")

# --- the auth gate, over a real socket -------------------------------------

print()
print("the auth gate: /api/ping is the ONLY pre-auth endpoint")
M.set_caps(mock=False)
M.Handler.token = "correct-horse"
srv = M.ThreadingHTTPServer(("127.0.0.1", 0), M.Handler)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()


def get(path, token=None):
    r = urllib.request.Request("http://127.0.0.1:%d%s" % (port, path))
    if token:
        r.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(r, timeout=5) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, {}


code, body = get("/api/ping")
check("ping answers WITHOUT a token", code, 200)
check("ping says ok", body.get("ok"), True)
check("ping carries app name", body.get("app"), "couchside-agent")
check("ping carries host", bool(body.get("host")), True)
# The token must never appear in the pre-auth response.
check("ping leaks no token", "correct-horse" in json.dumps(body), False)

code, _ = get("/api/status")
check("status without a token -> 401", code, 401)
code, _ = get("/api/status", token="wrong")
check("status with a WRONG token -> 401", code, 401)
code, _ = get("/api/status", token="correct-horse ")   # trailing space
check("token is stripped, so a padded token still works", code, 200)
code, st2 = get("/api/status", token="correct-horse")
check("status with the token -> 200", code, 200)
check("...and returns caps", "caps" in st2, True)

code, _ = get("/api/not-a-real-route", token="correct-horse")
check("unknown /api route -> 404", code, 404)
code, _ = get("/definitely/not/api", token="correct-horse")
check("non-/api path -> 404", code, 404)

srv.shutdown()

# --- power + media: the frozen tables and the refusals ---------------------

print()
print("power ops are a FROZEN table, looked up not interpolated")
for bad in ("format_disk", "sleep; rm -rf /", "", None, "SLEEP", "reboot"):
    r = M.power_op(bad)
    check("power_op(%r) refused" % (bad,), r["ok"], False)
check("the allowlist is exactly the two measured ops",
      sorted(M._POWER_OPS), ["display_sleep", "sleep"])
check("every argv is a LIST built from our own constants",
      all(isinstance(v, list) and v[0] == M.PMSET for v in M._POWER_OPS.values()),
      True)

print()
print("media: unknown player or op runs nothing")
for pid, op in (("winamp", "play"), ("music", "rm -rf"), ("", ""),
                ("music", "SEEK"), ("spotify", "eval")):
    r = M.media_op(pid, op)
    check("media_op(%r,%r) refused" % (pid, op), r["ok"], False)
check("player table is frozen to what we can actually drive",
      sorted(M._MEDIA_APPS), ["music", "spotify"])
check("op table matches the Linux MPRIS verb set",
      sorted(M._MEDIA_OPS),
      ["next", "pause", "play", "play_pause", "previous", "stop"])

print()
print("the AppleScript cannot use a reserved variable name")
# `st` is reserved in AppleScript: `set st to ...` is a PARSE ERROR (-2741),
# so the read returns nothing and the card silently never appears. Measured on
# macOS 27. Pin it so nobody reintroduces the short name.
# Search the CODE, not the commentary. The agent documents both mistakes in
# prose — once in a # comment and once in a docstring — and a naive grep
# matched its own explanation twice while I narrowed this. ast strips both.
import ast as _ast


def _code_only(path):
    """Source with comments AND docstrings removed."""
    tree = _ast.parse(open(path).read())
    for node in _ast.walk(tree):
        if isinstance(node, (_ast.FunctionDef, _ast.AsyncFunctionDef,
                             _ast.ClassDef, _ast.Module)):
            body = getattr(node, "body", [])
            if (body and isinstance(body[0], _ast.Expr)
                    and isinstance(body[0].value, _ast.Constant)
                    and isinstance(body[0].value.value, str)):
                body.pop(0)
    return _ast.unparse(tree)


src = _code_only(os.path.join(ROOT, "agent", "mac", "couchsided-mac.py"))
check("no `set st to` in the code", "set st to" in src, False)

print()
print("the running-app probe is pgrep, not System Events")
# System Events' `exists process` was NON-DETERMINISTIC on macOS 27 — the same
# call seconds apart on an unchanged running app returned true then false, so
# caps.media disagreed with media_info(). pgrep is stable and needs no
# Automation consent.
check("probe does not shell out to System Events for liveness",
      "exists process" in src, False)
check("probe uses pgrep", "pgrep" in src, True)
# And the docstrings would still hide a regression, so assert the behaviour too:
check("_app_running is deterministic across repeats",
      len({M._app_running("Finder") for _ in range(5)}), 1)

print()
if FAILURES:
    print("FAILED: %s" % ", ".join(FAILURES))
    sys.exit(1)
print("all macOS agent tests passed")
