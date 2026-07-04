#!/usr/bin/env python3
"""couchsided.py: box-side agent for Couchside.

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
import select
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

try:
    import fcntl  # POSIX only; uinput needs it (Linux), absent on Windows
except ImportError:  # pragma: no cover
    fcntl = None

APP_NAME = "couchside-agent"
VERSION = "2.6.0"
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
        "description": "Restart the display session (sddm), fixes a wedged/black screen",
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

# SteamOS session-switch actions, injected at load time when
# steamos-session-select exists (see _inject_session_actions). Built-in rather
# than config-driven so they appear on any SteamOS box without editing
# /etc/couchside/config.json. No sudo needed: session-select runs as the user.
SESSION_ACTIONS = {
    "switch-desktop": {
        "label": "Switch to Desktop",
        "description": "Leave Game Mode for the SteamOS desktop",
        "danger": "medium",
        # "plasma" = one-time switch to the desktop (doesn't change the default
        # login mode, so the box still boots into Game Mode). NB: session-select
        # has no "desktop" arg: valid targets are plasma*/gamescope.
        "cmd": ["steamos-session-select", "plasma"],
        "user_env": True,
        "detached": True,
    },
    "return-gamemode": {
        "label": "Return to Game Mode",
        "description": "Switch back from the desktop to Steam Game Mode",
        "danger": "medium",
        "cmd": ["steamos-session-select", "gamescope"],
        "user_env": True,
        "detached": True,
    },
}

# Suspend action, injected at load time when the scoped sudoers rule allows it
# (see _inject_suspend_action). Built-in like the session actions so it appears
# without a config edit, but gated on sudo: the agent is a system service with
# no login seat, so logind/polkit will not grant suspend, and the installer's
# sudoers rule must permit `systemctl suspend`. The app pairs this with a
# Wake-on-LAN magic packet to wake the box back up (see read_net).
SUSPEND_ACTION = {
    "label": "Suspend",
    "description": "Suspend the box to RAM; wake it from the app over Wake-on-LAN",
    "danger": "medium",
    "cmd": ["sudo", "systemctl", "suspend"],
    "user_env": False,
    "detached": True,
}

# Custom launcher limits (see the SECURITY NOTE in the launcher routes).
MAX_LAUNCHERS = 100        # cap on total custom launchers
MAX_CMD_ARGS = 64          # cap on argv count per launcher
MAX_CMD_ARG_LEN = 4096     # cap on a single argv token
MAX_LABEL_LEN = 200        # cap on a launcher label

# Effective config: set by load_config() before the server starts.
WATCHLIST = list(DEFAULT_UNITS)
WATCHLIST_NAMES = {name for name, _scope in WATCHLIST}
ACTIONS = dict(DEFAULT_ACTIONS)
ACTION_ORDER = list(DEFAULT_ACTION_ORDER)
CONFIG_PORT = None  # optional "port" from config.json
CONFIG_PANEL = None  # optional {"device","baud"} RS-232 panel-control config
LAUNCHERS = []  # list of {"id","label","cmd":[...]}, custom launchers only
CONFIG_PATH = DEFAULT_CONFIG_PATH  # remembered by load_config() for rewrites
CONFIG_LOCK = threading.Lock()  # serializes launcher config rewrites


class ConfigError(ValueError):
    pass


def _valid_launcher_id(lid):
    """A stored custom launcher id: "custom:" + a filesystem-safe slug.

    No path separators / traversal (".", "..", "/"): the id is never used as
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

    Raises ConfigError on any schema violation; the caller falls back to the
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

    # Optional RS-232 panel control (e.g. Newline TruTouch over a USB-serial
    # adapter). device must live under /dev/: this string is opened and
    # written raw command frames, so it must never be attacker-influenced or a
    # path outside the device tree.
    panel = None
    panel_raw = raw.get("panel")
    if panel_raw is not None:
        if not isinstance(panel_raw, dict):
            raise ConfigError("panel must be an object")
        device = panel_raw.get("device")
        if not isinstance(device, str) or not device.startswith("/dev/"):
            raise ConfigError("panel.device must be a string path under /dev/")
        baud = panel_raw.get("baud", 19200)
        if baud not in PANEL_BAUDS:
            raise ConfigError("panel.baud must be one of %s"
                              % ", ".join(str(b) for b in sorted(PANEL_BAUDS)))
        proto = panel_raw.get("protocol", "newline")
        if proto != "newline":
            raise ConfigError("panel.protocol must be \"newline\"")
        panel = {"device": device, "baud": int(baud), "protocol": proto}

    return units, actions, order, port, launchers, panel


def load_config(path):
    """Load config.json into the module globals; fall back to defaults."""
    global WATCHLIST, WATCHLIST_NAMES, ACTIONS, ACTION_ORDER, CONFIG_PORT
    global LAUNCHERS, CONFIG_PATH, CONFIG_PANEL
    CONFIG_PATH = path  # remembered so launcher POST/DELETE can rewrite it
    try:
        with open(path) as f:
            raw = json.load(f)
        units, actions, order, port, launchers, panel = _parse_config(raw)
    except FileNotFoundError:
        print("warning: config %s not found, using built-in generic defaults"
              % path, file=sys.stderr, flush=True)
        return
    except (OSError, ValueError) as e:  # ValueError covers JSON + ConfigError
        print("warning: invalid config %s (%s), using built-in generic defaults"
              % (path, e), file=sys.stderr, flush=True)
        return
    WATCHLIST = units
    WATCHLIST_NAMES = {name for name, _scope in WATCHLIST}
    ACTIONS = actions
    ACTION_ORDER = order
    CONFIG_PORT = port
    LAUNCHERS = launchers
    CONFIG_PANEL = panel
    print("config loaded from %s: %d units, %d actions, %d launchers"
          % (path, len(WATCHLIST), len(ACTIONS), len(LAUNCHERS)), flush=True)


def _inject_session_actions():
    """Add the SteamOS session-switch actions (Switch to Desktop / Return to
    Game Mode) when steamos-session-select is present and the config didn't
    already define them. Called after load_config so it applies whether config
    loaded or fell back to defaults. Idempotent."""
    global ACTIONS, ACTION_ORDER
    if not shutil.which("steamos-session-select"):
        return
    for aid, spec in SESSION_ACTIONS.items():
        if aid not in ACTIONS:
            ACTIONS[aid] = dict(spec)
            if aid not in ACTION_ORDER:
                ACTION_ORDER.append(aid)


def _can_sudo_suspend():
    """True when the sudoers rule lets the agent run `systemctl suspend` without
    a password. Probes with `sudo -n -l`, which lists the permission and never
    runs the command. False on any failure, so a box whose installer predates
    the suspend rule simply omits the action instead of offering a dead one."""
    try:
        r = subprocess.run(["sudo", "-n", "-l", "/usr/bin/systemctl", "suspend"],
                           capture_output=True, timeout=4)
        return r.returncode == 0
    except Exception:
        return False


def _inject_suspend_action(mock):
    """Add the Suspend action when the box can run it. In --mock it is always
    added so the app's power control can be developed off-box; in real mode it
    appears only when the sudoers rule permits suspend. Called after load_config,
    idempotent, and skipped when the config already defines a suspend action."""
    global ACTIONS, ACTION_ORDER
    if "suspend" in ACTIONS:
        return
    if not mock and not _can_sudo_suspend():
        return
    ACTIONS["suspend"] = dict(SUSPEND_ACTION)
    if "suspend" not in ACTION_ORDER:
        ACTION_ORDER.append("suspend")

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


# --- primary-interface network facts (for the app's Wake-on-LAN power path) --
# The app's power button suspends the box over the LAN while it is awake, then
# wakes it with a Wake-on-LAN magic packet once it is asleep and the agent is
# gone. For that the app needs the box's MAC, whether the link is wired (WoL
# over WiFi rarely works), and whether magic-packet wake is armed. These facts
# rarely change, so read_net() is cached for _NET_TTL seconds (see
# net_info_cached) instead of shelling out to ethtool on every status poll.
_NET_TTL = 30.0
_NET_CACHE = {"at": 0.0, "val": None}


def _default_iface():
    """Interface name of the IPv4 default route, or None. Reads /proc/net/route
    (the row whose destination is 00000000). Pure stdlib, no shell."""
    try:
        with open("/proc/net/route") as f:
            next(f)  # skip the header row
            for line in f:
                cols = line.split()
                if len(cols) > 1 and cols[1] == "00000000":
                    return cols[0]
    except (OSError, StopIteration):
        return None
    return None


def _iface_mac(iface):
    try:
        with open("/sys/class/net/%s/address" % iface) as f:
            return f.read().strip() or None
    except OSError:
        return None


