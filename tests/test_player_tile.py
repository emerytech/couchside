#!/usr/bin/env python3
"""Tests for the Couchside Player tile (agent/couchside-player.sh).

Run: python3 tests/test_player_tile.py

Three things are locked down here, all of them measured rather than imagined:

1. THE ALLOWLIST. The tile reads a conf file the agent writes from a client
   request, so its service id and deep-link path are untrusted input. An id that
   is not an arm of the frozen case statement must launch NOTHING, and a path
   must clear that service's own pattern or be refused outright. Reject, never
   sanitise (CLAUDE.md §3 rule 6).

2. THE DISPLAY BACKEND. Measured 2026-07-27 on a real box and it is the INVERSE
   between the two sessions: Game Mode hands the tile DISPLAY=:1 with NO
   WAYLAND_DISPLAY, while the desktop spawned from a non-graphical parent has
   Wayland but no xauth cookie. Hardcoding either one kills Chrome with rc=1
   BEFORE it binds the debugging port, which presents as "the player is broken".
   Both directions are asserted, because a selector verified in one direction is
   not verified (CLAUDE.md §11 rule 2).

3. THE _ss_appid ANCHOR COLLISION. The shipped screensaver finds its own Steam
   shortcut by searching shortcuts.vdf for the literal b"couchside/Couchside".
   A player tile installed at ~/.local/opt/couchside/Couchside Player would ALSO
   match that prefix, and whichever entry came first in the file would win —
   silently breaking the screensaver's launch on every box that had both. The
   player is therefore installed under couchside-player/, and this test is the
   regression that keeps it there. It carries a positive control: the same
   parser, on a real screensaver entry, must still find the appid — otherwise
   "returns None" would prove nothing.

Pure stdlib, no pytest — same style as the other agent tests.
"""
import importlib.util
import os
import re
import shutil
import struct
import subprocess
import tempfile

# Resolved before any test clobbers PATH — the degrade-closed test empties PATH
# on purpose, and would otherwise fail to find the interpreter rather than
# testing the tile.
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
    print("%s %s%s" % (PASS if cond else FAIL, name,
                       "" if cond else "  <- %s" % (detail,)))
    if not cond:
        _fail.append(name)


def tile(*args, env=None):
    """Run the tile's debug entry points. Returns (rc, stdout)."""
    e = dict(os.environ)
    e.pop("WAYLAND_DISPLAY", None)
    e.pop("DISPLAY", None)
    if env:
        e.update(env)
    p = subprocess.run([BASH, TILE, *args], capture_output=True, text=True,
                       env=e, timeout=30)
    return p.returncode, p.stdout.strip()


# ---------------------------------------------------------------------------
print("\nallowlist — known services resolve, unknown ids launch nothing")
# ---------------------------------------------------------------------------
rc, out = tile("--list-services")
services = out.split()
check("service list is non-empty", rc == 0 and len(services) >= 10, out)

bad_hosts = []
for svc in services:
    rc, url = tile("--print-url", svc)
    if rc != 0 or not url.startswith("https://"):
        bad_hosts.append((svc, rc, url))
check("every allowlisted service yields an https URL", not bad_hosts, bad_hosts)

# The ids below are the shapes an attacker would actually try: shell
# metacharacters, traversal, and a near-miss on a real id.
refused = []
for evil in ("", "netflix; rm -rf /", "$(id)", "`id`", "../../etc/passwd",
             "netflix/../evil", "NETFLIX", "netflix ", "custom",
             "http://evil.example.com", "file:///etc/passwd", "-h"):
    rc, out = tile("--print-url", evil)
    if rc == 0:
        refused.append((evil, out))
check("non-allowlisted service ids are refused, nothing emitted",
      not refused, refused)

# ---------------------------------------------------------------------------
print("\ndeep-link paths — pattern or nothing")
# ---------------------------------------------------------------------------
rc, out = tile("--print-url", "max", "/video/watch/6d3c4b1d-9b3a-4a1e-8c2f-0d1e2f3a4b5c")
check("max accepts the one observed deep-link shape",
      rc == 0 and out.startswith("https://play.max.com/video/watch/"), out)

