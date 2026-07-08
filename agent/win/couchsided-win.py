#!/usr/bin/env python3
"""couchsided-win.py: Windows box-side agent for Couchside.

Pure python3 stdlib (ctypes for Win32). Serves the same Couchside agent API
contract v1 as the Linux agent (agent/couchsided.py) on port 8787, so the
phone app pairs and talks to a Windows HTPC exactly like a SteamOS/Bazzite
box. Also runs on macOS/Linux in --mock mode for phone-app development.

Windows equivalents of the Linux primitives:
  status    GetTickCount64 / GlobalMemoryStatusEx / GetSystemTimes /
            GetDriveTypeW + shutil.disk_usage / GetAdaptersInfo
  units     Windows services via `sc query` / `sc qdescription`
  journal   Windows Event Log via `wevtutil qe` (provider = unit name)
  actions   shutdown.exe / rundll32 (an interactive user can shut down,
            reboot, suspend, and lock without elevation)
  gamepad   ViGEmBus kernel driver via ViGEmClient.dll (ctypes); mouse,
            keyboard and volume keys via SendInput (no driver needed)
  panel     RS-232 over COMn via CreateFileW/SetCommState (same Newline
            TruTouch frames as the Linux agent)

Watched units and recovery actions are config-driven:
%ProgramData%\\Couchside\\config.json (overridable with --config). On a
missing or invalid config the agent logs a warning and falls back to safe
generic defaults.

IMPORTANT deployment note: virtual input (SendInput, ViGEm) only works from
the interactive user session, NOT from a session-0 Windows service. Install
as a logon-triggered Scheduled Task running as the (non-elevated) desktop
user (install.ps1 does this), never as a classic service. Keeping the agent
unprivileged mirrors the Linux agent's least-privilege model: the bearer-
authed action/launcher API must never hand LAN clients admin execution.
"""

import argparse
import base64
import ctypes
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
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

IS_WINDOWS = sys.platform == "win32"

if IS_WINDOWS:
    import winreg
    from ctypes import wintypes
    # use_last_error=True so error paths can read ctypes.get_last_error()
    # (the value captured at FFI return) instead of the live thread
    # LastError, which interpreter housekeeping can overwrite.
    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _user32 = ctypes.WinDLL("user32", use_last_error=True)
    _iphlpapi = ctypes.WinDLL("iphlpapi", use_last_error=True)
    _ws2_32 = ctypes.WinDLL("ws2_32", use_last_error=True)
else:  # --mock on macOS/Linux: never touch Win32
    winreg = None
    wintypes = None
    _kernel32 = _user32 = _iphlpapi = _ws2_32 = None

# The QR encoder (same pure-stdlib module the Linux agent uses); /pair renders
# the matrix server-side from it. When installed, install.ps1 copies qr.py in
# beside this file; when run from a repo checkout it lives one dir up in
# agent/. Put both on the path so either layout resolves `import qr`.
_here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _here)
sys.path.insert(1, os.path.dirname(_here))
try:
    import qr as qrmod
except ImportError:
    qrmod = None

# Same app id the phone expects (AGENT_APPS in app/lib/api.ts); the Windows
# agent versions independently of the Linux one.
APP_NAME = "couchside-agent"
VERSION = "0.3.0-win"

_PROGRAMDATA = os.environ.get("ProgramData", r"C:\ProgramData")
DEFAULT_CONFIG_PATH = os.path.join(_PROGRAMDATA, "Couchside", "config.json")
DEFAULT_TOKEN_PATH = os.path.join(_PROGRAMDATA, "Couchside", "token")
DEFAULT_PORT = 8787

# Flags for spawning children without popping console windows, and for
# fire-and-forget detach (reboot etc. must outlive the agent).
if IS_WINDOWS:
    CREATE_NO_WINDOW = 0x08000000
    DETACHED_PROCESS = 0x00000008
    CREATE_NEW_PROCESS_GROUP = 0x00000200
    _RUN_FLAGS = CREATE_NO_WINDOW
    _DETACH_FLAGS = CREATE_NO_WINDOW | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
else:
    _RUN_FLAGS = 0
    _DETACH_FLAGS = 0

# ---------------------------------------------------------------------------
# Config: watched units + recovery actions
#
# Same schema as the Linux agent's /etc/couchside/config.json, with two
# Windows-specific readings:
#   - units[].name is a Windows SERVICE name (e.g. "Audiosrv"); scope is
#     accepted for schema parity but both values query the same service
#     controller (Windows has no systemd --user analog here).
#   - panel.device is a COM port name ("COM3"), not a /dev path.
#
# {
#   "port": 8787,                                   # optional
#   "units": [{"name": "Audiosrv", "scope": "system"}, ...],
#   "actions": {
#     "<id>": {
#       "label": "...",                             # optional, defaults to id
#       "description": "...",                       # optional, defaults to ""
#       "danger": "low"|"medium"|"high",            # required
#       "cmd": ["argv0", "arg1", ...],              # required, non-empty
#       "user_env": bool,                           # accepted, ignored on Windows
#       "detached": bool                            # optional, default false
#     }, ...
#   },
#   "action_order": ["<id>", ...],                  # optional listing order
#   "launchers": [                                  # optional custom launchers
#     {"id": "custom:<slug>", "label": "...", "cmd": [...]}
#   ],
#   "panel": {"device": "COM3", "baud": 19200, "protocol": "newline"}
# }
# ---------------------------------------------------------------------------

DEFAULT_UNITS = [
    # (service name, scope). Audiosrv = Windows Audio: the service an HTPC
    # actually cares about; add Steam/Sunshine etc. via config.json.
    ("Audiosrv", "system"),
]

DEFAULT_ACTIONS = {
    "restart-explorer": {
        "label": "Restart Explorer",
        "description": "Restart the Windows shell (explorer.exe), fixes a wedged desktop/taskbar",
        "danger": "medium",
        "cmd": ["powershell", "-NoProfile", "-Command",
                "Stop-Process -Name explorer -Force; Start-Process explorer.exe"],
        "user_env": False,
        "detached": False,
    },
    "lock": {
        "label": "Lock Screen",
        "description": "Lock the Windows session",
        "danger": "low",
        "cmd": ["rundll32.exe", "user32.dll,LockWorkStation"],
        "user_env": False,
        "detached": False,
    },
    "suspend": {
        "label": "Suspend",
        "description": "Suspend the box to RAM; wake it from the app over Wake-on-LAN",
        "danger": "medium",
        # SetSuspendState hibernates instead of sleeping when hibernation is
        # enabled; install.ps1 runs `powercfg /hibernate off` to make this a
        # true suspend (documented in the README).
        "cmd": ["rundll32.exe", "powrprof.dll,SetSuspendState", "0,1,0"],
        "user_env": False,
        "detached": True,
    },
    "reboot": {
        "label": "Reboot",
        "description": "Reboot the box",
        "danger": "high",
        "cmd": ["shutdown", "/r", "/t", "0"],
        "user_env": False,
        "detached": True,
    },
    "poweroff": {
        "label": "Power Off",
        "description": "Power off the box",
        "danger": "high",
        "cmd": ["shutdown", "/s", "/t", "0"],
        "user_env": False,
        "detached": True,
    },
}

DEFAULT_ACTION_ORDER = ["restart-explorer", "lock", "suspend", "reboot", "poweroff"]

# Custom launcher limits (same as the Linux agent).
MAX_LAUNCHERS = 100
MAX_CMD_ARGS = 64
MAX_CMD_ARG_LEN = 4096
MAX_LABEL_LEN = 200

# Supported serial line speeds (validated in config; the DCB is built from the
# integer directly on Windows, no termios constants needed).
PANEL_BAUDS = (9600, 19200, 38400, 57600, 115200)

# Effective config: set by load_config() before the server starts.
WATCHLIST = list(DEFAULT_UNITS)
WATCHLIST_NAMES = {name for name, _scope in WATCHLIST}
ACTIONS = dict(DEFAULT_ACTIONS)
ACTION_ORDER = list(DEFAULT_ACTION_ORDER)
CONFIG_PORT = None
CONFIG_PANEL = None
CONFIG_CEC_BRIDGE = None  # optional {"host","port","token"}: forward TV ops to a Pi
LAUNCHERS = []
CONFIG_PATH = DEFAULT_CONFIG_PATH
CONFIG_LOCK = threading.Lock()


class ConfigError(ValueError):
    pass


def _valid_launcher_id(lid):
    """A stored custom launcher id: "custom:" + a filesystem-safe slug."""
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


def _valid_com_device(device):
    """Panel device must be a plain COM port name ("COM1".."COM255"). The
    string is opened raw and written command frames, so it must never be
    attacker-influenced or an arbitrary path."""
    if not isinstance(device, str) or not device.upper().startswith("COM"):
        return False
    digits = device[3:]
    return digits.isdigit() and 1 <= int(digits) <= 255


def _parse_config(raw):
    """Validate a parsed config.json dict.

    Returns (units, actions, order, port, launchers, panel). Raises
    ConfigError on any schema violation; the caller falls back to the
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

    panel = None
    panel_raw = raw.get("panel")
    if panel_raw is not None:
        if not isinstance(panel_raw, dict):
            raise ConfigError("panel must be an object")
        device = panel_raw.get("device")
        if not _valid_com_device(device):
            raise ConfigError("panel.device must be a COM port name like \"COM3\"")
        baud = panel_raw.get("baud", 19200)
        if baud not in PANEL_BAUDS:
            raise ConfigError("panel.baud must be one of %s"
                              % ", ".join(str(b) for b in PANEL_BAUDS))
        proto = panel_raw.get("protocol", "newline")
        if proto != "newline":
            raise ConfigError("panel.protocol must be \"newline\"")
        panel = {"device": device.upper(), "baud": int(baud), "protocol": proto}

    # Optional CEC bridge: forward TV power/volume to a Raspberry Pi (or any
    # Linux box) wired to the TV's HDMI running couchside-cec-bridge. Lets a
    # Windows box (no CEC) still drive TV power. See cec-bridge/.
    cec_bridge = None
    cb_raw = raw.get("cec_bridge")
    if cb_raw is not None:
        if not isinstance(cb_raw, dict):
            raise ConfigError("cec_bridge must be an object")
        host = cb_raw.get("host")
        if not isinstance(host, str) or not host.strip():
            raise ConfigError("cec_bridge.host must be a non-empty string")
        cb_port = cb_raw.get("port", 8799)
        if not isinstance(cb_port, int) or not (1 <= cb_port <= 65535):
            raise ConfigError("cec_bridge.port must be an int 1-65535")
        cb_token = cb_raw.get("token")
        if not isinstance(cb_token, str) or not cb_token:
            raise ConfigError("cec_bridge.token must be a non-empty string")
        cec_bridge = {"host": host.strip(), "port": int(cb_port),
                      "token": cb_token}

    return units, actions, order, port, launchers, panel, cec_bridge


def load_config(path):
    """Load config.json into the module globals; fall back to defaults."""
    global WATCHLIST, WATCHLIST_NAMES, ACTIONS, ACTION_ORDER, CONFIG_PORT
    global LAUNCHERS, CONFIG_PATH, CONFIG_PANEL, CONFIG_CEC_BRIDGE
    CONFIG_PATH = path  # remembered so launcher POST/DELETE can rewrite it
    try:
        with open(path, encoding="utf-8-sig") as f:
            raw = json.load(f)
        units, actions, order, port, launchers, panel, cec_bridge = \
            _parse_config(raw)
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
    CONFIG_CEC_BRIDGE = cec_bridge
    print("config loaded from %s: %d units, %d actions, %d launchers"
          % (path, len(WATCHLIST), len(ACTIONS), len(LAUNCHERS)), flush=True)


# ---------------------------------------------------------------------------
# Real-mode data collection (Windows; each helper degrades gracefully)
# ---------------------------------------------------------------------------


def read_uptime_s():
    """Milliseconds since boot via GetTickCount64 (monotonic across sleep)."""
    try:
        _kernel32.GetTickCount64.restype = ctypes.c_ulonglong
        return int(_kernel32.GetTickCount64() // 1000)
    except Exception:
        return 0


class _MEMORYSTATUSEX(ctypes.Structure):
    _fields_ = [
        ("dwLength", ctypes.c_uint32),
        ("dwMemoryLoad", ctypes.c_uint32),
        ("ullTotalPhys", ctypes.c_uint64),
        ("ullAvailPhys", ctypes.c_uint64),
        ("ullTotalPageFile", ctypes.c_uint64),
        ("ullAvailPageFile", ctypes.c_uint64),
        ("ullTotalVirtual", ctypes.c_uint64),
        ("ullAvailVirtual", ctypes.c_uint64),
        ("ullAvailExtendedVirtual", ctypes.c_uint64),
    ]


def read_mem():
    try:
        st = _MEMORYSTATUSEX()
        st.dwLength = ctypes.sizeof(st)
        if not _kernel32.GlobalMemoryStatusEx(ctypes.byref(st)):
            raise OSError("GlobalMemoryStatusEx failed")
        total_mb = int(st.ullTotalPhys // (1024 * 1024))
        avail_mb = int(st.ullAvailPhys // (1024 * 1024))
        return {
            "total_mb": total_mb,
            "used_mb": total_mb - avail_mb,
            "available_mb": avail_mb,
        }
    except Exception:
        return {"total_mb": 0, "used_mb": 0, "available_mb": 0}


# --- CPU "load": Windows has no loadavg, so a background sampler turns
# GetSystemTimes deltas into a utilization-based approximation: instantaneous
# busy-fraction * logical cores, smoothed with 1/5/15-minute EMAs so the app's
# three load slots keep their familiar meaning.
_LOAD_LOCK = threading.Lock()
_LOAD = [0.0, 0.0, 0.0]
_LOAD_SAMPLE_S = 5.0


class _FILETIME(ctypes.Structure):
    _fields_ = [("dwLowDateTime", ctypes.c_uint32),
                ("dwHighDateTime", ctypes.c_uint32)]

    def to_int(self):
        return (self.dwHighDateTime << 32) | self.dwLowDateTime


def _system_times():
    """(idle, kernel, user) 100ns tick counters, or None."""
    idle, kern, user = _FILETIME(), _FILETIME(), _FILETIME()
    if not _kernel32.GetSystemTimes(ctypes.byref(idle), ctypes.byref(kern),
                                    ctypes.byref(user)):
        return None
    return idle.to_int(), kern.to_int(), user.to_int()


def _load_sampler():
    """Daemon thread: sample CPU busy-fraction every _LOAD_SAMPLE_S seconds and
    fold it into the three EMAs. Kernel time includes idle time on Windows, so
    busy = (kernel + user - idle) / (kernel + user)."""
    ncpu = os.cpu_count() or 1
    prev = _system_times()
    # EMA alphas for 1/5/15-minute horizons at our sample interval.
    alphas = [1 - pow(2.718281828, -_LOAD_SAMPLE_S / w) for w in (60.0, 300.0, 900.0)]
    while True:
        time.sleep(_LOAD_SAMPLE_S)
        cur = _system_times()
        if prev is None or cur is None:
            prev = cur
            continue
        d_idle = cur[0] - prev[0]
        d_kern = cur[1] - prev[1]
        d_user = cur[2] - prev[2]
        prev = cur
        total = d_kern + d_user
        if total <= 0:
            continue
        busy = max(0.0, min(1.0, (total - d_idle) / total))
        inst = busy * ncpu  # loadavg-like: runnable-ish work in "cores"
        with _LOAD_LOCK:
            for i, a in enumerate(alphas):
                _LOAD[i] = _LOAD[i] * (1 - a) + inst * a


def start_load_sampler():
    t = threading.Thread(target=_load_sampler, daemon=True,
                         name="load-sampler")
    t.start()


def read_load():
    with _LOAD_LOCK:
        return [round(x, 2) for x in _LOAD]


# --- CPU temperature: WMI thermal zone, which many consumer boards simply do
# not populate (or gate behind admin). One PowerShell probe, cached; None when
# unavailable, which the app already tolerates. Failures back off to a slow
# retry rather than latching dead: a transient PowerShell hiccup (or a WMI
# provider that comes up late) should not permanently blank the temperature.
_TEMP_TTL = 30.0
_TEMP_FAIL_TTL = 600.0
_TEMP_CACHE = {"at": 0.0, "val": None, "ttl": _TEMP_TTL}


def read_cpu_temp_c():
    now = time.monotonic()
    if now - _TEMP_CACHE["at"] <= _TEMP_CACHE["ttl"]:
        return _TEMP_CACHE["val"]
    _TEMP_CACHE["at"] = now
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             "(Get-CimInstance -Namespace root/wmi "
             "-ClassName MSAcpi_ThermalZoneTemperature "
             "-ErrorAction Stop | Select-Object -First 1).CurrentTemperature"],
            capture_output=True, text=True, timeout=10,
            creationflags=_RUN_FLAGS)
        raw = (r.stdout or "").strip()
        if r.returncode != 0 or not raw:
            raise ValueError(raw or "no thermal zone")
        # WMI reports tenths of Kelvin.
        temp_c = round(int(float(raw)) / 10.0 - 273.15, 1)
        if not (-50.0 < temp_c < 150.0):
            raise ValueError("implausible temperature %r" % temp_c)
        _TEMP_CACHE["val"] = temp_c
        _TEMP_CACHE["ttl"] = _TEMP_TTL
        return temp_c
    except Exception:
        # Most boxes without a readable thermal zone stay that way, so back
        # off hard (10 min) instead of spawning PowerShell every 30s — but
        # never latch permanently.
        _TEMP_CACHE["val"] = None
        _TEMP_CACHE["ttl"] = _TEMP_FAIL_TTL
        return None


DRIVE_FIXED = 3


def read_disks():
    """Every fixed drive with real capacity (C:\\, D:\\, ...)."""
    disks = []
    try:
        _kernel32.GetLogicalDrives.restype = ctypes.c_uint32
        mask = _kernel32.GetLogicalDrives()
    except Exception:
        mask = 0
    for i in range(26):
        if not (mask >> i) & 1:
            continue
        mount = "%s:\\" % chr(ord("A") + i)
        try:
            if _kernel32.GetDriveTypeW(ctypes.c_wchar_p(mount)) != DRIVE_FIXED:
                continue
            du = shutil.disk_usage(mount)
            if du.total < 1024 ** 3:
                continue
            pct = int(round(du.used * 100.0 / du.total)) if du.total else 0
            disks.append({
                "mount": mount,
                "total_gb": round(du.total / (1024 ** 3), 1),
                "used_gb": round(du.used / (1024 ** 3), 1),
                "free_gb": round(du.free / (1024 ** 3), 1),
                "pct": pct,
            })
        except Exception:
            continue
    return disks


# --- primary-interface network facts (for the app's Wake-on-LAN power path) --
_NET_TTL = 30.0
_NET_CACHE = {"at": 0.0, "val": None}

MIB_IF_TYPE_ETHERNET = 6
IF_TYPE_IEEE80211 = 71
MAX_ADAPTER_NAME_LENGTH = 256
MAX_ADAPTER_DESCRIPTION_LENGTH = 128
MAX_ADAPTER_ADDRESS_LENGTH = 8


class _IP_ADDR_STRING(ctypes.Structure):
    pass


_IP_ADDR_STRING._fields_ = [
    ("Next", ctypes.POINTER(_IP_ADDR_STRING)),
    ("IpAddress", ctypes.c_char * 16),
    ("IpMask", ctypes.c_char * 16),
    ("Context", ctypes.c_uint32),
]


class _IP_ADAPTER_INFO(ctypes.Structure):
    pass


_IP_ADAPTER_INFO._fields_ = [
    ("Next", ctypes.POINTER(_IP_ADAPTER_INFO)),
    ("ComboIndex", ctypes.c_uint32),
    ("AdapterName", ctypes.c_char * (MAX_ADAPTER_NAME_LENGTH + 4)),
    ("Description", ctypes.c_char * (MAX_ADAPTER_DESCRIPTION_LENGTH + 4)),
    ("AddressLength", ctypes.c_uint32),
    ("Address", ctypes.c_ubyte * MAX_ADAPTER_ADDRESS_LENGTH),
    ("Index", ctypes.c_uint32),
    ("Type", ctypes.c_uint32),
    ("DhcpEnabled", ctypes.c_uint32),
    ("CurrentIpAddress", ctypes.POINTER(_IP_ADDR_STRING)),
    ("IpAddressList", _IP_ADDR_STRING),
    ("GatewayList", _IP_ADDR_STRING),
    ("DhcpServer", _IP_ADDR_STRING),
    ("HaveWins", ctypes.c_int),
    ("PrimaryWinsServer", _IP_ADDR_STRING),
    ("SecondaryWinsServer", _IP_ADDR_STRING),
    ("LeaseObtained", ctypes.c_long),
    ("LeaseExpires", ctypes.c_long),
]


def _best_iface_index():
    """Adapter index the default route would use, via GetBestInterface toward
    TEST-NET-1 (192.0.2.1, never actually sent). None on failure."""
    try:
        dest = _ws2_32.inet_addr(b"192.0.2.1")
        index = ctypes.c_uint32(0)
        if _iphlpapi.GetBestInterface(dest, ctypes.byref(index)) != 0:
            return None
        return index.value
    except Exception:
        return None


def _adapters_info():
    """All adapters from GetAdaptersInfo as a list of _IP_ADAPTER_INFO."""
    size = ctypes.c_ulong(0)
    _iphlpapi.GetAdaptersInfo(None, ctypes.byref(size))
    if size.value == 0:
        return []
    buf = ctypes.create_string_buffer(size.value)
    if _iphlpapi.GetAdaptersInfo(buf, ctypes.byref(size)) != 0:
        return []
    adapters = []
    node = ctypes.cast(buf, ctypes.POINTER(_IP_ADAPTER_INFO))
    while node:
        adapters.append(node.contents)
        node = node.contents.Next
    return adapters


def _wol_armed_for_mac(mac):
    """Best-effort WakeOnMagicPacket state via PowerShell; None when the cmdlet
    is unavailable (non-admin, older Windows) or the adapter isn't found."""
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             "(Get-NetAdapter | Where-Object {$_.MacAddress -replace '-',':' "
             "-eq '%s'} | Get-NetAdapterPowerManagement "
             "-ErrorAction Stop).WakeOnMagicPacket" % mac.upper()],
            capture_output=True, text=True, timeout=10,
            creationflags=_RUN_FLAGS)
        raw = (r.stdout or "").strip().lower()
        if r.returncode != 0 or not raw:
            return None
        return raw == "enabled"
    except Exception:
        return None


