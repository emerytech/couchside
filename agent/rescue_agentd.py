#!/usr/bin/env python3
"""rescue_agentd.py — box-side agent for Rescue Remote.

Pure python3 stdlib. Serves the Rescue Agent API contract v1 on port 8787.
Runs on Bazzite (Fedora Atomic) as a systemd service; also runs on macOS
in --mock mode for phone-app development.
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
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

try:
    import fcntl  # POSIX only; uinput needs it (Linux), absent on Windows
except ImportError:  # pragma: no cover
    fcntl = None

APP_NAME = "rescue-agent"
VERSION = "1.1.0"
UID = 1000
XDG_RUNTIME_DIR = "/run/user/%d" % UID

# ---------------------------------------------------------------------------
# Watchlist / allowlists (contract constants)
# ---------------------------------------------------------------------------

WATCHLIST = [
    # (name, scope)
    ("sddm.service", "system"),
    ("htpc-nosleep.service", "system"),
    ("greenboot-healthcheck.service", "system"),
    ("rescue-agent.service", "system"),
    ("skyscrape.service", "user"),
]
WATCHLIST_NAMES = {name for name, _scope in WATCHLIST}

ACTIONS = {
    "restart-sddm": {
        "label": "Restart Session",
        "description": "Restart display session — fixes wedged gamescope (black screen)",
        "danger": "high",
        "cmd": ["sudo", "systemctl", "restart", "sddm"],
        "user_env": False,
        "detached": False,
    },
    "restart-kodi": {
        "label": "Stop Kodi",
        "description": "Stop Kodi — relaunch from the Steam tile",
        "danger": "medium",
        "cmd": ["flatpak", "kill", "tv.kodi.Kodi"],
        "user_env": True,
        "detached": False,
    },
    "restart-skyscrape": {
        "label": "Restart Skyscrape",
        "description": "Restart the box-art scraper service",
        "danger": "low",
        "cmd": ["systemctl", "--user", "restart", "skyscrape.service"],
        "user_env": True,
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

# Order for /api/actions listing
ACTION_ORDER = ["restart-sddm", "restart-kodi", "restart-skyscrape", "reboot", "poweroff"]

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
        "hostname": "bazzite",
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
    "htpc-nosleep.service": "Inhibit sleep for HTPC duty",
    "greenboot-healthcheck.service": "greenboot Health Checks Runner",
    "rescue-agent.service": "Rescue Remote box agent",
    "skyscrape.service": "Box-art scraper for RetroArch library",
}


def mock_units():
    units = []
    for name, scope in WATCHLIST:
        if name == "skyscrape.service":
            active, sub = "inactive", "dead"
        else:
            active, sub = "active", "running"
        units.append({
            "name": name,
            "scope": scope,
            "active": active,
            "sub": sub,
            "description": MOCK_UNIT_DESCS.get(name, name),
        })
    return units


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
        "Session started for user bazzite",
        "Authentication for user \"bazzite\" successful",
        "Auth: sddm-helper exited successfully",
        "Greeter stopped",
    ],
    "htpc-nosleep.service": [
        "Started Inhibit sleep for HTPC duty.",
        "systemd-inhibit: taking idle+sleep lock",
        "Inhibitor lock active (what=sleep:idle, who=htpc-nosleep)",
        "Watchdog ping ok",
        "Lock refreshed",
    ],
    "greenboot-healthcheck.service": [
        "Starting greenboot Health Checks Runner...",
        "Running Required Health Check Scripts...",
        "Script '01_repository_dns_check.sh' SUCCESS",
        "Script '02_watchdog.sh' SUCCESS",
        "Running Wanted Health Check Scripts...",
        "Boot Status is GREEN - Health Check SUCCESS",
        "Finished greenboot Health Checks Runner.",
    ],
    "rescue-agent.service": [
        "Started Rescue Remote box agent.",
        "rescue-agent 1.1.0 listening on 0.0.0.0:8787",
        "GET /api/ping 200 0ms",
        "GET /api/status 200 4ms",
        "GET /api/units 200 61ms",
        "GET /api/journal?unit=sddm.service 200 88ms",
        "POST /api/actions/restart-skyscrape 200 412ms",
    ],
    "skyscrape.service": [
        "Started Box-art scraper for RetroArch library.",
        "skyscrape: scanning /home/bazzite/ROMs (37 systems)",
        "skyscrape: 4100 entries indexed",
        "skyscrape: fetching artwork batch 12/40",
        "skyscrape: rate limited by upstream, backing off 30s",
        "skyscrape: wrote 118 thumbnails",
        "skyscrape: run complete in 214s",
        "skyscrape.service: Deactivated successfully.",
    ],
}


def mock_journal(unit, scope, lines):
    templates = MOCK_LOG_TEMPLATES.get(unit, ["(no logs)"])
    out = []
    n = min(lines, 30)
    t = time.time() - n * 47
    host = "bazzite"
    src = unit.replace(".service", "")
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
# Virtual gamepad — evdev/uinput constants and pure-stdlib uinput driver
# ---------------------------------------------------------------------------

EV_SYN = 0x00
EV_KEY = 0x01
EV_ABS = 0x03
SYN_REPORT = 0

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


def _event_name(etype, code):
    if etype == EV_KEY:
        return KEY_NAMES.get(code, "KEY_%d" % code)
    if etype == EV_ABS:
        return ABS_NAMES.get(code, "ABS_%d" % code)
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
    device = entry.get("device")
    if device is not None:
        try:
            device.destroy()
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
    server_version = "rescue-agent/" + VERSION
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
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
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
            else:
                self._send(404, {"error": "not found"}, started)
        except BrokenPipeError:
            pass
        except Exception as e:
            try:
                self._send(500, {"error": e.__class__.__name__}, started)
            except Exception:
                pass

    def do_POST(self):
        started = time.monotonic()
        # Drain any request body so an HTTP/1.1 keep-alive connection doesn't
        # desync (leftover body bytes would be parsed as the next request line).
        try:
            _body_len = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            _body_len = 0
        if _body_len:
            self.rfile.read(_body_len)
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

            self._send(404, {"error": "not found"}, started)
        except BrokenPipeError:
            pass
        except Exception as e:
            try:
                self._send(500, {"error": e.__class__.__name__}, started)
            except Exception:
                pass

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
        entry = {"conn": conn, "device": None}

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
                    if not self._gamepad_message(conn, device, payload):
                        return
                except OSError:
                    return
        finally:
            with GAMEPAD_LOCK:
                mine = GAMEPAD_ACTIVE is entry
                if mine:
                    GAMEPAD_ACTIVE = None
                # Always destroy OUR device (destroy() is idempotent): if a
                # replacer tore us down while our device was still being
                # created, it saw device=None and only closed the socket —
                # without this, that freshly created uinput device (and fd)
                # would leak as a phantom pad until service restart.
                device = entry.get("device")
            if device is not None:
                try:
                    device.destroy()
                except Exception:
                    pass
            if mine:
                print("[gamepad] disconnected", flush=True)
            # socket itself is closed by the http.server machinery
            # (close_connection is set), or already closed by a replacer.

    def _gamepad_message(self, conn, device, payload):
        """Handle one text frame. Returns False when the session must end."""
        try:
            msg = json.loads(payload.decode("utf-8"))
            if not isinstance(msg, dict):
                raise ValueError("message must be a JSON object")
        except (ValueError, UnicodeDecodeError):
            ws_send_json(conn, {"t": "err", "msg": "invalid JSON message"})
            ws_send(conn, WS_OP_CLOSE)
            return False
        if msg.get("t") == "ping":
            ws_send_json(conn, {"t": "pong"})
            return True
        try:
            events = gamepad_events(msg)
        except ValueError as e:
            ws_send_json(conn, {"t": "err", "msg": str(e)})
            ws_send(conn, WS_OP_CLOSE)
            return False
        try:
            device.emit(events)
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
    p = argparse.ArgumentParser(description="Rescue Remote box agent")
    p.add_argument("--port", type=int, default=8787)
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--token-file", default="/etc/rescue-agent/token")
    p.add_argument("--token", default=None,
                   help="literal token (overrides --token-file; dev only)")
    p.add_argument("--mock", action="store_true",
                   help="serve fake data, never run real commands")
    args = p.parse_args()

    Handler.token = load_token(args)
    Handler.mock = args.mock

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    mode = "mock" if args.mock else "real"
    print("%s %s listening on %s:%d (%s mode)" % (
        APP_NAME, VERSION, args.host, args.port, mode), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