def _iface_wired(iface):
    """True wired, False wireless. A wireless NIC exposes a
    /sys/class/net/<if>/wireless directory or DEVTYPE=wlan in its uevent."""
    if os.path.isdir("/sys/class/net/%s/wireless" % iface):
        return False
    try:
        with open("/sys/class/net/%s/uevent" % iface) as f:
            if "DEVTYPE=wlan" in f.read():
                return False
    except OSError:
        pass
    return True


def _iface_wol_armed(iface):
    """True when magic-packet wake (WoL flag 'g') is enabled per ethtool, False
    when disabled, None when ethtool is missing or the read fails. Reading the
    WoL state does not need root."""
    ethtool = shutil.which("ethtool")
    if not ethtool:
        return None
    try:
        r = subprocess.run([ethtool, iface], capture_output=True, text=True,
                           timeout=4)
    except Exception:
        return None
    if r.returncode != 0:
        return None
    for line in r.stdout.splitlines():
        s = line.strip()
        if s.startswith("Wake-on:"):
            return "g" in s.split(":", 1)[1]
    return None


def read_net():
    """Primary-interface facts for the app's Wake-on-LAN power path. Every field
    degrades to None when it can't be read."""
    iface = _default_iface()
    if not iface:
        return {"iface": None, "mac": None, "wired": None, "wol_armed": None}
    return {"iface": iface, "mac": _iface_mac(iface),
            "wired": _iface_wired(iface), "wol_armed": _iface_wol_armed(iface)}


def net_info_cached():
    """read_net() memoized for _NET_TTL seconds so status polls do not shell out
    to ethtool every few seconds. A lost race just recomputes, which is fine."""
    now = time.monotonic()
    if _NET_CACHE["val"] is None or now - _NET_CACHE["at"] > _NET_TTL:
        _NET_CACHE["val"] = read_net()
        _NET_CACHE["at"] = now
    return _NET_CACHE["val"]


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
            # always "100% used": meaningless and alarming on the dashboard).
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
        "net": net_info_cached(),
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
        "net": {"iface": "eth0", "mac": "de:ad:be:ef:00:01",
                "wired": True, "wol_armed": True},
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
# Launchers: custom (config) + auto-discovered Steam games
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

# Steam runtime/tool appids that ship in every library, never real games.
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

    Steam's VDF has no stdlib parser and the agent ships pure-stdlib (no pip on
    immutable distros), so rather than vendor a parser we line-scan for the one
    thing needed here: `"path"   "<value>"`. Best-effort; never raises.
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

    The id must correspond to a launcher currently in the list: a configured
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
# TV control (probe-and-appear): three interchangeable backends
#
# GET  /api/tv        -> {"available": true, "backend": "...", "adapter": "...",
#                         "ops": [...]}
# POST /api/tv/<op>   -> ActionResult; op ∈ TV_OPS
#
# The app polls GET /api/tv once per box connect and shows a compact TV strip
# only when a backend answers; both routes 404 like any unknown route when no
# backend is present, so a box with no TV hardware surfaces no strip. The "ops"
# list tells the app which controls the active backend supports, so it can hide
# the power buttons on a backend that only does volume.
#
# Backends, preferred in this order:
#   panel: RS-232 serial control (e.g. Newline TruTouch). CONFIG-DRIVEN: only
#           active when config.json names a serial device (never auto-probed,
#           so we never blast command frames at an unrelated tty). Reliable:
#           the panel MCU listens even in standby, so power-on-from-off works.
#   cec:   HDMI-CEC via cec-ctl (kernel framework) or cec-client (libcec).
#           Auto-probed; only counts when the HDMI connector is actually live.
#   soft:  the box's own audio sink via wpctl (PipeWire) or pactl (PulseAudio).
#           Volume and mute only, no power. Lowest priority, so it appears as a
#           fallback when neither panel nor CEC can drive the TV.
#
# Unified ops (TV_OPS): power_on, power_off, volume_up, volume_down, mute. The
# soft backend serves the volume/mute subset (SOFT_OPS) and rejects power ops.
# CEC has no discrete "off": power_off maps to CEC standby.
# ---------------------------------------------------------------------------

TV_OPS = ("power_on", "power_off", "volume_up", "volume_down", "mute")

# ---- CEC backend ----------------------------------------------------------
# CEC availability is re-evaluated CHEAPLY per request (see cec_current), not
# frozen at startup: the kernel-CEC path is a few sysfs reads, so a TV powered
# on after the agent started becomes controllable without a restart, and a dark
# HDMI port stays hidden. Only the expensive libcec probe (a ~6 s cec-client
# shell-out) is done once at startup and cached in CEC_LIBCEC.
CEC_CTL_BIN = None   # path to cec-ctl if on PATH, else None (set at startup)
CEC_LIBCEC = None    # cached libcec descriptor {tool,bin,device,adapter} or None


def _cec_connector_status(dev):
    """DRM connector status ('connected'/'disconnected'/…) for a /dev/cecN, or
    None if it can't be mapped. The kernel nests each CEC device's sysfs node
    under its HDMI connector dir, e.g. /sys/class/drm/card1/card1-HDMI-A-1/cec0.
    """
    name = os.path.basename(dev)
    try:
        for status_path in glob.glob("/sys/class/drm/*/*/status"):
            if os.path.isdir(os.path.join(os.path.dirname(status_path), name)):
                with open(status_path) as f:
                    return f.read().strip()
    except OSError:
        return None
    return None


def _usable_cec_dev():
    """First /dev/cec[0-9] whose HDMI connector is not 'disconnected'. Skips
    adapters bound to a dark port (box HDMI unplugged, display on DisplayPort)
    so the TV strip never appears over a dead CEC bus. A device whose connector
    can't be mapped (status None) is permitted: unknown != disconnected.

    Because cec_current() calls this per request, a display that asserts HPD
    (any powered-on TV, and the many TVs that keep HPD live in standby) is
    picked up dynamically; only a TV in deep-off that drops HPD is missed until
    it is woken once by other means (such TVs rarely CEC-wake reliably anyway)."""
    for dev in sorted(glob.glob("/dev/cec[0-9]")):
        if _cec_connector_status(dev) != "disconnected":
            return dev
    return None


def _libcec_has_adapter(cec_client_bin):
    """True if libcec's `cec-client -l` enumerates at least one adapter
    (e.g. a Pulse-Eight USB-CEC dongle). Never raises; false on any failure."""
    try:
        r = subprocess.run([cec_client_bin, "-l"], capture_output=True,
                           timeout=6)
    except Exception:
        return False
    # cec-client's `-l` output format shifts between libcec versions: newer
    # builds print a "COM port:" line per adapter, older ones only a "Found
    # devices: N" summary line, so accept either as proof of an adapter.
    out = (r.stdout or b"").decode("utf-8", "replace").lower()
    if "com port:" in out:
        return True
    for line in out.splitlines():
        s = line.strip()
        if s.startswith("found devices:"):
            try:
                return int(s.split(":", 1)[1].strip()) > 0
            except ValueError:
                return False
    return False


def set_cec(mock):
    """Startup CEC probe: cache cec-ctl's presence and (via one ~6 s shell-out)
    whether libcec sees an adapter. In --mock no CEC is registered: the mock
    TV strip runs on the panel backend (see set_panel) so development exercises
    the serial path the user is building toward."""
    global CEC_CTL_BIN, CEC_LIBCEC
    if mock:
        CEC_CTL_BIN = None
        CEC_LIBCEC = None
        return
    CEC_CTL_BIN = shutil.which("cec-ctl")
    client = shutil.which("cec-client")
    if client and _libcec_has_adapter(client):
        CEC_LIBCEC = {"tool": "cec-client", "bin": client, "device": None,
                      "adapter": "libcec adapter"}
    else:
        CEC_LIBCEC = None


def cec_current():
    """Live CEC descriptor, recomputed cheaply per call, or None. Prefers the
    kernel framework (cec-ctl) on a connected /dev/cec port (re-checked each
    call), then the cached libcec adapter. Never raises."""
    try:
        if CEC_CTL_BIN:
            dev = _usable_cec_dev()
            if dev:
                return {"tool": "cec-ctl", "bin": CEC_CTL_BIN, "device": dev,
                        "adapter": "kernel CEC (%s)" % dev}
    except Exception:
        pass
    return CEC_LIBCEC


def cec_available():
    return cec_current() is not None