def read_net():
    """Primary-interface facts. Every field degrades to None."""
    try:
        index = _best_iface_index()
        if index is None:
            return {"iface": None, "mac": None, "wired": None, "wol_armed": None}
        for ad in _adapters_info():
            if ad.Index != index:
                continue
            mac = ":".join("%02x" % b for b in ad.Address[:ad.AddressLength]) or None
            wired = None
            if ad.Type == MIB_IF_TYPE_ETHERNET:
                wired = True
            elif ad.Type == IF_TYPE_IEEE80211:
                wired = False
            desc = ad.Description.decode("mbcs", "replace").strip() or None
            return {"iface": desc, "mac": mac, "wired": wired,
                    "wol_armed": _wol_armed_for_mac(mac) if mac else None}
        return {"iface": None, "mac": None, "wired": None, "wol_armed": None}
    except Exception:
        return {"iface": None, "mac": None, "wired": None, "wol_armed": None}


def net_info_cached():
    now = time.monotonic()
    if _NET_CACHE["val"] is None or now - _NET_CACHE["at"] > _NET_TTL:
        _NET_CACHE["val"] = read_net()
        _NET_CACHE["at"] = now
    return _NET_CACHE["val"]


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


# --- units: Windows services via sc.exe --------------------------------------
# `sc query` STATE values -> (active, sub) in systemd vocabulary so the app's
# existing unit UI just works.
_SC_STATE_MAP = {
    "1": ("inactive", "dead"),        # STOPPED
    "2": ("activating", "start"),     # START_PENDING
    "3": ("deactivating", "stop"),    # STOP_PENDING
    "4": ("active", "running"),       # RUNNING
    "5": ("deactivating", "stop"),    # CONTINUE_PENDING (rare; close enough)
    "6": ("inactive", "paused"),      # PAUSE_PENDING
    "7": ("inactive", "paused"),      # PAUSED
}


def _sc_run(args):
    """Run sc.exe and return stdout text (OEM codepage tolerated)."""
    r = subprocess.run(["sc"] + args, capture_output=True, timeout=10,
                       creationflags=_RUN_FLAGS)
    return (r.stdout or b"").decode("utf-8", "replace"), r.returncode


def real_units():
    units = []
    for name, scope in WATCHLIST:
        active, sub, desc = "unknown", "unknown", ""
        try:
            out, rc = _sc_run(["query", name])
            if rc == 0:
                for line in out.splitlines():
                    s = line.strip()
                    if s.upper().startswith("STATE"):
                        # "STATE              : 4  RUNNING"
                        val = s.split(":", 1)[1].strip().split()
                        if val:
                            active, sub = _SC_STATE_MAP.get(
                                val[0], ("unknown", "unknown"))
                        break
            elif rc == 1060:  # ERROR_SERVICE_DOES_NOT_EXIST
                active, sub = "inactive", "not-found"
            dout, drc = _sc_run(["qdescription", name])
            if drc == 0:
                # "DESCRIPTION:  <text>" possibly wrapped onto the next line
                lines = dout.splitlines()
                for i, line in enumerate(lines):
                    if "DESCRIPTION" in line.upper():
                        after = line.split(":", 1)[1].strip() if ":" in line else ""
                        if not after and i + 1 < len(lines):
                            after = lines[i + 1].strip()
                        desc = after
                        break
        except Exception:
            pass
        units.append({
            "name": name,
            "scope": scope,
            "active": active,
            "sub": sub,
            "description": desc or name,
        })
    return units


# --- journal: Windows Event Log via wevtutil ---------------------------------


def _wevtutil_query(log, xpath, max_events, max_lines):
    """Text lines for the newest `max_events` events from `log` matching
    `xpath`, oldest-first (journalctl order), clamped to the LAST `max_lines`
    lines. Empty list on any failure.

    /f:text emits multi-line "Event[n]:" blocks and /rd:true reverses only
    the EVENT order, so the flip back to oldest-first must operate on whole
    blocks — reversing flat lines would render every event upside-down.
    """
    try:
        r = subprocess.run(
            ["wevtutil", "qe", log, "/q:%s" % xpath, "/c:%d" % max_events,
             "/rd:true", "/f:text"],
            capture_output=True, timeout=15, creationflags=_RUN_FLAGS)
        if r.returncode != 0:
            return []
        text = (r.stdout or b"").decode("utf-8", "replace")
    except Exception:
        return []
    blocks = []  # newest-first, as emitted
    current = []
    for line in text.splitlines():
        if not line.strip():
            continue
        if line.startswith("Event[") and current:
            blocks.append(current)
            current = []
        current.append(line.rstrip())
    if current:
        blocks.append(current)
    blocks.reverse()  # oldest-first, lines inside each block untouched
    out = [line for block in blocks for line in block]
    # The contract clamps LINES (journalctl -n), but /c: caps EVENTS; a
    # multi-line-block query can overshoot badly, so tail-trim to honor it.
    return out[-max_lines:]


def _service_display_name(unit):
    """The service's display name via `sc getdisplayname`, or None."""
    try:
        out, rc = _sc_run(["getdisplayname", unit])
        if rc != 0:
            return None
        # Output: "[SC] GetServiceDisplayName SUCCESS  Name = Windows Audio"
        for line in out.splitlines():
            if "=" in line and "Name" in line:
                name = line.split("=", 1)[1].strip()
                return name or None
    except Exception:
        pass
    return None


def _xpath_escape(value):
    return value.replace("'", "&apos;")


def real_journal(unit, scope, lines):
    """Event-log lines for a watched unit.

    Provider-name query against System then Application: services log under
    their own provider name when they log at all. Falls back to Service
    Control Manager events, which carry the service's DISPLAY name (not the
    key name) in their EventData — so the fallback resolves the display name
    and matches either, keeping started/stopped/crashed visible for services
    like Audiosrv ("Windows Audio") that never log under their own provider.
    """
    safe = _xpath_escape(unit)
    for log in ("System", "Application"):
        out = _wevtutil_query(
            log, "*[System[Provider[@Name='%s']]]" % safe, lines, lines)
        if out:
            return out
    names = ["Data='%s'" % safe]
    display = _service_display_name(unit)
    if display and display != unit:
        names.append("Data='%s'" % _xpath_escape(display))
    return _wevtutil_query(
        "System",
        "*[System[Provider[@Name='Service Control Manager']] and "
        "EventData[%s]]" % " or ".join(names), lines, lines)


def real_action(action_id):
    spec = ACTIONS[action_id]
    start = time.monotonic()
    if spec["detached"]:
        proc = subprocess.Popen(
            spec["cmd"],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            stdin=subprocess.DEVNULL, creationflags=_DETACH_FLAGS,
        )
        # Give the child ~200ms: if it already died non-zero, don't report
        # false success.
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
                       timeout=15, creationflags=_RUN_FLAGS)
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
    import math
    base = 55.0 + 4.5 * math.sin(now / 97.0)
    temp = round(base + random.uniform(-0.8, 0.8), 1)
    return {
        "hostname": "couchside-win",
        "time": int(now),
        "uptime_s": int(now - MOCK_START + MOCK_BOOT_OFFSET),
        "load": [round(random.uniform(0.2, 1.4), 2),
                 round(random.uniform(0.3, 1.1), 2),
                 round(random.uniform(0.3, 0.9), 2)],
        "cpu_temp_c": temp,
        "mem": {"total_mb": 16268, "used_mb": 7412, "available_mb": 8856},
        "disks": [
            {"mount": "C:\\", "total_gb": 930.2, "used_gb": 412.4,
             "free_gb": 517.8, "pct": 44},
            {"mount": "D:\\", "total_gb": 1863.0, "used_gb": 1204.2,
             "free_gb": 658.8, "pct": 65},
        ],
        "net": {"iface": "Intel(R) Ethernet Connection I219-V",
                "mac": "de:ad:be:ef:00:02", "wired": True, "wol_armed": True},
        "agent_version": VERSION,
    }


MOCK_UNIT_DESCS = {
    "Audiosrv": "Windows Audio",
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
    "The %(unit)s service entered the running state.",
    "%(src)s: initialized",
    "%(src)s: heartbeat ok",
    "%(src)s: work item processed",
    "%(src)s: idle",
]

MOCK_LOG_TEMPLATES = {
    "Audiosrv": [
        "The Windows Audio service entered the running state.",
        "Audio endpoint enumeration completed.",
        "Default render device changed.",
        "Audio session created for process steam.exe.",
    ],
}


def mock_journal(unit, scope, lines):
    src = unit
    templates = MOCK_LOG_TEMPLATES.get(
        unit, [t % {"unit": unit, "src": src} for t in MOCK_GENERIC_LOG])
    out = []
    n = min(lines, 30)
    t = time.time() - n * 47
    host = "couchside-win"
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
# Same routes and shapes as the Linux agent. Steam discovery reads the install
# path from the registry (HKCU\Software\Valve\Steam SteamPath), then the same
# libraryfolders.vdf / appmanifest_*.acf line-scans.
# ---------------------------------------------------------------------------

# Steam runtime/tool appids that ship in every library, never real games.
STEAM_TOOL_APPIDS = frozenset({
    "228980",   # Steamworks Common Redistributables
})

