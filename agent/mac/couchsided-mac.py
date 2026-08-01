#!/usr/bin/env python3
"""Couchside macOS agent — FIRST SLICE (alpha).

The third sibling of agent/couchsided.py (Linux) and agent/win/couchsided-win.py
(Windows). Same wire contract on purpose: HTTP + one bearer token, LAN only, an
`/api/ping` that is the ONLY pre-auth endpoint, and `/api/status` shaped exactly
like the other two so the app needs no protocol change — only caps gating, which
it already does.

SCOPE OF THIS FILE, deliberately small (docs/memory/project_* roadmap entry):
pairing surface + /api/ping + /api/status with HONEST caps. Nothing that has not
run on a real Mac is reported as available. Power, media and the rest come in
later slices, each measured before it is claimed.

WHY HOMEBREW AND NOT THE APP STORE — this is structural, not a preference. The
agent is a background daemon that (eventually) synthesises input, reads the
screen and sleeps the machine. App Store distribution requires sandboxing, which
forbids all three; a sandboxed build could not do the product. A Homebrew tap
plus a `launchd` LaunchAgent is the macOS analogue of install.sh + systemd. The
same reasoning already ruled out Flathub for Linux.

WHAT MACOS TAKES AWAY, and why the caps here are mostly False:
  * NO uinput. A real virtual gamepad needs a DriverKit system extension with an
    Apple entitlement — its own project. `gamepad` is False and the app's Pad tab
    gates off, exactly as it does for a server box.
  * TCC. Screen capture needs Screen Recording consent and input synthesis needs
    Accessibility consent. Both are per-binary, granted by hand in System
    Settings, and revoked on update. A cap must therefore report what we have
    been GRANTED, never merely what the OS supports — see _tcc_screen_ok().

Pure python3 stdlib, like the other two. macOS ships python3 with the Command
Line Tools; the tap declares it.
"""
import argparse
import hmac
import json
import os
import platform
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

APP_NAME = "couchside-agent"
VERSION = "0.1.0-mac"

DEFAULT_PORT = 8787
STARTED_AT = time.time()

# Capability snapshot, filled once by set_caps() and served from /api/status —
# same shape and lifecycle as the Linux/Windows agents.
CAPS = {}


# --------------------------------------------------------------------------
# Probes. Every one answers "can this box ACTUALLY do it right now", and every
# one degrades CLOSED: an error, a missing binary or a refused permission is
# False, never True. A cap that lies produces a dead control in the app, which
# this project has already paid for once (KI-047).
# --------------------------------------------------------------------------

def _run(argv, timeout=5):
    """argv LIST only, never a shell string — the same rule as the siblings."""
    try:
        p = subprocess.run(argv, capture_output=True, timeout=timeout)
        return p.returncode, p.stdout.decode("utf-8", "replace"), \
            p.stderr.decode("utf-8", "replace")
    except (OSError, subprocess.SubprocessError):
        return -1, "", ""


def _which(name):
    for d in os.environ.get("PATH", "").split(os.pathsep):
        p = os.path.join(d, name)
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    for d in ("/usr/bin", "/usr/sbin", "/bin", "/sbin", "/opt/homebrew/bin"):
        p = os.path.join(d, name)
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return None


def _tcc_screen_ok():
    """Do we HAVE Screen Recording consent — not "does macOS support capture".

    Deliberately conservative for this first slice: TCC state cannot be read
    reliably without private API, and a wrong TRUE here is exactly the dead
    control the caps discipline exists to prevent. Capture ships in a later
    slice together with a real consent flow, so this reports False and the
    app hides the preview card.
    """
    return False


def _mac_model():
    """e.g. "MacBookPro18,3" — the closest thing to the Linux DMI model."""
    rc, out, _ = _run(["/usr/sbin/sysctl", "-n", "hw.model"])
    return out.strip() if rc == 0 and out.strip() else None