def _cec_argv(cec, op):
    """Return (argv, stdin_bytes|None) for a CEC op against descriptor <cec>.
    Ops here are the CEC-internal names (power_on/standby/volume_*/mute). All
    target the TV (logical address 0); volume/mute use CEC User Control (UI)
    commands, which a TV forwards to an ARC audio system when system-audio is
    on."""
    if cec["tool"] == "cec-ctl":
        base = [cec["bin"], "-d", cec["device"], "--to", "0"]
        if op == "power_on":
            return base + ["--image-view-on"], None
        if op == "standby":
            return base + ["--standby"], None
        ui = {"volume_up": "volume-up", "volume_down": "volume-down",
              "mute": "mute"}[op]
        # Press + release in one invocation is the one-shot UI-command idiom.
        return base + ["--user-control-pressed", "ui-cmd=" + ui,
                       "--user-control-released"], None
    # cec-client (libcec): single-command mode (-s), command on stdin.
    cmd = {"power_on": "on 0", "standby": "standby 0", "volume_up": "volup",
           "volume_down": "voldown", "mute": "mute"}[op]
    return [cec["bin"], "-s", "-d", "1"], (cmd + "\n").encode("ascii")


def real_cec(op):
    """Run a CEC op via a one-shot arg-list subprocess. ActionResult-shaped."""
    start = time.monotonic()
    cec = cec_current()
    if cec is None:  # raced from available to gone (TV/HDMI dropped)
        return {"ok": False, "exit_code": -1, "stdout": "",
                "stderr": "cec backend unavailable", "duration_ms": 0}
    argv, stdin = _cec_argv(cec, op)
    try:
        r = subprocess.run(argv, input=stdin, capture_output=True, timeout=10)
    except subprocess.TimeoutExpired:
        return {"ok": False, "exit_code": -1, "stdout": "",
                "stderr": "cec command timed out",
                "duration_ms": int((time.monotonic() - start) * 1000)}
    except Exception as e:
        return {"ok": False, "exit_code": -1, "stdout": "",
                "stderr": "%s: %s" % (e.__class__.__name__, e),
                "duration_ms": int((time.monotonic() - start) * 1000)}
    out = (r.stdout or b"").decode("utf-8", "replace")
    err = (r.stderr or b"").decode("utf-8", "replace")
    return {"ok": r.returncode == 0, "exit_code": r.returncode,
            "stdout": out, "stderr": err,
            "duration_ms": int((time.monotonic() - start) * 1000)}


def mock_cec(op):
    """--mock stand-in for a CEC op: log it, never touch hardware, succeed."""
    time.sleep(0.1)
    print("[cec] %s" % op, flush=True)
    return {"ok": True, "exit_code": 0, "stdout": "[mock cec] %s\n" % op,
            "stderr": "", "duration_ms": 100}


# ---- panel backend (RS-232 serial) ----------------------------------------
# Supported serial line speeds (int -> termios constant). Membership is also
# the config validator for panel.baud (see _parse_config).
PANEL_BAUDS = {
    9600: termios.B9600,
    19200: termios.B19200,
    38400: termios.B38400,
    57600: termios.B57600,
    115200: termios.B115200,
}

# Newline TruTouch RS-232 protocol (19200 8N1). Frame is a fixed 9-byte header,
# a one-byte key code, then a 0xCF terminator: 7F 08 99 A2 B3 C4 02 FF 01 XX CF.
# The panel echoes 7F 09 99 A2 B3 C4 02 FF 01 XX 01 CF on success.
PANEL_FRAME_HEAD = bytes([0x7F, 0x08, 0x99, 0xA2, 0xB3, 0xC4, 0x02, 0xFF, 0x01])
PANEL_FRAME_TAIL = 0xCF
PANEL_CODES = {
    "power_on": 0x00,
    "power_off": 0x01,
    "mute": 0x02,
    "volume_down": 0x17,
    "volume_up": 0x18,
}

# Populated at startup by set_panel(); {"device","baud","protocol"} or None.
PANEL = None


def _panel_frame(op):
    """Build the 11-byte Newline command frame for a unified TV op."""
    return PANEL_FRAME_HEAD + bytes([PANEL_CODES[op], PANEL_FRAME_TAIL])


def _hexstr(b):
    return " ".join("%02X" % x for x in b)