# appmanifest StateFlags bits meaning "an operation is in progress" (see the
# Linux agent for the full rationale). A game appears in /api/downloads only
# when one of these is set, or its byte counters prove an incomplete transfer.
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
    """Steam install dir from the registry, or None (never raises)."""
    if not IS_WINDOWS:
        return None
    for hive, subkey in ((winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam"),
                         (winreg.HKEY_LOCAL_MACHINE,
                          r"SOFTWARE\WOW6432Node\Valve\Steam")):
        try:
            with winreg.OpenKey(hive, subkey) as key:
                value_name = ("SteamPath" if hive == winreg.HKEY_CURRENT_USER
                              else "InstallPath")
                path, _type = winreg.QueryValueEx(key, value_name)
            path = os.path.normpath(str(path))
            if os.path.isdir(os.path.join(path, "steamapps")):
                return path
        except OSError:
            continue
        except Exception:
            continue
    return None


def _steam_exe(root):
    """Path to steam.exe under the root, or None."""
    exe = os.path.join(root, "steam.exe")
    return exe if os.path.isfile(exe) else None


# Steam Big Picture action, injected at load time when steam.exe exists (see
# _inject_steam_action). The Windows analog of the Linux agent's built-in
# SteamOS session-switch actions: one tap puts the box in couch/controller
# mode. Uses the `-bigpicture` flag (validated on a real box): it reliably
# COLD-STARTS a closed Steam directly into Big Picture — the couch use case.
# The `steam://open/bigpicture` URL was tried and REJECTED: on a cold start
# its handler brings Steam up in ordinary desktop mode (the URL is consumed
# before the UI is ready), which is exactly the "nothing happens" symptom.
# Trade-off: the flag does not flip an already-running desktop instance into
# Big Picture, but the target scenario is an idle box with Steam closed.
# Runs in the interactive session (the agent's scheduled task lives there),
# so the UI lands on the actual screen.
STEAM_BIGPICTURE_ACTION = {
    "label": "Steam Big Picture",
    "description": "Open Steam in Big Picture (couch) mode; starts Steam if it isn't running",
    "danger": "low",
    "cmd": [],  # filled with the discovered steam.exe path at inject time
    "user_env": False,
    "detached": True,
}


def _inject_steam_action(mock):
    """Add the Steam Big Picture action when steam.exe is present. Called
    after load_config so it applies whether config loaded or fell back to
    defaults; a config-defined "steam-bigpicture" wins. In --mock it is
    always injected (fake argv) so the app's Actions tab can be developed
    off-box. Idempotent."""
    global ACTIONS, ACTION_ORDER
    if "steam-bigpicture" in ACTIONS:
        return
    if mock:
        cmd = ["steam", "-bigpicture"]
    else:
        root = _steam_root()
        exe = _steam_exe(root) if root else None
        if exe is None:
            return
        cmd = [exe, "-bigpicture"]
    spec = dict(STEAM_BIGPICTURE_ACTION)
    spec["cmd"] = cmd
    ACTIONS["steam-bigpicture"] = spec
    if "steam-bigpicture" not in ACTION_ORDER:
        ACTION_ORDER.append("steam-bigpicture")


def _parse_vdf_paths(text):
    """Extract library "path" values from a libraryfolders.vdf blob.
    Line-scan, best-effort; never raises. VDF escapes backslashes ("C:\\\\...")
    so unescape the doubled ones."""
    paths = []
    for line in text.splitlines():
        s = line.strip()
        if not s.startswith('"path"'):
            continue
        rest = s[len('"path"'):].lstrip()
        if len(rest) >= 2 and rest[0] == '"':
            end = rest.find('"', 1)
            if end > 1:
                paths.append(rest[1:end].replace("\\\\", "\\"))
    return paths


def _steam_libraries(root):
    """The list of steamapps dirs to scan for this Steam root. Never raises."""
    libs = []
    seen = set()

    def add(steamapps_dir):
        try:
            real = os.path.realpath(steamapps_dir)
        except Exception:
            real = steamapps_dir
        key = os.path.normcase(real)
        if key not in seen and os.path.isdir(steamapps_dir):
            seen.add(key)
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


def _parse_acf(text, keys=("appid", "name")):
    """Extract the requested top-level quoted keys from an appmanifest .acf blob
    (default "appid"/"name", so existing callers are unchanged). Never raises."""
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
    if name.startswith("Steamworks") or name.startswith("Proton"):
        return True
    return False


def discover_steam_games():
    """Auto-discovered Steam games as Launcher dicts, sorted by name.
    Read-only, best-effort: any error yields an empty list."""
    try:
        root = _steam_root()
        if root is None:
            return []
        games = {}
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
                games.setdefault(appid, name)
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

    Read-only; any failure yields []. Walks the same libraries as
    discover_steam_games() but reads StateFlags + byte counters per appmanifest.
    Inclusion is an allowlist: an app is reported only when an active-op bit is
    set OR its byte counters prove an incomplete transfer. Uninstalls (2048) and
    fully-installed / stale pending-update entries with equal counters are
    omitted, so the list reflects only what is actually moving.
    """
    try:
        root = _steam_root()
        if root is None:
            return []
        keys = ("appid", "name", "StateFlags", "BytesToDownload", "BytesDownloaded")
        found = {}
        for steamapps in _steam_libraries(root):
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
                    continue
                incomplete = total > 0 and done < total
                if not (flags & DL_ACTIVE_OP) and not incomplete:
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


def list_launchers():
    """All launchers: configured custom launchers first, then Steam games."""
    customs = [
        {"id": l["id"], "label": l["label"], "kind": "custom"}
        for l in LAUNCHERS
    ]
    return customs + discover_steam_games()


def _launcher_argv(launcher_id):
    """Resolve a KNOWN launcher id to its argv, or None if unknown.

    steam:<appid>  -> [steam.exe, "steam://rungameid/<appid>"]
    custom:<slug>  -> that launcher's stored cmd argv from config
    """
    if launcher_id.startswith("steam:"):
        appid = launcher_id[len("steam:"):]
        if not appid.isdigit():
            return None
        root = _steam_root()
        exe = _steam_exe(root) if root else None
        if exe is None:
            return None
        for game in discover_steam_games():
            if game["id"] == launcher_id:
                return [exe, "steam://rungameid/%s" % appid]
        return None
    if _valid_launcher_id(launcher_id):
        for l in LAUNCHERS:
            if l["id"] == launcher_id:
                return list(l["cmd"])
    return None


def real_launch(argv):
    """Fire-and-forget launch into the user's session. The agent runs as the
    logged-in user (scheduled task), so children land on the desktop directly;
    detached so they outlive an agent restart."""
    try:
        subprocess.Popen(
            argv, shell=False,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL, creationflags=_DETACH_FLAGS,
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
    """--mock stand-in: one advancing download (+7%/poll) and one paused entry."""
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
    slug = "".join(out).strip("-_")
    return slug or "launcher"


def _new_launcher_id(label, existing_ids):
    """Generate a unique, valid custom: id derived from label."""
    base = _slugify_label(label)
    candidate = "custom:%s" % base
    n = 1
    while candidate in existing_ids or not _valid_launcher_id(candidate):
        n += 1
        candidate = "custom:%s-%d" % (base, n)
    return candidate


def _write_config_launchers(new_launchers):
    """Persist LAUNCHERS = new_launchers to CONFIG_PATH atomically (temp file +
    os.replace). Serialized by CONFIG_LOCK. Raises on I/O failure."""
    with CONFIG_LOCK:
        raw = None
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8-sig") as f:
                raw = json.load(f)
        except (OSError, ValueError):
            raw = None
        if not isinstance(raw, dict):
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
        # Create the config dir if it's missing: on Windows the agent may run
        # with a literal --token and no pre-existing %ProgramData%\Couchside,
        # and the first launcher POST would otherwise 500 on a FileNotFoundError.
        os.makedirs(directory, exist_ok=True)
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
        global LAUNCHERS
        LAUNCHERS = new_launchers


def add_launcher(label, cmd):
    """Validate + persist a new custom launcher; return its Launcher dict.
    Raises ConfigError on invalid input (mapped to HTTP 400 by the caller)."""
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
# SendInput plumbing: virtual mouse / keyboard / media keys (no driver needed)
# ---------------------------------------------------------------------------

INPUT_MOUSE = 0
INPUT_KEYBOARD = 1

KEYEVENTF_EXTENDEDKEY = 0x0001
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004

MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_MIDDLEDOWN = 0x0020
MOUSEEVENTF_MIDDLEUP = 0x0040
MOUSEEVENTF_WHEEL = 0x0800
WHEEL_DELTA = 120

VK_BACK, VK_TAB, VK_RETURN, VK_SHIFT, VK_ESCAPE, VK_SPACE = (
    0x08, 0x09, 0x0D, 0x10, 0x1B, 0x20)
VK_END, VK_HOME = 0x23, 0x24
VK_LEFT, VK_UP, VK_RIGHT, VK_DOWN = 0x25, 0x26, 0x27, 0x28
VK_VOLUME_MUTE, VK_VOLUME_DOWN, VK_VOLUME_UP = 0xAD, 0xAE, 0xAF

# E0-prefixed extended keys: SendInput needs KEYEVENTF_EXTENDEDKEY or their
# scan codes alias onto the numpad for raw-input consumers.
EXTENDED_VKS = frozenset((VK_LEFT, VK_UP, VK_RIGHT, VK_DOWN, VK_HOME, VK_END,
                          VK_VOLUME_MUTE, VK_VOLUME_DOWN, VK_VOLUME_UP))

# named special key -> virtual-key code (same protocol names as Linux)
SPECIAL_KEYS = {
    "backspace": VK_BACK,
    "enter": VK_RETURN,
    "tab": VK_TAB,
    "esc": VK_ESCAPE,
    "space": VK_SPACE,
    "up": VK_UP,
    "down": VK_DOWN,
    "left": VK_LEFT,
    "right": VK_RIGHT,
    "home": VK_HOME,
    "end": VK_END,
}

if IS_WINDOWS:
    ULONG_PTR = ctypes.c_size_t

    class _MOUSEINPUT(ctypes.Structure):
        _fields_ = [("dx", ctypes.c_long), ("dy", ctypes.c_long),
                    ("mouseData", ctypes.c_uint32),
                    ("dwFlags", ctypes.c_uint32),
                    ("time", ctypes.c_uint32),
                    ("dwExtraInfo", ULONG_PTR)]

    class _KEYBDINPUT(ctypes.Structure):
        _fields_ = [("wVk", ctypes.c_uint16), ("wScan", ctypes.c_uint16),
                    ("dwFlags", ctypes.c_uint32),
                    ("time", ctypes.c_uint32),
                    ("dwExtraInfo", ULONG_PTR)]

    class _HARDWAREINPUT(ctypes.Structure):
        _fields_ = [("uMsg", ctypes.c_uint32),
                    ("wParamL", ctypes.c_uint16),
                    ("wParamH", ctypes.c_uint16)]

    class _INPUT_UNION(ctypes.Union):
        _fields_ = [("mi", _MOUSEINPUT), ("ki", _KEYBDINPUT),
                    ("hi", _HARDWAREINPUT)]

    class _INPUT(ctypes.Structure):
        _fields_ = [("type", ctypes.c_uint32), ("u", _INPUT_UNION)]

    # Pin the signature: without argtypes ctypes defaults every arg to c_int,
    # which truncates the _INPUT array pointer on 64-bit Windows.
    _user32.SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(_INPUT), ctypes.c_int]
    _user32.SendInput.restype = wintypes.UINT

    def _send_inputs(inputs):
        """SendInput a list of _INPUT; raises OSError when Windows swallows
        them (secure desktop / UIPI / wrong session), so callers can report
        failure. Callers must treat this as NON-fatal — see _gamepad_message."""
        if not inputs:
            return
        n = len(inputs)
        arr = (_INPUT * n)(*inputs)
        sent = _user32.SendInput(n, arr, ctypes.sizeof(_INPUT))
        if sent != n:
            raise OSError("SendInput injected %d/%d events (error %d)"
                          % (sent, n, ctypes.get_last_error()))

    def _key_input(vk, down):
        inp = _INPUT()
        inp.type = INPUT_KEYBOARD
        inp.u.ki.wVk = vk
        # Real scan code alongside the VK: some games read scan codes only.
        inp.u.ki.wScan = _user32.MapVirtualKeyW(vk, 0)  # MAPVK_VK_TO_VSC
        flags = 0 if down else KEYEVENTF_KEYUP
        # Arrows/Home/End/volume are E0-prefixed extended keys; without this
        # flag their scan codes read as NUMPAD keys to raw-input consumers
        # (games), turning "left" into numpad-4.
        if vk in EXTENDED_VKS:
            flags |= KEYEVENTF_EXTENDEDKEY
        inp.u.ki.dwFlags = flags
        return inp

    def _unicode_key_inputs(ch):
        """Down+up KEYEVENTF_UNICODE events for one character, independent of
        the active keyboard layout (AltGr chars, any script). Non-BMP chars
        inject as their UTF-16 surrogate pair."""
        inputs = []
        units = ch.encode("utf-16-le")
        for i in range(0, len(units), 2):
            code = int.from_bytes(units[i:i + 2], "little")
            for up in (False, True):
                inp = _INPUT()
                inp.type = INPUT_KEYBOARD
                inp.u.ki.wVk = 0
                inp.u.ki.wScan = code
                inp.u.ki.dwFlags = (KEYEVENTF_UNICODE |
                                    (KEYEVENTF_KEYUP if up else 0))
                inputs.append(inp)
        return inputs

    def _mouse_input(dx=0, dy=0, data=0, flags=0):
        inp = _INPUT()
        inp.type = INPUT_MOUSE
        inp.u.mi.dx = dx
        inp.u.mi.dy = dy
        inp.u.mi.mouseData = data
        inp.u.mi.dwFlags = flags
        return inp


# ---------------------------------------------------------------------------
# Box mute state via Core Audio (ctypes COM, read-only). Best-effort: every
# failure returns None, which the API contract tolerates (muted: bool|null).
# ---------------------------------------------------------------------------

if IS_WINDOWS:
    _ole32 = ctypes.WinDLL("ole32", use_last_error=True)

    class _GUID(ctypes.Structure):
        _fields_ = [("Data1", ctypes.c_uint32), ("Data2", ctypes.c_uint16),
                    ("Data3", ctypes.c_uint16), ("Data4", ctypes.c_ubyte * 8)]

        @classmethod
        def from_str(cls, s):
            g = cls()
            _ole32.CLSIDFromString(ctypes.c_wchar_p(s), ctypes.byref(g))
            return g

    _CLSID_MMDeviceEnumerator = "{BCDE0395-E52F-467C-8E3D-C4579291692E}"
    _IID_IMMDeviceEnumerator = "{A95664D2-9614-4F35-A746-DE8DB63617E6}"
    _IID_IAudioEndpointVolume = "{5CDF2C82-841E-4546-9722-0CF74078229A}"
    _CLSCTX_ALL = 23
    _eRender, _eMultimedia = 0, 1

    def _com_method(obj, index, *argtypes):
        """Bound callable for vtable slot `index` on COM interface pointer
        `obj`. Explicit argtypes (the implicit `this` is prepended here), so
        ctypes marshals byrefs/ints correctly."""
        vtbl = ctypes.cast(obj, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p)))
        fn_ptr = vtbl.contents[index]
        proto = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, *argtypes)
        fn = proto(fn_ptr)
        return lambda *args: fn(obj, *args)

    def _com_release(obj):
        try:
            _com_method(obj, 2)()  # IUnknown::Release
        except Exception:
            pass

    # CoInitializeEx return values that mean THIS call took ownership and the
    # thread must balance with CoUninitialize: S_OK (0) and S_FALSE (1, already
    # inited in the SAME mode). RPC_E_CHANGED_MODE means another init on this
    # thread owns COM in a different mode — do NOT uninit then.
    _RPC_E_CHANGED_MODE = 0x80010106

    def _with_endpoint_volume(fn):
        """Acquire the default-render-endpoint IAudioEndpointVolume, invoke
        fn(volume_ptr_value), and tear everything down: releases every COM
        object AND balances CoInitializeEx with CoUninitialize (the missing
        CoUninitialize was leaking a COM apartment refcount on every /api/tv
        poll). Returns fn's result, or None on any failure. Never raises."""
        enumerator = ctypes.c_void_p()
        device = ctypes.c_void_p()
        volume = ctypes.c_void_p()
        need_uninit = False
        try:
            hr = _ole32.CoInitializeEx(None, 0)  # COINIT_MULTITHREADED
            # Uninit only when we actually initialized (S_OK/S_FALSE), never on
            # RPC_E_CHANGED_MODE or any hard failure.
            need_uninit = hr in (0, 1)
            if hr not in (0, 1) and hr != _RPC_E_CHANGED_MODE:
                return None
            clsid = _GUID.from_str(_CLSID_MMDeviceEnumerator)
            iid_enum = _GUID.from_str(_IID_IMMDeviceEnumerator)
            hr = _ole32.CoCreateInstance(
                ctypes.byref(clsid), None, _CLSCTX_ALL,
                ctypes.byref(iid_enum), ctypes.byref(enumerator))
            if hr != 0 or not enumerator:
                return None
            # IMMDeviceEnumerator::GetDefaultAudioEndpoint (vtable slot 4)
            get_default = _com_method(
                enumerator.value, 4, ctypes.c_uint32, ctypes.c_uint32,
                ctypes.POINTER(ctypes.c_void_p))
            hr = get_default(_eRender, _eMultimedia, ctypes.byref(device))
            if hr != 0 or not device:
                return None
            # IMMDevice::Activate (slot 3)
            iid_vol = _GUID.from_str(_IID_IAudioEndpointVolume)
            activate = _com_method(
                device.value, 3, ctypes.POINTER(_GUID), ctypes.c_uint32,
                ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p))
            hr = activate(ctypes.byref(iid_vol), _CLSCTX_ALL, None,
                          ctypes.byref(volume))
            if hr != 0 or not volume:
                return None
            return fn(volume.value)
        except Exception:
            return None
        finally:
            for obj in (volume, device, enumerator):
                if obj:
                    _com_release(obj.value)
            if need_uninit:
                try:
                    _ole32.CoUninitialize()
                except Exception:
                    pass

    def read_box_muted():
        """Current default-render-endpoint mute (True/False), or None."""
        def _get(vol):
            # IAudioEndpointVolume::GetMute (slot 15)
            muted = ctypes.c_int(0)
            get_mute = _com_method(vol, 15, ctypes.POINTER(ctypes.c_int))
            if get_mute(ctypes.byref(muted)) != 0:
                return None
            return bool(muted.value)
        return _with_endpoint_volume(_get)

    def read_box_volume():
        """Current default-render-endpoint scalar volume as a float 0.0-1.0,
        or None. Uses IAudioEndpointVolume::GetMasterVolumeLevelScalar
        (vtable slot 9): the same 0..1 taper the Windows volume slider uses,
        so it lines up with the app's percentage."""
        def _get(vol):
            level = ctypes.c_float(0.0)
            get_scalar = _com_method(vol, 9, ctypes.POINTER(ctypes.c_float))
            if get_scalar(ctypes.byref(level)) != 0:
                return None
            return max(0.0, min(1.0, float(level.value)))
        return _with_endpoint_volume(_get)

    def set_box_volume_scalar(level01):
        """Set the endpoint scalar volume to level01 (0.0-1.0) via
        IAudioEndpointVolume::SetMasterVolumeLevelScalar (vtable slot 7).
        Returns True on success. A positive level also clears mute (slot 14
        SetMute) so the change is audible, matching the Linux soft_set_volume
        unmute-on-raise behaviour."""
        lvl = max(0.0, min(1.0, float(level01)))
        def _set(vol):
            set_scalar = _com_method(vol, 7, ctypes.c_float, ctypes.c_void_p)
            if set_scalar(ctypes.c_float(lvl), None) != 0:
                return False
            if lvl > 0.0:
                # SetMute(FALSE, NULL) — best-effort; ignore its hr.
                set_mute = _com_method(vol, 14, ctypes.c_int, ctypes.c_void_p)
                set_mute(0, None)
            return True
        return bool(_with_endpoint_volume(_set))
