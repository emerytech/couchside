#!/usr/bin/env python3
"""couchsided.py — box-side agent for Couchside.

Pure python3 stdlib. Serves the Couchside agent API contract v1 on port 8787.
Runs on SteamOS (Arch) and Bazzite (Fedora Atomic) as a systemd service; also
runs on macOS in --mock mode for phone-app development.

Watched units and recovery actions are config-driven:
/etc/couchside/config.json (overridable with --config). On a missing or
invalid config the agent logs a warning and falls back to safe generic
defaults.
"""

import argparse
import base64
import glob
import hashlib
import hmac
import json
import os
import random
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

try:
    import fcntl  # POSIX only; uinput needs it (Linux), absent on Windows
except ImportError:  # pragma: no cover
    fcntl = None

APP_NAME = "couchside-agent"
VERSION = "2.2.0"
UID = os.getuid()
XDG_RUNTIME_DIR = "/run/user/%d" % UID

DEFAULT_CONFIG_PATH = "/etc/couchside/config.json"
DEFAULT_PORT = 8787

# ---------------------------------------------------------------------------
# Config: watched units + recovery actions
#
# /etc/couchside/config.json schema:
# {
#   "port": 8787,                                   # optional
#   "units": [{"name": "sddm.service", "scope": "system"|"user"}, ...],
#   "actions": {
#     "<id>": {
#       "label": "...",                             # optional, defaults to id
#       "description": "...",                       # optional, defaults to ""
#       "danger": "low"|"medium"|"high",            # required
#       "cmd": ["argv0", "arg1", ...],              # required, non-empty
#       "user_env": bool,                           # optional, default false
#       "detached": bool                            # optional, default false
#     }, ...
#   },
#   "action_order": ["<id>", ...],                  # optional listing order
#   "launchers": [                                  # optional custom launchers
#     {"id": "custom:<slug>",                       # id (generated on POST)
#      "label": "...",                              # required non-empty string
#      "cmd": ["argv0", "arg1", ...]}               # required non-empty argv
#   ]
# }
#
# The journal allowlist is exactly the configured unit names. On a missing or
# invalid config the GENERIC defaults below apply.
#
# "launchers" holds user-defined custom launchers (persisted here by the
# POST/DELETE /api/launchers routes); Steam games are auto-discovered at
# request time and NOT stored in config.
# ---------------------------------------------------------------------------

DEFAULT_UNITS = [
    # (name, scope)
    ("sddm.service", "system"),
    ("couchside.service", "system"),
]

DEFAULT_ACTIONS = {
    "restart-session": {
        "label": "Restart Session",
        "description": "Restart the display session (sddm) — fixes a wedged/black screen",
        "danger": "high",
        "cmd": ["sudo", "systemctl", "restart", "sddm"],
        "user_env": False,
        "detached": False,
    },
    "reboot": {
        "label": "Reboot",
        "description": "Reboot the box",
        "danger": "high",
        "cmd": ["sudo", "systemctl", "reboot"],
        "user_env": False,
        "detached": True,
    },
    "poweroff": {
        "label": "Power Off",
        "description": "Power off the box",
        "danger": "high",
        "cmd": ["sudo", "systemctl", "poweroff"],
        "user_env": False,
        "detached": True,
    },
}

DEFAULT_ACTION_ORDER = ["restart-session", "reboot", "poweroff"]

# Custom launcher limits (see the SECURITY NOTE in the launcher routes).
MAX_LAUNCHERS = 100        # cap on total custom launchers
MAX_CMD_ARGS = 64          # cap on argv count per launcher
MAX_CMD_ARG_LEN = 4096     # cap on a single argv token
MAX_LABEL_LEN = 200        # cap on a launcher label

# Effective config — set by load_config() before the server starts.
WATCHLIST = list(DEFAULT_UNITS)
WATCHLIST_NAMES = {name for name, _scope in WATCHLIST}
ACTIONS = dict(DEFAULT_ACTIONS)
ACTION_ORDER = list(DEFAULT_ACTION_ORDER)
CONFIG_PORT = None  # optional "port" from config.json
LAUNCHERS = []  # list of {"id","label","cmd":[...]} — custom launchers only
CONFIG_PATH = DEFAULT_CONFIG_PATH  # remembered by load_config() for rewrites
CONFIG_LOCK = threading.Lock()  # serializes launcher config rewrites


class ConfigError(ValueError):
    pass


def _valid_launcher_id(lid):
    """A stored custom launcher id: "custom:" + a filesystem-safe slug.

    No path separators / traversal (".", "..", "/") — the id is never used as
    a path, but this keeps ids inert and predictable regardless of downstream use.
    """
    if not isinstance(lid, str) or not lid.startswith("custom:"):
        return False
    slug = lid[len("custom:"):]
    if not slug or slug in (".", ".."):
        return False
    return all(c.isalnum() or c in "-_" for c in slug)


def _valid_cmd(cmd):
    """A launcher/action argv: non-empty list of non-empty bounded strings."""
    if not isinstance(cmd, list) or not cmd or len(cmd) > MAX_CMD_ARGS:
        return False
    return all(isinstance(a, str) and a and len(a) <= MAX_CMD_ARG_LEN
               for a in cmd)


def _parse_config(raw):
    """Validate a parsed config.json dict.

    Returns (units, actions, order, port, launchers).

    Raises ConfigError on any schema violation — the caller falls back to the
    generic defaults wholesale (no partial merges).
    """
    if not isinstance(raw, dict):
        raise ConfigError("config root must be a JSON object")

    port = raw.get("port")
    if port is not None:
        if not isinstance(port, int) or isinstance(port, bool) or not (1 <= port <= 65535):
            raise ConfigError("port must be an integer 1-65535")

    units_raw = raw.get("units")
    if not isinstance(units_raw, list) or not units_raw:
        raise ConfigError("units must be a non-empty list")
    units = []
    seen = set()
    for i, u in enumerate(units_raw):
        if not isinstance(u, dict):
            raise ConfigError("units[%d] must be an object" % i)
        name = u.get("name")
        scope = u.get("scope")
        if not isinstance(name, str) or not name:
            raise ConfigError("units[%d].name must be a non-empty string" % i)
        if scope not in ("system", "user"):
            raise ConfigError("units[%d].scope must be \"system\" or \"user\"" % i)
        if name in seen:
            raise ConfigError("duplicate unit %r" % name)
        seen.add(name)
        units.append((name, scope))

    actions_raw = raw.get("actions")
    if not isinstance(actions_raw, dict):
        raise ConfigError("actions must be an object")
    actions = {}
    for aid, spec in actions_raw.items():
        if not isinstance(aid, str) or not aid:
            raise ConfigError("action ids must be non-empty strings")
        if not isinstance(spec, dict):
            raise ConfigError("actions[%r] must be an object" % aid)
        danger = spec.get("danger")
        if danger not in ("low", "medium", "high"):
            raise ConfigError("actions[%r].danger must be low|medium|high" % aid)
        cmd = spec.get("cmd")
        if (not isinstance(cmd, list) or not cmd or
                not all(isinstance(a, str) and a for a in cmd)):
            raise ConfigError("actions[%r].cmd must be a non-empty list of strings" % aid)
        label = spec.get("label", aid)
        description = spec.get("description", "")
        if not isinstance(label, str) or not isinstance(description, str):
            raise ConfigError("actions[%r] label/description must be strings" % aid)
        user_env = spec.get("user_env", False)
        detached = spec.get("detached", False)
        if not isinstance(user_env, bool) or not isinstance(detached, bool):
            raise ConfigError("actions[%r] user_env/detached must be booleans" % aid)
        actions[aid] = {
            "label": label,
            "description": description,
            "danger": danger,
            "cmd": list(cmd),
            "user_env": user_env,
            "detached": detached,
        }

    order_raw = raw.get("action_order")
    if order_raw is None:
        order = list(actions.keys())
    else:
        if (not isinstance(order_raw, list) or
                not all(isinstance(a, str) for a in order_raw)):
            raise ConfigError("action_order must be a list of strings")
        unknown = [a for a in order_raw if a not in actions]
        if unknown:
            raise ConfigError("action_order references unknown actions: %s"
                              % ", ".join(unknown))
        if len(set(order_raw)) != len(order_raw):
            raise ConfigError("action_order has duplicates")
        order = list(order_raw)
        order += [a for a in actions if a not in order]  # unlisted go last

    launchers_raw = raw.get("launchers")
    launchers = []
    if launchers_raw is not None:
        if not isinstance(launchers_raw, list):
            raise ConfigError("launchers must be a list")
        if len(launchers_raw) > MAX_LAUNCHERS:
            raise ConfigError("too many launchers (max %d)" % MAX_LAUNCHERS)
        seen_ids = set()
        for i, l in enumerate(launchers_raw):
            if not isinstance(l, dict):
                raise ConfigError("launchers[%d] must be an object" % i)
            lid = l.get("id")
            if not _valid_launcher_id(lid):
                raise ConfigError("launchers[%d].id must be a valid custom: id" % i)
            if lid in seen_ids:
                raise ConfigError("duplicate launcher id %r" % lid)
            seen_ids.add(lid)
            label = l.get("label")
            if not isinstance(label, str) or not label or len(label) > MAX_LABEL_LEN:
                raise ConfigError("launchers[%d].label must be a non-empty string" % i)
            cmd = l.get("cmd")
            if not _valid_cmd(cmd):
                raise ConfigError("launchers[%d].cmd must be a non-empty argv list" % i)
            launchers.append({"id": lid, "label": label, "cmd": list(cmd)})

    return units, actions, order, port, launchers