def _serial_send(device, baud, frame, expect_reply=True, timeout=1.0):
    """Open <device> raw at <baud> 8N1 (pure stdlib termios), write <frame>
    bytes, optionally read a short reply. Returns the reply bytes (may be
    empty). Raises OSError on open/IO failure."""
    speed = PANEL_BAUDS[baud]
    fd = os.open(device, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    try:
        iflag, oflag, cflag, lflag, _ispeed, _ospeed, cc = termios.tcgetattr(fd)
        # 8 data bits, no parity, 1 stop bit, ignore modem lines, receiver on.
        cflag = (cflag & ~termios.CSIZE) | termios.CS8
        cflag &= ~(termios.PARENB | termios.CSTOPB)
        if hasattr(termios, "CRTSCTS"):
            cflag &= ~termios.CRTSCTS
        cflag |= (termios.CLOCAL | termios.CREAD)
        iflag &= ~(termios.IXON | termios.IXOFF | termios.IXANY)
        iflag &= ~(termios.INLCR | termios.IGNCR | termios.ICRNL)
        oflag &= ~termios.OPOST
        lflag &= ~(termios.ICANON | termios.ECHO | termios.ECHOE | termios.ISIG)
        termios.tcsetattr(fd, termios.TCSANOW,
                          [iflag, oflag, cflag, lflag, speed, speed, cc])
        termios.tcflush(fd, termios.TCIOFLUSH)
        # Write fully (device opened non-blocking; a short frame won't block,
        # but loop defensively on partial writes).
        mv = memoryview(frame)
        wdeadline = time.monotonic() + timeout
        while mv:
            try:
                n = os.write(fd, mv)
                mv = mv[n:]
            except BlockingIOError:
                if time.monotonic() >= wdeadline:
                    raise
                select.select([], [fd], [], max(0.0, wdeadline - time.monotonic()))
        termios.tcdrain(fd)
        reply = b""
        if expect_reply:
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                r, _, _ = select.select([fd], [], [],
                                        max(0.0, deadline - time.monotonic()))
                if not r:
                    break
                try:
                    chunk = os.read(fd, 64)
                except (BlockingIOError, OSError):
                    break
                if not chunk:
                    break
                reply += chunk
                if len(reply) >= 12:  # a full Newline return frame
                    break
        return reply
    finally:
        os.close(fd)


def set_panel(mock):
    """Populate the panel descriptor. In --mock a fake serial device is always
    reported so the TV strip can be developed before the RS-232 adapter exists.
    Real mode: active only when config.json named a serial device that exists."""
    global PANEL
    if mock:
        PANEL = {"device": "mock", "baud": 19200, "protocol": "newline"}
    elif CONFIG_PANEL and os.path.exists(CONFIG_PANEL["device"]):
        PANEL = dict(CONFIG_PANEL)
    else:
        PANEL = None


def panel_available():
    return PANEL is not None


def real_panel(op):
    """Send a Newline command frame over the configured serial line. Success
    means the frame was written (the panel may or may not reply); the reply, if
    any, is echoed in stdout for diagnostics. ActionResult-shaped."""
    start = time.monotonic()
    frame = _panel_frame(op)
    try:
        reply = _serial_send(PANEL["device"], PANEL["baud"], frame)
    except Exception as e:
        return {"ok": False, "exit_code": -1, "stdout": "",
                "stderr": "%s: %s" % (e.__class__.__name__, e),
                "duration_ms": int((time.monotonic() - start) * 1000)}
    stdout = "sent %s | reply %s" % (
        _hexstr(frame), _hexstr(reply) if reply else "(none)")
    return {"ok": True, "exit_code": 0, "stdout": stdout, "stderr": "",
            "duration_ms": int((time.monotonic() - start) * 1000)}


def mock_panel(op):
    """--mock stand-in: log the frame that would go out, never open a device."""
    time.sleep(0.1)
    frame = _panel_frame(op)
    print("[panel] %s -> %s" % (op, _hexstr(frame)), flush=True)
    return {"ok": True, "exit_code": 0,
            "stdout": "[mock panel] %s -> %s\n" % (op, _hexstr(frame)),
            "stderr": "", "duration_ms": 100}


# ---- soft backend (box audio via PipeWire / PulseAudio) -------------------
# Controls the box's OWN default output sink, not the TV. It offers volume and
# mute only: a software sink has no "power", so power ops are unsupported. Soft
# is the lowest-priority backend, so it surfaces only when neither panel nor CEC
# can drive the TV. That gives a box with no RS-232 and no working CEC a way to
# change its game/OS volume from the phone. Commands run in the desktop user's
# audio session (XDG_RUNTIME_DIR), never sudo.
SOFT_OPS = ("volume_up", "volume_down", "mute")
SOFT_STEP = "5%"      # volume change per press
SOFT = None           # {"tool","bin","adapter"} set at startup, or None


def _soft_tool():
    """First usable (tool, bin) for driving the default sink, or None. Prefers
    wpctl (PipeWire, which SteamOS and Bazzite use), then pactl (PulseAudio)."""
    wp = shutil.which("wpctl")
    if wp:
        return ("wpctl", wp)
    pa = shutil.which("pactl")
    if pa:
        return ("pactl", pa)
    return None


def _soft_probe_ok(tool, binp):
    """True when the default sink answers a read, i.e. a usable audio session
    exists. Runs in the user env so it finds the desktop user's PipeWire or
    PulseAudio socket. Never raises."""
    argv = ([binp, "get-volume", "@DEFAULT_AUDIO_SINK@"] if tool == "wpctl"
            else [binp, "get-sink-volume", "@DEFAULT_SINK@"])
    try:
        r = subprocess.run(argv, capture_output=True, timeout=4,
                           env=_user_env())
        return r.returncode == 0
    except Exception:
        return False


def set_soft(mock):
    """Startup probe for box-audio control. In --mock the soft backend stays
    off so the mock TV strip runs on the panel path (see set_panel)."""
    global SOFT
    if mock:
        SOFT = None
        return
    tool = _soft_tool()
    if tool and _soft_probe_ok(*tool):
        SOFT = {"tool": tool[0], "bin": tool[1],
                "adapter": "%s (default sink)" % tool[0]}
    else:
        SOFT = None


def soft_available():
    return SOFT is not None


def _soft_argv(op):
    """argv for a soft op against the default sink. On wpctl the volume is
    clamped to 1.0 (-l 1.0) so a press cannot push PipeWire past 100%."""
    tool, binp = SOFT["tool"], SOFT["bin"]
    if tool == "wpctl":
        sink = "@DEFAULT_AUDIO_SINK@"
        if op == "volume_up":
            return [binp, "set-volume", "-l", "1.0", sink, SOFT_STEP + "+"]
        if op == "volume_down":
            return [binp, "set-volume", sink, SOFT_STEP + "-"]
        return [binp, "set-mute", sink, "toggle"]
    sink = "@DEFAULT_SINK@"
    if op == "volume_up":
        return [binp, "set-sink-volume", sink, "+" + SOFT_STEP]
    if op == "volume_down":
        return [binp, "set-sink-volume", sink, "-" + SOFT_STEP]
    return [binp, "set-sink-mute", sink, "toggle"]


def real_soft(op):
    """Run a box-audio op in the desktop user's session. ActionResult-shaped.
    Power ops are rejected here because a sink cannot be powered on or off."""
    start = time.monotonic()
    if op not in SOFT_OPS:
        return {"ok": False, "exit_code": -1, "stdout": "",
                "stderr": "%s is not available on the soft-audio backend" % op,
                "duration_ms": 0}
    argv = _soft_argv(op)
    try:
        r = subprocess.run(argv, capture_output=True, timeout=5,
                           env=_user_env())
    except subprocess.TimeoutExpired:
        return {"ok": False, "exit_code": -1, "stdout": "",
                "stderr": "audio command timed out",
                "duration_ms": int((time.monotonic() - start) * 1000)}
    except Exception as e:
        return {"ok": False, "exit_code": -1, "stdout": "",
                "stderr": "%s: %s" % (e.__class__.__name__, e),
                "duration_ms": int((time.monotonic() - start) * 1000)}
    out = (r.stdout or b"").decode("utf-8", "replace")
    err = (r.stderr or b"").decode("utf-8", "replace")
    return {"ok": r.returncode == 0, "exit_code": r.returncode,
            "stdout": out, "stderr": err,
            "duration_ms": int((time.monotonic() - start) * 1000)}


def mock_soft(op):
    """--mock stand-in for a box-audio op: log it, touch nothing, succeed."""
    time.sleep(0.1)
    print("[soft] %s" % op, flush=True)
    return {"ok": True, "exit_code": 0, "stdout": "[mock soft] %s\n" % op,
            "stderr": "", "duration_ms": 100}


# ---- unified dispatch -----------------------------------------------------
# CEC has no discrete power-off; its standby command IS the off state.
_TV_TO_CEC = {"power_on": "power_on", "power_off": "standby",
              "volume_up": "volume_up", "volume_down": "volume_down",
              "mute": "mute"}


def set_tv(mock):
    """Probe every TV backend at startup (call after load_config)."""
    set_cec(mock)
    set_panel(mock)
    set_soft(mock)


def tv_backend():
    """Active backend name, or None when no backend exists. The serial panel is
    preferred over CEC because it is reliable and can power on from standby;
    soft (box audio) is the last resort when neither can drive the TV."""
    if panel_available():
        return "panel"
    if cec_available():
        return "cec"
    if soft_available():
        return "soft"
    return None


def tv_info():
    """GET /api/tv body, or None when no backend is available. "ops" lists the
    controls the active backend supports so the app can hide the rest."""
    b = tv_backend()
    if b == "panel":
        return {"available": True, "backend": "panel",
                "adapter": "Newline RS-232 (%s @ %d)"
                           % (PANEL["device"], PANEL["baud"]),
                "ops": list(TV_OPS)}
    if b == "cec":
        cec = cec_current()
        adapter = cec["adapter"] if cec else "CEC"
        return {"available": True, "backend": "cec", "adapter": adapter,
                "ops": list(TV_OPS)}
    if b == "soft":
        return {"available": True, "backend": "soft",
                "adapter": SOFT["adapter"], "ops": list(SOFT_OPS)}
    return None


def tv_send(op, mock):
    """Dispatch a unified TV op to the active backend. Returns an ActionResult,
    or None when no backend is available (caller 404s)."""
    b = tv_backend()
    if b == "panel":
        return mock_panel(op) if mock else real_panel(op)
    if b == "cec":
        cec_op = _TV_TO_CEC[op]
        return mock_cec(cec_op) if mock else real_cec(cec_op)
    if b == "soft":
        return mock_soft(op) if mock else real_soft(op)
    return None


# ---------------------------------------------------------------------------
# Virtual gamepad: evdev/uinput constants and pure-stdlib uinput driver
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

# (axis code, absmin, absmax): all axes the virtual pad declares
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
# Virtual mouse: evdev EV_REL / EV_KEY (buttons)
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
# Virtual keyboard: evdev EV_KEY over KEY_* codes
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


# Python's stdlib has no helper for ioctl request numbers, so reproduce the
# kernel's _IOC macros from <asm-generic/ioctl.h> by hand: each uinput request
# below is built as direction<<30 | size<<16 | type<<8 | nr, the same way the C
# header builds it.
_IOC_NONE, _IOC_WRITE = 0, 1


def _ioc(direction, typ, nr, size):
    return (direction << 30) | (size << 16) | (ord(typ) << 8) | nr


def _IO(typ, nr):
    return _ioc(_IOC_NONE, typ, nr, 0)


def _IOW(typ, nr, size):
    return _ioc(_IOC_WRITE, typ, nr, size)


# uinput's own ioctls. "U" is uinput's magic type byte; the numbers and the
# int-sized argument come straight from <linux/uinput.h>.
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
        # A real size check, not an assert (python3 -O strips asserts). A struct
        # that packed to the wrong size would silently scramble the descriptor
        # handed to the kernel; 1116 is the fixed uinput_user_dev size.
        if struct.calcsize(_UINPUT_USER_DEV) != 1116:  # survives python3 -O
            raise RuntimeError("uinput_user_dev struct packs to %d bytes, expected 1116"
                               % struct.calcsize(_UINPUT_USER_DEV))
        self.fd = None
        fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
        try:
            # Legacy uinput handshake, strictly in this order: declare which
            # event types and codes the device can emit (UI_SET_*), write the
            # uinput_user_dev descriptor, then UI_DEV_CREATE to bring it to life.
            fcntl.ioctl(fd, UI_SET_EVBIT, EV_KEY)   # buttons
            fcntl.ioctl(fd, UI_SET_EVBIT, EV_ABS)   # sticks, triggers, dpad
            for code in BTN_CODES.values():
                fcntl.ioctl(fd, UI_SET_KEYBIT, code)
            for code, _lo, _hi in GAMEPAD_AXES:
                fcntl.ioctl(fd, UI_SET_ABSBIT, code)
            # Axis ranges are indexed by the ABS_* code itself, so the arrays
            # need a slot for every possible code (64). The concrete per-axis
            # numbers (signed sticks, 0..255 triggers) live in GAMEPAD_AXES.
            absmin = [0] * 64
            absmax = [0] * 64
            for code, lo, hi in GAMEPAD_AXES:
                absmin[code] = lo
                absmax[code] = hi
            # The struct ends with four s32[64] arrays: absmax, absmin, absfuzz,
            # absflat. We fill max/min and leave fuzz/flat zero (no dead zone or
            # jitter filter here; the phone side already smooths the sticks).
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
    # Byte 0 packs FIN (0x80), three RSV bits (0x70), and the opcode (0x0F);
    # byte 1 packs the MASK bit (0x80) and a 7-bit length (0x7F). The app only
    # ever sends whole, single-frame, masked messages, so anything else is a
    # protocol violation we reject rather than try to handle.
    if not (b0 & 0x80) or (b0 & 0x0F) == 0:
        raise ValueError("fragmented frames not supported")
    if b0 & 0x70:
        raise ValueError("RSV bits set")
    if not (b1 & 0x80):
        raise ValueError("client frames must be masked")
    length = b1 & 0x7F
    idx = 2
    # A 7-bit length of 126 means the real length is the next 2 bytes, 127 the
    # next 8, both big-endian.
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
    # The 4-byte masking key sits right before the payload; unmask by XOR-ing
    # each byte with the key byte it cycles through (i mod 4).
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
    # Server frames are never masked. The header is FIN|opcode, then the length
    # in its smallest form: inline 7-bit when under 126, otherwise the 126+u16
    # or 127+u64 escape (this mirrors the read side in ws_try_parse).
    n = len(payload)
    header = bytes([0x80 | opcode])   # 0x80 = FIN, i.e. a complete message
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
# Pairing QR page (GET /pair): LOCALHOST-ONLY, serves the pairing deep link
# as an offline-rendered QR so the box's own TV can show it in Game Mode.
#
# SECURITY: /pair exposes the pairing token in the clear, so it is gated to
# loopback clients only (see Handler.do_GET). It is NOT under /api and is NOT
# bearer-authed: the loopback check IS the entire security model.
# ---------------------------------------------------------------------------

# Inlined, MIT-licensed pure-JS QR generator (Kazuhiko Arase's
# qrcode-generator, reduced to 8-bit byte mode / EC level M / auto type).
# Rendered fully client-side and OFFLINE: no CDN, so it works on a box with
# no internet. Exposes a global `qrcode(typeNumber)` factory.
PAIR_QR_JS = r"""
var qrcode = (function () {
  function QR8bitByte(data) { this.mode = 4; this.data = data; this.parsedData = [];
    for (var i = 0, l = this.data.length; i < l; i++) {
      var byteArray = [], code = this.data.charCodeAt(i);
      if (code > 0x10000) { byteArray[0]=0xF0|((code&0x1C0000)>>>18); byteArray[1]=0x80|((code&0x3F000)>>>12); byteArray[2]=0x80|((code&0xFC0)>>>6); byteArray[3]=0x80|(code&0x3F); }
      else if (code > 0x800) { byteArray[0]=0xE0|((code&0xF000)>>>12); byteArray[1]=0x80|((code&0xFC0)>>>6); byteArray[2]=0x80|(code&0x3F); }
      else if (code > 0x80) { byteArray[0]=0xC0|((code&0x7C0)>>>6); byteArray[1]=0x80|(code&0x3F); }
      else { byteArray[0]=code; }
      this.parsedData.push(byteArray);
    }
    this.parsedData = Array.prototype.concat.apply([], this.parsedData);
    if (this.parsedData.length != this.data.length) { this.parsedData.unshift(191); this.parsedData.unshift(187); this.parsedData.unshift(239); }
  }
  QR8bitByte.prototype = { getLength: function () { return this.parsedData.length; },
    write: function (buffer) { for (var i=0,l=this.parsedData.length;i<l;i++){ buffer.put(this.parsedData[i],8);} } };

  function QRCodeModel(typeNumber, errorCorrectLevel) { this.typeNumber=typeNumber; this.errorCorrectLevel=errorCorrectLevel; this.modules=null; this.moduleCount=0; this.dataCache=null; this.dataList=[]; }
  QRCodeModel.prototype = {
    addData: function (data) { var d = new QR8bitByte(data); this.dataList.push(d); this.dataCache=null; },
    isDark: function (row, col) { if (row<0||this.moduleCount<=row||col<0||this.moduleCount<=col) throw new Error(row+","+col); return this.modules[row][col]; },
    getModuleCount: function () { return this.moduleCount; },
    make: function () { this.makeImpl(false, this.getBestMaskPattern()); },
    makeImpl: function (test, maskPattern) {
      this.moduleCount = this.typeNumber*4+17; this.modules = new Array(this.moduleCount);
      for (var row=0;row<this.moduleCount;row++){ this.modules[row]=new Array(this.moduleCount); for (var col=0;col<this.moduleCount;col++) this.modules[row][col]=null; }
      this.setupPositionProbePattern(0,0); this.setupPositionProbePattern(this.moduleCount-7,0); this.setupPositionProbePattern(0,this.moduleCount-7);
      this.setupPositionAdjustPattern(); this.setupTimingPattern(); this.setupTypeInfo(test, maskPattern);
      if (this.typeNumber>=7) this.setupTypeNumber(test);
      if (this.dataCache==null) this.dataCache = QRCodeModel.createData(this.typeNumber, this.errorCorrectLevel, this.dataList);
      this.mapData(this.dataCache, maskPattern);
    },
    setupPositionProbePattern: function (row, col) {
      for (var r=-1;r<=7;r++){ if (row+r<=-1||this.moduleCount<=row+r) continue;
        for (var c=-1;c<=7;c++){ if (col+c<=-1||this.moduleCount<=col+c) continue;
          if ((0<=r&&r<=6&&(c==0||c==6))||(0<=c&&c<=6&&(r==0||r==6))||(2<=r&&r<=4&&2<=c&&c<=4)) this.modules[row+r][col+c]=true; else this.modules[row+r][col+c]=false; } } },
    getBestMaskPattern: function () { var minLostPoint=0, pattern=0;
      for (var i=0;i<8;i++){ this.makeImpl(true,i); var lostPoint=QRUtil.getLostPoint(this); if (i==0||minLostPoint>lostPoint){ minLostPoint=lostPoint; pattern=i; } } return pattern; },
    setupTimingPattern: function () { for (var r=8;r<this.moduleCount-8;r++){ if (this.modules[r][6]!=null) continue; this.modules[r][6]=(r%2==0); }
      for (var c=8;c<this.moduleCount-8;c++){ if (this.modules[6][c]!=null) continue; this.modules[6][c]=(c%2==0); } },
    setupPositionAdjustPattern: function () { var pos=QRUtil.getPatternPosition(this.typeNumber);
      for (var i=0;i<pos.length;i++){ for (var j=0;j<pos.length;j++){ var row=pos[i],col=pos[j]; if (this.modules[row][col]!=null) continue;
        for (var r=-2;r<=2;r++){ for (var c=-2;c<=2;c++){ if (r==-2||r==2||c==-2||c==2||(r==0&&c==0)) this.modules[row+r][col+c]=true; else this.modules[row+r][col+c]=false; } } } } },
    setupTypeNumber: function (test) { var bits=QRUtil.getBCHTypeNumber(this.typeNumber);
      for (var i=0;i<18;i++){ var mod=(!test&&((bits>>i)&1)==1); this.modules[Math.floor(i/3)][i%3+this.moduleCount-8-3]=mod; }
      for (var i=0;i<18;i++){ var mod=(!test&&((bits>>i)&1)==1); this.modules[i%3+this.moduleCount-8-3][Math.floor(i/3)]=mod; } },
    setupTypeInfo: function (test, maskPattern) { var data=(this.errorCorrectLevel<<3)|maskPattern; var bits=QRUtil.getBCHTypeInfo(data);
      for (var i=0;i<15;i++){ var mod=(!test&&((bits>>i)&1)==1);
        if (i<6) this.modules[i][8]=mod; else if (i<8) this.modules[i+1][8]=mod; else this.modules[this.moduleCount-15+i][8]=mod; }
      for (var i=0;i<15;i++){ var mod=(!test&&((bits>>i)&1)==1);
        if (i<8) this.modules[8][this.moduleCount-i-1]=mod; else if (i<9) this.modules[8][15-i-1+1]=mod; else this.modules[8][15-i-1]=mod; }
      this.modules[this.moduleCount-8][8]=(!test); },
    mapData: function (data, maskPattern) { var inc=-1,row=this.moduleCount-1,bitIndex=7,byteIndex=0;
      for (var col=this.moduleCount-1;col>0;col-=2){ if (col==6) col--;
        while (true){ for (var c=0;c<2;c++){ if (this.modules[row][col-c]==null){ var dark=false; if (byteIndex<data.length) dark=(((data[byteIndex]>>>bitIndex)&1)==1);
          var mask=QRUtil.getMask(maskPattern,row,col-c); if (mask) dark=!dark; this.modules[row][col-c]=dark; bitIndex--; if (bitIndex==-1){ byteIndex++; bitIndex=7; } } }
          row+=inc; if (row<0||this.moduleCount<=row){ row-=inc; inc=-inc; break; } } } }
  };
  QRCodeModel.PAD0=0xEC; QRCodeModel.PAD1=0x11;
  QRCodeModel.createData = function (typeNumber, errorCorrectLevel, dataList) {
    var rsBlocks=QRRSBlock.getRSBlocks(typeNumber, errorCorrectLevel); var buffer=new QRBitBuffer();
    for (var i=0;i<dataList.length;i++){ var data=dataList[i]; buffer.put(data.mode,4); buffer.put(data.getLength(), QRUtil.getLengthInBits(data.mode, typeNumber)); data.write(buffer); }
    var totalDataCount=0; for (var i=0;i<rsBlocks.length;i++) totalDataCount+=rsBlocks[i].dataCount;
    if (buffer.getLengthInBits()>totalDataCount*8) throw new Error("code length overflow. ("+buffer.getLengthInBits()+">"+totalDataCount*8+")");
    if (buffer.getLengthInBits()+4<=totalDataCount*8) buffer.put(0,4);
    while (buffer.getLengthInBits()%8!=0) buffer.putBit(false);
    while (true){ if (buffer.getLengthInBits()>=totalDataCount*8) break; buffer.put(QRCodeModel.PAD0,8); if (buffer.getLengthInBits()>=totalDataCount*8) break; buffer.put(QRCodeModel.PAD1,8); }
    return QRCodeModel.createBytes(buffer, rsBlocks);
  };
  QRCodeModel.createBytes = function (buffer, rsBlocks) {
    var offset=0, maxDcCount=0, maxEcCount=0; var dcdata=new Array(rsBlocks.length), ecdata=new Array(rsBlocks.length);
    for (var r=0;r<rsBlocks.length;r++){ var dcCount=rsBlocks[r].dataCount, ecCount=rsBlocks[r].totalCount-dcCount; maxDcCount=Math.max(maxDcCount,dcCount); maxEcCount=Math.max(maxEcCount,ecCount);
      dcdata[r]=new Array(dcCount); for (var i=0;i<dcdata[r].length;i++) dcdata[r][i]=0xff&buffer.buffer[i+offset]; offset+=dcCount;
      var rsPoly=QRUtil.getErrorCorrectPolynomial(ecCount); var rawPoly=new QRPolynomial(dcdata[r], rsPoly.getLength()-1); var modPoly=rawPoly.mod(rsPoly); ecdata[r]=new Array(rsPoly.getLength()-1);
      for (var i=0;i<ecdata[r].length;i++){ var modIndex=i+modPoly.getLength()-ecdata[r].length; ecdata[r][i]=(modIndex>=0)?modPoly.get(modIndex):0; } }
    var totalCodeCount=0; for (var i=0;i<rsBlocks.length;i++) totalCodeCount+=rsBlocks[i].totalCount;
    var data=new Array(totalCodeCount), index=0;
    for (var i=0;i<maxDcCount;i++){ for (var r=0;r<rsBlocks.length;r++){ if (i<dcdata[r].length) data[index++]=dcdata[r][i]; } }
    for (var i=0;i<maxEcCount;i++){ for (var r=0;r<rsBlocks.length;r++){ if (i<ecdata[r].length) data[index++]=ecdata[r][i]; } }
    return data;
  };

  var QRErrorCorrectLevel = { M: 0 };
  var QRUtil = {
    PATTERN_POSITION_TABLE: [[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50],[6,30,54],[6,32,58],[6,34,62],[6,26,46,66],[6,26,48,70],[6,26,50,74],[6,30,54,78],[6,30,56,82],[6,30,58,86],[6,34,62,90],[6,28,50,72,94],[6,26,50,74,98],[6,30,54,78,102],[6,28,54,80,106],[6,32,58,84,110],[6,30,58,86,114],[6,34,62,90,118],[6,26,50,74,98,122],[6,30,54,78,102,126],[6,26,52,78,104,130],[6,30,56,82,108,134],[6,34,60,86,112,138],[6,30,58,86,114,142],[6,34,62,90,118,146],[6,30,54,78,102,126,150],[6,24,50,76,102,128,154],[6,28,54,80,106,132,158],[6,32,58,84,110,136,162],[6,26,54,82,110,138,166],[6,30,58,86,114,142,170]],
    G15: (1<<10)|(1<<8)|(1<<5)|(1<<4)|(1<<2)|(1<<1)|(1<<0),
    G18: (1<<12)|(1<<11)|(1<<10)|(1<<9)|(1<<8)|(1<<5)|(1<<2)|(1<<0),
    G15_MASK: (1<<14)|(1<<12)|(1<<10)|(1<<4)|(1<<1),
    getBCHTypeInfo: function (data) { var d=data<<10; while (QRUtil.getBCHDigit(d)-QRUtil.getBCHDigit(QRUtil.G15)>=0) d^=(QRUtil.G15<<(QRUtil.getBCHDigit(d)-QRUtil.getBCHDigit(QRUtil.G15))); return ((data<<10)|d)^QRUtil.G15_MASK; },
    getBCHTypeNumber: function (data) { var d=data<<12; while (QRUtil.getBCHDigit(d)-QRUtil.getBCHDigit(QRUtil.G18)>=0) d^=(QRUtil.G18<<(QRUtil.getBCHDigit(d)-QRUtil.getBCHDigit(QRUtil.G18))); return (data<<12)|d; },
    getBCHDigit: function (data) { var digit=0; while (data!=0){ digit++; data>>>=1; } return digit; },
    getPatternPosition: function (typeNumber) { return QRUtil.PATTERN_POSITION_TABLE[typeNumber-1]; },
    getMask: function (maskPattern, i, j) { switch (maskPattern){
      case 0: return (i+j)%2==0; case 1: return i%2==0; case 2: return j%3==0; case 3: return (i+j)%3==0;
      case 4: return (Math.floor(i/2)+Math.floor(j/3))%2==0; case 5: return (i*j)%2+(i*j)%3==0;
      case 6: return ((i*j)%2+(i*j)%3)%2==0; case 7: return ((i*j)%3+(i+j)%2)%2==0; default: throw new Error("bad maskPattern:"+maskPattern); } },
    getErrorCorrectPolynomial: function (errorCorrectLength) { var a=new QRPolynomial([1],0); for (var i=0;i<errorCorrectLength;i++) a=a.multiply(new QRPolynomial([1,QRMath.gexp(i)],0)); return a; },
    getLengthInBits: function (mode, type) { if (1<=type&&type<10) return 8; else if (type<27) return 16; else if (type<41) return 16; else throw new Error("type:"+type); },
    getLostPoint: function (qrCode) { var moduleCount=qrCode.getModuleCount(), lostPoint=0;
      for (var row=0;row<moduleCount;row++){ for (var col=0;col<moduleCount;col++){ var sameCount=0, dark=qrCode.isDark(row,col);
        for (var r=-1;r<=1;r++){ if (row+r<0||moduleCount<=row+r) continue; for (var c=-1;c<=1;c++){ if (col+c<0||moduleCount<=col+c) continue; if (r==0&&c==0) continue; if (dark==qrCode.isDark(row+r,col+c)) sameCount++; } }
        if (sameCount>5) lostPoint+=(3+sameCount-5); } }
      for (var row=0;row<moduleCount-1;row++){ for (var col=0;col<moduleCount-1;col++){ var count=0; if (qrCode.isDark(row,col)) count++; if (qrCode.isDark(row+1,col)) count++; if (qrCode.isDark(row,col+1)) count++; if (qrCode.isDark(row+1,col+1)) count++; if (count==0||count==4) lostPoint+=3; } }
      for (var row=0;row<moduleCount;row++){ for (var col=0;col<moduleCount-6;col++){ if (qrCode.isDark(row,col)&&!qrCode.isDark(row,col+1)&&qrCode.isDark(row,col+2)&&qrCode.isDark(row,col+3)&&qrCode.isDark(row,col+4)&&!qrCode.isDark(row,col+5)&&qrCode.isDark(row,col+6)) lostPoint+=40; } }
      for (var col=0;col<moduleCount;col++){ for (var row=0;row<moduleCount-6;row++){ if (qrCode.isDark(row,col)&&!qrCode.isDark(row+1,col)&&qrCode.isDark(row+2,col)&&qrCode.isDark(row+3,col)&&qrCode.isDark(row+4,col)&&!qrCode.isDark(row+5,col)&&qrCode.isDark(row+6,col)) lostPoint+=40; } }
      var darkCount=0; for (var col=0;col<moduleCount;col++){ for (var row=0;row<moduleCount;row++){ if (qrCode.isDark(row,col)) darkCount++; } }
      var ratio=Math.abs(100*darkCount/moduleCount/moduleCount-50)/5; lostPoint+=ratio*10; return lostPoint; }
  };
  var QRMath = { glog: function (n) { if (n<1) throw new Error("glog("+n+")"); return QRMath.LOG_TABLE[n]; },
    gexp: function (n) { while (n<0) n+=255; while (n>=256) n-=255; return QRMath.EXP_TABLE[n]; },
    EXP_TABLE: new Array(256), LOG_TABLE: new Array(256) };
  for (var i=0;i<8;i++) QRMath.EXP_TABLE[i]=1<<i;
  for (var i=8;i<256;i++) QRMath.EXP_TABLE[i]=QRMath.EXP_TABLE[i-4]^QRMath.EXP_TABLE[i-5]^QRMath.EXP_TABLE[i-6]^QRMath.EXP_TABLE[i-8];
  for (var i=0;i<255;i++) QRMath.LOG_TABLE[QRMath.EXP_TABLE[i]]=i;

  function QRPolynomial(num, shift) { if (num.length==undefined) throw new Error(num.length+"/"+shift); var offset=0; while (offset<num.length&&num[offset]==0) offset++;
    this.num=new Array(num.length-offset+shift); for (var i=0;i<num.length-offset;i++) this.num[i]=num[i+offset]; }
  QRPolynomial.prototype = { get: function (index) { return this.num[index]; }, getLength: function () { return this.num.length; },
    multiply: function (e) { var num=new Array(this.getLength()+e.getLength()-1);
      for (var i=0;i<this.getLength();i++){ for (var j=0;j<e.getLength();j++){ num[i+j]^=QRMath.gexp(QRMath.glog(this.get(i))+QRMath.glog(e.get(j))); } } return new QRPolynomial(num,0); },
    mod: function (e) { if (this.getLength()-e.getLength()<0) return this; var ratio=QRMath.glog(this.get(0))-QRMath.glog(e.get(0)); var num=new Array(this.getLength());
      for (var i=0;i<this.getLength();i++) num[i]=this.get(i); for (var i=0;i<e.getLength();i++) num[i]^=QRMath.gexp(QRMath.glog(e.get(i))+ratio); return new QRPolynomial(num,0).mod(e); } };

  function QRRSBlock(totalCount, dataCount) { this.totalCount=totalCount; this.dataCount=dataCount; }
  QRRSBlock.RS_BLOCK_TABLE = [
    [1,26,16],[1,44,28],[1,70,44],[2,50,32],[2,67,43],[4,43,27],[4,49,31],[2,60,38,2,61,39],[3,58,24,2,59,25],
    [4,69,43,1,70,44],[1,80,50,4,81,51],[6,58,36,2,59,37],[8,59,37,1,60,38],[4,64,40,5,65,41],[5,65,41,5,66,42],
    [7,73,45,3,74,46],[10,74,46,1,75,47],[9,69,43,4,70,44],[3,70,44,11,71,45],[3,67,41,13,68,42],[17,68,42],
    [17,74,46],[4,75,47,14,76,48],[6,73,45,14,74,46],[8,75,47,13,76,48],[19,74,46,4,75,47],[22,73,45,3,74,46],
    [3,73,45,23,74,46],[21,73,45,7,74,46],[19,75,47,10,76,48],[2,74,46,29,75,47],[10,74,46,23,75,47],
    [14,74,46,21,75,47],[14,74,46,23,75,47],[12,75,47,26,76,48],[6,75,47,34,76,48],[29,74,46,14,75,47],
    [13,74,46,32,75,47],[40,75,47,7,76,48],[18,75,47,31,76,48]
  ];
  QRRSBlock.getRSBlocks = function (typeNumber, errorCorrectLevel) {
    var rsBlock = QRRSBlock.RS_BLOCK_TABLE[typeNumber-1]; if (rsBlock==undefined) throw new Error("bad rs block @ typeNumber:"+typeNumber);
    var length=rsBlock.length/3, list=[];
    for (var i=0;i<length;i++){ var count=rsBlock[i*3+0], totalCount=rsBlock[i*3+1], dataCount=rsBlock[i*3+2]; for (var j=0;j<count;j++) list.push(new QRRSBlock(totalCount, dataCount)); }
    return list;
  };

  function QRBitBuffer() { this.buffer=[]; this.length=0; }
  QRBitBuffer.prototype = { get: function (index) { var bufIndex=Math.floor(index/8); return ((this.buffer[bufIndex]>>>(7-index%8))&1)==1; },
    put: function (num, length) { for (var i=0;i<length;i++) this.putBit(((num>>>(length-i-1))&1)==1); },
    getLengthInBits: function () { return this.length; },
    putBit: function (bit) { var bufIndex=Math.floor(this.length/8); if (this.buffer.length<=bufIndex) this.buffer.push(0); if (bit) this.buffer[bufIndex]|=(0x80>>>(this.length%8)); this.length++; } };

  var _factory = function (typeNumber) {
    var _model = null;
    return {
      addData: function (data) {
        var t = typeNumber || 0;
        if (t === 0) {
          for (t = 1; t <= 40; t++) {
            try { var m = new QRCodeModel(t, QRErrorCorrectLevel.M); m.addData(data); m.make(); _model = m; break; }
            catch (e) { _model = null; }
          }
          if (!_model) throw new Error("data too long for QR level M");
        } else {
          _model = new QRCodeModel(t, QRErrorCorrectLevel.M); _model.addData(data); _model.make();
        }
      },
      make: function () { if (_model === null) throw new Error("call addData first"); },
      getModuleCount: function () { return _model.getModuleCount(); },
      isDark: function (r, c) { return _model.isDark(r, c); }
    };
  };
  return _factory;
})();
"""


def _pair_hostname():
    """Short hostname + .local for the pairing deep link (mDNS reachable)."""
    host = socket.gethostname().split(".")[0] or "localhost"
    return host + ".local"


def _pair_lan_ip():
    """Best-effort primary LAN IP for the pairing deep link's &ip= fallback.

    UDP connect() picks the interface the default route would use without
    sending a single packet. Returns None when it can't be determined (or is
    loopback); the ip param is simply omitted then.
    """
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("192.0.2.1", 9))  # TEST-NET-1: never actually sent
            ip = s.getsockname()[0]
        finally:
            s.close()
        return None if ip.startswith("127.") else ip
    except OSError:
        return None