else:
    def read_box_muted():
        return None

    def read_box_volume():
        return None

    def set_box_volume_scalar(level01):
        return False


# ---------------------------------------------------------------------------
# TV control (probe-and-appear): panel (RS-232 over COMn) + soft (volume keys)
#
# Same unified op set and dispatch rules as the Linux agent, minus CEC (no
# standard CEC stack on Windows). Windows binds VK_VOLUME_MUTE natively with
# a real mute OSD, so mute is a plain media-key tap here (no volume-to-zero
# dance like gamescope needs).
# ---------------------------------------------------------------------------

TV_OPS = ("power_on", "power_off", "volume_up", "volume_down", "mute")
SOFT_OPS = ("volume_up", "volume_down", "mute")
_POWER_OPS = ("power_on", "power_off")

_SOFT_VKS = {
    "volume_up": VK_VOLUME_UP,
    "volume_down": VK_VOLUME_DOWN,
    "mute": VK_VOLUME_MUTE,
}

PANEL = None  # {"device","baud","protocol"} when active
SOFT = None   # {"adapter": ...} when SendInput volume keys are available


# ---- panel backend: Newline TruTouch RS-232 frames over a COM port ---------

_PANEL_KEYCODES = {
    "power_on": 0x00,
    "power_off": 0x01,
    "mute": 0x02,
    "volume_down": 0x17,
    "volume_up": 0x18,
}


def _panel_frame(op):
    code = _PANEL_KEYCODES[op]
    return bytes([0x7F, 0x08, 0x99, 0xA2, 0xB3, 0xC4, 0x02, 0xFF, 0x01,
                  code, 0xCF])


def _hexstr(b):
    return " ".join("%02X" % x for x in b)


if IS_WINDOWS:
    GENERIC_READ = 0x80000000
    GENERIC_WRITE = 0x40000000
    OPEN_EXISTING = 3
    INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value

    class _DCB(ctypes.Structure):
        _fields_ = [
            ("DCBlength", ctypes.c_uint32), ("BaudRate", ctypes.c_uint32),
            ("fFlags", ctypes.c_uint32),  # packed bitfields, cleared to 0
            ("wReserved", ctypes.c_uint16), ("XonLim", ctypes.c_uint16),
            ("XoffLim", ctypes.c_uint16), ("ByteSize", ctypes.c_ubyte),
            ("Parity", ctypes.c_ubyte), ("StopBits", ctypes.c_ubyte),
            ("XonChar", ctypes.c_char), ("XoffChar", ctypes.c_char),
            ("ErrorChar", ctypes.c_char), ("EofChar", ctypes.c_char),
            ("EvtChar", ctypes.c_char), ("wReserved1", ctypes.c_uint16),
        ]

    class _COMMTIMEOUTS(ctypes.Structure):
        _fields_ = [
            ("ReadIntervalTimeout", ctypes.c_uint32),
            ("ReadTotalTimeoutMultiplier", ctypes.c_uint32),
            ("ReadTotalTimeoutConstant", ctypes.c_uint32),
            ("WriteTotalTimeoutMultiplier", ctypes.c_uint32),
            ("WriteTotalTimeoutConstant", ctypes.c_uint32),
        ]

    def _serial_send(device, baud, frame, expect_reply=True, timeout=1.0):
        """Open \\\\.\\COMn raw at <baud> 8N1, write <frame>, read back a short
        reply (best-effort). Returns the reply bytes."""
        path = "\\\\.\\" + device
        # restype must be c_void_p: the default c_int truncates the 64-bit
        # HANDLE and turns INVALID_HANDLE_VALUE into a plain -1 that would
        # never match the sentinel below.
        _kernel32.CreateFileW.restype = ctypes.c_void_p
        handle = _kernel32.CreateFileW(
            ctypes.c_wchar_p(path), ctypes.c_uint32(GENERIC_READ | GENERIC_WRITE),
            0, None, OPEN_EXISTING, 0, None)
        if handle == INVALID_HANDLE_VALUE or handle is None:
            raise OSError("cannot open %s (error %d)"
                          % (device, ctypes.get_last_error()))
        handle = ctypes.c_void_p(handle)  # keep full 64-bit width in calls
        try:
            dcb = _DCB()
            dcb.DCBlength = ctypes.sizeof(dcb)
            if not _kernel32.GetCommState(handle, ctypes.byref(dcb)):
                raise OSError("GetCommState failed (error %d)"
                              % ctypes.get_last_error())
            dcb.BaudRate = baud
            dcb.ByteSize = 8
            dcb.Parity = 0     # NOPARITY
            dcb.StopBits = 0   # ONESTOPBIT
            # fBinary must stay set (bit 0); everything else (parity check,
            # CTS/DSR flow control, XON/XOFF, DTR/RTS control) cleared = raw.
            dcb.fFlags = 0x00000001
            if not _kernel32.SetCommState(handle, ctypes.byref(dcb)):
                raise OSError("SetCommState failed (error %d)"
                              % ctypes.get_last_error())
            # MAXDWORD/MAXDWORD/constant: ReadFile returns as soon as ANY
            # bytes are available (or after `constant` ms with none), instead
            # of stalling the full timeout waiting to fill the buffer. The
            # panel echo is 12 bytes and arrives in milliseconds; the plain
            # total-timeout form would block every TV op ~1s.
            MAXDWORD = 0xFFFFFFFF
            to = _COMMTIMEOUTS(MAXDWORD, MAXDWORD, int(timeout * 1000),
                               0, int(timeout * 1000))
            _kernel32.SetCommTimeouts(handle, ctypes.byref(to))
            written = ctypes.c_uint32(0)
            if not _kernel32.WriteFile(handle, frame, len(frame),
                                       ctypes.byref(written), None):
                raise OSError("WriteFile failed (error %d)"
                              % ctypes.get_last_error())
            if written.value != len(frame):
                raise OSError("short serial write (%d/%d)"
                              % (written.value, len(frame)))
            _kernel32.FlushFileBuffers(handle)
            reply = b""
            if expect_reply:
                # Accumulate until the 12-byte Newline echo is in (or the
                # deadline passes); each ReadFile returns per the interval
                # timeouts above, so a quiet line exits early.
                deadline = time.monotonic() + timeout
                buf = ctypes.create_string_buffer(64)
                nread = ctypes.c_uint32(0)
                while len(reply) < 12 and time.monotonic() < deadline:
                    if not _kernel32.ReadFile(handle, buf, 64,
                                              ctypes.byref(nread), None):
                        break
                    if nread.value == 0:
                        break  # timed out with nothing more coming
                    reply += buf.raw[:nread.value]
            return reply
        finally:
            _kernel32.CloseHandle(handle)
else:
    def _serial_send(device, baud, frame, expect_reply=True, timeout=1.0):
        raise OSError("serial panel control requires Windows")


def _com_port_exists(device):
    """True when COMn is present (QueryDosDeviceW resolves it)."""
    if not IS_WINDOWS:
        return False
    try:
        buf = ctypes.create_unicode_buffer(1024)
        return _kernel32.QueryDosDeviceW(ctypes.c_wchar_p(device), buf, 1024) != 0
    except Exception:
        return False


def set_panel(mock):
    """Populate the panel descriptor. In --mock a fake serial device is always
    reported so the TV strip can be developed without hardware. Real mode:
    active only when config.json named a COM port that exists."""
    global PANEL
    if mock:
        PANEL = {"device": "mock", "baud": 19200, "protocol": "newline"}
    elif CONFIG_PANEL and _com_port_exists(CONFIG_PANEL["device"]):
        PANEL = dict(CONFIG_PANEL)
    else:
        PANEL = None


def panel_available():
    return PANEL is not None


def real_panel(op):
    """Send a Newline command frame over the configured COM port. Success
    means the frame was written; the reply, if any, is echoed in stdout."""
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


# ---- soft backend (box volume via the OS media keys) ------------------------


def set_soft(mock):
    """Probe the soft backend. SendInput needs no device creation, so this is
    a capability check only. In --mock the soft backend stays off so the mock
    TV strip runs on the panel path (same as Linux)."""
    global SOFT
    if mock or not IS_WINDOWS:
        SOFT = None
        return
    SOFT = {"adapter": "OS volume keys"}


def soft_available():
    return SOFT is not None


def real_soft(op):
    """Tap the matching volume media key. Windows handles VK_VOLUME_* exactly
    like a hardware volume rocker: real volume change + on-screen indicator,
    including a genuine mute toggle. ActionResult-shaped, with "muted" on the
    mute op so the app's indicator updates without a follow-up poll."""
    start = time.monotonic()
    vk = _SOFT_VKS.get(op)
    if vk is None:
        return {"ok": False, "exit_code": -1, "stdout": "",
                "stderr": "%s is not a volume op" % op, "duration_ms": 0}
    try:
        _send_inputs([_key_input(vk, True), _key_input(vk, False)])
    except OSError as e:
        return {"ok": False, "exit_code": -1, "stdout": "",
                "stderr": "%s: %s" % (e.__class__.__name__, e),
                "duration_ms": int((time.monotonic() - start) * 1000)}
    result = {"ok": True, "exit_code": 0, "stdout": "sent %s" % op,
              "stderr": "",
              "duration_ms": int((time.monotonic() - start) * 1000)}
    if op == "mute":
        # Give the shell a beat to commit the toggle before reading it back.
        time.sleep(0.1)
        result["muted"] = read_box_muted()
    return result


def mock_soft(op):
    """--mock stand-in for a box-volume op: log it, touch nothing, succeed."""
    time.sleep(0.1)
    print("[soft] %s" % op, flush=True)
    return {"ok": True, "exit_code": 0, "stdout": "[mock soft] %s\n" % op,
            "stderr": "", "duration_ms": 100}


def _soft_volume_pct():
    """Box volume as an integer 0-100, or None if unreadable. Reads the same
    Core Audio endpoint that backs the mute state, so the app's slider and the
    volume rocker agree."""
    v = read_box_volume()
    if v is None:
        return None
    return max(0, min(100, int(round(v * 100))))


def soft_set_volume(level):
    """Set the box volume to <level> percent (0-100) directly on the Core Audio
    endpoint (SetMasterVolumeLevelScalar). Unlike the Linux agent, Windows has
    no gamescope OSD to satisfy, and SetMasterVolumeLevelScalar is exactly what
    the volume slider drives, so a single scalar write both changes the level
    and shows nothing surprising. ActionResult-shaped, plus a "level" field so
    the app's slider can snap to the real value."""
    start = time.monotonic()
    level = max(0, min(100, int(level)))

    def result(ok, cur, note):
        return {"ok": ok, "exit_code": 0 if ok else -1,
                "stdout": note if ok else "", "stderr": "" if ok else note,
                "level": cur,
                "duration_ms": int((time.monotonic() - start) * 1000)}

    if not set_box_volume_scalar(level / 100.0):
        return result(False, _soft_volume_pct(), "box volume set failed")
    cur = _soft_volume_pct()
    return result(True, level if cur is None else cur, "level %d" % level)


# ---- unified dispatch --------------------------------------------------------


# ---- cec_bridge backend (forward TV ops to a Pi wired to the TV over CEC) ----
# Windows has no local CEC stack, so a box whose HDMI carries no CEC (most
# desktops) can instead point at a Raspberry Pi running couchside-cec-bridge
# that is plugged into the TV's HDMI. Config-driven (config.json "cec_bridge").
CEC_BRIDGE = None
CEC_BRIDGE_TIMEOUT = 12


def set_cec_bridge(mock):
    global CEC_BRIDGE
    CEC_BRIDGE = dict(CONFIG_CEC_BRIDGE) if CONFIG_CEC_BRIDGE else None


def cec_bridge_available():
    return CEC_BRIDGE is not None


def real_cec_bridge(op):
    """Forward one TV op to the bridge (POST /cec/<op>, bearer token). The bridge
    returns an ActionResult; pass it straight through. Transport errors become a
    synthetic failure so the app shows a clean error, not a 500."""
    b = CEC_BRIDGE
    start = time.monotonic()
    url = "http://%s:%d/cec/%s" % (b["host"], b["port"], op)
    req = urllib.request.Request(
        url, data=b"", method="POST",
        headers={"Authorization": "Bearer " + b["token"]})
    try:
        with urllib.request.urlopen(req, timeout=CEC_BRIDGE_TIMEOUT) as resp:
            body = json.loads(resp.read().decode("utf-8", "replace"))
        if isinstance(body, dict) and "ok" in body:
            return body
        return {"ok": False, "exit_code": -1, "stdout": "",
                "stderr": "cec bridge returned an unexpected body",
                "duration_ms": int((time.monotonic() - start) * 1000)}
    except Exception as e:
        return {"ok": False, "exit_code": -1, "stdout": "",
                "stderr": "cec bridge %s: %s" % (url, e),
                "duration_ms": int((time.monotonic() - start) * 1000)}


def mock_cec_bridge(op):
    time.sleep(0.1)
    print("[cec_bridge] %s -> %s:%d" % (op, CEC_BRIDGE["host"],
                                        CEC_BRIDGE["port"]), flush=True)
    return {"ok": True, "exit_code": 0,
            "stdout": "[mock cec_bridge] %s\n" % op, "stderr": "",
            "duration_ms": 100}


def set_tv(mock):
    """Probe every TV backend at startup (call after load_config)."""
    set_panel(mock)
    set_cec_bridge(mock)
    set_soft(mock)


def _tv_hw_backend():
    """The external TV backend for power: the serial panel, then a CEC bridge
    Pi, then nothing (Windows has no local CEC stack)."""
    if panel_available():
        return "panel"
    if cec_bridge_available():
        return "cec_bridge"
    return None


def tv_info():
    """GET /api/tv body, or None when nothing is controllable."""
    hw = _tv_hw_backend()
    box_vol = soft_available()
    if hw is None and not box_vol:
        return None
    if hw == "panel":
        backend, adapter = "panel", "Newline RS-232 (%s @ %d)" % (
            PANEL["device"], PANEL["baud"])
    elif hw == "cec_bridge":
        # Report as "cec" so the app treats it as a normal CEC TV backend.
        backend, adapter = "cec", "CEC bridge (%s:%d)" % (
            CEC_BRIDGE["host"], CEC_BRIDGE["port"])
    else:
        backend, adapter = "soft", SOFT["adapter"]
    return {
        "available": True,
        "backend": backend,
        "adapter": adapter,
        "ops": list(TV_OPS),
        "box_volume": box_vol,
        "tv_volume": hw is not None,
        "tv_power": hw is not None,
        "muted": read_box_muted() if box_vol else None,
        # Current levels (0-100 or null) so the app's slider shows and keeps a
        # real position. Box level is the Core Audio scalar; the Windows panel
        # backend has no volume read-back, so tv_volume_level stays null.
        "box_volume_level": _soft_volume_pct() if box_vol else None,
        "tv_volume_level": None,
    }


def _send_tv_hw(op, mock):
    """Route an op to the external TV backend (panel or CEC bridge), or None."""
    b = _tv_hw_backend()
    if b == "panel":
        return mock_panel(op) if mock else real_panel(op)
    if b == "cec_bridge":
        return mock_cec_bridge(op) if mock else real_cec_bridge(op)
    return None