def load_config(path):
    """Load config.json into the module globals; fall back to defaults."""
    global WATCHLIST, WATCHLIST_NAMES, ACTIONS, ACTION_ORDER, CONFIG_PORT
    global LAUNCHERS, CONFIG_PATH
    CONFIG_PATH = path  # remembered so launcher POST/DELETE can rewrite it
    try:
        with open(path) as f:
            raw = json.load(f)
        units, actions, order, port, launchers = _parse_config(raw)
    except FileNotFoundError:
        print("warning: config %s not found — using built-in generic defaults"
              % path, file=sys.stderr, flush=True)
        return
    except (OSError, ValueError) as e:  # ValueError covers JSON + ConfigError
        print("warning: invalid config %s (%s) — using built-in generic defaults"
              % (path, e), file=sys.stderr, flush=True)
        return
    WATCHLIST = units
    WATCHLIST_NAMES = {name for name, _scope in WATCHLIST}
    ACTIONS = actions
    ACTION_ORDER = order
    CONFIG_PORT = port
    LAUNCHERS = launchers
    print("config loaded from %s: %d units, %d actions, %d launchers"
          % (path, len(WATCHLIST), len(ACTIONS), len(LAUNCHERS)), flush=True)

# ---------------------------------------------------------------------------
# Real-mode data collection (Linux; each helper degrades gracefully)
# ---------------------------------------------------------------------------


def _user_env():
    env = dict(os.environ)
    env["XDG_RUNTIME_DIR"] = XDG_RUNTIME_DIR
    return env


def read_uptime_s():
    try:
        with open("/proc/uptime") as f:
            return int(float(f.read().split()[0]))
    except Exception:
        return 0


def read_load():
    try:
        return [round(x, 2) for x in os.getloadavg()]
    except Exception:
        return [0.0, 0.0, 0.0]


def read_cpu_temp_c():
    """Scan hwmon for coretemp; fall back to any temp1_input; then thermal zones."""
    try:
        coretemp_path = None
        fallback_path = None
        for name_file in sorted(glob.glob("/sys/class/hwmon/hwmon*/name")):
            hwmon_dir = os.path.dirname(name_file)
            try:
                with open(name_file) as f:
                    name = f.read().strip()
            except OSError:
                continue
            temp_file = os.path.join(hwmon_dir, "temp1_input")
            if not os.path.exists(temp_file):
                continue
            if name == "coretemp" and coretemp_path is None:
                coretemp_path = temp_file
            if fallback_path is None:
                fallback_path = temp_file
        path = coretemp_path or fallback_path
        if path is None:
            for tz in sorted(glob.glob("/sys/class/thermal/thermal_zone*/temp")):
                path = tz
                break
        if path is None:
            return None
        with open(path) as f:
            milli = int(f.read().strip())
        return round(milli / 1000.0, 1)
    except Exception:
        return None


def read_mem():
    try:
        info = {}
        with open("/proc/meminfo") as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 2:
                    info[parts[0].rstrip(":")] = int(parts[1])  # kB
        total_mb = info.get("MemTotal", 0) // 1024
        avail_mb = info.get("MemAvailable", 0) // 1024
        return {
            "total_mb": total_mb,
            "used_mb": total_mb - avail_mb,
            "available_mb": avail_mb,
        }
    except Exception:
        return {"total_mb": 0, "used_mb": 0, "available_mb": 0}


def read_disks():
    disks = []
    for mount in ("/", "/var"):
        try:
            du = shutil.disk_usage(mount)
            # Skip synthetic mounts with no real capacity (e.g. the composefs
            # read-only / on Bazzite/Fedora Atomic reports a tiny total that is
            # always "100% used" — meaningless and alarming on the dashboard).
            if du.total < 1024 ** 3:
                continue
            total_gb = du.total / (1024 ** 3)
            used_gb = du.used / (1024 ** 3)
            free_gb = du.free / (1024 ** 3)
            pct = int(round(du.used * 100.0 / du.total)) if du.total else 0
            disks.append({
                "mount": mount,
                "total_gb": round(total_gb, 1),
                "used_gb": round(used_gb, 1),
                "free_gb": round(free_gb, 1),
                "pct": pct,
            })
        except Exception:
            continue
    return disks


def real_status():
    return {
        "hostname": socket.gethostname().split(".")[0],
        "time": int(time.time()),
        "uptime_s": read_uptime_s(),
        "load": read_load(),
        "cpu_temp_c": read_cpu_temp_c(),
        "mem": read_mem(),
        "disks": read_disks(),
        "agent_version": VERSION,
    }


def real_units():
    units = []
    for name, scope in WATCHLIST:
        active, sub, desc = "unknown", "unknown", ""
        try:
            # Parse Key=Value output: systemctl show prints properties in
            # vtable order, not -p argument order, so --value line order
            # cannot be trusted.
            if scope == "system":
                cmd = ["systemctl", "show", "-p", "ActiveState",
                       "-p", "SubState", "-p", "Description", name]
                env = None
            else:
                cmd = ["systemctl", "--user", "show", "-p", "ActiveState",
                       "-p", "SubState", "-p", "Description", name]
                env = _user_env()
            r = subprocess.run(cmd, capture_output=True, text=True,
                               timeout=10, env=env)
            props = {}
            for line in r.stdout.splitlines():
                key, eq, value = line.partition("=")
                if eq:
                    props[key.strip()] = value.strip()
            active = props.get("ActiveState") or "unknown"
            sub = props.get("SubState") or "unknown"
            desc = props.get("Description", "")
        except Exception:
            pass
        units.append({
            "name": name,
            "scope": scope,
            "active": active,
            "sub": sub,
            "description": desc,
        })
    return units


def real_journal(unit, scope, lines):
    if scope == "system":
        cmd = ["sudo", "journalctl", "-u", unit, "-n", str(lines),
               "--no-pager", "-o", "short-iso"]
        env = None
    else:
        cmd = ["journalctl", "--user", "-u", unit, "-n", str(lines),
               "--no-pager", "-o", "short-iso"]
        env = _user_env()
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=15, env=env)
    return r.stdout.splitlines()


def real_action(action_id):
    spec = ACTIONS[action_id]
    env = _user_env() if spec["user_env"] else None
    start = time.monotonic()
    if spec["detached"]:
        proc = subprocess.Popen(
            spec["cmd"], env=env,
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            stdin=subprocess.DEVNULL, start_new_session=True,
        )
        # Give the child ~200ms: if it already died non-zero (e.g. sudo
        # refused with no NOPASSWD rule), don't report false success.
        time.sleep(0.2)
        rc = proc.poll()
        if rc is not None and rc != 0:
            try:
                err = proc.stderr.read().decode("utf-8", "replace") if proc.stderr else ""
            except Exception:
                err = ""
            return {
                "ok": False,
                "exit_code": rc,
                "stdout": "",
                "stderr": err.strip() or ("command exited %d" % rc),
                "duration_ms": int((time.monotonic() - start) * 1000),
            }
        return {
            "ok": True,
            "exit_code": 0,
            "stdout": "",
            "stderr": "",
            "duration_ms": int((time.monotonic() - start) * 1000),
        }
    r = subprocess.run(spec["cmd"], capture_output=True, text=True,
                       timeout=15, env=env)
    return {
        "ok": r.returncode == 0,
        "exit_code": r.returncode,
        "stdout": r.stdout,
        "stderr": r.stderr,
        "duration_ms": int((time.monotonic() - start) * 1000),
    }


# ---------------------------------------------------------------------------
# Mock mode
# ---------------------------------------------------------------------------

MOCK_START = time.time()
MOCK_BOOT_OFFSET = 3600 * 26 + 417  # pretend the box has been up ~26h already


def mock_status():
    now = time.time()
    # cpu temp wanders ~50-60C on a slow sine + jitter
    import math
    base = 55.0 + 4.5 * math.sin(now / 97.0)
    temp = round(base + random.uniform(-0.8, 0.8), 1)
    return {
        "hostname": "couchside-box",
        "time": int(now),
        "uptime_s": int(now - MOCK_START + MOCK_BOOT_OFFSET),
        "load": [round(random.uniform(0.2, 1.4), 2),
                 round(random.uniform(0.3, 1.1), 2),
                 round(random.uniform(0.3, 0.9), 2)],
        "cpu_temp_c": temp,
        "mem": {"total_mb": 15803, "used_mb": 6212, "available_mb": 9591},
        "disks": [
            {"mount": "/", "total_gb": 465.1, "used_gb": 210.4,
             "free_gb": 254.7, "pct": 45},
            {"mount": "/var", "total_gb": 465.1, "used_gb": 198.2,
             "free_gb": 266.9, "pct": 43},
        ],
        "agent_version": VERSION,
    }


MOCK_UNIT_DESCS = {
    "sddm.service": "Simple Desktop Display Manager",
    "couchside.service": "Couchside box agent",
}


def mock_units():
    units = []
    for name, scope in WATCHLIST:
        units.append({
            "name": name,
            "scope": scope,
            "active": "active",
            "sub": "running",
            "description": MOCK_UNIT_DESCS.get(name, name),
        })
    return units


MOCK_GENERIC_LOG = [
    "Starting %(unit)s...",
    "Started %(unit)s.",
    "%(src)s: initialized",
    "%(src)s: heartbeat ok",
    "%(src)s: work item processed",
    "%(src)s: idle",
]

