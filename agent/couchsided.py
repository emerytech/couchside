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
import calendar
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
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

try:
    import fcntl  # POSIX only; uinput needs it (Linux), absent on Windows
except ImportError:  # pragma: no cover
    fcntl = None

APP_NAME = "couchside-agent"
VERSION = "2.9.2"
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


# ---------------------------------------------------------------------------
# Box capability summary (rides /api/status).
#
# The app learns which optional features a box supports (gamepad, Steam,
# now-playing, TV strip, screen preview, scheduled wake) so it can hide UI the
# box can't back. Historically it discovered each one with its own probe-and-
# appear request (GET /api/tv, /api/media, /api/screen, ...): N round-trips per
# connect, each independently version-sniffed. Folding a boolean summary into
# the status poll it already makes lets the app skip those probes and paint the
# right UI on the first frame. A boot-time snapshot, like the existing probes it
# replaces: presence here (a controller node, a Steam install, a session bus) is
# static per boot, so it is computed once in main() and served from CAPS.
#
# It is a hint, not authority: a live op still confirms (e.g. gamepad=True but
# /dev/uinput perms broke). Absent on agents < this version, so the app keeps
# its 404 fallbacks. In --mock every capability reads True so the whole app is
# exercisable on a dev machine with no hardware.
# ---------------------------------------------------------------------------

CAPS = {}  # set once by set_caps() in main(); returned by real_/mock_status


def _uinput_writable():
    """Best-effort: can this process open /dev/uinput for the virtual gamepad?
    The udev rule + `input` group grant rw; os.access uses the real uid/gid,
    which is what the service runs as. Never raises."""
    try:
        return os.access("/dev/uinput", os.W_OK)
    except Exception:
        return False


def set_caps(mock):
    """Snapshot box capabilities into CAPS. Call in main() AFTER set_tv/
    set_mpris/set_screen so the availability helpers reflect real startup
    detection. In --mock everything is available (see module note)."""
    global CAPS

    def safe(fn):
        try:
            return bool(fn())
        except Exception:
            return False

    if mock:
        CAPS = {k: True for k in
                ("gamepad", "steam", "media", "tv", "screen", "power_schedule",
                 "screensaver", "couchmode", "desktop")}
        return
    CAPS = {
        "gamepad": _uinput_writable(),
        "steam": _steam_root() is not None,
        "media": safe(mpris_available),
        "tv": safe(lambda: _tv_hw_backend() is not None or soft_available()),
        "screen": _SCREEN is not None,
        "power_schedule": safe(rtc_available),
        "screensaver": safe(screensaver_available),
        "couchmode": safe(couchmode_available),
        "desktop": safe(desktop_available),
    }


# ---------------------------------------------------------------------------
# Aerial screensaver (/api/screensaver).
#
# Apple-TV-style flyover screensaver. The heavy lifting lives in the installed
# couchside-screensaver.sh (deployed by install.sh / the Decky plugin next to
# this agent): it caches Apple's public aerial catalog, filters by THEME, picks
# a quality TIER, and loops shuffled videos with ffplay. This agent only
# manages it:
#   - it must be launched THROUGH STEAM (gamescope surfaces only what Steam
#     focuses — the atom tricks were tested and do not work), so first start
#     registers it as a non-Steam shortcut via steamos-add-to-steam and
#     launches it with steam://rungameid/<id>;
#   - stop kills the pid from the script's pidfile (NOT the pgid — Steam's
#     reaper owns the process group);
#   - theme/tier are written to the script's conf before each start.
# ---------------------------------------------------------------------------

SCREENSAVER_SCRIPT = os.path.expanduser(
    "~/.local/opt/couchside/couchside-screensaver.sh")
SCREENSAVER_CONF = os.path.expanduser("~/.config/couchside/screensaver.conf")
SCREENSAVER_PIDFILE = os.path.expanduser("~/.cache/couchside/screensaver.pid")
SCREENSAVER_THEMES = ("all", "landscapes", "cities", "space", "underwater")
SCREENSAVER_TIERS = ("1080-H264", "1080-SDR", "1080-HDR", "4K-SDR", "4K-HDR")
# How long to wait for steamos-add-to-steam's async registration to land in
# shortcuts.vdf, and the gap between the double rungameid fire on a fresh
# registration (the first open only shows the shortcut's page).
SS_REGISTER_WAIT_S = 10
SS_FIRST_LAUNCH_GAP_S = 4

SS_MOCK = False
_SS_MOCK = {"running": False, "theme": "all", "tier": "1080-H264"}
_SS_LOCK = threading.Lock()   # one start/stop mutation at a time


def set_screensaver(mock):
    global SS_MOCK
    SS_MOCK = mock


def screensaver_available():
    """Script deployed + the Steam-launch toolchain present. Boot-time hint
    (rides caps); GET /api/screensaver is the live authority."""
    return (os.path.isfile(SCREENSAVER_SCRIPT)
            and shutil.which("ffplay") is not None
            and shutil.which("steam") is not None
            and shutil.which("steamos-add-to-steam") is not None)


def _ss_running():
    try:
        with open(SCREENSAVER_PIDFILE) as f:
            pid = int(f.read().strip())
        os.kill(pid, 0)
        return True
    except (OSError, ValueError):
        return False


def _ss_conf_read():
    """(theme, tier) from the script's conf, defaults when absent/partial."""
    theme, tier = "all", "1080-H264"
    try:
        with open(SCREENSAVER_CONF) as f:
            for line in f:
                line = line.strip()
                if line.startswith("THEME="):
                    theme = line.split("=", 1)[1].strip() or theme
                elif line.startswith("TIER="):
                    tier = line.split("=", 1)[1].strip() or tier
    except OSError:
        pass
    return theme, tier


def _ss_conf_write(theme, tier):
    os.makedirs(os.path.dirname(SCREENSAVER_CONF), exist_ok=True)
    with open(SCREENSAVER_CONF, "w") as f:
        f.write("TIER=%s\nTHEME=%s\n" % (tier, theme))


def _ss_validate(theme, tier):
    """Validated (theme, tier), raising ValueError on junk. theme may be a
    comma list of known themes ("space,underwater")."""
    parts = [t.strip().lower() for t in str(theme).split(",") if t.strip()]
    if not parts:
        parts = ["all"]
    for t in parts:
        if t not in SCREENSAVER_THEMES:
            raise ValueError("unknown theme %r" % t)
    if tier not in SCREENSAVER_TIERS:
        raise ValueError("unknown tier %r" % tier)
    return ",".join(parts), tier


def _ss_appid():
    """The registered shortcut's appid from shortcuts.vdf, or None. Matched by
    exe path so a rename of the tile doesn't break the lookup."""
    for p in glob.glob(os.path.expanduser(
            "~/.steam/steam/userdata/*/config/shortcuts.vdf")):
        try:
            with open(p, "rb") as f:
                data = f.read()
        except OSError:
            continue
        i = data.find(b"couchside-screensaver.sh")
        if i < 0:
            continue
        # The appid field precedes the exe/appname block of the same entry.
        seg = data[max(0, i - 300):i]
        j = seg.rfind(b"\x02appid\x00")
        if j >= 0 and j + 12 <= len(seg):
            return struct.unpack("<I", seg[j + 8:j + 12])[0]
    return None


def _ss_gameid(appid):
    """steam://rungameid id for a non-Steam shortcut."""
    return (appid << 32) | 0x02000000