def tv_send(op, mock, target=None):
    """Dispatch a TV op. Power always goes to the external TV backend. Volume
    goes to the box's own OS volume (soft) by default, or to the TV backend
    when target == "tv". Falls back to whichever exists. None when nothing
    can handle it (caller 404s)."""
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
# Now-playing + transport via Windows System Media Transport Controls (SMTC)
#
# The Windows analog of the Linux agent's MPRIS control. Two halves, each
# best-effort and fully wrapped so failure degrades to 404/unavailable and
# never touches an existing endpoint:
#   * metadata  — the current SMTC session (title/artist/album/status/timeline)
#                 read through WinRT's GlobalSystemMediaTransportControlsSession-
#                 Manager, driven from a short PowerShell script (no pip WinRT
#                 dep; stdlib only). Read-only.
#   * transport — the OS media keys via SendInput (VK_MEDIA_*), exactly like a
#                 keyboard's play/next/prev buttons. These are GLOBAL (the shell
#                 routes them to the active session), so there is one synthetic
#                 player id ("system") rather than a per-app address.
#
# NEEDS ON-WINDOWS TESTING: the PowerShell WinRT bridge (async GetAwaiter /
# thumbnail stream) is written to the documented API but unverified on a real
# box. All of it is wrapped; on any failure smtc_info() returns an available
# session list that may be empty, and the app simply shows nothing.
# ---------------------------------------------------------------------------

VK_MEDIA_NEXT_TRACK = 0xB0
VK_MEDIA_PREV_TRACK = 0xB1
VK_MEDIA_STOP = 0xB2
VK_MEDIA_PLAY_PAUSE = 0xB3

# Transport op -> media-key VK. play/pause/play_pause all fold onto the single
# hardware PLAY_PAUSE toggle (media keys expose no distinct play vs pause), so
# the app's play and pause buttons both toggle — matching a real remote.
SMTC_KEY_OPS = {
    "play": VK_MEDIA_PLAY_PAUSE,
    "pause": VK_MEDIA_PLAY_PAUSE,
    "play_pause": VK_MEDIA_PLAY_PAUSE,
    "next": VK_MEDIA_NEXT_TRACK,
    "previous": VK_MEDIA_PREV_TRACK,
    "stop": VK_MEDIA_STOP,
}
# Contract parity with MPRIS_OPS: the app may offer a seek control, but media
# keys can't seek, so "seek" is accepted as a known op and reported unsupported.
SMTC_OPS = tuple(SMTC_KEY_OPS) + ("seek",)

# The single synthetic player id. SMTC transport is global, so there is no real
# per-app addressing; the app just needs a stable id to POST ops against.
SMTC_PLAYER_ID = "system"

SMTC_ART_MAX = 2 * 1024 * 1024  # 2 MiB read cap on album art (MPRIS parity)
SMTC_TIMEOUT = 6

# Cache the last metadata read briefly so a poll of /api/media plus the app's
# art fetch don't each spawn PowerShell; art resolution reuses the cached key.
_SMTC_LOCK = threading.Lock()
_SMTC_CACHE = {"at": 0.0, "val": None}
_SMTC_TTL = 1.0

# PowerShell that prints ONE line of JSON describing the current SMTC session,
# or "null". Kept inert on failure (any throw -> the outer runner returns None).
_SMTC_PS = r"""
$ErrorActionPreference = 'Stop'
function Await($t, $rt) {
  $m = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.IsGenericMethod } |
    Select-Object -First 1
  $g = $m.MakeGenericMethod($rt)
  $task = $g.Invoke($null, @($t))
  $task.Wait(-1) | Out-Null
  return $task.Result
}
try {
  [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime] | Out-Null
  [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManagerRequestedEventArgs, Windows.Media.Control, ContentType=WindowsRuntime] | Out-Null
  $mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
  $mgr = Await ($mgrType::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  $s = $mgr.GetCurrentSession()
  if ($null -eq $s) { 'null'; exit 0 }
  $props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  $pb = $s.GetPlaybackInfo()
  $tl = $s.GetTimelineProperties()
  $status = [int]$pb.PlaybackStatus
  $hasArt = $false
  if ($props.Thumbnail -ne $null) { $hasArt = $true }
  $o = [ordered]@{
    id       = [string]$s.SourceAppUserModelId
    title    = [string]$props.Title
    artist   = [string]$props.Artist
    album    = [string]$props.AlbumTitle
    status   = $status
    pos_ms   = [long]$tl.Position.TotalMilliseconds
    len_ms   = [long]$tl.EndTime.TotalMilliseconds
    can_next = [bool]$pb.Controls.IsNextEnabled
    can_prev = [bool]$pb.Controls.IsPreviousEnabled
    can_play = [bool]$pb.Controls.IsPlayEnabled
    can_pause= [bool]$pb.Controls.IsPauseEnabled
    has_art  = $hasArt
  }
  ($o | ConvertTo-Json -Compress)
} catch { 'null' }
"""

# PowerShell that writes the current SMTC thumbnail to $env:CS_ART_OUT and
# prints "ok"/"none". Separate from metadata so the (heavier) stream copy runs
# only when the app actually requests art.
_SMTC_ART_PS = r"""
$ErrorActionPreference = 'Stop'
function Await($t, $rt) {
  $m = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.IsGenericMethod } |
    Select-Object -First 1
  $g = $m.MakeGenericMethod($rt)
  $task = $g.Invoke($null, @($t))
  $task.Wait(-1) | Out-Null
  return $task.Result
}
try {
  [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime] | Out-Null
  $mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
  $mgr = Await ($mgrType::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  $s = $mgr.GetCurrentSession()
  if ($null -eq $s) { 'none'; exit 0 }
  $props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  if ($props.Thumbnail -eq $null) { 'none'; exit 0 }
  $stream = Await ($props.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
  $size = [int]$stream.Size
  if ($size -le 0 -or $size -gt 2097152) { 'none'; exit 0 }
  $reader = [Windows.Storage.Streams.DataReader]::new($stream)
  Await ($reader.LoadAsync($size)) ([uint32]) | Out-Null
  $bytes = New-Object byte[] $size
  $reader.ReadBytes($bytes)
  [System.IO.File]::WriteAllBytes($env:CS_ART_OUT, $bytes)
  'ok'
} catch { 'none' }
"""

# SMTC PlaybackStatus enum -> the app's status vocabulary (MPRIS parity).
_SMTC_STATUS = {4: "Playing", 5: "Paused"}


def _smtc_str(v):
    return v if isinstance(v, str) else ""


def _smtc_art_key(session):
    """Stable cache-buster for the current track's art, derived from the track
    identity (never a path). Changes when the track changes."""
    basis = "%s|%s|%s" % (session.get("title", ""), session.get("artist", ""),
                          session.get("album", ""))
    return hashlib.sha1(basis.encode("utf-8", "replace")).hexdigest()[:16]


def _run_powershell(script, timeout, env=None):
    """Run a PowerShell script from stdin; return stdout text, or None on any
    failure. -Command - reads the script from stdin so no temp file / no
    quoting minefield. Never raises."""
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive",
             "-ExecutionPolicy", "Bypass", "-Command", "-"],
            input=script, capture_output=True, text=True, timeout=timeout,
            creationflags=_RUN_FLAGS, env=env)
    except Exception:
        return None
    if r.returncode != 0:
        return None
    return r.stdout


def _smtc_read():
    """Current SMTC session as a raw dict (PowerShell JSON), or None. Cached
    for _SMTC_TTL to keep /api/media polling cheap. Never raises."""
    if not IS_WINDOWS:
        return None
    now = time.monotonic()
    with _SMTC_LOCK:
        if _SMTC_CACHE["val"] is not None and now - _SMTC_CACHE["at"] < _SMTC_TTL:
            return _SMTC_CACHE["val"]
    out = _run_powershell(_SMTC_PS, SMTC_TIMEOUT)
    val = None
    if out:
        line = out.strip()
        if line and line.lower() != "null":
            try:
                parsed = json.loads(line)
                if isinstance(parsed, dict):
                    val = parsed
            except Exception:
                val = None
    with _SMTC_LOCK:
        _SMTC_CACHE.update(at=time.monotonic(), val=val)
    return val


def _smtc_player_info():
    """The single SMTC player dict (MPRIS-player-shaped), or None when nothing
    is playing/paused. Never raises."""
    session = _smtc_read()
    if not isinstance(session, dict):
        return None
    status = _SMTC_STATUS.get(session.get("status"), "Stopped")
    def _int(v):
        try:
            return max(0, int(v))
        except (TypeError, ValueError):
            return 0
    has_art = bool(session.get("has_art"))
    return {
        "id": SMTC_PLAYER_ID,
        "identity": _smtc_str(session.get("id")) or "Media",
        "status": status,
        "title": _smtc_str(session.get("title")),
        "artist": _smtc_str(session.get("artist")),
        "album": _smtc_str(session.get("album")),
        "position_ms": _int(session.get("pos_ms")),
        "length_ms": _int(session.get("len_ms")),
        "rate": 1.0,
        # Media keys can't seek; report no seek so the app hides the scrubber.
        "can_seek": False,
        "can_go_next": bool(session.get("can_next")),
        "can_go_previous": bool(session.get("can_prev")),
        "can_play": bool(session.get("can_play")),
        "can_pause": bool(session.get("can_pause")),
        "art": has_art,
        "art_key": _smtc_art_key(session) if has_art else "",
    }


def smtc_available():
    """True when SMTC control is even plausible (Windows). The metadata read is
    probe-and-appear at /api/media, so this only gates the whole feature off on
    non-Windows."""
    return IS_WINDOWS


def smtc_info():
    """{"available":True,"players":[...]} or None when SMTC is unavailable.
    A live-but-idle box returns an empty players list (matches MPRIS)."""
    if not smtc_available():
        return None
    info = _smtc_player_info()
    return {"available": True, "players": [info] if info is not None else []}


def real_smtc_op(player, op):
    """Run a transport op by tapping the matching media key. ActionResult-shaped,
    or None for an unknown player / unsupported op (route 404s). The media key is
    global, so `player` is validated only against the synthetic id."""
    if player != SMTC_PLAYER_ID:
        return None
    start = time.monotonic()
    if op == "seek":
        return {"ok": False, "exit_code": -1, "stdout": "",
                "stderr": "seek is not supported over media keys",
                "duration_ms": int((time.monotonic() - start) * 1000)}
    vk = SMTC_KEY_OPS.get(op)
    if vk is None:
        return None
    try:
        _send_inputs([_key_input(vk, True), _key_input(vk, False)])
    except OSError as e:
        return {"ok": False, "exit_code": -1, "stdout": "",
                "stderr": "%s: %s" % (e.__class__.__name__, e),
                "duration_ms": int((time.monotonic() - start) * 1000)}
    # A key tap invalidates the cached metadata (status likely changed).
    with _SMTC_LOCK:
        _SMTC_CACHE.update(at=0.0, val=None)
    return {"ok": True, "exit_code": 0, "stdout": "sent %s" % op, "stderr": "",
            "duration_ms": int((time.monotonic() - start) * 1000)}


def smtc_art(player, art_key):
    """Resolve the CURRENT session's thumbnail bytes (the client supplies no
    path), enforce the 2 MiB cap, and sniff the image type. Returns (data, mime)
    or None. `art_key` must match the current track's key (else the track
    changed -> 404). Never raises."""
    if player != SMTC_PLAYER_ID:
        return None
    session = _smtc_read()
    if not isinstance(session, dict) or not session.get("has_art"):
        return None
    if art_key and _smtc_art_key(session) != art_key:
        return None
    tmp = None
    try:
        fd, tmp = tempfile.mkstemp(prefix="cs-art-", suffix=".img")
        os.close(fd)
        env = dict(os.environ)
        env["CS_ART_OUT"] = tmp
        out = _run_powershell(_SMTC_ART_PS, SMTC_TIMEOUT, env=env)
        if not out or out.strip().lower() != "ok":
            return None
        if os.path.getsize(tmp) > SMTC_ART_MAX:
            return None
        with open(tmp, "rb") as f:
            data = f.read(SMTC_ART_MAX + 1)
        if not data or len(data) > SMTC_ART_MAX:
            return None
        mime = _sniff_image(data)
        return (data, mime) if mime else None
    except Exception:
        return None
    finally:
        if tmp:
            try:
                os.remove(tmp)
            except OSError:
                pass


# --- SMTC mock (parity with mock_mpris_*) ------------------------------------
_MOCK_SMTC_POS = 0
# 1x1 transparent PNG so --mock album art works off-box.
_MOCK_ART_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")


def mock_smtc_info():
    global _MOCK_SMTC_POS
    _MOCK_SMTC_POS = (_MOCK_SMTC_POS + 3000) % 214000
    return {"available": True, "players": [{
        "id": SMTC_PLAYER_ID, "identity": "Groove", "status": "Playing",
        "title": "Midnight City", "artist": "M83",
        "album": "Hurry Up, We're Dreaming",
        "position_ms": _MOCK_SMTC_POS, "length_ms": 214000, "rate": 1.0,
        "can_seek": False, "can_go_next": True, "can_go_previous": True,
        "can_play": True, "can_pause": True, "art": True,
        "art_key": "mockart1",
    }]}


def mock_smtc_op(player, op):
    if player != SMTC_PLAYER_ID:
        return None
    if op == "seek":
        return {"ok": False, "exit_code": -1, "stdout": "",
                "stderr": "seek is not supported over media keys",
                "duration_ms": 10}
    if op not in SMTC_KEY_OPS:
        return None
    print("[smtc] %s %s" % (player, op), flush=True)
    return {"ok": True, "exit_code": 0,
            "stdout": "[mock smtc] %s %s" % (player, op),
            "stderr": "", "duration_ms": 40}


def mock_smtc_art(player, art_key):
    if player != SMTC_PLAYER_ID:
        return None
    return (_MOCK_ART_PNG, "image/png")


# --- image magic-byte sniffing (shared by SMTC art + screen frames) ----------
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


# ---------------------------------------------------------------------------
# Screen preview: one downscaled JPEG frame per request via GDI BitBlt.
#
# The Windows analog of the Linux agent's gamescope/grim capture. Pure ctypes
# GDI (CreateCompatibleDC/BitBlt/GetDIBits over the virtual screen), downscaled
# with StretchBlt (HALFTONE), then encoded to JPEG. No PIL: JPEG comes from the
# built-in Windows Imaging Component (WIC) via a tiny PowerShell one-liner that
# re-encodes a stdlib-written BMP, keeping this dependency-free. Single-flight +
# a short cache cap the capture rate exactly like the Linux path.
#
# 404 semantics: capture is BLOCKED on the secure desktop (UAC / lock screen)
# and from a session-0 service; both surface as a BitBlt/GetDIBits failure, and
# real_screen_frame() returns None so the route replies 503 (transient) while
# screen_info() still advertises the backend. When capture can never work
# (non-Windows real mode) screen_info() returns None so /api/screen 404s and the
# app hides the card entirely.
#
# NEEDS ON-WINDOWS TESTING: the GDI structs + the BMP->JPEG WIC re-encode are
# written to the documented APIs but unverified on a real box.
# ---------------------------------------------------------------------------

SCREEN_WIDTH = 960                 # downscale target width
SCREEN_MAX_BYTES = 12 * 1024 * 1024
SCREEN_MIN_INTERVAL_S = 0.5        # server floor: at most ~2 captures/sec
SCREEN_CAPTURE_TIMEOUT_S = 8
SCREEN_LOCK = threading.Lock()     # single-flight: never stack captures
_SCREEN_CACHE = {"ts": 0.0, "data": None, "mime": None}
_SCREEN = None                     # capability dict or None; set by set_screen

if IS_WINDOWS:
    _gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)

    SM_XVIRTUALSCREEN = 76
    SM_YVIRTUALSCREEN = 77
    SM_CXVIRTUALSCREEN = 78
    SM_CYVIRTUALSCREEN = 79
    SRCCOPY = 0x00CC0020
    DIB_RGB_COLORS = 0
    BI_RGB = 0
    HALFTONE = 4

    class _BITMAPINFOHEADER(ctypes.Structure):
        _fields_ = [
            ("biSize", ctypes.c_uint32), ("biWidth", ctypes.c_int32),
            ("biHeight", ctypes.c_int32), ("biPlanes", ctypes.c_uint16),
            ("biBitCount", ctypes.c_uint16), ("biCompression", ctypes.c_uint32),
            ("biSizeImage", ctypes.c_uint32),
            ("biXPelsPerMeter", ctypes.c_int32),
            ("biYPelsPerMeter", ctypes.c_int32),
            ("biClrUsed", ctypes.c_uint32), ("biClrImportant", ctypes.c_uint32),
        ]

    class _BITMAPINFO(ctypes.Structure):
        _fields_ = [("bmiHeader", _BITMAPINFOHEADER),
                    ("bmiColors", ctypes.c_uint32 * 3)]