MOCK_LOG_TEMPLATES = {
    "sddm.service": [
        "Starting Simple Desktop Display Manager...",
        "Initializing...",
        "Starting...",
        "Logind interface found",
        "Adding new display...",
        "Loading theme configuration from \"\"",
        "Display server starting...",
        "Running: /usr/bin/gamescope --xwayland-count 2",
        "Setting default cursor",
        "Running display setup script",
        "Greeter starting...",
        "Session started for user gamer",
        "Authentication for user \"gamer\" successful",
        "Auth: sddm-helper exited successfully",
        "Greeter stopped",
    ],
    "couchside.service": [
        "Started Couchside box agent.",
        "couchside-agent %s listening on 0.0.0.0:8787" % VERSION,
        "GET /api/ping 200 0ms",
        "GET /api/status 200 4ms",
        "GET /api/units 200 61ms",
        "GET /api/journal?<redacted> 200 88ms",
        "POST /api/actions/reboot 200 412ms",
    ],
}


def mock_journal(unit, scope, lines):
    src = unit.replace(".service", "")
    templates = MOCK_LOG_TEMPLATES.get(
        unit, [t % {"unit": unit, "src": src} for t in MOCK_GENERIC_LOG])
    out = []
    n = min(lines, 30)
    t = time.time() - n * 47
    host = "couchside-box"
    for i in range(n):
        msg = templates[i % len(templates)]
        ts = time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(t))
        out.append("%s %s %s[%d]: %s" % (ts, host, src, 1200 + i, msg))
        t += 47 + random.uniform(-20, 20)
    return out


def mock_action(action_id):
    time.sleep(0.3)
    spec = ACTIONS[action_id]
    return {
        "ok": True,
        "exit_code": 0,
        "stdout": "[mock] %s\n" % " ".join(spec["cmd"]),
        "stderr": "",
        "duration_ms": 300,
    }


# ---------------------------------------------------------------------------
# Launchers — custom (config) + auto-discovered Steam games
#
# GET  /api/launchers      -> {"launchers": [Launcher, ...]}
# POST /api/launchers      -> Launcher (add a custom launcher)
# POST /api/launchers/<id> -> LaunchResult (fire-and-forget launch)
# DELETE /api/launchers/<id> -> {"ok": true} (delete a custom launcher)
#
# Launcher shape: {"id","label","kind":"steam"|"custom"[,"appid":int]}
# ---------------------------------------------------------------------------

# Steam roots to probe, in preference order (native, then Flatpak).
STEAM_ROOTS = [
    "~/.steam/steam",
    "~/.local/share/Steam",
    "~/.var/app/com.valvesoftware.Steam/data/Steam",
]

# Steam runtime/tool appids that ship in every library — never real games.
# (Name-based filtering catches the rest; this covers a few odd names.)
STEAM_TOOL_APPIDS = frozenset({
    "228980",   # Steamworks Common Redistributables
    "1070560",  # Steam Linux Runtime 1.0 (scout)
    "1391110",  # Steam Linux Runtime 2.0 (soldier)
    "1628350",  # Steam Linux Runtime 3.0 (sniper)
    "1493710",  # Proton Experimental
})


def _steam_root():
    """Return the first existing Steam root path, or None (never raises)."""
    for root in STEAM_ROOTS:
        try:
            path = os.path.expanduser(root)
            if os.path.isdir(os.path.join(path, "steamapps")):
                return path
        except Exception:
            continue
    return None


def _parse_vdf_paths(text):
    """Extract library "path" values from a libraryfolders.vdf blob.

    Best-effort line scan for `"path"   "<value>"` — the VDF is a simple quoted
    key/value tree and we only need the path strings. Never raises.
    """
    paths = []
    for line in text.splitlines():
        s = line.strip()
        # Match:  "path"   "/some/library"
        if not s.startswith('"path"'):
            continue
        rest = s[len('"path"'):].lstrip()
        if len(rest) >= 2 and rest[0] == '"':
            end = rest.find('"', 1)
            if end > 1:
                paths.append(rest[1:end])
    return paths


def _steam_libraries(root):
    """Return the list of steamapps dirs to scan for this Steam root.

    Always includes the root's own steamapps/; adds any extra libraries listed
    in steamapps/libraryfolders.vdf. Never raises.
    """
    libs = []
    seen = set()

    def add(steamapps_dir):
        try:
            real = os.path.realpath(steamapps_dir)
        except Exception:
            real = steamapps_dir
        if real not in seen and os.path.isdir(steamapps_dir):
            seen.add(real)
            libs.append(steamapps_dir)

    add(os.path.join(root, "steamapps"))
    vdf = os.path.join(root, "steamapps", "libraryfolders.vdf")
    try:
        with open(vdf, "r", encoding="utf-8", errors="replace") as f:
            text = f.read()
        for p in _parse_vdf_paths(text):
            add(os.path.join(p, "steamapps"))
    except OSError:
        pass
    except Exception:
        pass
    return libs


def _parse_acf(text):
    """Extract simple quoted top-level keys from an appmanifest .acf blob.

    Returns a dict of the string keys we care about ("appid", "name"). The ACF
    format is `"key"  "value"` lines; we scan for those two. Never raises.
    """
    out = {}
    for line in text.splitlines():
        s = line.strip()
        if not s.startswith('"'):
            continue
        end = s.find('"', 1)
        if end <= 1:
            continue
        key = s[1:end]
        if key not in ("appid", "name"):
            continue
        rest = s[end + 1:].lstrip()
        if len(rest) >= 2 and rest[0] == '"':
            vend = rest.find('"', 1)
            if vend > 0:
                out[key] = rest[1:vend]
    return out


def _is_steam_tool(appid, name):
    """True if this appmanifest is a Steam runtime/tool, not a real game."""
    if appid in STEAM_TOOL_APPIDS:
        return True
    if name.startswith("Steam Linux Runtime") or name.startswith("Proton"):
        return True
    return False


def discover_steam_games():
    """Return auto-discovered Steam games as Launcher dicts, sorted by name.

    Read-only, best-effort: any error in discovery yields an empty list rather
    than raising. Each game -> {"id":"steam:<appid>","label":<name>,
    "kind":"steam","appid":<int>}. De-duped by appid; runtimes/tools skipped.
    """
    try:
        root = _steam_root()
        if root is None:
            return []
        games = {}  # appid(str) -> name
        for steamapps in _steam_libraries(root):
            try:
                manifests = glob.glob(os.path.join(steamapps, "appmanifest_*.acf"))
            except Exception:
                continue
            for mf in manifests:
                try:
                    with open(mf, "r", encoding="utf-8", errors="replace") as f:
                        fields = _parse_acf(f.read())
                except OSError:
                    continue
                except Exception:
                    continue
                appid = fields.get("appid")
                name = fields.get("name")
                if not appid or not appid.isdigit() or not name:
                    continue
                if _is_steam_tool(appid, name):
                    continue
                games.setdefault(appid, name)  # de-dupe by appid
        launchers = [
            {"id": "steam:%s" % appid, "label": name,
             "kind": "steam", "appid": int(appid)}
            for appid, name in games.items()
        ]
        launchers.sort(key=lambda l: (l["label"].lower(), l["appid"]))
        return launchers
    except Exception:
        return []


def list_launchers():
    """All launchers: configured custom launchers first, then Steam games."""
    customs = [
        {"id": l["id"], "label": l["label"], "kind": "custom"}
        for l in LAUNCHERS
    ]
    return customs + discover_steam_games()


def _launcher_argv(launcher_id):
    """Resolve a KNOWN launcher id to its argv, or None if unknown.

    The id must correspond to a launcher currently in the list — a configured
    custom launcher, or a Steam game actually discovered on disk. An id that is
    well-formed but not present (e.g. steam:<appid> for a game that isn't
    installed) resolves to None so the route returns 404 "unknown launcher".

    steam:<appid>  -> ["steam", "steam://rungameid/<appid>"]
    custom:<slug>  -> that launcher's stored cmd argv from config
    """
    if launcher_id.startswith("steam:"):
        appid = launcher_id[len("steam:"):]
        if not appid.isdigit():
            return None
        # Only launch a Steam game we actually discovered (matches the listed
        # launchers); an unknown/uninstalled appid is not a launcher.
        for game in discover_steam_games():
            if game["id"] == launcher_id:
                return ["steam", "steam://rungameid/%s" % appid]
        return None
    if _valid_launcher_id(launcher_id):
        for l in LAUNCHERS:
            if l["id"] == launcher_id:
                return list(l["cmd"])
    return None


def _session_env():
    """Env for launching into the user's graphical session.

    Starts from _user_env() (sets XDG_RUNTIME_DIR) and best-effort discovers
    DISPLAY / WAYLAND_DISPLAY if not already present: DISPLAY defaults to ":0";
    WAYLAND_DISPLAY is inferred from a wayland-* socket in XDG_RUNTIME_DIR.
    """
    env = _user_env()
    if not env.get("DISPLAY"):
        env["DISPLAY"] = ":0"
    if not env.get("WAYLAND_DISPLAY"):
        try:
            for entry in sorted(os.listdir(XDG_RUNTIME_DIR)):
                if entry.startswith("wayland-") and not entry.endswith(".lock"):
                    env["WAYLAND_DISPLAY"] = entry
                    break
        except OSError:
            pass
    return env


def real_launch(argv):
    """Fire-and-forget launch into the user's graphical session.

    subprocess.Popen with shell=False, start_new_session=True; returns a
    LaunchResult immediately. Never blocks on the child.
    """
    try:
        subprocess.Popen(
            argv, env=_session_env(), shell=False,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL, start_new_session=True,
        )
    except Exception as e:
        return {"ok": False, "error": "%s: %s" % (e.__class__.__name__, e)}
    return {"ok": True}


def mock_launch(argv):
    """--mock stand-in: log the argv, never execute anything real."""
    print("[launch] %s" % " ".join(argv), flush=True)
    return {"ok": True}


