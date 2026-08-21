#!/usr/bin/env python3
"""Graphical-session env discovery for launches: _session_env() and friends.

Run: python3 tests/test_session_env.py

WHY THIS SURFACE EXISTS: the agent is a systemd --user service and inherits
NONE of DISPLAY / WAYLAND_DISPLAY / XAUTHORITY (measured on a SteamOS Game Mode
box: its process environ carried only XDG_RUNTIME_DIR). Every launch runs with
env=_session_env(). The old code hard-guessed DISPLAY=":0"; on a box whose
Steam UI sat on a different display that guess produced Steam's "Unable to open
a connection to X" (kb ref 4050-WOJB-0608) instead of launching the game.

The fix DISCOVERS the real values from a live same-uid session process
(the running Steam, or a desktop shell) via /proc/<pid>/environ, and only
falls back to the old guess when discovery finds nothing.

The healthy hardware box could only prove the ":0"-happens-to-be-right case
(its display really is :0). This pins the case that box could NOT show — a
session on :1 — in both directions, plus the fallbacks and the safety skips:

  1. DISCOVERS a non-:0 display: a donor on :1 -> _session_env DISPLAY == ":1",
     NOT the ":0" guess. (The customer's failing case, now passing.)
  2. FALLS BACK to ":0" when no donor is found (degrades to old behaviour).
  3. INHERITED env always wins: a real DISPLAY in the base env is never
     overridden by discovery.
  4. NEVER INVENTS: a per-game pressure-vessel sandbox XAUTHORITY is skipped
     (it is not valid for a general launch); a real host XAUTHORITY is kept.
  5. PRIORITY: the highest-priority donor that has a DISPLAY wins.
  6. PARSING: the NUL-separated /proc environ blob parses like the kernel's,
     and a non-UTF-8 value is dropped, never crashes.
"""
import importlib.util
import os
import sys

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


def with_session(donor_envs, base=None):
    """Run _session_env() with a fake set of donor processes.

    donor_envs: ordered list of (pid, environ_dict) as _session_donor_pids +
    _read_proc_environ would return them. base: the pre-discovery env
    _user_env() yields (defaults to just XDG_RUNTIME_DIR, i.e. the agent's
    real blind spot). Returns the resolved env dict."""
    saved = (cs._session_donor_pids, cs._read_proc_environ, cs._user_env, cs.os.listdir)
    envmap = {pid: env for pid, env in donor_envs}
    try:
        cs._session_donor_pids = lambda: [pid for pid, _ in donor_envs]
        cs._read_proc_environ = lambda pid: dict(envmap.get(pid, {}))
        cs._user_env = lambda: dict(base if base is not None else {"XDG_RUNTIME_DIR": "/run/user/1000"})
        # neutralise the wayland-socket fallback (no real runtime dir in CI)
        cs.os.listdir = lambda p: (_ for _ in ()).throw(OSError("no dir"))
        return cs._session_env()
    finally:
        (cs._session_donor_pids, cs._read_proc_environ, cs._user_env, cs.os.listdir) = saved


# 1. DISCOVERS a non-:0 display — the customer's failing case, now passing.
env = with_session([(101, {"DISPLAY": ":1"})])
check("discovers DISPLAY :1 from a live donor (not the :0 guess)", env.get("DISPLAY"), ":1")

# 2. FALLS BACK to :0 when nothing is discoverable (old behaviour preserved).
env = with_session([])
check("no donor -> falls back to :0", env.get("DISPLAY"), ":0")
env = with_session([(101, {"HOME": "/home/deck"})])  # donor exists, no DISPLAY
check("donor without DISPLAY -> falls back to :0", env.get("DISPLAY"), ":0")

# 3. INHERITED env wins — discovery never overrides a real inherited value.
env = with_session([(101, {"DISPLAY": ":1"})],
                   base={"XDG_RUNTIME_DIR": "/run/user/1000", "DISPLAY": ":9"})
check("inherited DISPLAY is not overridden by discovery", env.get("DISPLAY"), ":9")

# 4. NEVER INVENTS: pressure-vessel sandbox XAUTHORITY is skipped; host one kept.
env = with_session([(101, {"DISPLAY": ":1",
                           "XAUTHORITY": "/run/pressure-vessel/Xauthority"})])
check("sandbox pressure-vessel XAUTHORITY is skipped", env.get("XAUTHORITY"), None)
check("  (DISPLAY still discovered alongside the skip)", env.get("DISPLAY"), ":1")
env = with_session([(101, {"DISPLAY": ":0", "XAUTHORITY": "/home/deck/.Xauthority"})])
check("host XAUTHORITY is kept", env.get("XAUTHORITY"), "/home/deck/.Xauthority")

# 5. PRIORITY: first donor (highest priority) that has a DISPLAY wins.
env = with_session([(101, {"HOME": "/h"}),          # steam, no DISPLAY
                    (202, {"DISPLAY": ":0"}),        # next donor, has it
                    (303, {"DISPLAY": ":7"})])       # lower — must not win
check("first donor with a DISPLAY wins", env.get("DISPLAY"), ":0")

# 6. PARSING: /proc environ blob semantics, including a bad-UTF-8 value.
blob = b"DISPLAY=:0\x00XAUTHORITY=/home/deck/.Xauthority\x00BAD=\xff\xfe\x00NOEQ\x00"
parsed = cs._parse_environ_blob(blob)
check("parse: DISPLAY", parsed.get("DISPLAY"), ":0")
check("parse: XAUTHORITY", parsed.get("XAUTHORITY"), "/home/deck/.Xauthority")
check("parse: non-UTF-8 value dropped", "BAD" in parsed, False)
check("parse: chunk without '=' ignored", "NOEQ" in parsed, False)

# _harvest_session_env returns only what it found (leaves the rest to fallbacks).
saved = (cs._session_donor_pids, cs._read_proc_environ)
try:
    cs._session_donor_pids = lambda: [1]
    cs._read_proc_environ = lambda pid: {"DISPLAY": ":4", "IRRELEVANT": "x"}
    h = cs._harvest_session_env()
    check("harvest returns only session keys it found", h, {"DISPLAY": ":4"})
finally:
    (cs._session_donor_pids, cs._read_proc_environ) = saved

print()
if FAILURES:
    print("FAILED: %s" % ", ".join(FAILURES))
    sys.exit(1)
print("all session-env discovery tests passed")