def _bmp_bytes(width, height, bgr_rows_top_down):
    """Wrap top-down 24-bit BGR scanlines (each padded to a 4-byte boundary) in
    a BITMAPFILEHEADER+BITMAPINFOHEADER so WIC can re-encode it. Negative height
    marks the DIB top-down."""
    row_stride = (width * 3 + 3) & ~3
    pixel_bytes = row_stride * height
    # BITMAPFILEHEADER (14) + BITMAPINFOHEADER (40)
    file_size = 14 + 40 + pixel_bytes
    fileheader = struct.pack("<2sIHHI", b"BM", file_size, 0, 0, 14 + 40)
    infoheader = struct.pack("<IiiHHIIiiII", 40, width, -height, 1, 24,
                             BI_RGB, pixel_bytes, 0, 0, 0, 0)
    return fileheader + infoheader + bgr_rows_top_down


def set_screen(mock):
    """Probe the capture path (call after load_config). --mock always advertises
    a stdlib PNG backend. Real Windows advertises the GDI backend unconditionally
    (whether a given frame succeeds is decided per-request); non-Windows real
    mode has no capture path."""
    global _SCREEN
    if mock:
        _SCREEN = {"session": "mock", "backends": ["mock"]}
    elif IS_WINDOWS:
        _SCREEN = {"session": "desktop", "backends": ["gdi"]}
    else:
        _SCREEN = None


def screen_info():
    """{available, session, backends, formats} or None when no capture path."""
    if _SCREEN is None:
        return None
    return {"available": True, "session": _SCREEN["session"],
            "backends": _SCREEN["backends"], "formats": ["image/jpeg"]}


def _capture_bmp():
    """Grab the whole virtual screen, downscale to SCREEN_WIDTH via StretchBlt,
    and return (bmp_bytes, w, h) or None on any failure (secure desktop, no
    session). Never raises. Pure GDI: no third-party capture lib."""
    if not IS_WINDOWS:
        return None
    src_dc = mem_dc = dst_dc = None
    src_bmp = dst_bmp = None
    try:
        _user32.GetSystemMetrics.restype = ctypes.c_int
        vx = _user32.GetSystemMetrics(SM_XVIRTUALSCREEN)
        vy = _user32.GetSystemMetrics(SM_YVIRTUALSCREEN)
        vw = _user32.GetSystemMetrics(SM_CXVIRTUALSCREEN)
        vh = _user32.GetSystemMetrics(SM_CYVIRTUALSCREEN)
        if vw <= 0 or vh <= 0:
            return None
        # Downscale target: cap width at SCREEN_WIDTH, keep aspect (never upsize).
        if vw > SCREEN_WIDTH:
            dw = SCREEN_WIDTH
            dh = max(1, int(round(vh * (SCREEN_WIDTH / float(vw)))))
        else:
            dw, dh = vw, vh

        _user32.GetDC.restype = ctypes.c_void_p
        _user32.GetDC.argtypes = [ctypes.c_void_p]
        src_dc = _user32.GetDC(None)
        if not src_dc:
            return None
        _gdi32.CreateCompatibleDC.restype = ctypes.c_void_p
        _gdi32.CreateCompatibleDC.argtypes = [ctypes.c_void_p]
        _gdi32.CreateCompatibleBitmap.restype = ctypes.c_void_p
        _gdi32.CreateCompatibleBitmap.argtypes = [ctypes.c_void_p,
                                                  ctypes.c_int, ctypes.c_int]
        mem_dc = _gdi32.CreateCompatibleDC(src_dc)
        dst_dc = _gdi32.CreateCompatibleDC(src_dc)
        if not mem_dc or not dst_dc:
            return None
        src_bmp = _gdi32.CreateCompatibleBitmap(src_dc, vw, vh)
        dst_bmp = _gdi32.CreateCompatibleBitmap(src_dc, dw, dh)
        if not src_bmp or not dst_bmp:
            return None
        _gdi32.SelectObject.restype = ctypes.c_void_p
        _gdi32.SelectObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        _gdi32.SelectObject(mem_dc, src_bmp)
        _gdi32.SelectObject(dst_dc, dst_bmp)
        _gdi32.BitBlt.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int,
                                  ctypes.c_int, ctypes.c_int, ctypes.c_void_p,
                                  ctypes.c_int, ctypes.c_int, ctypes.c_uint32]
        if not _gdi32.BitBlt(mem_dc, 0, 0, vw, vh, src_dc, vx, vy, SRCCOPY):
            return None
        _gdi32.SetStretchBltMode.argtypes = [ctypes.c_void_p, ctypes.c_int]
        _gdi32.SetStretchBltMode(dst_dc, HALFTONE)
        _gdi32.StretchBlt.argtypes = [
            ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int,
            ctypes.c_int, ctypes.c_void_p, ctypes.c_int, ctypes.c_int,
            ctypes.c_int, ctypes.c_int, ctypes.c_uint32]
        if not _gdi32.StretchBlt(dst_dc, 0, 0, dw, dh, mem_dc, 0, 0, vw, vh,
                                 SRCCOPY):
            return None
        # Pull the downscaled bitmap out as top-down 24-bit BGR.
        bmi = _BITMAPINFO()
        bmi.bmiHeader.biSize = ctypes.sizeof(_BITMAPINFOHEADER)
        bmi.bmiHeader.biWidth = dw
        bmi.bmiHeader.biHeight = -dh   # negative => top-down
        bmi.bmiHeader.biPlanes = 1
        bmi.bmiHeader.biBitCount = 24
        bmi.bmiHeader.biCompression = BI_RGB
        row_stride = (dw * 3 + 3) & ~3
        buf = ctypes.create_string_buffer(row_stride * dh)
        _gdi32.GetDIBits.argtypes = [
            ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32,
            ctypes.c_void_p, ctypes.POINTER(_BITMAPINFO), ctypes.c_uint32]
        scanned = _gdi32.GetDIBits(dst_dc, dst_bmp, 0, dh, buf,
                                   ctypes.byref(bmi), DIB_RGB_COLORS)
        if scanned == 0:
            return None
        return (_bmp_bytes(dw, dh, buf.raw), dw, dh)
    except Exception:
        return None
    finally:
        try:
            if src_bmp:
                _gdi32.DeleteObject.argtypes = [ctypes.c_void_p]
                _gdi32.DeleteObject(src_bmp)
            if dst_bmp:
                _gdi32.DeleteObject(dst_bmp)
            if mem_dc:
                _gdi32.DeleteDC.argtypes = [ctypes.c_void_p]
                _gdi32.DeleteDC(mem_dc)
            if dst_dc:
                _gdi32.DeleteDC(dst_dc)
            if src_dc:
                _user32.ReleaseDC.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
                _user32.ReleaseDC(None, src_dc)
        except Exception:
            pass


# PowerShell that re-encodes a BMP ($env:CS_BMP_IN) to a JPEG
# ($env:CS_JPG_OUT) using the built-in System.Drawing codec (WIC). Prints
# "ok"/"err". Keeps JPEG encoding dependency-free (no PIL).
_SCREEN_JPEG_PS = r"""
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Drawing
  $img = [System.Drawing.Image]::FromFile($env:CS_BMP_IN)
  try { $img.Save($env:CS_JPG_OUT, [System.Drawing.Imaging.ImageFormat]::Jpeg) }
  finally { $img.Dispose() }
  'ok'
} catch { 'err' }
"""


def _bmp_to_jpeg(bmp):
    """Re-encode BMP bytes to JPEG via the Windows System.Drawing codec. Returns
    JPEG bytes or None. Never raises."""
    bmp_path = jpg_path = None
    try:
        fd, bmp_path = tempfile.mkstemp(prefix="cs-scr-", suffix=".bmp")
        with os.fdopen(fd, "wb") as f:
            f.write(bmp)
        fd, jpg_path = tempfile.mkstemp(prefix="cs-scr-", suffix=".jpg")
        os.close(fd)
        env = dict(os.environ)
        env["CS_BMP_IN"] = bmp_path
        env["CS_JPG_OUT"] = jpg_path
        out = _run_powershell(_SCREEN_JPEG_PS, SCREEN_CAPTURE_TIMEOUT_S, env=env)
        if not out or out.strip().lower() != "ok":
            return None
        with open(jpg_path, "rb") as f:
            data = f.read(SCREEN_MAX_BYTES + 1)
        if not data or len(data) > SCREEN_MAX_BYTES:
            return None
        return data if _sniff_image(data) == "image/jpeg" else None
    except Exception:
        return None
    finally:
        for p in (bmp_path, jpg_path):
            if p:
                try:
                    os.remove(p)
                except OSError:
                    pass


def real_screen_frame():
    """One fresh JPEG frame as (data, "image/jpeg"), or None when capture is
    blocked/failing (secure desktop, session-0). Single-flight + short cache so
    concurrent clients share one capture (matches the Linux path). Never raises."""
    if _SCREEN is None:
        return None
    now = time.monotonic()
    if _SCREEN_CACHE["data"] is not None and now - _SCREEN_CACHE["ts"] < SCREEN_MIN_INTERVAL_S:
        return (_SCREEN_CACHE["data"], _SCREEN_CACHE["mime"])
    if not SCREEN_LOCK.acquire(blocking=False):
        # Another capture is in flight; serve the last frame if we have one.
        if _SCREEN_CACHE["data"] is not None:
            return (_SCREEN_CACHE["data"], _SCREEN_CACHE["mime"])
        SCREEN_LOCK.acquire()
    try:
        now = time.monotonic()
        if _SCREEN_CACHE["data"] is not None and now - _SCREEN_CACHE["ts"] < SCREEN_MIN_INTERVAL_S:
            return (_SCREEN_CACHE["data"], _SCREEN_CACHE["mime"])
        cap = _capture_bmp()
        if cap is None:
            return None
        bmp, _w, _h = cap
        data = _bmp_to_jpeg(bmp)
        if not data:
            return None
        _SCREEN_CACHE.update(ts=time.monotonic(), data=data, mime="image/jpeg")
        return (data, "image/jpeg")
    finally:
        SCREEN_LOCK.release()


_MOCK_SCREEN_N = 0


def _encode_png(w, h, rows):
    """Encode 8-bit RGBA scanlines (each `bytes` of length w*4) to PNG bytes.
    Pure zlib + struct, no PIL (mirrors the Linux agent)."""
    import zlib

    def _chunk(tag, data):
        body = tag + data
        return (struct.pack(">I", len(data)) + body
                + struct.pack(">I", zlib.crc32(body) & 0xffffffff))
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)  # RGBA, no interlace
    raw = b"".join(b"\x00" + r for r in rows)  # per-scanline filter byte 0
    return (b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", ihdr)
            + _chunk(b"IDAT", zlib.compress(raw, 6)) + _chunk(b"IEND", b""))


def mock_screen_frame():
    """--mock: a small stdlib PNG with a moving band, so the app's preview works
    off-box."""
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
# Sleep timer + scheduled wake (/api/power/schedule|sleep|wake).
#
# The Windows analog of the Linux agent's threading.Timer suspend + RTC alarm.
#   * sleep — an in-process one-shot threading.Timer firing the existing
#             suspend/poweroff action; deliberately volatile (a restart clears
#             it; the app detects that by polling). Identical to Linux.
#   * wake  — a scheduled wake set with SetWaitableTimer(fResume=TRUE) on a
#             DEDICATED daemon thread that blocks in WaitForSingleObject until
#             the timer fires (the OS then resumes the machine from sleep). This
#             mirrors the Linux RTC alarm's "survives the suspend" contract as
#             closely as a user-mode agent can: the timer object lives as long
#             as the agent process, so the wake holds across a suspend but NOT
#             across an agent restart/reboot (documented; the app polls state).
#
# A waitable timer only resumes the box if the platform allows wake timers
# (powercfg) and the agent process stays alive across the suspend — true for the
# logon-triggered task the agent runs under. NEEDS ON-WINDOWS TESTING.
# ---------------------------------------------------------------------------

SLEEP_MIN_S, SLEEP_MAX_S = 60, 8 * 3600
WAKE_MIN_S, WAKE_MAX_S = 120, 86100
SLEEP_ACTIONS = ("suspend", "poweroff")

POWER_MOCK = False          # set by set_power_schedule(mock)
SLEEP_LOCK = threading.Lock()
_SLEEP = {"timer": None, "action": None, "fire_at": 0.0}

WAKE_LOCK = threading.Lock()
# {"handle": HANDLE, "thread": Thread, "fire_at": epoch, "cancel": Event} or None
_WAKE = None
_MOCK_WAKE = {"fire_at": 0}


def set_power_schedule(mock):
    global POWER_MOCK
    POWER_MOCK = mock


def sleep_can_arm(action):
    """(ok, error). The action must be a known sleep action present in ACTIONS.
    Unlike Linux there is no sudoers gate (an interactive Windows user may
    suspend/shutdown unprivileged), so presence in ACTIONS is sufficient."""
    if action not in SLEEP_ACTIONS:
        return (False, "unknown action")
    if POWER_MOCK:
        return (True, None)
    if ACTIONS.get(action) is None:
        return (False, "%s unavailable" % action)
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


def wake_available():
    """True when a scheduled wake can be armed: --mock, or a real Windows box
    (waitable timers are always present; whether the platform actually resumes
    is a powercfg/BIOS concern the app surfaces to the user)."""
    return POWER_MOCK or IS_WINDOWS


if IS_WINDOWS:
    # SetWaitableTimer / CreateWaitableTimerW signatures.
    _kernel32.CreateWaitableTimerW.restype = ctypes.c_void_p
    _kernel32.CreateWaitableTimerW.argtypes = [ctypes.c_void_p, ctypes.c_int,
                                               ctypes.c_wchar_p]
    _kernel32.SetWaitableTimer.argtypes = [
        ctypes.c_void_p, ctypes.POINTER(ctypes.c_int64), ctypes.c_long,
        ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int]
    _kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
    _kernel32.WaitForSingleObject.restype = ctypes.c_uint32


def _wake_clear_locked():
    global _WAKE
    if _WAKE is not None:
        _WAKE["cancel"].set()
        if IS_WINDOWS and _WAKE.get("handle"):
            try:
                # CancelWaitableTimer then CloseHandle so the waiter unblocks.
                _kernel32.CancelWaitableTimer(ctypes.c_void_p(_WAKE["handle"]))
                _kernel32.CloseHandle(ctypes.c_void_p(_WAKE["handle"]))
            except Exception:
                pass
        _WAKE = None


def wake_set(at_epoch):
    """Arm a resume-from-sleep at wall-time at_epoch via SetWaitableTimer with
    fResume=TRUE, replacing any prior wake. Returns True on success. A dedicated
    daemon thread blocks on the timer so the object stays referenced until it
    fires or is cancelled."""
    global _WAKE
    if POWER_MOCK:
        with WAKE_LOCK:
            _MOCK_WAKE["fire_at"] = int(at_epoch)
        print("[wake] mock alarm at %d" % int(at_epoch), flush=True)
        return True
    if not IS_WINDOWS:
        return False
    with WAKE_LOCK:
        _wake_clear_locked()
        try:
            handle = _kernel32.CreateWaitableTimerW(None, 1, None)  # manual reset
            if not handle:
                return False
            # Negative 100ns relative time, or a positive absolute FILETIME. Use
            # an ABSOLUTE due-time so clock skew between now and fire is exact:
            # FILETIME epoch is 1601-01-01; 116444736000000000 100ns ticks to
            # the Unix epoch.
            due_ft = int((at_epoch + 11644473600) * 10000000)
            due = ctypes.c_int64(due_ft)
            # fResume=TRUE (last arg) => wake the system from sleep when it fires.
            ok = _kernel32.SetWaitableTimer(
                ctypes.c_void_p(handle), ctypes.byref(due), 0, None, None, 1)
            if not ok:
                _kernel32.CloseHandle(ctypes.c_void_p(handle))
                return False
        except Exception:
            return False

        cancel = threading.Event()

        def _waiter(h=handle, ev=cancel, fire_at=int(at_epoch)):
            # Block until the timer fires (resuming the box) or we're cancelled.
            try:
                _kernel32.WaitForSingleObject(ctypes.c_void_p(h), 0xFFFFFFFF)
            except Exception:
                pass
            if not ev.is_set():
                print("[wake] fired at %d" % fire_at, flush=True)
            with WAKE_LOCK:
                global _WAKE
                if _WAKE is not None and _WAKE.get("handle") == h:
                    try:
                        _kernel32.CloseHandle(ctypes.c_void_p(h))
                    except Exception:
                        pass
                    _WAKE = None

        t = threading.Thread(target=_waiter, daemon=True, name="wake-timer")
        _WAKE = {"handle": handle, "thread": t, "fire_at": int(at_epoch),
                 "cancel": cancel}
        t.start()
        return True