def _slugify_label(label):
    """Lower-case, alnum/-/_ only slug of a label (for a launcher id)."""
    out = []
    for ch in label.lower():
        if ch.isalnum() or ch in "-_":
            out.append(ch)
        elif ch in " \t":
            out.append("-")
        # drop everything else
    slug = "".join(out).strip("-_")
    return slug or "launcher"


def _new_launcher_id(label, existing_ids):
    """Generate a unique, valid custom: id derived from label.

    Guarantees _valid_launcher_id() and uniqueness against existing_ids by
    appending a short counter as needed.
    """
    base = _slugify_label(label)
    candidate = "custom:%s" % base
    n = 1
    while candidate in existing_ids or not _valid_launcher_id(candidate):
        n += 1
        candidate = "custom:%s-%d" % (base, n)
    return candidate


def _write_config_launchers(new_launchers):
    """Persist LAUNCHERS = new_launchers to CONFIG_PATH atomically.

    Reads the current config.json (or starts from a minimal skeleton if it is
    missing/unreadable/malformed), replaces the "launchers" key, and writes it
    back via a temp file + os.replace so a crash never leaves a truncated
    config that would wedge the Restart=always daemon. Serialized by
    CONFIG_LOCK. Raises on I/O failure (the caller maps it to a 500).
    """
    with CONFIG_LOCK:
        raw = None
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                raw = json.load(f)
        except (OSError, ValueError):
            raw = None
        if not isinstance(raw, dict):
            # No usable config on disk: build a minimal one that still round-
            # trips through _parse_config (units/actions are required there).
            raw = {
                "units": [{"name": name, "scope": scope}
                          for name, scope in WATCHLIST],
                "actions": {
                    aid: {"danger": spec["danger"], "cmd": list(spec["cmd"]),
                          "label": spec["label"],
                          "description": spec["description"],
                          "user_env": spec["user_env"],
                          "detached": spec["detached"]}
                    for aid, spec in ACTIONS.items()
                },
            }
        raw["launchers"] = [
            {"id": l["id"], "label": l["label"], "cmd": list(l["cmd"])}
            for l in new_launchers
        ]
        directory = os.path.dirname(CONFIG_PATH) or "."
        fd, tmp = tempfile.mkstemp(prefix=".couchside-config-", dir=directory)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(raw, f, indent=2)
                f.write("\n")
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, CONFIG_PATH)
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        # Only mutate the in-memory list once the write succeeded.
        global LAUNCHERS
        LAUNCHERS = new_launchers


def add_launcher(label, cmd):
    """Validate + persist a new custom launcher; return its Launcher dict.

    Raises ConfigError on invalid input (mapped to HTTP 400 by the caller).
    """
    if not isinstance(label, str) or not label.strip() or len(label) > MAX_LABEL_LEN:
        raise ConfigError("label must be a non-empty string")
    if not _valid_cmd(cmd):
        raise ConfigError("cmd must be a non-empty list of non-empty strings")
    if len(LAUNCHERS) >= MAX_LAUNCHERS:
        raise ConfigError("too many launchers (max %d)" % MAX_LAUNCHERS)
    label = label.strip()
    existing = {l["id"] for l in LAUNCHERS}
    lid = _new_launcher_id(label, existing)
    new = list(LAUNCHERS) + [{"id": lid, "label": label, "cmd": list(cmd)}]
    _write_config_launchers(new)
    return {"id": lid, "label": label, "kind": "custom"}


def delete_launcher(launcher_id):
    """Remove a custom launcher by id; persist. Returns True, or False if the
    id is a valid custom id that isn't present. Raises on persist failure."""
    if not any(l["id"] == launcher_id for l in LAUNCHERS):
        return False
    new = [l for l in LAUNCHERS if l["id"] != launcher_id]
    _write_config_launchers(new)
    return True


# ---------------------------------------------------------------------------
# Virtual gamepad — evdev/uinput constants and pure-stdlib uinput driver
# ---------------------------------------------------------------------------

EV_SYN = 0x00
EV_KEY = 0x01
EV_REL = 0x02
EV_ABS = 0x03
SYN_REPORT = 0

# Relative axes (mouse)
REL_X, REL_Y, REL_WHEEL = 0, 1, 8

ABS_X, ABS_Y, ABS_Z, ABS_RX, ABS_RY, ABS_RZ = 0, 1, 2, 3, 4, 5
ABS_HAT0X, ABS_HAT0Y = 16, 17

# protocol button key -> evdev key code
BTN_CODES = {
    "a": 304,       # BTN_SOUTH
    "b": 305,       # BTN_EAST
    "x": 308,       # BTN_WEST
    "y": 307,       # BTN_NORTH
    "lb": 310,      # BTN_TL
    "rb": 311,      # BTN_TR
    "select": 314,  # BTN_SELECT
    "start": 315,   # BTN_START
    "guide": 316,   # BTN_MODE
    "l3": 317,      # BTN_THUMBL
    "r3": 318,      # BTN_THUMBR
}

# dpad "buttons" -> (hat axis, pressed value); released -> 0
DPAD_MAP = {
    "dl": (ABS_HAT0X, -1),
    "dr": (ABS_HAT0X, 1),
    "du": (ABS_HAT0Y, -1),
    "dd": (ABS_HAT0Y, 1),
}

# (axis code, absmin, absmax) — all axes the virtual pad declares
GAMEPAD_AXES = [
    (ABS_X, -32768, 32767),
    (ABS_Y, -32768, 32767),
    (ABS_Z, 0, 255),
    (ABS_RX, -32768, 32767),
    (ABS_RY, -32768, 32767),
    (ABS_RZ, 0, 255),
    (ABS_HAT0X, -1, 1),
    (ABS_HAT0Y, -1, 1),
]

KEY_NAMES = {
    304: "BTN_SOUTH", 305: "BTN_EAST", 307: "BTN_NORTH", 308: "BTN_WEST",
    310: "BTN_TL", 311: "BTN_TR", 314: "BTN_SELECT", 315: "BTN_START",
    316: "BTN_MODE", 317: "BTN_THUMBL", 318: "BTN_THUMBR",
}
ABS_NAMES = {
    0: "ABS_X", 1: "ABS_Y", 2: "ABS_Z", 3: "ABS_RX", 4: "ABS_RY",
    5: "ABS_RZ", 16: "ABS_HAT0X", 17: "ABS_HAT0Y",
}

# ---------------------------------------------------------------------------
# Virtual mouse — evdev EV_REL / EV_KEY (buttons)
# ---------------------------------------------------------------------------

BTN_LEFT, BTN_RIGHT, BTN_MIDDLE = 0x110, 0x111, 0x112

# protocol mouse-button key -> evdev button code
MOUSE_BTN_CODES = {
    "l": BTN_LEFT,
    "r": BTN_RIGHT,
    "m": BTN_MIDDLE,
}

MOUSE_REL_AXES = (REL_X, REL_Y, REL_WHEEL)

REL_NAMES = {REL_X: "REL_X", REL_Y: "REL_Y", REL_WHEEL: "REL_WHEEL"}

# ---------------------------------------------------------------------------
# Virtual keyboard — evdev EV_KEY over KEY_* codes
# ---------------------------------------------------------------------------

# Linux input-event-codes KEY_* values.
KEY_ESC = 1
KEY_1, KEY_2, KEY_3, KEY_4, KEY_5 = 2, 3, 4, 5, 6
KEY_6, KEY_7, KEY_8, KEY_9, KEY_0 = 7, 8, 9, 10, 11
KEY_MINUS, KEY_EQUAL, KEY_BACKSPACE, KEY_TAB = 12, 13, 14, 15
KEY_Q, KEY_W, KEY_E, KEY_R, KEY_T, KEY_Y = 16, 17, 18, 19, 20, 21
KEY_U, KEY_I, KEY_O, KEY_P = 22, 23, 24, 25
KEY_LEFTBRACE, KEY_RIGHTBRACE, KEY_ENTER = 26, 27, 28
KEY_A, KEY_S, KEY_D, KEY_F, KEY_G, KEY_H = 30, 31, 32, 33, 34, 35
KEY_J, KEY_K, KEY_L, KEY_SEMICOLON = 36, 37, 38, 39
KEY_APOSTROPHE, KEY_GRAVE, KEY_LEFTSHIFT, KEY_BACKSLASH = 40, 41, 42, 43
KEY_Z, KEY_X, KEY_C, KEY_V, KEY_B, KEY_N, KEY_M = 44, 45, 46, 47, 48, 49, 50
KEY_COMMA, KEY_DOT, KEY_SLASH = 51, 52, 53
KEY_SPACE = 57
KEY_HOME, KEY_UP = 102, 103
KEY_LEFT, KEY_RIGHT, KEY_END, KEY_DOWN = 105, 106, 107, 108