def set_caps(mock=False):
    """Snapshot what this Mac can do. Called once at startup.

    EVERY key in the canonical vocabulary (protocol/protocol.json) is answered
    explicitly — False is a real answer and means "this box cannot", which the
    app renders as an absent card rather than a broken one. Keys omitted
    entirely would read as "unknown, probe me", which is a different and wrong
    claim on a platform where we KNOW the answer.
    """
    global CAPS
    if mock:
        CAPS = {"gamepad": True, "steam": True, "media": True, "tv": True,
                "screen": True, "power_schedule": True, "screensaver": True,
                "couchmode": True, "desktop": True}
        return
    CAPS = {
        # No uinput on macOS; a virtual pad needs a DriverKit extension.
        "gamepad": False,
        # Steam.app being installed is a fact we can check honestly. It gates
        # the Launch tab, which reads the library — later slice, but the cap
        # itself is true today and costs nothing to report.
        "steam": os.path.isdir("/Applications/Steam.app"),
        # No MPRIS equivalent on macOS. MediaRemote is a PRIVATE framework and
        # this agent is pure stdlib, so it cannot link it — that is a language
        # limit, not a privilege one, and no amount of root changes it. What we
        # CAN do with stdlib is talk to the players that publish an AppleScript
        # dictionary (Music, Spotify) via osascript. So `media` means "a player
        # we can actually drive is running", checked live, never "macOS has
        # media somewhere".
        "media": bool(_media_players()),
        # No TV backend on a Mac (no CEC, no RS-232 panel wiring).
        "tv": False,
        # Needs Screen Recording consent — see _tcc_screen_ok().
        "screen": _tcc_screen_ok(),
        # `pmset schedule` needs root — MEASURED: as the console user it
        # answers "This operation must be run as root". The macOS installer is
        # its own structure and may grant that (a LaunchDaemon or a narrow
        # sudoers entry, same shape as the Linux agent's), so this reports what
        # THIS process can actually do right now rather than what the platform
        # could do with privileges it has not been given.
        "power_schedule": _pmset_schedule_ok(),
        # Steam-shortcut screensaver is a gamescope-era Linux feature.
        "screensaver": False,
        # No gamescope session to switch into, and no Big Picture tier yet
        # (the roadmap says MEASURE the steam:// URLs on macOS rather than
        # assuming the Linux behaviour ports — Windows already proved the same
        # URLs behave differently per platform).
        "couchmode": False,
        "desktop": False,
    }


# --------------------------------------------------------------------------
# Power. Everything here is a FIXED argv built from a frozen table — the client
# picks a key, never a command. Sleeping the box is the one action a phone
# genuinely needs from across the room, and it works unprivileged.
# --------------------------------------------------------------------------

PMSET = "/usr/bin/pmset"
CAFFEINATE = "/usr/bin/caffeinate"

# Frozen: op -> argv. Adding a power action means adding an entry, never
# widening a pattern (CLAUDE.md §3.3).
_POWER_OPS = {
    "sleep": [PMSET, "sleepnow"],
    "display_sleep": [PMSET, "displaysleepnow"],
}

# The keep-awake process, when we started one. macOS has no "disable sleep"
# setting we should be writing; `caffeinate` holding an assertion is the
# supported way, and it dies with us — which is the right failure mode for a
# phone-driven toggle (agent restarts => the box can sleep again).
_CAFFEINATE_PROC = None
_CAFFEINATE_LOCK = threading.Lock()


def _pmset_schedule_ok():
    """Can we ACTUALLY schedule a wake — i.e. do we have root?

    Asks pmset to list the schedule, which is readable, then checks euid: the
    write path is what needs root and probing it for real would leave a
    scheduled wake behind. Degrades closed.
    """
    if not os.path.isfile(PMSET):
        return False
    return os.geteuid() == 0


def power_op(op):
    """Run one allowlisted power action. ActionResult shape, like the siblings."""
    start = time.monotonic()
    argv = _POWER_OPS.get(op)          # looked up, never interpolated
    if argv is None:
        return {"ok": False, "exit_code": 1, "stdout": "",
                "stderr": "unknown power op", "duration_ms": 0}
    rc, out, err = _run(argv, timeout=10)
    return {"ok": rc == 0, "exit_code": rc, "stdout": out.strip(),
            "stderr": err.strip(),
            "duration_ms": int((time.monotonic() - start) * 1000)}


def keep_awake_state():
    with _CAFFEINATE_LOCK:
        p = _CAFFEINATE_PROC
        return bool(p is not None and p.poll() is None)