def wake_clear():
    """Cancel the scheduled wake (idempotent)."""
    if POWER_MOCK:
        with WAKE_LOCK:
            _MOCK_WAKE["fire_at"] = 0
        return True
    with WAKE_LOCK:
        _wake_clear_locked()
    return True


def wake_info():
    """Current scheduled wake as {fire_at, remaining_s} (wall time) or None."""
    if POWER_MOCK:
        fa = _MOCK_WAKE["fire_at"]
        if fa and fa > time.time():
            return {"fire_at": int(fa), "remaining_s": int(fa - time.time())}
        return None
    with WAKE_LOCK:
        if _WAKE is None:
            return None
        fa = _WAKE["fire_at"]
    if fa and fa > time.time():
        return {"fire_at": int(fa), "remaining_s": int(fa - time.time())}
    return None


def power_schedule_info():
    """The /api/power/schedule payload (matches the Linux shape)."""
    return {
        "sleep": sleep_info(),
        "wake": wake_info(),
        "wake_available": wake_available(),
        "limits": {"sleep_min_s": SLEEP_MIN_S, "sleep_max_s": SLEEP_MAX_S,
                   "wake_min_s": WAKE_MIN_S, "wake_max_s": WAKE_MAX_S},
    }


# ---------------------------------------------------------------------------
# Virtual gamepad: ViGEmBus (Xbox 360) via ViGEmClient.dll
#
# The ViGEmBus kernel driver is the Windows equivalent of uinput for pads
# (what DS4Windows/Parsec use). Games see a real wired 360 controller. The
# driver is a documented prerequisite (install.ps1 points at the official
# installer); without it the WS handshake still completes and the client gets
# an err frame, exactly like a Linux box without /dev/uinput access.
# ---------------------------------------------------------------------------

VIGEM_ERROR_NONE = 0x20000000

# protocol button key -> XUSB_REPORT wButtons bit
XUSB_BTN_BITS = {
    "du": 0x0001, "dd": 0x0002, "dl": 0x0004, "dr": 0x0008,
    "start": 0x0010, "select": 0x0020,
    "l3": 0x0040, "r3": 0x0080,
    "lb": 0x0100, "rb": 0x0200,
    "guide": 0x0400,
    "a": 0x1000, "b": 0x2000, "x": 0x4000, "y": 0x8000,
}


class _XUSB_REPORT(ctypes.Structure):
    _fields_ = [
        ("wButtons", ctypes.c_uint16),
        ("bLeftTrigger", ctypes.c_ubyte),
        ("bRightTrigger", ctypes.c_ubyte),
        ("sThumbLX", ctypes.c_int16),
        ("sThumbLY", ctypes.c_int16),
        ("sThumbRX", ctypes.c_int16),
        ("sThumbRY", ctypes.c_int16),
    ]


_VIGEM_LOCK = threading.Lock()
_VIGEM = {"dll": None, "client": None}


def _load_vigem():
    """Load ViGEmClient.dll and connect a shared client (cached on success).
    Returns (dll, client) or raises RuntimeError with a useful message.

    Failures are NOT latched: a transient one (ViGEmBus not up yet right
    after boot, DLL dropped in after first use) heals on the next gamepad
    connection, matching the Linux agent's retry-per-session uinput open.
    """
    with _VIGEM_LOCK:
        if _VIGEM["client"] is not None:
            return _VIGEM["dll"], _VIGEM["client"]
        candidates = []
        base = getattr(sys, "_MEIPASS", None)  # PyInstaller onefile extract dir
        if base:
            candidates.append(os.path.join(base, "ViGEmClient.dll"))
        candidates.append(os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "ViGEmClient.dll"))
        candidates.append("ViGEmClient.dll")  # PATH / System32
        dll = None
        for cand in candidates:
            try:
                dll = ctypes.CDLL(cand)
                break
            except OSError:
                continue
        if dll is None:
            raise RuntimeError(
                "ViGEmClient.dll not found (install ViGEmBus and place "
                "ViGEmClient.dll next to the agent)")
        try:
            dll.vigem_alloc.restype = ctypes.c_void_p
            dll.vigem_connect.restype = ctypes.c_uint32
            dll.vigem_connect.argtypes = [ctypes.c_void_p]
            dll.vigem_target_x360_alloc.restype = ctypes.c_void_p
            dll.vigem_target_add.restype = ctypes.c_uint32
            dll.vigem_target_add.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
            dll.vigem_target_x360_update.restype = ctypes.c_uint32
            dll.vigem_target_x360_update.argtypes = [
                ctypes.c_void_p, ctypes.c_void_p, _XUSB_REPORT]
            dll.vigem_target_remove.restype = ctypes.c_uint32
            dll.vigem_target_remove.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
            dll.vigem_target_free.argtypes = [ctypes.c_void_p]
            dll.vigem_disconnect.argtypes = [ctypes.c_void_p]
            dll.vigem_free.argtypes = [ctypes.c_void_p]
            client = dll.vigem_alloc()
            if not client:
                raise RuntimeError("vigem_alloc failed")
            err = dll.vigem_connect(client)
            if err != VIGEM_ERROR_NONE:
                dll.vigem_free(client)
                raise RuntimeError(
                    "vigem_connect failed (0x%08X): is the ViGEmBus driver "
                    "installed?" % err)
        except RuntimeError:
            raise
        except Exception as e:
            raise RuntimeError("ViGEmClient init failed: %s" % e)
        _VIGEM["dll"] = dll
        _VIGEM["client"] = client
        return dll, client


def _scale_stick(f):
    return max(-32768, min(32767, int(round(f * 32767))))


class ViGEmGamepad:
    """Virtual Xbox 360 pad backed by ViGEmBus. Holds the full XUSB report
    state; every protocol message mutates the state and pushes one update.

    emit() and destroy() are serialized by a per-device lock: unlike the
    Linux uinput fd (where a racing write/close worst-cases as a caught
    EBADF), the target here is a heap pointer freed by native code, and the
    replace-connection path calls destroy() from ANOTHER thread while the
    old session thread may still be inside emit(). Without the lock that is
    a native use-after-free; with it, a destroyed device just raises OSError,
    which the session loop already handles."""

    name = "ViGEm X360 pad"

    def __init__(self):
        if not IS_WINDOWS:
            raise RuntimeError("ViGEm gamepad requires Windows")
        self._lock = threading.Lock()
        self._dll, self._client = _load_vigem()
        self._report = _XUSB_REPORT()
        self._target = self._dll.vigem_target_x360_alloc()
        if not self._target:
            raise RuntimeError("vigem_target_x360_alloc failed")
        err = self._dll.vigem_target_add(self._client, self._target)
        if err != VIGEM_ERROR_NONE:
            self._dll.vigem_target_free(self._target)
            self._target = None
            raise RuntimeError("vigem_target_add failed (0x%08X)" % err)

    def emit(self, events):
        """Apply normalized pad events and push the report.
        events: [("btn", key, v) | ("trig", "lt"|"rt", 0..255) |
                 ("stick", "l"|"r", x, y)] with protocol +y = down."""
        rep = self._report
        for ev in events:
            kind = ev[0]
            if kind == "btn":
                bit = XUSB_BTN_BITS[ev[1]]
                if ev[2]:
                    rep.wButtons |= bit
                else:
                    rep.wButtons &= ~bit & 0xFFFF
            elif kind == "trig":
                if ev[1] == "lt":
                    rep.bLeftTrigger = ev[2]
                else:
                    rep.bRightTrigger = ev[2]
            elif kind == "stick":
                x = _scale_stick(ev[2])
                y = max(-32768, min(32767, -_scale_stick(ev[3])))  # +y up
                if ev[1] == "l":
                    rep.sThumbLX, rep.sThumbLY = x, y
                else:
                    rep.sThumbRX, rep.sThumbRY = x, y
        with self._lock:
            if self._target is None:
                raise OSError("gamepad device destroyed")
            err = self._dll.vigem_target_x360_update(
                self._client, self._target, rep)
        if err != VIGEM_ERROR_NONE:
            raise OSError("vigem update failed (0x%08X)" % err)

    def destroy(self):
        with self._lock:  # idempotent + safe against concurrent emit/destroy
            target, self._target = self._target, None
        if target:
            try:
                self._dll.vigem_target_remove(self._client, target)
            except Exception:
                pass
            try:
                self._dll.vigem_target_free(target)
            except Exception:
                pass