def _ss_fire(gameid):
    subprocess.Popen(
        ["steam", "steam://rungameid/%d" % gameid],
        env=_user_env(), start_new_session=True,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def screensaver_info():
    if SS_MOCK:
        return {"available": True, "running": _SS_MOCK["running"],
                "theme": _SS_MOCK["theme"], "tier": _SS_MOCK["tier"],
                "themes": list(SCREENSAVER_THEMES),
                "tiers": list(SCREENSAVER_TIERS)}
    theme, tier = _ss_conf_read()
    return {"available": screensaver_available(), "running": _ss_running(),
            "theme": theme, "tier": tier,
            "themes": list(SCREENSAVER_THEMES),
            "tiers": list(SCREENSAVER_TIERS)}


def screensaver_start(theme, tier):
    """Write conf and launch via Steam. Registration (first ever start) and
    the fresh-registration double-fire run in a background thread — the POST
    returns immediately and the app watches `running` flip via GET."""
    theme, tier = _ss_validate(theme, tier)
    if SS_MOCK:
        _SS_MOCK.update(running=True, theme=theme, tier=tier)
        return {"ok": True, "running": True}
    if not screensaver_available():
        raise RuntimeError("screensaver not installed on this box")
    with _SS_LOCK:
        _ss_conf_write(theme, tier)
        if _ss_running():
            # Restart with the new theme/tier: kill, then relaunch below.
            screensaver_stop()
        appid = _ss_appid()

    def launch():
        aid = appid
        fresh = aid is None
        if fresh:
            subprocess.run(
                ["steamos-add-to-steam", SCREENSAVER_SCRIPT],
                env=_user_env(), timeout=30,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            deadline = time.monotonic() + SS_REGISTER_WAIT_S
            while aid is None and time.monotonic() < deadline:
                time.sleep(1)
                aid = _ss_appid()
            if aid is None:
                print("[screensaver] registration did not appear in shortcuts.vdf",
                      flush=True)
                return
        _ss_fire(_ss_gameid(aid))
        if fresh:
            # A shortcut's very first rungameid only opens its page.
            time.sleep(SS_FIRST_LAUNCH_GAP_S)
            _ss_fire(_ss_gameid(aid))

    threading.Thread(target=launch, daemon=True).start()
    return {"ok": True, "starting": True}


def screensaver_stop():
    if SS_MOCK:
        _SS_MOCK["running"] = False
        return {"ok": True, "running": False}
    try:
        with open(SCREENSAVER_PIDFILE) as f:
            pid = int(f.read().strip())
        os.kill(pid, 15)  # SIGTERM; the script forwards it to its ffplay child
    except (OSError, ValueError):
        pass  # not running = already stopped; stop is idempotent
    return {"ok": True, "running": False}


# ---------------------------------------------------------------------------
# Metrics history (rides /api/status as "history").
#
# A small ring of recent vitals so the app can draw sparklines instead of a
# single point-in-time number. Sampled ON the status poll itself — no
# background thread, no idle cost; the ring only advances while a client is
# actually watching, which is exactly when the trend matters. Samples are
# rate-limited to one per HISTORY_MIN_INTERVAL_S no matter how many clients
# poll (Fleet polls every box), and the ring holds HISTORY_LEN samples
# (~5 min at the app's cadence). Parallel arrays keep the payload tiny.
# ---------------------------------------------------------------------------

HISTORY_LEN = 30
HISTORY_MIN_INTERVAL_S = 10
_HISTORY = {"t": [], "temp": [], "load": [], "mem_pct": []}
_HISTORY_LOCK = threading.Lock()


def _record_history(now, temp, load1, mem):
    """Append one sample (rate-limited, ring-capped). Values may be None —
    recorded as-is so the app can gap the sparkline rather than draw a lie."""
    mem_pct = None
    if isinstance(mem, dict) and mem.get("total_mb"):
        mem_pct = round(mem.get("used_mb", 0) * 100.0 / mem["total_mb"], 1)
    with _HISTORY_LOCK:
        if _HISTORY["t"] and now - _HISTORY["t"][-1] < HISTORY_MIN_INTERVAL_S:
            return
        for key, val in (("t", now), ("temp", temp),
                         ("load", load1), ("mem_pct", mem_pct)):
            _HISTORY[key].append(val)
            if len(_HISTORY[key]) > HISTORY_LEN:
                del _HISTORY[key][0]


def _history_snapshot():
    with _HISTORY_LOCK:
        return {k: list(v) for k, v in _HISTORY.items()}


def real_status():
    load = read_load()
    temp = read_cpu_temp_c()
    mem = read_mem()
    now = int(time.time())
    _record_history(now, temp, load[0] if load else None, mem)
    return {
        "hostname": socket.gethostname().split(".")[0],
        "time": now,
        "uptime_s": read_uptime_s(),
        "load": load,
        "cpu_temp_c": temp,
        "mem": mem,
        "disks": read_disks(),
        "net": net_info_cached(),
        "agent_version": VERSION,
        # CAPS is a boot-time snapshot, but "desktop" is SESSION-volatile (it
        # flips with every Game Mode <-> desktop switch), so recompute it per
        # request — a cheap pgrep — or the app's desktop cluster would freeze
        # at whatever session the agent booted in.
        "caps": dict(CAPS, desktop=desktop_available()),
        "history": _history_snapshot(),
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


# Fixed-argument, root-owned journal wrapper installed by install.sh / the Decky
# plugin. The couchside sudoers rule grants ONLY this script (no wildcards), and
# the script validates the unit + line count before calling journalctl with a
# locked-down option set — so a caller can never inject --file/--directory to
# read arbitrary files as root. See install.sh's (f) section.
JOURNAL_WRAPPER = "/etc/couchside/couchside-journal"


def real_journal(unit, scope, lines):
    if scope == "system":
        # Prefer the wrapper (airtight). Fall back to a direct sudo journalctl on
        # installs that predate it, so a freshly-fetched agent on an older box
        # still reads the journal via the legacy sudoers rule.
        if os.path.exists(JOURNAL_WRAPPER):
            cmd = ["sudo", JOURNAL_WRAPPER, unit, str(lines)]
        else:
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
# Couch Mode (/api/displays, /api/couch-mode, /api/desktop-mode).
#
# For a box run as a DESKTOP (Plasma) that also has a TV wired in: one tap flings
# it into Game Mode on the TV. The desktop→couch handoff, phone-triggered.
#
# Output mechanism (verified on a real SteamOS box, 2026-07-15): the SteamOS
# gamescope session hardcodes `-O '*',eDP-1` — prefer ANY external output, fall
# back to the internal panel — so a box with a single external (the TV) lands
# Game Mode on it automatically; nothing to inject. gamescope reads DRM directly
# and ignores the X11 "primary" flag, so the old set-primary theory does nothing
# for it. Forcing a SPECIFIC external when several are connected would need a
# gamescope session override we don't ship yet, so `output` is advisory and the
# app's picker (shown only with 2+ externals) is best-effort there.
#
# SteamOS/Bazzite only (shared tooling: gamescope, steamos-session-select,
# kscreen-doctor, wpctl). Gated to boxes with 2+ connected outputs, so a
# single-display box (a handheld with nothing plugged in, or a dedicated Game
# Mode box) never shows the button. Outputs are read from DRM sysfs, which works
# regardless of the current session (kscreen-doctor only answers inside Plasma).
#
# The switch (couchmode_start / desktop_mode) runs entirely from the agent's own
# service env: it's a SYSTEM service running as the desktop user with
# XDG_RUNTIME_DIR set, which is all pactl/wpctl (audio, over the user runtime
# socket) and steamosctl (session switch, over the system bus) need — no DISPLAY
# or session D-Bus. Being a system service, the agent SURVIVES the session tear-
# down, so it keeps answering and reports the new session on the next poll.
# ---------------------------------------------------------------------------

# DRM connector name prefixes that are a built-in panel, not a TV/monitor.
_INTERNAL_OUTPUT_PREFIXES = ("eDP", "LVDS", "DSI")
# The session tools Couch Mode drives; all must be present to offer it.
_COUCHMODE_TOOLS = ("gamescope", "steamos-session-select", "kscreen-doctor", "wpctl")


def _is_steamos_like():
    """True on SteamOS or Bazzite — the only platforms Couch Mode targets."""
    try:
        rel = open("/etc/os-release").read().lower()
    except OSError:
        return False
    return "steamos" in rel or "bazzite" in rel


def _connected_outputs():
    """Connected DRM outputs as [{name, internal}], newest-sorted by connector.

    Read straight from /sys/class/drm/*/status so it works in ANY session
    (Plasma, Game Mode, or the bare login state) — kscreen-doctor only answers
    while a KWin session is up.
    """
    outs = []
    for path in sorted(glob.glob("/sys/class/drm/card*-*")):
        try:
            if open(os.path.join(path, "status")).read().strip() != "connected":
                continue
        except OSError:
            continue
        # cardN-DP-2 -> DP-2 ; cardN-eDP-1 -> eDP-1
        name = os.path.basename(path).split("-", 1)[1]
        outs.append({
            "name": name,
            "internal": name.startswith(_INTERNAL_OUTPUT_PREFIXES),
        })
    return outs


def couchmode_available():
    """True when this box can do the desktop→TV Game Mode handoff: SteamOS/Bazzite,
    the session tools present, and at least one EXTERNAL output (a TV/monitor to
    fling Game Mode onto). A desktop tower or mini-PC with a single wired display
    counts — the handoff is desktop→Game Mode on that display. A bare handheld
    (internal panel only, nothing plugged in) stays hidden."""
    if not _is_steamos_like():
        return False
    if not all(shutil.which(t) for t in _COUCHMODE_TOOLS):
        return False
    return any(not o["internal"] for o in _connected_outputs())


def _couchmode_session():
    """'gamescope' when this box is currently in Game Mode, else 'desktop'.
    Lets the app show 'Back to Desktop' vs the fling-to-TV picker.

    The gamescope compositor runs with process name (comm) 'gamescope-wl' even
    though its argv[0] is 'gamescope' — so an exact `pgrep -x gamescope` MISSES
    it. Match either name with an anchored regex; the anchor also avoids matching
    the 'start-gamescope-session' launcher script."""
    try:
        r = subprocess.run(["pgrep", "-x", "gamescope(-wl)?"],
                           capture_output=True, timeout=3)
        return "gamescope" if r.returncode == 0 else "desktop"
    except Exception:
        return "desktop"


def _output_forcing_supported():
    """True when this box's gamescope session honors $OUTPUT_CONNECTOR (so the
    app's display picker is AUTHORITATIVE, not advisory). Bazzite's
    gamescope-session-plus reads it into --prefer-output; SteamOS's session
    hardcodes its preference and ignores the env. Detected from the session
    script itself rather than a distro name, so it tracks reality."""
    try:
        with open("/usr/share/gamescope-session-plus/"
                  "gamescope-session-plus") as f:
            return "OUTPUT_CONNECTOR" in f.read()
    except OSError:
        return False


def couchmode_info():
    """Payload for GET /api/displays: the connected outputs, which are TV
    candidates (external) to offer as the game display, and the current session
    so the app shows enter-vs-exit. None when unavailable, so the route 404s and
    the app hides the Couch Mode control (probe-and-appear)."""
    if not couchmode_available():
        return None
    outs = _connected_outputs()
    return {
        "available": True,
        "outputs": outs,
        # External (non-panel) outputs are the game-display candidates. Default
        # to the first external one in the app's picker.
        "game_outputs": [o["name"] for o in outs if not o["internal"]],
        "session": _couchmode_session(),
        # Whether the picker's choice is actually honored (see helper). The app
        # hides the picker when this is False — a dead control is worse than
        # no control.
        "output_forcing": _output_forcing_supported(),
    }


def desktop_available():
    """True on a SteamOS/Bazzite box currently in the Plasma DESKTOP session —
    gates the app's desktop-nav cluster (Start menu / pointer / overview), which
    only makes sense in the desktop, not in Game Mode. Session-aware so the
    buttons appear when you're on the desktop and hide once you fling to Game
    Mode. The keys themselves ride the existing /ws/gamepad uinput keyboard."""
    return _is_steamos_like() and _couchmode_session() == "desktop"


def _couch_run(cmd, timeout=25, max_out=1500):
    """Run a Couch Mode switch command from the agent's service env. The agent
    runs as the desktop user with XDG_RUNTIME_DIR set (ensured here for safety),
    which is all pactl/wpctl and steamosctl need. Returns a compact result dict;
    never raises. `max_out` caps stdout/stderr (tail) for the JSON reply; pass
    None when a caller needs to PARSE full output (e.g. `pactl list sinks`)."""
    env = dict(os.environ)
    env.setdefault("XDG_RUNTIME_DIR", "/run/user/%d" % os.getuid())
    try:
        r = subprocess.run(cmd, capture_output=True, text=True,
                           timeout=timeout, env=env)
        out, err = r.stdout or "", r.stderr or ""
        if max_out is not None:
            out, err = out[-max_out:], err[-max_out:]
        return {"ok": r.returncode == 0, "exit_code": r.returncode,
                "stdout": out, "stderr": err}
    except FileNotFoundError:
        return {"ok": False, "exit_code": 127, "stdout": "",
                "stderr": "%s: not found" % cmd[0]}
    except subprocess.TimeoutExpired:
        return {"ok": False, "exit_code": 124, "stdout": "",
                "stderr": "%s: timed out" % cmd[0]}
    except Exception as e:  # never let a switch step crash the request
        return {"ok": False, "exit_code": 1, "stdout": "",
                "stderr": "%s: %s" % (cmd[0], e.__class__.__name__)}


def _pactl_sinks():
    """Parse `pactl list sinks` into [{name, hdmi, available}]. `available` is
    True only when a port on the sink reports availability 'available' (an
    HDMI/DP output with a live display), so the TV's audio sink is the one that's
    both hdmi and available. [] when pactl is missing or errors."""
    if not shutil.which("pactl"):
        return []
    r = _couch_run(["pactl", "list", "sinks"], timeout=8, max_out=None)
    if not r["ok"]:
        return []
    sinks, cur = [], None
    for raw in r["stdout"].splitlines():
        s = raw.strip()
        if s.startswith("Name:"):
            cur = {"name": s.split(":", 1)[1].strip(),
                   "hdmi": False, "available": False}
            sinks.append(cur)
        elif cur is not None and "type: HDMI" in s:
            cur["hdmi"] = True
            # port line ends "..., available)" vs "..., not available)"
            if s.endswith("available)") and "not available)" not in s:
                cur["available"] = True
    return sinks


def _tv_audio_sink():
    """Node name of the connected TV's HDMI/DP audio sink (hdmi + available), or
    None so the audio move no-ops rather than guessing."""
    for s in _pactl_sinks():
        if s["hdmi"] and s["available"]:
            return s["name"]
    return None


def _internal_audio_sink():
    """Node name of the built-in speaker/analog sink (for restoring on return)."""
    for s in _pactl_sinks():
        low = s["name"].lower()
        if not s["hdmi"] and ("speaker" in low or "analog" in low
                              or "pci" in low):
            return s["name"]
    return None


def _couch_run_first(cmds):
    """Run candidate commands in order until one succeeds; return that result
    (or the last failure). Skips commands whose binary is absent. The session
    switchers differ per distro — see _session_to_game — so the switch is a
    try-chain, not a single verb."""
    result = {"ok": False, "exit_code": 127, "stdout": "",
              "stderr": "no session-switch tool found"}
    for cmd in cmds:
        if not shutil.which(cmd[0]):
            continue
        result = _couch_run(cmd)
        if result["ok"]:
            return result
    return result


def _session_to_game():
    """Transient switch to Game Mode.

    SteamOS: steamosctl (validated live; does NOT change the boot default).
    Bazzite: ships a steamosctl WITHOUT the SessionManagement interface (the
    call errors), so fall through to its steamos-session-select script
    (validated live on a bazzite-deck box)."""
    return _couch_run_first([
        ["steamosctl", "switch-to-game-mode"],
        ["steamos-session-select", "gamescope"],
    ])


def _session_to_desktop():
    """Transient switch back to the desktop session.

    SteamOS: steamosctl with the X11 session (validated live). Bazzite: its
    steamos-session-select 'plasma' runs a ONESHOT desktop session — the boot
    default stays Game Mode, which is exactly couch-mode semantics (also
    validated live)."""
    return _couch_run_first([
        ["steamosctl", "switch-to-desktop-mode", "plasmax11.desktop"],
        ["steamosctl", "switch-to-desktop-mode"],
        ["steamos-session-select", "plasma"],
    ])


_ENVD_OUTPUT_CONF = os.path.expanduser(
    "~/.config/environment.d/95-couchside-couchmode.conf")


def _set_preferred_output(output):
    """Make the app's display picker REAL where the platform allows it.

    Bazzite's gamescope-session-plus sources ~/.config/environment.d/*.conf and
    feeds $OUTPUT_CONNECTOR to gamescope's --prefer-output (verified on a
    bazzite-deck box). Write the chosen connector there, with the platform's
    own fallbacks after it, so an unplugged monitor degrades instead of
    blanking. SteamOS's session hardcodes its preference and ignores this file
    — harmless there, picker stays advisory.

    SECURITY: `output` is client-supplied and lands in a file systemd parses —
    accept it only if it exactly matches a CONNECTED DRM connector name.
    Returns a step dict."""
    if not output:
        return {"skipped": True}
    if output not in {o["name"] for o in _connected_outputs()}:
        return {"ok": False, "exit_code": 1, "stdout": "",
                "stderr": "unknown output %r" % (output,)}
    try:
        os.makedirs(os.path.dirname(_ENVD_OUTPUT_CONF), exist_ok=True)
        with open(_ENVD_OUTPUT_CONF, "w") as f:
            f.write("# Written by couchside couch-mode (app display picker).\n"
                    "OUTPUT_CONNECTOR=%s,*,eDP-1\n" % output)
        return {"ok": True, "exit_code": 0, "stdout": "", "stderr": ""}
    except OSError as e:
        return {"ok": False, "exit_code": 1, "stdout": "",
                "stderr": "envd write: %s" % e}


def couchmode_start(output, hdr=False):
    """Fling the box into Game Mode on the TV. Steps, all best-effort except the
    session switch: (0) TV power-on + input-to-box where the box can drive the
    panel/CEC (inert otherwise), (1) move audio to the TV's HDMI sink, (2)
    transient switch to Game Mode. On platforms whose session honors
    $OUTPUT_CONNECTOR (Bazzite) the chosen `output` is FORCED via an
    environment.d drop-in; elsewhere gamescope picks its own external. The
    switch tears down the desktop session — the agent (system service)
    survives, so the app reads session=gamescope on its next poll."""
    steps = {}
    # (0) Fold in TV power + input. tv_send returns None when no backend exists.
    pwr = tv_send("power_on", False)
    steps["tv_power_on"] = pwr if pwr is not None else {"skipped": True}
    src = tv_send("source_box", False)
    steps["tv_input"] = src if src is not None else {"skipped": True}
    # (1) Route audio to the TV.
    sink = _tv_audio_sink()
    steps["audio"] = (_couch_run(["pactl", "set-default-sink", sink])
                      if sink else {"skipped": True})
    # (2) Honor the display picker where the platform allows it.
    steps["output"] = _set_preferred_output(output)
    # (3) Enter Game Mode (the one step that must succeed).
    sw = _session_to_game()
    steps["session"] = sw
    return {"ok": sw["ok"], "output": output, "hdr": bool(hdr),
            "session": "gamescope" if sw["ok"] else _couchmode_session(),
            "steps": steps}


def desktop_mode():
    """Return from Game Mode to the Plasma desktop and route audio back to the
    built-in speaker."""
    sw = _session_to_desktop()
    steps = {"session": sw}
    sink = _internal_audio_sink()
    steps["audio"] = (_couch_run(["pactl", "set-default-sink", sink])
                      if sink else {"skipped": True})
    return {"ok": sw["ok"],
            "session": "desktop" if sw["ok"] else _couchmode_session(),
            "steps": steps}


# ---------------------------------------------------------------------------
# Sleep timer + scheduled wake (/api/power/schedule|sleep|wake).
#
# Delayed suspend/poweroff is an in-process one-shot threading.Timer firing the
# existing suspend/poweroff action — deliberately volatile (a restart clears it;
# the app detects that by polling). Scheduled wake is an RTC alarm set via ioctl
# on /dev/rtc0, reachable through a udev rule that adds rtc0 to group `input`
# (the agent already has SupplementaryGroups=input) — NO sudoers change; the
# alarm survives restarts and the suspend itself. The ioctl numbers + struct
# layout + the valid-date-clear + single-open behaviour were all verified on a
# real Bazzite rtc0.
# ---------------------------------------------------------------------------

SLEEP_MIN_S, SLEEP_MAX_S = 60, 8 * 3600
WAKE_MIN_S, WAKE_MAX_S = 120, 86100   # just under 24h (exact-day is ambiguous on some CMOS RTCs)
SLEEP_ACTIONS = ("suspend", "poweroff")

POWER_MOCK = False          # set by set_power_schedule(mock)
SLEEP_LOCK = threading.Lock()
_SLEEP = {"timer": None, "action": None, "fire_at": 0.0}

RTC_DEV = "/dev/rtc0"
RTC_LOCK = threading.Lock()
# ioctl request numbers (validated on hardware); _IOR('p',0x09,36) etc.
RTC_RD_TIME = 0x80247009
RTC_WKALM_RD = 0x80287010
RTC_WKALM_SET = 0x4028700f
_RTC_TIME = "=9i"           # sec,min,hour,mday,mon,year,wday,yday,isdst
_RTC_WK = "=BB2x9i"         # enabled, pending, 2 pad, rtc_time
_MOCK_WAKE = {"fire_at": 0}  # --mock in-memory alarm


def set_power_schedule(mock):
    global POWER_MOCK
    POWER_MOCK = mock


def _can_sudo_action(cmd):
    """True iff the agent user has passwordless sudo for exactly `cmd`. Probes
    with `sudo -n -l` (never runs it). Generalises _can_sudo_suspend."""
    try:
        r = subprocess.run(["sudo", "-n", "-l"] + list(cmd), capture_output=True, timeout=4)
        return r.returncode == 0
    except Exception:
        return False


def sleep_can_arm(action):
    """(ok, error). The action must be a known sleep action, present in ACTIONS,
    and its privileged command actually permitted — so we never arm a timer that
    silently fails when it fires (poweroff is in ACTIONS unconditionally but sudo
    may still refuse it)."""
    if action not in SLEEP_ACTIONS:
        return (False, "unknown action")
    if POWER_MOCK:
        return (True, None)
    spec = ACTIONS.get(action)
    if spec is None:
        return (False, "%s unavailable" % action)
    cmd = list(spec["cmd"])
    if cmd and cmd[0] == "sudo":
        probe = cmd[1:]
        if probe and not probe[0].startswith("/"):
            probe = ["/usr/bin/" + probe[0]] + probe[1:]  # sudo -l wants an absolute path
        if not _can_sudo_action(probe):
            return (False, "%s not permitted (sudoers)" % action)
    return (True, None)


def _sleep_info_locked():
    if _SLEEP["timer"] is None:
        return None
    return {"action": _SLEEP["action"], "fire_at": int(_SLEEP["fire_at"]),
            "remaining_s": max(0, int(_SLEEP["fire_at"] - time.time()))}


def _sleep_cancel_locked():
    if _SLEEP["timer"] is not None:
        _SLEEP["timer"].cancel()
    _SLEEP.update(timer=None, action=None, fire_at=0.0)


def sleep_arm(delay_s, action):
    """Arm a one-shot suspend/poweroff after delay_s, replacing any prior arm."""
    with SLEEP_LOCK:
        _sleep_cancel_locked()
        fire_at = time.time() + delay_s

        def _fire():
            with SLEEP_LOCK:
                if _SLEEP["timer"] is not timer:  # cancelled or superseded
                    return
                _SLEEP.update(timer=None, action=None, fire_at=0.0)
            r = mock_action(action) if POWER_MOCK else real_action(action)
            print("[sleep] fired %s: ok=%s" % (action, r.get("ok")), flush=True)

        timer = threading.Timer(delay_s, _fire)
        timer.daemon = True
        _SLEEP.update(timer=timer, action=action, fire_at=fire_at)
        timer.start()
        return _sleep_info_locked()


def sleep_cancel():
    with SLEEP_LOCK:
        _sleep_cancel_locked()


def sleep_info():
    with SLEEP_LOCK:
        return _sleep_info_locked()


def rtc_available():
    if POWER_MOCK:
        return True
    return os.path.exists(RTC_DEV) and os.access(RTC_DEV, os.R_OK | os.W_OK)


def _rtc_ioctl_read(fd, req, size):
    buf = bytearray(size)
    fcntl.ioctl(fd, req, buf, True)
    return bytes(buf)


def _rtc_now_epoch(fd):
    """Current RTC time as an epoch in the RTC's OWN timebase (fields read as if
    UTC), so alarm math is immune to whether the RTC runs UTC or LOCAL."""
    t = struct.unpack(_RTC_TIME, _rtc_ioctl_read(fd, RTC_RD_TIME, 36))
    return calendar.timegm((t[5] + 1900, t[4] + 1, t[3], t[2], t[1], t[0], 0, 0, 0))


def rtc_wake_info():
    """Current wake alarm as {fire_at, remaining_s} (wall time) or None."""
    if POWER_MOCK:
        fa = _MOCK_WAKE["fire_at"]
        if fa and fa > time.time():
            return {"fire_at": int(fa), "remaining_s": int(fa - time.time())}
        return None
    if not rtc_available():
        return None
    try:
        with RTC_LOCK:
            with open(RTC_DEV, "rb") as fd:
                rtc_epoch = _rtc_now_epoch(fd)
                w = struct.unpack(_RTC_WK, _rtc_ioctl_read(fd, RTC_WKALM_RD, 40))
    except OSError:
        return None
    if not w[0]:
        return None
    alarm_epoch = calendar.timegm((w[7] + 1900, w[6] + 1, w[5], w[4], w[3], w[2], 0, 0, 0))
    fire_at = time.time() + (alarm_epoch - rtc_epoch)  # RTC-timebase -> wall
    return {"fire_at": int(fire_at), "remaining_s": max(0, int(fire_at - time.time()))}


def rtc_set_wake(at_epoch):
    """Set the RTC wake alarm to fire at wall-time `at_epoch`; verify read-back.
    Returns True on success."""
    if POWER_MOCK:
        _MOCK_WAKE["fire_at"] = int(at_epoch)
        print("[wake] mock alarm at %d" % int(at_epoch), flush=True)
        return True
    if not rtc_available():
        return False
    try:
        with RTC_LOCK:
            with open(RTC_DEV, "rb") as fd:
                target = _rtc_now_epoch(fd) + int(at_epoch - time.time())
                tm = time.gmtime(target)
                alarm = struct.pack(_RTC_WK, 1, 0, tm.tm_sec, tm.tm_min, tm.tm_hour,
                                    tm.tm_mday, tm.tm_mon - 1, tm.tm_year - 1900,
                                    tm.tm_wday, tm.tm_yday, tm.tm_isdst)
                fcntl.ioctl(fd, RTC_WKALM_SET, alarm)
                r = struct.unpack(_RTC_WK, _rtc_ioctl_read(fd, RTC_WKALM_RD, 40))
        # Verify enabled + Y/M/D/h/m/s; the kernel normalises wday/yday/isdst.
        return (r[0] == 1 and r[2] == tm.tm_sec and r[3] == tm.tm_min
                and r[4] == tm.tm_hour and r[5] == tm.tm_mday
                and r[6] == tm.tm_mon - 1 and r[7] == tm.tm_year - 1900)
    except OSError:
        return False


def rtc_clear_wake():
    """Disable the wake alarm. enabled=0 must still carry a VALID date — a zero
    date is rejected with EINVAL (verified on hardware)."""
    if POWER_MOCK:
        _MOCK_WAKE["fire_at"] = 0
        return True
    if not rtc_available():
        return False
    try:
        with RTC_LOCK:
            with open(RTC_DEV, "rb") as fd:
                tm = time.gmtime(_rtc_now_epoch(fd))
                clr = struct.pack(_RTC_WK, 0, 0, tm.tm_sec, tm.tm_min, tm.tm_hour,
                                  tm.tm_mday, tm.tm_mon - 1, tm.tm_year - 1900,
                                  tm.tm_wday, tm.tm_yday, tm.tm_isdst)
                fcntl.ioctl(fd, RTC_WKALM_SET, clr)
        return True
    except OSError:
        return False


def power_schedule_info():
    """The /api/power/schedule payload."""
    return {
        "sleep": sleep_info(),
        "wake": rtc_wake_info(),
        "wake_available": rtc_available(),
        "limits": {"sleep_min_s": SLEEP_MIN_S, "sleep_max_s": SLEEP_MAX_S,
                   "wake_min_s": WAKE_MIN_S, "wake_max_s": WAKE_MAX_S},
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
    load1 = round(random.uniform(0.2, 1.4), 2)
    mem = {"total_mb": 15803, "used_mb": 6212, "available_mb": 9591}
    # Feed the same history ring as real mode so sparklines are exercisable in
    # --mock (rate-limited exactly the same way).
    _record_history(int(now), temp, load1, mem)
    return {
        "hostname": "couchside-box",
        "time": int(now),
        "uptime_s": int(now - MOCK_START + MOCK_BOOT_OFFSET),
        "load": [load1,
                 round(random.uniform(0.3, 1.1), 2),
                 round(random.uniform(0.3, 0.9), 2)],
        "cpu_temp_c": temp,
        "mem": mem,
        "disks": [
            {"mount": "/", "total_gb": 465.1, "used_gb": 210.4,
             "free_gb": 254.7, "pct": 45},
            {"mount": "/var", "total_gb": 465.1, "used_gb": 198.2,
             "free_gb": 266.9, "pct": 43},
        ],
        "net": {"iface": "eth0", "mac": "de:ad:be:ef:00:01",
                "wired": True, "wol_armed": True},
        "agent_version": VERSION,
        "caps": CAPS,
        "history": _history_snapshot(),
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

# appmanifest StateFlags bits meaning "an operation is in progress". A game is
# reported in /api/downloads ONLY when one of these is set, or when its byte
# counters prove an incomplete transfer — an allowlist, never "anything != 4".
DL_UPDATE_RUNNING = 256
DL_UPDATE_STARTED = 512
DL_UPDATE_STOPPING = 1024
DL_UNINSTALLING = 2048        # excluded: an uninstall is not a download
DL_VALIDATING = 131072
DL_PREALLOCATING = 524288
DL_DOWNLOADING = 1048576
DL_STAGING = 2097152
DL_COMMITTING = 4194304
DL_ACTIVE_OP = (DL_UPDATE_RUNNING | DL_UPDATE_STARTED | DL_UPDATE_STOPPING
                | DL_VALIDATING | DL_PREALLOCATING | DL_DOWNLOADING
                | DL_STAGING | DL_COMMITTING)


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


# The set of steamapps library dirs changes rarely (only when the user adds a
# Steam library), but re-reading libraryfolders.vdf + realpath'ing every entry
# on each launch and each downloads poll is wasteful. Cache the discovered
# library list per root for _STEAM_LIB_TTL seconds. Best-effort: never raises.
_STEAM_LIB_TTL = 30.0
_STEAM_LIB_CACHE = {"root": None, "at": 0.0, "val": None}
_STEAM_LIB_LOCK = threading.Lock()


def _steam_libraries_cached(root):
    """_steam_libraries(root) memoized for _STEAM_LIB_TTL seconds. Keyed on the
    root path so a changed root invalidates the cache. A lost race just
    recomputes, which is harmless."""
    now = time.monotonic()
    with _STEAM_LIB_LOCK:
        c = _STEAM_LIB_CACHE
        if (c["val"] is not None and c["root"] == root
                and now - c["at"] <= _STEAM_LIB_TTL):
            return list(c["val"])
    libs = _steam_libraries(root)
    with _STEAM_LIB_LOCK:
        _STEAM_LIB_CACHE.update(root=root, at=now, val=list(libs))
    return libs


def _steam_game_installed(appid):
    """True iff appid names a real (non-tool) Steam game with a manifest on disk.

    Validates against the SPECIFIC appmanifest_<appid>.acf in each library
    instead of globbing + parsing every manifest, so the launch path is O(#
    libraries) file stats rather than O(# installed games) parses. appid must
    be all-digits (caller-validated) so the filename can't escape the dir.
    Read-only, best-effort; never raises.
    """
    try:
        if not (isinstance(appid, str) and appid.isdigit()):
            return False
        root = _steam_root()
        if root is None:
            return False
        for steamapps in _steam_libraries_cached(root):
            mf = os.path.join(steamapps, "appmanifest_%s.acf" % appid)
            try:
                if not os.path.isfile(mf):
                    continue
                with open(mf, "r", encoding="utf-8", errors="replace") as f:
                    fields = _parse_acf(f.read())
            except OSError:
                continue
            except Exception:
                continue
            mid = fields.get("appid")
            name = fields.get("name")
            if mid != appid or not name:
                continue
            if _is_steam_tool(appid, name):
                continue
            return True
        return False
    except Exception:
        return False


def _parse_acf(text, keys=("appid", "name")):
    """Extract simple quoted top-level keys from an appmanifest .acf blob.

    Returns a dict of the requested string keys. The ACF format is
    `"key"  "value"` lines; we scan for the ones named in `keys` (default
    "appid"/"name", so existing callers are unchanged). Never raises.
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
        if key not in keys:
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
        for steamapps in _steam_libraries_cached(root):
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


def _acf_int(s):
    """Parse an ACF numeric string to int; 0 on missing/garbage (never raises)."""
    try:
        return int(s)
    except (TypeError, ValueError):
        return 0


def _download_state(flags):
    """Map StateFlags to a coarse, user-facing operation label."""
    if flags & (DL_DOWNLOADING | DL_PREALLOCATING):
        return "downloading"
    if flags & DL_VALIDATING:
        return "validating"
    if flags & (DL_STAGING | DL_COMMITTING):
        return "finalizing"
    if flags & (DL_UPDATE_RUNNING | DL_UPDATE_STARTED | DL_UPDATE_STOPPING):
        return "updating"
    # Incomplete bytes with no active-op bit: paused and queued look identical
    # in the appmanifest, so report the more useful "paused".
    return "paused"


def steam_downloads():
    """Steam apps with an in-progress download/update/validation, best-effort.

    Read-only; any failure yields [] rather than raising. Walks the same
    libraries as discover_steam_games() but reads StateFlags + byte counters
    from each appmanifest. Inclusion is an allowlist: an app is reported only
    when an active-op bit is set OR its byte counters prove an incomplete
    transfer. Uninstalls (2048) and fully-installed / stale pending-update
    entries with equal counters are omitted, so the list reflects only what is
    actually moving.
    """
    try:
        root = _steam_root()
        if root is None:
            return []
        keys = ("appid", "name", "StateFlags", "BytesToDownload", "BytesDownloaded")
        found = {}  # appid(str) -> dict
        for steamapps in _steam_libraries_cached(root):
            try:
                manifests = glob.glob(os.path.join(steamapps, "appmanifest_*.acf"))
            except Exception:
                continue
            for mf in manifests:
                try:
                    with open(mf, "r", encoding="utf-8", errors="replace") as f:
                        fields = _parse_acf(f.read(), keys=keys)
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
                flags = _acf_int(fields.get("StateFlags"))
                total = _acf_int(fields.get("BytesToDownload"))
                done = _acf_int(fields.get("BytesDownloaded"))
                if flags & DL_UNINSTALLING:
                    continue  # uninstall in progress, not a download
                incomplete = total > 0 and done < total
                if not (flags & DL_ACTIVE_OP) and not incomplete:
                    # Fully installed, or a stale flags==6 pending-update entry
                    # whose byte counters are equal: nothing is moving.
                    continue
                percent = (
                    int(max(0, min(100, round(done * 100.0 / total)))) if total > 0 else 0
                )
                found[appid] = {
                    "appid": int(appid),
                    "name": name,
                    "state": _download_state(flags),
                    "bytes_total": total,
                    "bytes_downloaded": done,
                    "percent": percent,
                }
        order = {"downloading": 0, "paused": 1}
        items = list(found.values())
        items.sort(key=lambda d: (order.get(d["state"], 2), d["name"].lower(), d["appid"]))
        return items
    except Exception:
        return []


# Steam caches each game's portrait "library capsule" (600x900 cover art) on
# disk under the Steam root. Two on-disk layouts exist across Steam versions;
# the app fetches this from the agent (never a CDN) so it stays LAN-only.
STEAM_COVER_CACHE = ("appcache", "librarycache")


def _steam_cover_path(appid):
    """Local path to the 600x900 library cover for a Steam appid, or None.

    Looks in <root>/appcache/librarycache/ for both known layouts:
      new (2023+):  <appid>/library_600x900.jpg
      old (flat):   <appid>_library_600x900.jpg
    appid must be all-digits (caller-validated too) so the path can never
    escape the cache dir. Read-only, best-effort; never raises.
    """
    if not (isinstance(appid, str) and appid.isdigit()):
        return None
    root = _steam_root()
    if root is None:
        return None
    cache = os.path.join(root, *STEAM_COVER_CACHE)
    candidates = (
        os.path.join(cache, appid, "library_600x900.jpg"),
        os.path.join(cache, "%s_library_600x900.jpg" % appid),
    )
    for p in candidates:
        try:
            if os.path.isfile(p):
                return p
        except OSError:
            continue
    return None


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
        # Only launch a Steam game we actually have installed (matches the
        # listed launchers); an unknown/uninstalled appid is not a launcher.
        # Validate the SPECIFIC appmanifest_<appid>.acf rather than globbing +
        # parsing every manifest on each launch.
        if _steam_game_installed(appid):
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


_MOCK_DL_PCT = 0


def mock_downloads():
    """--mock stand-in: one advancing download (0->100%, +7% per poll so the
    progress bar visibly moves) and one paused entry. No real Steam needed."""
    global _MOCK_DL_PCT
    _MOCK_DL_PCT = (_MOCK_DL_PCT + 7) % 101
    total = 42_000_000_000
    done = int(total * _MOCK_DL_PCT / 100)
    return [
        {"appid": 1091500, "name": "Cyberpunk 2077", "state": "downloading",
         "bytes_total": total, "bytes_downloaded": done, "percent": _MOCK_DL_PCT},
        {"appid": 570, "name": "Dota 2", "state": "paused",
         "bytes_total": 18_000_000_000, "bytes_downloaded": 5_400_000_000,
         "percent": 30},
    ]


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


def _write_config_launchers_locked(new_launchers):
    """Persist LAUNCHERS = new_launchers to CONFIG_PATH atomically.

    CONFIG_LOCK MUST already be held by the caller — this is the body of the
    read-modify-write and callers (add_launcher/delete_launcher) hold the lock
    across their cap-check + build + this write so a concurrent writer can't
    clobber from a stale LAUNCHERS snapshot.

    Reads the current config.json (or starts from a minimal skeleton if it is
    missing/unreadable/malformed), replaces the "launchers" key, and writes it
    back via a temp file + os.replace so a crash never leaves a truncated
    config that would wedge the Restart=always daemon. Raises on I/O failure
    (the caller maps it to a 500).
    """
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

    The whole read-modify-write (cap-check, id-derivation from the current set,
    build, persist) runs under CONFIG_LOCK so two concurrent adds can't both
    snapshot the same LAUNCHERS and clobber each other's write.
    """
    if not isinstance(label, str) or not label.strip() or len(label) > MAX_LABEL_LEN:
        raise ConfigError("label must be a non-empty string")
    if not _valid_cmd(cmd):
        raise ConfigError("cmd must be a non-empty list of non-empty strings")
    label = label.strip()
    with CONFIG_LOCK:
        if len(LAUNCHERS) >= MAX_LAUNCHERS:
            raise ConfigError("too many launchers (max %d)" % MAX_LAUNCHERS)
        existing = {l["id"] for l in LAUNCHERS}
        lid = _new_launcher_id(label, existing)
        new = list(LAUNCHERS) + [{"id": lid, "label": label, "cmd": list(cmd)}]
        _write_config_launchers_locked(new)
    return {"id": lid, "label": label, "kind": "custom"}


def delete_launcher(launcher_id):
    """Remove a custom launcher by id; persist. Returns True, or False if the
    id is a valid custom id that isn't present. Raises on persist failure.

    Presence-check + build + persist run under CONFIG_LOCK together so a
    concurrent add/delete can't clobber from a stale LAUNCHERS snapshot."""
    with CONFIG_LOCK:
        if not any(l["id"] == launcher_id for l in LAUNCHERS):
            return False
        new = [l for l in LAUNCHERS if l["id"] != launcher_id]
        _write_config_launchers_locked(new)
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
#   soft:  the box's own volume via the OS media keys (uinput), like a hardware
#           volume rocker. Volume and mute only, no power. Lowest priority, so it
#           appears as a fallback when neither panel nor CEC can drive the TV.
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
    # Select the OPS / Internal-PC input (the slot the box lives in), so a phone
    # tap pulls the panel back to the box from any other source. Validated on a
    # Newline TruTouch TT-7516UB; the OPS select code is shared across the UB/C
    # series. Panel-only: CEC/soft have no input-select equivalent.
    "source_box": 0x38,
    # Toggle the panel backlight (screen dark / lit) WITHOUT touching power. On
    # OPS displays, standby cuts power to the OPS slot and kills the box, so this
    # is the way to "turn the screen off" while the box keeps running in the
    # background. Toggle-only (the panel exposes no readable backlight state on
    # this firmware). Validated on a TT-7516UB: box stayed reachable after blank.
    "screen_toggle": 0x15,
}

# Ordered display inputs the Newline RS-232 panel can switch to, surfaced to the
# app as a source picker. Codes validated on a TT-7516UB (OPS / HDMI 1 / Home
# confirmed live; HDMI 2 / HDMI 3 per the Newline UB/C/STV code tables). This is
# panel-only: CEC cannot arbitrarily route a display's input from the box side.
PANEL_SOURCES = (
    ("ops", "Box (OPS)", 0x38),
    ("hdmi1", "HDMI 1", 0x0A),
    ("hdmi2", "HDMI 2", 0x52),
    ("hdmi3", "HDMI 3", 0x53),
    ("home", "Home", 0x1C),
)
PANEL_SOURCE_CODES = {sid: code for (sid, _label, code) in PANEL_SOURCES}

# Factory-remote keys (Newline UB/C/STV code tables; OK/arrows/menu/home/return
# validated against the UB manual). Lets the app emulate the physical Newline
# remote entirely over RS-232: navigate the panel OSD / Android home, open its
# menu and settings, without the IR remote. Panel-only.
PANEL_KEYS = {
    "up": 0x2E,
    "down": 0x2F,
    "left": 0x2C,
    "right": 0x2D,
    "ok": 0x2B,
    "menu": 0x1B,
    "home": 0x1C,
    "back": 0x1D,
    "settings": 0x20,
    "bright_up": 0x47,
    "bright_down": 0x48,
}

# Absolute-volume closed loop bounds. The panel has no working absolute-set
# command (0x05 ACKs but does nothing on the UB), yet volume READ (0x33) tracks
# step-by-step exactly, so absolute set = read, then step vol+/- until the
# target is reached. 110 caps a full 0->100 sweep with margin.
PANEL_VOL_MAX_STEPS = 110

# Populated at startup by set_panel(); {"device","baud","protocol"} or None.
PANEL = None

# One transaction on the panel's serial line at a time. The HTTP server is
# threaded, so a tv_info poll (volume read) can otherwise interleave with a
# running volume closed loop on the same /dev/ttyS*, crossing their replies.
PANEL_IO_LOCK = threading.Lock()


def _panel_frame(op):
    """Build the 11-byte Newline command frame for a unified TV op."""
    return PANEL_FRAME_HEAD + bytes([PANEL_CODES[op], PANEL_FRAME_TAIL])


def _hexstr(b):
    return " ".join("%02X" % x for x in b)


def _serial_send(device, baud, frame, expect_reply=True, timeout=1.0):
    """Open <device> raw at <baud> 8N1 (pure stdlib termios), write <frame>
    bytes, optionally read a short reply. Returns the reply bytes (may be
    empty). Raises OSError on open/IO failure. Serialized on PANEL_IO_LOCK so
    threaded HTTP handlers can't interleave transactions on the one line."""
    with PANEL_IO_LOCK:
        return _serial_send_locked(device, baud, frame, expect_reply, timeout)


def _serial_send_locked(device, baud, frame, expect_reply, timeout):
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


def _panel_send_code(code):
    """Send one raw Newline key code over the serial line. Success means the
    frame was written (the panel may or may not reply); the reply, if any, is
    echoed in stdout for diagnostics. ActionResult-shaped."""
    start = time.monotonic()
    frame = PANEL_FRAME_HEAD + bytes([code, PANEL_FRAME_TAIL])
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


def real_panel(op):
    """Send the Newline command frame for a unified TV op. ActionResult-shaped."""
    return _panel_send_code(PANEL_CODES[op])


def real_panel_source(sid):
    """Switch the panel to display input <sid> (see PANEL_SOURCES)."""
    return _panel_send_code(PANEL_SOURCE_CODES[sid])


def real_panel_key(key):
    """Send one factory-remote key (see PANEL_KEYS) to the panel."""
    return _panel_send_code(PANEL_KEYS[key])


def _panel_read_volume():
    """Current panel speaker volume (0-100 int), or None if unreadable. Uses the
    0x33 status query; the reply carries the level at byte 10:
    7F 09 99 A2 B3 C4 02 FF 01 33 <VOL> CF."""
    frame = PANEL_FRAME_HEAD + bytes([0x33, PANEL_FRAME_TAIL])
    try:
        reply = _serial_send(PANEL["device"], PANEL["baud"], frame)
    except Exception:
        return None
    if len(reply) >= 12 and reply[8:10] == bytes([0x01, 0x33]):
        return reply[10]
    return None


def panel_set_volume(level):
    """Set the panel volume to <level> (0-100) via a closed loop: read the
    current level, then step vol+/vol- until it matches. The panel ignores its
    documented absolute-set frame, but the read tracks each step exactly (one
    step = one unit, verified on a TT-7516UB), so stepping converges. Bails on
    read failure or a stalled loop. ActionResult-shaped, plus "level". The whole
    loop holds VOLUME_LOCK (individual frames are already serialized by
    PANEL_IO_LOCK, but two overlapping loops would still interleave steps)."""
    with VOLUME_LOCK:
        return _panel_set_volume_locked(level)


def _panel_set_volume_locked(level):
    start = time.monotonic()
    level = max(0, min(100, int(level)))

    def result(ok, cur, note):
        return {"ok": ok, "exit_code": 0 if ok else -1,
                "stdout": note, "stderr": "" if ok else note, "level": cur,
                "duration_ms": int((time.monotonic() - start) * 1000)}

    cur = _panel_read_volume()
    if cur is None:
        return result(False, None, "panel volume unreadable")
    steps = 0
    while cur != level and steps < PANEL_VOL_MAX_STEPS:
        code = 0x18 if level > cur else 0x17  # vol+ / vol-
        r = _panel_send_code(code)
        if not r["ok"]:
            return result(False, cur, "step failed: %s" % r["stderr"])
        steps += 1
        # The panel ACKs the key before it applies the level change, so give it
        # a moment to settle before reading — an immediate read sees the OLD
        # value and would misdiagnose a stall (measured on the TT-7516UB).
        time.sleep(0.12)
        nxt = _panel_read_volume()
        if nxt == cur:  # slow apply? one grace re-read before declaring a stall
            time.sleep(0.2)
            nxt = _panel_read_volume()
        if nxt is None:
            return result(False, cur, "panel volume unreadable mid-loop")
        if nxt == cur:  # panel stopped moving (limit or wedged) — don't spin
            return result(nxt == level, nxt,
                          "stalled at %d after %d steps" % (nxt, steps))
        cur = nxt
    return result(cur == level, cur, "level %d in %d steps" % (cur, steps))


def mock_panel(op):
    """--mock stand-in: log the frame that would go out, never open a device."""
    time.sleep(0.1)
    frame = _panel_frame(op)
    print("[panel] %s -> %s" % (op, _hexstr(frame)), flush=True)
    return {"ok": True, "exit_code": 0,
            "stdout": "[mock panel] %s -> %s\n" % (op, _hexstr(frame)),
            "stderr": "", "duration_ms": 100}


# ---- soft backend (box volume via the OS media keys) ----------------------
# Controls the box's own volume by emitting the KEY_VOLUMEUP/DOWN/MUTE media
# keys through uinput, exactly as the hardware volume rocker does. This matters
# on SteamOS Game Mode: Steam manages its own volume node and shows an on-screen
# volume OSD in response to those keys, whereas a direct wpctl change to the
# default sink neither shows the OSD nor affects what Steam is playing. Volume
# and mute only (there is no power key), and it is the lowest-priority backend,
# so it appears only when neither panel nor CEC drives the TV. Uses the virtual
# media-key device (see UInputMediaKeys), so it needs /dev/uinput, never sudo.
SOFT_OPS = ("volume_up", "volume_down", "mute")
SOFT = None           # {"adapter": ...} when the media-key device exists, else None
_MEDIA_DEV = None      # the persistent UInputMediaKeys device, created by set_soft
_PRE_MUTE_VOL = None   # volume before we muted, so unmute restores it (see _soft_mute)

# Serializes stateful volume transactions (mute's read-modify-write of the sink
# + _PRE_MUTE_VOL, and both absolute-set convergence loops). The HTTP server is
# threaded; two overlapping loops would fight step-against-step and the stale
# request could win.
VOLUME_LOCK = threading.Lock()


def set_soft(mock):
    """Create the virtual media-key device at startup. It is built once, up
    front, rather than on first use, because the compositor does not read a
    freshly hot-plugged input device for a second or two, which would silently
    drop the first volume presses. Creating it early gives gamescope time to
    enumerate it well before anyone touches volume. In --mock the soft backend
    stays off so the mock TV strip runs on the panel path. SOFT is set only when
    the device is created."""
    global SOFT, _MEDIA_DEV
    if mock:
        SOFT = None
        return
    if _MEDIA_DEV is None:
        try:
            _MEDIA_DEV = UInputMediaKeys()
        except Exception:
            _MEDIA_DEV = None
    SOFT = {"adapter": "OS volume keys"} if _MEDIA_DEV is not None else None


def soft_available():
    return SOFT is not None


def real_soft(op):
    """Change box volume. Volume up/down emit media keys via the media-key device
    so the OS moves the volume and (in Game Mode) shows its OSD. Mute drives the
    volume to 0 the same way (see _soft_mute), because gamescope does not bind
    KEY_MUTE. ActionResult-shaped. Power ops are rejected (no volume key)."""
    start = time.monotonic()
    if op == "mute":
        return _soft_mute(start)
    code = SOFT_MEDIA_KEYS.get(op)
    if code is None:
        return {"ok": False, "exit_code": -1, "stdout": "",
                "stderr": "%s is not a volume op" % op, "duration_ms": 0}
    if _MEDIA_DEV is None:
        return {"ok": False, "exit_code": -1, "stdout": "",
                "stderr": "media-key device unavailable",
                "duration_ms": int((time.monotonic() - start) * 1000)}
    try:
        _MEDIA_DEV.tap(code)
    except OSError as e:
        return {"ok": False, "exit_code": -1, "stdout": "",
                "stderr": "%s: %s" % (e.__class__.__name__, e),
                "duration_ms": int((time.monotonic() - start) * 1000)}
    return {"ok": True, "exit_code": 0, "stdout": "sent %s" % op, "stderr": "",
            "duration_ms": int((time.monotonic() - start) * 1000)}


def _wpctl_volume_line():
    """Raw 'wpctl get-volume @DEFAULT_AUDIO_SINK@' stdout, or None if unreadable.
    Looks like 'Volume: 0.45' or 'Volume: 0.00 [MUTED]'."""
    wp = shutil.which("wpctl")
    if wp is None:
        return None
    try:
        r = subprocess.run([wp, "get-volume", "@DEFAULT_AUDIO_SINK@"],
                           capture_output=True, timeout=4, env=_user_env())
    except Exception:
        return None
    if r.returncode != 0:
        return None
    return (r.stdout or b"").decode("utf-8", "replace")


def _soft_muted():
    """Current mute state of the box's default sink (True/False), or None if it
    can't be read. Volume 0 counts as muted: driving the volume to 0 with the
    media key is exactly how mute is applied, and the sink reads '[MUTED]' there."""
    line = _wpctl_volume_line()
    if line is None:
        return None
    return "MUTED" in line.upper()


def _soft_volume():
    """Current box volume as a float (0.0-1.0+), or None if unreadable."""
    line = _wpctl_volume_line()
    if line is None:
        return None
    for tok in line.split():
        try:
            return float(tok)
        except ValueError:
            continue
    return None


def _wpctl_set(*args):
    """Run 'wpctl <args>' in the user's audio session. Returns the CompletedProcess
    or None if wpctl is missing / the call raised."""
    wp = shutil.which("wpctl")
    if wp is None:
        return None
    try:
        return subprocess.run([wp] + list(args), capture_output=True,
                              timeout=4, env=_user_env())
    except Exception:
        return None


def _soft_mute(start):
    """Toggle box mute. gamescope binds no KEY_MUTE and shows no mute OSD, so a
    plain wpctl mute would be invisible on the panel. Instead mute drives the
    volume to 0 with the volume-down media key: that fires the on-screen volume
    OSD (bar empties to the muted-speaker icon) AND leaves the sink '[MUTED]'.
    The pre-mute level is saved so unmute restores it. ActionResult-shaped with a
    "muted" field for the app's own indicator. Serialized on VOLUME_LOCK: it is
    a read-modify-write of sink state + _PRE_MUTE_VOL, and a double-tap from the
    app would otherwise interleave two toggles into a wrong final state."""
    global _PRE_MUTE_VOL
    with VOLUME_LOCK:
        return _soft_mute_locked(start)


def _soft_mute_locked(start):
    global _PRE_MUTE_VOL
    def result(ok, muted, stdout="", stderr=""):
        return {"ok": ok, "exit_code": 0 if ok else -1, "stdout": stdout,
                "stderr": stderr, "muted": muted,
                "duration_ms": int((time.monotonic() - start) * 1000)}
    if shutil.which("wpctl") is None:
        return result(False, None, stderr="wpctl not found for mute")
    if _soft_muted():
        # Unmute: clear the flag and restore the volume we saved when muting.
        _wpctl_set("set-mute", "@DEFAULT_AUDIO_SINK@", "0")
        if _PRE_MUTE_VOL is not None:
            _wpctl_set("set-volume", "@DEFAULT_AUDIO_SINK@", "%.2f" % _PRE_MUTE_VOL)
            _PRE_MUTE_VOL = None
        return result(True, False, stdout="unmuted")
    # Mute: remember the current level, drop just above zero silently, then one
    # volume-down media key to land on 0 with the OSD showing. Keep an already
    # saved pre-mute level: the media tap applies asynchronously, so a rapid
    # second toggle can arrive while the sink still reads unmuted at 0.02 —
    # overwriting would trade the user's real level for that 2%.
    if _PRE_MUTE_VOL is None:
        _PRE_MUTE_VOL = _soft_volume()
    _wpctl_set("set-volume", "@DEFAULT_AUDIO_SINK@", "0.02")
    tapped = False
    if _MEDIA_DEV is not None:
        try:
            _MEDIA_DEV.tap(KEY_VOLUMEDOWN)
            tapped = True
        except OSError:
            tapped = False
    if tapped:
        # Wait for the compositor to apply the tap so the sink reads [MUTED]
        # before the lock releases — a back-to-back toggle then sees the truth.
        deadline = time.monotonic() + 0.6
        while time.monotonic() < deadline:
            time.sleep(0.08)
            if _soft_muted():
                break
        else:
            tapped = False  # never landed; fall through to the direct flag
    if not tapped:
        # No media-key device (or it failed): no OSD is possible, so just set the
        # mute flag directly. Correct state, only the on-screen indicator is lost.
        _wpctl_set("set-mute", "@DEFAULT_AUDIO_SINK@", "1")
    return result(True, True, stdout="muted")


def soft_set_volume(level):
    """Set the box volume to <level> percent (0-100). Prefers media-key stepping
    (Game Mode shows its OSD and Steam tracks it; direct wpctl writes are
    invisible there), converging via a closed loop on the sink's real level. If
    stepping doesn't move the sink (desktop session with no key handler), falls
    back to one direct wpctl set. ActionResult-shaped, plus "level". Serialized
    on VOLUME_LOCK so two overlapping sets can't fight step-against-step."""
    with VOLUME_LOCK:
        return _soft_set_volume_locked(level)


def _soft_set_volume_locked(level):
    global _PRE_MUTE_VOL
    start = time.monotonic()
    level = max(0, min(100, int(level)))
    target = level / 100.0
    # Slider endpoints mean exactly "silent" / "max": no convergence tolerance
    # there, or a request for 0 could return ok while audio still plays.
    tol = 0.001 if level in (0, 100) else 0.025

    def result(ok, cur, note):
        return {"ok": ok, "exit_code": 0 if ok else -1,
                "stdout": note, "stderr": "" if ok else note,
                "level": None if cur is None else int(round(cur * 100)),
                "duration_ms": int((time.monotonic() - start) * 1000)}

    cur = _soft_volume()
    if cur is None:
        return result(False, None, "box volume unreadable (wpctl)")
    # Mute leaves the flag set at 0; a positive target should unmute first so
    # the level change is audible (mirrors what the volume keys do). The saved
    # pre-mute level is stale once an explicit level is chosen — drop it so a
    # later mute/unmute cycle can't restore a forgotten volume.
    if level > 0 and _soft_muted():
        _wpctl_set("set-mute", "@DEFAULT_AUDIO_SINK@", "0")
        _PRE_MUTE_VOL = None
    for _ in range(40):  # media-key steps are ~5%, so 40 covers 0->100 twice
        if abs(cur - target) <= tol:
            return result(True, cur, "level %d" % int(round(cur * 100)))
        if _MEDIA_DEV is None:
            break
        code = KEY_VOLUMEUP if target > cur else KEY_VOLUMEDOWN
        try:
            _MEDIA_DEV.tap(code)
        except OSError:
            break
        time.sleep(0.08)  # let the compositor apply the step before re-reading
        nxt = _soft_volume()
        if nxt is None or abs(nxt - cur) < 0.001:
            break  # no handler moving the sink — fall through to direct set
        # Overshoot straddling the target counts as done (step > remaining gap).
        if (cur < target < nxt) or (nxt < target < cur):
            return result(True, nxt, "level %d" % int(round(nxt * 100)))
        cur = nxt
    # Direct fallback (desktop sessions; no OSD, but the level is correct).
    r = _wpctl_set("set-volume", "@DEFAULT_AUDIO_SINK@", "%.2f" % target)
    if r is None or r.returncode != 0:
        return result(False, cur, "wpctl set-volume failed")
    return result(True, target, "level %d (direct)" % level)


def mock_soft(op):
    """--mock stand-in for a box-volume op: log it, touch nothing, succeed."""
    time.sleep(0.1)
    print("[soft] %s" % op, flush=True)
    return {"ok": True, "exit_code": 0, "stdout": "[mock soft] %s\n" % op,
            "stderr": "", "duration_ms": 100}


# ---- unified dispatch -----------------------------------------------------
# CEC has no discrete power-off; its standby command IS the off state.
_TV_TO_CEC = {"power_on": "power_on", "power_off": "standby",
              "volume_up": "volume_up", "volume_down": "volume_down",
              "mute": "mute"}

_POWER_OPS = ("power_on", "power_off")

# Ops only the RS-232 panel can do (no CEC/soft equivalent): jump to the box's
# OPS input, and blank/unblank the screen without cutting power.
_PANEL_ONLY_OPS = ("source_box", "screen_toggle")


def set_tv(mock):
    """Probe every TV backend at startup (call after load_config)."""
    set_cec(mock)
    set_panel(mock)
    set_soft(mock)


def _tv_hw_backend():
    """The external TV backend for power (and TV volume, when chosen): the serial
    panel first (it can power on from standby), then CEC. None when neither
    exists. Kept separate from box volume, which the soft backend handles."""
    if panel_available():
        return "panel"
    if cec_available():
        return "cec"
    return None


def tv_info():
    """GET /api/tv body, or None when nothing is controllable. The two concerns
    are split so the app can offer box vs TV volume: tv_power/tv_volume mean an
    external TV backend (panel/CEC) is present; box_volume means the box's own OS
    volume (soft) is available. Volume defaults to the box (see tv_send)."""
    hw = _tv_hw_backend()
    box_vol = soft_available()
    if hw is None and not box_vol:
        return None
    if hw == "panel":
        backend, adapter = "panel", "Newline RS-232 (%s @ %d)" % (
            PANEL["device"], PANEL["baud"])
    elif hw == "cec":
        cec = cec_current()
        backend, adapter = "cec", (cec["adapter"] if cec else "CEC")
    else:
        backend, adapter = "soft", (SOFT["adapter"] if SOFT else "OS volume keys")
    return {
        "available": True,
        "backend": backend,
        "adapter": adapter,
        "ops": list(TV_OPS),
        "box_volume": box_vol,
        "tv_volume": hw is not None,
        "tv_power": hw is not None,
        # Input source switch (jump the panel to the box's OPS input). Only the
        # RS-232 panel backend can do it, so the app shows the button solely for
        # panel boxes — CEC/soft boxes never see it (keeps the default UI clean).
        "source_box": panel_available(),
        # Full display-input picker (panel only). Each entry: {id,label}; the app
        # POSTs /api/tv/source/<id> to switch. Empty when no panel backend.
        "sources": ([{"id": sid, "label": label}
                     for (sid, label, _code) in PANEL_SOURCES]
                    if panel_available() else []),
        # Screen blank/unblank without cutting power (keeps the box alive when an
        # OPS display would otherwise power the box off in standby). Panel-only.
        "screen_toggle": panel_available(),
        # Factory-remote key emulation (arrows/ok/menu/home/back/settings) over
        # RS-232, so the app's Remote view can drive the panel OSD. Panel-only.
        "keys": panel_available(),
        # Box mute state, so the app shows the right mute indicator on connect.
        "muted": _soft_muted() if box_vol else None,
        # Current levels (0-100 or null) so the app's volume slider can show and
        # keep a real position. Both are cheap reads (wpctl / one serial query).
        "box_volume_level": (None if (v := _soft_volume()) is None
                             else max(0, min(100, int(round(v * 100)))))
                            if box_vol else None,
        "tv_volume_level": _panel_read_volume() if panel_available() else None,
    }


def _send_tv_hw(op, mock):
    """Route an op to the external TV backend (panel/CEC), or None if neither."""
    b = _tv_hw_backend()
    if b == "panel":
        return mock_panel(op) if mock else real_panel(op)
    if b == "cec":
        cec_op = _TV_TO_CEC[op]
        return mock_cec(cec_op) if mock else real_cec(cec_op)
    return None


def tv_send(op, mock, target=None):
    """Dispatch a TV op. Power always goes to the external TV backend. Volume
    goes to the box's own OS volume (soft) by default, or to the TV backend when
    target == "tv" (the app's opt-in). Falls back to whichever exists when the
    chosen target is missing. None when nothing can handle it (caller 404s)."""
    if op in _PANEL_ONLY_OPS:
        # Input-select and screen-blank are panel-only (RS-232). No CEC/soft
        # fallback exists for them.
        if not panel_available():
            return None
        return mock_panel(op) if mock else real_panel(op)
    if op in _POWER_OPS:
        return _send_tv_hw(op, mock)
    if target != "tv" and soft_available():
        return mock_soft(op) if mock else real_soft(op)
    r = _send_tv_hw(op, mock)
    if r is not None:
        return r
    if soft_available():
        return mock_soft(op) if mock else real_soft(op)
    return None


# ---------------------------------------------------------------------------
# MPRIS media-player control (now-playing + transport) over the user session
# bus via `busctl`. Named MPRIS_*/mpris_* so it never collides with the box's
# OS-volume media-key device (_MEDIA_DEV / SOFT_MEDIA_KEYS / UInputMediaKeys),
# which is a different "media". No new listener/port; ships with systemd.
# ---------------------------------------------------------------------------

MPRIS_PREFIX = "org.mpris.MediaPlayer2."
MPRIS_OBJPATH = "/org/mpris/MediaPlayer2"
MPRIS_PLAYER_IFACE = "org.mpris.MediaPlayer2.Player"
MPRIS_MAX_PLAYERS = 8
MPRIS_ART_MAX = 2 * 1024 * 1024  # 2 MiB read cap on album art

# Fixed transport op -> Player method. Closed table: no client string reaches
# D-Bus; "seek" is handled separately (SetPosition, Seek-delta fallback).
MPRIS_METHODS = {
    "play": "Play", "pause": "Pause", "play_pause": "PlayPause",
    "next": "Next", "previous": "Previous", "stop": "Stop",
}
MPRIS_OPS = tuple(MPRIS_METHODS) + ("seek",)

BUSCTL = None            # "busctl" when usable (or in --mock), else None
_MPRIS_ART_ROOTS = ()    # realpath allowlist for file:// art, set by set_mpris


def mpris_available():
    """True when the user session bus and busctl are both present."""
    return (shutil.which("busctl") is not None
            and os.path.exists(os.path.join(XDG_RUNTIME_DIR, "bus")))


def set_mpris(mock):
    """Startup probe. Enables MPRIS when busctl + the session bus exist (always
    in --mock), and computes the realpath allowlist for file:// album art."""
    global BUSCTL, _MPRIS_ART_ROOTS
    home = os.path.expanduser("~")
    roots = []
    for p in ("/tmp", XDG_RUNTIME_DIR, os.path.join(home, ".cache"),
              os.path.join(home, ".var"), os.path.join(home, ".mozilla")):
        try:
            roots.append(os.path.realpath(p))
        except Exception:
            pass
    _MPRIS_ART_ROOTS = tuple(roots)
    BUSCTL = "busctl" if (mock or mpris_available()) else None


def _bus_val(v):
    """Unwrap one busctl --json=short variant {"type","data"} to a Python value,
    recursing into a{sv} dicts. Arrays/scalars pass through. Never raises."""
    if not isinstance(v, dict) or "data" not in v:
        return v
    d = v["data"]
    if str(v.get("type", "")).startswith("a{") and isinstance(d, dict):
        return {k: _bus_val(x) for k, x in d.items()}
    return d


def _busctl_json(args, timeout=2):
    """busctl --user --json=short <args> -> parsed JSON, or None. Never raises;
    runs with the user session env so it targets the right bus."""
    if BUSCTL is None:
        return None
    try:
        r = subprocess.run([BUSCTL, "--user", "--json=short"] + list(args),
                           capture_output=True, timeout=timeout, env=_user_env())
    except Exception:
        return None
    if r.returncode != 0:
        return None
    try:
        return json.loads(r.stdout.decode("utf-8", "replace"))
    except Exception:
        return None


def _busctl_call(argv, start, timeout=3):
    """Run a busctl method call; return an ActionResult (mirrors real_cec)."""
    try:
        r = subprocess.run(argv, capture_output=True, timeout=timeout,
                           env=_user_env())
    except subprocess.TimeoutExpired:
        return {"ok": False, "exit_code": -1, "stdout": "",
                "stderr": "busctl timed out",
                "duration_ms": int((time.monotonic() - start) * 1000)}
    except Exception as e:
        return {"ok": False, "exit_code": -1, "stdout": "",
                "stderr": "%s: %s" % (e.__class__.__name__, e),
                "duration_ms": int((time.monotonic() - start) * 1000)}
    return {"ok": r.returncode == 0, "exit_code": r.returncode,
            "stdout": (r.stdout or b"").decode("utf-8", "replace"),
            "stderr": (r.stderr or b"").decode("utf-8", "replace"),
            "duration_ms": int((time.monotonic() - start) * 1000)}


def _mpris_list_names():
    """Bus names of all MPRIS players (org.mpris.MediaPlayer2.*)."""
    obj = _busctl_json(["call", "org.freedesktop.DBus", "/org/freedesktop/DBus",
                        "org.freedesktop.DBus", "ListNames"])
    names = obj.get("data") if isinstance(obj, dict) else None
    # busctl wraps the single 'as' out-arg as data:[[name, ...]] — unwrap it.
    if isinstance(names, list) and names and isinstance(names[0], list):
        names = names[0]
    if not isinstance(names, list):
        return []
    return [n for n in names
            if isinstance(n, str) and n.startswith(MPRIS_PREFIX)
            and all(c.isalnum() or c in "._-" for c in n)]


def _mpris_getall(name):
    """Every property across BOTH MPRIS interfaces (Player transport props +
    the root MediaPlayer2 Identity), merged into a flat {prop: value} dict
    (values unwrapped), or {} on total failure.

    The empty-interface form `GetAll s ""` is NOT supported by real players
    (verified on-box: busctl returns 'No such interface ""'), so we query each
    interface explicitly. Per-call D-Bus wait is bounded with --timeout=1 so a
    hung player can't stall the list."""
    props = {}
    for iface in (MPRIS_PLAYER_IFACE, "org.mpris.MediaPlayer2"):
        obj = _busctl_json(["--timeout=1", "call", name, MPRIS_OBJPATH,
                            "org.freedesktop.DBus.Properties", "GetAll", "s", iface])
        if not isinstance(obj, dict):
            continue
        data = obj.get("data")
        if isinstance(data, list) and data and isinstance(data[0], dict):
            data = data[0]  # single a{sv} out-arg wrapped as a list
        if isinstance(data, dict):
            for k, v in data.items():
                props[k] = _bus_val(v)
    return props


def _mpris_str(v):
    return v if isinstance(v, str) else ""


def _mpris_int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return 0


def _art_key(url):
    """Short stable cache-buster for an art URL (changes with the track)."""
    if not url:
        return ""
    return hashlib.sha1(url.encode("utf-8", "replace")).hexdigest()[:16]


def _art_url_path(url):
    """If `url` is a file:// path under the art allowlist, return the real path;
    else None. Keeps "no client-addressable file routes" honest — only art a
    running player advertises, under a small set of cache dirs. Never raises."""
    if not isinstance(url, str) or not url.startswith("file://"):
        return None
    try:
        real = os.path.realpath(unquote(urlparse(url).path))
    except Exception:
        return None
    for root in _MPRIS_ART_ROOTS:
        if real == root or real.startswith(root + os.sep):
            return real
    return None


def _mpris_player_info(name):
    """Build the player dict for one MPRIS name, or None on failure."""
    props = _mpris_getall(name)
    if not props:
        return None
    meta = props.get("Metadata")
    if not isinstance(meta, dict):
        meta = {}
    artists = meta.get("xesam:artist")
    if isinstance(artists, list):
        artist = ", ".join(str(a) for a in artists if isinstance(a, str))
    else:
        artist = _mpris_str(artists)
    art_url = _mpris_str(meta.get("mpris:artUrl"))
    servable = _art_url_path(art_url) is not None  # file:// only; http(s) never fetched
    length_us = _mpris_int(meta.get("mpris:length"))
    pos_us = _mpris_int(props.get("Position"))
    status = _mpris_str(props.get("PlaybackStatus"))
    try:
        rate = float(props.get("Rate"))
    except (TypeError, ValueError):
        rate = 1.0
    return {
        "id": name[len(MPRIS_PREFIX):],
        "identity": _mpris_str(props.get("Identity")) or name[len(MPRIS_PREFIX):],
        "status": status if status in ("Playing", "Paused", "Stopped") else "Stopped",
        "title": _mpris_str(meta.get("xesam:title")),
        "artist": artist,
        "album": _mpris_str(meta.get("xesam:album")),
        "position_ms": pos_us // 1000 if pos_us > 0 else 0,
        "length_ms": length_us // 1000 if length_us > 0 else 0,
        "rate": rate,
        "can_seek": bool(props.get("CanSeek")),
        "can_go_next": bool(props.get("CanGoNext")),
        "can_go_previous": bool(props.get("CanGoPrevious")),
        "can_play": bool(props.get("CanPlay")),
        "can_pause": bool(props.get("CanPause")),
        "art": servable,
        "art_key": _art_key(art_url) if servable else "",
    }


def list_mpris_players():
    """All MPRIS players, Playing first, capped at MPRIS_MAX_PLAYERS. Best-effort;
    per-player failures are skipped. The name list is capped BEFORE the (one
    GetAll each) loop so a box that spawns many idle players (Chromium) can't
    blow the time budget; results are then sorted Playing-first. Worst case is
    (1 + MPRIS_MAX_PLAYERS) busctl calls, each bounded by the 2 s subprocess
    timeout (a live bus answers in ms); pathological all-hang ceiling ~18 s."""
    names = _mpris_list_names()[:MPRIS_MAX_PLAYERS]
    players = []
    for n in names:
        info = _mpris_player_info(n)
        if info is not None:
            players.append(info)
    order = {"Playing": 0, "Paused": 1}
    players.sort(key=lambda p: (order.get(p["status"], 2), p["identity"].lower()))
    return players


def mpris_info():
    """{"available":True,"players":[...]} or None when MPRIS is unavailable."""
    if BUSCTL is None:
        return None
    return {"available": True, "players": list_mpris_players()}


def _mpris_seek(name, position_ms, start):
    """Seek to an absolute position (ms). Prefers SetPosition (needs the current
    trackid); falls back to a relative Seek for players that reject it."""
    if position_ms is None or position_ms < 0:
        return {"ok": False, "exit_code": -1, "stdout": "",
                "stderr": "position_ms required", "duration_ms": 0}
    props = _mpris_getall(name)
    meta = props.get("Metadata") if isinstance(props.get("Metadata"), dict) else {}
    trackid = _mpris_str(meta.get("mpris:trackid"))
    length_us = _mpris_int(meta.get("mpris:length"))
    pos_us = position_ms * 1000
    if length_us > 0:
        pos_us = max(0, min(length_us, pos_us))
    if trackid:
        r = _busctl_call([BUSCTL, "--user", "call", name, MPRIS_OBJPATH,
                          MPRIS_PLAYER_IFACE, "SetPosition", "ox",
                          trackid, str(pos_us)], start)
        if r["ok"]:
            return r
    delta = pos_us - _mpris_int(props.get("Position"))
    return _busctl_call([BUSCTL, "--user", "call", name, MPRIS_OBJPATH,
                         MPRIS_PLAYER_IFACE, "Seek", "x", str(delta)], start)


def real_mpris_op(player, op, position_ms=None):
    """Run a transport op on <player>. ActionResult-shaped, or None for an
    unknown/dead player or op (route 404s). Re-validates the player against a
    fresh ListNames so we never act on a name that vanished."""
    start = time.monotonic()
    name = MPRIS_PREFIX + player
    if name not in _mpris_list_names():
        return None
    if op == "seek":
        return _mpris_seek(name, position_ms, start)
    method = MPRIS_METHODS.get(op)
    if method is None:
        return None
    return _busctl_call([BUSCTL, "--user", "call", name, MPRIS_OBJPATH,
                         MPRIS_PLAYER_IFACE, method], start)


_ART_MAGIC = (
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
)


def _sniff_image(data):
    """Magic-byte image type, or None (so a text/HTML file can't be served)."""
    for magic, mime in _ART_MAGIC:
        if data.startswith(magic):
            return mime
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def mpris_art(player, art_key):
    """Resolve <player>'s CURRENT advertised art file (the client never supplies
    a path), enforce the 2 MiB read cap, and sniff the image type. Returns
    (data, mime) or None. `art_key` must match the current track's key (else the
    track changed — 404)."""
    props = _mpris_getall(MPRIS_PREFIX + player)
    meta = props.get("Metadata") if isinstance(props.get("Metadata"), dict) else {}
    art_url = _mpris_str(meta.get("mpris:artUrl"))
    if art_key and _art_key(art_url) != art_key:
        return None
    path = _art_url_path(art_url)
    if path is None:
        return None
    try:
        if os.path.getsize(path) > MPRIS_ART_MAX:  # cheap pre-filter
            return None
        with open(path, "rb") as f:
            data = f.read(MPRIS_ART_MAX + 1)  # read-time enforcement
    except OSError:
        return None
    if len(data) > MPRIS_ART_MAX:
        return None
    mime = _sniff_image(data)
    return (data, mime) if mime else None


_MOCK_MPRIS_POS = 0
# 1x1 transparent PNG, so --mock album art works on macOS with no player.
_MOCK_ART_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")


def mock_mpris_info():
    """--mock: one advancing Spotify-like player."""
    global _MOCK_MPRIS_POS
    _MOCK_MPRIS_POS = (_MOCK_MPRIS_POS + 3000) % 214000
    return {"available": True, "players": [{
        "id": "spotify", "identity": "Spotify", "status": "Playing",
        "title": "Midnight City", "artist": "M83",
        "album": "Hurry Up, We're Dreaming",
        "position_ms": _MOCK_MPRIS_POS, "length_ms": 214000, "rate": 1.0,
        "can_seek": True, "can_go_next": True, "can_go_previous": True,
        "can_play": True, "can_pause": True, "art": True, "art_key": "mockart1",
    }]}


def mock_mpris_op(player, op, position_ms=None):
    print("[mpris] %s %s%s" % (player, op,
          "" if position_ms is None else " -> %dms" % position_ms), flush=True)
    return {"ok": True, "exit_code": 0,
            "stdout": "[mock mpris] %s %s" % (player, op),
            "stderr": "", "duration_ms": 40}


def mock_mpris_art(player, art_key):
    return (_MOCK_ART_PNG, "image/png")


# ---------------------------------------------------------------------------
# Live screen preview: grab one composited frame on demand, downscale to a
# small JPEG, serve over the bearer port (reuses _send_bytes, §3c). gamescope
# (Game Mode) does NOT implement wlr-screencopy, so grim fails — the primary
# path is `gamescopectl screenshot <path>`, which writes a 4K PNG
# ASYNCHRONOUSLY (~1.4s on a real Bazzite box), downscaled to a ~60KB 960px
# JPEG via ImageMagick/ffmpeg. KDE Desktop sessions use spectacle. All
# invocations + timings verified on-box.
# ---------------------------------------------------------------------------

SCREEN_MIN_INTERVAL_S = 0.5       # server floor: at most ~2 captures/sec, any client count
SCREEN_CAPTURE_TIMEOUT_S = 8      # per-step ceiling (gamescopectl async write + downscale)
SCREEN_MAX_BYTES = 12 * 1024 * 1024
SCREEN_WIDTH = 960                # downscale target width
SCREEN_LOCK = threading.Lock()    # single-flight: never stack captures
_SCREEN = None                    # capability dict or None; set by set_screen
_SCREEN_CACHE = {"ts": 0.0, "data": None, "mime": None}  # 500 ms frame cache


def _screen_downscaler():
    """(argv-builder, name) for a PNG->JPEG downscaler, or (None, None). Prefers
    ImageMagick, then ffmpeg — both ship on gaming boxes; keeps the agent off PIL
    (absent on stock SteamOS)."""
    if shutil.which("magick"):
        return (lambda src, dst: ["magick", src, "-resize", "%dx" % SCREEN_WIDTH,
                                  "-quality", "80", dst], "magick")
    if shutil.which("convert"):
        return (lambda src, dst: ["convert", src, "-resize", "%dx" % SCREEN_WIDTH,
                                  "-quality", "80", dst], "convert")
    if shutil.which("ffmpeg"):
        return (lambda src, dst: ["ffmpeg", "-y", "-loglevel", "error", "-i", src,
                                  "-vf", "scale=%d:-1" % SCREEN_WIDTH, "-q:v", "6", dst],
                "ffmpeg")
    return (None, None)


def set_screen(mock):
    """Detect a capture path at startup: gamescopectl when a gamescope socket
    exists, else spectacle for a KDE desktop. Requires a downscaler for real
    frames (a raw 4K PNG is too big to stream)."""
    global _SCREEN
    if mock:
        _SCREEN = {"session": "mock", "backends": ["mock"], "dscale": None}
        return
    dbuild, _ = _screen_downscaler()
    if dbuild is None:
        _SCREEN = None
        return
    gs = [s for s in _wayland_display_sockets() if s.startswith("gamescope-")]
    backends = []
    if shutil.which("gamescopectl") and gs:
        backends.append("gamescopectl")
    if shutil.which("spectacle"):
        backends.append("spectacle")
    if not backends:
        _SCREEN = None
        return
    _SCREEN = {"session": "gamescope" if gs else "desktop", "backends": backends,
               "dscale": dbuild, "gs_socket": gs[0] if gs else None}


def _screen_env():
    env = _user_env()
    if _SCREEN and _SCREEN.get("gs_socket"):
        env["WAYLAND_DISPLAY"] = _SCREEN["gs_socket"]
    else:
        socks = _wayland_display_sockets()
        if len(socks) == 1:
            env["WAYLAND_DISPLAY"] = socks[0]
    env.setdefault("DISPLAY", ":0")
    return env


def _png_complete(path):
    """True when a PNG is fully written: >=100 bytes and ends in the IEND chunk.
    gamescopectl writes async, so the file appears before it is complete."""
    try:
        if os.path.getsize(path) < 100:
            return False
        with open(path, "rb") as f:
            f.seek(-8, os.SEEK_END)
            return f.read(8) == b"IEND\xaeB`\x82"
    except OSError:
        return False


def _grab_gamescopectl(env, outdir):
    """`gamescopectl screenshot <png>` then poll for the async write to settle."""
    png = os.path.join(outdir, "frame.png")
    try:
        os.unlink(png)
    except OSError:
        pass
    try:
        subprocess.run(["gamescopectl", "screenshot", png], env=env,
                       timeout=SCREEN_CAPTURE_TIMEOUT_S,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        return None
    deadline = time.monotonic() + SCREEN_CAPTURE_TIMEOUT_S
    while time.monotonic() < deadline:
        if os.path.exists(png):
            s1 = os.path.getsize(png)
            time.sleep(0.1)
            if s1 == os.path.getsize(png) and _png_complete(png):
                return png
        time.sleep(0.1)
    return None


def _grab_spectacle(env, outdir):
    """`spectacle -b -n -o <png>` (background, no notify) for a KDE desktop."""
    png = os.path.join(outdir, "frame.png")
    try:
        os.unlink(png)
    except OSError:
        pass
    try:
        subprocess.run(["spectacle", "-b", "-n", "-o", png], env=env,
                       timeout=SCREEN_CAPTURE_TIMEOUT_S,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        return None
    return png if _png_complete(png) else None


def real_screen_frame():
    """Capture one frame -> (jpeg_bytes, "image/jpeg") or None. Single-flight +
    500 ms cache so any number of pollers cause at most ~2 captures/sec."""
    if _SCREEN is None:
        return None
    now = time.monotonic()
    if _SCREEN_CACHE["data"] is not None and now - _SCREEN_CACHE["ts"] < SCREEN_MIN_INTERVAL_S:
        return (_SCREEN_CACHE["data"], _SCREEN_CACHE["mime"])
    if not SCREEN_LOCK.acquire(blocking=False):
        # A capture is already running: serve the last frame if we have one,
        # else wait for the in-flight capture rather than starting a second.
        if _SCREEN_CACHE["data"] is not None:
            return (_SCREEN_CACHE["data"], _SCREEN_CACHE["mime"])
        SCREEN_LOCK.acquire()
    try:
        now = time.monotonic()
        if _SCREEN_CACHE["data"] is not None and now - _SCREEN_CACHE["ts"] < SCREEN_MIN_INTERVAL_S:
            return (_SCREEN_CACHE["data"], _SCREEN_CACHE["mime"])
        env = _screen_env()
        outdir = os.path.join(XDG_RUNTIME_DIR, "couchside-screen")
        try:
            os.makedirs(outdir, mode=0o700, exist_ok=True)
        except OSError:
            return None
        png = os.path.join(outdir, "frame.png")
        jpg = os.path.join(outdir, "frame.jpg")
        try:
            grabbed = None
            for backend in _SCREEN["backends"]:
                if backend == "gamescopectl":
                    grabbed = _grab_gamescopectl(env, outdir)
                elif backend == "spectacle":
                    grabbed = _grab_spectacle(env, outdir)
                if grabbed:
                    break
            if not grabbed:
                return None
            data = None
            try:
                subprocess.run(_SCREEN["dscale"](grabbed, jpg), env=env,
                               timeout=SCREEN_CAPTURE_TIMEOUT_S,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                with open(jpg, "rb") as f:
                    data = f.read(SCREEN_MAX_BYTES + 1)
            except Exception:
                return None
            if not data or len(data) > SCREEN_MAX_BYTES:
                return None
            _SCREEN_CACHE.update(ts=time.monotonic(), data=data, mime="image/jpeg")
            return (data, "image/jpeg")
        finally:
            # Always clean tmpfs, even when the grab itself failed (no partial
            # frame.png left behind on a box that never captures successfully).
            for p in (png, jpg):
                try:
                    os.unlink(p)
                except OSError:
                    pass
    finally:
        SCREEN_LOCK.release()


def screen_info():
    """{available, session, backends, formats} or None when no capture path."""
    if _SCREEN is None:
        return None
    return {"available": True, "session": _SCREEN["session"],
            "backends": _SCREEN["backends"], "formats": ["image/jpeg"]}


def _encode_png(w, h, rows):
    """Encode 8-bit RGBA scanlines (each `bytes` of length w*4) to PNG bytes.
    Pure zlib + struct, no PIL (§3e); also copied to the Windows GDI port."""
    def _chunk(tag, data):
        body = tag + data
        return (struct.pack(">I", len(data)) + body
                + struct.pack(">I", zlib.crc32(body) & 0xffffffff))
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)  # RGBA, no interlace
    raw = b"".join(b"\x00" + r for r in rows)  # per-scanline filter byte 0
    return (b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", ihdr)
            + _chunk(b"IDAT", zlib.compress(raw, 6)) + _chunk(b"IEND", b""))


_MOCK_SCREEN_N = 0


def mock_screen_frame():
    """--mock: a small stdlib PNG with a moving band, so the app's preview works
    on macOS without a compositor."""
    global _MOCK_SCREEN_N
    _MOCK_SCREEN_N += 1
    w, h = 320, 180
    band = (_MOCK_SCREEN_N * 12) % w
    rows = []
    for y in range(h):
        row = bytearray()
        for x in range(w):
            r = 220 if abs(x - band) <= 6 else 30
            row += bytes((r, (255 * y) // h, (255 * x) // w, 255))
        rows.append(bytes(row))
    return (_encode_png(w, h, rows), "image/png")


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
KEY_LEFTCTRL = 29  # for the Ctrl+V paste chord (non-ASCII text delivery)
KEY_A, KEY_S, KEY_D, KEY_F, KEY_G, KEY_H = 30, 31, 32, 33, 34, 35
KEY_J, KEY_K, KEY_L, KEY_SEMICOLON = 36, 37, 38, 39
KEY_APOSTROPHE, KEY_GRAVE, KEY_LEFTSHIFT, KEY_BACKSLASH = 40, 41, 42, 43
KEY_Z, KEY_X, KEY_C, KEY_V, KEY_B, KEY_N, KEY_M = 44, 45, 46, 47, 48, 49, 50
KEY_COMMA, KEY_DOT, KEY_SLASH = 51, 52, 53
KEY_LEFTALT = 56
KEY_SPACE = 57
KEY_HOME, KEY_UP = 102, 103
KEY_LEFT, KEY_RIGHT, KEY_END, KEY_DOWN = 105, 106, 107, 108
KEY_MUTE, KEY_VOLUMEDOWN, KEY_VOLUMEUP = 113, 114, 115
KEY_LEFTMETA = 125  # Super/Windows key — KDE opens the app launcher (Kickoff)

# Volume up/down go through the media keys so the OS shows its volume OSD. Mute
# is NOT here: gamescope does not bind KEY_MUTE, so real_soft toggles mute via
# wpctl on the default sink instead.
SOFT_MEDIA_KEYS = {
    "volume_up": KEY_VOLUMEUP,
    "volume_down": KEY_VOLUMEDOWN,
}

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

# named special key -> keycode (one press+release)
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
    # Desktop nav (KDE Plasma): a bare Meta tap opens the app launcher (Kickoff),
    # the SteamOS/Bazzite desktop "start menu".
    "meta": KEY_LEFTMETA,
}

# named chord -> ordered keycodes, pressed in order then released in reverse.
# Desktop (KDE Plasma) window/overview shortcut for the app's desktop cluster.
DESKTOP_CHORDS = {
    "overview": (KEY_LEFTMETA, KEY_W),  # KWin "Overview" effect (Plasma 6)
}

# All KEY_* codes the virtual keyboard may emit (declared at device create).
# KEY_LEFTCTRL is included for the Ctrl+V paste chord even though no char maps
# to it, else the uinput device won't declare the capability and emit fails.
KEYBOARD_CODES = sorted(
    {code for code, _shift in CHAR_KEYMAP.values()}
    | set(SPECIAL_KEYS.values())
    | {c for codes in DESKTOP_CHORDS.values() for c in codes}
    | {KEY_LEFTSHIFT, KEY_LEFTCTRL, KEY_LEFTALT}
)

# Names for mock logging of keyboard/mouse EV_KEY events.
_KEY_CODE_NAMES = {
    KEY_ESC: "KEY_ESC", KEY_BACKSPACE: "KEY_BACKSPACE", KEY_TAB: "KEY_TAB",
    KEY_ENTER: "KEY_ENTER", KEY_SPACE: "KEY_SPACE", KEY_LEFTSHIFT: "KEY_LEFTSHIFT",
    KEY_LEFTCTRL: "KEY_LEFTCTRL", KEY_LEFTALT: "KEY_LEFTALT",
    KEY_LEFTMETA: "KEY_LEFTMETA",
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


class UInputMediaKeys:
    """Virtual device that emits the volume media keys (mute / down / up). The OS
    handles them exactly like a hardware volume rocker: it changes the real
    volume and, in SteamOS Game Mode, shows the on-screen volume OSD. Kept
    separate from the WS keyboard (torn down each gamepad session) so /api/tv
    volume stands on its own."""

    name = "Couchside Media Keys"

    def __init__(self):
        if fcntl is None:
            raise RuntimeError("fcntl module unavailable on this platform")
        self.fd = None
        fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
        try:
            fcntl.ioctl(fd, UI_SET_EVBIT, EV_KEY)
            for code in (KEY_MUTE, KEY_VOLUMEDOWN, KEY_VOLUMEUP):
                fcntl.ioctl(fd, UI_SET_KEYBIT, code)
            setup = struct.pack(
                _UINPUT_USER_DEV,
                self.name.encode("utf-8"),
                0x03, 0x045E, 0x028B, 0x111,
                0,  # ff_effects_max
                *([0] * 64 + [0] * 64 + [0] * 64 + [0] * 64),
            )
            os.write(fd, setup)
            fcntl.ioctl(fd, UI_DEV_CREATE)
        except Exception:
            os.close(fd)
            raise
        self.fd = fd

    def tap(self, code):
        """Press then release one media key."""
        _emit_events(self.fd, [(EV_KEY, code, 1)])
        _emit_events(self.fd, [(EV_KEY, code, 0)])


# Pause after UI_DEV_CREATE before the first emit. The X server/compositor
# enumerates a new uinput device asynchronously; events sent before that lands
# are silently dropped. 0.5s is comfortably past the observed race on SteamOS
# (verified live: a Meta tap fired immediately after create never reached KWin;
# the same tap after a settle opened the launcher every time).
_UINPUT_SETTLE_S = 0.5


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
        # Settle before first emit — see UInputKeyboard (same enumeration race:
        # the first click/move of a fresh session would be dropped).
        time.sleep(_UINPUT_SETTLE_S)

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
        # Settle: the X server / compositor needs a beat to enumerate a fresh
        # uinput device before it delivers events from it. The keyboard is
        # created lazily on the FIRST key frame — without this, that first
        # press (a typed char, or the Start-menu Meta tap, verified live on
        # SteamOS) is silently dropped. One-time cost per session.
        time.sleep(_UINPUT_SETTLE_S)

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
        # Tolerant: unmappable chars are skipped, never raised. A single smart
        # quote / emoji used to raise here and kill the whole WS session.
        # Genuine non-ASCII is delivered via the paste path in
        # Handler._handle_kt, which intercepts 'kt' before this decoder; this
        # stays a safe fallback if 'kt' is ever routed straight through.
        return _type_events(text)
    if t == "k":
        key = msg.get("key")
        if key in SPECIAL_KEYS:
            code = SPECIAL_KEYS[key]
            return [(EV_KEY, code, 1), (EV_KEY, code, 0)]
        if key in DESKTOP_CHORDS:
            codes = DESKTOP_CHORDS[key]
            # Press in order, release in reverse (modifiers wrap the base key).
            return ([(EV_KEY, c, 1) for c in codes]
                    + [(EV_KEY, c, 0) for c in reversed(codes)])
        raise ValueError("unknown special key %r" % (key,))
    raise ValueError("unknown keyboard message type %r" % (t,))


def _type_events(text):
    """Uinput events to type `text`, skipping any char the ASCII keymap can't
    produce (tolerant — never raises). Non-typeable chars are handled elsewhere
    via paste; here they are simply omitted."""
    events = []
    for ch in text:
        entry = CHAR_KEYMAP.get(ch)
        if entry is None:
            continue
        code, shift = entry
        if shift:
            events.append((EV_KEY, KEY_LEFTSHIFT, 1))
        events.append((EV_KEY, code, 1))
        events.append((EV_KEY, code, 0))
        if shift:
            events.append((EV_KEY, KEY_LEFTSHIFT, 0))
    return events


def _split_typeable(text):
    """Split text into ordered ('type'|'paste', chunk) runs by whether each
    char is in CHAR_KEYMAP. Typeable runs go through uinput; paste runs go
    through the clipboard (unicode delivery)."""
    runs = []
    cur, buf = None, []
    for ch in text:
        kind = "type" if ch in CHAR_KEYMAP else "paste"
        if kind != cur:
            if buf:
                runs.append((cur, "".join(buf)))
            cur, buf = kind, [ch]
        else:
            buf.append(ch)
    if buf:
        runs.append((cur, "".join(buf)))
    return runs


# Bounds for one 'kt' frame, so a giant or pathologically-alternating string
# can't tie up the session's reader thread (each paste run costs ~2 subprocesses
# + a settle sleep). A real typed message is tiny; these are generous.
_KT_MAX_CHARS = 4096
_KT_MAX_PASTE_RUNS = 8

# Ctrl+V chord as uinput events (press ctrl, tap v, release ctrl).
_CTRL_V_EVENTS = [
    (EV_KEY, KEY_LEFTCTRL, 1),
    (EV_KEY, KEY_V, 1),
    (EV_KEY, KEY_V, 0),
    (EV_KEY, KEY_LEFTCTRL, 0),
]


def _wayland_display_sockets():
    """Names of wayland DISPLAY sockets in XDG_RUNTIME_DIR. Recognizes the
    standard wayland-<N> and gamescope's gamescope-<N> (Bazzite / Steam Deck
    Game Mode names its compositor socket gamescope-0, NOT wayland-0), while
    excluding lock files and gamescope's -ei / -stats side sockets. Never raises."""
    out = []
    try:
        for e in os.listdir(XDG_RUNTIME_DIR):
            if e.endswith(".lock"):
                continue
            if e.startswith("wayland-") and e[len("wayland-"):].isdigit():
                out.append(e)
            elif e.startswith("gamescope-") and e[len("gamescope-"):].isdigit():
                out.append(e)
    except OSError:
        pass
    return out


def _paste_env():
    """Session env for wl-copy/wl-paste, with WAYLAND_DISPLAY pinned to the one
    detected display socket (gamescope-0 in Game Mode); _session_env alone only
    finds wayland-<N>, which gamescope does not create."""
    env = _session_env()
    socks = _wayland_display_sockets()
    if len(socks) == 1:
        env["WAYLAND_DISPLAY"] = socks[0]
    return env


_PASTE_OK = None  # tri-state cache: None = unprobed, then True/False


def _paste_available():
    """True only when a clipboard paste actually WORKS: wl-copy + wl-paste exist,
    exactly one wayland display socket exists (single-socket safety gate against
    wrong-session pastes), AND a real wl-copy->wl-paste roundtrip succeeds.

    The roundtrip is essential, not paranoia: gamescope (Bazzite / Steam Deck
    Game Mode) exposes a wayland socket but does NOT implement
    wl_data_device_manager, so wl-copy silently fails there. Presence alone would
    wrongly advertise unicode; the roundtrip degrades Game Mode to ascii while
    keeping real Desktop-Mode wayland sessions on unicode. Probed once, cached,
    and clipboard-preserving (restores whatever was there)."""
    global _PASTE_OK
    if _PASTE_OK is not None:
        return _PASTE_OK
    _PASTE_OK = False
    if shutil.which("wl-copy") is None or shutil.which("wl-paste") is None:
        return False
    if len(_wayland_display_sockets()) != 1:
        return False
    env = _paste_env()
    sentinel = b"couchside-clip-probe"
    try:
        orig = subprocess.run(["wl-paste", "-n"], env=env, timeout=2,
                              stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        saved = orig.stdout if orig.returncode == 0 else None
        subprocess.run(["wl-copy"], input=sentinel, env=env, timeout=2,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(0.05)
        rb = subprocess.run(["wl-paste", "-n"], env=env, timeout=2,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        _PASTE_OK = rb.returncode == 0 and rb.stdout == sentinel
        if _PASTE_OK:  # restore the user's clipboard, don't leave the sentinel
            if saved:
                subprocess.run(["wl-copy"], input=saved, env=env, timeout=2,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            else:
                subprocess.run(["wl-copy", "--clear"], env=env, timeout=2,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        _PASTE_OK = False
    return _PASTE_OK


def _text_caps(mock):
    """Capability advertised in the hello frame: 'unicode' when we can deliver
    arbitrary text (via paste), else 'ascii' so the app strips non-typeable
    chars client-side. --mock always claims unicode."""
    return "unicode" if (mock or _paste_available()) else "ascii"


def _paste_log_once(entry, msg):
    """Log a paste diagnostic at most once per WS session."""
    if not entry.get("_paste_logged"):
        entry["_paste_logged"] = True
        print("[keyboard] %s" % msg, flush=True)


def _schedule_clipboard_clear(entry, env, delay=3.0):
    """Clear the wayland clipboard a few seconds after a paste, so pasted text
    (possibly sensitive) does not linger. Generation-guarded: a newer paste
    bumps the counter and cancels this clear (that paste owns the clipboard and
    schedules its own)."""
    gen = entry.get("_paste_gen", 0) + 1
    entry["_paste_gen"] = gen

    def _clear():
        if entry.get("_paste_gen") != gen:
            return
        try:
            subprocess.run(["wl-copy", "--clear"], env=env, timeout=2,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            pass

    threading.Timer(delay, _clear).start()


def clipboard_paste(text, kbd, mock, entry):
    """Deliver non-ASCII `text` by setting the wayland clipboard and sending
    Ctrl+V on the session keyboard device. Returns True on a delivered paste.

    Safety: wl-copy receives the text on STDIN (never argv — process cmdlines
    are world-readable and could leak a password). After copying we read the
    clipboard back with wl-paste; only if it matches do we press Ctrl+V, so a
    failed/again-wrong-socket copy can never paste a stale clipboard. On the
    first hard failure the paste path is marked dead for the session."""
    if mock:
        print("[mock] paste %d chars" % len(text), flush=True)
        return True
    if entry.get("_paste_dead"):
        return False
    env = _paste_env()
    try:
        subprocess.run(["wl-copy"], input=text.encode("utf-8"), env=env,
                       timeout=2, check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(0.05)  # let the compositor take ownership of the selection
        rb = subprocess.run(["wl-paste", "-n"], env=env, timeout=2,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    except Exception as e:
        entry["_paste_dead"] = True
        _paste_log_once(entry, "paste unavailable (%s); non-ASCII dropped" % e)
        return False
    if rb.returncode != 0 or rb.stdout.decode("utf-8", "replace") != text:
        # The compositor did not accept our clipboard on this socket: do NOT
        # Ctrl+V (would paste whatever was there before). Drop this chunk.
        _paste_log_once(entry, "clipboard read-back mismatch; non-ASCII dropped")
        return False
    try:
        kbd.emit(_CTRL_V_EVENTS)
    except Exception as e:
        _paste_log_once(entry, "Ctrl+V emit failed: %s" % e)
        return False
    _schedule_clipboard_clear(entry, env)
    return True


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


# Controller sessions. Multiple phones may be CONNECTED at once, but only one
# HOLDS the virtual input devices at a time. A joining phone either grabs
# control (handoff=takeover, the default and the pre-2.9.2 behavior) or asks
# the current holder to pass it (handoff=ask): the holder is prompted and taps
# Pass/Keep, and a demoted phone can Request control back. If the holder never
# answers, the waiter can Force after a client-side timeout. All state changes
# happen under GAMEPAD_LOCK; each entry carries its own SEND lock ("slock")
# because control frames (granted/released/…) are sent to a socket from a
# DIFFERENT thread than the one running that session's recv loop, and two
# threads writing one socket unsynchronised would interleave WS frames.
GAMEPAD_LOCK = threading.Lock()
GAMEPAD_HOLDER = None      # the entry that currently owns input devices, or None
GAMEPAD_SESSIONS = []      # every live entry (holder + waiters)


def _wsend_json(entry, obj):
    """Send one JSON text frame to a session, serialised per-socket. Never raises."""
    with entry["slock"]:
        try:
            ws_send_json(entry["conn"], obj)
        except OSError:
            pass


def _wsend_op(entry, opcode, payload=b""):
    """Send one raw WS frame to a session, serialised per-socket. Never raises."""
    with entry["slock"]:
        try:
            ws_send(entry["conn"], opcode, payload)
        except OSError:
            pass


def _release_devices(entry):
    """Destroy a session's virtual input devices (idempotent) but LEAVE its
    socket open — used when demoting a holder that stays connected as a waiter."""
    for slot in ("device", "mouse", "keyboard"):
        dev = entry.get(slot)
        if dev is not None:
            try:
                dev.destroy()
            except Exception:
                pass
            entry[slot] = None


def _make_holder(entry, mock):
    """Give `entry` the gamepad device and mark it holder, then send hello.
    A session only ever receives hello on becoming the holder (waiters get
    'waiting' instead), so hello IS the "you have control now" signal. Returns
    False (and closes the session) if uinput fails. Mouse/keyboard stay lazy —
    created on first use by this now-held session."""
    try:
        entry["device"] = MockGamepad() if mock else UInputGamepad()
    except Exception as e:
        print("[gamepad] device create failed: %s" % e, flush=True)
        _wsend_json(entry, {"t": "err", "msg": "uinput unavailable: %s" % e})
        _wsend_op(entry, WS_OP_CLOSE)
        return False
    entry["held"] = True
    entry["requested"] = False
    _wsend_json(entry, {"t": "hello", "dev": entry["device"].name,
                        "text": _text_caps(mock)})
    print("[gamepad] control -> %s" % entry["name"], flush=True)
    return True


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
        "<div class=\"sub\">Point your phone&rsquo;s <b>camera</b> at this code "
        "&mdash; it opens the Couchside app and pairs your box automatically. "
        "The app itself has no scanner; use the camera.</div>"
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

    # Per-connection socket read timeout. socketserver's setup() applies this
    # via connection.settimeout(), so a stalled or idle keep-alive client can't
    # pin a worker thread forever (a timed-out read raises and the thread ends).
    timeout = 30

    # Hard cap on a request body we will read into memory. Enforced BEFORE any
    # body read (see _read_body) so an unauthenticated LAN client can't force a
    # huge allocation via a large Content-Length. 8 MiB comfortably covers the
    # only bodies this agent accepts (tiny launcher/volume/power JSON).
    MAX_BODY_BYTES = 8 * 1024 * 1024

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

    # Chatty routes whose success (2xx) is sampled so a ~1-2 fps poll can't
    # scroll real diagnostics out of the journal's window (§3f). Errors and the
    # first hit of a burst still log.
    _SAMPLED_PATHS = ("/api/screen/frame",)
    _sample_last = {}  # path -> monotonic time of last logged success
    _SAMPLE_EVERY_S = 15

    def _log(self, code, started):
        dur_ms = int((time.monotonic() - started) * 1000)
        # Never log query strings: /ws/gamepad carries ?token=<secret>, and
        # this stdout lands in journald (which /api/journal serves back out).
        path = self.path.split("?", 1)[0]
        if path in self._SAMPLED_PATHS and code < 400:
            now = time.monotonic()
            if now - Handler._sample_last.get(path, 0) < self._SAMPLE_EVERY_S:
                return  # suppress this frame; a recent one already logged
            Handler._sample_last[path] = now
        if "?" in self.path:
            path += "?<redacted>"
        print("%s %s %s %d %dms" % (
            self.client_address[0], self.command, path, code, dur_ms),
            flush=True)

    def _send(self, code, payload, started, extra_headers=None):
        body = b"" if payload is None else json.dumps(payload).encode("utf-8")
        self.send_response(code)
        # No CORS: this is a LAN service for the native app + WS, neither of
        # which need it; sending ACAO:* let a malicious browser tab read
        # responses cross-origin.
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

    def _send_bytes(self, code, data, content_type, started,
                    cache_control=None, extra_headers=None):
        """Write a raw binary body (image bytes: Steam covers, album art, later
        screen frames) with an EXACT Content-Length (keep-alive safety under
        protocol_version HTTP/1.1)."""
        self.send_response(code)
        # No CORS: this is a LAN service for the native app + WS, neither of
        # which need it; sending ACAO:* let a malicious browser tab read
        # responses cross-origin.
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        if cache_control:
            self.send_header("Cache-Control", cache_control)
        if extra_headers:
            for k, v in extra_headers.items():
                self.send_header(k, v)
        self.end_headers()
        if data:
            self.wfile.write(data)
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
            elif path == "/api/downloads":
                # Always 200 (list may be empty). Old agents lack this route and
                # 404 -> the app hides the section (probe-and-appear via 404->null).
                downloads = mock_downloads() if self.mock else steam_downloads()
                self._send(200, {"downloads": downloads}, started)
            elif path.startswith("/api/steam/") and path.endswith("/cover"):
                appid = path[len("/api/steam/"):-len("/cover")]
                self._handle_steam_cover(appid, started)
            elif path == "/api/tv":
                # Probe-and-appear: 404 when no TV backend so the app shows no
                # TV strip; a body only when a backend is live.
                info = tv_info()
                if info is None:
                    self._send(404, {"error": "not found"}, started)
                else:
                    self._send(200, info, started)
            elif path == "/api/displays":
                # Probe-and-appear: 404 unless this box can do the desktop->TV
                # Game Mode handoff (SteamOS/Bazzite, 2+ outputs), so the app
                # shows no Couch Mode control otherwise.
                info = ({"available": True,
                         "outputs": [{"name": "DP-1", "internal": False},
                                     {"name": "eDP-1", "internal": True}],
                         "game_outputs": ["DP-1"],
                         "session": "desktop",
                         "output_forcing": True} if self.mock
                        else couchmode_info())
                if info is None:
                    self._send(404, {"error": "not found"}, started)
                else:
                    self._send(200, info, started)
            elif path == "/api/media":
                # Probe-and-appear: 404 when no session bus / busctl so the app
                # hides the Now Playing card; 200 with an empty list when idle.
                info = mock_mpris_info() if self.mock else mpris_info()
                if info is None:
                    self._send(404, {"error": "not found"}, started)
                else:
                    self._send(200, info, started)
            elif path == "/api/media/art":
                # Album art bytes for a player's CURRENT track. The client passes
                # only player id + art_key (a cache-buster) — never a path.
                q = parse_qs(parsed.query)
                player = (q.get("player") or [""])[0]
                key = (q.get("k") or [""])[0]
                art = None
                if player:
                    art = (mock_mpris_art(player, key) if self.mock
                           else (mpris_art(player, key) if BUSCTL else None))
                if art is None:
                    self._send(404, {"error": "not found"}, started)
                else:
                    data, mime = art
                    self._send_bytes(200, data, mime, started,
                                     cache_control="private, max-age=3600")
            elif path == "/api/screen":
                # Probe-and-appear: 404 when no capture path so the app hides the
                # preview card; a body describes the session + backends.
                info = {"available": True, "session": "mock",
                        "backends": ["mock"], "formats": ["image/png"]} \
                    if self.mock else screen_info()
                if info is None:
                    self._send(404, {"error": "not found"}, started)
                else:
                    self._send(200, info, started)
            elif path == "/api/screen/frame":
                # One fresh frame. Single-flight + 500ms cache cap captures at
                # ~2/s server-side; no-store so frames (may show passwords) are
                # never cached. High-frequency, so _log samples it.
                frame = mock_screen_frame() if self.mock else real_screen_frame()
                if frame is None:
                    self._send(503, {"error": "capture failed"}, started)
                else:
                    data, mime = frame
                    self._send_bytes(200, data, mime, started,
                                     cache_control="no-store")
            elif path == "/api/power/schedule":
                # Always 200: reports the (volatile) sleep timer + the RTC wake
                # alarm read from hardware. Old agents 404 -> app hides the rows.
                self._send(200, power_schedule_info(), started)
            elif path == "/api/screensaver":
                # Probe-and-appear like /api/tv: 404 when the script/toolchain
                # is absent so the app hides the feature (and old apps that
                # never ask are unaffected).
                info = screensaver_info()
                if info["available"]:
                    self._send(200, info, started)
                else:
                    self._send(404, {"error": "screensaver not installed"}, started)
            else:
                self._send(404, {"error": "not found"}, started)
        except BrokenPipeError:
            pass
        except Exception as e:
            try:
                self._send(500, {"error": e.__class__.__name__}, started)
            except Exception:
                pass

    def _handle_steam_cover(self, appid, started):
        """Serve a Steam game's 600x900 cover art from the box's LOCAL Steam
        cache. No CDN / third-party fetch: the phone talks only to this agent,
        so the app stays LAN-only. 404 when the appid is malformed, the game
        isn't installed, or Steam hasn't cached its portrait art yet (the app
        then shows its text-card fallback)."""
        cover = _steam_cover_path(appid)
        if cover is None:
            self._send(404, {"error": "no cover"}, started)
            return
        try:
            with open(cover, "rb") as f:
                body = f.read()
        except OSError:
            self._send(404, {"error": "no cover"}, started)
            return
        # Art is keyed by appid and effectively immutable; let the phone cache it.
        self._send_bytes(200, body, "image/jpeg", started,
                         extra_headers={"Cache-Control": "public, max-age=604800"})

    def _body_too_large(self):
        """True iff the declared Content-Length exceeds MAX_BODY_BYTES.

        Checked from the header alone, BEFORE any read, so a huge declared body
        is rejected without allocating for it. Callers that hit this must reply
        413 and close the connection (the body is never drained)."""
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return False
        return n > self.MAX_BODY_BYTES

    def _read_body(self):
        """Read and return the request body bytes (always drains it).

        Draining is mandatory: on an HTTP/1.1 keep-alive connection any leftover
        body bytes would be parsed as the next request line and desync it. The
        size is capped at MAX_BODY_BYTES; callers must gate on _body_too_large()
        first so an oversize body is rejected before we ever read it. A
        Content-Length above the cap that slips through here is clamped and the
        connection marked for close, so we still never allocate unbounded.
        """
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n <= 0:
            return b""
        if n > self.MAX_BODY_BYTES:
            # Defensive: normal paths gate on _body_too_large() before reading.
            self.close_connection = True
            n = self.MAX_BODY_BYTES
        return self.rfile.read(n)

    def do_POST(self):
        started = time.monotonic()
        try:
            parsed = urlparse(self.path)
            path = parsed.path.rstrip("/")

            if not path.startswith("/api/"):
                # Unknown route: authorize-agnostic 404, but drain the body so a
                # keep-alive connection doesn't desync (unless it's oversize).
                if self._body_too_large():
                    self.close_connection = True
                    self._send(413, {"error": "request body too large"}, started)
                    return
                self._read_body()
                self._send(404, {"error": "not found"}, started)
                return

            # Authorize BEFORE reading the body: an unauthenticated client must
            # not be able to make us allocate for its body. Reject + close so the
            # undrained body can't desync a keep-alive connection.
            if not self._authorized():
                self.close_connection = True
                self._send(401, {"error": "unauthorized"}, started)
                return

            # Authorized: now enforce the size cap, then read the body.
            if self._body_too_large():
                self.close_connection = True
                self._send(413, {"error": "request body too large"}, started)
                return
            body = self._read_body()

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

            # POST /api/tv/volume: absolute volume {"level": 0-100, "target":
            # "box"|"tv"}. Box converges via media-key steps (Game Mode OSD),
            # TV via the RS-232 closed loop. Checked before /api/tv/<op>.
            if path == "/api/tv/volume":
                try:
                    req = json.loads(body.decode("utf-8")) if body else {}
                    if not isinstance(req, dict):
                        raise ValueError("body must be a JSON object")
                    lvl = int(req.get("level"))
                except (ValueError, TypeError, UnicodeDecodeError):
                    self._send(400, {"error": "level must be an integer"},
                               started)
                    return
                if not 0 <= lvl <= 100:
                    self._send(400, {"error": "level must be 0-100"}, started)
                    return
                tgt = req.get("target") or "box"
                if tgt == "tv":
                    if not panel_available():
                        self._send(404, {"error": "no tv volume backend"},
                                   started)
                        return
                    result = ({"ok": True, "exit_code": 0, "level": lvl,
                               "stdout": "[mock] tv volume %d" % lvl,
                               "stderr": "", "duration_ms": 100}
                              if self.mock else panel_set_volume(lvl))
                else:
                    if not soft_available():
                        self._send(404, {"error": "no box volume backend"},
                                   started)
                        return
                    result = ({"ok": True, "exit_code": 0, "level": lvl,
                               "stdout": "[mock] box volume %d" % lvl,
                               "stderr": "", "duration_ms": 100}
                              if self.mock else soft_set_volume(lvl))
                self._send(200, result, started)
                return

            # POST /api/tv/key/<k>: factory-remote key (panel only).
            keyprefix = "/api/tv/key/"
            if path.startswith(keyprefix):
                k = unquote(path[len(keyprefix):])
                if not panel_available() or k not in PANEL_KEYS:
                    self._send(404, {"error": "unknown key"}, started)
                    return
                if self.mock:
                    result = {"ok": True, "exit_code": 0,
                              "stdout": "[mock panel] key %s" % k,
                              "stderr": "", "duration_ms": 100}
                else:
                    result = real_panel_key(k)
                self._send(200, result, started)
                return

            # POST /api/tv/source/<id>: switch the display input (panel only).
            # Checked before the generic /api/tv/ route since it is more specific.
            srcprefix = "/api/tv/source/"
            if path.startswith(srcprefix):
                sid = unquote(path[len(srcprefix):])
                if not panel_available() or sid not in PANEL_SOURCE_CODES:
                    self._send(404, {"error": "unknown source"}, started)
                    return
                if self.mock:
                    result = {"ok": True, "exit_code": 0,
                              "stdout": "[mock panel] source %s" % sid,
                              "stderr": "", "duration_ms": 100}
                else:
                    result = real_panel_source(sid)
                self._send(200, result, started)
                return

            # POST /api/media/<player>/<op>: MPRIS transport. <op> is a fixed
            # word; the seek op carries {"position_ms":int}. Unknown op / dead
            # player -> 404. Placed before the generic /api/tv/ route.
            mprefix = "/api/media/"
            if path.startswith(mprefix):
                rest = path[len(mprefix):]
                parts = rest.rsplit("/", 1)
                if len(parts) != 2 or not parts[0] or not parts[1]:
                    self._send(404, {"error": "not found"}, started)
                    return
                player, op = unquote(parts[0]), parts[1]
                if op not in MPRIS_OPS:
                    self._send(404, {"error": "unknown media op"}, started)
                    return
                position_ms = None
                if op == "seek":
                    try:
                        req = json.loads(body.decode("utf-8")) if body else {}
                        if not isinstance(req, dict):
                            raise ValueError("body must be a JSON object")
                        position_ms = int(req.get("position_ms"))
                    except (ValueError, TypeError, UnicodeDecodeError):
                        self._send(400, {"error": "position_ms must be an integer"},
                                   started)
                        return
                result = (mock_mpris_op(player, op, position_ms) if self.mock
                          else real_mpris_op(player, op, position_ms))
                if result is None:
                    self._send(404, {"error": "unknown player"}, started)
                    return
                self._send(200, result, started)
                return

            # POST /api/screensaver: {"op":"start","theme"?,"tier"?} | {"op":"stop"}
            if path == "/api/screensaver":
                if not (SS_MOCK or screensaver_available()):
                    self._send(404, {"error": "screensaver not installed"}, started)
                    return
                try:
                    req = json.loads(body.decode("utf-8")) if body else {}
                    if not isinstance(req, dict):
                        raise ValueError
                    op = req.get("op")
                except (ValueError, UnicodeDecodeError):
                    self._send(400, {"error": "json body with op required"}, started)
                    return
                cur_theme, cur_tier = _ss_conf_read()
                if op == "start":
                    try:
                        r = screensaver_start(req.get("theme", cur_theme),
                                              req.get("tier", cur_tier))
                    except ValueError as e:
                        self._send(400, {"error": str(e)}, started)
                        return
                    except RuntimeError as e:
                        self._send(409, {"error": str(e)}, started)
                        return
                    self._send(200, r, started)
                elif op == "stop":
                    self._send(200, screensaver_stop(), started)
                else:
                    self._send(400, {"error": "op must be start|stop"}, started)
                return

            # POST /api/couch-mode: {"output":"DP-2","hdr":false} — fling the box
            # into Game Mode on the TV. 404 unless the box can do the handoff.
            if path == "/api/couch-mode":
                if not (self.mock or couchmode_available()):
                    self._send(404, {"error": "couch mode unavailable"}, started)
                    return
                try:
                    req = json.loads(body.decode("utf-8")) if body else {}
                    if not isinstance(req, dict):
                        raise ValueError
                except (ValueError, UnicodeDecodeError):
                    self._send(400, {"error": "json body required"}, started)
                    return
                output = req.get("output") or ""
                hdr = bool(req.get("hdr", False))
                if self.mock:
                    self._send(200, {"ok": True, "output": output, "hdr": hdr,
                                     "session": "gamescope",
                                     "steps": {"session": {"ok": True}}}, started)
                    return
                self._send(200, couchmode_start(output, hdr), started)
                return

            # POST /api/desktop-mode: leave Game Mode back to the Plasma desktop.
            if path == "/api/desktop-mode":
                if not (self.mock or couchmode_available()):
                    self._send(404, {"error": "couch mode unavailable"}, started)
                    return
                if self.mock:
                    self._send(200, {"ok": True, "session": "desktop",
                                     "steps": {"session": {"ok": True}}}, started)
                    return
                self._send(200, desktop_mode(), started)
                return

            # POST /api/power/sleep: arm a delayed suspend/poweroff.
            if path == "/api/power/sleep":
                try:
                    req = json.loads(body.decode("utf-8")) if body else {}
                    if not isinstance(req, dict):
                        raise ValueError
                    delay_s = int(req.get("delay_s"))
                    action = req.get("action")
                except (ValueError, TypeError, UnicodeDecodeError):
                    self._send(400, {"error": "delay_s (int) and action required"}, started)
                    return
                if not SLEEP_MIN_S <= delay_s <= SLEEP_MAX_S:
                    self._send(400, {"error": "delay_s out of range"}, started)
                    return
                ok, err = sleep_can_arm(action)
                if not ok:
                    self._send(400, {"error": err}, started)
                    return
                self._send(200, {"sleep": sleep_arm(delay_s, action)}, started)
                return

            # POST /api/power/wake: set the RTC wake alarm to an absolute time.
            if path == "/api/power/wake":
                if not rtc_available():
                    self._send(409, {"error": "no writable /dev/rtc0"}, started)
                    return
                try:
                    req = json.loads(body.decode("utf-8")) if body else {}
                    at = int(req.get("at"))
                except (ValueError, TypeError, UnicodeDecodeError):
                    self._send(400, {"error": "at (epoch seconds) required"}, started)
                    return
                now = time.time()
                if not now + WAKE_MIN_S <= at <= now + WAKE_MAX_S:
                    self._send(400, {"error": "at must be %d-%ds out"
                                     % (WAKE_MIN_S, WAKE_MAX_S)}, started)
                    return
                if not rtc_set_wake(at):
                    self._send(500, {"error": "rtc set failed"}, started)
                    return
                self._send(200, {"wake": rtc_wake_info()}, started)
                return

            # POST /api/tv/<op>: TV power / volume. Volume defaults to the box's
            # own OS volume; ?target=tv routes it to the panel/CEC backend.
            tprefix = "/api/tv/"
            if path.startswith(tprefix):
                op = path[len(tprefix):]
                # source_box/screen_toggle ride the same route but are not
                # volume/power ops, so they are not in TV_OPS; allow explicitly.
                if op not in TV_OPS and op not in _PANEL_ONLY_OPS:
                    self._send(404, {"error": "unknown tv op"}, started)
                    return
                target = parse_qs(parsed.query).get("target", [None])[0]
                result = tv_send(op, self.mock, target)
                if result is None:  # nothing can handle this op
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
        try:
            parsed = urlparse(self.path)
            path = parsed.path.rstrip("/")

            if not path.startswith("/api/"):
                if self._body_too_large():
                    self.close_connection = True
                    self._send(413, {"error": "request body too large"}, started)
                    return
                self._read_body()  # drain for keep-alive safety
                self._send(404, {"error": "not found"}, started)
                return

            # Authorize BEFORE reading the body (see do_POST).
            if not self._authorized():
                self.close_connection = True
                self._send(401, {"error": "unauthorized"}, started)
                return

            # DELETE bodies are unusual but a client may send one; cap + drain it
            # for keep-alive safety now that we've authorized.
            if self._body_too_large():
                self.close_connection = True
                self._send(413, {"error": "request body too large"}, started)
                return
            self._read_body()

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

            # DELETE /api/power/sleep: cancel the armed sleep timer (idempotent).
            if path == "/api/power/sleep":
                sleep_cancel()
                self._send(200, {"sleep": None}, started)
                return
            # DELETE /api/power/wake: clear the RTC wake alarm (idempotent).
            if path == "/api/power/wake":
                rtc_clear_wake()
                self._send(200, {"wake": None}, started)
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
        global GAMEPAD_HOLDER
        conn = self.connection
        q = parse_qs(urlparse(self.path).query)
        name = (q.get("name", [""])[0] or "A device")[:40]
        # 'ask' = request control from the holder; anything else (incl. old
        # clients that send no param) = grab it, the pre-2.9.2 behavior.
        ask = q.get("handoff", ["takeover"])[0] == "ask"
        entry = {"conn": conn, "device": None, "mouse": None, "keyboard": None,
                 "name": name, "held": False, "requested": False,
                 "slock": threading.Lock()}

        # ---- decide this session's initial role -------------------------------
        demoted = None      # a holder we bumped (takeover): notify after unlock
        with GAMEPAD_LOCK:
            GAMEPAD_SESSIONS.append(entry)
            holder = GAMEPAD_HOLDER
            if holder is None:
                GAMEPAD_HOLDER = entry
                entry["held"] = True
                role = "hold"
            elif ask:
                entry["requested"] = True
                role = "wait"
            else:  # takeover
                holder["held"] = False
                demoted = holder
                GAMEPAD_HOLDER = entry
                entry["held"] = True
                role = "hold"

        if demoted is not None:
            _release_devices(demoted)
            _wsend_json(demoted, {"t": "released", "by": name})
        if role == "hold":
            if not _make_holder(entry, self.mock):
                # uinput failed; drop this session, promote a waiter if any.
                self._gamepad_cleanup(entry)
                return
        else:  # waiting: tell me, and prompt the holder
            _wsend_json(entry, {"t": "waiting", "holder": holder.get("name")})
            _wsend_json(holder, {"t": "control_request", "name": name})
            print("[gamepad] %s waiting (holder %s)"
                  % (name, holder.get("name")), flush=True)

        # ---- recv loop --------------------------------------------------------
        try:
            conn.settimeout(60.0)
            buf = bytearray()
            while True:
                try:
                    frame = ws_recv_frame(conn, buf)
                except ValueError as e:
                    print("[gamepad] protocol violation: %s" % e, flush=True)
                    _wsend_op(entry, WS_OP_CLOSE)
                    return
                if frame is None:  # EOF / timeout / socket error -> dead
                    return
                opcode, payload = frame
                try:
                    if opcode == WS_OP_CLOSE:
                        _wsend_op(entry, WS_OP_CLOSE, payload[:2])
                        return
                    if opcode == WS_OP_PING:
                        _wsend_op(entry, WS_OP_PONG, payload)
                        continue
                    if opcode != WS_OP_TEXT:
                        continue  # ignore binary / stray pong
                    if not self._gamepad_message(conn, entry, payload):
                        return
                except OSError:
                    return
        finally:
            self._gamepad_cleanup(entry)

    def _gamepad_cleanup(self, entry):
        """Remove a dead session; if it held control, promote a waiter (prefer
        one that requested). Runs from the session's own thread on exit."""
        global GAMEPAD_HOLDER
        promote = None
        with GAMEPAD_LOCK:
            was_holder = GAMEPAD_HOLDER is entry
            if entry in GAMEPAD_SESSIONS:
                GAMEPAD_SESSIONS.remove(entry)
            if was_holder:
                GAMEPAD_HOLDER = None
                waiters = [s for s in GAMEPAD_SESSIONS]
                promote = next((s for s in waiters if s.get("requested")), None) \
                    or (waiters[0] if waiters else None)
                if promote is not None:
                    GAMEPAD_HOLDER = promote
            # Destroy OUR devices under nothing (destroy is idempotent); grab
            # refs while we hold the lock so a concurrent promote can't race.
            devices = [entry.get("device"), entry.get("mouse"),
                       entry.get("keyboard")]
        for dev in devices:
            if dev is not None:
                try:
                    dev.destroy()
                except Exception:
                    pass
        if promote is not None and not _make_holder(promote, self.mock):
            # promotion failed (uinput gone): leave no holder.
            with GAMEPAD_LOCK:
                if GAMEPAD_HOLDER is promote:
                    GAMEPAD_HOLDER = None
        if was_holder:
            print("[gamepad] holder %s disconnected" % entry.get("name"),
                  flush=True)

    # Message-type prefixes routed to the mouse / keyboard virtual devices.
    _MOUSE_TYPES = frozenset(("m", "mb", "mw"))
    _KEYBOARD_TYPES = frozenset(("kt", "k"))

    def _handle_kt(self, conn, entry, msg):
        """Type text tolerantly and keep the session alive no matter what.

        Typeable chars go through the uinput keyboard; genuine non-ASCII goes
        through the clipboard-paste path. A missing keyboard device or an
        unavailable paste path just drops the affected chars (logged once) — no
        err frame, no close. Only a malformed message (non-string text) still
        err+closes, preserving the protocol contract.
        """
        text = msg.get("text")
        if not isinstance(text, str):
            _wsend_json(entry, {"t": "err", "msg": "kt text must be a string"})
            _wsend_op(entry, WS_OP_CLOSE)
            return False
        if not text:
            return True
        if len(text) > _KT_MAX_CHARS:
            _paste_log_once(entry, "kt text too long (%d chars); truncated" % len(text))
            text = text[:_KT_MAX_CHARS]
        kbd = entry.get("keyboard")
        if kbd is None:
            try:
                kbd = MockKeyboard() if self.mock else UInputKeyboard()
            except Exception as e:
                _paste_log_once(entry, "keyboard unavailable (%s); text dropped" % e)
                return True
            entry["keyboard"] = kbd
            print("[gamepad] keyboard device created (%s)" % kbd.name, flush=True)
        paste_runs = 0
        for kind, chunk in _split_typeable(text):
            if kind == "type":
                events = _type_events(chunk)
                if events:
                    try:
                        kbd.emit(events)
                    except Exception as e:
                        _paste_log_once(entry, "type emit failed: %s" % e)
            else:
                paste_runs += 1
                if paste_runs > _KT_MAX_PASTE_RUNS:
                    _paste_log_once(entry, "too many paste runs; remaining non-ASCII dropped")
                    continue
                clipboard_paste(chunk, kbd, self.mock, entry)
        return True

    # Control frames (holder handoff) — handled regardless of hold state.
    _CONTROL_TYPES = frozenset(("grant", "deny", "request", "force"))

    def _handle_control(self, entry, t):
        """Holder-handoff control frame. grant/deny come from the HOLDER;
        request/force come from a WAITER. Returns True (session continues)."""
        global GAMEPAD_HOLDER
        demoted = None
        promote = None
        notify_holder = None
        deny = None
        with GAMEPAD_LOCK:
            holder = GAMEPAD_HOLDER
            if t in ("grant", "deny") and entry is not holder:
                return True  # only the holder may grant/deny
            if t == "grant":
                target = next((s for s in GAMEPAD_SESSIONS
                               if s.get("requested") and s is not entry), None)
                if target is not None:
                    entry["held"] = False
                    demoted = entry
                    target["held"] = True  # provisional; device made below
                    GAMEPAD_HOLDER = target
                    promote = target
            elif t == "deny":
                deny = next((s for s in GAMEPAD_SESSIONS
                             if s.get("requested") and s is not entry), None)
                if deny is not None:
                    deny["requested"] = False
            elif t == "request":
                if holder is not None and entry is not holder:
                    entry["requested"] = True
                    notify_holder = holder
            elif t == "force":
                if holder is not None and entry is not holder:
                    holder["held"] = False
                    demoted = holder
                    entry["held"] = True
                    GAMEPAD_HOLDER = entry
                    promote = entry
        if demoted is not None:
            _release_devices(demoted)
            _wsend_json(demoted, {"t": "released",
                                  "by": (promote or {}).get("name")})
        if promote is not None:
            _make_holder(promote, self.mock)
        if notify_holder is not None:
            _wsend_json(notify_holder, {"t": "control_request",
                                        "name": entry.get("name")})
        if deny is not None:
            _wsend_json(deny, {"t": "denied"})
        return True

    def _gamepad_message(self, conn, entry, payload):
        """Handle one text frame. Returns False when the session must end.

        Control frames run regardless of hold state; INPUT frames (pad/mouse/
        keyboard) are dropped unless this session currently holds control, so a
        connected-but-waiting phone can never move the pointer.
        """
        try:
            msg = json.loads(payload.decode("utf-8"))
            if not isinstance(msg, dict):
                raise ValueError("message must be a JSON object")
        except (ValueError, UnicodeDecodeError):
            _wsend_json(entry, {"t": "err", "msg": "invalid JSON message"})
            _wsend_op(entry, WS_OP_CLOSE)
            return False
        t = msg.get("t")
        if t == "ping":
            _wsend_json(entry, {"t": "pong"})
            return True
        if t in self._CONTROL_TYPES:
            return self._handle_control(entry, t)
        # Input frames only from the holder; a waiter's input is ignored.
        if not entry.get("held"):
            return True
        if t == "kt":
            # Text passthrough is handled here, BEFORE the decode table, so it
            # can never close the session: unmappable chars are dropped and
            # genuine non-ASCII is pasted, all tolerantly.
            return self._handle_kt(conn, entry, msg)

        # Select decoder, target device slot, and lazy device factory.
        if t in self._MOUSE_TYPES:
            decode, slot = mouse_events, "mouse"
            factory = MockMouse if self.mock else UInputMouse
        elif t in self._KEYBOARD_TYPES:
            decode, slot = keyboard_events, "keyboard"
            factory = MockKeyboard if self.mock else UInputKeyboard
        else:
            decode, slot, factory = gamepad_events, "device", None

        try:
            events = decode(msg)
        except ValueError as e:
            _wsend_json(entry, {"t": "err", "msg": str(e)})
            _wsend_op(entry, WS_OP_CLOSE)
            return False

        target = entry.get(slot)
        if target is None:
            if factory is None:
                return True  # gamepad device gone (mid-teardown): drop frame
            try:
                target = factory()
            except Exception as e:
                print("[gamepad] %s device create failed: %s"
                      % (slot, e), flush=True)
                _wsend_json(entry, {"t": "err",
                                    "msg": "%s unavailable: %s" % (slot, e)})
                _wsend_op(entry, WS_OP_CLOSE)
                return False
            entry[slot] = target
            print("[gamepad] %s device created (%s)"
                  % (slot, target.name), flush=True)

        try:
            target.emit(events)
        except OSError as e:
            _wsend_json(entry, {"t": "err", "msg": "uinput write failed: %s" % e})
            _wsend_op(entry, WS_OP_CLOSE)
            return False
        return True


class BoundedThreadingHTTPServer(ThreadingHTTPServer):
    """ThreadingHTTPServer with a hard cap on concurrent connections so a
    connection flood cannot exhaust threads/FDs. A non-blocking semaphore is
    acquired before the worker thread is spawned; over the cap the socket is
    closed and the connection rejected. Released when the request finishes.

    Note: the long-lived /ws/gamepad connection holds a slot for the entire
    Pad session, so the cap must comfortably exceed a household's phones.
    """
    _MAX_CONNECTIONS = 128

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._conn_sem = threading.BoundedSemaphore(self._MAX_CONNECTIONS)

    def process_request(self, request, client_address):
        if not self._conn_sem.acquire(blocking=False):
            # Over the concurrency cap: reject rather than pile up threads.
            try:
                self.shutdown_request(request)
            except Exception:
                pass
            return
        super().process_request(request, client_address)

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            try:
                self._conn_sem.release()
            except ValueError:
                pass


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
    set_mpris(args.mock)
    set_screen(args.mock)
    set_power_schedule(args.mock)
    set_screensaver(args.mock)
    set_caps(args.mock)  # after the detectors above; snapshots CAPS
    port = args.port if args.port is not None else (CONFIG_PORT or DEFAULT_PORT)

    Handler.token = load_token(args)
    # Remembered so GET /pair can re-read the current token (unless a literal
    # --token was supplied, in which case there is no file to re-read).
    Handler.token_file = None if args.token else args.token_file
    Handler.port = port
    Handler.mock = args.mock

    server = BoundedThreadingHTTPServer((args.host, port), Handler)
    server.daemon_threads = True
    mode = "mock" if args.mock else "real"
    print("%s %s listening on %s:%d (%s mode)" % (
        APP_NAME, VERSION, args.host, port, mode), flush=True)
    info = tv_info()
    print("tv: %s" % ("%s (%s)" % (info["backend"], info["adapter"])
                      if info else "unavailable"), flush=True)
    print("mpris: %s" % ("available" if BUSCTL else "unavailable"), flush=True)
    print("screen: %s" % (("%s (%s)" % (_SCREEN["session"], ",".join(_SCREEN["backends"])))
                          if _SCREEN else "unavailable"), flush=True)
    print("caps: %s" % (",".join(sorted(k for k, v in CAPS.items() if v)) or "none"),
          flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