bad_paths = []
for path in ("/video/watch/not-a-uuid", "/video/watch/", "/../../etc/passwd",
             "//evil.example.com/x", "/video/watch/6d3c4b1d-9b3a-4a1e-8c2f-0d1e2f3a4b5c/../..",
             "/video/watch/6d3c4b1d 9b3a", "video/watch/x",
             "/video/watch/6d3c4b1d-9b3a-4a1e-8c2f-0d1e2f3a4b5c\\x",
             "https://evil.example.com"):
    rc, out = tile("--print-url", "max", path)
    if rc == 0:
        bad_paths.append((path, out))
check("malformed deep-link paths are refused", not bad_paths, bad_paths)

# Degrade closed: a service with no verified pattern must not accept ANY path,
# so an unverified guess can never become a live deep link.
no_pattern = []
for svc in ("netflix", "hulu", "disneyplus", "youtube"):
    rc, out = tile("--print-url", svc, "/watch/12345")
    if rc == 0:
        no_pattern.append((svc, out))
check("services without a verified pattern reject every path",
      not no_pattern, no_pattern)

# ...but they still open their home page, i.e. the refusal is scoped to paths.
rc, out = tile("--print-url", "netflix")
check("a service with no pattern still opens its home page",
      rc == 0 and out == "https://www.netflix.com/", out)

# ---------------------------------------------------------------------------
print("\ndisplay backend — both directions, because one is not a measurement")
# ---------------------------------------------------------------------------
rc, out = tile("--print-ozone", env={"WAYLAND_DISPLAY": "wayland-0"})
check("wayland session -> --ozone-platform=wayland",
      out == "--ozone-platform=wayland", out)

rc, out = tile("--print-ozone", env={"DISPLAY": ":1"})
check("gamescope/X11 session (DISPLAY only) -> --ozone-platform=x11",
      out == "--ozone-platform=x11", out)

rc, out = tile("--print-ozone", env={"WAYLAND_DISPLAY": "wayland-0",
                                     "DISPLAY": ":1"})
check("both set -> wayland wins", out == "--ozone-platform=wayland", out)

rc, out = tile("--print-ozone")
check("headless (neither set) -> no flag, let Chrome decide", out == "", out)

src = open(TILE).read()
check("the tile sheds Steam's runtime LD_* env",
      "unset LD_LIBRARY_PATH LD_PRELOAD" in src)
check("CDP is bound to loopback only, never a LAN interface",
      "--remote-debugging-address" not in src)
# Check CODE, not prose: the tile's comments legitimately mention CDP's
# Runtime.evaluate, and a naive substring match on "eval" flags that instead of
# a real shell eval.
code = [ln for ln in src.splitlines() if not ln.lstrip().startswith("#")]
check("no shell eval: the URL is never re-parsed as shell",
      not [ln for ln in code if re.search(r"\beval\b", ln)],
      [ln for ln in code if re.search(r"\beval\b", ln)])

# ---------------------------------------------------------------------------
print("\n_ss_appid anchor — the player must not hijack the screensaver's lookup")
# ---------------------------------------------------------------------------
def vdf_with(exe_path, appid):
    """A minimal shortcuts.vdf fragment shaped like the real one: the appid
    field precedes the exe/appname block of the same entry."""
    return (b"\x00shortcuts\x00\x00" + b"0\x00"
            + b"\x02appid\x00" + struct.pack("<I", appid)
            + b"\x01AppName\x00Some Tile\x00"
            + b"\x01Exe\x00\"" + exe_path.encode() + b"\"\x00"
            + b"\x08\x08")


def appid_from(entries):
    """Run the SHIPPED _ss_appid() against a synthetic Steam userdata tree."""
    tmp = tempfile.mkdtemp()
    cfg = os.path.join(tmp, ".steam", "steam", "userdata", "1234", "config")
    os.makedirs(cfg)
    with open(os.path.join(cfg, "shortcuts.vdf"), "wb") as f:
        for exe, aid in entries:
            f.write(vdf_with(exe, aid))
    old = os.environ.get("HOME")
    os.environ["HOME"] = tmp
    try:
        return cs._ss_appid()
    finally:
        if old is not None:
            os.environ["HOME"] = old


PLAYER_EXE = "/home/u/.local/opt/couchside-player/Couchside Player"
SAVER_EXE = "/home/u/.local/opt/couchside/Couchside Screensaver"