class WinMouse:
    """Virtual mouse via SendInput (no driver needed)."""

    name = "SendInput mouse"

    _BTN_FLAGS = {
        "l": (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        "r": (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        "m": (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
    }

    def __init__(self):
        if not IS_WINDOWS:
            raise RuntimeError("SendInput mouse requires Windows")

    def emit(self, events):
        inputs = []
        for ev in events:
            kind = ev[0]
            if kind == "move":
                inputs.append(_mouse_input(dx=ev[1], dy=ev[2],
                                           flags=MOUSEEVENTF_MOVE))
            elif kind == "btn":
                down_flag, up_flag = self._BTN_FLAGS[ev[1]]
                inputs.append(_mouse_input(
                    flags=down_flag if ev[2] else up_flag))
            elif kind == "wheel":
                # Protocol dy>0 = scroll up; Windows wheel delta >0 = up too.
                inputs.append(_mouse_input(
                    data=ctypes.c_uint32(ev[1] * WHEEL_DELTA & 0xFFFFFFFF).value,
                    flags=MOUSEEVENTF_WHEEL))
        _send_inputs(inputs)

    def destroy(self):
        pass  # nothing persistent to tear down


class WinKeyboard:
    """Virtual keyboard via SendInput. Text goes through KEYEVENTF_UNICODE,
    which is layout-independent: AltGr characters on non-US layouts, or any
    script, inject without VkKeyScanW's failure modes (an unsupported char
    can never kill the WS session). Special keys use real VK codes (with the
    extended-key flag where needed) so games and the shell see them."""

    name = "SendInput keyboard"

    def __init__(self):
        if not IS_WINDOWS:
            raise RuntimeError("SendInput keyboard requires Windows")

    def emit(self, events):
        inputs = []
        for ev in events:
            kind = ev[0]
            if kind == "text":
                for ch in ev[1]:
                    if ch in ("\n", "\r"):
                        # A real Enter keystroke, not a unicode CR: apps
                        # expect the key, exactly like the Linux agent.
                        inputs.append(_key_input(VK_RETURN, True))
                        inputs.append(_key_input(VK_RETURN, False))
                    elif ch == "\t":
                        inputs.append(_key_input(VK_TAB, True))
                        inputs.append(_key_input(VK_TAB, False))
                    else:
                        inputs.extend(_unicode_key_inputs(ch))
            elif kind == "key":
                vk = SPECIAL_KEYS[ev[1]]
                inputs.append(_key_input(vk, True))
                inputs.append(_key_input(vk, False))
        _send_inputs(inputs)

    def destroy(self):
        pass


class MockGamepad:
    """--mock stand-in: logs decoded events instead of touching ViGEm."""

    name = "mock"

    def emit(self, events):
        for ev in events:
            print("[gamepad] %s" % (ev,), flush=True)

    def destroy(self):
        print("[gamepad] mock destroyed", flush=True)


class MockMouse:
    name = "mock-mouse"

    def emit(self, events):
        for ev in events:
            print("[mouse] %s" % (ev,), flush=True)

    def destroy(self):
        print("[mouse] mock destroyed", flush=True)


class MockKeyboard:
    name = "mock-keyboard"

    def emit(self, events):
        for ev in events:
            print("[keyboard] %s" % (ev,), flush=True)

    def destroy(self):
        print("[keyboard] mock destroyed", flush=True)


# ---------------------------------------------------------------------------
# Protocol decoding: one client JSON message -> normalized event list. Same
# message shapes and validation errors as the Linux agent; only the backend
# consuming the normalized events differs.
# ---------------------------------------------------------------------------


def gamepad_events(msg):
    """Decode one gamepad message. Raises ValueError for malformed/unknown
    messages ("ping" is handled by the caller, not here)."""
    t = msg.get("t")
    if t == "b":
        k = msg.get("k")
        v = msg.get("v")
        if v not in (0, 1):
            raise ValueError("button v must be 0 or 1")
        if k in XUSB_BTN_BITS:
            return [("btn", k, v)]
        raise ValueError("unknown button %r" % (k,))
    if t == "t":
        k = msg.get("k")
        v = msg.get("v")
        if k not in ("lt", "rt"):
            raise ValueError("unknown trigger %r" % (k,))
        if not isinstance(v, (int, float)) or isinstance(v, bool):
            raise ValueError("trigger v must be a number")
        return [("trig", k, max(0, min(255, int(v))))]
    if t == "s":
        k = msg.get("k")
        x = msg.get("x")
        y = msg.get("y")
        if k not in ("l", "r"):
            raise ValueError("unknown stick %r" % (k,))
        if (not isinstance(x, (int, float)) or isinstance(x, bool) or
                not isinstance(y, (int, float)) or isinstance(y, bool)):
            raise ValueError("stick x/y must be numbers")
        return [("stick", k, x, y)]
    raise ValueError("unknown message type %r" % (t,))


def _require_int(msg, key):
    v = msg.get(key)
    if not isinstance(v, int) or isinstance(v, bool):
        raise ValueError("%s must be an integer" % key)
    return v


MOUSE_BTN_KEYS = ("l", "r", "m")


def mouse_events(msg):
    """Decode one mouse message ({"t":"m"|"mb"|"mw"}). Raises ValueError."""
    t = msg.get("t")
    if t == "m":
        dx = _require_int(msg, "dx")
        dy = _require_int(msg, "dy")
        return [("move", dx, dy)]
    if t == "mb":
        k = msg.get("k")
        v = msg.get("v")
        if k not in MOUSE_BTN_KEYS:
            raise ValueError("unknown mouse button %r" % (k,))
        if v not in (0, 1):
            raise ValueError("mouse button v must be 0 or 1")
        return [("btn", k, v)]
    if t == "mw":
        dy = _require_int(msg, "dy")
        return [("wheel", dy)]
    raise ValueError("unknown mouse message type %r" % (t,))


def keyboard_events(msg):
    """Decode one keyboard message ({"t":"kt","text":...} or
    {"t":"k","key":...}). Text characters inject as KEYEVENTF_UNICODE in the
    device, so any character is deliverable; only unknown special-key names
    are rejected here."""
    t = msg.get("t")
    if t == "kt":
        text = msg.get("text")
        if not isinstance(text, str):
            raise ValueError("kt text must be a string")
        return [("text", text)]
    if t == "k":
        key = msg.get("key")
        if key not in SPECIAL_KEYS:
            raise ValueError("unknown special key %r" % (key,))
        return [("key", key)]
    raise ValueError("unknown keyboard message type %r" % (t,))


# ---------------------------------------------------------------------------
# Minimal RFC6455 WebSocket support (server side, no fragmentation)
# ---------------------------------------------------------------------------

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
WS_OP_TEXT, WS_OP_CLOSE, WS_OP_PING, WS_OP_PONG = 0x1, 0x8, 0x9, 0xA
WS_MAX_FRAME = 1 << 20


def ws_try_parse(buf):
    """Try to parse one complete frame from the front of buf (bytearray).
    Returns (opcode, payload) and consumes the bytes, or None if more data is
    needed. Raises ValueError on protocol violations."""
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
    Returns None if the socket is dead. Raises ValueError on violations."""
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
# one (old virtual pad destroyed first, then its socket closed).
GAMEPAD_LOCK = threading.Lock()
GAMEPAD_ACTIVE = None


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
# as a QR so the box's own TV can show it.
#
# SECURITY: /pair exposes the pairing token in the clear, so it is gated to
# loopback clients only (see Handler.do_GET). It is NOT under /api and is NOT
# bearer-authed: the loopback check IS the entire security model.
#
# Unlike the Linux agent (which inlines a JS QR encoder), the matrix is
# rendered SERVER-SIDE from the qr.py module that ships alongside this file;
# the page only paints the precomputed modules to a canvas. Same offline
# guarantee, no duplicated encoder.
# ---------------------------------------------------------------------------


def _pair_hostname():
    """Short hostname + .local for the pairing deep link (Windows 10+ answers
    mDNS for <hostname>.local out of the box)."""
    host = socket.gethostname().split(".")[0] or "localhost"
    return host + ".local"


def _pair_lan_ip():
    """Best-effort primary LAN IP for the pairing deep link's &ip= fallback.
    UDP connect() picks the interface the default route would use without
    sending a single packet."""
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
    """The Couchside pairing link (same format as the Linux agent: params ride
    the URL #FRAGMENT so browsers never send the token to any server)."""
    from urllib.parse import quote
    url = "https://couchside.tv/pair#host=%s&port=%d&token=%s" % (
        quote(_pair_hostname(), safe=""), port, quote(token, safe=""))
    ip = _pair_lan_ip()
    if ip:
        url += "&ip=" + quote(ip, safe="")
    return url


def render_pair_page(token, port):
    """Self-contained dark HTML page painting the server-rendered QR matrix.
    No external resources: works on a box with no internet."""
    pair_url = build_pair_url(token, port)
    url_html = (pair_url.replace("&", "&amp;").replace("<", "&lt;")
                        .replace(">", "&gt;"))
    if qrmod is None:
        matrix_js, err_js = "null", json.dumps("QR module missing (qr.py)")
    else:
        try:
            model = qrmod.build_qr(pair_url)
            n = model.get_module_count()
            rows = ["".join("1" if model.is_dark(r, c) else "0"
                            for c in range(n)) for r in range(n)]
            matrix_js, err_js = json.dumps(rows), "null"
        except Exception as e:
            matrix_js, err_js = "null", json.dumps("QR encode failed: %s" % e)
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
        "word-break:break-all;max-width:80ch;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}"
        ".err{color:#ff6b6b;margin-top:3vmin;font-size:min(3vmin,18px);}"
        "</style></head><body>"
        "<h1>Scan to pair Couchside</h1>"
        "<div class=\"sub\">Point your phone&rsquo;s <b>camera</b> at this code "
        "&mdash; it opens the Couchside app and pairs your box automatically. "
        "The app itself has no scanner; use the camera.</div>"
        "<div class=\"card\"><canvas id=\"qr\" width=\"560\" height=\"560\"></canvas></div>"
        "<div class=\"url\">" + url_html + "</div>"
        "<div id=\"err\" class=\"err\"></div>"
        "<script>\n"
        "(function(){\n"
        "  var rows = " + matrix_js + ";\n"
        "  var err = " + err_js + ";\n"
        "  if (err || !rows) {\n"
        "    document.getElementById('err').textContent = err || 'no QR data';\n"
        "    return;\n"
        "  }\n"
        "  var n = rows.length, quiet = 4, total = n + quiet*2;\n"
        "  var canvas = document.getElementById('qr');\n"
        "  var px = Math.max(4, Math.floor(560/total));\n"
        "  var size = total*px; canvas.width = size; canvas.height = size;\n"
        "  var ctx = canvas.getContext('2d');\n"
        "  ctx.fillStyle = '#ffffff'; ctx.fillRect(0,0,size,size);\n"
        "  ctx.fillStyle = '#000000';\n"
        "  for (var r=0;r<n;r++){ for (var c=0;c<n;c++){ if (rows[r].charAt(c)==='1') {\n"
        "    ctx.fillRect((c+quiet)*px,(r+quiet)*px,px,px); } } }\n"
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
        """True iff the connecting client is on the loopback interface. Half
        the security model for /pair; the peer IP cannot be spoofed by a
        request header. The other half is _host_header_is_local."""
        host = self.client_address[0]
        if host == "::1":
            return True
        if host.startswith("::ffff:"):
            host = host[len("::ffff:"):]
        return host == "localhost" or host.startswith("127.")

    def _host_header_is_local(self):
        """True iff the request's Host header names loopback (anti-DNS-
        rebinding gate for /pair)."""
        host = (self.headers.get("Host") or "").strip().lower()
        if host.startswith("["):
            host = host[1:].split("]", 1)[0]
        elif host.count(":") == 1:
            host = host.rsplit(":", 1)[0]
        return host in ("localhost", "::1") or host.startswith("127.")

    def _current_token(self):
        """The token to advertise on /pair: fresh from the token file if we
        can read it, else the token loaded at startup."""
        if self.token_file:
            try:
                with open(self.token_file, encoding="utf-8-sig") as f:
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
    # scroll real diagnostics out of the journal's window. Errors and the first
    # hit of a burst still log.
    _SAMPLED_PATHS = ("/api/screen/frame",)
    _sample_last = {}  # path -> monotonic time of last logged success
    _SAMPLE_EVERY_S = 15

    def _log(self, code, started):
        dur_ms = int((time.monotonic() - started) * 1000)
        # Never log query strings: /ws/gamepad carries ?token=<secret>.
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

    def _send_bytes(self, code, data, content_type, started,
                    cache_control=None, extra_headers=None):
        """Write a raw binary body (album art, screen frames) with an EXACT
        Content-Length (keep-alive safety under HTTP/1.1) and the same CORS
        headers as _send."""
        self.send_response(code)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers",
                         "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods",
                         "GET, POST, DELETE, OPTIONS")
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
                # LOCALHOST-ONLY: two gates, both required (see the Linux
                # agent's security notes).
                if not self._is_loopback() or not self._host_header_is_local():
                    self._send(403, {"error": "forbidden"}, started)
                    return
                html = render_pair_page(self._current_token(), self.port)
                self._send_html(200, html, started)
                return

            if path == "/api/ping":
                # "ip" is the LAN address the client actually reached us on;
                # the app caches it per box as an mDNS fallback. "host" lets
                # the app verify a cached IP still points at THIS box.
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
                # 404 -> the app hides the section (probe-and-appear).
                downloads = mock_downloads() if self.mock else steam_downloads()
                self._send(200, {"downloads": downloads}, started)
            elif path == "/api/tv":
                info = tv_info()
                if info is None:
                    self._send(404, {"error": "not found"}, started)
                else:
                    self._send(200, info, started)
            elif path == "/api/media":
                # Probe-and-appear: 404 when SMTC is unavailable so the app
                # hides the Now Playing card; 200 with an empty list when idle.
                info = mock_smtc_info() if self.mock else smtc_info()
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
                    art = (mock_smtc_art(player, key) if self.mock
                           else smtc_art(player, key))
                if art is None:
                    self._send(404, {"error": "not found"}, started)
                else:
                    data, mime = art
                    self._send_bytes(200, data, mime, started,
                                     cache_control="private, max-age=3600")
            elif path == "/api/screen":
                # Probe-and-appear: 404 when no capture path so the app hides the
                # preview card; a body describes the session + backends.
                info = ({"available": True, "session": "mock",
                         "backends": ["mock"], "formats": ["image/png"]}
                        if self.mock else screen_info())
                if info is None:
                    self._send(404, {"error": "not found"}, started)
                else:
                    self._send(200, info, started)
            elif path == "/api/screen/frame":
                # One fresh frame. Single-flight + short cache cap captures
                # server-side; no-store so frames (may show passwords) are never
                # cached. High-frequency, so _log samples it.
                frame = mock_screen_frame() if self.mock else real_screen_frame()
                if frame is None:
                    self._send(503, {"error": "capture failed"}, started)
                else:
                    data, mime = frame
                    self._send_bytes(200, data, mime, started,
                                     cache_control="no-store")
            elif path == "/api/power/schedule":
                # Always 200: reports the (volatile) sleep timer + the scheduled
                # wake. Old agents 404 -> the app hides the rows.
                self._send(200, power_schedule_info(), started)
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
        """Read and return the request body bytes (always drains it, so
        keep-alive connections never desync)."""
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n <= 0:
            return b""
        return self.rfile.read(n)

    def do_POST(self):
        started = time.monotonic()
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

            if path == "/api/launchers":
                self._handle_add_launcher(body, started)
                return

            lprefix = "/api/launchers/"
            if path.startswith(lprefix):
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
            # "box"|"tv"}. Box converges on the Core Audio endpoint scalar; the
            # Windows panel has no absolute-set/read frame, so target "tv" 404s
            # (no backend). Checked before the generic /api/tv/<op> route.
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
                    # No Windows TV backend can set an absolute level.
                    self._send(404, {"error": "no tv volume backend"}, started)
                    return
                if not soft_available():
                    self._send(404, {"error": "no box volume backend"}, started)
                    return
                result = ({"ok": True, "exit_code": 0, "level": lvl,
                           "stdout": "[mock] box volume %d" % lvl,
                           "stderr": "", "duration_ms": 100}
                          if self.mock else soft_set_volume(lvl))
                self._send(200, result, started)
                return

            # POST /api/media/<player>/<op>: SMTC transport. Checked before the
            # generic /api/tv/ route (both live under /api/, distinct prefixes).
            mprefix = "/api/media/"
            if path.startswith(mprefix):
                rest = path[len(mprefix):]
                parts = rest.rsplit("/", 1)
                if len(parts) != 2 or not parts[0] or not parts[1]:
                    self._send(404, {"error": "not found"}, started)
                    return
                player, op = unquote(parts[0]), parts[1]
                if op not in SMTC_OPS:
                    self._send(404, {"error": "unknown media op"}, started)
                    return
                result = (mock_smtc_op(player, op) if self.mock
                          else real_smtc_op(player, op))
                if result is None:
                    self._send(404, {"error": "unknown player"}, started)
                    return
                self._send(200, result, started)
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
                    self._send(400,
                               {"error": "delay_s (int) and action required"},
                               started)
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

            # POST /api/power/wake: set a scheduled wake to an absolute time.
            if path == "/api/power/wake":
                if not wake_available():
                    self._send(409, {"error": "no wake backend"}, started)
                    return
                try:
                    req = json.loads(body.decode("utf-8")) if body else {}
                    at = int(req.get("at"))
                except (ValueError, TypeError, UnicodeDecodeError):
                    self._send(400, {"error": "at (epoch seconds) required"},
                               started)
                    return
                now = time.time()
                if not now + WAKE_MIN_S <= at <= now + WAKE_MAX_S:
                    self._send(400, {"error": "at must be %d-%ds out"
                                     % (WAKE_MIN_S, WAKE_MAX_S)}, started)
                    return
                if not wake_set(at):
                    # 503 not 500: the platform/driver refusing the wake timer is
                    # a transient/unsupported-backend condition, not an agent bug
                    # (matches the capture-failed convention elsewhere).
                    self._send(503, {"error": "wake set failed"}, started)
                    return
                self._send(200, {"wake": wake_info()}, started)
                return

            tprefix = "/api/tv/"
            if path.startswith(tprefix):
                op = path[len(tprefix):]
                if op not in TV_OPS:
                    self._send(404, {"error": "unknown tv op"}, started)
                    return
                target = parse_qs(parsed.query).get("target", [None])[0]
                result = tv_send(op, self.mock, target)
                if result is None:
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

            # DELETE /api/power/sleep: cancel the armed sleep timer (idempotent).
            if path == "/api/power/sleep":
                sleep_cancel()
                self._send(200, {"sleep": None}, started)
                return
            # DELETE /api/power/wake: clear the scheduled wake (idempotent).
            if path == "/api/power/wake":
                wake_clear()
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
                device = MockGamepad() if self.mock else ViGEmGamepad()
            except Exception as e:
                print("[gamepad] device create failed: %s" % e, flush=True)
                try:
                    ws_send_json(conn, {"t": "err",
                                        "msg": "gamepad unavailable: %s" % e})
                    ws_send(conn, WS_OP_CLOSE)
                except OSError:
                    pass
                return
            entry["device"] = device
            print("[gamepad] connected (%s)" % device.name, flush=True)
            # Windows types arbitrary unicode directly via KEYEVENTF_UNICODE,
            # so it always advertises full-text capability (no paste needed).
            ws_send_json(conn, {"t": "hello", "dev": device.name,
                                "text": "unicode"})

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
                # a replacer may have torn us down mid-create and seen
                # device=None, which would leak a freshly created virtual pad
                # until process exit.
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

    # Message-type prefixes routed to the mouse / keyboard virtual devices.
    _MOUSE_TYPES = frozenset(("m", "mb", "mw"))
    _KEYBOARD_TYPES = frozenset(("kt", "k"))

    def _gamepad_message(self, conn, entry, device, payload):
        """Handle one text frame. Returns False when the session must end."""
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
            factory = MockMouse if self.mock else WinMouse
        elif t in self._KEYBOARD_TYPES:
            decode, slot = keyboard_events, "keyboard"
            factory = MockKeyboard if self.mock else WinKeyboard
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
            entry["input_err_count"] = 0
            if entry.get("input_blocked"):  # was blocked, now working again
                entry["input_blocked"] = False
                try:
                    ws_send_json(conn, {"t": "resumed"})
                except OSError:
                    pass
        except (OSError, ValueError) as e:
            # An input-injection failure is NOT fatal to the session. SendInput
            # is refused whenever the box is on the lock/secure desktop, the
            # agent is not in the ACTIVE interactive session (session-0, a
            # disconnected RDP session), or an elevated window is focused
            # (UIPI) — all transient conditions. Tearing the socket down here
            # turned every such moment into "the trackpad stopped working" plus
            # a reconnect storm (one failed move killed the whole pad/mouse/
            # keyboard session). Instead: swallow it, log rate-limited, keep the
            # connection alive, and tell the app so it can show a hint.
            self._note_input_error(conn, entry, slot or "gamepad", e)
        return True

    def _note_input_error(self, conn, entry, kind, exc):
        """Non-fatal input-injection failure (see _gamepad_message). Keeps the
        session, logs rate-limited (first failure then <=once/5s so a stuck
        session can't flood the log /api/journal serves back), and tells the
        app ONCE on the transition into the blocked state so the Pad tab can
        surface a 'input paused — unlock the box' hint."""
        now = time.monotonic()
        n = entry.get("input_err_count", 0) + 1
        entry["input_err_count"] = n
        if not entry.get("input_blocked"):
            entry["input_blocked"] = True
            try:
                ws_send_json(conn, {"t": "blocked",
                    "msg": "Input paused — unlock the box or bring it to front."})
            except OSError:
                pass
        last = entry.get("input_err_logged_at", 0.0)
        if n == 1 or now - last > 5.0:
            entry["input_err_logged_at"] = now
            print("[gamepad] %s input blocked (%s) — connection kept alive; "
                  "resumes when the box's desktop is active and unlocked [x%d]"
                  % (kind, exc, n), flush=True)


def load_token(args):
    if args.token:
        return args.token
    try:
        with open(args.token_file, encoding="utf-8-sig") as f:
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


class QuietThreadingHTTPServer(ThreadingHTTPServer):
    """ThreadingHTTPServer that doesn't dump a traceback when a client drops
    the connection. The app (and any LAN poller) freely abandons keep-alive
    sockets between requests, and on Windows that abrupt close surfaces as
    ConnectionReset/Aborted inside readline BEFORE the request handler runs —
    too early for do_GET's try/except to catch. Left alone, socketserver's
    default handle_error prints a full traceback per drop, which both spams
    the console and pollutes the agent's own log that /api/journal serves
    back. These disconnects are benign, so swallow exactly them and defer to
    the default for anything genuinely unexpected."""

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, ConnectionAbortedError,
                            BrokenPipeError, TimeoutError)):
            return
        super().handle_error(request, client_address)


def main():
    p = argparse.ArgumentParser(description="Couchside box agent (Windows)")
    p.add_argument("--port", type=int, default=None,
                   help="listen port (overrides config; default %d)" % DEFAULT_PORT)
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--config", default=DEFAULT_CONFIG_PATH,
                   help="path to config.json (default %s)" % DEFAULT_CONFIG_PATH)
    p.add_argument("--token-file", default=DEFAULT_TOKEN_PATH)
    p.add_argument("--token", default=None,
                   help="literal token (overrides --token-file; dev only)")
    p.add_argument("--mock", action="store_true",
                   help="serve fake data, never run real commands")
    args = p.parse_args()

    if not IS_WINDOWS and not args.mock:
        print("error: real mode requires Windows; use --mock for development",
              file=sys.stderr)
        sys.exit(1)

    load_config(args.config)
    _inject_steam_action(args.mock)
    set_tv(args.mock)
    set_screen(args.mock)
    set_power_schedule(args.mock)
    if IS_WINDOWS and not args.mock:
        start_load_sampler()
    port = args.port if args.port is not None else (CONFIG_PORT or DEFAULT_PORT)

    Handler.token = load_token(args)
    # Remembered so GET /pair can re-read the current token (unless a literal
    # --token was supplied, in which case there is no file to re-read).
    Handler.token_file = None if args.token else args.token_file
    Handler.port = port
    Handler.mock = args.mock

    server = QuietThreadingHTTPServer((args.host, port), Handler)
    server.daemon_threads = True
    mode = "mock" if args.mock else "real"
    print("%s %s listening on %s:%d (%s mode)" % (
        APP_NAME, VERSION, args.host, port, mode), flush=True)
    info = tv_info()
    print("tv: %s" % ("%s (%s)" % (info["backend"], info["adapter"])
                      if info else "unavailable"), flush=True)
    print("pair: http://localhost:%d/pair" % port, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