# ASCII printable char -> (keycode, needs_shift)
def _build_char_map():
    m = {}
    # letters
    lower = {
        "a": KEY_A, "b": KEY_B, "c": KEY_C, "d": KEY_D, "e": KEY_E,
        "f": KEY_F, "g": KEY_G, "h": KEY_H, "i": KEY_I, "j": KEY_J,
        "k": KEY_K, "l": KEY_L, "m": KEY_M, "n": KEY_N, "o": KEY_O,
        "p": KEY_P, "q": KEY_Q, "r": KEY_R, "s": KEY_S, "t": KEY_T,
        "u": KEY_U, "v": KEY_V, "w": KEY_W, "x": KEY_X, "y": KEY_Y,
        "z": KEY_Z,
    }
    for ch, code in lower.items():
        m[ch] = (code, False)
        m[ch.upper()] = (code, True)
    # digit row, unshifted
    digits = {
        "1": KEY_1, "2": KEY_2, "3": KEY_3, "4": KEY_4, "5": KEY_5,
        "6": KEY_6, "7": KEY_7, "8": KEY_8, "9": KEY_9, "0": KEY_0,
    }
    for ch, code in digits.items():
        m[ch] = (code, False)
    # digit row, shifted symbols
    shifted_digits = {
        "!": KEY_1, "@": KEY_2, "#": KEY_3, "$": KEY_4, "%": KEY_5,
        "^": KEY_6, "&": KEY_7, "*": KEY_8, "(": KEY_9, ")": KEY_0,
    }
    for ch, code in shifted_digits.items():
        m[ch] = (code, True)
    # punctuation, unshifted then shifted
    unshifted_punct = {
        "-": KEY_MINUS, "=": KEY_EQUAL, "[": KEY_LEFTBRACE,
        "]": KEY_RIGHTBRACE, "\\": KEY_BACKSLASH, ";": KEY_SEMICOLON,
        "'": KEY_APOSTROPHE, "`": KEY_GRAVE, ",": KEY_COMMA,
        ".": KEY_DOT, "/": KEY_SLASH,
    }
    for ch, code in unshifted_punct.items():
        m[ch] = (code, False)
    shifted_punct = {
        "_": KEY_MINUS, "+": KEY_EQUAL, "{": KEY_LEFTBRACE,
        "}": KEY_RIGHTBRACE, "|": KEY_BACKSLASH, ":": KEY_SEMICOLON,
        "\"": KEY_APOSTROPHE, "~": KEY_GRAVE, "<": KEY_COMMA,
        ">": KEY_DOT, "?": KEY_SLASH,
    }
    for ch, code in shifted_punct.items():
        m[ch] = (code, True)
    # whitespace
    m[" "] = (KEY_SPACE, False)
    m["\t"] = (KEY_TAB, False)
    m["\n"] = (KEY_ENTER, False)
    m["\r"] = (KEY_ENTER, False)
    return m


CHAR_KEYMAP = _build_char_map()

# named special key -> keycode
SPECIAL_KEYS = {
    "backspace": KEY_BACKSPACE,
    "enter": KEY_ENTER,
    "tab": KEY_TAB,
    "esc": KEY_ESC,
    "space": KEY_SPACE,
    "up": KEY_UP,
    "down": KEY_DOWN,
    "left": KEY_LEFT,
    "right": KEY_RIGHT,
    "home": KEY_HOME,
    "end": KEY_END,
}

# All KEY_* codes the virtual keyboard may emit (declared at device create).
KEYBOARD_CODES = sorted(
    {code for code, _shift in CHAR_KEYMAP.values()}
    | set(SPECIAL_KEYS.values())
    | {KEY_LEFTSHIFT}
)

# Names for mock logging of keyboard/mouse EV_KEY events.
_KEY_CODE_NAMES = {
    KEY_ESC: "KEY_ESC", KEY_BACKSPACE: "KEY_BACKSPACE", KEY_TAB: "KEY_TAB",
    KEY_ENTER: "KEY_ENTER", KEY_SPACE: "KEY_SPACE", KEY_LEFTSHIFT: "KEY_LEFTSHIFT",
    KEY_UP: "KEY_UP", KEY_DOWN: "KEY_DOWN", KEY_LEFT: "KEY_LEFT",
    KEY_RIGHT: "KEY_RIGHT", KEY_HOME: "KEY_HOME", KEY_END: "KEY_END",
    KEY_MINUS: "KEY_MINUS", KEY_EQUAL: "KEY_EQUAL", KEY_LEFTBRACE: "KEY_LEFTBRACE",
    KEY_RIGHTBRACE: "KEY_RIGHTBRACE", KEY_BACKSLASH: "KEY_BACKSLASH",
    KEY_SEMICOLON: "KEY_SEMICOLON", KEY_APOSTROPHE: "KEY_APOSTROPHE",
    KEY_GRAVE: "KEY_GRAVE", KEY_COMMA: "KEY_COMMA", KEY_DOT: "KEY_DOT",
    KEY_SLASH: "KEY_SLASH",
}
for _c, _code in (("a", KEY_A), ("b", KEY_B), ("c", KEY_C), ("d", KEY_D),
                  ("e", KEY_E), ("f", KEY_F), ("g", KEY_G), ("h", KEY_H),
                  ("i", KEY_I), ("j", KEY_J), ("k", KEY_K), ("l", KEY_L),
                  ("m", KEY_M), ("n", KEY_N), ("o", KEY_O), ("p", KEY_P),
                  ("q", KEY_Q), ("r", KEY_R), ("s", KEY_S), ("t", KEY_T),
                  ("u", KEY_U), ("v", KEY_V), ("w", KEY_W), ("x", KEY_X),
                  ("y", KEY_Y), ("z", KEY_Z)):
    _KEY_CODE_NAMES[_code] = "KEY_%s" % _c.upper()
for _c, _code in (("0", KEY_0), ("1", KEY_1), ("2", KEY_2), ("3", KEY_3),
                  ("4", KEY_4), ("5", KEY_5), ("6", KEY_6), ("7", KEY_7),
                  ("8", KEY_8), ("9", KEY_9)):
    _KEY_CODE_NAMES[_code] = "KEY_%s" % _c

_BTN_CODE_NAMES = {
    BTN_LEFT: "BTN_LEFT", BTN_RIGHT: "BTN_RIGHT", BTN_MIDDLE: "BTN_MIDDLE",
}


def _event_name(etype, code):
    if etype == EV_KEY:
        if code in KEY_NAMES:
            return KEY_NAMES[code]
        if code in _BTN_CODE_NAMES:
            return _BTN_CODE_NAMES[code]
        if code in _KEY_CODE_NAMES:
            return _KEY_CODE_NAMES[code]
        return "KEY_%d" % code
    if etype == EV_ABS:
        return ABS_NAMES.get(code, "ABS_%d" % code)
    if etype == EV_REL:
        return REL_NAMES.get(code, "REL_%d" % code)
    if etype == EV_SYN:
        return "SYN_REPORT"
    return "code_%d" % code


# Linux ioctl request encoding: dir<<30 | size<<16 | type<<8 | nr
_IOC_NONE, _IOC_WRITE = 0, 1


def _ioc(direction, typ, nr, size):
    return (direction << 30) | (size << 16) | (ord(typ) << 8) | nr


def _IO(typ, nr):
    return _ioc(_IOC_NONE, typ, nr, 0)


def _IOW(typ, nr, size):
    return _ioc(_IOC_WRITE, typ, nr, size)


UI_SET_EVBIT = _IOW("U", 100, 4)   # int
UI_SET_KEYBIT = _IOW("U", 101, 4)  # int
UI_SET_RELBIT = _IOW("U", 102, 4)  # int
UI_SET_ABSBIT = _IOW("U", 103, 4)  # int
UI_DEV_CREATE = _IO("U", 1)
UI_DEV_DESTROY = _IO("U", 2)

# struct input_event on 64-bit Linux: struct timeval (2x long) + u16 + u16 + s32
_INPUT_EVENT = "=qqHHi"
# struct uinput_user_dev: name[80], input_id{4x u16}, ff_effects_max u32,
# absmax[64], absmin[64], absfuzz[64], absflat[64] (s32 arrays) = 1116 bytes
_UINPUT_USER_DEV = "=80sHHHHI64i64i64i64i"

GAMEPAD_DEV_NAME = "Microsoft X-Box 360 pad"
GAMEPAD_BUSTYPE = 0x03
GAMEPAD_VENDOR = 0x045E
GAMEPAD_PRODUCT = 0x028E
GAMEPAD_VERSION = 0x110


class UInputGamepad:
    """Virtual Xbox 360 pad via /dev/uinput (legacy uinput_user_dev API)."""

    name = GAMEPAD_DEV_NAME

    def __init__(self):
        if fcntl is None:
            raise RuntimeError("fcntl module unavailable on this platform")
        if struct.calcsize(_UINPUT_USER_DEV) != 1116:  # survives python3 -O
            raise RuntimeError("uinput_user_dev struct packs to %d bytes, expected 1116"
                               % struct.calcsize(_UINPUT_USER_DEV))
        self.fd = None
        fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
        try:
            fcntl.ioctl(fd, UI_SET_EVBIT, EV_KEY)
            fcntl.ioctl(fd, UI_SET_EVBIT, EV_ABS)
            for code in BTN_CODES.values():
                fcntl.ioctl(fd, UI_SET_KEYBIT, code)
            for code, _lo, _hi in GAMEPAD_AXES:
                fcntl.ioctl(fd, UI_SET_ABSBIT, code)
            absmin = [0] * 64
            absmax = [0] * 64
            for code, lo, hi in GAMEPAD_AXES:
                absmin[code] = lo
                absmax[code] = hi
            setup = struct.pack(
                _UINPUT_USER_DEV,
                self.name.encode("utf-8"),
                GAMEPAD_BUSTYPE, GAMEPAD_VENDOR, GAMEPAD_PRODUCT,
                GAMEPAD_VERSION,
                0,  # ff_effects_max
                *(absmax + absmin + [0] * 64 + [0] * 64),
            )
            os.write(fd, setup)
            fcntl.ioctl(fd, UI_DEV_CREATE)
        except Exception:
            os.close(fd)
            raise
        self.fd = fd

    def emit(self, events):
        """Write (type, code, value) events followed by EV_SYN/SYN_REPORT."""
        if self.fd is None:
            return
        data = b"".join(
            struct.pack(_INPUT_EVENT, 0, 0, etype, code, value)
            for etype, code, value in events
        )
        data += struct.pack(_INPUT_EVENT, 0, 0, EV_SYN, SYN_REPORT, 0)
        os.write(self.fd, data)

    def destroy(self):
        fd, self.fd = self.fd, None
        if fd is None:
            return
        try:
            fcntl.ioctl(fd, UI_DEV_DESTROY)
        except OSError:
            pass
        try:
            os.close(fd)
        except OSError:
            pass