def build_pair_url(token, port):
    """The Couchside pairing link.

    HTTPS (not couchside://) because Android camera apps won't open custom
    schemes from a QR code; every scanner opens https. couchside.tv/pair
    relaunches the app via the scheme (or shows install links). The params
    ride the URL #FRAGMENT, which browsers never send to the server: the
    token stays between the QR and the phone.

    host= stays the mDNS name (survives DHCP lease changes); ip= is the
    current LAN IP the app caches as a fallback for when mDNS breaks (e.g.
    SteamOS Game Mode WiFi power-save).
    """
    from urllib.parse import quote
    url = "https://couchside.tv/pair#host=%s&port=%d&token=%s" % (
        quote(_pair_hostname(), safe=""), port, quote(token, safe=""))
    ip = _pair_lan_ip()
    if ip:
        url += "&ip=" + quote(ip, safe="")
    return url


def render_pair_page(token, port):
    """Self-contained dark HTML page rendering the pairing QR offline.

    The pairing URL is injected as a JSON string literal (json.dumps) so it is
    safely escaped for the inline <script>. The QR is drawn client-side to a
    canvas from the inlined generator above; the couchside:// URL is shown as a
    small text fallback. No external resources: works on a box with no net.
    """
    pair_url = build_pair_url(token, port)
    url_js = json.dumps(pair_url)          # safe JS string literal
    url_html = (pair_url.replace("&", "&amp;").replace("<", "&lt;")
                        .replace(">", "&gt;"))  # safe HTML text
    return (
        "<!doctype html><html lang=\"en\"><head>"
        "<meta charset=\"utf-8\">"
        "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
        "<title>Pair Couchside</title>"
        "<style>"
        "html,body{margin:0;height:100%;background:#0d0f14;color:#e8ecf3;"
        "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;}"
        "body{display:flex;flex-direction:column;align-items:center;"
        "justify-content:center;text-align:center;padding:4vmin;box-sizing:border-box;}"
        "h1{font-size:min(6vmin,42px);font-weight:650;margin:0 0 3vmin;letter-spacing:.2px;}"
        ".sub{color:#9aa4b2;font-size:min(3vmin,20px);margin:0 0 4vmin;max-width:36ch;}"
        ".card{background:#fff;border-radius:24px;padding:min(5vmin,40px);"
        "box-shadow:0 12px 40px rgba(0,0,0,.5);}"
        "#qr{display:block;image-rendering:pixelated;width:min(70vmin,560px);"
        "height:min(70vmin,560px);}"
        ".url{margin-top:4vmin;color:#5a6472;font-size:min(2.2vmin,14px);"
        "word-break:break-all;max-width:80ch;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}"
        ".err{color:#ff6b6b;margin-top:3vmin;font-size:min(3vmin,18px);}"
        "</style></head><body>"
        "<h1>Scan to pair Couchside</h1>"
        "<div class=\"sub\">Open the Couchside app on your phone and scan this code, "
        "or point your phone camera at it.</div>"
        "<div class=\"card\"><canvas id=\"qr\" width=\"560\" height=\"560\"></canvas></div>"
        "<div class=\"url\">" + url_html + "</div>"
        "<div id=\"err\" class=\"err\"></div>"
        "<script>\n" + PAIR_QR_JS + "\n"
        "(function(){\n"
        "  var url = " + url_js + ";\n"
        "  try {\n"
        "    var qr = qrcode(0); qr.addData(url); qr.make();\n"
        "    var n = qr.getModuleCount();\n"
        "    var quiet = 4, total = n + quiet*2;\n"
        "    var canvas = document.getElementById('qr');\n"
        "    var px = Math.max(4, Math.floor(560/total));\n"
        "    var size = total*px; canvas.width = size; canvas.height = size;\n"
        "    var ctx = canvas.getContext('2d');\n"
        "    ctx.fillStyle = '#ffffff'; ctx.fillRect(0,0,size,size);\n"
        "    ctx.fillStyle = '#000000';\n"
        "    for (var r=0;r<n;r++){ for (var c=0;c<n;c++){ if (qr.isDark(r,c)) {\n"
        "      ctx.fillRect((c+quiet)*px,(r+quiet)*px,px,px); } } }\n"
        "  } catch (e) {\n"
        "    document.getElementById('err').textContent = 'Could not render QR: ' + e;\n"
        "  }\n"
        "})();\n"
        "</script></body></html>"
    )


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------