# POSITIVE CONTROL: the parser must still find a real screensaver entry.
# Without this, "the player is not matched" would be indistinguishable from
# "the parser is broken and matches nothing".
check("control: a real screensaver entry is still found",
      appid_from([(SAVER_EXE, 111222333)]) == 111222333,
      appid_from([(SAVER_EXE, 111222333)]))

check("a player-only library does NOT resolve as the screensaver",
      appid_from([(PLAYER_EXE, 999888777)]) is None,
      appid_from([(PLAYER_EXE, 999888777)]))

# The ordering case that would actually bite: player registered FIRST.
both = appid_from([(PLAYER_EXE, 999888777), (SAVER_EXE, 111222333)])
check("with both installed, the screensaver still finds ITS own appid",
      both == 111222333, both)

check("the player install dir cannot contain the screensaver's anchor",
      b"couchside/Couchside" not in PLAYER_EXE.encode())

# ---------------------------------------------------------------------------
print("\ndegrade closed — no Widevine browser means no launch")
# ---------------------------------------------------------------------------
# CI has no Chrome, which is exactly the condition being asserted: the tile must
# report unavailable and exit non-zero rather than launching something that
# would render a black rectangle where the film should be.
rc, out = tile("--print-browser", env={"PATH": tempfile.mkdtemp()})
check("no Widevine-capable browser -> unavailable, non-zero exit",
      rc != 0 and out == "unavailable", "rc=%s out=%r" % (rc, out))

# ---------------------------------------------------------------------------
print("\nde-Google — the Player finds a non-Chrome Chromium browser (owner + review 2026-08-30)")
# ---------------------------------------------------------------------------
# The tile drives any Chromium-family browser over CDP, so it must not REQUIRE
# Google Chrome. These mock a flatpak world: `flatpak info <id>` succeeds for the
# "installed" set, and a fake libwidevinecdm.so sits in a per-user flatpak tree
# we own (XDG_DATA_HOME) for the "has-CDM" set. That exercises the real
# resolve_browser() allowlist walk + Widevine gate without a browser present.
def _fake_browser_env(installed, cdm_for):
    d = tempfile.mkdtemp()
    bindir = os.path.join(d, "bin"); os.makedirs(bindir)
    fp = os.path.join(bindir, "flatpak")
    with open(fp, "w") as f:
        f.write('#!/bin/sh\n'
                'if [ "$1" = info ]; then\n'
                '  for i in %s; do [ "$2" = "$i" ] && exit 0; done\n'
                '  exit 1\n'
                'fi\nexit 0\n' % " ".join(installed))
    os.chmod(fp, 0o755)
    xdg = os.path.join(d, "data")
    for i in cdm_for:
        cdmdir = os.path.join(xdg, "flatpak", "app", i, "cur", "files", "lib")
        os.makedirs(cdmdir)
        open(os.path.join(cdmdir, "libwidevinecdm.so"), "w").close()
    return {"PATH": bindir + os.pathsep + os.environ.get("PATH", ""),
            "XDG_DATA_HOME": xdg}

# A de-Googled box — Brave, no Chrome — is now supported instead of dead.
rc, out = tile("--print-browser",
               env=_fake_browser_env(["com.brave.Browser"], ["com.brave.Browser"]))
check("Brave with no Chrome resolves as the player browser",
      rc == 0 and out == "flatpak com.brave.Browser", "rc=%s out=%r" % (rc, out))

# A second non-Google option resolves too (allowlist walk, not a Chrome special-case).
rc, out = tile("--print-browser",
               env=_fake_browser_env(["com.vivaldi.Vivaldi"], ["com.vivaldi.Vivaldi"]))
check("Vivaldi resolves as the player browser",
      rc == 0 and out == "flatpak com.vivaldi.Vivaldi", "rc=%s out=%r" % (rc, out))

# BACKWARD COMPAT: with BOTH Chrome and Brave present, Chrome still wins, so an
# existing install keeps its same profile and streaming logins across the update.
rc, out = tile("--print-browser",
               env=_fake_browser_env(["com.google.Chrome", "com.brave.Browser"],
                                     ["com.google.Chrome", "com.brave.Browser"]))
check("Chrome still preferred when present (no regression for existing boxes)",
      rc == 0 and out == "flatpak com.google.Chrome", "rc=%s out=%r" % (rc, out))