MOUSE_DEV_NAME = "Couchside Virtual Mouse"
MOUSE_BUSTYPE = 0x03
MOUSE_VENDOR = 0x045E
MOUSE_PRODUCT = 0x0289
MOUSE_VERSION = 0x111

KEYBOARD_DEV_NAME = "Couchside Virtual Keyboard"
KEYBOARD_BUSTYPE = 0x03
KEYBOARD_VENDOR = 0x045E
KEYBOARD_PRODUCT = 0x028A
KEYBOARD_VERSION = 0x111


def _emit_events(fd, events):
    """Pack (type, code, value) events + trailing EV_SYN and write to fd."""
    data = b"".join(
        struct.pack(_INPUT_EVENT, 0, 0, etype, code, value)
        for etype, code, value in events
    )
    data += struct.pack(_INPUT_EVENT, 0, 0, EV_SYN, SYN_REPORT, 0)
    os.write(fd, data)


class UInputMouse:
    """Virtual relative mouse: REL_X/REL_Y/REL_WHEEL + BTN_LEFT/RIGHT/MIDDLE."""

    name = MOUSE_DEV_NAME

    def __init__(self):
        if fcntl is None:
            raise RuntimeError("fcntl module unavailable on this platform")
        self.fd = None
        fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
        try:
            fcntl.ioctl(fd, UI_SET_EVBIT, EV_KEY)
            fcntl.ioctl(fd, UI_SET_EVBIT, EV_REL)
            for code in MOUSE_BTN_CODES.values():
                fcntl.ioctl(fd, UI_SET_KEYBIT, code)
            for code in MOUSE_REL_AXES:
                fcntl.ioctl(fd, UI_SET_RELBIT, code)
            setup = struct.pack(
                _UINPUT_USER_DEV,
                self.name.encode("utf-8"),
                MOUSE_BUSTYPE, MOUSE_VENDOR, MOUSE_PRODUCT, MOUSE_VERSION,
                0,  # ff_effects_max
                *([0] * 64 + [0] * 64 + [0] * 64 + [0] * 64),
            )
            os.write(fd, setup)
            fcntl.ioctl(fd, UI_DEV_CREATE)
        except Exception:
            os.close(fd)
            raise
        self.fd = fd

    def emit(self, events):
        if self.fd is None:
            return
        _emit_events(self.fd, events)

    def destroy(self):
        fd, self.fd = self.fd, None
        if fd is None:
            return
        try:
            fcntl.ioctl(fd, UI_DEV_DESTROY)
        except OSError:
            pass
        try:
            os.close(fd)
        except OSError:
            pass


class UInputKeyboard:
    """Virtual keyboard emitting the KEY_* codes in KEYBOARD_CODES."""

    name = KEYBOARD_DEV_NAME

    def __init__(self):
        if fcntl is None:
            raise RuntimeError("fcntl module unavailable on this platform")
        self.fd = None
        fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
        try:
            fcntl.ioctl(fd, UI_SET_EVBIT, EV_KEY)
            for code in KEYBOARD_CODES:
                fcntl.ioctl(fd, UI_SET_KEYBIT, code)
            setup = struct.pack(
                _UINPUT_USER_DEV,
                self.name.encode("utf-8"),
                KEYBOARD_BUSTYPE, KEYBOARD_VENDOR, KEYBOARD_PRODUCT,
                KEYBOARD_VERSION,
                0,  # ff_effects_max
                *([0] * 64 + [0] * 64 + [0] * 64 + [0] * 64),
            )
            os.write(fd, setup)
            fcntl.ioctl(fd, UI_DEV_CREATE)
        except Exception:
            os.close(fd)
            raise
        self.fd = fd

    def emit(self, events):
        if self.fd is None:
            return
        _emit_events(self.fd, events)

    def destroy(self):
        fd, self.fd = self.fd, None
        if fd is None:
            return
        try:
            fcntl.ioctl(fd, UI_DEV_DESTROY)
        except OSError:
            pass
        try:
            os.close(fd)
        except OSError:
            pass


class MockGamepad:
    """--mock stand-in: logs decoded events instead of touching uinput."""

    name = "mock"

    def emit(self, events):
        for etype, code, value in events:
            print("[gamepad] %s %s(%d) = %d" % (
                "EV_KEY" if etype == EV_KEY else "EV_ABS",
                _event_name(etype, code), code, value), flush=True)
        print("[gamepad] EV_SYN SYN_REPORT", flush=True)

    def destroy(self):
        print("[gamepad] mock device destroyed", flush=True)


def _ev_type_name(etype):
    return {EV_KEY: "EV_KEY", EV_ABS: "EV_ABS",
            EV_REL: "EV_REL", EV_SYN: "EV_SYN"}.get(etype, "EV_%d" % etype)


class MockMouse:
    """--mock stand-in for the virtual mouse: logs decoded events."""

    name = "mock-mouse"

    def emit(self, events):
        for etype, code, value in events:
            print("[mouse] %s %s(%d) = %d" % (
                _ev_type_name(etype), _event_name(etype, code), code, value),
                flush=True)
        print("[mouse] EV_SYN SYN_REPORT", flush=True)

    def destroy(self):
        print("[mouse] mock device destroyed", flush=True)


class MockKeyboard:
    """--mock stand-in for the virtual keyboard: logs decoded events."""

    name = "mock-keyboard"

    def emit(self, events):
        for etype, code, value in events:
            print("[keyboard] %s %s(%d) = %d" % (
                _ev_type_name(etype), _event_name(etype, code), code, value),
                flush=True)
        print("[keyboard] EV_SYN SYN_REPORT", flush=True)

    def destroy(self):
        print("[keyboard] mock device destroyed", flush=True)


def _scale_stick(f):
    return max(-32768, min(32767, int(round(f * 32767))))


def gamepad_events(msg):
    """Decode one client JSON message into a list of (type, code, value).

    Raises ValueError for malformed/unknown messages ("ping" is handled by
    the caller, not here).
    """
    t = msg.get("t")
    if t == "b":
        k = msg.get("k")
        v = msg.get("v")
        if v not in (0, 1):
            raise ValueError("button v must be 0 or 1")
        if k in BTN_CODES:
            return [(EV_KEY, BTN_CODES[k], v)]
        if k in DPAD_MAP:
            code, pressed = DPAD_MAP[k]
            return [(EV_ABS, code, pressed if v else 0)]
        raise ValueError("unknown button %r" % (k,))
    if t == "t":
        k = msg.get("k")
        v = msg.get("v")
        if k not in ("lt", "rt"):
            raise ValueError("unknown trigger %r" % (k,))
        if not isinstance(v, (int, float)) or isinstance(v, bool):
            raise ValueError("trigger v must be a number")
        value = max(0, min(255, int(v)))
        return [(EV_ABS, ABS_Z if k == "lt" else ABS_RZ, value)]
    if t == "s":
        k = msg.get("k")
        x = msg.get("x")
        y = msg.get("y")
        if k not in ("l", "r"):
            raise ValueError("unknown stick %r" % (k,))
        if (not isinstance(x, (int, float)) or isinstance(x, bool) or
                not isinstance(y, (int, float)) or isinstance(y, bool)):
            raise ValueError("stick x/y must be numbers")
        xcode, ycode = (ABS_X, ABS_Y) if k == "l" else (ABS_RX, ABS_RY)
        return [(EV_ABS, xcode, _scale_stick(x)),
                (EV_ABS, ycode, _scale_stick(y))]
    raise ValueError("unknown message type %r" % (t,))


def _require_int(msg, key):
    v = msg.get(key)
    if not isinstance(v, int) or isinstance(v, bool):
        raise ValueError("%s must be an integer" % key)
    return v


def mouse_events(msg):
    """Decode one mouse JSON message into a list of (type, code, value).

    Handles {"t":"m"}, {"t":"mb"}, {"t":"mw"}. Raises ValueError on malformed
    messages. The caller only routes m/mb/mw here.
    """
    t = msg.get("t")
    if t == "m":
        dx = _require_int(msg, "dx")
        dy = _require_int(msg, "dy")
        return [(EV_REL, REL_X, dx), (EV_REL, REL_Y, dy)]
    if t == "mb":
        k = msg.get("k")
        v = msg.get("v")
        if k not in MOUSE_BTN_CODES:
            raise ValueError("unknown mouse button %r" % (k,))
        if v not in (0, 1):
            raise ValueError("mouse button v must be 0 or 1")
        return [(EV_KEY, MOUSE_BTN_CODES[k], v)]
    if t == "mw":
        dy = _require_int(msg, "dy")
        return [(EV_REL, REL_WHEEL, dy)]
    raise ValueError("unknown mouse message type %r" % (t,))


def keyboard_events(msg):
    """Decode one keyboard JSON message into a list of (type, code, value).

    Handles {"t":"kt","text":...} (each char -> optional shift + key press +
    release) and {"t":"k","key":...} (one named special press+release). Raises
    ValueError on malformed messages or unsupported characters/keys.
    """
    t = msg.get("t")
    if t == "kt":
        text = msg.get("text")
        if not isinstance(text, str):
            raise ValueError("kt text must be a string")
        events = []
        for ch in text:
            entry = CHAR_KEYMAP.get(ch)
            if entry is None:
                raise ValueError("unsupported character %r" % (ch,))
            code, shift = entry
            if shift:
                events.append((EV_KEY, KEY_LEFTSHIFT, 1))
            events.append((EV_KEY, code, 1))
            events.append((EV_KEY, code, 0))
            if shift:
                events.append((EV_KEY, KEY_LEFTSHIFT, 0))
        return events
    if t == "k":
        key = msg.get("key")
        if key not in SPECIAL_KEYS:
            raise ValueError("unknown special key %r" % (key,))
        code = SPECIAL_KEYS[key]
        return [(EV_KEY, code, 1), (EV_KEY, code, 0)]
    raise ValueError("unknown keyboard message type %r" % (t,))