class Handler(BaseHTTPRequestHandler):
    server_version = APP_NAME + "/" + VERSION
    protocol_version = "HTTP/1.1"

    # set by main()
    token = ""
    token_file = None   # path to re-read the current token for /pair
    port = DEFAULT_PORT  # advertised in the pairing deep link
    mock = False

    def log_message(self, fmt, *args):  # route BaseHTTPRequestHandler logs away
        pass

    def _is_loopback(self):
        """True iff the connecting client is on the loopback interface.

        Half the security model for /pair (which exposes the token): only
        127.0.0.0/8 and ::1 (incl. the ::ffff:127.0.0.1 v4-mapped form) are
        allowed. self.client_address[0] is the peer IP as seen by the
        kernel-accepted socket, so it cannot be spoofed by a request header.
        The other half is _host_header_is_local (DNS rebinding).
        """
        host = self.client_address[0]
        if host == "::1":
            return True
        if host.startswith("::ffff:"):
            host = host[len("::ffff:"):]  # IPv4-mapped IPv6
        return host == "localhost" or host.startswith("127.")

    def _host_header_is_local(self):
        """True iff the request's Host header names loopback.

        Anti-DNS-rebinding gate for /pair: a malicious web page loaded in the
        box's own browser can rebind its domain to 127.0.0.1 and fetch
        http://attacker.tld:PORT/pair: the socket peer IS loopback then, but
        the Host header still says attacker.tld. The legitimate launcher opens
        http://localhost:PORT/pair, so requiring a loopback Host costs nothing.
        """
        host = (self.headers.get("Host") or "").strip().lower()
        if host.startswith("["):  # [::1] or [::1]:port
            host = host[1:].split("]", 1)[0]
        elif host.count(":") == 1:
            host = host.rsplit(":", 1)[0]  # strip :port
        return host in ("localhost", "::1") or host.startswith("127.")

    def _current_token(self):
        """The token to advertise on /pair: fresh from the token file if we
        can read it (picks up a re-generated token without a restart), else
        the token loaded at startup."""
        if self.token_file:
            try:
                with open(self.token_file) as f:
                    tok = f.read().strip()
                if tok:
                    return tok
            except OSError:
                pass
        return self.token

    def _send_html(self, code, html, started):
        body = html.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)
        self._log(code, started)

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

            if path == "/pair":
                # LOCALHOST-ONLY: /pair renders the pairing token as a QR, so a
                # non-loopback client MUST NOT see it. Two gates, both required:
                # peer IP must be loopback AND the Host header must name
                # loopback (anti-DNS-rebinding, see _host_header_is_local).
                if not self._is_loopback() or not self._host_header_is_local():
                    self._send(403, {"error": "forbidden"}, started)
                    return
                html = render_pair_page(self._current_token(), self.port)
                self._send_html(200, html, started)
                return

            if path == "/api/ping":
                # "ip" is the server-side address of THIS connection, i.e. the
                # LAN IP the client actually reached us on. The app caches it
                # per box and falls back to it when mDNS (.local) resolution
                # breaks (classic SteamOS Game Mode: WiFi power-save drops the
                # multicast that mDNS needs while unicast HTTP still works).
                # "host" (short hostname) lets the app verify that a cached IP
                # still points at THIS box before trusting it with the bearer
                # token. Hostname disclosure is acceptable: mDNS broadcasts it
                # to the whole LAN anyway.
                try:
                    own_ip = self.connection.getsockname()[0]
                except OSError:
                    own_ip = None
                short_host = socket.gethostname().split(".")[0] or None
                self._send(200, {"ok": True, "app": APP_NAME,
                                 "version": VERSION, "ip": own_ip,
                                 "host": short_host}, started)
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
            elif path == "/api/tv":
                # Probe-and-appear: 404 when no TV backend so the app shows no
                # TV strip; a body only when a backend is live.
                info = tv_info()
                if info is None:
                    self._send(404, {"error": "not found"}, started)
                else:
                    self._send(200, info, started)
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
        # Always drain the body first (see _read_body), even on the paths that
        # ignore it, so keep-alive connections never desync.
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

            # POST /api/launchers: add a custom launcher from a JSON body.
            if path == "/api/launchers":
                self._handle_add_launcher(body, started)
                return

            # POST /api/launchers/<id>: fire-and-forget launch.
            lprefix = "/api/launchers/"
            if path.startswith(lprefix):
                # The app percent-encodes the id (encodeURIComponent turns the
                # "steam:"/"custom:" colon into %3A), so decode before matching.
                launcher_id = unquote(path[len(lprefix):])
                argv = _launcher_argv(launcher_id)
                if argv is None:
                    self._send(404, {"ok": False,
                                     "error": "unknown launcher"}, started)
                    return
                result = mock_launch(argv) if self.mock else real_launch(argv)
                self._send(200, result, started)
                return

            # POST /api/tv/<op>: one-shot TV control (panel or CEC backend).
            tprefix = "/api/tv/"
            if path.startswith(tprefix):
                op = path[len(tprefix):]
                if op not in TV_OPS:
                    self._send(404, {"error": "unknown tv op"}, started)
                    return
                result = tv_send(op, self.mock)
                if result is None:  # no backend available
                    self._send(404, {"error": "not found"}, started)
                    return
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
                launcher_id = unquote(path[len(lprefix):])
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
                # created, it saw device=None and only closed the socket.
                # Without this, that freshly created uinput device (and fd)
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
    _inject_session_actions()
    _inject_suspend_action(args.mock)
    set_tv(args.mock)
    port = args.port if args.port is not None else (CONFIG_PORT or DEFAULT_PORT)

    Handler.token = load_token(args)
    # Remembered so GET /pair can re-read the current token (unless a literal
    # --token was supplied, in which case there is no file to re-read).
    Handler.token_file = None if args.token else args.token_file
    Handler.port = port
    Handler.mock = args.mock

    server = ThreadingHTTPServer((args.host, port), Handler)
    server.daemon_threads = True
    mode = "mock" if args.mock else "real"
    print("%s %s listening on %s:%d (%s mode)" % (
        APP_NAME, VERSION, args.host, port, mode), flush=True)
    info = tv_info()
    print("tv: %s" % ("%s (%s)" % (info["backend"], info["adapter"])
                      if info else "unavailable"), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