def keep_awake_set(on):
    """Hold or release a caffeinate assertion. Idempotent both ways.

    -d (display) and -i (idle) together are what "keep this box awake for the
    couch" means; without -d the screen still blanks mid-film.
    """
    global _CAFFEINATE_PROC
    start = time.monotonic()
    with _CAFFEINATE_LOCK:
        running = _CAFFEINATE_PROC is not None and _CAFFEINATE_PROC.poll() is None
        try:
            if on and not running:
                _CAFFEINATE_PROC = subprocess.Popen(
                    [CAFFEINATE, "-d", "-i"],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            elif not on and running:
                _CAFFEINATE_PROC.terminate()
                try:
                    _CAFFEINATE_PROC.wait(timeout=5)
                except subprocess.SubprocessError:
                    _CAFFEINATE_PROC.kill()
                _CAFFEINATE_PROC = None
        except (OSError, subprocess.SubprocessError) as e:
            return {"ok": False, "exit_code": -1, "stdout": "",
                    "stderr": "caffeinate: %s" % e,
                    "duration_ms": int((time.monotonic() - start) * 1000)}
        now = _CAFFEINATE_PROC is not None and _CAFFEINATE_PROC.poll() is None
    return {"ok": now == bool(on), "exit_code": 0, "stdout": "on" if now else "off",
            "stderr": "", "duration_ms": int((time.monotonic() - start) * 1000)}


# --------------------------------------------------------------------------
# Media. Per-app AppleScript, because macOS has no MPRIS and MediaRemote is a
# private framework a stdlib agent cannot link.
#
# The payload matches the Linux agent's /api/media shape exactly
# ({"available":true,"players":[...]}, each player with id/identity/status/
# title/artist/album/position_ms/length_ms/can_*), so the app's Now Playing
# card needs no macOS branch.
# --------------------------------------------------------------------------

OSASCRIPT = "/usr/bin/osascript"

# Frozen table: player id -> (app name, bundle-ish label). Adding a player is
# adding an entry. The app NAME is ours, never client input, and it is the only
# thing interpolated into the AppleScript we run.
_MEDIA_APPS = {
    "music": ("Music", "Apple Music"),
    "spotify": ("Spotify", "Spotify"),
}

# op -> the AppleScript verb. Same closed-set discipline as MPRIS_METHODS.
_MEDIA_OPS = {
    "play": "play", "pause": "pause", "play_pause": "playpause",
    "next": "next track", "previous": "previous track", "stop": "stop",
}


def _app_running(app_name):
    """Is this app running? Checked WITHOUT launching it — `tell application X`
    would START the app, which is the opposite of a probe.

    pgrep, NOT System Events. The first version asked System Events for
    `exists process "Music"` and was NON-DETERMINISTIC on macOS 27: the same
    call, seconds apart against an unchanged running Music, returned true then
    false, so caps.media disagreed with media_info() and a transport op
    reported "not running" for a player it had just listed. A flaky probe is
    worse than a broken one — it ships as "the card sometimes appears".
    pgrep needs no Automation consent, no AppleScript round trip, and gives the
    same answer every time.
    """
    rc, out, _ = _run(["/usr/bin/pgrep", "-x", app_name], timeout=3)
    return rc == 0 and bool(out.strip())


def _media_players():
    """Running players we can drive. Empty list is a real answer: no player,
    no Now Playing card."""
    return [pid for pid, (app, _label) in _MEDIA_APPS.items()
            if _app_running(app)]


def _media_player_info(pid):
    app, label = _MEDIA_APPS[pid]
    # ONE -e PER LINE, and NOT a variable called `st`.
    #
    # `st` is a reserved token in AppleScript — `set st to ...` fails with
    # "Expected expression but found st" (-2741), which is a parse error, so
    # the whole read returns nothing and the card silently never appears.
    # Measured on macOS 27: renaming the variable is the entire fix, and the
    # first diagnosis (embedded newlines being flattened) was WRONG — both the
    # one-string and the -e-per-line forms failed identically until the rename.
    # The -e-per-line form is kept anyway as the documented shape.
    #
    # Tab-separated so a title containing a comma cannot shift the fields.
    lines = [
        'tell application "%s"' % app,
        'set pstate to (player state as text)',
        'if pstate is "stopped" then return pstate',
        'return pstate & tab & (name of current track) & tab & '
        '(artist of current track) & tab & (album of current track) & tab & '
        '((duration of current track) as text) & tab & '
        '((player position) as text)',
        'end tell',
    ]
    argv = [OSASCRIPT]
    for ln in lines:
        argv += ["-e", ln]
    rc, out, _ = _run(argv, timeout=6)
    if rc != 0:
        # TCC Automation consent not granted, or the app refused. Degrade
        # closed: no entry rather than a half-empty card.
        return None
    parts = out.strip().split("\t")
    state = (parts[0] or "").strip().lower()
    status = {"playing": "Playing", "paused": "Paused"}.get(state, "Stopped")
    info = {"id": pid, "identity": label, "status": status,
            "title": "", "artist": "", "album": "",
            "position_ms": 0, "length_ms": 0,
            "can_seek": False, "can_go_next": True, "can_go_previous": True,
            "can_play": True, "can_pause": True}
    if len(parts) >= 6:
        info["title"] = parts[1].strip()
        info["artist"] = parts[2].strip()
        info["album"] = parts[3].strip()
        try:
            # Music reports seconds (float); Spotify reports ms for duration
            # and seconds for position — normalise both to ms.
            dur = float(parts[4])
            info["length_ms"] = int(dur if pid == "spotify" else dur * 1000)
            info["position_ms"] = int(float(parts[5]) * 1000)
        except (ValueError, TypeError):
            pass
    return info


def media_info():
    """{"available":true,"players":[...]} or None when nothing can be driven —
    None makes the route 404 and the app hides the card, same as Linux."""
    pids = _media_players()
    if not pids:
        return None
    players = [i for i in (_media_player_info(p) for p in pids) if i]
    if not players:
        return None
    order = {"Playing": 0, "Paused": 1}
    players.sort(key=lambda p: (order.get(p["status"], 2), p["identity"].lower()))
    return {"available": True, "players": players}


def media_op(pid, op):
    """One allowlisted transport op on one allowlisted player."""
    start = time.monotonic()
    if pid not in _MEDIA_APPS or op not in _MEDIA_OPS:
        return {"ok": False, "exit_code": 1, "stdout": "",
                "stderr": "unknown player or op", "duration_ms": 0}
    app, _ = _MEDIA_APPS[pid]
    if not _app_running(app):
        # Never LAUNCH a player to control it — `tell application` would.
        return {"ok": False, "exit_code": 1, "stdout": "",
                "stderr": "%s is not running" % app, "duration_ms": 0}
    rc, out, err = _run(
        [OSASCRIPT, "-e", 'tell application "%s" to %s' % (app, _MEDIA_OPS[op])],
        timeout=6)
    return {"ok": rc == 0, "exit_code": rc, "stdout": out.strip(),
            "stderr": err.strip(),
            "duration_ms": int((time.monotonic() - start) * 1000)}


# --------------------------------------------------------------------------
# Status payload — the SAME keys the Linux and Windows agents send. Absent
# fields are omitted, never sent as null (CLAUDE.md §4: add fields, never
# change shapes; the app treats absence as "this box did not say").
# --------------------------------------------------------------------------

def _mem():
    rc, out, _ = _run(["/usr/sbin/sysctl", "-n", "hw.memsize"])
    if rc != 0 or not out.strip():
        return None
    try:
        total = int(out.strip())
    except ValueError:
        return None
    # THERE IS NO SINGLE "PERCENT USED" ON MACOS. Measured on this Mac
    # (Mac15,6, macOS 27.0) at one moment, three native views disagreed:
    #   top PhysMem ............... 17G used, 141M unused  -> ~99%
    #   Activity Monitor's model .. anon + wired + compressed -> ~68%
    #   Linux-equivalent .......... total - available -> ~76%
    # (`memory_pressure` prints "49% free", but that is a PRESSURE metric and
    # cannot be reproduced from its own page counts — it is not a control for
    # this quantity, and an earlier version of this comment wrongly treated it
    # as one.)
    #
    # We report the LINUX-EQUIVALENT definition on purpose: the same app bar
    # renders Linux, Windows and macOS boxes, so it has to mean one thing.
    # Linux sends total - MemAvailable, where available counts reclaimable
    # cache as free (agent/couchsided.py:1120-1126); the macOS analogue is
    # free + inactive + speculative + purgeable. Reporting top's number instead
    # would show every Mac as ~99% full, which is true by macOS convention and
    # useless in a cross-platform bar.
    #
    # The page size is READ, never assumed — this machine uses 16384, not the
    # 4096 an x86 habit would default to, and a hardcoded default would have
    # been wrong by 4x on Apple silicon.
    rc, vm, _ = _run(["/usr/bin/vm_stat"])
    used = None
    if rc == 0:
        page = None
        pages = {}
        for line in vm.splitlines():
            if "page size of" in line:
                for tok in line.replace("(", " ").replace(")", " ").split():
                    if tok.isdigit():
                        page = int(tok)
                        break
                continue
            if ":" not in line:
                continue
            key, _, val = line.partition(":")
            val = val.strip().rstrip(".")
            if val.isdigit():
                pages[key.strip().lower()] = int(val)
        # The page size is read above, never assumed: this machine uses 16384,
        # and an x86 habit of defaulting to 4096 would be wrong by 4x on Apple
        # silicon.
        free = pages.get("pages free")
        inactive = pages.get("pages inactive")
        spec = pages.get("pages speculative", 0)
        purge = pages.get("pages purgeable", 0)
        if page and free is not None and inactive is not None:
            avail = (free + inactive + spec + purge) * page
            used = total - avail
    out = {"total_mb": total // (1024 * 1024)}
    if used is not None and 0 < used <= total:
        out["used_mb"] = used // (1024 * 1024)
        # DERIVED from the two rounded numbers, not floored independently:
        # flooring both used and (total-used) loses a megabyte and the pair
        # stops summing to the total, which a used/total bar renders as a
        # permanent 1 MB of nowhere. Caught by the test that asserts they add up.
        out["available_mb"] = out["total_mb"] - out["used_mb"]
    return out


def _load():
    try:
        return [round(x, 2) for x in os.getloadavg()]
    except (OSError, AttributeError):
        return None


def _uptime_s():
    rc, out, _ = _run(["/usr/sbin/sysctl", "-n", "kern.boottime"])
    if rc == 0 and "sec =" in out:
        try:
            sec = int(out.split("sec =")[1].split(",")[0].strip())
            return int(time.time() - sec)
        except (ValueError, IndexError):
            pass
    return int(time.time() - STARTED_AT)


def read_os_info():
    """{"name","version","build","kernel"} — the Console header line.

    Same contract as the Linux reader, including the rule that made the Nobara
    fix necessary: name and version are separate fields and the app joins them,
    so the name must not already carry the version.
    """
    out = {"name": "macOS"}
    rc, ver, _ = _run(["/usr/bin/sw_vers", "-productVersion"])
    if rc == 0 and ver.strip():
        out["version"] = ver.strip()
    rc, build, _ = _run(["/usr/bin/sw_vers", "-buildVersion"])
    if rc == 0 and build.strip():
        out["build"] = build.strip()
    try:
        out["kernel"] = platform.release()
    except Exception:
        pass
    return out


def real_status():
    st = {
        "hostname": socket.gethostname().split(".")[0],
        "time": int(time.time()),
        "uptime_s": _uptime_s(),
        "agent_version": VERSION,
        "caps": dict(CAPS),
        "os": read_os_info(),
    }
    load = _load()
    if load:
        st["load"] = load
    mem = _mem()
    if mem:
        st["mem"] = mem
    model = _mac_model()
    if model:
        st["model"] = model
    return st


# --------------------------------------------------------------------------
# HTTP. /api/ping is the ONLY pre-auth endpoint (the app's discovery sweep
# needs it); everything else is behind the bearer token.
# --------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "couchside-mac/" + VERSION
    token = ""

    def log_message(self, fmt, *args):
        pass  # we log ourselves, one line per request

    def _log(self, code, started):
        print("%s %s %s %s %dms" % (
            self.client_address[0], self.command, self.path, code,
            int((time.monotonic() - started) * 1000)), flush=True)

    def _send(self, code, payload, started):
        data = json.dumps(payload).encode("utf-8") if payload is not None else b""
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        # NO CORS, deliberately: LAN-only and token-authed by design (CLAUDE.md
        # §4). Browser dev goes through scripts/web-dev-proxy.py.
        self.end_headers()
        if data:
            self.wfile.write(data)
        self._log(code, started)

    def _authorized(self):
        auth = self.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return False
        # compare_digest, not ==, so a wrong token cannot be found byte by byte
        # from response timing.
        return hmac.compare_digest(auth[len("Bearer "):].strip(), self.token)

    def do_GET(self):
        started = time.monotonic()
        try:
            path = urlparse(self.path).path.rstrip("/") or "/"

            if path == "/api/ping":
                # The one pre-auth endpoint. "ip" is the address the client
                # actually reached us on (the app caches it as an mDNS
                # fallback); "host" lets it check a cached IP still points here.
                try:
                    own_ip = self.connection.getsockname()[0]
                except OSError:
                    own_ip = None
                self._send(200, {"ok": True, "app": APP_NAME, "version": VERSION,
                                 "ip": own_ip,
                                 "host": socket.gethostname().split(".")[0]},
                           started)
                return

            if not path.startswith("/api/"):
                self._send(404, {"error": "not found"}, started)
                return

            if not self._authorized():
                self._send(401, {"error": "unauthorized"}, started)
                return

            if path == "/api/status":
                self._send(200, real_status(), started)
                return

            if path == "/api/media":
                # Probe-and-appear, same as Linux: 404 when nothing is
                # drivable so the app hides the Now Playing card entirely.
                info = media_info()
                if info is None:
                    self._send(404, {"error": "not found"}, started)
                else:
                    self._send(200, info, started)
                return

            if path == "/api/power/keep-awake":
                self._send(200, {"available": True,
                                 "on": keep_awake_state()}, started)
                return

            # Everything else is genuinely not implemented on this platform
            # yet. 404 rather than a stub: the app's probe-and-appear pattern
            # reads 404 as "this box cannot", which is the truth.
            self._send(404, {"error": "not implemented on macOS yet"}, started)
        except Exception as e:                     # never leak a traceback
            try:
                self._send(500, {"error": e.__class__.__name__}, started)
            except Exception:
                pass

    def do_POST(self):
        started = time.monotonic()
        try:
            path = urlparse(self.path).path.rstrip("/") or "/"
            if not self._authorized():
                self._send(401, {"error": "unauthorized"}, started)
                return

            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if 0 < length <= 65536 else b""

            # POST /api/power  {"op":"sleep"|"display_sleep"} — looked up
            # against a frozen table, never interpolated.
            if path == "/api/power":
                try:
                    req = json.loads(body.decode("utf-8")) if body else {}
                    if not isinstance(req, dict):
                        raise ValueError
                except (ValueError, UnicodeDecodeError):
                    self._send(400, {"error": "json body required"}, started)
                    return
                op = req.get("op")
                if op not in _POWER_OPS:
                    self._send(400, {"error": "op must be one of %s"
                                     % "|".join(sorted(_POWER_OPS))}, started)
                    return
                self._send(200, power_op(op), started)
                return

            # POST /api/power/keep-awake  {"on":true|false}
            if path == "/api/power/keep-awake":
                try:
                    req = json.loads(body.decode("utf-8")) if body else {}
                    if not isinstance(req, dict):
                        raise ValueError
                except (ValueError, UnicodeDecodeError):
                    self._send(400, {"error": "json body required"}, started)
                    return
                on = req.get("on")
                if not isinstance(on, bool):
                    self._send(400, {"error": "on must be a boolean"}, started)
                    return
                self._send(200, keep_awake_set(on), started)
                return

            # POST /api/media/<player>/<op> — the SAME route shape the Linux
            # agent uses, so the app's transport buttons need no macOS branch.
            mprefix = "/api/media/"
            if path.startswith(mprefix):
                parts = path[len(mprefix):].rsplit("/", 1)
                if len(parts) != 2 or not parts[0] or not parts[1]:
                    self._send(404, {"error": "not found"}, started)
                    return
                pid, op = parts[0], parts[1]
                if pid not in _MEDIA_APPS or op not in _MEDIA_OPS:
                    self._send(404, {"error": "unknown player or op"}, started)
                    return
                self._send(200, media_op(pid, op), started)
                return

            self._send(404, {"error": "not implemented on macOS yet"}, started)
        except Exception as e:
            try:
                self._send(500, {"error": e.__class__.__name__}, started)
            except Exception:
                pass


def main(argv=None):
    ap = argparse.ArgumentParser(description="Couchside macOS agent (alpha)")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--token", default=None)
    ap.add_argument("--token-file", default=None)
    ap.add_argument("--mock", action="store_true",
                    help="serve believable data with every cap true, for app dev")
    ap.add_argument("--version", action="store_true")
    a = ap.parse_args(argv)

    if a.version:
        print(VERSION)
        return 0

    token = a.token
    if not token and a.token_file:
        try:
            with open(a.token_file) as f:
                token = f.read().strip()
        except OSError as e:
            print("error: cannot read token file: %s" % e, file=sys.stderr)
            return 2
    if not token and not a.mock:
        print("error: --token or --token-file is required", file=sys.stderr)
        return 2

    set_caps(a.mock)
    Handler.token = token or "mock"
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    srv.daemon_threads = True
    print("couchside-mac %s listening on %s:%d%s"
          % (VERSION, a.host, a.port, " (mock)" if a.mock else ""), flush=True)
    print("caps: %s" % ",".join(sorted(k for k, v in CAPS.items() if v)) or "(none)",
          flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