# ---------------------------------------------------------------------------
# Minimal RFC6455 WebSocket support (server side, no fragmentation)
# ---------------------------------------------------------------------------

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
WS_OP_TEXT, WS_OP_CLOSE, WS_OP_PING, WS_OP_PONG = 0x1, 0x8, 0x9, 0xA
WS_MAX_FRAME = 1 << 20


def ws_try_parse(buf):
    """Try to parse one complete frame from the front of buf (bytearray).

    Returns (opcode, payload) and consumes the bytes, or None if more data
    is needed. Raises ValueError on protocol violations (fragmentation,
    unmasked client frame, oversized frame).
    """
    if len(buf) < 2:
        return None
    b0, b1 = buf[0], buf[1]
    if not (b0 & 0x80) or (b0 & 0x0F) == 0:
        raise ValueError("fragmented frames not supported")
    if b0 & 0x70:
        raise ValueError("RSV bits set")
    if not (b1 & 0x80):
        raise ValueError("client frames must be masked")
    length = b1 & 0x7F
    idx = 2
    if length == 126:
        if len(buf) < 4:
            return None
        length = int.from_bytes(buf[2:4], "big")
        idx = 4
    elif length == 127:
        if len(buf) < 10:
            return None
        length = int.from_bytes(buf[2:10], "big")
        idx = 10
    if length > WS_MAX_FRAME:
        raise ValueError("frame too large")
    end = idx + 4 + length
    if len(buf) < end:
        return None
    mask = buf[idx:idx + 4]
    payload = bytearray(buf[idx + 4:end])
    for i in range(length):
        payload[i] ^= mask[i & 3]
    opcode = b0 & 0x0F
    del buf[:end]
    return opcode, bytes(payload)


def ws_recv_frame(conn, buf):
    """Return the next (opcode, payload) frame, buffering partial TCP reads.

    Returns None if the socket is dead (EOF, timeout, error). Raises
    ValueError on protocol violations.
    """
    while True:
        frame = ws_try_parse(buf)
        if frame is not None:
            return frame
        try:
            chunk = conn.recv(4096)
        except (TimeoutError, OSError):
            return None
        if not chunk:
            return None
        buf.extend(chunk)


def ws_send(conn, opcode, payload=b""):
    n = len(payload)
    header = bytes([0x80 | opcode])
    if n < 126:
        header += bytes([n])
    elif n < (1 << 16):
        header += bytes([126]) + n.to_bytes(2, "big")
    else:
        header += bytes([127]) + n.to_bytes(8, "big")
    conn.sendall(header + payload)


def ws_send_json(conn, obj):
    ws_send(conn, WS_OP_TEXT, json.dumps(obj).encode("utf-8"))


# Single active gamepad connection: a new valid connection replaces the old
# one (old uinput device destroyed first, then its socket closed).
GAMEPAD_LOCK = threading.Lock()
GAMEPAD_ACTIVE = None  # {"conn": socket, "device": gamepad-or-None}


def _gamepad_teardown(entry):
    for slot in ("device", "mouse", "keyboard"):
        dev = entry.get(slot)
        if dev is not None:
            try:
                dev.destroy()
            except Exception:
                pass
    try:
        entry["conn"].shutdown(socket.SHUT_RDWR)
    except OSError:
        pass
    try:
        entry["conn"].close()
    except OSError:
        pass


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------