# The Widevine gate still holds for the NEW browsers: installed but no CDM must
# degrade closed, not launch a browser that renders a black rectangle.
rc, out = tile("--print-browser",
               env=_fake_browser_env(["com.brave.Browser"], []))
check("a de-Googled browser with no Widevine CDM is refused (degrade closed)",
      rc != 0 and out == "unavailable", "rc=%s out=%r" % (rc, out))

# ---------------------------------------------------------------------------
# NOTE: this file's check() is check(NAME, COND, detail) — the other two
# player suites are check(COND, LABEL, detail). Getting it backwards here
# puts the label in the cond slot, where a non-empty string is always
# truthy, so every check PASSES unconditionally. That happened once.
print("\nsearch — free text, so structure is rejected and the rest is encoded")
# ---------------------------------------------------------------------------
rc, out = tile("--list-searchable")
searchable = out.split()
check("some services are searchable", rc == 0 and bool(searchable), out)
# Searchable must be a SUBSET of the services the box can open: a service you
# can search but not open would be a dead end.
rc, all_out = tile("--list-services")
check("every searchable service is also an openable one",
      set(searchable) <= set(all_out.split()), searchable)

rc, url = tile("--print-search", "youtube", "The Bear")
check("a plain query builds the service's own search url",
      rc == 0 and url.startswith("https://www.youtube.com/results?search_query=")
      and url.endswith("The%20Bear"), url)

# UTF-8 must survive. An earlier encoder rejected every non-ASCII title (the
# [:print:] class excludes bytes >= 0x80 under LC_ALL=C), and the one after it
# sign-extended them into %FFFFFFFFFFFFFFC3. Both are caught by round-tripping.
import urllib.parse
for text in ("Amelie", "Am\u00e9lie", "\u5343\u3068\u5343\u5c0b",
             "rick & morty", "a+b", "100% cotton"):
    rc, url = tile("--print-search", "youtube", text)
    if rc != 0:
        check("search accepts %r" % text, False, "refused")
        continue
    decoded = urllib.parse.unquote(url.split("search_query=", 1)[1])
    check("%r round-trips through the encoder" % text, decoded == text, decoded)

# Structure must be refused, not cleaned up.
# No NUL case: it cannot traverse argv at all (execve rejects it), which is
# also why it can never reach the tile in production — the agent passes the
# query as an argv element, never through a shell.
bad_queries = ["", "   ", "a" * 81, "a\nb", "a\tb", "a\x7fb", "a\x1bb"]
refused_q = []
for q in bad_queries:
    rc, out = tile("--print-search", "youtube", q)
    if rc == 0:
        refused_q.append((q, out))
check("empty / over-long / control-byte queries are refused",
      not refused_q, refused_q)

# Nothing a query contains may change the URL's STRUCTURE.
structural = []
for q in ("a&b=c", "x#frag", "../../etc/passwd", "a?b", "a/b",
          "\" onmouseover=1", "javascript:alert(1)"):
    rc, url = tile("--print-search", "youtube", q)
    if rc != 0:
        continue
    value = url.split("search_query=", 1)[1]
    if any(ch in value for ch in "&#?/:\"'<>"):
        structural.append((q, url))
check("no query can inject a second parameter, a fragment, or a path",
      not structural, structural)

# A service with no VERIFIED search url cannot be searched at all.
unsearchable = []
for svc in set(all_out.split()) - set(searchable):
    rc, out = tile("--print-search", svc, "anything")
    if rc == 0:
        unsearchable.append((svc, out))
check("services without a verified search url refuse every query",
      not unsearchable, unsearchable)
rc, out = tile("--print-search", "evilcorp", "x")
check("an unknown service cannot be searched either", rc != 0, out)

# Alias hosts: measured on a live box, play.max.com redirects to
# play.hbomax.com and shared Max links use the latter, so matching only the
# canonical host rejected the ONE service whose deep-link pattern is verified.
rc, hosts = tile("--print-hosts", "max")
check("max declares its alias host", rc == 0 and "play.hbomax.com" in hosts, hosts)
rc, out = tile("--print-hosts", "netflix")
check("a service with no aliases says so rather than inventing one", rc != 0, out)

print("\n%d checks failed" % len(_fail))
raise SystemExit(1 if _fail else 0)
