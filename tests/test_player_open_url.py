#!/usr/bin/env python3
"""Free-URL tier of the Couchside Player (project_media-player.md §5 tier 3).

Run: python3 tests/test_player_open_url.py

Covers the security boundary of "a client makes the box's browser open an
arbitrary page": the agent's urllib validator, the opt-in flag (ships OFF), and
the tile's scheme backstop. No box, no browser — this is the allowlist proof.
"""
import importlib.util
import json
import os
import shutil
import subprocess
import tempfile

BASH = shutil.which("bash") or "/bin/bash"
HERE = os.path.dirname(os.path.abspath(__file__))
AGENT = os.path.join(HERE, "..", "agent", "couchsided.py")
TILE = os.path.join(HERE, "..", "agent", "couchside-player.sh")

spec = importlib.util.spec_from_file_location("couchsided", AGENT)
cs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cs)

PASS = "  \033[32mPASS\033[0m"
FAIL = "  \033[31mFAIL\033[0m"
_fail = []


def check(name, cond, detail=""):
    print("%s %s%s" % (PASS if cond else FAIL, name, "" if cond else "  <- %s" % detail))
    if not cond:
        _fail.append(name)


# --- 1. the agent urllib validator (the primary enforcement) ----------------
ACCEPT = [
    "https://en.wikipedia.org/wiki/Steam_Deck",
    "https://example.com:8443/path?q=1",
    "http://192.168.1.50:32400/web",          # Plex on the LAN over http
    "http://10.0.0.5:8096/",                  # Jellyfin
    "http://plex.local:32400",                # localhost-ish name
    "http://127.0.0.1:8123/",                 # Home Assistant loopback
    "https://sub.domain.co.uk/a/b/c",
]
REJECT = [
    "http://example.com/",                    # plaintext to a PUBLIC host
    "file:///etc/passwd",                     # local file exfiltration
    "javascript:alert(1)",
    "data:text/html,<h1>x",
    "chrome://settings",
    "ftp://example.com/",
    "https://user:pw@evil.com/",              # userinfo in the netloc
    "https://例.jp/",                     # IDN (non-ASCII)
    "https://example.com/ oops",              # whitespace
    "https://example.com:9999/",              # port not in the allowed set
    "https://",                               # no host
    "https://-bad-.com/",                     # edge-hyphenated label
    "https://a..b/",                          # empty label
    "not a url",
    "",
    None,
]
for u in ACCEPT:
    check("accept %r" % u, cs._pl_validate_open_url(u) == u)
for u in REJECT:
    check("reject %r" % u, cs._pl_validate_open_url(u) is None)

# over-length is rejected
check("reject over-length", cs._pl_validate_open_url("https://a.com/" + "x" * 4000) is None)


# --- 2. the opt-in flag (ships OFF; read fresh from config) ------------------
def flag_with(cfg):
    """_pl_custom_url_enabled() against a temp config.json (PL_MOCK off)."""
    saved_mock, saved_path = cs.PL_MOCK, cs.CONFIG_PATH
    cs.PL_MOCK = False
    fd, p = tempfile.mkstemp(suffix=".json")
    try:
        with os.fdopen(fd, "w") as f:
            if cfg is not None:
                f.write(cfg)
        cs.CONFIG_PATH = p
        return cs._pl_custom_url_enabled()
    finally:
        cs.PL_MOCK, cs.CONFIG_PATH = saved_mock, saved_path
        os.unlink(p)


check("flag OFF: empty config", flag_with("{}") is False)
check("flag OFF: absent key", flag_with('{"port":8787}') is False)
check("flag OFF: not exactly true", flag_with('{"player":{"custom_url":"yes"}}') is False)
check("flag OFF: unparseable config", flag_with("{ broken") is False)
check("flag ON: player.custom_url true", flag_with('{"player":{"custom_url":true}}') is True)


# --- 3. the tile scheme backstop (defense-in-depth at the enforcement point) -
def tile(url):
    e = dict(os.environ)
    e.pop("WAYLAND_DISPLAY", None)
    e.pop("DISPLAY", None)
    r = subprocess.run([BASH, TILE, "--print-open-url", url],
                       capture_output=True, text=True, env=e)
    return r.returncode, r.stdout.strip()


rc, out = tile("https://example.com/x")
check("tile accepts https", rc == 0 and out == "https://example.com/x")
rc, _ = tile("http://192.168.1.9:32400/web")
check("tile accepts http-LAN-ish", rc == 0)
for bad in ("file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "chrome://x"):
    rc, _ = tile(bad)
    check("tile rejects %r" % bad, rc != 0)


# --- 4. player_open with a url (mock) validates + echoes it -----------------
saved = cs.PL_MOCK
cs.PL_MOCK = True
try:
    r = cs.player_open(None, "", "", "https://example.com/watch")
    check("player_open(url) mock returns validated url", r.get("url") == "https://example.com/watch")
    try:
        cs.player_open(None, "", "", "file:///etc/passwd")
        check("player_open(bad url) raises", False, "did not raise")
    except ValueError:
        check("player_open(bad url) raises", True)
finally:
    cs.PL_MOCK = saved

print()
if _fail:
    print("FAILED: %d" % len(_fail))
    raise SystemExit(1)
print("all player-open-url checks passed")