class Handler(BaseHTTPRequestHandler):
    server_version = APP_NAME + "/" + VERSION
    protocol_version = "HTTP/1.1"

    # set by main()
    token = ""
    mock = False

    def log_message(self, fmt, *args):  # route BaseHTTPRequestHandler logs away
        pass

    def _log(self, code, started):
        dur_ms = int((time.monotonic() - started) * 1000)
        # Never log query strings: /ws/gamepad carries ?token=<secret>, and
        # this stdout lands in journald (which /api/journal serves back out).
        path = self.path.split("?", 1)[0]
        if "?" in self.path:
            path += "?<redacted>"
        print("%s %s %s %d %dms" % (
            self.client_address[0], self.command, path, code, dur_ms),
            flush=True)

    def _send(self, code, payload, started, extra_headers=None):
        body = b"" if payload is None else json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers",
                         "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods",
                         "GET, POST, DELETE, OPTIONS")
        if payload is not None:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if extra_headers:
            for k, v in extra_headers.items():
                self.send_header(k, v)
        self.end_headers()
        if body:
            self.wfile.write(body)
        self._log(code, started)

    def _authorized(self):
        auth = self.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return False
        supplied = auth[len("Bearer "):].strip()
        return hmac.compare_digest(supplied, self.token)

    # -- verbs ---------------------------------------------------------------

    def do_OPTIONS(self):
        started = time.monotonic()
        self._send(204, None, started)

    def do_GET(self):
        started = time.monotonic()
        try:
            parsed = urlparse(self.path)
            path = parsed.path.rstrip("/") or "/"

            if path == "/ws/gamepad":
                self._handle_gamepad_ws(parsed, started)
                return

            if path == "/api/ping":
                self._send(200, {"ok": True, "app": APP_NAME,
                                 "version": VERSION}, started)
                return

            if not path.startswith("/api/"):
                self._send(404, {"error": "not found"}, started)
                return

            if not self._authorized():
                self._send(401, {"error": "unauthorized"}, started)
                return

            if path == "/api/status":
                data = mock_status() if self.mock else real_status()
                self._send(200, data, started)
            elif path == "/api/units":
                units = mock_units() if self.mock else real_units()
                self._send(200, {"units": units}, started)
            elif path == "/api/journal":
                self._handle_journal(parsed, started)
            elif path == "/api/actions":
                actions = [
                    {"id": aid,
                     "label": ACTIONS[aid]["label"],
                     "description": ACTIONS[aid]["description"],
                     "danger": ACTIONS[aid]["danger"]}
                    for aid in ACTION_ORDER
                ]
                self._send(200, {"actions": actions}, started)
            elif path == "/api/launchers":
                self._send(200, {"launchers": list_launchers()}, started)
            else:
                self._send(404, {"error": "not found"}, started)
        except BrokenPipeError:
            pass
        except Exception as e:
            try:
                self._send(500, {"error": e.__class__.__name__}, started)
            except Exception:
                pass

    def _read_body(self):
        """Read and return the request body bytes (always drains it).

        Draining is mandatory: on an HTTP/1.1 keep-alive connection any leftover
        body bytes would be parsed as the next request line and desync it.
        """
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n <= 0:
            return b""
        return self.rfile.read(n)

    def do_POST(self):
        started = time.monotonic()
        # Always drain the body first (see _read_body) — even on the paths that
        # ignore it — so keep-alive connections never desync.
        body = self._read_body()
        try:
            parsed = urlparse(self.path)
            path = parsed.path.rstrip("/")

            if not path.startswith("/api/"):
                self._send(404, {"error": "not found"}, started)
                return

            if not self._authorized():
                self._send(401, {"error": "unauthorized"}, started)
                return

            prefix = "/api/actions/"
            if path.startswith(prefix):
                action_id = path[len(prefix):]
                if action_id not in ACTIONS:
                    self._send(404, {"error": "unknown action"}, started)
                    return
                result = (mock_action(action_id) if self.mock
                          else real_action(action_id))
                self._send(200, result, started)
                return

            # POST /api/launchers — add a custom launcher from a JSON body.
            if path == "/api/launchers":
                self._handle_add_launcher(body, started)
                return

            # POST /api/launchers/<id> — fire-and-forget launch.
            lprefix = "/api/launchers/"
            if path.startswith(lprefix):
                launcher_id = path[len(lprefix):]
                argv = _launcher_argv(launcher_id)
                if argv is None:
                    self._send(404, {"ok": False,
                                     "error": "unknown launcher"}, started)
                    return
                result = mock_launch(argv) if self.mock else real_launch(argv)
                self._send(200, result, started)
                return

            self._send(404, {"error": "not found"}, started)
        except BrokenPipeError:
            pass
        except Exception as e:
            try:
                self._send(500, {"error": e.__class__.__name__}, started)
            except Exception:
                pass

    def do_DELETE(self):
        started = time.monotonic()
        # Drain any body for keep-alive safety (DELETE bodies are unusual but
        # a client may send Content-Length: 0 or a stray body).
        self._read_body()
        try:
            parsed = urlparse(self.path)
            path = parsed.path.rstrip("/")

            if not path.startswith("/api/"):
                self._send(404, {"error": "not found"}, started)
                return

            if not self._authorized():
                self._send(401, {"error": "unauthorized"}, started)
                return

            lprefix = "/api/launchers/"
            if path.startswith(lprefix):
                launcher_id = path[len(lprefix):]
                if launcher_id.startswith("steam:"):
                    self._send(400, {"error": "not deletable"}, started)
                    return
                if not _valid_launcher_id(launcher_id):
                    self._send(404, {"error": "unknown launcher"}, started)
                    return
                if not delete_launcher(launcher_id):
                    self._send(404, {"error": "unknown launcher"}, started)
                    return
                self._send(200, {"ok": True}, started)
                return

            self._send(404, {"error": "not found"}, started)
        except BrokenPipeError:
            pass
        except Exception as e:
            try:
                self._send(500, {"error": e.__class__.__name__}, started)
            except Exception:
                pass

    def _handle_add_launcher(self, body, started):
        try:
            data = json.loads(body.decode("utf-8")) if body else None
        except (ValueError, UnicodeDecodeError):
            self._send(400, {"error": "invalid JSON body"}, started)
            return
        if not isinstance(data, dict):
            self._send(400, {"error": "body must be a JSON object"}, started)
            return
        try:
            launcher = add_launcher(data.get("label"), data.get("cmd"))
        except ConfigError as e:
            self._send(400, {"error": str(e)}, started)
            return
        self._send(200, launcher, started)

    # -- journal ---------------------------------------------------------------

    def _handle_journal(self, parsed, started):
        qs = parse_qs(parsed.query)
        unit = qs.get("unit", [""])[0]
        scope = qs.get("scope", [""])[0]
        try:
            lines = int(qs.get("lines", ["100"])[0])
        except ValueError:
            lines = 100
        lines = max(1, min(500, lines))

        if unit not in WATCHLIST_NAMES:
            self._send(400, {"error": "unit not allowed"}, started)
            return

        # derive scope from watchlist if absent/invalid
        watch_scope = dict(WATCHLIST)[unit]
        if scope not in ("system", "user"):
            scope = watch_scope

        if self.mock:
            log_lines = mock_journal(unit, scope, lines)
        else:
            log_lines = real_journal(unit, scope, lines)
        self._send(200, {"unit": unit, "scope": scope,
                         "lines": log_lines}, started)

    # -- gamepad websocket -----------------------------------------------------

    def _handle_gamepad_ws(self, parsed, started):
        # This socket never returns to HTTP keep-alive.
        self.close_connection = True

        # Auth BEFORE any handshake response: token query param.
        qs = parse_qs(parsed.query)
        supplied = qs.get("token", [""])[0]
        if not supplied or not hmac.compare_digest(supplied, self.token):
            self._send(401, {"error": "unauthorized"}, started,
                       extra_headers={"Connection": "close"})
            return

        key = self.headers.get("Sec-WebSocket-Key", "")
        upgrade = (self.headers.get("Upgrade") or "").lower()
        if upgrade != "websocket" or not key:
            self._send(400, {"error": "websocket upgrade required"}, started,
                       extra_headers={"Connection": "close"})
            return

        accept = base64.b64encode(
            hashlib.sha1((key + WS_GUID).encode("ascii")).digest()
        ).decode("ascii")
        try:
            self.connection.sendall(
                b"HTTP/1.1 101 Switching Protocols\r\n"
                b"Upgrade: websocket\r\n"
                b"Connection: Upgrade\r\n"
                b"Sec-WebSocket-Accept: " + accept.encode("ascii") +
                b"\r\n\r\n")
        except OSError:
            return
        self._log(101, started)

        try:
            self._gamepad_session()
        except Exception as e:  # never fall back to HTTP error responses
            print("[gamepad] session error: %s: %s"
                  % (e.__class__.__name__, e), flush=True)

    def _gamepad_session(self):
        global GAMEPAD_ACTIVE
        conn = self.connection
        entry = {"conn": conn, "device": None, "mouse": None, "keyboard": None}

        # One active gamepad connection: replace (and tear down) the old one.
        with GAMEPAD_LOCK:
            old, GAMEPAD_ACTIVE = GAMEPAD_ACTIVE, entry
        if old is not None:
            print("[gamepad] replacing previous connection", flush=True)
            _gamepad_teardown(old)

        mine = True
        try:
            try:
                device = MockGamepad() if self.mock else UInputGamepad()
            except Exception as e:
                print("[gamepad] device create failed: %s" % e, flush=True)
                try:
                    ws_send_json(conn, {"t": "err",
                                        "msg": "uinput unavailable: %s" % e})
                    ws_send(conn, WS_OP_CLOSE)
                except OSError:
                    pass
                return
            entry["device"] = device
            print("[gamepad] connected (%s)" % device.name, flush=True)
            ws_send_json(conn, {"t": "hello", "dev": device.name})

            conn.settimeout(60.0)
            buf = bytearray()
            while True:
                try:
                    frame = ws_recv_frame(conn, buf)
                except ValueError as e:
                    print("[gamepad] protocol violation: %s" % e, flush=True)
                    try:
                        ws_send(conn, WS_OP_CLOSE)
                    except OSError:
                        pass
                    return
                if frame is None:  # EOF / timeout / socket error -> dead
                    return
                opcode, payload = frame
                try:
                    if opcode == WS_OP_CLOSE:
                        ws_send(conn, WS_OP_CLOSE, payload[:2])
                        return
                    if opcode == WS_OP_PING:
                        ws_send(conn, WS_OP_PONG, payload)
                        continue
                    if opcode != WS_OP_TEXT:
                        continue  # ignore binary / stray pong
                    if not self._gamepad_message(conn, entry, device, payload):
                        return
                except OSError:
                    return
        finally:
            with GAMEPAD_LOCK:
                mine = GAMEPAD_ACTIVE is entry
                if mine:
                    GAMEPAD_ACTIVE = None
                # Always destroy ALL of OUR devices (destroy() is idempotent):
                # if a replacer tore us down while our gamepad was still being
                # created, it saw device=None and only closed the socket —
                # without this, that freshly created uinput device (and fd)
                # would leak as a phantom pad until service restart. The lazily
                # created mouse/keyboard are torn down here too.
                devices = [entry.get("device"), entry.get("mouse"),
                           entry.get("keyboard")]
            for dev in devices:
                if dev is not None:
                    try:
                        dev.destroy()
                    except Exception:
                        pass
            if mine:
                print("[gamepad] disconnected", flush=True)
            # socket itself is closed by the http.server machinery
            # (close_connection is set), or already closed by a replacer.

    # Message-type prefixes routed to the mouse / keyboard virtual devices.
    _MOUSE_TYPES = frozenset(("m", "mb", "mw"))
    _KEYBOARD_TYPES = frozenset(("kt", "k"))

    def _gamepad_message(self, conn, entry, device, payload):
        """Handle one text frame. Returns False when the session must end.

        Gamepad messages drive the always-present pad. Mouse (m/mb/mw) and
        keyboard (kt/k) messages drive virtual devices created lazily on first
        use and tracked in `entry` for teardown on disconnect.
        """
        try:
            msg = json.loads(payload.decode("utf-8"))
            if not isinstance(msg, dict):
                raise ValueError("message must be a JSON object")
        except (ValueError, UnicodeDecodeError):
            ws_send_json(conn, {"t": "err", "msg": "invalid JSON message"})
            ws_send(conn, WS_OP_CLOSE)
            return False
        t = msg.get("t")
        if t == "ping":
            ws_send_json(conn, {"t": "pong"})
            return True

        # Select decoder, target device slot, and lazy device factory.
        if t in self._MOUSE_TYPES:
            decode, slot = mouse_events, "mouse"
            factory = MockMouse if self.mock else UInputMouse
        elif t in self._KEYBOARD_TYPES:
            decode, slot = keyboard_events, "keyboard"
            factory = MockKeyboard if self.mock else UInputKeyboard
        else:
            decode, slot, factory = gamepad_events, None, None

        try:
            events = decode(msg)
        except ValueError as e:
            ws_send_json(conn, {"t": "err", "msg": str(e)})
            ws_send(conn, WS_OP_CLOSE)
            return False

        if slot is None:
            target = device
        else:
            target = entry.get(slot)
            if target is None:
                try:
                    target = factory()
                except Exception as e:
                    print("[gamepad] %s device create failed: %s"
                          % (slot, e), flush=True)
                    ws_send_json(conn, {"t": "err",
                                        "msg": "%s unavailable: %s" % (slot, e)})
                    ws_send(conn, WS_OP_CLOSE)
                    return False
                entry[slot] = target
                print("[gamepad] %s device created (%s)"
                      % (slot, target.name), flush=True)

        try:
            target.emit(events)
        except OSError as e:
            ws_send_json(conn, {"t": "err", "msg": "uinput write failed: %s" % e})
            ws_send(conn, WS_OP_CLOSE)
            return False
        return True


def load_token(args):
    if args.token:
        return args.token
    try:
        with open(args.token_file) as f:
            token = f.read().strip()
        if not token:
            print("error: token file %s is empty" % args.token_file,
                  file=sys.stderr)
            sys.exit(1)
        return token
    except OSError as e:
        print("error: cannot read token file %s: %s" % (args.token_file, e),
              file=sys.stderr)
        sys.exit(1)


def main():
    p = argparse.ArgumentParser(description="Couchside box agent")
    p.add_argument("--port", type=int, default=None,
                   help="listen port (overrides config; default %d)" % DEFAULT_PORT)
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--config", default=DEFAULT_CONFIG_PATH,
                   help="path to config.json (default %s)" % DEFAULT_CONFIG_PATH)
    p.add_argument("--token-file", default="/etc/couchside/token")
    p.add_argument("--token", default=None,
                   help="literal token (overrides --token-file; dev only)")
    p.add_argument("--mock", action="store_true",
                   help="serve fake data, never run real commands")
    args = p.parse_args()

    load_config(args.config)
    port = args.port if args.port is not None else (CONFIG_PORT or DEFAULT_PORT)

    Handler.token = load_token(args)
    Handler.mock = args.mock

    server = ThreadingHTTPServer((args.host, port), Handler)
    server.daemon_threads = True
    mode = "mock" if args.mock else "real"
    print("%s %s listening on %s:%d (%s mode)" % (
        APP_NAME, VERSION, args.host, port, mode), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
