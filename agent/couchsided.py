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
import re
import select
import shutil
import socket
import ssl
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time
import urllib.error
import urllib.request
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, quote, unquote

try:
    import fcntl  # POSIX only; uinput needs it (Linux), absent on Windows
except ImportError:  # pragma: no cover
    fcntl = None

APP_NAME = "couchside-agent"
VERSION = "2.9.34"
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
#   ],
#   "guide": {                                      # optional; guide-hold trigger
#     "enabled": false,                             # default false (opt-in)
#     "hold_ms": 1200,                              # 600..5000, default 1200
#     "uniq": ""                                    # optional; pin to ONE pad (MAC)
#   }
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

# Decky Loader's plugin_loader.service dies whenever Steam's CEF context goes
# away (a Steam restart, a session switch) and exits CLEANLY, so systemd never
# auto-restarts it — the Decky panel just silently vanishes from the Quick
# Access Menu until the next reboot. Observed in the field within hours of it
# mattering. This action lets the phone fix it. Injected only when the unit
# exists AND the sudoers grant is present (see _inject_decky_action).
DECKY_RESTART_ACTION = {
    "label": "Restart Decky",
    "description": "Restart Decky Loader when its menu has vanished from Quick Access",
    "danger": "low",
    "cmd": ["sudo", "systemctl", "restart", "plugin_loader"],
    "user_env": False,
    "detached": False,
}

# Pairing a controller is the one job you cannot do WITH a controller, and
# Steam buries the Bluetooth page several clicks into Settings — which is a real
# problem on a couch with no keyboard. steam:// deep-links straight to it.
#
# VERIFIED ON HARDWARE via a screen capture of the box: firing
# steam://open/settings/bluetooth in Game Mode lands directly on the Bluetooth
# panel, sidebar highlighted, scan already running. Worth recording HOW that was
# established, because the obvious check lies: this URL is NOT a string literal
# anywhere in Steam's JS bundle (the handler builds the route from the panel
# name), so grepping the bundle finds nothing and proves nothing. An earlier
# pass grepped, found no match, and wrongly concluded no Bluetooth deep link
# existed. Test the URL, don't grep for it.
BLUETOOTH_PAIRING_ACTION = {
    "label": "Pair a controller",
    "description": "Open Steam's Bluetooth pairing screen on the TV",
    # Navigates the TV away from whatever is on it — the app renders medium as
    # "CHANGES WHAT'S ON SCREEN", which is exactly what this does.
    "danger": "medium",
    "cmd": ["steam", "steam://open/settings/bluetooth"],
    "user_env": True,        # needs DISPLAY / XDG_RUNTIME_DIR to reach the session
    "detached": True,        # the url handler hands off to the running client
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
CONFIG_WEBOS = None  # optional {"host","mac","client_key"} LG webOS TV config
CONFIG_SAMSUNG = None  # optional {"host","mac","token"} Samsung Tizen TV config
CONFIG_ROKU = None  # optional {"host","name"} Roku (ECP) TV config
CONFIG_ANDROIDTV = None  # optional {"host","cert","key","name","mac"} Android TV config
CONFIG_VIDAA = None  # optional {"host","name","mac"} Hisense VIDAA (MQTT) config
# optional {"host","name"} LG COMMERCIAL/signage panel (TCP 9761, no pairing).
# Distinct from CONFIG_WEBOS: these panels do not speak consumer webOS at all.
CONFIG_LGCOM = None
# The brand the user explicitly chose to drive, or None to fall back to the
# priority chain in _tv_hw_backend(). Without this a second paired TV was
# UNREACHABLE: the chain returns exactly one backend, so pairing e.g. a Google
# TV on a box that already had an LG reported success and then did nothing,
# because webos outranks androidtv and kept winning silently.
CONFIG_TV_ACTIVE = None
# Guide-button hold -> Couch Mode. OFF BY DEFAULT: a false positive yanks the
# user out of their desktop session mid-work. "uniq" optionally pins the trigger
# to ONE pad, keyed on the evdev U: Uniq field (the pad's OWN MAC) because BT
# pads RE-ENUMERATE — the /dev/input/eventN number and the uhid sysfs path both
# change across reconnects, Uniq does not. Empty uniq = any REAL pad.
GUIDE_MIN_HOLD_MS, GUIDE_MAX_HOLD_MS = 600, 5000
GUIDE_DEFAULTS = {"enabled": False, "hold_ms": 1200, "uniq": ""}
CONFIG_GUIDE = dict(GUIDE_DEFAULTS)
# When true, the app may trigger a box-side agent update via POST
# /api/update/apply. OFF BY DEFAULT: enabling it lets any holder of the bearer
# token cause a (signature-verified) install + restart, so it is opt-in and can
# only be turned on ON THE BOX (`couchside allow-updates on`, or config.json),
# never by the app itself. The app just reads the state and shows/hides its
# Update button accordingly.
ALLOW_APP_UPDATE = False
# When true, the app may CREATE custom launchers over the network (POST
# /api/launchers with an arbitrary argv). OFF BY DEFAULT: a launcher argv is
# executed verbatim as the desktop user (real_launch -> Popen(argv)), so remote
# creation lets any bearer-token holder run an arbitrary command (e.g. an argv
# whose argv[0] is a shell). That is user-level, not root, and the same token can
# already synthesize keystrokes over /ws/gamepad — but it is a silent, persistent
# primitive that contradicts the "bounded token" model, so minting new launchers
# is a box-side opt-in (`couchside allow-launchers on`, or config.json). TRIGGERING
# launchers the box owner already defined stays allowed; only remote CREATE is gated.
ALLOW_APP_LAUNCHERS = False
LAUNCHERS = []  # list of {"id","label","cmd":[...]}, custom launchers only
CONFIG_PATH = DEFAULT_CONFIG_PATH  # remembered by load_config() for rewrites
# False when the config DIRECTORY isn't writable by the agent's user (a
# root-owned dir under a non-root agent — a common ownership drift). Config
# writes go via a temp file in that dir + os.replace, so an unwritable dir makes
# every save (TV pairing, launcher edits) fail with a 500. Checked once at
# startup (check_config_writable) and surfaced in /api/status so the failure is
# never silent.
CONFIG_WRITABLE = True
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

    # Optional LG webOS TV (SSAP over the network). host is an IP/hostname; the
    # optional client_key is written back here by the pairing endpoint so later
    # starts reconnect silently; the optional mac enables Wake-on-LAN power-on.
    webos = None
    webos_raw = raw.get("webos")
    if webos_raw is not None:
        if not isinstance(webos_raw, dict):
            raise ConfigError("webos must be an object")
        host = webos_raw.get("host")
        if not isinstance(host, str) or not host:
            raise ConfigError("webos.host must be a non-empty string")
        webos = {"host": host}
        ck = webos_raw.get("client_key")
        if ck is not None:
            if not isinstance(ck, str):
                raise ConfigError("webos.client_key must be a string")
            webos["client_key"] = ck
        mac = webos_raw.get("mac")
        if mac is not None:
            if not isinstance(mac, str):
                raise ConfigError("webos.mac must be a string")
            webos["mac"] = mac

    # Optional Samsung Tizen TV (WS remote). host is an IP/hostname; the optional
    # token is written back by the pairing endpoint for silent reconnects; the
    # optional mac enables Wake-on-LAN power-on.
    samsung = None
    samsung_raw = raw.get("samsung")
    if samsung_raw is not None:
        if not isinstance(samsung_raw, dict):
            raise ConfigError("samsung must be an object")
        host = samsung_raw.get("host")
        if not isinstance(host, str) or not host:
            raise ConfigError("samsung.host must be a non-empty string")
        samsung = {"host": host}
        tok = samsung_raw.get("token")
        if tok is not None:
            if not isinstance(tok, str):
                raise ConfigError("samsung.token must be a string")
            samsung["token"] = tok
        mac = samsung_raw.get("mac")
        if mac is not None:
            if not isinstance(mac, str):
                raise ConfigError("samsung.mac must be a string")
            samsung["mac"] = mac

    # Optional Roku TV (ECP over HTTP). host is an IP/hostname; the optional
    # name is a friendly label captured when the device was added. No pairing.
    roku = None
    roku_raw = raw.get("roku")
    if roku_raw is not None:
        if not isinstance(roku_raw, dict):
            raise ConfigError("roku must be an object")
        host = roku_raw.get("host")
        if not isinstance(host, str) or not host:
            raise ConfigError("roku.host must be a non-empty string")
        roku = {"host": host}
        name = roku_raw.get("name")
        if name is not None:
            if not isinstance(name, str):
                raise ConfigError("roku.name must be a string")
            roku["name"] = name

    # Optional Android TV / Google TV (Remote v2). host + the paired client
    # cert/key (PEM strings, written back by the pairing endpoint); optional
    # name label and mac (for Wake-on-LAN power-on).
    androidtv = None
    atv_raw = raw.get("androidtv")
    if atv_raw is not None:
        if not isinstance(atv_raw, dict):
            raise ConfigError("androidtv must be an object")
        host = atv_raw.get("host")
        if not isinstance(host, str) or not host:
            raise ConfigError("androidtv.host must be a non-empty string")
        androidtv = {"host": host}
        for field in ("cert", "key", "name", "mac"):
            val = atv_raw.get(field)
            if val is not None:
                if not isinstance(val, str):
                    raise ConfigError("androidtv.%s must be a string" % field)
                androidtv[field] = val

    # Optional LG COMMERCIAL/signage panel (TCP 9761). host + optional name.
    # No pairing and no credentials: the control port is unauthenticated, which
    # is why this is a separate backend from consumer webOS rather than a mode
    # of it.
    lgcom = None
    lgcom_raw = raw.get("lg_commercial")
    if lgcom_raw is not None:
        if not isinstance(lgcom_raw, dict):
            raise ConfigError("lg_commercial must be an object")
        host = lgcom_raw.get("host")
        if not isinstance(host, str) or not host:
            raise ConfigError("lg_commercial.host must be a non-empty string")
        lgcom = {"host": host}
        nm = lgcom_raw.get("name")
        if nm is not None:
            if not isinstance(nm, str):
                raise ConfigError("lg_commercial.name must be a string")
            lgcom["name"] = nm

    # Optional Hisense VIDAA TV (MQTT on 36669). host + optional name/mac; no
    # pairing (default broker creds).
    vidaa = None
    vidaa_raw = raw.get("vidaa")
    if vidaa_raw is not None:
        if not isinstance(vidaa_raw, dict):
            raise ConfigError("vidaa must be an object")
        host = vidaa_raw.get("host")
        if not isinstance(host, str) or not host:
            raise ConfigError("vidaa.host must be a non-empty string")
        vidaa = {"host": host}
        for field in ("name", "mac"):
            val = vidaa_raw.get(field)
            if val is not None:
                if not isinstance(val, str):
                    raise ConfigError("vidaa.%s must be a string" % field)
                vidaa[field] = val

    # Optional guide-button hold trigger. Validated HERE rather than in the
    # early opt-in read above so that a config the agent cannot parse leaves the
    # trigger at its default — which is OFF. That is the fail-safe direction:
    # the early-read pattern would preserve "on" across an unparseable config.
    guide = dict(GUIDE_DEFAULTS)
    guide_raw = raw.get("guide")
    if guide_raw is not None:
        if not isinstance(guide_raw, dict):
            raise ConfigError("guide must be an object")
        if "enabled" in guide_raw:
            if not isinstance(guide_raw["enabled"], bool):
                raise ConfigError("guide.enabled must be a boolean")
            guide["enabled"] = guide_raw["enabled"]
        if "hold_ms" in guide_raw:
            ms = guide_raw["hold_ms"]
            # bool is a subclass of int; reject it explicitly.
            if isinstance(ms, bool) or not isinstance(ms, int):
                raise ConfigError("guide.hold_ms must be an integer")
            if not GUIDE_MIN_HOLD_MS <= ms <= GUIDE_MAX_HOLD_MS:
                raise ConfigError("guide.hold_ms must be %d..%d"
                                  % (GUIDE_MIN_HOLD_MS, GUIDE_MAX_HOLD_MS))
            guide["hold_ms"] = ms
        if "uniq" in guide_raw:
            if not isinstance(guide_raw["uniq"], str):
                raise ConfigError("guide.uniq must be a string")
            guide["uniq"] = guide_raw["uniq"].strip()

    return (units, actions, order, port, launchers, panel, webos, samsung,
            roku, androidtv, vidaa, lgcom, guide)


def load_config(path):
    """Load config.json into the module globals; fall back to defaults."""
    global WATCHLIST, WATCHLIST_NAMES, ACTIONS, ACTION_ORDER, CONFIG_PORT
    global LAUNCHERS, CONFIG_PATH, CONFIG_PANEL, CONFIG_WEBOS, CONFIG_SAMSUNG
    global CONFIG_ROKU, CONFIG_ANDROIDTV, CONFIG_VIDAA, ALLOW_APP_UPDATE
    global CONFIG_LGCOM, CONFIG_TV_ACTIVE
    global ALLOW_APP_LAUNCHERS, CONFIG_GUIDE
    # ABSOLUTE on purpose: every rewrite derives the temp-file directory from
    # os.path.dirname(CONFIG_PATH), and a relative path has no directory part.
    # That fell through to the process CWD, which under systemd is "/" — see
    # _write_config_atomic for the read-only-root failure that caused.
    CONFIG_PATH = os.path.abspath(path)  # remembered so launcher POST/DELETE can rewrite it
    try:
        with open(path) as f:
            raw = json.load(f)
        # Read the opt-in flags FIRST, independent of the rest of the config: they
        # must be honored even if _parse_config later rejects some other field.
        if isinstance(raw, dict):
            ALLOW_APP_UPDATE = bool(raw.get("allow_app_update", False))
            ALLOW_APP_LAUNCHERS = bool(raw.get("allow_app_launchers", False))
        (units, actions, order, port, launchers, panel, webos, samsung,
         roku, androidtv, vidaa, lgcom, guide) = _parse_config(raw)
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
    CONFIG_WEBOS = webos
    CONFIG_SAMSUNG = samsung
    CONFIG_ROKU = roku
    CONFIG_ANDROIDTV = androidtv
    CONFIG_VIDAA = vidaa
    CONFIG_LGCOM = lgcom
    active = raw.get("tv_active")
    CONFIG_TV_ACTIVE = active if isinstance(active, str) and active else None
    CONFIG_GUIDE = guide
    print("config loaded from %s: %d units, %d actions, %d launchers"
          % (path, len(WATCHLIST), len(ACTIONS), len(LAUNCHERS)), flush=True)


def check_config_writable():
    """Verify the agent can persist config, and warn loudly if not.

    Config writes go through a temp file in the config's DIRECTORY + os.replace
    (see _config_set_field), so the DIR — not just the file — must be writable by
    the agent's user. A root-owned config dir under a non-root agent (an install
    ownership drift) makes every save — TV pairing, launcher edits — fail with a
    500 the app used to render as a vague error. Surfaced in /api/status
    (config_writable) so the condition is visible instead of silent. Call in
    main() after load_config."""
    global CONFIG_WRITABLE
    directory = os.path.dirname(CONFIG_PATH) or "."
    # W_OK to create the temp file, X_OK to os.replace into the dir.
    CONFIG_WRITABLE = os.access(directory, os.W_OK | os.X_OK)
    if not CONFIG_WRITABLE:
        print("WARNING: config dir %s is NOT writable by uid %d — TV pairing and "
              "launcher changes will fail to save. chown the config dir to the "
              "agent's user." % (directory, os.getuid()), file=sys.stderr,
              flush=True)


def _write_config_atomic(raw):
    """Persist <raw> to CONFIG_PATH via temp file + os.replace. THE writer.

    Every config save funnels here — launchers, TV pairings, _config_set_field.
    It used to be three copy-pasted blocks that each carried the same trap:

        directory = os.path.dirname(CONFIG_PATH) or "."

    `or "."` looks like a harmless fallback. It is not: tempfile.mkstemp returns
    an ABSOLUTE path, so "." resolves against the process CWD, and a systemd
    service's CWD is "/". A CONFIG_PATH with no directory part therefore tried to
    write the temp file to the ROOT filesystem. On SteamOS root is read-only, so
    pairing a TV on a Steam Deck failed with

        [Errno 30] Read-only file system: '/.couchside-config-il0oed3c'

    — an errno on a temp name that named neither the config nor the real problem,
    and that no user could act on. load_config now abspath's CONFIG_PATH so the
    directory is always real; the check below turns the remaining case (a dir
    that genuinely isn't writable — root-owned config under a non-root agent, or
    a read-only mount) into a message that says what to fix.

    Raises ConfigError (a ValueError) on an unwritable dir. Deliberate: the
    pairing routes catch Exception and render it as a 500, and the launcher route
    catches ConfigError, so no caller is left with an unhandled traceback. MUST
    be called with CONFIG_LOCK held by the callers that mutate shared state."""
    directory = os.path.dirname(CONFIG_PATH) or "."
    # W_OK to create the temp file, X_OK to os.replace into the dir. Checked here
    # and not only at startup because a remount or chown can land mid-run.
    if not os.access(directory, os.W_OK | os.X_OK):
        raise ConfigError(
            "config dir %s is not writable by uid %d, so %s cannot be saved "
            "(read-only filesystem, or the dir is owned by another user). "
            "Reinstall or chown the config dir to the agent's user."
            % (directory, os.getuid(), CONFIG_PATH))
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


def _nopasswd_last_match(rules_text, needle):
    """Pure last-match-wins evaluation of `sudo -l` rule output.

    Two field failures taught this function its shape, one per naive version:
      * `sudo -n -l <cmd>` exit-code probing: exits 0 for ANY allowing rule,
        including wheel's password-requiring "(ALL) ALL". Shipped a Restart
        Decky button that appeared and then failed "a password is required".
      * "any NOPASSWD line names the command": sudoers is LAST-match-wins, and
        sudoers.d files load in lexical order — a box's `wheel` file
        ("(ALL) ALL", password) sorted after our `couchside` file and silently
        shadowed EVERY NOPASSWD grant for three days. The rules were all
        visible in `sudo -l`; only the ordering made them dead. (This is also
        why the installers now write `zz-couchside`: it must sort LAST.)

    So: walk the rule lines in order, track the LAST rule that matches the
    command — a rule naming it, or an ALL rule which matches everything — and
    answer whether THAT rule is NOPASSWD."""
    allowed = None
    for line in rules_text.splitlines():
        line = line.strip()
        if not line.startswith("("):
            continue                      # not a rule line (Defaults, headers)
        body = line.split(")", 1)[1].strip() if ")" in line else line
        matches_all = (body == "ALL" or body == "NOPASSWD: ALL"
                       or body.endswith(": ALL"))
        if matches_all or needle in line:
            allowed = "NOPASSWD" in line
    return bool(allowed)


def _sudo_nopasswd_allows(needle):
    """True when sudoers ACTUALLY permits the command without a password —
    last-match evaluated (see _nopasswd_last_match). False on any failure: a
    missing grant must HIDE an action, never offer a dead one."""
    try:
        r = subprocess.run(["sudo", "-n", "-l"], capture_output=True,
                           timeout=4, text=True)
        if r.returncode != 0:
            return False
        return _nopasswd_last_match(r.stdout, needle)
    except Exception:
        return False


def _can_sudo_suspend():
    """True when sudoers lets the agent run `systemctl suspend` with no
    password — via the NOPASSWD-parsing probe (see _sudo_nopasswd_allows for
    why exit-code probing is wrong)."""
    return _sudo_nopasswd_allows("systemctl suspend")


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


def _can_sudo_decky_restart():
    """True when sudoers permits `systemctl restart plugin_loader` with no
    password — via the NOPASSWD-parsing probe (see _sudo_nopasswd_allows)."""
    return _sudo_nopasswd_allows("systemctl restart plugin_loader")


def _inject_decky_action(mock):
    """Add the Restart Decky action on boxes that have Decky Loader installed
    AND the sudoers grant to restart it. Both gates matter: without the unit
    the action is meaningless, and without the grant it would just fail — a
    dead button costs more trust than a missing one. In --mock it is always
    added so the app's Actions tab can be developed off-box. Called after
    load_config; idempotent; a config-defined action of the same id wins."""
    global ACTIONS, ACTION_ORDER
    if "restart-decky" in ACTIONS:
        return
    if not mock:
        if not os.path.exists("/etc/systemd/system/plugin_loader.service"):
            return
        if not _can_sudo_decky_restart():
            return
    ACTIONS["restart-decky"] = dict(DECKY_RESTART_ACTION)
    if "restart-decky" not in ACTION_ORDER:
        ACTION_ORDER.append("restart-decky")


def _inject_bluetooth_action(mock):
    """Add the Bluetooth pairing action on boxes that actually have Steam.

    Gated on Steam being installed, since the whole action is a steam:// URL —
    on a non-Steam box it would be a button that silently does nothing, and a
    dead button costs more trust than a missing one (same reasoning as the Decky
    gate above). No sudo and no unit to check: the URL runs as the desktop user
    through the already-running client. In --mock it is always added so the
    Actions tab can be developed off-box. Called after load_config; idempotent;
    a config-defined action of the same id wins."""
    global ACTIONS, ACTION_ORDER
    if "pair-controller" in ACTIONS:
        return
    if not mock and _steam_root() is None:
        return
    ACTIONS["pair-controller"] = dict(BLUETOOTH_PAIRING_ACTION)
    if "pair-controller" not in ACTION_ORDER:
        ACTION_ORDER.append("pair-controller")

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
                 "screensaver", "couchmode", "desktop", "steamlink", "gaming",
                 "streamhost", "steammenus")}
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
        "steamlink": safe(steamlink_available),
        "gaming": safe(gaming_available),
        "streamhost": safe(streamhost_available),
        "steammenus": safe(steammenus_available),
    }


# ---------------------------------------------------------------------------
# Update check (/api/update/check).
#
# PRIVACY: this is the ONLY thing that reaches the public internet on the app's
# behalf, and it lives on the BOX — which already talks to GitHub to fetch its
# own updates — NOT in the phone app. The app reads the result over the LAN, so
# the app itself never leaves your network. GitHub sees the box's IP (a read of
# a public repo); nothing about the user is sent to us. The check runs only when
# asked (the app polls this route) and is CACHED, so GitHub is contacted at most
# once every few hours. It compares the installed agent version to the newest
# SIGNED release (the same assets install.sh verifies), so nothing here can be
# spoofed into recommending a malicious build.
# ---------------------------------------------------------------------------
_UPDATE_LATEST_VER_URL = \
    "https://github.com/emerytech/couchside/releases/latest/download/agent-version.txt"
_UPDATE_RELEASE_API = "https://api.github.com/repos/emerytech/couchside/releases/latest"
_UPDATE_TTL_S = 6 * 3600
_update_cache = {"at": 0.0, "data": None}
_update_lock = threading.Lock()


def _http_text(url, timeout=8):
    """GET a small text/JSON body from GitHub. GitHub requires a User-Agent."""
    req = urllib.request.Request(url, headers={
        "User-Agent": "couchside-agent/%s" % VERSION,
        "Accept": "application/vnd.github+json",
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(1_000_000).decode("utf-8", "replace")


def _ver_tuple(s):
    out = []
    for p in (s or "").strip().split("."):
        digits = "".join(ch for ch in p if ch.isdigit())
        out.append(int(digits) if digits else 0)
    return tuple(out) or (0,)


def update_check(force=False):
    """Whether a newer SIGNED agent release exists. Cached (6h) so the app can
    poll cheaply — the box contacts GitHub only on a cache miss. Never raises;
    a network failure returns available:false with an error string."""
    now = time.monotonic()
    with _update_lock:
        c = _update_cache
        if not force and c["data"] is not None and now - c["at"] < _UPDATE_TTL_S:
            return c["data"]
    installed = VERSION
    try:
        latest = _http_text(_UPDATE_LATEST_VER_URL).strip().split()[0]
        meta = json.loads(_http_text(_UPDATE_RELEASE_API))
        data = {
            "available": _ver_tuple(latest) > _ver_tuple(installed),
            "installed": installed,
            "latest": latest,
            "tag": meta.get("tag_name") or None,
            "notes": (meta.get("body") or "").strip() or None,
            "checked_at": int(time.time()),
        }
    except Exception as e:
        data = {"available": False, "installed": installed, "latest": None,
                "tag": None, "notes": None, "error": str(e)[:200],
                "checked_at": int(time.time())}
    with _update_lock:
        _update_cache["at"] = now
        _update_cache["data"] = data
    return data


def mock_update_check():
    return {"available": True, "installed": VERSION, "latest": "2.9.9",
            "tag": "v2.8.9",
            "notes": "## Mock update 2.9.9\n- A shiny new thing\n- A small fix",
            "checked_at": int(time.time())}


def update_apply():
    """Spawn a DETACHED box-side update (the signed installer) so it survives
    this agent's own restart, and return immediately. The caller MUST have
    verified ALLOW_APP_UPDATE first. The installer verifies the release
    signature before installing, so a triggered update can only ever install an
    authentic release — never arbitrary code."""
    log = "/tmp/couchside-update.log"
    # start_new_session detaches the child into its own session/process group:
    # when the installer restarts couchside.service and kills this agent, the
    # update keeps running to completion.
    subprocess.Popen(
        ["bash", "-c",
         "curl -fsSL 'https://couchside.tv/install.sh' | bash > %s 2>&1" % log],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, start_new_session=True)
    print("[update] app-triggered update started (log: %s)" % log, flush=True)
    return {"started": True, "log": log}


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

# The installed player's basename IS the Steam tile name: Steam titles a
# non-Steam shortcut from the file basename (steam://addnonsteamgame). Named
# "Couchside Screensaver" so the Game Mode tile reads that, not the old ugly
# "couchside-screensaver.sh". The repo/release-asset name stays
# couchside-screensaver.sh; install.sh/plugin install it under the display name.
SCREENSAVER_SCRIPT = os.path.expanduser(
    "~/.local/opt/couchside/Couchside Screensaver")
# Legacy pre-2.9.20 install path; kept so _ss_appid can still find an
# already-registered old tile and reuse it instead of stacking a duplicate.
SCREENSAVER_SCRIPT_LEGACY = os.path.expanduser(
    "~/.local/opt/couchside/couchside-screensaver.sh")
SCREENSAVER_CONF = os.path.expanduser("~/.config/couchside/screensaver.conf")
# Branded Steam grid art dropped next to the shortcut appid so the tile shows a
# real capsule, not the filename-on-gradient placeholder. Shipped beside the
# agent (release asset + plugin bundle). {n} formats the appid.
SCREENSAVER_GRID_ART = os.path.expanduser(
    "~/.local/opt/couchside/steam-grid")
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


def _ss_script():
    """The installed player path, new display name preferred, legacy fallback.
    So a box whose agent updated to 2.9.20+ before its install.sh re-laid the
    renamed player keeps the screensaver working (via the old file) instead of
    the button vanishing — the tile just keeps its old name until install.sh
    catches up."""
    if os.path.isfile(SCREENSAVER_SCRIPT):
        return SCREENSAVER_SCRIPT
    if os.path.isfile(SCREENSAVER_SCRIPT_LEGACY):
        return SCREENSAVER_SCRIPT_LEGACY
    return SCREENSAVER_SCRIPT


def screensaver_available():
    """Script deployed (new or legacy path) + the Steam-launch toolchain
    present. Boot-time hint (rides caps); GET /api/screensaver is the live
    authority."""
    return (os.path.isfile(_ss_script())
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
    """The registered shortcut's appid from shortcuts.vdf, or None. Anchored on
    the Exe PATH so a tile rename can't break the lookup. Tries the current
    basename first, then the pre-2.9.20 'couchside-screensaver.sh' basename, so
    a box that already registered the old tile REUSES it instead of getting a
    duplicate on upgrade."""
    for p in glob.glob(os.path.expanduser(
            "~/.steam/steam/userdata/*/config/shortcuts.vdf")):
        try:
            with open(p, "rb") as f:
                data = f.read()
        except OSError:
            continue
        # "couchside/Couchside" hits the Exe path and survives the space being
        # stored literally OR percent-encoded (%20) — the token ends before the
        # space. It never collides with the lowercase "couchside/couchside-pair"
        # pairing tile.
        i = data.find(b"couchside/Couchside")
        if i < 0:
            i = data.find(b"couchside-screensaver.sh")   # legacy fallback
        if i < 0:
            continue
        # The appid field precedes the exe/appname block of the same entry.
        # b"\x02appid\x00" is 7 bytes; the LE int32 begins at j+7. (The old
        # j+8 read one byte late and returned a bogus appid, so the agent's own
        # fresh registration -> rungameid never actually launched anything.)
        seg = data[max(0, i - 300):i]
        j = seg.rfind(b"\x02appid\x00")
        if j >= 0 and j + 11 <= len(seg):
            return struct.unpack("<I", seg[j + 7:j + 11])[0]
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


def _ss_install_grid_art(appid):
    """Copy the branded Steam capsule art into every account's grid/ folder,
    keyed by the shortcut appid, so the Game Mode tile shows a real Couchside
    capsule instead of Steam's filename-on-gradient placeholder.

    Steam grid naming for a non-Steam shortcut appid:
      <appid>p.png     portrait  (the Game Mode library tile)
      <appid>.png      landscape (the header capsule)
      <appid>_logo.png logo overlay (transparent)
    Best-effort and idempotent: missing art or an unwritable folder is logged
    and ignored — art is never allowed to block the screensaver launch."""
    art = {
        "portrait":  "%dp.png" % appid,
        "landscape": "%d.png" % appid,
        "logo":      "%d_logo.png" % appid,
    }
    srcs = {k: os.path.join(SCREENSAVER_GRID_ART, "screensaver-%s.png" % k)
            for k in art}
    if not all(os.path.isfile(p) for p in srcs.values()):
        return
    for cfg in glob.glob(os.path.expanduser(
            "~/.steam/steam/userdata/*/config")):
        grid = os.path.join(cfg, "grid")
        try:
            os.makedirs(grid, exist_ok=True)
            for k, dstname in art.items():
                shutil.copyfile(srcs[k], os.path.join(grid, dstname))
        except OSError as e:
            print("[screensaver] grid art copy skipped (%s)" % e, flush=True)


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
                ["steamos-add-to-steam", _ss_script()],
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
            # Fresh tile: drop the branded capsule so it shows real art, not the
            # filename-on-gradient placeholder. Best-effort; a missing art dir or
            # unwritable grid folder never blocks the launch.
            _ss_install_grid_art(aid)
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
        # False when the config dir isn't writable by the agent user, so the app
        # can warn that TV pairing / launcher edits won't persist (agent >= 2.9.12).
        "config_writable": CONFIG_WRITABLE,
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
    """True when this box can switch desktop↔Game Mode: SteamOS/Bazzite, the
    session tools present, and ANY connected display to land Game Mode on.

    An external TV/monitor gives the full handoff (display pin, TV wake, audio
    routing). An INTERNAL-ONLY box — an undocked Steam Deck / Legion Go — now
    also qualifies: there the Couch button is simply the desktop↔Game Mode
    switch on the handheld's own screen, every TV-shaped step in
    couchmode_start() reports skipped, and the app's display picker hides
    because game_outputs is empty. This gate also feeds guide_hold_available(),
    so relaxing it is what lets the guide-button hold work undocked.

    Headless (no display at all) stays hidden: gamescope with nothing to render
    on is a box you can no longer reach."""
    if not _is_steamos_like():
        return False
    if not all(shutil.which(t) for t in _COUCHMODE_TOOLS):
        return False
    return bool(_connected_outputs())


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


def _couchmode_session_strict():
    """'gamescope' | 'desktop' | None. Same probe as _couchmode_session but
    UNKNOWN on error instead of assuming 'desktop'.

    _couchmode_session() fails open to 'desktop' because the app only needs a
    button label. The controller trigger cannot afford that: a pgrep timeout
    while the box is IN Game Mode would otherwise re-run
    steamos-session-select gamescope and can restart the session under a running
    game — and GUIDE is held constantly in Game Mode, where it is Steam's own
    QAM gesture. For the trigger, unknown must mean 'do nothing'."""
    try:
        r = subprocess.run(["pgrep", "-x", "gamescope(-wl)?"],
                           capture_output=True, timeout=3)
    except Exception:
        return None
    if r.returncode == 0:
        return "gamescope"
    if r.returncode == 1:
        return "desktop"
    return None          # pgrep itself failed (>=2): unknown


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
        # to the first external one in the app's picker. EMPTY on an
        # internal-only handheld — the app then hides the picker and the switch
        # lands on the built-in panel (output="", pinning skipped).
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
        return {"skipped": True, "reason": "no external display selected"}
    if not _output_forcing_supported():
        # SteamOS hardcodes its output; the drop-in would be written but ignored.
        # Honest skip-with-reason so the ceremony never fakes a green node.
        return {"skipped": True,
                "reason": "this session picks its own output (SteamOS)"}
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


# Serialized session switching. couchmode_start() tears down a login session and
# _set_preferred_output() rewrites a file non-atomically; the HTTP server is
# threaded (BoundedThreadingHTTPServer) and the guide watcher adds a second,
# non-HTTP caller. HTTP callers BLOCK — behaviour identical to today, just
# serialized, so no new status code and no app change. The watcher never blocks:
# it takes the lock non-blocking and honours a cooldown, so a controller press
# during an in-flight switch is dropped rather than queued behind it.
COUCH_LOCK = threading.Lock()
_COUCH_LAST_SWITCH = 0.0


def couchmode_enter(output="", hdr=False):
    """Serialized couchmode_start() for HTTP callers. Blocks."""
    global _COUCH_LAST_SWITCH
    with COUCH_LOCK:
        _COUCH_LAST_SWITCH = time.monotonic()
        return couchmode_start(output, hdr)


def couchmode_exit():
    """Serialized desktop_mode() for HTTP callers. Blocks."""
    global _COUCH_LAST_SWITCH
    with COUCH_LOCK:
        _COUCH_LAST_SWITCH = time.monotonic()
        return desktop_mode()


def couchmode_try_enter(output="", cooldown=0.0):
    """Non-blocking couchmode_start() for the controller watcher. Returns None
    when a switch is already in flight or one landed within `cooldown`."""
    global _COUCH_LAST_SWITCH
    if not COUCH_LOCK.acquire(False):
        return None
    try:
        if cooldown and time.monotonic() - _COUCH_LAST_SWITCH < cooldown:
            return None
        _COUCH_LAST_SWITCH = time.monotonic()
        return couchmode_start(output, False)
    finally:
        COUCH_LOCK.release()


# ---------------------------------------------------------------------------
# Couch Mode ceremony: the desktop->TV switch as a VISIBLE, staged job the phone
# polls (GET /api/couch-mode/status). The switch runs on a daemon thread that
# holds COUCH_LOCK for its whole duration (serialized with enter/exit/try_enter
# — one session switch at a time) and mutates the job dict under a SEPARATE fast
# lock, so a status poll never blocks on the in-flight switch. Monotonic `id`
# supersedes an older ceremony. Fixes two lies the old fire-and-forget path told:
#   (a) "Ready" only meant a subprocess exited 0 — nothing verified gamescope
#       actually came up. We now poll for it.
#   (b) audio silently "skipped" when the just-woken TV's HDMI sink hadn't
#       enumerated yet, landing you in Game Mode with sound on the wrong device.
#       We retry after the session is up and report an honest failure.
COUCHMODE_MOCK = False           # set by set_couchmode(mock) from main()
_COUCH_JOB_LOCK = threading.Lock()
_COUCH_JOB = {"id": 0, "state": "idle", "output": "", "hdr": False,
              "session": None, "started_at": 0.0, "stages": []}

# Display order == execution order. Audio is LAST (not the roadmap's listed
# order) because bug (b) needs the TV's HDMI sink, which only exists AFTER the
# session is up. fatal=True fails the whole ceremony; only the switch is fatal.
_COUCH_STAGE_TEMPLATE = (
    {"key": "tv_power_on", "label": "TV power",  "fatal": False},
    {"key": "tv_input",    "label": "TV input",  "fatal": False},
    {"key": "output",      "label": "Display",   "fatal": False},
    {"key": "session",     "label": "Game Mode", "fatal": True},
    {"key": "audio",       "label": "Audio",     "fatal": False},
)
SESSION_VERIFY_TIMEOUT_S = 12.0     # bug (a): wait for gamescope to actually appear
SESSION_VERIFY_INTERVAL_S = 0.5
AUDIO_SINK_RETRIES = 6             # bug (b): ~3s settle after the TV wakes
AUDIO_SINK_DELAY_S = 0.5


def set_couchmode(mock):
    global COUCHMODE_MOCK
    COUCHMODE_MOCK = bool(mock)


def _couch_do_tv_power():
    r = tv_send("power_on", False)
    return r if r is not None else {"skipped": True,
                                    "reason": "no TV control backend"}


def _couch_do_tv_input():
    r = tv_send("source_box", False)
    return r if r is not None else {"skipped": True,
                                    "reason": "no TV control backend"}


def _couch_verify_gamescope():
    """Bug (a): confirm Game Mode ACTUALLY came up. _session_to_game() only tells
    us the switch subprocess exited 0. The agent (a system service) survives the
    desktop teardown, so it keeps answering pgrep after the switch."""
    deadline = time.monotonic() + SESSION_VERIFY_TIMEOUT_S
    while time.monotonic() < deadline:
        if _couchmode_session() == "gamescope":
            return True
        time.sleep(SESSION_VERIFY_INTERVAL_S)
    return _couchmode_session() == "gamescope"


def _couch_do_audio(has_external):
    """Bug (b): route audio to the TV's HDMI sink AFTER the session is up, with a
    settle. Honest: no external display -> skipped (built-in is correct); external
    present but its HDMI sink never enumerates -> failed non-fatal (the 'TV just
    woke' case that used to masquerade as skipped)."""
    if not has_external:
        return {"state": "skipped",
                "reason": "no external display; audio stays on the box"}
    sink = None
    for _ in range(AUDIO_SINK_RETRIES):
        sink = _tv_audio_sink()
        if sink:
            break
        time.sleep(AUDIO_SINK_DELAY_S)
    if not sink:
        return {"state": "failed",
                "reason": "the TV's HDMI audio sink never appeared — "
                          "sound may still be on the box"}
    r = _couch_run(["pactl", "set-default-sink", sink])
    if r["ok"]:
        return {"state": "ok"}
    return {"state": "failed",
            "reason": (r["stderr"] or "").strip()[:120]
                      or "pactl could not switch the default sink"}


def _step_state_reason(r):
    """(state, reason) from a subprocess/skip dict (tv_send / _set_preferred_output)."""
    if r is None or r.get("skipped"):
        return "skipped", (r or {}).get("reason")
    if r.get("ok"):
        return "ok", None
    return "failed", (r.get("stderr") or "").strip()[:120] or None


def _couch_stage_locked(job_id, key, state, reason=None):
    if _COUCH_JOB["id"] != job_id:          # superseded by a newer ceremony
        return
    for s in _COUCH_JOB["stages"]:
        if s["key"] == key:
            s["state"] = state
            if reason:
                s["reason"] = reason
            elif state in ("running", "pending"):
                s.pop("reason", None)
            return


def _couch_stage(job_id, key, state, reason=None):
    with _COUCH_JOB_LOCK:
        _couch_stage_locked(job_id, key, state, reason)


def _legacy_steps_locked():
    """Rebuild the old couchmode_start `steps` dict so an OLD app reading
    {ok, steps} off the POST response is unaffected."""
    out = {}
    for s in _COUCH_JOB["stages"]:
        st = s["state"]
        if st == "ok":
            out[s["key"]] = {"ok": True}
        elif st == "skipped":
            out[s["key"]] = {"skipped": True, "reason": s.get("reason")}
        elif st == "failed":
            out[s["key"]] = {"ok": False, "stderr": s.get("reason", "")}
        else:
            out[s["key"]] = {"pending": True}
    return out


def _couch_job_snapshot_locked():
    ok = _COUCH_JOB["state"] == "done"
    return {
        "id": _COUCH_JOB["id"],
        "state": _COUCH_JOB["state"],          # idle|running|done|failed
        "output": _COUCH_JOB["output"],
        "hdr": _COUCH_JOB["hdr"],
        "session": _COUCH_JOB["session"],      # verified session at terminal
        "started_at": _COUCH_JOB["started_at"],
        "stages": [dict(s) for s in _COUCH_JOB["stages"]],   # FULL array, copy
        # backward-compat for old apps reading the synchronous shape:
        "ok": ok,
        "steps": _legacy_steps_locked(),
    }


def couchmode_job_info():
    with _COUCH_JOB_LOCK:
        return _couch_job_snapshot_locked()


def _couch_finalize(job_id):
    with _COUCH_JOB_LOCK:
        if _COUCH_JOB["id"] != job_id:
            return
        session_stage = next(s for s in _COUCH_JOB["stages"]
                             if s["key"] == "session")
        up = session_stage["state"] == "ok"
        _COUCH_JOB["state"] = "done" if up else "failed"
        _COUCH_JOB["session"] = "gamescope" if up else _couchmode_session()


def _couch_mock_worker(job_id):
    """--mock: a believable ceremony that ANIMATES (~0.6s/stage, all green),
    driving the REAL job dict so the app's poll/render path is exercised."""
    for key in ("tv_power_on", "tv_input", "output", "session", "audio"):
        _couch_stage(job_id, key, "running")
        time.sleep(0.6)
        _couch_stage(job_id, key, "ok")
    _couch_finalize(job_id)


def _couch_ceremony_worker(job_id, output, hdr):
    """Staged switch. Holds COUCH_LOCK for the whole switch; writes each stage
    under the fast _COUCH_JOB_LOCK so status polls never block on it."""
    global _COUCH_LAST_SWITCH
    try:
        with COUCH_LOCK:
            _COUCH_LAST_SWITCH = time.monotonic()
            if COUCHMODE_MOCK:
                _couch_mock_worker(job_id)
                return
            has_external = any(not o["internal"] for o in _connected_outputs())

            _couch_stage(job_id, "tv_power_on", "running")
            st, why = _step_state_reason(_couch_do_tv_power())
            _couch_stage(job_id, "tv_power_on", st, why)

            _couch_stage(job_id, "tv_input", "running")
            st, why = _step_state_reason(_couch_do_tv_input())
            _couch_stage(job_id, "tv_input", st, why)

            _couch_stage(job_id, "output", "running")
            st, why = _step_state_reason(_set_preferred_output(output))
            _couch_stage(job_id, "output", st, why)

            # (bug a) switch, then VERIFY gamescope actually came up.
            _couch_stage(job_id, "session", "running")
            sw = _session_to_game()
            if not sw["ok"]:
                _couch_stage(job_id, "session", "failed",
                             (sw["stderr"] or "").strip()[:120]
                             or "session switch tool failed")
            elif _couch_verify_gamescope():
                _couch_stage(job_id, "session", "ok")
            else:
                _couch_stage(job_id, "session", "failed",
                             "switch reported success but Game Mode did not "
                             "come up in %ds" % int(SESSION_VERIFY_TIMEOUT_S))

            # (bug b) audio LAST, retried, honest skipped-vs-failed.
            _couch_stage(job_id, "audio", "running")
            a = _couch_do_audio(has_external)
            _couch_stage(job_id, "audio", a["state"], a.get("reason"))

            _couch_finalize(job_id)
    except Exception as e:                  # a worker thread must never escape
        with _COUCH_JOB_LOCK:
            if _COUCH_JOB["id"] == job_id:
                _couch_stage_locked(job_id, "session", "failed",
                                    "ceremony crashed: %s" % e.__class__.__name__)
                _COUCH_JOB["state"] = "failed"
                _COUCH_JOB["session"] = _couchmode_session()
        print("[couch] ceremony %d crashed: %s" % (job_id, e), flush=True)


def couch_ceremony_start(output="", hdr=False):
    """Kick the staged ceremony as a background job; return the initial snapshot
    (state=running, stages pending) IMMEDIATELY. If one is already running, return
    THAT job's snapshot — a double-tap or a second phone tapping Fling joins the
    existing ceremony instead of stacking a second switch."""
    with _COUCH_JOB_LOCK:
        if _COUCH_JOB["state"] == "running":
            return _couch_job_snapshot_locked()
        _COUCH_JOB["id"] += 1
        job_id = _COUCH_JOB["id"]
        _COUCH_JOB.update(
            state="running", output=output or "", hdr=bool(hdr),
            session=None, started_at=time.time(),
            stages=[{"key": s["key"], "label": s["label"],
                     "fatal": s["fatal"], "state": "pending"}
                    for s in _COUCH_STAGE_TEMPLATE])
        snap = _couch_job_snapshot_locked()
    threading.Thread(target=_couch_ceremony_worker,
                     args=(job_id, output or "", bool(hdr)),
                     daemon=True, name="couch-ceremony").start()
    return snap


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
        "config_writable": True,
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
# Bits that mean bytes/work are ACTUALLY MOVING (transfer or install), as
# opposed to the update-state-machine bits (UPDATE_RUNNING/STARTED/STOPPING)
# which Steam also sets on QUEUED updates and leaves for days without moving a
# byte. "Currently downloading" uses these + the downloading/ folder, so the
# app stops showing idle queue entries as stuck live downloads.
DL_TRANSFER = (DL_DOWNLOADING | DL_PREALLOCATING | DL_VALIDATING
               | DL_STAGING | DL_COMMITTING)
# Update-state-machine bits: set on queued/scheduled updates that aren't moving.
DL_UPDATE_ANY = DL_UPDATE_RUNNING | DL_UPDATE_STARTED | DL_UPDATE_STOPPING


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


# ---------------------------------------------------------------------------
# Steam Remote Play — in-home streaming (/api/steamlink).
#
# The box's Steam client can stream games FROM another Steam machine on the LAN
# (your gaming PC or another Deck) — the Steam client IS the streaming client,
# so there is nothing to install. Steam caches every host it has streamed from,
# and the appids that host offers, in config/remoteclients.vdf. We surface those
# as one-tap "stream this game" tiles: launching steam://rungameid/<appid> for a
# game that is NOT installed locally but that an online host offers makes Steam
# stream it (verified on real hardware: a single rungameid brought up the
# streaming_client, no install manifest). If the host is offline the launch is a
# no-op on the box, so this is safe to fire optimistically.
#
# Names come from Steam's own appinfo.vdf cache (LAN-only, never a CDN — matches
# the cover-art policy), so host-only games that were never installed still show
# their real title. Cover art rides the existing /api/steam/<appid>/cover, which
# 404s for uncached art; the app falls back to the title.
# ---------------------------------------------------------------------------

# appinfo.vdf name cache: parsing the (multi-MB) blob on every /api/steamlink
# poll is wasteful, and it changes rarely. Cache the full {appid:int -> name}
# map keyed by the file's mtime+size so a Steam metadata refresh invalidates it.
_APPINFO_CACHE = {"key": None, "names": {}}
_APPINFO_LOCK = threading.Lock()
_APPINFO_MAGIC_V29 = 0x07564429
_APPINFO_MAGIC_V28 = 0x07564428


def _appinfo_path():
    root = _steam_root()
    if root is None:
        return None
    p = os.path.join(root, "appcache", "appinfo.vdf")
    return p if os.path.isfile(p) else None


def _parse_appinfo_names(data):
    """{appid:int -> name:str} from an appinfo.vdf blob (v28 inline-key or v29
    string-table). Defensive: a malformed app entry is skipped, never raised;
    a wholly unparseable blob yields {}. Only common->name is extracted."""
    names = {}
    try:
        magic = struct.unpack_from("<I", data, 0)[0]
    except struct.error:
        return names
    if magic not in (_APPINFO_MAGIC_V29, _APPINFO_MAGIC_V28):
        return names
    v29 = magic == _APPINFO_MAGIC_V29
    # string table (v29 only): keys in the KV blob are int32 indices into it.
    name_idx = None
    if v29:
        try:
            st_off = struct.unpack_from("<q", data, 8)[0]
            count = struct.unpack_from("<I", data, st_off)[0]
            strings, p = [], st_off + 4
            for _ in range(count):
                e = data.index(b"\x00", p)
                strings.append(data[p:e])
                p = e + 1
            name_idx = strings.index(b"name")
        except (struct.error, ValueError, IndexError):
            return names
        section = 16
    else:
        section = 12
    # Within an app entry the KV blob begins after the fixed header fields:
    # infoState(4) lastUpdated(4) picsToken(8) sha1(20) changeNumber(4)
    # + v29's second (binary-vdf) sha1(20).
    kv_off = 4 + 4 + 8 + 20 + 4 + (20 if v29 else 0)
    n = len(data)
    p = section
    while p + 8 <= n:
        try:
            appid = struct.unpack_from("<I", data, p)[0]
            if appid == 0:
                break
            size = struct.unpack_from("<I", data, p + 4)[0]
            blob_start = p + 8
            blob_end = blob_start + size
            p = blob_end
            names_val = _appinfo_find_name(data, blob_start + kv_off,
                                           min(blob_end, n), name_idx, v29)
            if names_val:
                names[appid] = names_val
        except (struct.error, ValueError, IndexError):
            break
    return names


def _appinfo_find_name(data, start, end, name_idx, v29):
    """The first string field named "name" in one app's KV blob, or None. Keys
    are int32 string-table indices (v29) or inline NUL-terminated (v28)."""
    p = start
    depth = 0
    try:
        while p < end:
            t = data[p]
            p += 1
            if t == 0x08:            # end of map
                depth -= 1
                if depth < 0:
                    return None
                continue
            if v29:
                key = struct.unpack_from("<I", data, p)[0]
                p += 4
            else:
                e = data.index(b"\x00", p)
                key = data[p:e]
                p = e + 1
            if t == 0x00:            # nested map
                depth += 1
                continue
            if t == 0x01:            # string value
                e = data.index(b"\x00", p)
                val = data[p:e]
                p = e + 1
                if (name_idx is not None and key == name_idx) or \
                        (name_idx is None and key == b"name"):
                    return val.decode("utf-8", "replace")
                continue
            if t == 0x02:            # int32
                p += 4
                continue
            if t == 0x07:            # int64
                p += 8
                continue
            return None              # unknown type: stop this app safely
    except (IndexError, struct.error):
        return None
    return None


def _steam_appinfo_names():
    """{appid:int -> name}, cached by appinfo.vdf mtime+size. {} on any error."""
    path = _appinfo_path()
    if path is None:
        return {}
    try:
        st = os.stat(path)
        key = (st.st_mtime, st.st_size)
    except OSError:
        return {}
    with _APPINFO_LOCK:
        if _APPINFO_CACHE["key"] == key:
            return _APPINFO_CACHE["names"]
    try:
        with open(path, "rb") as f:
            names = _parse_appinfo_names(f.read())
    except OSError:
        return {}
    with _APPINFO_LOCK:
        _APPINFO_CACHE["key"] = key
        _APPINFO_CACHE["names"] = names
    return names


def _remoteclients_path():
    root = _steam_root()
    if root is None:
        return None
    p = os.path.join(root, "config", "remoteclients.vdf")
    return p if os.path.isfile(p) else None


# --- stream-host liveness ---------------------------------------------------
#
# remoteclients.vdf lists every host this box has EVER streamed from and says
# nothing about which are on now. Picking a game from a host that is off makes
# Steam fall back to "play locally" and offer a multi-GB INSTALL, which reads as
# a Couchside bug when it is really "that PC is off".
#
# The signal is Steam's own logs/remote_connections.txt. Steam already receives
# the LAN discovery beacons and writes them down with the client id, so the
# agent never has to touch the network -- no probing, no port scan, no mDNS.
#
# MEASURED on two boxes (2026-07-20) before choosing the rule:
#   * Beacon recency ALONE is not usable. Beacons are bursty: median gap 9s but
#     p99 2725s, and 5.4% of gaps within an active stretch exceed 15 minutes.
#     Any tight freshness window flickers a present host to "offline".
#   * The lifecycle lines ("Client <id> (<host>) connected|disconnected") are a
#     STATE, and that state matched every host whose truth was independently
#     known: two live boxes read `connected` (1m, 6m), while the asleep Steam
#     Deck from the original report read `disconnected` 12h, and a machine gone
#     for a month read `disconnected` 28d.
#   * IP-derived evidence was rejected: a beacon's address field is sometimes
#     the client id rather than an IP, ARP reads FAILED for hosts that are live
#     over a relay, and the "peer" holding a connection is frequently the
#     ROUTER (the same trap already documented for stream-host detection).
#
# A host that loses power abruptly may never log `disconnected` -- the same
# missing-stop-marker shape as streaming_log.txt. So `connected` is paired with
# a staleness cap, and `last_seen` is always reported so the app can say "last
# seen 12h ago" instead of asserting something it cannot know.
_REMOTE_LOG_MAX_BYTES = 4 * 1024 * 1024   # tail cap: this log reaches MBs
STREAM_HOST_STALE_S = 2 * 3600            # `connected` older than this = unknown
_RX_REMOTE_LIFECYCLE = re.compile(
    r"^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\].*?"
    r"Client (\d+) \(([^)]*)\) (connected|disconnected)")
_RX_REMOTE_BEACON = re.compile(
    r"^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\].*?"
    r"broadcast message from client (\d+) \(([^)]*)\)")


def _remote_log_path():
    root = _steam_root()
    if root is None:
        return None
    p = os.path.join(root, "logs", "remote_connections.txt")
    return p if os.path.isfile(p) else None


def _remote_log_epoch(stamp):
    """Unix seconds from a 'YYYY-MM-DD HH:MM:SS' log stamp, else None. Steam
    writes local time, so this parses as local time (mktime), matching
    _stream_line_epoch."""
    try:
        return int(time.mktime(time.strptime(stamp, "%Y-%m-%d %H:%M:%S")))
    except (ValueError, OverflowError):
        return None


def remote_client_liveness():
    """{client_id: {"state": "connected"|"disconnected"|None, "state_at": int,
    "last_seen": int, "host": str}} from Steam's remote-connections log.

    Reads only the TAIL: the log runs to megabytes and only the newest events
    matter. Never raises -- a box with no log simply yields {}."""
    path = _remote_log_path()
    if path is None:
        return {}
    try:
        size = os.path.getsize(path)
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            if size > _REMOTE_LOG_MAX_BYTES:
                f.seek(size - _REMOTE_LOG_MAX_BYTES)
                f.readline()             # discard the partial first line
            lines = f.readlines()
    except OSError:
        return {}

    out = {}

    def touch(cid, host, when):
        e = out.setdefault(cid, {"state": None, "state_at": 0, "last_seen": 0,
                                 "host": host})
        if when > e["last_seen"]:
            e["last_seen"] = when
        # Newest hostname wins: a box keeps its id across a rename.
        if host and when >= e.get("_host_at", 0):
            e["host"], e["_host_at"] = host, when
        return e

    for line in lines:
        m = _RX_REMOTE_LIFECYCLE.match(line)
        if m:
            when = _remote_log_epoch(m.group(1))
            if when is None:
                continue
            e = touch(m.group(2), m.group(3), when)
            if when >= e["state_at"]:
                e["state"], e["state_at"] = m.group(4), when
            continue
        m = _RX_REMOTE_BEACON.match(line)
        if m:
            when = _remote_log_epoch(m.group(1))
            if when is not None:
                touch(m.group(2), m.group(3), when)
    for e in out.values():
        e.pop("_host_at", None)
    return out


def stream_host_online(entry, now=None):
    """(online: bool, reason: str) for one remote_client_liveness() entry.

    `online` is deliberately conservative. Dimming a host that is actually up
    costs the user one tap; calling a host up when it is not is what makes
    Steam offer a multi-gigabyte install, so ambiguity resolves to offline."""
    now = int(time.time()) if now is None else now
    if not entry:
        return False, "never seen on this network"
    age = max(0, now - int(entry.get("last_seen") or 0))
    if entry.get("state") == "connected":
        if now - int(entry.get("state_at") or 0) <= STREAM_HOST_STALE_S:
            return True, "connected"
        return False, "no response in %s" % _short_ago(age)
    if entry.get("state") == "disconnected":
        return False, "offline (last seen %s ago)" % _short_ago(age)
    return False, "last seen %s ago" % _short_ago(age)


def _short_ago(seconds):
    """Compact age for a user-facing reason string: 45s / 12m / 3h / 5d."""
    s = max(0, int(seconds))
    if s < 90:
        return "%ds" % s
    if s < 5400:
        return "%dm" % (s // 60)
    if s < 172800:
        return "%dh" % (s // 3600)
    return "%dd" % (s // 86400)


def _vdf_line_val(line):
    """The VALUE of a `"key"  "value"` text-VDF line (the last quoted token), or
    None. Used for remoteclients.vdf, which has no nesting we care about."""
    parts = line.split('"')
    if len(parts) >= 4:
        return parts[-2]
    if len(parts) == 3:              # a lone `"token"` (e.g. the "apps" key)
        return parts[1]
    return None


def _parse_remoteclients(text):
    """[{host, cid, last, apps:[appid_str,...]}] from a remoteclients.vdf blob.
    Text line-scan (pure-stdlib agent, no VDF parser). Best-effort; [] on trouble.

    `cid` is the 64-bit Steam client id -- the map KEY each host block hangs
    off, which earlier revisions read past. It matters because it is the same
    id Steam writes in logs/remote_connections.txt, so host liveness can be
    joined on an exact id instead of a hostname string (a box can be renamed
    while keeping its id -- observed: bazzite -> lenovodesktop)."""
    hosts = []
    cur = None
    in_apps = False
    pending_cid = None
    for raw in text.splitlines():
        s = raw.strip()
        # A bare quoted run of digits at block level is a client id key.
        if (not in_apps and len(s) > 2 and s[0] == '"' and s[-1] == '"'
                and s[1:-1].isdigit()):
            pending_cid = s[1:-1]
        if s.startswith('"hostname"'):
            cur = {"host": _vdf_line_val(s) or "", "cid": pending_cid or "",
                   "last": 0, "apps": []}
            hosts.append(cur)
            pending_cid = None
            in_apps = False
        elif cur is not None and s.startswith('"lastupdated"'):
            try:
                cur["last"] = int(_vdf_line_val(s) or "0")
            except (TypeError, ValueError):
                pass
        elif s == '"apps"':
            in_apps = True
        elif in_apps:
            if s.startswith("}"):
                in_apps = False
            elif cur is not None:
                v = _vdf_line_val(s)
                if v and v.isdigit():
                    cur["apps"].append(v)
    return hosts


def discover_stream_games():
    """Streamable host games as launcher dicts, most-recent host per appid.
    Each -> {"id":"stream:<appid>","label":<name>,"kind":"stream",
    "appid":<int>,"host":<hostname>}. Tools/runtimes skipped. Read-only,
    best-effort: any failure yields []."""
    try:
        path = _remoteclients_path()
        if path is None:
            return []
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            hosts = _parse_remoteclients(f.read())
        names = _steam_appinfo_names()
        best = {}  # appid(str) -> (last_seen, host)
        for h in hosts:
            for a in h["apps"]:
                prev = best.get(a)
                if prev is None or h["last"] > prev[0]:
                    best[a] = (h["last"], h["host"], h.get("cid", ""))
        out = []
        for a, (last, host, cid) in best.items():
            name = names.get(int(a), "")
            if _is_steam_tool(a, name):
                continue
            out.append({
                "id": "stream:%s" % a,
                "label": name or ("App %s" % a),
                "kind": "stream",
                "appid": int(a),
                "host": host,
                "cid": cid,
                "last": last,
            })
        out.sort(key=lambda l: (l["label"].lower(), l["appid"]))
        return out
    except Exception:
        return []


def _streamable_appids():
    """Set of appid strings currently offered by any known host — the allowlist
    the launch route validates against so only a real streamable game fires."""
    return {str(g["appid"]) for g in discover_stream_games()}


def steamlink_available():
    """Steam present AND at least one host offers at least one streamable game.
    Boot-time hint (rides caps); GET /api/steamlink is the live authority."""
    return (_steam_root() is not None
            and shutil.which("steam") is not None
            and bool(discover_stream_games()))


def steamlink_info():
    """{available, hosts:[{host, last, games:[{appid,label}]}]} grouped by host,
    newest host first. games are de-duped to their most-recent host, so a title
    appears once even if several machines offer it."""
    games = discover_stream_games()
    by_host = {}
    for g in games:
        by_host.setdefault(g["host"], {"host": g["host"], "last": g["last"],
                                       "cid": g.get("cid", ""), "games": []})
        by_host[g["host"]]["games"].append(
            {"appid": g["appid"], "label": g["label"]})
    hosts = sorted(by_host.values(), key=lambda h: h["last"], reverse=True)

    # Liveness, joined on the Steam client id (never the hostname -- a box can
    # be renamed and keep its id). Read once for all hosts, not per host.
    live = remote_client_liveness()
    now = int(time.time())
    for h in hosts:
        h["games"].sort(key=lambda g: g["label"].lower())
        entry = live.get(h.get("cid") or "")
        online, reason = stream_host_online(entry, now)
        h["online"] = online
        h["reason"] = reason
        h["last_seen"] = int(entry.get("last_seen") or 0) if entry else 0
        h.pop("cid", None)               # internal join key, not app-facing
    return {"available": bool(games), "hosts": hosts}


def _acf_int(s):
    """Parse an ACF numeric string to int; 0 on missing/garbage (never raises)."""
    try:
        return int(s)
    except (TypeError, ValueError):
        return 0


def _download_state(flags):
    """Map StateFlags to a coarse, user-facing label for an ACTIVELY-moving app
    (caller has already established a real transfer is in progress)."""
    if flags & (DL_DOWNLOADING | DL_PREALLOCATING):
        return "downloading"
    if flags & DL_VALIDATING:
        return "validating"
    if flags & (DL_STAGING | DL_COMMITTING):
        return "finalizing"
    # An UPDATE_* bit but no transfer bit, yet the caller proved it's moving
    # (present in the downloading/ folder): it IS downloading.
    return "downloading"


def _downloading_appids(steamapps):
    """Appids Steam is ACTIVELY transferring right now: the digit-named subdirs
    under steamapps/downloading/. This is ground truth for "moving now" — the
    appmanifest StateFlags alone leave queued updates marked started/stopping
    for days with zero bytes moving. Best-effort; never raises."""
    ids = set()
    try:
        for name in os.listdir(os.path.join(steamapps, "downloading")):
            if name.isdigit():
                ids.add(name)
    except OSError:
        pass
    return ids


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
            # Ground truth for "moving now" in THIS library.
            active_ids = _downloading_appids(steamapps)
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
                # ACTUALLY moving right now: a transfer/install bit is set, or
                # Steam has a chunk dir open for it. NOT the update-* bits alone.
                active = bool(flags & DL_TRANSFER) or appid in active_ids
                # Queued: Steam has an update pending (update-* bit or unfinished
                # bytes) but isn't transferring it — the "downloads for days"
                # backlog. Reported as its own state so the app can dim/section
                # it instead of showing a stuck live download.
                pending = bool(flags & DL_UPDATE_ANY) or incomplete
                if not active and not pending:
                    continue  # fully installed, nothing to do
                if not active and not incomplete:
                    # Queued but every byte is already present (stale 100%
                    # "updating" ghost, e.g. an update applied but the flag not
                    # cleared): nothing left to download — drop it.
                    continue
                percent = (
                    int(max(0, min(100, round(done * 100.0 / total)))) if total > 0 else 0
                )
                if active:
                    state = _download_state(flags)
                    if state == "downloading" and total > 0 and done >= total:
                        state = "finalizing"  # bytes done, Steam is installing
                else:
                    state = "queued"
                found[appid] = {
                    "appid": int(appid),
                    "name": name,
                    "state": state,
                    "active": active,
                    "bytes_total": total,
                    "bytes_downloaded": done,
                    "percent": percent,
                }
        order = {
            "downloading": 0, "validating": 1, "finalizing": 2, "queued": 3,
        }
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

    steam:<appid>   -> ["steam", "steam://rungameid/<appid>"] (installed game)
    stream:<appid>  -> ["steam", "steam://rungameid/<appid>"] (Remote Play from
                       a host — same URL, but the appid is validated against the
                       streamable set instead of the on-disk manifest, since a
                       host game is by definition NOT installed locally)
    custom:<slug>   -> that launcher's stored cmd argv from config
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
    if launcher_id.startswith("stream:"):
        appid = launcher_id[len("stream:"):]
        if not appid.isdigit():
            return None
        # A host-streamable game is NOT installed locally, so gate on the
        # remoteclients allowlist instead. Steam streams it iff a host that
        # offers it is online; if not, the rungameid is a harmless no-op.
        if appid in _streamable_appids():
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
    """--mock stand-in: one advancing ACTIVE download (0->100%, +7% per poll so
    the bar visibly moves) plus two QUEUED updates (pending, not moving) — the
    common real shape. No real Steam needed."""
    global _MOCK_DL_PCT
    _MOCK_DL_PCT = (_MOCK_DL_PCT + 7) % 101
    total = 42_000_000_000
    done = int(total * _MOCK_DL_PCT / 100)
    return [
        {"appid": 1091500, "name": "Cyberpunk 2077", "state": "downloading",
         "active": True, "bytes_total": total, "bytes_downloaded": done,
         "percent": _MOCK_DL_PCT},
        {"appid": 570, "name": "Dota 2", "state": "queued", "active": False,
         "bytes_total": 18_000_000_000, "bytes_downloaded": 0, "percent": 0},
        {"appid": 1245620, "name": "Elden Ring", "state": "queued",
         "active": False, "bytes_total": 3_100_000_000, "bytes_downloaded": 0,
         "percent": 0},
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
    _write_config_atomic(raw)
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


# ---- webOS backend (LG consumer TVs, SSAP over a stdlib WebSocket) ---------
# Consumer webOS TVs speak SSAP: JSON request/response over a TLS WebSocket on
# port 3001 (the TV serves a self-signed cert). The WebSocket (RFC 6455) is
# hand-rolled below so the agent stays pure-stdlib (see the module docstring) —
# Bazzite/SteamOS are immutable, so a pip dependency is not an option. The
# pywebostv project was the protocol oracle; nothing from it ships here.
#
# Pairing: the first connect raises an Accept prompt on the TV and returns a
# client-key, which the pairing endpoint persists in config.json (webos.
# client_key) so later reconnects are silent. power_off is an SSAP call;
# power_ON is impossible over the socket (a TV that is off has dropped its
# network stack), so it is a Wake-on-LAN magic packet to webos.mac. D-pad and
# media buttons ride a SECOND "pointer" WebSocket whose URL the TV returns from
# getPointerInputSocket.
#
# CONFIG-DRIVEN like the panel backend: present only when config named a webos
# host AND a client_key has been paired (or in --mock). The socket is opened
# lazily so a powered-off TV never blocks startup or the appear-probe.
WEBOS_PORT = 3001
_WEBOS_WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

# Register manifest — verbatim LG/pywebostv value. The `signed` sub-object is
# covered by the static `signature`, so it must be byte-for-byte identical or
# the TV rejects the session with "401 insufficient permissions". Embedded as
# an ASCII (\uXXXX-escaped) JSON string so no multibyte source bytes can drift;
# json.loads() reconstitutes the exact object at pairing time.
_WEBOS_REGISTER_JSON = '{"forcePairing":false,"manifest":{"appVersion":"1.1","manifestVersion":1,"permissions":["LAUNCH","LAUNCH_WEBAPP","APP_TO_APP","CLOSE","TEST_OPEN","TEST_PROTECTED","CONTROL_AUDIO","CONTROL_DISPLAY","CONTROL_INPUT_JOYSTICK","CONTROL_INPUT_MEDIA_RECORDING","CONTROL_INPUT_MEDIA_PLAYBACK","CONTROL_INPUT_TV","CONTROL_POWER","READ_APP_STATUS","READ_CURRENT_CHANNEL","READ_INPUT_DEVICE_LIST","READ_NETWORK_STATE","READ_RUNNING_APPS","READ_TV_CHANNEL_LIST","WRITE_NOTIFICATION_TOAST","READ_POWER_STATE","READ_COUNTRY_INFO","READ_SETTINGS","CONTROL_TV_SCREEN","CONTROL_TV_STANBY","CONTROL_FAVORITE_GROUP","CONTROL_USER_INFO","CHECK_BLUETOOTH_DEVICE","CONTROL_BLUETOOTH","CONTROL_TIMER_INFO","STB_INTERNAL_CONNECTION","CONTROL_RECORDING","READ_RECORDING_STATE","WRITE_RECORDING_LIST","READ_RECORDING_LIST","READ_RECORDING_SCHEDULE","WRITE_RECORDING_SCHEDULE","READ_STORAGE_DEVICE_LIST","READ_TV_PROGRAM_INFO","CONTROL_BOX_CHANNEL","READ_TV_ACR_AUTH_TOKEN","READ_TV_CONTENT_STATE","READ_TV_CURRENT_TIME","ADD_LAUNCHER_CHANNEL","SET_CHANNEL_SKIP","RELEASE_CHANNEL_SKIP","CONTROL_CHANNEL_BLOCK","DELETE_SELECT_CHANNEL","CONTROL_CHANNEL_GROUP","SCAN_TV_CHANNELS","CONTROL_TV_POWER","CONTROL_WOL"],"signatures":[{"signature":"eyJhbGdvcml0aG0iOiJSU0EtU0hBMjU2Iiwia2V5SWQiOiJ0ZXN0LXNpZ25pbmctY2VydCIsInNpZ25hdHVyZVZlcnNpb24iOjF9.hrVRgjCwXVvE2OOSpDZ58hR+59aFNwYDyjQgKk3auukd7pcegmE2CzPCa0bJ0ZsRAcKkCTJrWo5iDzNhMBWRyaMOv5zWSrthlf7G128qvIlpMT0YNY+n/FaOHE73uLrS/g7swl3/qH/BGFG2Hu4RlL48eb3lLKqTt2xKHdCs6Cd4RMfJPYnzgvI4BNrFUKsjkcu+WD4OO2A27Pq1n50cMchmcaXadJhGrOqH5YmHdOCj5NSHzJYrsW0HPlpuAx/ECMeIZYDh6RMqaFM2DXzdKX9NmmyqzJ3o/0lkk/N97gfVRLW5hA29yeAwaCViZNCP8iC9aO0q9fQojoa7NQnAtw==","signatureVersion":1}],"signed":{"appId":"com.lge.test","created":"20140509","localizedAppNames":{"":"LG Remote App","ko-KR":"\\ub9ac\\ubaa8\\ucee8 \\uc571","zxx-XX":"\\u041b\\u0413 R\\u044d\\u043cot\\u044d A\\u041f\\u041f"},"localizedVendorNames":{"":"LG Electronics"},"permissions":["TEST_SECURE","CONTROL_INPUT_TEXT","CONTROL_MOUSE_AND_KEYBOARD","READ_INSTALLED_APPS","READ_LGE_SDX","READ_NOTIFICATIONS","SEARCH","WRITE_SETTINGS","WRITE_NOTIFICATION_ALERT","CONTROL_POWER","READ_CURRENT_CHANNEL","READ_RUNNING_APPS","READ_UPDATE_INFO","UPDATE_FROM_REMOTE_APP","READ_LGE_TV_INPUT_EVENTS","READ_TV_CURRENT_TIME"],"serial":"2f930e2d2cfe083771f68e4fe7bb07","vendorId":"com.lge"}},"pairingType":"PROMPT"}'

# Unified TV op -> (ssap uri, payload or None). "mute" (a toggle) and "power_on"
# (Wake-on-LAN) are handled specially in real_webos, so they are not here.
_WEBOS_OP_URI = {
    "power_off": ("ssap://system/turnOff", None),
    "volume_up": ("ssap://audio/volumeUp", None),
    "volume_down": ("ssap://audio/volumeDown", None),
}

# Factory-remote key (shared PANEL_KEYS vocabulary) -> webOS pointer button name.
_WEBOS_KEYS = {
    "up": "UP", "down": "DOWN", "left": "LEFT", "right": "RIGHT", "ok": "ENTER",
    "menu": "MENU", "home": "HOME", "back": "BACK", "exit": "EXIT", "info": "INFO",
    "play": "PLAY", "pause": "PAUSE", "stop": "STOP", "rewind": "REWIND",
    "fast_forward": "FASTFORWARD",
}


class _WebOSWS:
    """Barebones RFC 6455 text-frame client over TLS (accepts the TV's
    self-signed cert). One frame per message; server frames are never masked."""

    def __init__(self, url, timeout=6):
        u = urlparse(url)
        host, port = u.hostname, (u.port or WEBOS_PORT)
        sock = socket.create_connection((host, port), timeout=timeout)
        if u.scheme == "wss":
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            sock = ctx.wrap_socket(sock, server_hostname=host)
        sock.settimeout(timeout)
        self.sock = sock
        req_path = (u.path or "/") + (("?" + u.query) if u.query else "")
        self._handshake(host, port, req_path)

    def _handshake(self, host, port, path):
        key = base64.b64encode(os.urandom(16)).decode()
        req = ("GET %s HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\n"
               "Connection: Upgrade\r\nSec-WebSocket-Key: %s\r\n"
               "Sec-WebSocket-Version: 13\r\n\r\n" % (path, host, port, key))
        self.sock.sendall(req.encode())
        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = self.sock.recv(1)
            if not chunk:
                raise IOError("websocket closed during handshake")
            resp += chunk
        accept = base64.b64encode(
            hashlib.sha1((key + _WEBOS_WS_GUID).encode()).digest()).decode()
        if b" 101 " not in resp.split(b"\r\n", 1)[0] or accept.encode() not in resp:
            raise IOError("websocket handshake rejected")

    def _recv_exact(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise IOError("websocket closed mid-frame")
            buf += chunk
        return buf

    def send_text(self, text):
        data = text.encode()
        n = len(data)
        hdr = bytes([0x81])                       # FIN + text opcode
        if n < 126:
            hdr += bytes([0x80 | n])
        elif n < 65536:
            hdr += bytes([0x80 | 126]) + struct.pack("!H", n)
        else:
            hdr += bytes([0x80 | 127]) + struct.pack("!Q", n)
        mask = os.urandom(4)
        self.sock.sendall(hdr + mask
                          + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def recv_text(self):
        while True:
            b0, b1 = self._recv_exact(2)
            opcode, length = b0 & 0x0F, b1 & 0x7F
            if length == 126:
                length = struct.unpack("!H", self._recv_exact(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._recv_exact(8))[0]
            payload = self._recv_exact(length) if length else b""
            if opcode == 0x8:                     # close
                raise IOError("websocket closed by TV")
            if opcode in (0x9, 0xA):              # ping / pong -> ignore
                continue
            return payload.decode(errors="ignore")

    def close(self):
        try:
            self.sock.close()
        except Exception:
            pass


class _WebOSSession:
    """One SSAP session: the control socket plus a lazily-opened pointer socket
    for button presses. Not internally locked — callers serialize via
    WEBOS_LOCK."""

    def __init__(self, host):
        self.ws = _WebOSWS("wss://%s:%d/" % (host, WEBOS_PORT))
        self._id = 0
        self.pointer = None

    def _send(self, obj):
        self._id += 1
        obj["id"] = "cs_%d" % self._id
        self.ws.send_text(json.dumps(obj))
        return obj["id"]

    def register(self, client_key, timeout=60):
        """Send the register handshake; return (client_key, prompted). A valid
        client_key registers silently; otherwise the TV shows an Accept prompt
        and the returned key must be persisted."""
        payload = json.loads(_WEBOS_REGISTER_JSON)
        if client_key:
            payload["client-key"] = client_key
        self._send({"type": "register", "payload": payload})
        prompted = False
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            msg = json.loads(self.ws.recv_text())
            if msg.get("payload", {}).get("pairingType") == "PROMPT":
                prompted = True
            elif msg.get("type") == "registered":
                return msg["payload"]["client-key"], prompted
            elif msg.get("type") == "error":
                raise IOError(msg.get("error", "register failed"))
        raise IOError("pairing timed out")

    def request(self, uri, payload=None, timeout=6):
        obj = {"type": "request", "uri": uri}
        if payload is not None:
            obj["payload"] = payload
        rid = self._send(obj)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            msg = json.loads(self.ws.recv_text())
            if msg.get("id") == rid:
                if msg.get("type") == "error":
                    raise IOError(msg.get("error", "ssap error"))
                return msg.get("payload", {})
        raise IOError("ssap request timed out: %s" % uri)

    def button(self, name):
        if self.pointer is None:
            p = self.request(
                "ssap://com.webos.service.networkinput/getPointerInputSocket")
            path = p.get("socketPath")
            if not path:
                raise IOError("no pointer socket path")
            self.pointer = _WebOSWS(path)
        self.pointer.send_text("type:button\nname:%s\n\n" % name)

    def close(self):
        if self.pointer:
            self.pointer.close()
        self.ws.close()


WEBOS = None            # active _WebOSSession, or None until first use
WEBOS_LOCK = threading.Lock()
_WEBOS_MOCK = False
# Last mute state we applied. webOS reports muted=None when no audio session is
# active (e.g. the home screen), so a read-then-invert toggle would re-mute
# forever; we fall back to this tracked value when the TV can't report.
_WEBOS_LAST_MUTE = False


def set_webos(mock):
    """Prepare the webos backend. In --mock it is always 'available' and ops are
    logged (no socket). Real availability is decided by config (see
    webos_available); the socket is opened lazily on first use, not here."""
    global WEBOS, _WEBOS_MOCK
    _WEBOS_MOCK = mock
    if WEBOS is not None:
        WEBOS.close()
    WEBOS = None
    # (Re)arm the on-TV text-focus watcher for the new config (no-op in --mock
    # or when unpaired). Retires any prior watcher via the generation bump.
    start_webos_ime_watch()


def webos_available():
    """True when the webos backend can serve requests: --mock, or config named a
    host and a client_key is present (i.e. the TV has been paired)."""
    if _WEBOS_MOCK:
        return True
    return bool(CONFIG_WEBOS and CONFIG_WEBOS.get("client_key"))


def _webos_conn():
    """Return a live registered _WebOSSession, (re)connecting as needed. Caller
    MUST hold WEBOS_LOCK."""
    global WEBOS
    if WEBOS is None:
        sess = _WebOSSession(CONFIG_WEBOS["host"])
        sess.register(CONFIG_WEBOS.get("client_key"))
        WEBOS = sess
    return WEBOS


def _webos_result(start, ok, note):
    return {"ok": ok, "exit_code": 0 if ok else -1,
            "stdout": note if ok else "", "stderr": "" if ok else note,
            "duration_ms": int((time.monotonic() - start) * 1000)}


def _webos_do(fn):
    """Run fn(session) under the lock, with one reconnect+retry on a socket
    error (the TV drops idle sockets and may have rebooted). ActionResult."""
    global WEBOS
    start = time.monotonic()
    with WEBOS_LOCK:
        for attempt in (1, 2):
            try:
                return _webos_result(start, True, fn(_webos_conn()) or "ok")
            except (IOError, OSError, ValueError, KeyError) as e:
                if WEBOS is not None:
                    WEBOS.close()
                WEBOS = None                      # force reconnect on retry
                if attempt == 2:
                    return _webos_result(
                        start, False, "%s: %s" % (e.__class__.__name__, e))


def real_webos(op):
    """Dispatch a unified TV op. power_on is Wake-on-LAN (the TV is
    unreachable when off); mute toggles; the rest are SSAP calls."""
    if op == "power_on":
        return _webos_wol()
    if op == "mute":
        def toggle(s):
            global _WEBOS_LAST_MUTE
            reported = s.request("ssap://audio/getVolume").get("muted")
            muted = _WEBOS_LAST_MUTE if reported is None else bool(reported)
            _WEBOS_LAST_MUTE = not muted
            s.request("ssap://audio/setMute", {"mute": _WEBOS_LAST_MUTE})
            return "mute -> %s" % _WEBOS_LAST_MUTE
        return _webos_do(toggle)
    uri_payload = _WEBOS_OP_URI.get(op)
    if uri_payload is None:
        return _webos_result(time.monotonic(), False, "unsupported op %s" % op)
    uri, payload = uri_payload
    return _webos_do(lambda s: (s.request(uri, payload), op)[1])


def real_webos_key(k):
    """Send one factory-remote key (PANEL_KEYS vocabulary) as a pointer button."""
    name = _WEBOS_KEYS.get(k)
    if name is None:
        return _webos_result(time.monotonic(), False, "unknown key %s" % k)
    return _webos_do(lambda s: (s.button(name), "key %s" % k)[1])


def real_webos_text(text):
    """Insert text into the focused webOS field via the IME."""
    return _webos_do(lambda s: (s.request(
        "ssap://com.webos.service.ime/insertText",
        {"text": text, "replace": 0}), "text (%d chars)" % len(text))[1])


def _webos_wol():
    """Wake-on-LAN magic packet to webos.mac. power_on has no SSAP form (a TV
    that is off has no live socket), so WoL is the only wake path; it works only
    when the TV has 'Mobile TV On'/'Quick Start+' enabled."""
    start = time.monotonic()
    mac = (CONFIG_WEBOS or {}).get("mac")
    if not mac:
        return _webos_result(start, False, "no webos.mac configured for wake")
    try:
        raw = bytes.fromhex(mac.replace(":", "").replace("-", ""))
        if len(raw) != 6:
            raise ValueError("mac must be 6 bytes")
        packet = b"\xff" * 6 + raw * 16
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            s.sendto(packet, ("255.255.255.255", 9))
        finally:
            s.close()
        return _webos_result(start, True, "wol -> %s" % mac)
    except (ValueError, OSError) as e:
        return _webos_result(start, False, "wol failed: %s" % e)


def mock_webos(op):
    """--mock stand-in: log the op, open no socket, succeed."""
    time.sleep(0.05)
    print("[webos] %s" % op, flush=True)
    return {"ok": True, "exit_code": 0, "stdout": "[mock webos] %s\n" % op,
            "stderr": "", "duration_ms": 50}


# ---- webOS on-TV text-focus push (feeds the app's auto-keyboard) -----------
# LG's mobile remote learns when a TV text field is focused by SUBSCRIBING to
# ssap://com.webos.service.ime/registerRemoteKeyboard: the TV pushes a frame
# whenever input focus opens or closes (payload.currentWidget.focus). We mirror
# that here on a DEDICATED SSAP socket (the request/response session is
# serialised + dropped when idle, so it can't host a long-lived subscription)
# and relay each transition to the connected phones over the gamepad socket as
# {"t":"input_focus","open":bool,"value":str}. The app then pops its text sheet
# so the user types on the phone. Best-effort: any socket error just reconnects
# with backoff, and it advertises via the tv_info `text_focus_push` cap so the
# app only auto-pops where this actually fires (webOS today).
_WEBOS_IME_URI = "ssap://com.webos.service.ime/registerRemoteKeyboard"
# Longer than the request/response default: a focused-field subscription idles
# for minutes between transitions (webOS WS pings keep the socket warm).
_WEBOS_IME_TIMEOUT = 30
# Monotonic generation: bumped by every set_webos() so a re-pair (or teardown)
# retires any running watcher without needing to reach into its blocked recv.
_WEBOS_IME_GEN = 0


def _webos_ime_text(cw):
    """Best-effort current field text from a registerRemoteKeyboard widget.
    webOS rarely echoes existing content on this channel, so this is usually
    "" — the app treats the sheet as empty then, which is correct."""
    for k in ("focusText", "text", "value", "inputText"):
        v = cw.get(k)
        if isinstance(v, str):
            return v
    return ""


def start_webos_ime_watch():
    """(Re)start the IME focus watcher. Bumping the generation stops any prior
    watcher; a new daemon thread starts only for a real, paired webOS TV (never
    in --mock, which has no socket). Call after any set_webos()."""
    global _WEBOS_IME_GEN
    _WEBOS_IME_GEN += 1
    if _WEBOS_MOCK or not webos_available():
        return
    gen = _WEBOS_IME_GEN
    threading.Thread(target=_webos_ime_watch, args=(gen,), daemon=True,
                     name="webos-ime").start()


def _webos_ime_watch(gen):
    """Hold one registerRemoteKeyboard subscription open and broadcast focus
    transitions to the phones. Runs until its generation is superseded; any
    error reconnects with capped backoff. Never raises out of the thread."""
    backoff = 2
    logged = False                            # log an outage once, not per retry
    while gen == _WEBOS_IME_GEN:
        sess = None
        try:
            sess = _WebOSSession(CONFIG_WEBOS["host"])
            sess.ws.sock.settimeout(_WEBOS_IME_TIMEOUT)
            sess.register(CONFIG_WEBOS.get("client_key"))
            sub_id = sess._send({"type": "subscribe", "uri": _WEBOS_IME_URI})
            backoff = 2                       # a clean connect resets backoff
            logged = False
            last_open = None
            while gen == _WEBOS_IME_GEN:
                try:
                    msg = json.loads(sess.ws.recv_text())
                except socket.timeout:
                    continue                  # idle field; keep the socket open
                if msg.get("id") != sub_id:
                    continue                  # register echo / unrelated frame
                if msg.get("type") == "error":
                    raise IOError(msg.get("error", "ime subscription error"))
                cw = (msg.get("payload") or {}).get("currentWidget")
                if not isinstance(cw, dict) or "focus" not in cw:
                    continue
                open_ = bool(cw.get("focus"))
                if open_ == last_open:
                    continue                  # de-dupe repeated same-state pushes
                last_open = open_
                if gen != _WEBOS_IME_GEN:
                    break
                if open_:
                    _gamepad_broadcast({"t": "input_focus", "open": True,
                                        "value": _webos_ime_text(cw)})
                else:
                    _gamepad_broadcast({"t": "input_focus", "open": False})
        except (IOError, OSError, ValueError, KeyError) as e:
            if not logged:
                print("[webos-ime] subscription paused (%s: %s); retrying"
                      % (e.__class__.__name__, e), flush=True)
                logged = True
        finally:
            if sess is not None:
                sess.close()
        if gen != _WEBOS_IME_GEN:
            break
        time.sleep(backoff)                   # TV asleep / network blip
        backoff = min(backoff * 2, 30)


def webos_pair(host, timeout=60):
    """Open a fresh session to <host> (the TV shows an Accept prompt) and return
    the granted client_key. Raises IOError on rejection/timeout. The caller
    persists host+key to config so later sessions register silently."""
    sess = _WebOSSession(host)
    try:
        client_key, _prompted = sess.register(
            (CONFIG_WEBOS or {}).get("client_key"), timeout=timeout)
        return client_key
    finally:
        sess.close()


def _webos_save(host, client_key, mac=None):
    """Persist the paired webOS config to CONFIG_PATH atomically (same temp-file
    + os.replace pattern as the launcher writer) and update CONFIG_WEBOS. Holds
    CONFIG_LOCK so a concurrent config rewrite can't clobber it. The caller
    refreshes set_webos/set_caps afterwards."""
    cfg = {"host": host, "client_key": client_key}
    if mac:
        cfg["mac"] = mac
    global CONFIG_WEBOS
    with CONFIG_LOCK:
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                raw = json.load(f)
        except (OSError, ValueError):
            raw = None
        if not isinstance(raw, dict):
            raw = {"units": [{"name": n, "scope": s} for n, s in WATCHLIST]}
        raw["webos"] = cfg
        _write_config_atomic(raw)
        CONFIG_WEBOS = cfg
    set_tv_active("webos")


# ---- shared helpers for the network TV backends ---------------------------
def _wol_send(mac):
    """Send a Wake-on-LAN magic packet to <mac> (broadcast :9). ActionResult.
    Shared by the network TV backends: a TV that is off has no live socket, so
    WoL is the only way to power it on (needs the TV's fast-wake setting on)."""
    start = time.monotonic()
    if not mac:
        return _webos_result(start, False, "no mac configured for wake")
    try:
        raw = bytes.fromhex(mac.replace(":", "").replace("-", ""))
        if len(raw) != 6:
            raise ValueError("mac must be 6 bytes")
        packet = b"\xff" * 6 + raw * 16
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            s.sendto(packet, ("255.255.255.255", 9))
        finally:
            s.close()
        return _webos_result(start, True, "wol -> %s" % mac)
    except (ValueError, OSError) as e:
        return _webos_result(start, False, "wol failed: %s" % e)


def set_tv_active(brand):
    """Persist which paired TV the box should drive. None clears the choice and
    restores the priority chain.

    Called on every successful pair as well as from the picker: pairing a TV is
    an unambiguous statement that you want to use it, and without this a second
    paired TV stayed silently unreachable behind a higher-priority brand."""
    global CONFIG_TV_ACTIVE
    with CONFIG_LOCK:
        _config_set_field("tv_active", brand)
        CONFIG_TV_ACTIVE = brand
    return brand


def _config_set_field(field, value):
    """Read-modify-write CONFIG_PATH, setting top-level <field> = value, via the
    same atomic temp-file + os.replace pattern as the launcher writer. Caller
    MUST hold CONFIG_LOCK."""
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError):
        raw = None
    if not isinstance(raw, dict):
        raw = {"units": [{"name": n, "scope": s} for n, s in WATCHLIST]}
    raw[field] = value
    _write_config_atomic(raw)


# ---- Samsung backend (Tizen Smart TVs, WS remote over the stdlib WebSocket) -
# Samsung Tizen TVs expose a WebSocket remote at
# wss://<host>:8002/api/v2/channels/samsung.remote.control?name=<b64>[&token=].
# It reuses the _WebOSWS transport built for webOS (self-signed cert, same RFC
# 6455 framing) — only the message schema differs, so no new dependency
# (samsungtvws was the protocol oracle; nothing from it ships). Pre-2016 sets
# use plaintext ws://<host>:8001 and are not handled.
#
# Pairing: the first connect (no token) raises an Allow prompt on the TV; once
# accepted, the TV's ms.channel.connect event carries a token that the pairing
# endpoint persists (config.json samsung.token) for silent reconnects. Keys are
# fire-and-forget ms.remote.control commands. power_off is KEY_POWER (a toggle);
# power_ON is a Wake-on-LAN magic packet to samsung.mac.
SAMSUNG_PORT = 8002
_SAMSUNG_NAME_B64 = base64.b64encode(b"Couchside").decode()

# Unified TV op -> Samsung key. KEY_MUTE is itself a toggle (no state tracking);
# power_on is Wake-on-LAN, not a key.
_SAMSUNG_OP_KEY = {
    "power_off": "KEY_POWER",
    "volume_up": "KEY_VOLUP",
    "volume_down": "KEY_VOLDOWN",
    "mute": "KEY_MUTE",
}

# Factory-remote key (shared PANEL_KEYS/_WEBOS_KEYS vocabulary) -> Samsung code.
_SAMSUNG_KEYS = {
    "up": "KEY_UP", "down": "KEY_DOWN", "left": "KEY_LEFT", "right": "KEY_RIGHT",
    "ok": "KEY_ENTER", "menu": "KEY_MENU", "home": "KEY_HOME", "back": "KEY_RETURN",
    "exit": "KEY_EXIT", "info": "KEY_INFO", "play": "KEY_PLAY", "pause": "KEY_PAUSE",
    "stop": "KEY_STOP", "rewind": "KEY_REWIND", "fast_forward": "KEY_FF",
    "source": "KEY_SOURCE",   # opens the Tizen source/input menu
}


class _SamsungSession:
    """One Tizen WS remote session. After the ms.channel.connect handshake the
    socket accepts fire-and-forget commands. Not internally locked — callers
    serialize via SAMSUNG_LOCK."""

    def __init__(self, host, token=None):
        url = ("wss://%s:%d/api/v2/channels/samsung.remote.control?name=%s"
               % (host, SAMSUNG_PORT, _SAMSUNG_NAME_B64))
        if token:
            url += "&token=" + token
        self.ws = _WebOSWS(url)
        self.token = token
        self._connect()

    def _connect(self, timeout=60):
        """Read events until the channel is authorized. Captures the token the
        TV grants on first pairing (or rotates)."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            msg = json.loads(self.ws.recv_text())
            event = msg.get("event")
            if event == "ms.channel.connect":
                tok = msg.get("data", {}).get("token")
                if tok:
                    self.token = str(tok)
                return
            if event == "ms.channel.unauthorized":
                raise IOError("authorization denied on the TV")
        raise IOError("Samsung authorization timed out")

    def send_key(self, key):
        self.ws.send_text(json.dumps({
            "method": "ms.remote.control",
            "params": {"Cmd": "Click", "DataOfCmd": key, "Option": "false",
                       "TypeOfRemote": "SendRemoteKey"}}))

    def send_text(self, text):
        enc = base64.b64encode(text.encode("utf-8")).decode("ascii")
        self.ws.send_text(json.dumps({
            "method": "ms.remote.control",
            "params": {"Cmd": enc, "DataOfCmd": "base64",
                       "TypeOfRemote": "SendInputString"}}))

    def close(self):
        self.ws.close()


SAMSUNG = None            # active _SamsungSession, or None until first use
SAMSUNG_LOCK = threading.Lock()
_SAMSUNG_MOCK = False


def set_samsung(mock):
    """Prepare the Samsung backend (mirrors set_webos)."""
    global SAMSUNG, _SAMSUNG_MOCK
    _SAMSUNG_MOCK = mock
    if SAMSUNG is not None:
        SAMSUNG.close()
    SAMSUNG = None


def samsung_available():
    """True in --mock, or when config named a host and a token is present (i.e.
    the TV has been paired)."""
    if _SAMSUNG_MOCK:
        return True
    return bool(CONFIG_SAMSUNG and CONFIG_SAMSUNG.get("token"))


def _samsung_conn():
    """Return a live connected _SamsungSession. Caller MUST hold SAMSUNG_LOCK."""
    global SAMSUNG
    if SAMSUNG is None:
        SAMSUNG = _SamsungSession(CONFIG_SAMSUNG["host"],
                                  CONFIG_SAMSUNG.get("token"))
    return SAMSUNG


def _samsung_do(fn):
    """Run fn(session) under the lock, with one reconnect+retry. ActionResult."""
    global SAMSUNG
    start = time.monotonic()
    with SAMSUNG_LOCK:
        for attempt in (1, 2):
            try:
                return _webos_result(start, True, fn(_samsung_conn()) or "ok")
            except (IOError, OSError, ValueError, KeyError) as e:
                if SAMSUNG is not None:
                    SAMSUNG.close()
                SAMSUNG = None
                if attempt == 2:
                    return _webos_result(
                        start, False, "%s: %s" % (e.__class__.__name__, e))


def real_samsung(op):
    """Dispatch a unified TV op. power_on is Wake-on-LAN; the rest are keys."""
    if op == "power_on":
        return _wol_send((CONFIG_SAMSUNG or {}).get("mac"))
    key = _SAMSUNG_OP_KEY.get(op)
    if key is None:
        return _webos_result(time.monotonic(), False, "unsupported op %s" % op)
    return _samsung_do(lambda s: (s.send_key(key), op)[1])


def real_samsung_key(k):
    """Send one factory-remote key (PANEL_KEYS vocabulary) as a Tizen key."""
    code = _SAMSUNG_KEYS.get(k)
    if code is None:
        return _webos_result(time.monotonic(), False, "unknown key %s" % k)
    return _samsung_do(lambda s: (s.send_key(code), "key %s" % k)[1])


def real_samsung_text(text):
    """Send text to a focused on-TV field (Tizen SendInputString)."""
    return _samsung_do(
        lambda s: (s.send_text(text), "text (%d chars)" % len(text))[1])


def mock_samsung(op):
    """--mock stand-in: log the op, open no socket, succeed."""
    time.sleep(0.05)
    print("[samsung] %s" % op, flush=True)
    return {"ok": True, "exit_code": 0, "stdout": "[mock samsung] %s\n" % op,
            "stderr": "", "duration_ms": 50}


def samsung_pair(host, timeout=60):
    """Connect without a saved token so the TV shows an Allow prompt; return the
    token the TV grants once the user accepts. Raises IOError on rejection or
    timeout. The caller persists host+token to config for silent reconnects."""
    sess = _SamsungSession(host, (CONFIG_SAMSUNG or {}).get("token"))
    try:
        if not sess.token:
            raise IOError("TV did not grant a token")
        return sess.token
    finally:
        sess.close()


def _samsung_save(host, token, mac=None):
    """Persist the paired Samsung config to CONFIG_PATH atomically and update
    CONFIG_SAMSUNG. Holds CONFIG_LOCK."""
    cfg = {"host": host, "token": token}
    if mac:
        cfg["mac"] = mac
    global CONFIG_SAMSUNG
    with CONFIG_LOCK:
        _config_set_field("samsung", cfg)
        CONFIG_SAMSUNG = cfg
    set_tv_active("samsung")


# ---- Roku backend (ECP over plain HTTP) -----------------------------------
# Roku devices expose the External Control Protocol (ECP) as an unauthenticated
# HTTP service on port 8060 — no pairing, no token, no WebSocket. Key presses
# are POST /keypress/<KEY>; power on/off are ECP keys too (Roku TVs stay
# reachable in standby, so unlike webOS/Samsung there is no Wake-on-LAN).
# Stateless: each op is a one-shot POST, so there is no session or lock.
# Config-driven; a reachable host is enough (nothing to pair).
ROKU_PORT = 8060

# Unified TV op -> ECP key. Roku TVs wake over the network, so power_on is the
# PowerOn key (not Wake-on-LAN); mute (VolumeMute) self-toggles.
_ROKU_OP_KEY = {
    "power_off": "PowerOff", "power_on": "PowerOn",
    "volume_up": "VolumeUp", "volume_down": "VolumeDown", "mute": "VolumeMute",
}

# Factory-remote key (shared vocabulary) -> ECP key. Roku has no distinct
# pause/stop (Play toggles) and no menu (Info is the "*" options key).
_ROKU_KEYS = {
    "up": "Up", "down": "Down", "left": "Left", "right": "Right", "ok": "Select",
    "menu": "Info", "home": "Home", "back": "Back", "exit": "Home", "info": "Info",
    "play": "Play", "pause": "Play", "stop": "Play", "rewind": "Rev",
    "fast_forward": "Fwd",
}


def _roku_tag(xml, tag):
    """Extract <tag>...</tag> text from a Roku ECP XML blob, or None."""
    open_t, close_t = "<%s>" % tag, "</%s>" % tag
    a = xml.find(open_t)
    if a < 0:
        return None
    a += len(open_t)
    b = xml.find(close_t, a)
    return xml[a:b].strip() if b > a else None


def _roku_post(host, path, timeout=4):
    """POST an empty body to a Roku ECP path. ActionResult-shaped."""
    start = time.monotonic()
    url = "http://%s:%d/%s" % (host, ROKU_PORT, path)
    try:
        req = urllib.request.Request(url, data=b"", method="POST")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            r.read()
        return _webos_result(start, True, path)
    except urllib.error.HTTPError as e:
        # A reachable Roku that refuses control (403) has its "Control by mobile
        # apps" network access set below permissive. Flag it so the app can tell
        # the user exactly what to change on the TV.
        res = _webos_result(start, False, "HTTP %d: %s" % (e.code, e.reason))
        if e.code == 403:
            res["hint"] = "roku_control_disabled"
        return res
    except OSError as e:            # URLError etc. are OSError subclasses
        return _webos_result(start, False, "%s: %s" % (e.__class__.__name__, e))


ROKU_MOCK = False


def set_roku(mock):
    """Prepare the Roku backend. Nothing to open (stateless HTTP)."""
    global ROKU_MOCK
    ROKU_MOCK = mock


def roku_available():
    """True in --mock, or when config named a Roku host (no pairing needed)."""
    if ROKU_MOCK:
        return True
    return bool(CONFIG_ROKU and CONFIG_ROKU.get("host"))


def real_roku(op):
    """Dispatch a unified TV op to an ECP keypress (power on/off included)."""
    key = _ROKU_OP_KEY.get(op)
    if key is None:
        return _webos_result(time.monotonic(), False, "unsupported op %s" % op)
    return _roku_post(CONFIG_ROKU["host"], "keypress/" + key)


def real_roku_key(k):
    """Send one factory-remote key (PANEL_KEYS vocabulary) as an ECP keypress."""
    key = _ROKU_KEYS.get(k)
    if key is None:
        return _webos_result(time.monotonic(), False, "unknown key %s" % k)
    return _roku_post(CONFIG_ROKU["host"], "keypress/" + key)


def real_roku_text(text):
    """Type text via ECP Lit_ keypresses, one character at a time."""
    host = CONFIG_ROKU["host"]
    for ch in text:
        r = _roku_post(host, "keypress/Lit_" + quote(ch, safe=""))
        if not r["ok"]:
            return r
    return _webos_result(time.monotonic(), True, "text (%d chars)" % len(text))


def mock_roku(op):
    """--mock stand-in: log the op, touch no network, succeed."""
    time.sleep(0.02)
    print("[roku] %s" % op, flush=True)
    return {"ok": True, "exit_code": 0, "stdout": "[mock roku] %s\n" % op,
            "stderr": "", "duration_ms": 20}


def roku_add(host, timeout=4):
    """Verify a Roku answers ECP at <host> and return its friendly name (Roku
    needs no pairing). Raises IOError when it does not respond."""
    url = "http://%s:%d/query/device-info" % (host, ROKU_PORT)
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            xml = r.read().decode(errors="ignore")
    except OSError as e:
        raise IOError("Roku not reachable at %s: %s" % (host, e))
    return (_roku_tag(xml, "user-device-name")
            or _roku_tag(xml, "friendly-device-name")
            or _roku_tag(xml, "default-device-name")
            or _roku_tag(xml, "model-name") or host)


def _roku_save(host, name):
    """Persist the Roku config to CONFIG_PATH atomically and update CONFIG_ROKU."""
    cfg = {"host": host, "name": name}
    global CONFIG_ROKU
    with CONFIG_LOCK:
        _config_set_field("roku", cfg)
        CONFIG_ROKU = cfg
    set_tv_active("roku")


# ---- Android TV / Google TV backend (Remote v2, protobuf over TLS) --------
# Android TV Remote v2: length-prefixed protobuf over TLS on two ports — 6467
# (pairing) and 6466 (remote). The client authenticates with a self-signed TLS
# cert; pairing binds that cert to the TV via a 6-digit code shown on screen.
# Kept pure-stdlib: the cert is minted by shelling out to `openssl` (stdlib ssl
# can't create X.509), and the protobuf messages are hand-rolled (a varint +
# field-walker codec, no library). androidtvremote2 was the protocol oracle.
#
# Two things here are unlike the other network backends:
#  * Pairing is TWO-STEP over ONE held socket — the code arrives mid-session, so
#    pair_start opens + handshakes the pairing socket (TV shows the code) and
#    pair_finish computes the secret on the SAME socket. The socket is parked in
#    ANDROIDTV_PAIR between the two HTTP calls.
#  * The remote channel must answer periodic pings or the TV drops it, so it
#    runs a persistent connection with a background keepalive reader thread
#    (reconnect-per-key would add a ~1s handshake to every D-pad press).
ANDROIDTV_PAIR_PORT = 6467
ANDROIDTV_REMOTE_PORT = 6466
_ATV_FEATURES = 622                 # feature bitmask echoed in the remote config

# Unified TV op -> Android keycode. power_on has no in-band form (a TV that is
# off has dropped its network stack) — it is Wake-on-LAN when a mac is known,
# else a best-effort POWER key. mute (KEYCODE_MUTE) self-toggles.
_ATV_OP_KEY = {"power_off": 26, "volume_up": 24, "volume_down": 25, "mute": 91}
# Factory-remote key (shared vocabulary) -> Android keycode.
_ATV_KEYS = {
    "up": 19, "down": 20, "left": 21, "right": 22, "ok": 23, "menu": 82,
    "home": 3, "back": 4, "exit": 4, "play": 126, "pause": 127, "stop": 86,
    "rewind": 89, "fast_forward": 90,
    "source": 178,   # KEYCODE_TV_INPUT — opens the input picker on Google TV
}


# -- protobuf wire codec (namespaced) --
def _atv_varint(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        out.append(b | 0x80 if n else b)
        if not n:
            return bytes(out)


def _atv_read_varint(buf, pos):
    shift = result = 0
    while True:
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not b & 0x80:
            return result, pos
        shift += 7


def _atv_tag(field, wt):
    return _atv_varint((field << 3) | wt)


def _atv_fv(field, val):
    return _atv_tag(field, 0) + _atv_varint(val)          # varint field


def _atv_fb(field, data):
    return _atv_tag(field, 2) + _atv_varint(len(data)) + data  # length-delimited


def _atv_fs(field, s):
    return _atv_fb(field, s.encode())


def _atv_fm(field, data):
    return _atv_fb(field, data)                            # embedded message


def _atv_parse(buf):
    """protobuf bytes -> {field_number: [values]} (varint->int, len-delim->bytes)."""
    pos, fields = 0, {}
    while pos < len(buf):
        tag, pos = _atv_read_varint(buf, pos)
        f, wt = tag >> 3, tag & 7
        if wt == 0:
            v, pos = _atv_read_varint(buf, pos)
        elif wt == 2:
            ln, pos = _atv_read_varint(buf, pos)
            v = buf[pos:pos + ln]
            pos += ln
        elif wt == 1:
            v = buf[pos:pos + 8]
            pos += 8
        elif wt == 5:
            v = buf[pos:pos + 4]
            pos += 4
        else:
            raise ValueError("bad wire type %d" % wt)
        fields.setdefault(f, []).append(v)
    return fields


def _atv_outer(inner_field, inner):
    """OuterMessage: protocol_version(1)=2, status(2)=200, <inner>."""
    return _atv_fv(1, 2) + _atv_fv(2, 200) + _atv_fm(inner_field, inner)


# -- framing (varint length prefix) --
def _atv_send(sock, msg):
    sock.sendall(_atv_varint(len(msg)) + msg)


def _atv_recv(sock):
    lenbuf = b""
    while True:
        b = sock.recv(1)
        if not b:
            raise IOError("androidtv connection closed")
        lenbuf += b
        if not b[0] & 0x80:
            break
    ln, _ = _atv_read_varint(lenbuf, 0)
    data = b""
    while len(data) < ln:
        chunk = sock.recv(ln - len(data))
        if not chunk:
            raise IOError("androidtv closed mid-message")
        data += chunk
    return data


# -- cert (openssl CLI) + TLS --
def _atv_generate_cert():
    """Mint a self-signed client cert via openssl. Returns (cert_pem, key_pem,
    cert_path, key_path). stdlib ssl cannot create X.509, hence the shell-out —
    in-character with the agent's other tool shell-outs (cec-ctl, wpctl, ...)."""
    d = tempfile.mkdtemp(prefix="couchside-atv-")
    cp, kp = os.path.join(d, "cert.pem"), os.path.join(d, "key.pem")
    subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-keyout", kp,
         "-out", cp, "-days", "3650", "-nodes", "-subj", "/CN=couchside",
         "-addext", "subjectAltName=DNS:couchside",
         "-addext", "basicConstraints=CA:TRUE,pathlen:0"],
        check=True, capture_output=True)
    os.chmod(kp, 0o600)
    with open(cp) as f:
        cert_pem = f.read()
    with open(kp) as f:
        key_pem = f.read()
    return cert_pem, key_pem, cp, kp


def _atv_write_cert(cert_pem, key_pem):
    """Write PEM strings to a fresh temp dir; return (cert_path, key_path).
    ssl.load_cert_chain needs file paths, so config-stored PEM is materialized."""
    d = tempfile.mkdtemp(prefix="couchside-atv-")
    cp, kp = os.path.join(d, "cert.pem"), os.path.join(d, "key.pem")
    with open(cp, "w") as f:
        f.write(cert_pem)
    with open(kp, "w") as f:
        f.write(key_pem)
    os.chmod(kp, 0o600)
    return cp, kp


def _atv_modulus_pem(path):
    r = subprocess.run(["openssl", "x509", "-in", path, "-noout", "-modulus"],
                       check=True, capture_output=True, text=True)
    return r.stdout.strip().split("Modulus=")[1]


def _atv_modulus_der(der):
    r = subprocess.run(["openssl", "x509", "-inform", "DER", "-noout", "-modulus"],
                       input=der, capture_output=True)
    return r.stdout.decode().strip().split("Modulus=")[1]


def _atv_tls(host, port, cert_path, key_path, timeout=15):
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE               # TV serves a self-signed cert
    ctx.load_cert_chain(certfile=cert_path, keyfile=key_path)
    raw = socket.create_connection((host, port), timeout=timeout)
    s = ctx.wrap_socket(raw)
    s.settimeout(timeout)
    return s


# -- pairing (two-step, one held socket) --
ANDROIDTV_PAIR = None            # {sock, client_mod, server_mod, cert, key, host, expires}
ANDROIDTV_PAIR_LOCK = threading.Lock()


def androidtv_pair_start(host):
    """Open the pairing socket and handshake up to the point the TV shows its
    6-digit code. Parks the session in ANDROIDTV_PAIR for androidtv_pair_finish.
    Reuses the config cert if one exists (re-pair), else mints a fresh one."""
    global ANDROIDTV_PAIR
    with ANDROIDTV_PAIR_LOCK:
        if ANDROIDTV_PAIR:
            try:
                ANDROIDTV_PAIR["sock"].close()
            except Exception:
                pass
            ANDROIDTV_PAIR = None
        if CONFIG_ANDROIDTV and CONFIG_ANDROIDTV.get("cert"):
            cert_pem, key_pem = CONFIG_ANDROIDTV["cert"], CONFIG_ANDROIDTV["key"]
            cp, kp = _atv_write_cert(cert_pem, key_pem)
        else:
            cert_pem, key_pem, cp, kp = _atv_generate_cert()
        s = _atv_tls(host, ANDROIDTV_PAIR_PORT, cp, kp)
        server_mod = _atv_modulus_der(s.getpeercert(True))
        client_mod = _atv_modulus_pem(cp)
        enc = _atv_fv(1, 3) + _atv_fv(2, 6)       # encoding: HEX, 6 symbols
        _atv_send(s, _atv_outer(10, _atv_fs(1, "atvremote") + _atv_fs(2, "Couchside")))
        if 11 not in _atv_parse(_atv_recv(s)):
            raise IOError("no pairing_request_ack")
        _atv_send(s, _atv_outer(20, _atv_fm(1, enc) + _atv_fv(3, 1)))
        if 20 not in _atv_parse(_atv_recv(s)):
            raise IOError("no options")
        _atv_send(s, _atv_outer(30, _atv_fm(1, enc) + _atv_fv(2, 1)))
        if 31 not in _atv_parse(_atv_recv(s)):
            raise IOError("no configuration_ack")
        ANDROIDTV_PAIR = {"sock": s, "client_mod": client_mod,
                          "server_mod": server_mod, "cert": cert_pem,
                          "key": key_pem, "host": host,
                          "expires": time.monotonic() + 300}


def androidtv_pair_finish(code):
    """Complete pairing with the 6-hex-digit code from the TV. Returns
    (cert_pem, key_pem, host) for the caller to persist. Raises on a bad code."""
    global ANDROIDTV_PAIR
    with ANDROIDTV_PAIR_LOCK:
        p = ANDROIDTV_PAIR
        if not p or time.monotonic() > p["expires"]:
            ANDROIDTV_PAIR = None
            raise IOError("no active pairing session (call pair/start first)")
        code = (code or "").strip()
        if len(code) != 6:
            raise IOError("code must be 6 hex digits")
        try:
            bytes.fromhex(code)
        except ValueError:
            raise IOError("code must be hexadecimal")
        h = hashlib.sha256()
        h.update(bytes.fromhex(p["client_mod"]))
        h.update(bytes.fromhex("010001"))        # exponent 65537, 0-prefixed
        h.update(bytes.fromhex(p["server_mod"]))
        h.update(bytes.fromhex("010001"))
        h.update(bytes.fromhex(code[2:]))
        secret = h.digest()
        if secret[0] != int(code[0:2], 16):
            raise IOError("wrong pairing code")
        s = p["sock"]
        _atv_send(s, _atv_outer(40, _atv_fb(1, secret)))
        if 41 not in _atv_parse(_atv_recv(s)):
            raise IOError("pairing rejected by the TV")
        try:
            s.close()
        except Exception:
            pass
        ANDROIDTV_PAIR = None
        return p["cert"], p["key"], p["host"]


def _androidtv_save(host, cert_pem, key_pem, name=None, mac=None):
    """Persist the paired Android TV config atomically and update CONFIG_ANDROIDTV."""
    cfg = {"host": host, "cert": cert_pem, "key": key_pem}
    if name:
        cfg["name"] = name
    if mac:
        cfg["mac"] = mac
    global CONFIG_ANDROIDTV
    with CONFIG_LOCK:
        _config_set_field("androidtv", cfg)
        CONFIG_ANDROIDTV = cfg
    set_tv_active("androidtv")


# -- persistent remote session (keepalive) --
class _AndroidTVRemote:
    """One remote-channel connection with a background keepalive reader. Sends
    are serialized under `lock`; the reader thread only reads (and answers pings
    under the same lock). Reconnects lazily on the next send after a drop."""

    def __init__(self):
        self.sock = None
        self.lock = threading.Lock()
        self._active = None       # the socket the reader is bound to

    def _handshake(self, s):
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            f = _atv_parse(_atv_recv(s))
            if 1 in f:            # remote_configure -> reply with our device_info
                dev = (_atv_fv(3, 1) + _atv_fs(4, "1") + _atv_fs(5, "atvremote")
                       + _atv_fs(6, "1.0.0"))
                _atv_send(s, _atv_fm(1, _atv_fv(1, _ATV_FEATURES) + _atv_fm(2, dev)))
            elif 2 in f:          # remote_set_active
                _atv_send(s, _atv_fm(2, _atv_fv(1, _ATV_FEATURES)))
            elif 8 in f:          # ping during handshake
                v = _atv_parse(f[8][0]).get(1, [1])[0]
                _atv_send(s, _atv_fm(9, _atv_fv(1, v)))
            elif 40 in f:         # remote_start -> ready
                return
        raise IOError("androidtv remote handshake timed out")

    def _reader_loop(self, s):
        while self._active is s:
            try:
                f = _atv_parse(_atv_recv(s))
            except Exception:
                break
            if 8 in f:            # remote_ping_request -> remote_ping_response
                v = _atv_parse(f[8][0]).get(1, [1])[0]
                try:
                    with self.lock:
                        if self.sock is s:
                            _atv_send(s, _atv_fm(9, _atv_fv(1, v)))
                except Exception:
                    break
        with self.lock:
            if self.sock is s:
                self.sock = None
                self._active = None

    def _ensure(self):
        """Caller holds self.lock. Connect + handshake + start reader if needed."""
        if self.sock is not None:
            return
        cp, kp = _atv_write_cert(CONFIG_ANDROIDTV["cert"], CONFIG_ANDROIDTV["key"])
        s = _atv_tls(CONFIG_ANDROIDTV["host"], ANDROIDTV_REMOTE_PORT, cp, kp)
        self._handshake(s)
        self.sock = s
        self._active = s
        threading.Thread(target=self._reader_loop, args=(s,), daemon=True).start()

    def send_key(self, code):
        with self.lock:
            for attempt in (1, 2):
                try:
                    self._ensure()
                    # remote_key_inject(10){key_code(1), direction(2)=SHORT(3)}
                    _atv_send(self.sock, _atv_fm(10, _atv_fv(1, code) + _atv_fv(2, 3)))
                    return
                except (IOError, OSError, ssl.SSLError, ValueError):
                    self._close_locked()
                    if attempt == 2:
                        raise

    def _close_locked(self):
        self._active = None
        if self.sock is not None:
            try:
                self.sock.close()
            except Exception:
                pass
            self.sock = None

    def close(self):
        with self.lock:
            self._close_locked()


ANDROIDTV = None                 # active _AndroidTVRemote, or None
ANDROIDTV_LOCK = threading.Lock()
_ANDROIDTV_MOCK = False


def set_androidtv(mock):
    """Prepare the Android TV backend. Available in --mock, or when config has a
    paired cert+host. The remote connection is opened lazily on first use."""
    global ANDROIDTV, _ANDROIDTV_MOCK
    _ANDROIDTV_MOCK = mock
    if ANDROIDTV is not None:
        ANDROIDTV.close()
    ANDROIDTV = None


def androidtv_available():
    if _ANDROIDTV_MOCK:
        return True
    return bool(CONFIG_ANDROIDTV and CONFIG_ANDROIDTV.get("cert")
                and CONFIG_ANDROIDTV.get("host"))


def _androidtv_do(fn):
    """Run fn(remote) under the lock with one reconnect retry. ActionResult."""
    global ANDROIDTV
    start = time.monotonic()
    with ANDROIDTV_LOCK:
        if ANDROIDTV is None:
            ANDROIDTV = _AndroidTVRemote()
        try:
            return _webos_result(start, True, fn(ANDROIDTV) or "ok")
        except (IOError, OSError, ssl.SSLError, ValueError, KeyError) as e:
            return _webos_result(start, False, "%s: %s" % (e.__class__.__name__, e))


def real_androidtv(op):
    """Dispatch a unified TV op. power_on is Wake-on-LAN (or best-effort POWER);
    the rest are keycodes."""
    if op == "power_on":
        mac = (CONFIG_ANDROIDTV or {}).get("mac")
        if mac:
            return _wol_send(mac)
        return _androidtv_do(lambda r: (r.send_key(26), "power (best-effort)")[1])
    code = _ATV_OP_KEY.get(op)
    if code is None:
        return _webos_result(time.monotonic(), False, "unsupported op %s" % op)
    return _androidtv_do(lambda r: (r.send_key(code), op)[1])


def real_androidtv_key(k):
    """Send one factory-remote key (shared vocabulary) as an Android keycode."""
    code = _ATV_KEYS.get(k)
    if code is None:
        return _webos_result(time.monotonic(), False, "unknown key %s" % k)
    return _androidtv_do(lambda r: (r.send_key(code), "key %s" % k)[1])


def mock_androidtv(op):
    """--mock stand-in: log the op, open no socket, succeed."""
    time.sleep(0.05)
    print("[androidtv] %s" % op, flush=True)
    return {"ok": True, "exit_code": 0, "stdout": "[mock androidtv] %s\n" % op,
            "stderr": "", "duration_ms": 50}


# ---- VIDAA backend (Hisense TVs, MQTT over TLS) ---------------------------
# Hisense VIDAA TVs run an MQTT broker on port 36669 (the RemoteNOW app
# protocol). Keys are published to a sendkey topic. Kept pure-stdlib: a minimal
# hand-rolled MQTT 3.1.1 client (CONNECT + PUBLISH over TLS), no library. The
# default broker credentials work on most sets; a few newer models need a
# 4-digit authorize step which is not handled here. hisensetv was the oracle.
#
# Stateless like Roku: each key is a one-shot connect + publish + close (MQTT
# QoS-0 publish is fire-and-forget), so there is no session or keepalive thread.
VIDAA_PORT = 36669
_VIDAA_USER = "hisenseservice"
_VIDAA_PASS = "multimqttservice"
_VIDAA_DEVICE = "AA:BB:CC:DD:EE:FF$normal"      # arbitrary client-topic id

# Unified TV op -> VIDAA key. power_on = WoL/best-effort; KEY_MUTE self-toggles.
_VIDAA_OP_KEY = {"power_off": "KEY_POWER", "volume_up": "KEY_VOLUMEUP",
                 "volume_down": "KEY_VOLUMEDOWN", "mute": "KEY_MUTE"}
# Factory-remote key (shared vocabulary) -> VIDAA key (note back -> KEY_RETURNS).
_VIDAA_KEYS = {
    "up": "KEY_UP", "down": "KEY_DOWN", "left": "KEY_LEFT", "right": "KEY_RIGHT",
    "ok": "KEY_OK", "menu": "KEY_MENU", "home": "KEY_HOME", "back": "KEY_RETURNS",
    "exit": "KEY_EXIT", "play": "KEY_PLAY", "pause": "KEY_PAUSE", "stop": "KEY_STOP",
}


def _mqtt_str(s):
    b = s.encode()
    return struct.pack("!H", len(b)) + b


def _mqtt_rlen(n):
    """MQTT remaining-length varint (7 bits + continuation)."""
    out = bytearray()
    while True:
        b = n % 128
        n //= 128
        if n:
            b |= 0x80
        out.append(b)
        if not n:
            return bytes(out)


def _vidaa_connect(host, timeout=6):
    """Open a TLS MQTT connection to the VIDAA broker and CONNECT with the
    default credentials. Returns the ssl socket; raises on refusal."""
    ctx = ssl._create_unverified_context()
    raw = socket.create_connection((host, VIDAA_PORT), timeout=timeout)
    s = ctx.wrap_socket(raw)
    s.settimeout(timeout)
    cid = "couchside-%06x" % (int(time.monotonic() * 1000) & 0xFFFFFF)
    vh = _mqtt_str("MQTT") + bytes([0x04, 0xC2]) + struct.pack("!H", 60)
    body = vh + _mqtt_str(cid) + _mqtt_str(_VIDAA_USER) + _mqtt_str(_VIDAA_PASS)
    s.sendall(bytes([0x10]) + _mqtt_rlen(len(body)) + body)
    if s.recv(1)[0] != 0x20:                    # CONNACK type
        raise IOError("unexpected MQTT response")
    data = s.recv(s.recv(1)[0])
    if len(data) < 2 or data[1] != 0:
        raise IOError("MQTT connect refused (rc=%s)"
                      % (data[1] if len(data) > 1 else "?"))
    return s


def _vidaa_send_key(host, keyname):
    """Connect, publish one sendkey, close. ActionResult-shaped."""
    start = time.monotonic()
    try:
        s = _vidaa_connect(host)
        try:
            body = (_mqtt_str("/remoteapp/tv/remote_service/%s/actions/sendkey"
                              % _VIDAA_DEVICE) + keyname.encode())
            s.sendall(bytes([0x30]) + _mqtt_rlen(len(body)) + body)
        finally:
            try:
                s.close()
            except Exception:
                pass
        return _webos_result(start, True, keyname)
    except (IOError, OSError, ssl.SSLError) as e:
        return _webos_result(start, False, "%s: %s" % (e.__class__.__name__, e))


VIDAA_MOCK = False


def set_vidaa(mock):
    """Prepare the VIDAA backend. Nothing to open (stateless)."""
    global VIDAA_MOCK
    VIDAA_MOCK = mock


def vidaa_available():
    """True in --mock, or when config named a VIDAA host (no pairing)."""
    if VIDAA_MOCK:
        return True
    return bool(CONFIG_VIDAA and CONFIG_VIDAA.get("host"))


def real_vidaa(op):
    """Dispatch a unified TV op. power_on is WoL (or best-effort POWER)."""
    if op == "power_on":
        mac = (CONFIG_VIDAA or {}).get("mac")
        if mac:
            return _wol_send(mac)
        return _vidaa_send_key(CONFIG_VIDAA["host"], "KEY_POWER")
    key = _VIDAA_OP_KEY.get(op)
    if key is None:
        return _webos_result(time.monotonic(), False, "unsupported op %s" % op)
    return _vidaa_send_key(CONFIG_VIDAA["host"], key)


def real_vidaa_key(k):
    """Send one factory-remote key (shared vocabulary) as a VIDAA key."""
    key = _VIDAA_KEYS.get(k)
    if key is None:
        return _webos_result(time.monotonic(), False, "unknown key %s" % k)
    return _vidaa_send_key(CONFIG_VIDAA["host"], key)


def mock_vidaa(op):
    """--mock stand-in: log the op, open no socket, succeed."""
    time.sleep(0.03)
    print("[vidaa] %s" % op, flush=True)
    return {"ok": True, "exit_code": 0, "stdout": "[mock vidaa] %s\n" % op,
            "stderr": "", "duration_ms": 30}


def vidaa_add(host):
    """Verify a VIDAA TV answers the MQTT broker at <host> (no pairing). Returns
    the host as its label. Raises IOError when the broker refuses/unreachable."""
    s = _vidaa_connect(host)
    try:
        s.close()
    except Exception:
        pass
    return host


def _vidaa_save(host, name=None, mac=None):
    """Persist the VIDAA config to CONFIG_PATH atomically and update CONFIG_VIDAA."""
    cfg = {"host": host}
    if name:
        cfg["name"] = name
    if mac:
        cfg["mac"] = mac
    global CONFIG_VIDAA
    with CONFIG_LOCK:
        _config_set_field("vidaa", cfg)
        CONFIG_VIDAA = cfg
    set_tv_active("vidaa")


# ---- LAN TV discovery (mDNS + SSDP sweep) ---------------------------------
# GET /api/tv/discover runs a short multicast sweep FROM THE BOX and returns the
# TVs it can reach, so the app can offer a "scan" picker instead of making the
# user type an IP. The box is the right scanner: it is the machine that will
# actually control the TV (so anything found is guaranteed box-reachable), and
# it runs real multicast where phone mDNS is flaky. Pure stdlib, in character
# with the other hand-rolled protocols here.
#   Android/Google TV: mDNS PTR _androidtvremote2._tcp  (THE pairing service)
#   Samsung Tizen:     mDNS PTR _samsungmsf._tcp
#   Roku:              SSDP ST roku:ecp   (name via /query/device-info)
#   LG webOS:          SSDP, LG-identified responses  (friendlyName from UPnP)
# VIDAA has no standard discovery, so it is never listed (manual add stays).
_MDNS_ADDR = ("224.0.0.251", 5353)
_SSDP_ADDR = ("239.255.255.250", 1900)


def _mdns_query_pkt(service):
    pkt = struct.pack("!HHHHHH", 0, 0, 1, 0, 0, 0)  # 1 question, PTR/IN below
    for label in service.split("."):
        pkt += bytes([len(label)]) + label.encode()
    return pkt + b"\x00" + struct.pack("!HH", 12, 1)


def _dns_name(buf, pos):
    """Parse a (possibly compression-pointer) DNS name; return (name, next_pos)."""
    labels, jumped, nxt = [], False, pos
    for _ in range(128):
        ln = buf[pos]
        if ln == 0:
            pos += 1
            if not jumped:
                nxt = pos
            break
        if ln & 0xC0 == 0xC0:
            ptr = ((ln & 0x3F) << 8) | buf[pos + 1]
            if not jumped:
                nxt = pos + 2
            pos, jumped = ptr, True
            continue
        pos += 1
        labels.append(buf[pos:pos + ln].decode("utf-8", "replace"))
        pos += ln
    return ".".join(labels), nxt


def _parse_mdns(buf):
    """One mDNS packet -> (ptr_targets[], srv{name:(host,port)}, a{name:ip})."""
    ptr, srv, a = [], {}, {}
    try:
        qd, an, ns, ar = struct.unpack("!HHHH", buf[4:12])
        pos = 12
        for _ in range(qd):
            _, pos = _dns_name(buf, pos)
            pos += 4
        for _ in range(an + ns + ar):
            name, pos = _dns_name(buf, pos)
            rtype, _cls, _ttl, rdlen = struct.unpack("!HHIH", buf[pos:pos + 10])
            pos += 10
            if rtype == 12:                        # PTR
                tgt, _ = _dns_name(buf, pos)
                ptr.append(tgt)
            elif rtype == 33:                      # SRV -> host + port
                port = struct.unpack("!H", buf[pos + 4:pos + 6])[0]
                host, _ = _dns_name(buf, pos + 6)
                srv[name] = (host, port)
            elif rtype == 1 and rdlen == 4:        # A -> IPv4
                a[name] = ".".join(str(x) for x in buf[pos:pos + 4])
            pos += rdlen
    except Exception:
        pass                                       # a malformed packet is skipped
    return ptr, srv, a


def _mdns_socket():
    """A socket that can actually HEAR mDNS answers: bound to 5353 and joined to
    the group, sharing the port with whatever else is running (avahi).

    WHY THIS MATTERS -- measured, because the obvious fix does not work. A
    compliant responder sends its answer to the MULTICAST group, not back to the
    querier's ephemeral port. Querying from an ephemeral port therefore only
    ever finds devices that happen to answer unicast anyway. On a real network
    that silently split the results: Chromecast replied and was found, while an
    Android/Google TV advertising the very service we asked for
    (_androidtvremote2._tcp, "Conference Room") and an LG webOS TV were both
    invisible -- so "Scan for TVs" returned neither of the user's real TVs.

    Setting the QU (unicast-response) bit instead was tried FIRST and changed
    nothing: 0 replies with the bit set, 2 replies once bound to the group. Do
    not "simplify" this back to a QU bit.

    Returns (socket, joined). joined=False means the bind/join failed and the
    caller is falling back to the old ephemeral behaviour -- degraded, but the
    scan still finds unicast-answering devices instead of raising."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    # SO_REUSEPORT so this coexists with avahi/systemd-resolved already on 5353.
    # Multicast datagrams are delivered to EVERY socket joined to the group, so
    # sharing the port does not steal avahi's traffic.
    try:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
    except (AttributeError, OSError):
        pass
    joined = False
    try:
        s.bind(("", _MDNS_ADDR[1]))
        mreq = struct.pack("4sl", socket.inet_aton(_MDNS_ADDR[0]), socket.INADDR_ANY)
        s.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)
        joined = True
    except OSError:
        # Port unavailable (no SO_REUSEPORT, or a strict responder holds it):
        # fall back to an unbound socket rather than losing discovery entirely.
        try:
            s.close()
        except OSError:
            pass
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
    except OSError:
        pass
    return s, joined


def _mdns_discover(service, timeout=2.5):
    """Return [{name, host}] for a mDNS service PTR (e.g. _androidtvremote2._tcp
    .local). Best-effort; empty on any failure."""
    s, _joined = _mdns_socket()
    s.settimeout(0.5)
    inst, srv_all, a_all = set(), {}, {}
    try:
        s.sendto(_mdns_query_pkt(service), _MDNS_ADDR)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                # Bound to 5353 we now see every responder's traffic, not just
                # replies to our own question, so allow for full-size records.
                data, _ = s.recvfrom(9000)
            except socket.timeout:
                continue
            except OSError:
                break
            ptr, srv, a = _parse_mdns(data)
            srv_all.update(srv)
            a_all.update(a)
            # `endswith` alone also matches the SERVICE name itself, which is
            # a record we now receive (bound to 5353 we see service-level PTRs,
            # not just answers to our own question). That leaked
            # "_androidtvremote2._tcp.local" into the results as if it were a
            # TV. Require a real instance label underneath it.
            for n in list(ptr) + list(srv):
                if n != service and n.endswith("." + service):
                    inst.add(n)
    finally:
        s.close()
    out = []
    for name in inst:
        host, _port = srv_all.get(name, (None, None))
        ip = a_all.get(host) if host else None
        if not ip and len(a_all) == 1:             # single host seen: use it
            ip = next(iter(a_all.values()))
        if not ip:
            continue
        label = name[: -len(service) - 1].rstrip(".") or name
        # `target` is the SRV target hostname (e.g. LGwebOSTV.local). Callers
        # need it to identify the DEVICE: an instance label is a user-chosen
        # room name ("Conference Room Display") and cannot be matched on.
        out.append({"name": label, "host": ip, "target": host or ""})
    return out


def _ssdp_search(st, timeout=2.5):
    """M-SEARCH for <st>; return response header dicts (with _ip). Best-effort."""
    msg = ("M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\n"
           'MAN: "ssdp:discover"\r\nMX: 1\r\nST: %s\r\n\r\n' % st).encode()
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.settimeout(0.5)
    res = []
    try:
        s.sendto(msg, _SSDP_ADDR)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                data, addr = s.recvfrom(2048)
            except socket.timeout:
                continue
            except OSError:
                break
            h = {"_ip": addr[0]}
            for line in data.decode("utf-8", "replace").split("\r\n")[1:]:
                if ":" in line:
                    k, v = line.split(":", 1)
                    h[k.strip().lower()] = v.strip()
            res.append(h)
    finally:
        s.close()
    return res


def _discover_http(url, timeout=2.0):
    try:
        import urllib.request
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.read().decode("utf-8", "replace")
    except Exception:
        return ""


def _roku_name(ip):
    xml = _discover_http("http://%s:8060/query/device-info" % ip)
    for tag in ("user-device-name", "friendly-device-name", "default-device-name"):
        m = re.search(r"<%s>(.*?)</%s>" % (tag, tag), xml)
        if m and m.group(1).strip():
            return m.group(1).strip()
    return "Roku"


def _discover_androidtv():
    # _androidtvremote2._tcp is the pairing service (what we control); its
    # instance name is usually the friendly TV name. _googlecast._tcp is queried
    # only to fill in a blank/generic name (some firmwares report one there).
    tvs = _mdns_discover("_androidtvremote2._tcp.local")
    cast = {c["host"]: c["name"]
            for c in _mdns_discover("_googlecast._tcp.local", timeout=1.5)
            if c.get("name")}
    out = []
    for t in tvs:
        name = t["name"]
        if (not name or name == t["host"]) and cast.get(t["host"]):
            name = cast[t["host"]]
        out.append({"brand": "androidtv", "name": name or "Android TV",
                    "host": t["host"]})
    return out


def _discover_samsung():
    return [{"brand": "samsung", "name": t["name"], "host": t["host"]}
            for t in _mdns_discover("_samsungmsf._tcp.local")]


def _discover_roku():
    out, seen = [], set()
    for r in _ssdp_search("roku:ecp"):
        ip = r.get("_ip")
        if ip and ip not in seen:
            seen.add(ip)
            out.append({"brand": "roku", "name": _roku_name(ip), "host": ip})
    return out


def _discover_webos():
    """LG webOS via SSDP: filter ssdp:all to LG-identified responses and pull the
    friendlyName from the UPnP device description."""
    out, seen = [], set()
    for r in _ssdp_search("ssdp:all", timeout=2.5):
        ip = r.get("_ip")
        blob = (r.get("server", "") + r.get("usn", "") + r.get("location", "")).lower()
        if not ip or ip in seen or not re.search(r"\blg\b|webos|lge", blob):
            continue
        seen.add(ip)
        name = ""
        loc = r.get("location", "")
        if loc:
            m = re.search(r"<friendlyName>(.*?)</friendlyName>", _discover_http(loc))
            if m:
                name = m.group(1).strip()
        out.append({"brand": "webos", "name": name or "LG webOS", "host": ip})

    # SSDP alone misses real TVs. Measured on a live network: an 85" consumer
    # webOS set answered no SSDP search at all, so "Scan for TVs" returned only
    # a commercial signage panel -- the app then pre-filled that wrong target
    # and pairing failed with an opaque TLS timeout, because a signage panel
    # accepts TCP on 3001 without ever completing a handshake.
    #
    # Modern LG sets advertise AirPlay over mDNS, where that same TV showed up
    # immediately as "Conference Room Display" (LGwebOSTV.local). Its mDNS
    # hostname is the reliable tell -- the AirPlay instance name is a
    # user-chosen room label, and plenty of non-LG devices serve _airplay._tcp.
    for t in _mdns_discover("_airplay._tcp.local", timeout=2.0):
        ip, host = t.get("host"), (t.get("target") or "")
        if not ip or ip in seen:
            continue
        if not re.search(r"lgwebostv|webos", host.lower()):
            continue
        seen.add(ip)
        out.append({"brand": "webos", "name": t.get("name") or "LG webOS", "host": ip})
    return out


# LG COMMERCIAL / signage control port. Commercial panels expose LG's
# documented RS-232 command set over TCP here; consumer sets do not open it.
LG_COMMERCIAL_PORT = 9761


def _port_open(host, port, timeout=1.5):
    """True if a TCP connect succeeds. An OPEN port is weak evidence on its own
    -- see identify_tv, where a commercial LG panel opens 3001 and then never
    completes a TLS handshake."""
    try:
        s = socket.create_connection((host, port), timeout=timeout)
        s.close()
        return True
    except OSError:
        return False


def _tls_completes(host, port, timeout=4.0):
    """True if a TLS handshake actually COMPLETES (self-signed is fine).

    This is the check that separates a consumer webOS TV from an LG commercial
    panel, and it cannot be replaced by a port check. Measured on real hardware:
    the panel accepts TCP on 3001 in 6ms and then never handshakes, so the
    pairing attempt died with "_ssl.c:1063: The handshake operation timed out"
    -- an error that told the user nothing about the actual problem, which was
    that they had aimed Couchside at the wrong device entirely."""
    try:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        raw = socket.create_connection((host, port), timeout=timeout)
        raw.settimeout(timeout)
        with ctx.wrap_socket(raw, server_hostname=host):
            return True
    except Exception:
        return False


def identify_tv(host):
    """What KIND of device is at this address?

    {"brand": <id or None>, "label": str, "supported": bool, "reason": str}

    Exists so a wrong target produces an explanation instead of a raw socket
    error. Ordered most-specific first: the HTTP APIs answer with a real device
    name, and the LG commercial check must precede the consumer webOS check
    because both open 3001.

    A handful of connects to ONE address the user typed -- not a sweep."""
    host = (host or "").strip()
    if not host:
        return {"brand": None, "label": "", "supported": False,
                "reason": "no address given"}

    # Roku: unauthenticated ECP, names itself.
    if _port_open(host, ROKU_PORT):
        xml = _discover_http("http://%s:%d/query/device-info" % (host, ROKU_PORT))
        m = re.search(r"<friendly-device-name>(.*?)</friendly-device-name>", xml)
        if m or "<device-info>" in xml:
            return {"brand": "roku", "label": (m.group(1).strip() if m else "Roku"),
                    "supported": True, "reason": "Roku ECP"}

    # Samsung Tizen: the v2 API returns a device block.
    if _port_open(host, SAMSUNG_PORT):
        return {"brand": "samsung", "label": "Samsung", "supported": True,
                "reason": "Samsung Tizen remote port"}

    # LG COMMERCIAL before consumer: a signage panel also opens 3001, but its
    # 3001 never completes TLS. 9761 is the tell and it is unambiguous.
    if _port_open(host, LG_COMMERCIAL_PORT):
        return {"brand": "lg_commercial", "label": "LG commercial display",
                "supported": False,
                "reason": "This is an LG commercial/signage display, not a "
                          "consumer webOS TV. It does not support webOS "
                          "pairing."}

    # Consumer webOS: TCP alone is not enough, the handshake must complete.
    if _port_open(host, WEBOS_PORT):
        if _tls_completes(host, WEBOS_PORT):
            return {"brand": "webos", "label": "LG webOS", "supported": True,
                    "reason": "webOS SSAP"}
        return {"brand": None, "label": "unknown device", "supported": False,
                "reason": "Port %d is open but it is not answering as a webOS "
                          "TV (the secure handshake times out). This is usually "
                          "a commercial display or another device entirely."
                          % WEBOS_PORT}

    if _port_open(host, ANDROIDTV_REMOTE_PORT):
        return {"brand": "androidtv", "label": "Google TV", "supported": True,
                "reason": "Android TV remote port"}

    if _port_open(host, VIDAA_PORT):
        return {"brand": "vidaa", "label": "Hisense", "supported": True,
                "reason": "VIDAA MQTT port"}

    return {"brand": None, "label": "", "supported": False,
            "reason": "Nothing answered at that address. Check the IP, and "
                      "make sure the TV is powered on -- a TV in standby "
                      "cannot be identified."}


# ---- LG commercial / signage backend (TCP 9761) ---------------------------
# LG's COMMERCIAL panels (the signage line -- an "S" model like UR640S) speak
# LG's documented RS-232 command set over plain TCP on 9761. No pairing, no TLS,
# no accept prompt: considerably simpler than consumer webOS, which these panels
# do NOT support at all (see identify_tv -- they open 3001 and never handshake).
#
# Wire format is ASCII:   <c1><c2> <setid> <data>\r
#            reply:       <c2> <setid> OK<data>x     (NG<data>x on refusal)
# A data byte of ff is a STATUS READ, not a write.
#
# MEASURED on a real panel, set + read-back + restore for each:
#   ka power    01 = on
#   xb input    91 (round-tripped 91 -> 90 -> 91, verified each step)
#   ke mute     00 = muted, 01 = unmuted (INVERTED vs what you would guess)
#   kf volume   ACKs the write and then always reads back 00 -- audio is inert
#               on that panel, so volume is deliberately NOT exposed. A control
#               that silently does nothing costs more trust than a missing one.
#   mg backlight -> NG (unsupported); dn/fy/fz -> no reply at all.
LGCOM_PORT = 9761
LGCOM_SETID = "01"
_LGCOM_TIMEOUT = 4.0
LGCOM_MOCK = False

# op -> (command, data). Only ops proven to round-trip on hardware.
_LGCOM_OPS = {
    "power_off": ("ka", "00"),
    "power_on": ("ka", "01"),   # works over the network: the panel keeps its
                                # NIC alive in standby, unlike a consumer TV
                                # which needs Wake-on-LAN.
}


def lgcom_available():
    """True in --mock, or when config named an LG commercial host (no pairing)."""
    if LGCOM_MOCK:
        return True
    return bool(CONFIG_LGCOM and CONFIG_LGCOM.get("host"))


def _lgcom_cmd(host, cmd, data, timeout=_LGCOM_TIMEOUT):
    """One command; the reply string, or None. Never raises."""
    try:
        s = socket.create_connection((host, LGCOM_PORT), timeout=timeout)
    except OSError:
        return None
    try:
        s.settimeout(timeout)
        s.sendall(("%s %s %s\r" % (cmd, LGCOM_SETID, data)).encode("ascii"))
        return s.recv(256).decode("ascii", "replace").strip()
    except OSError:
        return None
    finally:
        try:
            s.close()
        except OSError:
            pass


def _lgcom_ok(reply):
    """The panel answers OK<data>x on success and NG<data>x on refusal."""
    return bool(reply) and "OK" in reply


def _lgcom_value(reply):
    """The two data chars out of '<c> 01 OK91x', or None."""
    if not _lgcom_ok(reply):
        return None
    i = reply.index("OK") + 2
    v = reply[i:i + 2]
    return v if len(v) == 2 else None


def lgcom_input(host, code):
    """Switch input. `code` is LG's input byte (90 = HDMI1, 91 = HDMI2, ...)."""
    return _lgcom_ok(_lgcom_cmd(host, "xb", code))


def lgcom_mute(host, on):
    """Mute. NOTE the inversion: ke 00 mutes, ke 01 unmutes."""
    return _lgcom_ok(_lgcom_cmd(host, "ke", "00" if on else "01"))


def lgcom_muted(host):
    """True/False/None. Inverted, as above."""
    v = _lgcom_value(_lgcom_cmd(host, "ke", "ff"))
    return None if v is None else (v == "00")


def lgcom_status(host):
    """{power, input, muted} -- whichever the panel answers. Never raises."""
    out = {}
    v = _lgcom_value(_lgcom_cmd(host, "ka", "ff"))
    if v is not None:
        out["power"] = (v == "01")
    v = _lgcom_value(_lgcom_cmd(host, "xb", "ff"))
    if v is not None:
        out["input"] = v
    m = lgcom_muted(host)
    if m is not None:
        out["muted"] = m
    return out


def real_lgcom(op):
    """Run a TV op against the panel. Mirrors the other backends' return shape."""
    start = time.monotonic()

    def done(ok, stdout="", stderr=""):
        return {"ok": ok, "exit_code": 0 if ok else -1, "stdout": stdout,
                "stderr": stderr,
                "duration_ms": int((time.monotonic() - start) * 1000)}

    if LGCOM_MOCK:
        return done(True, "[mock lgcom] %s" % op)
    host = (CONFIG_LGCOM or {}).get("host")
    if not host:
        return done(False, stderr="no LG commercial display configured")
    if op == "mute":
        cur = lgcom_muted(host)
        return done(lgcom_mute(host, not cur) if cur is not None
                    else lgcom_mute(host, True))
    pair = _LGCOM_OPS.get(op)
    if pair is None:
        # Volume is intentionally absent: it ACKs and never takes effect.
        return done(False, stderr="op not supported on an LG commercial display")
    return done(_lgcom_ok(_lgcom_cmd(host, pair[0], pair[1])))


def tv_discover(mock, timeout=2.6):
    """Sweep the LAN for controllable TVs (see the module note). Returns a list
    of {brand, name, host}, deduped by host (a pairing backend wins over a bare
    UPnP echo of the same set). Each method runs in its own thread so the whole
    sweep is ~one timeout, not the sum."""
    if mock:
        return [
            {"brand": "androidtv", "name": "Living Room TV (mock)", "host": "10.0.0.51"},
            {"brand": "webos", "name": "Bedroom LG (mock)", "host": "10.0.0.52"},
            {"brand": "roku", "name": "Office Roku (mock)", "host": "10.0.0.53"},
        ]
    results, lock = [], threading.Lock()

    def run(fn):
        try:
            found = fn()
        except Exception:
            found = []
        with lock:
            results.extend(found)

    threads = [threading.Thread(target=run, args=(fn,), daemon=True) for fn in
               (_discover_androidtv, _discover_samsung, _discover_roku, _discover_webos)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout + 2.5)
    # Dedup by host; brand priority = pairing backends over passive echoes.
    order = {"androidtv": 0, "webos": 1, "samsung": 2, "roku": 3}
    best = {}
    for tv in results:
        host = tv.get("host")
        if not host:
            continue
        cur = best.get(host)
        if cur is None or order.get(tv["brand"], 9) < order.get(cur["brand"], 9):
            best[host] = tv
    return sorted(best.values(), key=lambda t: (order.get(t["brand"], 9), t["name"]))


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
    set_webos(mock)
    set_samsung(mock)
    set_roku(mock)
    set_androidtv(mock)
    set_vidaa(mock)
    set_soft(mock)


def _probe_ok(fn):
    """True if an availability probe says yes. Probes touch config, sockets and
    serial ports, so any of them can raise; a backend that errors is simply not
    available. (set_caps has its own local `safe` for the same reason -- this is
    the module-level equivalent, needed because _tv_hw_backend runs per request.)"""
    try:
        return bool(fn())
    except Exception:
        return False


# brand -> availability probe, in the order the chain falls back through.
def _tv_backend_probes():
    return [("panel", panel_available), ("webos", webos_available),
            ("samsung", samsung_available), ("androidtv", androidtv_available),
            ("roku", roku_available), ("vidaa", vidaa_available),
            ("lgcom", lgcom_available), ("cec", cec_available)]


def tv_backends_available():
    """Every controllable backend on this box, newest-choice first. The app
    lists these so the user can pick WHICH paired TV to drive."""
    return [name for name, probe in _tv_backend_probes() if _probe_ok(probe)]


def _tv_hw_backend():
    """The external TV backend for power (and TV volume, when chosen).

    An explicit user choice (config `tv_active`) wins, so a box with several
    paired TVs drives the one the user picked. It is validated against live
    availability every call rather than trusted: a chosen TV whose config was
    removed must fall back instead of leaving the box with no working remote.

    With no choice recorded, the historical priority chain applies: the serial
    panel first (it can power on from standby), then a paired webOS TV (explicit
    config + a strict superset of CEC), then CEC."""
    if CONFIG_TV_ACTIVE:
        for name, probe in _tv_backend_probes():
            if name == CONFIG_TV_ACTIVE and _probe_ok(probe):
                return name
    if panel_available():
        return "panel"
    if webos_available():
        return "webos"
    if samsung_available():
        return "samsung"
    if androidtv_available():
        return "androidtv"
    if roku_available():
        return "roku"
    if vidaa_available():
        return "vidaa"
    if lgcom_available():
        return "lgcom"
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
    # The roster the app's TV picker lists, plus what is actually driving now.
    # `active` is the RESOLVED backend, not the stored preference: a chosen TV
    # whose config vanished falls back, and the UI must show what is true.
    backends = tv_backends_available()
    if hw == "panel":
        backend, adapter = "panel", "Newline RS-232 (%s @ %d)" % (
            PANEL["device"], PANEL["baud"])
    elif hw == "lgcom":
        backend, adapter = "lgcom", ("LG commercial (%s)" % CONFIG_LGCOM["host"]
                                     if CONFIG_LGCOM else "LG commercial")
    elif hw == "webos":
        backend, adapter = "webos", ("LG webOS (%s)" % CONFIG_WEBOS["host"]
                                     if CONFIG_WEBOS else "LG webOS")
    elif hw == "samsung":
        backend, adapter = "samsung", ("Samsung Tizen (%s)" % CONFIG_SAMSUNG["host"]
                                       if CONFIG_SAMSUNG else "Samsung Tizen")
    elif hw == "roku":
        backend, adapter = "roku", ("Roku (%s)" % (CONFIG_ROKU.get("name")
                                    or CONFIG_ROKU["host"]) if CONFIG_ROKU
                                    else "Roku")
    elif hw == "androidtv":
        backend, adapter = "androidtv", ("Android TV (%s)"
                                         % (CONFIG_ANDROIDTV.get("name")
                                            or CONFIG_ANDROIDTV["host"])
                                         if CONFIG_ANDROIDTV else "Android TV")
    elif hw == "vidaa":
        backend, adapter = "vidaa", ("Hisense VIDAA (%s)"
                                     % (CONFIG_VIDAA.get("name")
                                        or CONFIG_VIDAA["host"])
                                     if CONFIG_VIDAA else "Hisense VIDAA")
    elif hw == "cec":
        cec = cec_current()
        backend, adapter = "cec", (cec["adapter"] if cec else "CEC")
    else:
        backend, adapter = "soft", (SOFT["adapter"] if SOFT else "OS volume keys")
    return {
        "available": True,
        "backend": backend,
        "adapter": adapter,
        # Every controllable backend on this box, and the user's stored choice.
        # The app lists `backends` as a TV picker; older apps ignore both fields
        # and keep seeing exactly the single `backend` they always did.
        "backends": backends,
        "tv_active": CONFIG_TV_ACTIVE,
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
        # Factory-remote key emulation (arrows/ok/menu/home/back/settings): the
        # RS-232 panel drives the OSD, a paired webOS TV drives its pointer/nav.
        # Either lights up the app's Remote view D-pad cluster.
        "keys": (panel_available() or webos_available()
                 or samsung_available() or roku_available()
                 or androidtv_available() or vidaa_available()),
        # A "source" key opens the TV's input picker (agent >= 2.9.12). Android/
        # Google TV (KEYCODE_TV_INPUT) and Samsung (KEY_SOURCE) have one; webOS/
        # Roku don't (no single input-menu key), and the RS-232 panel uses its
        # own explicit source list (source_box / sources) instead.
        "source_key": androidtv_available() or samsung_available(),
        # Text entry into a focused on-TV field. webOS (IME), Samsung
        # (SendInputString) and Roku (Lit_ keypresses) support it; the panel
        # and CEC have no text channel.
        "text": (webos_available() or samsung_available()
                 or roku_available()),
        # Backend PUSHES a focus signal when an on-TV text field opens/closes,
        # so the app can auto-raise its keyboard (see the t:input_focus frame on
        # /ws/gamepad). webOS-only today (registerRemoteKeyboard subscription);
        # every other backend keeps the manual text button, so this stays false.
        "text_focus_push": webos_available(),
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
    """Route an op to the external TV backend (panel/webos/CEC), or None."""
    b = _tv_hw_backend()
    if b == "panel":
        return mock_panel(op) if mock else real_panel(op)
    if b == "lgcom":
        return real_lgcom(op)
    if b == "webos":
        return mock_webos(op) if mock else real_webos(op)
    if b == "samsung":
        return mock_samsung(op) if mock else real_samsung(op)
    if b == "roku":
        return mock_roku(op) if mock else real_roku(op)
    if b == "androidtv":
        return mock_androidtv(op) if mock else real_androidtv(op)
    if b == "vidaa":
        return mock_vidaa(op) if mock else real_vidaa(op)
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
    """Cache the STATIC half of the capture capability at startup: the
    downscaler and which capture binaries exist. Requires a downscaler for real
    frames (a raw 4K PNG is too big to stream).

    The session-dependent half (which compositor is up, hence which backend can
    actually grab a frame) is deliberately NOT decided here -- see
    _screen_live(). Binaries do not come and go at runtime; compositors do."""
    global _SCREEN
    if mock:
        _SCREEN = {"session": "mock", "backends": ["mock"], "dscale": None}
        return
    dbuild, _ = _screen_downscaler()
    if dbuild is None:
        _SCREEN = None                  # no downscaler: this box can never capture
        return
    if not (shutil.which("gamescopectl") or shutil.which("spectacle")):
        _SCREEN = None                  # no capture tool at all
        return
    _SCREEN = {"dscale": dbuild,
               "has_gamescopectl": bool(shutil.which("gamescopectl")),
               "has_spectacle": bool(shutil.which("spectacle"))}


def _screen_live():
    """Resolve the CURRENT session and usable backends, or None if nothing can
    capture right now. Cheap (one listdir); callers are rate-limited anyway.

    WHY THIS IS RE-EVALUATED PER CALL AND NOT CACHED AT STARTUP: couchside.service
    and the Steam session race at boot. Measured on a real box -- agent up at
    09:34:26, gamescope-0 socket created at 09:35 -- the agent decided "desktop /
    spectacle", then spent the whole uptime firing a KDE screenshot tool at a
    gamescope session. spectacle wrote no file, so every /api/screen/frame
    returned 503 "capture failed" until the service happened to be restarted.
    It presented as "screen capture works sometimes", because whether it works
    depended purely on which of the two won the boot race."""
    if _SCREEN is None or _SCREEN.get("dscale") is None:
        return _SCREEN                  # None, or the mock dict, unchanged
    gs = [s for s in _wayland_display_sockets() if s.startswith("gamescope-")]
    backends = []
    # gamescopectl only works against a live gamescope socket; order matters,
    # the session's own grabber goes first.
    if _SCREEN["has_gamescopectl"] and gs:
        backends.append("gamescopectl")
    if _SCREEN["has_spectacle"]:
        backends.append("spectacle")
    if not backends:
        return None
    return {"session": "gamescope" if gs else "desktop", "backends": backends,
            "dscale": _SCREEN["dscale"], "gs_socket": gs[0] if gs else None}


def _screen_env(live=None):
    env = _user_env()
    if live and live.get("gs_socket"):
        env["WAYLAND_DISPLAY"] = live["gs_socket"]
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
    live = _screen_live()
    if live is None:
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
        env = _screen_env(live)
        outdir = os.path.join(XDG_RUNTIME_DIR, "couchside-screen")
        try:
            os.makedirs(outdir, mode=0o700, exist_ok=True)
        except OSError:
            return None
        png = os.path.join(outdir, "frame.png")
        jpg = os.path.join(outdir, "frame.jpg")
        try:
            grabbed = None
            for backend in live["backends"]:
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
                subprocess.run(live["dscale"](grabbed, jpg), env=env,
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
    """{available, session, backends, formats} or None when no capture path.

    Reports the LIVE session, so the card reflects what would actually be
    grabbed right now rather than whatever was true when the agent booted."""
    live = _screen_live()
    if live is None:
        return None
    return {"available": True, "session": live["session"],
            "backends": live["backends"], "formats": ["image/jpeg"]}


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
#
# The wait is a DEADLINE, not an inline sleep: __init__ stamps ready-at and
# emit() sleeps only the remainder. Devices are pre-created at hello
# (_make_holder), so the window has normally elapsed by the first real gesture
# and the wait is zero — measured 508ms first-frame stall -> ~7ms. A frame that
# does arrive early still waits out the remainder, preserving the guarantee.
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
        # Settle deadline before first emit — see UInputKeyboard (same
        # enumeration race: the first click/move of a fresh session would be
        # dropped). emit() waits out whatever remains of this window.
        self._ready_at = time.monotonic() + _UINPUT_SETTLE_S

    def emit(self, events):
        if self.fd is None:
            return
        wait = self._ready_at - time.monotonic()
        if wait > 0:
            time.sleep(wait)
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
        # Settle deadline: the X server / compositor needs a beat to enumerate
        # a fresh uinput device before it delivers events from it — without
        # the wait, the first press (a typed char, or the Start-menu Meta tap,
        # verified live on SteamOS) is silently dropped. Stamped here, waited
        # out in emit(); pre-created at hello so the wait is normally zero.
        self._ready_at = time.monotonic() + _UINPUT_SETTLE_S

    def emit(self, events):
        if self.fd is None:
            return
        wait = self._ready_at - time.monotonic()
        if wait > 0:
            time.sleep(wait)
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
# Controller trigger: GUIDE-button hold -> Couch Mode (opt-in).
#
# Holding GUIDE (BTN_MODE) for ~1.2s on a REAL pad, while the box is in the
# DESKTOP session, flings it into Game Mode. Off by default. ONE-DIRECTIONAL: a
# hold in Game Mode does nothing (there GUIDE is Steam's own QAM gesture).
#
# Why a HOLD and not a tap: a guide TAP is already claimed by Steam — it opens
# Big Picture inside the desktop session. Verified on hardware: the steam pid is
# unchanged across a tap, no gamescope process appears, and steamos-session-select
# is never invoked. Big Picture renders the same couch UI as Game Mode, so this
# is easy to mistake for a session switch; it is not one. Steam keeps the tap,
# we take the hold, and they never collide.
#
# We NEVER EVIOCGRAB: Steam reads these same nodes and an exclusive grab would
# steal the user's controller. Read-only, so every event still reaches Steam.
#
# Why this and not controller-wake: reading /dev/input/event* needs only group
# `input`, which couchside.service already grants (SupplementaryGroups=input).
# Arming a wake source means writing /sys/.../power/wakeup, which needs root and
# an installer change that Decky-installed boxes never run.
#
# REAL vs EMULATED — the single most important rule here. The naive test "reject
# Sysfs under /devices/virtual/" is WRONG: Bluetooth pads route through uhid,
# which is itself virtual, e.g.
#   S: Sysfs=/devices/virtual/misc/uhid/0005:045E:0B22.000B/input/input963
# The correct discriminator is "P: Phys non-empty OR U: Uniq non-empty".
# Measured on hardware:
#   real BT Xbox pad     Phys=ac:f2:3c:8b:64:fe   Uniq=44:16:22:1f:74:5d
#   real wired pad       Phys=usb-0000:c3:00.4-1/input0   Uniq=(empty)
#   Steam Input phantom  (28de:11ff)  Phys=(empty)  Uniq=(empty)
#   OUR OWN uinput pad   (045e:028e)  Phys=(empty)  Uniq=(empty)
# The agent creates its own "Microsoft X-Box 360 pad" on EVERY phone WebSocket
# connect (UInputGamepad, above). This exclusion is STRUCTURAL, not heuristic:
# the legacy uinput_user_dev descriptor (_UINPUT_USER_DEV) has no phys/uniq field
# and this file defines no UI_SET_PHYS/UI_SET_UNIQ ioctl, so our pad can never
# present one. If the filter ever matched it, connecting the phone app would tear
# down the user's desktop session. Do NOT replace this with a name or VID/PID
# check: GAMEPAD_DEV_NAME is byte-identical to a real Xbox 360 pad.
# ---------------------------------------------------------------------------

_PROC_INPUT_DEVICES = "/proc/bus/input/devices"
_DEV_INPUT = "/dev/input"
BTN_MODE = BTN_CODES["guide"]        # 316 / 0x13C
_GUIDE_EV_SIZE = struct.calcsize(_INPUT_EVENT)   # 24 on 64-bit
_GUIDE_TICK = 0.25                   # select() ceiling: bounds disarm latency
_GUIDE_RESCAN_S = 3.0                # hotplug reconciliation cadence
_GUIDE_STALE_HOLD_S = 8.0            # a press with no release this long is junk
_GUIDE_SETTLE_S = 5.0                # post-fire quiet period
_GUIDE_COOLDOWN_S = 30.0             # min spacing of controller-fired switches
_GUIDE_LOCK = threading.Lock()       # _GUIDE_GEN += 1 is not atomic
_GUIDE_GEN = 0
_GUIDE_MOCK = False


def _parse_input_devices(text):
    """Parse /proc/bus/input/devices into
    [{"name","phys","uniq","vendor","product","handlers":[...],"keybits":[...]}].
    Tolerant of unknown lines. partition(':') is used so a Phys like
    usb-0000:c3:00.4-1/input0 survives."""
    recs, cur = [], None
    for line in text.splitlines():
        if not line.strip():
            cur = None
            continue
        tag, _, val = line.partition(":")
        val = val.strip()
        if tag == "I":
            cur = {"name": "", "phys": "", "uniq": "", "handlers": [],
                   "keybits": [], "vendor": "", "product": ""}
            recs.append(cur)
            # "Bus=0003 Vendor=28de Product=11ff Version=0001". VID:PID is the
            # only thing that separates a Steam Input phantom from the pad it
            # republishes — both are phys-less and both are named after a real
            # Xbox pad. Lowercased: /proc prints hex lowercase, but don't rely
            # on it. Missing/garbled fields stay "" and simply never match.
            for tok in val.split():
                k, _, v = tok.partition("=")
                if k == "Vendor":
                    cur["vendor"] = v.strip().lower()
                elif k == "Product":
                    cur["product"] = v.strip().lower()
        elif cur is None:
            continue
        elif tag == "N" and val.startswith("Name="):
            cur["name"] = val[5:].strip().strip('"')
        elif tag == "P" and val.startswith("Phys="):
            cur["phys"] = val[5:].strip()
        elif tag == "U" and val.startswith("Uniq="):
            cur["uniq"] = val[5:].strip()
        elif tag == "H" and val.startswith("Handlers="):
            cur["handlers"] = val[9:].split()
        elif tag == "B" and val.startswith("KEY="):
            cur["keybits"] = val[4:].split()
    return recs


def _declares_key(rec, code):
    """True when the device's EV_KEY bitmask advertises <code>.

    /proc prints the bitmask as space-separated 64-bit hex words, MOST
    significant word FIRST, so word 0 of the bit space is the LAST field. A
    device with no 'B: KEY=' line declares no keys at all.

    This is what separates a controller from its own sibling nodes: a USB
    DualSense registers TWO js devices sharing one Uniq — the pad, and a
    'Motion Sensors' node that declares no keys. Without this test the pad shows
    up twice in the app's controller list. It also drops wheels and flight
    panels, which are joysticks with no guide button."""
    words = rec.get("keybits") or []
    idx, bit = divmod(code, 64)
    if idx >= len(words):
        return False
    try:
        return bool(int(words[len(words) - 1 - idx], 16) >> bit & 1)
    except ValueError:
        return False


def list_real_pads():
    """Physical game controllers present right now. Two filters, both required:
      * a js* handler -> a joystick, not a keyboard/mouse/lid switch. NOTE the
        token is "js2", not "js" — match with startswith. (Comparing for
        equality against "js" matches nothing and was a real bug in the
        prototype.)
      * Phys or Uniq non-empty -> REAL, not uinput/Steam-Input emulated.
    Returns [{"event","name","phys","uniq"}]; [] on any read error, since an
    unreadable /proc must degrade to "no pads" rather than raise. Because of the
    js* filter this never holds an fd on a keyboard: no keylogging surface."""
    try:
        with open(_PROC_INPUT_DEVICES, "r", errors="replace") as f:
            text = f.read()
    except OSError:
        return []
    pads = []
    for rec in _parse_input_devices(text):
        h = rec["handlers"]
        if not any(t.startswith("js") for t in h):
            continue
        if not (rec["phys"] or rec["uniq"]):
            continue                       # emulated; see the block comment
        if not _declares_key(rec, BTN_MODE):
            continue                       # sibling sensor node / wheel / panel
        ev = next((t for t in h if t.startswith("event")), None)
        if not ev:
            continue
        pads.append({"event": ev, "name": rec["name"],
                     "phys": rec["phys"], "uniq": rec["uniq"]})
    return pads


def _guide_pad_matches(pad, uniq):
    """uniq == "" means "any real pad". Otherwise an exact case-insensitive
    match on the pad's own MAC — stable across BT re-enumeration, whereas Phys
    is the HOST adapter's MAC and is identical for every BT pad, so it cannot
    serve as an identity."""
    return True if not uniq else pad["uniq"].lower() == uniq.lower()


def guide_hold_available():
    """Can this box watch for the hold? Requires the Couch Mode handoff plus
    readable evdev. Answers "capable", NOT "enabled". Never raises."""
    try:
        return (couchmode_available()
                and os.access(_PROC_INPUT_DEVICES, os.R_OK)
                and os.access(_DEV_INPUT, os.R_OK | os.X_OK))
    except Exception:
        return False


def _guide_hold_s():
    try:
        ms = int(CONFIG_GUIDE.get("hold_ms", GUIDE_DEFAULTS["hold_ms"]))
    except (TypeError, ValueError):
        ms = GUIDE_DEFAULTS["hold_ms"]
    return max(GUIDE_MIN_HOLD_MS, min(GUIDE_MAX_HOLD_MS, ms)) / 1000.0


def guide_hold_info():
    """Body for GET /api/guide-hold. `readable` distinguishes "no controller
    connected" from "the agent can't READ your controller" — the likely support
    case, an agent user missing from group input."""
    uniq = (CONFIG_GUIDE.get("uniq") or "").strip()
    pads = list_real_pads()
    return {"available": True,
            "enabled": bool(CONFIG_GUIDE.get("enabled")),
            "hold_ms": int(_guide_hold_s() * 1000),
            "uniq": uniq,
            "uniq_present": bool(uniq) and any(
                p["uniq"].lower() == uniq.lower() for p in pads),
            "session": _couchmode_session(),
            "controllers": [
                {"uniq": p["uniq"], "phys": p["phys"], "name": p["name"],
                 "readable": os.access(os.path.join(_DEV_INPUT, p["event"]),
                                       os.R_OK)}
                for p in pads]}


def _guide_save(enabled, hold_ms, uniq):
    """Persist the guide settings and update CONFIG_GUIDE."""
    global CONFIG_GUIDE
    cfg = {"enabled": bool(enabled), "hold_ms": int(hold_ms),
           "uniq": (uniq or "").strip()}
    with CONFIG_LOCK:
        _config_set_field("guide", cfg)
        CONFIG_GUIDE = cfg


def set_guide(mock):
    """Arm/disarm the watcher from the current CONFIG_GUIDE. Idempotent — call
    from main() (AFTER load_config) and from the settings route."""
    global _GUIDE_MOCK
    _GUIDE_MOCK = bool(mock)
    start_guide_watch()


def start_guide_watch():
    """(Re)start the watcher. Bumping the generation retires any prior thread —
    it notices within _GUIDE_TICK, closes its fds in finally, and exits — and a
    new daemon thread starts only when the setting is on and the box is capable.
    The lock matters: `+= 1` is not atomic, so two concurrent POSTs could
    otherwise lose an increment and leave two live watchers both firing."""
    global _GUIDE_GEN
    with _GUIDE_LOCK:
        _GUIDE_GEN += 1
        gen = _GUIDE_GEN
    if _GUIDE_MOCK or not CONFIG_GUIDE.get("enabled"):
        return
    if not guide_hold_available():
        print("[guide] hold trigger is on but unavailable on this box",
              flush=True)
        return
    threading.Thread(target=_guide_watch, args=(gen,), daemon=True,
                     name="guide-hold").start()
    print("[guide] armed (%dms, %s)"
          % (int(_guide_hold_s() * 1000),
             ("pad %s" % CONFIG_GUIDE["uniq"]) if CONFIG_GUIDE.get("uniq")
             else "any real pad"), flush=True)


def _guide_drop(state, fd):
    """Close and forget one pad. Dropping the fd drops its in-flight press with
    it, so a pad that vanishes mid-hold can never fire later."""
    state.pop(fd, None)
    try:
        os.close(fd)
    except OSError:
        pass


def _guide_rescan(state, failed):
    """Reconcile the open fds with the real-pad list, in place. Rebuilt BY PATH
    every few seconds rather than opened once, because BT pads re-enumerate onto
    a different eventN under a different uhid path. Unreadable nodes are skipped
    — a mixed box may have one pad we cannot open.

    `failed` is the set of nodes we have already warned about. Without it the
    warning repeats on EVERY rescan: a Legion Go S's built-in pad is mode 000
    (readable by nobody), so an unfiltered log spams the journal forever at the
    rescan cadence. Entries are forgotten once the node goes away, so a genuinely
    new failure still gets one line."""
    uniq = (CONFIG_GUIDE.get("uniq") or "").strip()
    want = {p["event"]: p for p in list_real_pads()
            if _guide_pad_matches(p, uniq)}
    for fd in list(state):
        if state[fd]["event"] not in want:
            _guide_drop(state, fd)          # unplugged, or no longer a match
    failed &= set(want)                     # forget nodes that have vanished
    have = {state[fd]["event"] for fd in state}
    for ev, pad in want.items():
        if ev in have:
            continue
        try:
            # O_RDONLY, and NEVER EVIOCGRAB: Steam reads these same nodes.
            fd = os.open(os.path.join(_DEV_INPUT, ev),
                         os.O_RDONLY | os.O_NONBLOCK)
        except OSError as e:
            if ev not in failed:
                failed.add(ev)
                print("[guide] cannot open %s (%s)" % (ev, e), flush=True)
            continue
        failed.discard(ev)
        state[fd] = {"event": ev, "uniq": pad["uniq"], "name": pad["name"],
                     "down_at": None}
        print("[guide] watching %s (%s, uniq=%s)"
              % (ev, pad["name"] or "?", pad["uniq"] or "-"), flush=True)


def _guide_read(state, fd, now):
    """Drain <fd>, tracking BTN_MODE press/release. False when the node is gone.
    value 2 is autorepeat and is IGNORED, so a repeat cannot restart or extend
    the clock."""
    st = state.get(fd)
    if st is None:
        return False
    while True:
        try:
            chunk = os.read(fd, _GUIDE_EV_SIZE * 64)
        except BlockingIOError:
            return True
        except OSError:
            return False                    # ENODEV: pad vanished mid-read
        if not chunk:
            return False
        for off in range(0, len(chunk) - _GUIDE_EV_SIZE + 1, _GUIDE_EV_SIZE):
            _s, _us, etype, code, value = struct.unpack_from(
                _INPUT_EVENT, chunk, off)
            if etype != EV_KEY or code != BTN_MODE:
                continue
            if value == 1:
                st["down_at"] = now         # press
            elif value == 0:
                st["down_at"] = None        # release CANCELS a pending hold
        if len(chunk) < _GUIDE_EV_SIZE * 64:
            return True                     # short read: nothing more queued


def _guide_due(state, now):
    """True when some pad's hold has matured. Also expires junk presses (a lost
    release on a still-open fd). Clears EVERY pad's press when it fires, so two
    pads held at once produce exactly one switch."""
    hold = _guide_hold_s()
    due = False
    for st in state.values():
        if st["down_at"] is None:
            continue
        elapsed = now - st["down_at"]
        if elapsed > _GUIDE_STALE_HOLD_S:
            st["down_at"] = None            # stuck key / lost release
        elif elapsed >= hold:
            due = True
    if due:
        for st in state.values():
            st["down_at"] = None
    return due


def _guide_fire():
    """A qualifying hold completed. EVERY guard lives here, because this path
    bypasses the HTTP layer entirely — no bearer token, no route-level 404.
    Returns True if a switch was attempted."""
    try:
        if not couchmode_available():
            return False
        # STRICT: unknown must NOT read as desktop. Firing while actually in Game
        # Mode could restart the session under a running game, and GUIDE is held
        # constantly there (it is Steam's own QAM gesture).
        if _couchmode_session_strict() != "desktop":
            return False
        print("[guide] hold in desktop session -> couch mode", flush=True)
        # No output pin: same as the app's default; gamescope picks its external
        # via the hardcoded -O '*',eDP-1. On a multi-external box the phone's
        # picker stays authoritative and this trigger is not.
        r = couchmode_try_enter("", cooldown=_GUIDE_COOLDOWN_S)
        if r is None:
            return False                    # switch in flight, or cooling down
        if not r.get("ok"):
            print("[guide] couch mode not entered: %s"
                  % ((r.get("steps", {}).get("session", {}) or {}).get("stderr")
                     or "unknown"), flush=True)
        return True
    except Exception as e:                  # this thread must never die
        print("[guide] fire failed: %s: %s" % (e.__class__.__name__, e),
              flush=True)
        return True


def _guide_watch(gen):
    """Watch every matching real pad for a guide hold. Runs until its generation
    is superseded; any error closes everything and rebuilds with capped backoff.
    Never raises out of the thread.

    select() is deliberately NOT wrapped: a bad fd raises out to the outer
    handler, which closes the whole set and rebuilds. Swallowing it here would
    busy-spin at 100% CPU on a dead-but-still-listed node."""
    backoff = 2
    logged = False
    while gen == _GUIDE_GEN:
        state = {}                # fd -> {"event","uniq","name","down_at"}
        failed = set()            # nodes already warned about (log-once)
        fired = False
        try:
            next_scan = 0.0
            while gen == _GUIDE_GEN:
                now = time.monotonic()
                if now >= next_scan:
                    _guide_rescan(state, failed)
                    next_scan = now + _GUIDE_RESCAN_S
                    backoff, logged = 2, False
                if not state:
                    time.sleep(_GUIDE_TICK)     # no pad connected: cheap idle
                    continue
                # Wake exactly when the oldest hold matures, else on the tick, so
                # fire latency is ~0ms past the threshold rather than up to a tick.
                wait = _GUIDE_TICK
                downs = [s["down_at"] for s in state.values()
                         if s["down_at"] is not None]
                if downs:
                    wait = max(0.0, min(_GUIDE_TICK,
                                        min(downs) + _guide_hold_s() - now))
                r, _, _ = select.select(list(state), [], [], wait)
                now = time.monotonic()
                for fd in r:
                    if not _guide_read(state, fd, now):
                        _guide_drop(state, fd)
                        next_scan = 0.0         # force an immediate resync
                if _guide_due(state, time.monotonic()) and _guide_fire():
                    fired = True
                    break
        except (IOError, OSError, ValueError) as e:
            if not logged:
                print("[guide] watch paused (%s: %s); retrying"
                      % (e.__class__.__name__, e), flush=True)
                logged = True
        finally:
            for fd in list(state):
                _guide_drop(state, fd)
        if gen != _GUIDE_GEN:
            break
        if fired:
            # Let the session switch land, then rebuild from scratch. Reopening
            # the nodes DISCARDS anything the kernel queued during the teardown
            # (each open of an evdev node gets its own empty client buffer), so
            # stale events cannot read as a fresh press. That is the debounce —
            # no timestamp state needed. A user still holding GUIDE at reopen
            # must release and re-press, because we never saw the DOWN.
            time.sleep(_GUIDE_SETTLE_S)
            backoff = 2
        else:
            time.sleep(backoff)
            backoff = min(backoff * 2, 30)


# ---------------------------------------------------------------------------
# Gaming card (GET /api/gaming). A live "what's running right now" panel:
# discrete-GPU temp/VRAM, the running Steam game (+ cover via the existing cover
# route), the active display output, connected controllers with battery, and the
# session (Game Mode vs desktop). EVERY field is independently optional — the
# only boxes reachable to test on are Intel i915 with NO hwmon under the DRM
# device, so the GPU block simply does not appear rather than blanking the card.
# The amdgpu sysfs paths follow the documented layout but are UNVERIFIED on
# hardware (no AMD box on the LAN), and degrade to "no GPU block" on anything
# that is not amdgpu (Intel exposes no device hwmon; NVIDIA would need NVML).
# ---------------------------------------------------------------------------

_GAMING_TTL = 2.0
_GAMING_CACHE = {"val": None, "at": 0.0}
_GAMING_LOCK = threading.Lock()
# Sysfs roots, as module constants so tests can point them at fixtures (the same
# pattern as _PROC_INPUT_DEVICES for the pad list).
_DRM_DIR = "/sys/class/drm"
_POWER_SUPPLY_DIR = "/sys/class/power_supply"


def _read_int(path):
    """int from a one-line sysfs file, or None (never raises)."""
    try:
        with open(path) as f:
            return int(f.read().strip())
    except (OSError, ValueError):
        return None


def gaming_available():
    """Boot-time caps hint: a box with Steam can have a gaming session worth
    showing. GET /api/gaming is the live authority (per-field probe-and-appear).
    Never raises."""
    try:
        return _steam_root() is not None
    except Exception:
        return False


def _gpu_sensors():
    """Discrete-GPU temp + VRAM from amdgpu sysfs, or {} when absent. Intel i915
    exposes no DRM-device hwmon; NVIDIA needs NVML — both degrade here to "no GPU
    block", never to a CPU number mislabelled as GPU. Every field independently
    optional. Read-only, best-effort; never raises."""
    try:
        drm = _DRM_DIR
        # Real cards only: cardN. The connector dirs (cardN-DP-1) ALSO match a
        # bare card* glob AND carry a `device` symlink (to the DRM card, not the
        # PCI GPU), so mem_info_*/hwmon are not under them — re.fullmatch(card\d+)
        # is the documented fix for that trap.
        cards = [b for b in os.listdir(drm) if re.fullmatch(r"card\d+", b)]
    except OSError:
        return {}
    for card in sorted(cards):
        dev = os.path.join(drm, card, "device")
        hw_name, temp_path = None, None
        # hwmon index is not stable across boxes: match on the name file, never a
        # hardcoded hwmonN (as read_cpu_temp_c does).
        for nf in sorted(glob.glob(os.path.join(dev, "hwmon", "hwmon*", "name"))):
            try:
                with open(nf) as f:
                    nm = f.read().strip()
            except OSError:
                continue
            if nm == "amdgpu":
                hw_name = nm
                cand = os.path.join(os.path.dirname(nf), "temp1_input")
                temp_path = cand if os.path.exists(cand) else None
                break
        if hw_name is None:
            continue  # Intel/NVIDIA/virtual card: no amdgpu hwmon here
        gpu = {"name": hw_name}
        if temp_path:
            milli = _read_int(temp_path)
            if milli is not None:
                gpu["temp_c"] = round(milli / 1000.0, 1)
        # VRAM is documented as BYTES but was not observable this session. Sanity-
        # gate the magnitude before trusting the unit — a total under ~64 MB is
        # almost certainly not bytes, so drop it rather than report a lie.
        total = _read_int(os.path.join(dev, "mem_info_vram_total"))
        used = _read_int(os.path.join(dev, "mem_info_vram_used"))
        if total is not None and total > (64 << 20):
            gpu["vram_total_mb"] = total >> 20
            if used is not None:
                gpu["vram_used_mb"] = used >> 20
        return gpu
    return {}


_REAPER_APPID_RE = re.compile(r"\bAppId=(\d+)")


def _appid_from_cmdline(cmdline):
    """Steam AppId from a /proc/<pid>/cmdline blob (NUL-separated tokens), or
    None. Requires the real Steam launch wrapper — a `reaper` executable token
    AND a steamapps/ path (the game binary) — so a stray "AppId=" elsewhere does
    not register. Rejects a bracketed argv[0] ([oom_reaper] and other kernel
    threads; those also have an empty cmdline, but guard explicitly). Never
    raises."""
    try:
        args = [a for a in cmdline.split("\x00") if a]
        if not args or args[0].startswith("["):
            return None
        if not any(os.path.basename(a) == "reaper" for a in args):
            return None
        joined = " ".join(args)
        if "steamapps" not in joined:
            return None
        m = _REAPER_APPID_RE.search(joined)
        return m.group(1) if m else None
    except Exception:
        return None


def _running_game():
    """{"appid": int[, "label": str]} for the Steam game running now, or None.
    Scans /proc/*/cmdline for the reaper wrapper; label from the appinfo cache
    (LAN-only, same source the Steam Link list uses). Best-effort; never raises."""
    try:
        for entry in glob.glob("/proc/[0-9]*/cmdline"):
            try:
                with open(entry, "r", errors="replace") as f:
                    cmd = f.read()
            except OSError:
                continue
            appid = _appid_from_cmdline(cmd)
            if appid:
                game = {"appid": int(appid)}
                name = _steam_appinfo_names().get(int(appid))
                if name:
                    game["label"] = name
                return game
    except Exception:
        pass
    return None


def _norm_mac(s):
    """A MAC-ish string lowercased with all separators stripped, for fuzzy joins
    across the many power_supply naming schemes."""
    return re.sub(r"[^0-9a-f]", "", (s or "").lower())


def _pad_battery(uniq):
    """{"battery_pct": int[, "battery_status": str]} joined to a pad's uniq via
    /sys/class/power_supply, or {} when there is no match. An EMPTY power_supply
    directory is the normal mains-desktop case, NOT an error. Pad-battery naming
    varies (hid-<MAC>-battery, sony_controller_battery_<MAC>, …) so join fuzzily:
    the pad MAC (separators stripped) appearing in the supply's own name or its
    uevent. Read-only, best-effort; never raises."""
    key = _norm_mac(uniq)
    if not key:
        return {}
    try:
        supplies = os.listdir(_POWER_SUPPLY_DIR)
    except OSError:
        return {}
    for name in supplies:
        base = os.path.join(_POWER_SUPPLY_DIR, name)
        if key not in _norm_mac(name):
            try:
                with open(os.path.join(base, "uevent")) as f:
                    uev = f.read()
            except OSError:
                uev = ""
            if key not in _norm_mac(uev):
                continue
        out = {}
        pct = _read_int(os.path.join(base, "capacity"))
        if pct is not None:
            out["battery_pct"] = max(0, min(100, pct))
        try:
            with open(os.path.join(base, "status")) as f:
                st = f.read().strip()
            if st:
                out["battery_status"] = st
        except OSError:
            pass
        if out:
            return out
    return {}


# Steam Input republishes every controller it manages as its own virtual pad
# under this VID:PID. The Puck is the wireless dongle the 2025 Steam Controller
# pairs through; its presence is what lets us name an otherwise anonymous
# phantom. Both measured on a live box, 2026-07-19.
_STEAM_INPUT_ID = ("28de", "11ff")
_STEAM_PUCK_ID = ("28de", "1304")


def _read_input_devices():
    """Parsed /proc/bus/input/devices, [] on any read error."""
    try:
        with open(_PROC_INPUT_DEVICES, "r", errors="replace") as f:
            return _parse_input_devices(f.read())
    except OSError:
        return []


def _is_pad(rec):
    """A joystick node with a guide button — same shape test list_real_pads
    applies, minus its phys/uniq requirement."""
    return (any(t.startswith("js") for t in rec.get("handlers", []))
            and _declares_key(rec, BTN_MODE))


def _steam_input_pads(recs):
    """Pads Steam Input is currently republishing (VID:PID 28de:11ff).

    MEASURED ON HARDWARE, all three cases producing exactly one phantom each:
    a real pad carrying a Phys, a phys-less pad, and the agent's OWN uinput
    pad. So this count is (real pads) + (agent pads) + (pads only Steam can
    see) — never a subset. That is what makes the subtraction below sound."""
    return [r for r in recs
            if (r.get("vendor"), r.get("product")) == _STEAM_INPUT_ID
            and _is_pad(r)]


def _own_pad_count():
    """Virtual gamepads the agent itself has open right now.

    Counts entries whose device slot is filled, NOT len(GAMEPAD_SESSIONS) —
    waiters sit in that list with device None, and an entry is appended before
    any device is created. Normally 0 or 1 (only the holder owns a pad); it can
    briefly read 2 during a handoff, between promoting the new holder and
    releasing the old one, since both run outside GAMEPAD_LOCK. A transient
    over-count only hides a controller for one 2s poll, which is why this is
    allowed to race rather than take a heavier lock."""
    try:
        with GAMEPAD_LOCK:
            return sum(1 for s in GAMEPAD_SESSIONS
                       if s.get("device") is not None)
    except Exception:
        return 0


def _gaming_controllers():
    """Controllers the user could actually play with, deduped, with a best-
    effort battery join.

    TWO sources, because neither sees every pad on its own:

      * REAL pads (list_real_pads) — carry a Phys or Uniq, so they have honest
        names and can be battery-joined.
      * Steam Input phantoms — a Steam Controller NEVER exposes a gamepad node
        of its own. The Puck presents only lizard-mode mouse/keyboard nodes;
        Steam consumes the HID and republishes it phys-less. Those phantoms are
        invisible to list_real_pads BY DESIGN: our own uinput pad is phys-less
        too, and a filter that matched it would tear down the user's desktop
        session every time a phone connected.

    Steam wraps everything it manages, so whatever is left after subtracting
    the pads we can already see and the pads we created ourselves is exactly
    what list_real_pads cannot reach:

        total = max(len(real), phantoms - our_pads)

    max() rather than plain subtraction so real pads still show when Steam is
    not running at all and there are no phantoms. Verified against a live box
    in every state that was reachable:

        idle, Steam Controller on   real 0  phantom 1  ours 0  -> 1
        phone gamepad connected     real 0  phantom 2  ours 1  -> 1  (not 2)
        + a pad carrying a Phys     real 1  phantom 2  ours 0  -> 2
        Steam not running           real 1  phantom 0  ours 0  -> 1
    """
    seen, out = set(), []
    for p in list_real_pads():
        u = p.get("uniq") or ""
        dedupe = u.lower() or (p.get("phys") or "").lower() or p.get("event", "")
        if dedupe in seen:
            continue
        seen.add(dedupe)
        ctrl = {"uniq": u, "name": p.get("name", "")}
        ctrl.update(_pad_battery(u))
        out.append(ctrl)

    recs = _read_input_devices()
    hidden = max(0, len(_steam_input_pads(recs)) - _own_pad_count() - len(out))
    if hidden:
        # The phantom is anonymous ("Microsoft X-Box 360 pad 0") and carries no
        # Uniq, so there is nothing real to name or battery-join it by. Name it
        # from the dongle when that is present. No battery either way: the 2025
        # controller publishes NO power_supply node (its charge is readable only
        # over HID, in userspace), so there is nothing for _pad_battery to find.
        label = ("Steam Controller"
                 if any((r.get("vendor"), r.get("product")) == _STEAM_PUCK_ID
                        for r in recs)
                 else "Controller")
        for i in range(hidden):
            # Synthetic uniq: the app keys its controller list on uniq, so two
            # hidden pads must not collide on "".
            out.append({"uniq": "steam-input-%d" % i, "name": label})
    return out


def _active_output():
    """The display the game is on: the first external connected output, else the
    first internal, else None. From _connected_outputs (works in any session)."""
    outs = _connected_outputs()
    if not outs:
        return None
    ext = [o for o in outs if not o["internal"]]
    return (ext or outs)[0]


def _gaming_payload():
    """The /api/gaming body — every field independently optional; omit anything
    that could not be read rather than emit a null the app must special-case.
    TTL-memoized so the app's ~5s poll does not re-scan sysfs/proc each time."""
    now = time.monotonic()
    with _GAMING_LOCK:
        c = _GAMING_CACHE
        if c["val"] is not None and now - c["at"] <= _GAMING_TTL:
            return c["val"]
    payload = {"session": _couchmode_session()}
    gpu = _gpu_sensors()
    if gpu:
        payload["gpu"] = gpu
    game = _running_game()
    if game:
        payload["game"] = game
    output = _active_output()
    if output:
        payload["output"] = output
    ctrls = _gaming_controllers()
    if ctrls:
        payload["controllers"] = ctrls
    with _GAMING_LOCK:
        _GAMING_CACHE["val"] = payload
        _GAMING_CACHE["at"] = now
    return payload


def mock_gaming():
    """A full payload for --mock so the app's render path is exercised without
    hardware: GPU block populated (as an AMD box would), a running game, an
    external output, a pad with battery, Game Mode."""
    return {
        "gpu": {"name": "amdgpu", "temp_c": 61.0,
                "vram_used_mb": 3300, "vram_total_mb": 8192},
        "game": {"appid": 1091500, "label": "Cyberpunk 2077"},
        "output": {"name": "DP-1", "internal": False},
        "controllers": [{"uniq": "dc:2c:26:aa:bb:cc",
                         "name": "Xbox Wireless Controller",
                         "battery_pct": 62, "battery_status": "Discharging"}],
        "session": "gamescope",
    }


# ---------------------------------------------------------------------------
# Stream host detection (GET /api/stream-host) — CouchOS roadmap phase 4a.
#
# DETECT ONLY: is a Steam Remote Play session being served BY this box right now?
# No session/display manipulation whatsoever (that is 4b/4c, and 4c is gated on a
# hardware test). This is the opposite direction from the shipped `steamlink`
# CLIENT feature ("Stream FROM PC"), so it gets its own caps key and endpoint.
#
# Signal choice, grounded on hardware rather than the original plan's log tailer:
#   * TCP 27036 LISTEN (owned by steam) = the host is up. VERIFIED live. This
#     doubles as the wedged-Steam test.
#   * A CONNECTED UDP peer on the streaming ports = a session is actually
#     running, and it names the peer. Verified to be CLEAN while idle (the only
#     connected UDP socket on an idle box is DHCP 68<->67).
# The plan specified tailing streaming_log.txt instead. Three findings on real
# hardware argued against it: (a) the log has NO stream-stop line at all, forcing
# a deadline hack; (b) its would-be liveness lines are swamped by 9,915
# "Adding/Removing process for gameID" entries that fire with no stream running,
# which would pin a session permanently active; (c) an ESTABLISHED TCP peer on
# 27036 is NOT a session — the router holds one on an idle box. The UDP-peer
# probe has both edges, names the peer, and needs no deadline. If a live host
# session shows it does not fire, the log tailer is the documented fallback.
# ---------------------------------------------------------------------------

# Steam's Remote Play control port. LISTEN here (owned by steam) means the host
# is up; it doubles as the wedged-Steam test. Verified live.
_STREAM_LISTEN_PORT = 27036
_PROC_NET_TCP = ("/proc/net/tcp", "/proc/net/tcp6")
_PROC_NET_UDP = ("/proc/net/udp", "/proc/net/udp6")
_TCP_LISTEN = "0A"

# Session edges, read off streaming_log.txt. BOTH edges exist — captured from a
# real macOS Remote Play session served by a live box:
#   [2026-07-19 17:50:17][75.044] >>> Starting desktop stream
#   [2026-07-19 17:50:18][75.533] >>> Client video decoder set to macOS Metal ...
#   [2026-07-19 17:51:04][122.09] >>> Stopped desktop stream
# (An earlier draft of this feature keyed on a connected UDP peer in 27031-27036
# instead; that signal DID NOT FIRE during that real session, so it silently
# missed it. Log markers are the ground truth.)
_STREAM_START_MARK = ">>> Starting desktop stream"
_STREAM_STOP_MARK = ">>> Stopped desktop stream"
_STREAM_CLIENT_MARK = ">>> Client video decoder set to "
# Absolute backstop for a session left "started" with no stop line. It is NOT
# the real recovery path — 12h is far too coarse for that; _stream_data_bound()
# catches a dirty end within one poll. This only bounds the pathological case
# where the data port somehow stays bound forever.
_STREAM_MAX_S = 12 * 3600
# The Remote Play DATA port. Bound for the life of a session and released when
# it ends, cleanly or not — see _stream_data_bound().
_STREAM_DATA_PORT = 27031
_STREAM_LOCK = threading.Lock()
_STREAM_STATE = {"active": False, "since": 0, "client": None, "pos": 0}


def _stream_log_path():
    """<steam_root>/logs/streaming_log.txt, or None. Built through _steam_root()
    (never a hardcoded ~/.steam/steam), mirroring _remoteclients_path()."""
    root = _steam_root()
    if root is None:
        return None
    p = os.path.join(root, "logs", "streaming_log.txt")
    return p if os.path.isfile(p) else None


def _stream_line_epoch(line):
    """Unix seconds from a '[YYYY-MM-DD HH:MM:SS]...' log prefix, else None."""
    try:
        if not line.startswith("[") or len(line) < 21:
            return None
        return int(time.mktime(time.strptime(line[1:20], "%Y-%m-%d %H:%M:%S")))
    except (ValueError, OverflowError):
        return None


def _stream_scan_log():
    """Advance a byte cursor over streaming_log.txt and fold the session markers
    into _STREAM_STATE. Handles ROTATION (file shrank -> restart at 0). The first
    scan reads the whole file so the current state is established from the last
    marker; afterwards only the new tail is read. Never raises."""
    path = _stream_log_path()
    if path is None:
        return
    try:
        size = os.path.getsize(path)
    except OSError:
        return
    with _STREAM_LOCK:
        pos = _STREAM_STATE["pos"]
        if size < pos:          # rotated / truncated
            pos = 0
        if size == pos:
            return              # nothing new
        try:
            with open(path, "r", errors="replace") as f:
                f.seek(pos)
                chunk = f.read()
                newpos = f.tell()
        except OSError:
            return
        for line in chunk.splitlines():
            if _STREAM_START_MARK in line:
                _STREAM_STATE["active"] = True
                _STREAM_STATE["since"] = _stream_line_epoch(line) or int(time.time())
                _STREAM_STATE["client"] = None
            elif _STREAM_STOP_MARK in line:
                _STREAM_STATE["active"] = False
                _STREAM_STATE["since"] = 0
                _STREAM_STATE["client"] = None
            elif _STREAM_CLIENT_MARK in line:
                # "... set to macOS Metal hardware decoding" -> "macOS"
                rest = line.split(_STREAM_CLIENT_MARK, 1)[1].strip()
                _STREAM_STATE["client"] = rest.split()[0] if rest else None
        _STREAM_STATE["pos"] = newpos


def _proc_net_rows(paths):
    """Yield (local_port, rem_hex_ip, rem_port, state) from /proc/net/tcp{,6}.
    Pure parsing — no `ss`/`netstat` subprocess. Never raises."""
    for path in paths:
        try:
            with open(path) as f:
                lines = f.read().splitlines()[1:]     # drop the header
        except OSError:
            continue
        for line in lines:
            parts = line.split()
            if len(parts) < 4:
                continue
            try:
                lp = parts[1].rsplit(":", 1)[1]
                rh, rp = parts[2].rsplit(":", 1)
                yield (int(lp, 16), rh, int(rp, 16), parts[3])
            except (ValueError, IndexError):
                continue


def _stream_listening():
    """True when Steam is listening on the Remote Play control port — i.e. this
    box can host, and Steam is not wedged. Never raises."""
    for lport, _rh, _rp, st in _proc_net_rows(_PROC_NET_TCP):
        if lport == _STREAM_LISTEN_PORT and st == _TCP_LISTEN:
            return True
    return False


def _stream_data_bound():
    """True while Steam holds the Remote Play DATA socket open (udp/27031).

    THE RECOVERY SIGNAL for a session that ended dirty. Steam writes
    ">>> Stopped desktop stream" only on a GRACEFUL stop — a stream host that
    crashes or gets replaced never writes one, so the session stayed "active"
    until _STREAM_MAX_S (12 HOURS) expired. Observed in the wild: a card still
    claiming a live macOS stream 27 minutes after the client disconnected.

    Measured on hardware in BOTH states, which is the bar this detector failed
    to clear the first time around:
        streaming live   udp6 :27031 present  (even with the log idle 41s)
        session dead     27031 absent entirely, while Steam kept running and
                         kept its 27037 discovery listener plus three LAN peers

    It binds BEFORE the start marker is written ("Streaming initialized and
    listening on port 27031" precedes ">>> Starting desktop stream" by ~4s), so
    cross-checking it cannot suppress a session that is merely starting up.

    Rejected alternative: log mtime staleness. Measured 41s of silence DURING a
    healthy stream, so any threshold tight enough to be useful would hide live
    sessions. Note the port binds on udp6 in practice — check both families.
    Never raises."""
    for lport, _rh, _rp, _st in _proc_net_rows(_PROC_NET_UDP):
        if lport == _STREAM_DATA_PORT:
            return True
    return False


# ---------------------------------------------------------------------------
# Steam settings deep links (/api/steam/menus)
# ---------------------------------------------------------------------------
#
# steam://open/settings/<panel> jumps straight to one page of Steam's settings.
# That is useful from a couch, where the alternative is walking a controller
# through a menu — and impossible when the thing being configured IS the
# controller.
#
# EVERY slug below was confirmed ON HARDWARE by firing it at a real box and
# screen-capturing the result. That is not belt-and-braces. This list CANNOT be
# derived by reading Steam's JS bundle: the handler builds the route from the
# panel name, so the slugs appear nowhere in it. Grepping finds a few unrelated
# legacy URLs and misses every entry here — including "bluetooth", which is
# proven to work. An earlier pass grepped, found nothing, and wrongly concluded
# no Bluetooth deep link existed.
#
# An unknown slug is NOT an error: Steam silently opens Settings on its DEFAULT
# page. So a wrong entry would present as a working button that goes somewhere
# else — worse than a missing one. Hence measured, never guessed.
#
# Verified ABSENT (Steam fell back to the default page) — do NOT re-add one of
# these without capturing the screen first: internet, ingame, notifications,
# notification, alerts, in-game, overlay, gameoverlay, ingameoverlay, interface,
# broadcast, remoteplay, remote-play, remoteplaysettings, account, voice, music,
# compatibility, developer, wifi, connectivity, steamnetwork, general,
# steamcloud, streaming, recording. Several of those panels DO exist in Steam's UI (Notifications,
# In Game, Remote Play are all visible in the sidebar) — their slugs are simply
# something else and have not been found yet.
#
# "system" is deliberately absent for a different reason: it IS the default
# page, so it is indistinguishable from an invalid slug by screen capture. It
# almost certainly works; it is omitted rather than shipped on an assumption.
STEAM_MENUS = (
    ("home", "Home"),
    ("library", "Library"),
    ("store", "Store"),
    ("downloads", "Downloads"),
    ("storage", "Storage"),
    ("gamerecording", "Game Recording"),
    ("network", "Internet"),
    ("display", "Display"),
    ("audio", "Audio"),
    ("power", "Power"),
    ("controller", "Controller"),
    ("bluetooth", "Bluetooth"),
    ("keyboard", "Keyboard"),
    ("customization", "Customization"),
    ("accessibility", "Accessibility"),
    ("friends", "Friends & Chat"),
    ("family", "Family"),
    ("cloud", "Cloud"),
    ("security", "Security"),
)
_STEAM_MENU_IDS = frozenset(m[0] for m in STEAM_MENUS)


def steammenus_available():
    """Boot-time caps hint: these are steam:// URLs and are meaningless without
    Steam. GET /api/steam/menus is the live authority. Never raises."""
    try:
        return _steam_root() is not None
    except Exception:
        return False


def steam_menus_payload():
    """The menu list, in the order the app should render it — most-reached-for
    first rather than Steam's own sidebar order."""
    return {"menus": [{"id": i, "label": label} for i, label in STEAM_MENUS]}


def open_steam_menu(menu_id):
    """Open one settings panel on the box's screen. True when dispatched.

    SECURITY: menu_id is checked against a FROZEN allowlist and never reaches a
    shell — the argv is handed to the steam binary directly. Anything not on the
    list is refused rather than forwarded, so a caller cannot steer the box to
    an arbitrary steam:// URL (steam:// can install games and run programs).
    Detached like the equivalent Action: the url handler hands off to the
    already-running client and exits."""
    if menu_id not in _STEAM_MENU_IDS:
        return False
    subprocess.Popen(
        ["steam", "steam://open/settings/%s" % menu_id],
        env=_user_env(),
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL, start_new_session=True,
    )
    return True


def streamhost_available():
    """Boot-time caps hint: Steam is present, so this box could host. The
    endpoint is the live authority. Never raises."""
    try:
        return _steam_root() is not None
    except Exception:
        return False


def stream_host_info():
    """Body for GET /api/stream-host. `active` = a Remote Play session is being
    served BY this box right now; the app shows its card only then.

    The log markers open a session; the log marker OR a released data port
    closes it. An ESTABLISHED TCP peer on 27036/27037 is NOT a session (an idle
    box has one from the router, plus one per Steam client on the LAN — a
    client's connection outlives its stream by design), and `listening` is
    context only: Steam drops that listener around a session, so gating on it
    would hide a live stream."""
    _stream_scan_log()
    listening = _stream_listening()
    with _STREAM_LOCK:
        active = bool(_STREAM_STATE["active"])
        since = _STREAM_STATE["since"]
        client = _STREAM_STATE["client"]
    if active and since and int(time.time()) - since > _STREAM_MAX_S:
        active = False                      # stale "started" with no stop line
    if active and not _stream_data_bound():
        # Dirty end: the host process died or was replaced without ever writing
        # a stop marker, so the log alone would keep this session "live" for
        # hours. Clear the shared state too, not just the local flag, so `client`
        # and `since` stop being reported. The byte cursor is deliberately left
        # alone — resetting it would re-read the whole log on the next poll.
        active = False
        with _STREAM_LOCK:
            if _STREAM_STATE["active"]:
                _STREAM_STATE["active"] = False
                _STREAM_STATE["since"] = 0
                _STREAM_STATE["client"] = None
    # NOTE: `active` is deliberately NOT gated on `listening`. Verified on real
    # hardware: Steam drops its 0.0.0.0:27036 TCP listener around a streaming
    # session (present before, gone after) while the client stays connected — so
    # gating on it would SUPPRESS a genuinely live session. The log's explicit
    # stop marker plus _STREAM_MAX_S are what clear a session; `listening` is
    # reported for context only.
    info = {"available": True, "listening": listening, "active": active}
    if active:
        if client:
            info["client"] = client
        if since:
            info["since"] = since
    return info


def mock_stream_host():
    return {"available": True, "listening": True, "active": True,
            "client": "macOS", "since": int(time.time()) - 725}


def mock_tv():
    """A box with TWO paired TVs, so the app's TV picker is reachable in the
    web harness.

    /api/tv had no mock branch, so under --mock it ran the real tv_info()
    against the dev machine, found no backend and 404'd. That made the
    multi-TV picker -- which only renders at 2+ backends -- impossible to
    exercise anywhere except a box with two TVs physically paired, which is
    exactly the state that is hardest to arrange and easiest to ship broken."""
    return {
        "available": True,
        "backend": "webos",
        "adapter": "LG webOS (10.7.0.205)",
        "backends": ["webos", "androidtv"],
        "tv_active": "webos",
        "ops": ["power_on", "power_off", "volume_up", "volume_down", "mute"],
        "box_volume": True, "tv_volume": True, "tv_power": True,
        "source_box": False, "sources": [], "screen_toggle": False,
        "keys": True, "source_key": False, "text": True,
        "text_focus_push": True, "muted": False,
        "box_volume_level": 70, "tv_volume_level": None,
    }


def mock_steamlink():
    """Stream hosts in EVERY liveness state at once.

    /api/steamlink previously had no mock branch, so under --mock it ran the
    real detector against the dev machine's filesystem, found no Steam, and
    404'd -- while set_caps(mock) advertised steamlink: True. The offline-host
    UI was therefore impossible to exercise in the web harness, which is
    exactly the surface it needed testing on.

    Covers all four states the app must render: online, cleanly offline, a host
    that stopped responding without ever disconnecting, and one never seen."""
    now = int(time.time())
    return {"available": True, "hosts": [
        {"host": "emery-pc", "last": now - 900, "online": True,
         "reason": "connected", "last_seen": now - 42,
         "games": [{"appid": 3164500, "label": "Schedule I"},
                   {"appid": 1174180, "label": "Red Dead Redemption 2"},
                   {"appid": 271590, "label": "Grand Theft Auto V"}]},
        {"host": "taylor-steamdeck", "last": now - 44536, "online": False,
         "reason": "offline (last seen 12h ago)", "last_seen": now - 44536,
         "games": [{"appid": 33230, "label": "Assassin's Creed II"},
                   {"appid": 220, "label": "Half-Life 2"}]},
        {"host": "steamdeck", "last": now - 7893, "online": False,
         "reason": "no response in 2h", "last_seen": now - 7893,
         "games": [{"appid": 1086940, "label": "Baldur's Gate 3"}]},
        {"host": "DESKTOP-MAGJDDS", "last": now - 2420082, "online": False,
         "reason": "never seen on this network", "last_seen": 0,
         "games": [{"appid": 228980, "label": "Steamworks Common Redistributables"},
                   {"appid": 3041230, "label": "Silksong"}]},
    ]}


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
# Idle-reap: drop a gamepad session that has sent us NOTHING for this long. The
# app pings every ~5s, so real silence this long means app->box is dead (a
# Game-Mode Wi-Fi blip during a Couch Mode switch leaves the socket half-dead —
# the phone keeps sending but nothing arrives, so the trackpad freezes). Reaping
# fast + closing cleanly is the ONLY reliable app->box-death signal (a box->app
# heartbeat can't detect it — it flows regardless and would just mask a dead
# outbound). Was 60s; 12s is >2x the ping so a healthy client never false-reaps.
GAMEPAD_IDLE_TIMEOUT_S = 12.0


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


def _gamepad_broadcast(obj):
    """Send one JSON frame to every live gamepad session (holder + waiters).
    Snapshots the list under the lock, then sends outside it (each _wsend_json
    takes only that socket's slock), so socket I/O never blocks GAMEPAD_LOCK.
    Best-effort: a dead socket is skipped. Used for out-of-band pushes such as
    the webOS on-TV text-focus signal (t:input_focus)."""
    with GAMEPAD_LOCK:
        entries = list(GAMEPAD_SESSIONS)
    for entry in entries:
        _wsend_json(entry, obj)


def _release_devices(entry):
    """Demote a session that stays connected as a waiter: destroy its gamepad
    (one pad per holder — the new holder brings its own) but KEEP the mouse and
    keyboard. Their frames are gated on entry["held"] anyway, and keeping them
    makes regaining control instant — re-creating them restarted the 0.5s
    enumeration-settle window, so the first swipe after a pass-back stalled
    ~500ms (measured). Mouse buttons are defensively released (a drag could be
    mid-press at demote; keyboard frames always pair press+release, so keys
    can never be left held)."""
    dev = entry.get("device")
    if dev is not None:
        # Zero the pad BEFORE destroying it, for the same reason the mouse is
        # zeroed below — that reasoning just never got applied to the pad. The
        # d-pad is a LATCHED absolute axis (DPAD_MAP -> ABS_HAT0X/Y), so a
        # demote mid-swipe tears the device down with a direction still
        # asserted. Unlike the keyboard, nothing here pairs press with release.
        try:
            dev.emit([(EV_ABS, ABS_HAT0X, 0), (EV_ABS, ABS_HAT0Y, 0)]
                     + [(EV_KEY, code, 0) for code in BTN_CODES.values()])
        except Exception:
            pass
        try:
            dev.destroy()
        except Exception:
            pass
        entry["device"] = None
    mouse = entry.get("mouse")
    if mouse is not None:
        # Skip if the device is still inside its settle window: nothing can
        # have been pressed through it yet, and emit() would block this (the
        # granter's) thread for the remainder.
        ready = getattr(mouse, "_ready_at", 0) <= time.monotonic()
        if ready:
            try:
                mouse.emit([(EV_KEY, code, 0)
                            for code in MOUSE_BTN_CODES.values()])
            except Exception:
                pass


def _make_holder(entry, mock):
    """Give `entry` the gamepad device and mark it holder, then send hello.
    A session only ever receives hello on becoming the holder (waiters get
    'waiting' instead), so hello IS the "you have control now" signal. Returns
    False (and closes the session) if uinput fails.

    Mouse/keyboard are pre-created here too: instantiation is a few ioctls
    (the enumeration settle is a deadline waited out in emit(), not a sleep in
    __init__), so by the time a human makes their first gesture the settle
    window has elapsed and the frame emits immediately. Previously they were
    created lazily on first use, which stalled the recv loop ~0.5s on the
    first swipe / keypress of EVERY session (measured 508/525ms). A create
    failure here is non-fatal — the slot stays None and the lazy path in
    _handle_frame retries on first use, reporting the error to the client."""
    # REUSE the session's existing pad on re-promotion, when one survived.
    # (_release_devices DOES destroy the pad at demotion, so usually none has —
    # an earlier version of this comment claimed otherwise.) The guard is what
    # stops a re-promotion from OVERWRITING a live ref: that orphaned the old
    # pad object with its fd still open, leaving a phantom "Microsoft X-Box 360
    # pad N" alive until the agent exited (three were found on a box after one
    # afternoon). Each orphan is also a controller Steam re-enumerates — enough
    # churn corrupted a real box's desktop controller config, and each one now
    # also inflates _own_pad_count and so hides a real controller from the
    # gaming card. Reuse keeps a handoff ping-pong presenting ONE stable
    # controller to Steam instead of a parade.
    if entry.get("device") is None:
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
    for slot, factory in (("mouse", MockMouse if mock else UInputMouse),
                          ("keyboard", MockKeyboard if mock else UInputKeyboard)):
        if entry.get(slot) is None:
            try:
                entry[slot] = factory()
            except Exception as e:
                print("[gamepad] %s pre-create failed (lazy path will retry):"
                      " %s" % (slot, e), flush=True)
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


# ---- PIN pairing (app-initiated box enrollment) ---------------------------
# A phone that discovered this box on the LAN (see the UDP responder) can enroll
# WITHOUT already having the token, via a PIN shown on the BOX'S OWN screen —
# physical-presence proof, exactly like Android-TV pairing:
#   POST /api/pair/start  (unauth): mint a 6-digit PIN, display it on the box
#     (Steam's browser -> the loopback /pair page), return the TTL.
#   POST /api/pair/finish (unauth): trade the correct PIN for the box token.
# The PIN is rendered ONLY on the loopback /pair page, so it never crosses the
# network — you must be able to SEE the box's screen. Brute force is blocked by
# a short TTL + a small attempt cap + a single live session, and repeated
# /start is debounced so a LAN peer can't spam the on-screen popup.
PAIR_PIN_TTL = 120           # seconds a displayed PIN stays valid
PAIR_PIN_MAX_ATTEMPTS = 5    # wrong PINs before the session is burned
PAIR_PIN_START_DEBOUNCE = 3  # min seconds between /start (anti on-screen spam)
PAIR_PIN_LOCK = threading.Lock()
# {"pin": "123456", "expires": mono, "attempts": int, "started": mono} or None
PAIR_PIN = None


def pair_pin_start():
    """Mint a fresh PIN + session (replacing any prior one) and return
    (pin, ttl). Debounced: within PAIR_PIN_START_DEBOUNCE of the last start the
    LIVE pin is returned unchanged, so a double-tap / retry doesn't reroll the
    number already on screen. Caller displays it on the box."""
    global PAIR_PIN
    with PAIR_PIN_LOCK:
        now = time.monotonic()
        s = PAIR_PIN
        if s and now <= s["expires"] and now - s["started"] < PAIR_PIN_START_DEBOUNCE:
            return s["pin"], int(s["expires"] - now)
        pin = "%06d" % (int.from_bytes(os.urandom(3), "big") % 1000000)
        PAIR_PIN = {"pin": pin, "expires": now + PAIR_PIN_TTL,
                    "attempts": 0, "started": now}
        return pin, PAIR_PIN_TTL


def pair_pin_active():
    """The current PIN if a session is live (for /pair to render on-screen),
    else None."""
    with PAIR_PIN_LOCK:
        if PAIR_PIN and time.monotonic() <= PAIR_PIN["expires"]:
            return PAIR_PIN["pin"]
        return None


def pair_pin_check(pin):
    """Validate a submitted PIN. True (and burns the session) on match; raises
    ValueError with a user-facing reason on no-session / expired / locked /
    wrong. A wrong guess counts toward the attempt cap."""
    global PAIR_PIN
    with PAIR_PIN_LOCK:
        s = PAIR_PIN
        if not s or time.monotonic() > s["expires"]:
            PAIR_PIN = None
            raise ValueError("no active pairing — start it again from the app")
        if s["attempts"] >= PAIR_PIN_MAX_ATTEMPTS:
            PAIR_PIN = None
            raise ValueError("too many wrong PINs — start again")
        if (pin or "").strip() != s["pin"]:
            s["attempts"] += 1
            raise ValueError("wrong PIN")
        PAIR_PIN = None                       # consume on success
        return True


def pair_show_on_box(port):
    """Open the loopback /pair page on the BOX'S own screen so the PIN is
    visible there. Game Mode -> Steam's built-in browser (steam://openurl);
    desktop -> xdg-open. Best-effort, detached, never blocks the request."""
    url = "http://localhost:%d/pair" % port
    gamescope = _couchmode_session() == "gamescope"

    def go():
        try:
            if gamescope:
                subprocess.run(["steam", "-ifrunning", "steam://openurl/" + url],
                               timeout=10)
            elif shutil.which("xdg-open"):
                subprocess.run(["xdg-open", url], timeout=10)
            elif shutil.which("steam"):
                subprocess.run(["steam", "-ifrunning", "steam://openurl/" + url],
                               timeout=10)
        except Exception:
            pass
    threading.Thread(target=go, daemon=True).start()


def render_pin_page(pin):
    """Full-screen dark page showing the pairing PIN, spaced for reading off a
    TV. A JS poll of /api/pair/status clears the PIN to a neutral 'done' once the
    session ends (paired or expired), and leaves it untouched on any fetch error
    — so the agent restarting never shows a browser error, and a successful pair
    never flashes the token QR. Built with a placeholder replace (not
    %-formatting) because the CSS contains a literal '%' (height:100%)."""
    return (
        "<!doctype html><html><head><meta charset=utf-8>"
        "<meta name=viewport content='width=device-width,initial-scale=1'>"
        "<title>Couchside pairing</title><style>"
        "html,body{margin:0;height:100%;background:#0b1220;color:#e5e7eb;"
        "font-family:system-ui,sans-serif;display:flex;flex-direction:column;"
        "align-items:center;justify-content:center;text-align:center}"
        ".t{font-size:5vh;color:#93c5fd;letter-spacing:.1em;font-weight:600}"
        ".pin{font-size:22vh;font-weight:800;letter-spacing:.15em;margin:2vh 0;"
        "font-variant-numeric:tabular-nums;color:#fff}"
        ".s{font-size:3.2vh;color:#94a3b8;max-width:80vw}"
        "</style></head><body>"
        "<div class=t>ENTER THIS PIN IN THE APP</div>"
        "<div class=pin>__PIN__</div>"
        "<div class=s>Couchside · this code is shown only on this screen</div>"
        "<script>var done=false;setInterval(function(){"
        "fetch('/api/pair/status').then(function(r){return r.json()})"
        ".then(function(d){if(d&&d.active===false&&!done){done=true;"
        "document.body.innerHTML="
        "'<div class=t>PAIRED</div><div class=s>Press B (Back) to close.</div>'"
        # Steam's browser can't be closed programmatically (neither a page-side
        # window.close()/steam:// nav nor an agent steam:// CLI dismisses it), so
        # we land on a clean PAIRED screen and tell the user how to close it.
        "}}).catch(function(){})},3000)</script>"
        "</body></html>".replace("__PIN__", " ".join(pin)))


# ---- LAN discovery responder (lets the app find this box) ------------------
# The app broadcasts COUCHSIDE_DISCOVER_MAGIC to this UDP port; the box replies
# with its identity + HTTP port so the app can list it in a "scan for boxes"
# picker (then PIN-pair, above). Bound on the SAME number as the HTTP port
# (UDP vs TCP, no clash). Reveals existence + hostname + version only — no
# token, no control. UDP broadcast is used deliberately: it is far more reliable
# than mDNS multicast RX on Android (no MulticastLock dance).
COUCHSIDE_DISCOVER_MAGIC = b"COUCHSIDE_DISCOVER?"


def _udp_discovery_responder(port):
    """Answer LAN discovery probes on UDP <port>. Best-effort daemon; a bind
    failure just disables discovery (the app can still add a box by IP)."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(("0.0.0.0", port))
    except OSError as e:
        print("[discover] responder disabled: %s" % e, flush=True)
        return
    print("[discover] UDP responder on :%d" % port, flush=True)
    while True:
        try:
            data, addr = s.recvfrom(256)
        except OSError:
            continue
        if not data.startswith(COUCHSIDE_DISCOVER_MAGIC):
            continue
        short = socket.gethostname().split(".")[0] or "couchside"
        reply = json.dumps({"couchside": True, "name": short,
                            "host": short + ".local", "port": port,
                            "version": VERSION}).encode()
        try:
            s.sendto(reply, addr)
        except OSError:
            pass


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
                # While a PIN-pairing session is live, this page IS the physical-
                # presence proof: show the big PIN (loopback-only, so only someone
                # at the box sees it). Otherwise the usual token QR.
                pin = pair_pin_active()
                html = (render_pin_page(pin) if pin
                        else render_pair_page(self._current_token(), self.port))
                self._send_html(200, html, started)
                return

            if path == "/api/pair/status":
                # Loopback-only: the on-screen /pair PIN page polls this to learn
                # when its session ended (paired/expired), so it can clear itself
                # without a blind reload. Reveals only a boolean, no secret.
                if not self._is_loopback():
                    self._send(403, {"error": "forbidden"}, started)
                    return
                self._send(200, {"active": pair_pin_active() is not None}, started)
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
                # The LAN IP the phone actually reached us on. The app caches it
                # as the box's fallback address and REFRESHES it every poll, so a
                # box added by hostname gets a working fallback and a box whose
                # DHCP lease drifts stays reachable when mDNS (.local) breaks —
                # e.g. right after an agent restart, when Game Mode WiFi
                # power-save has dropped the multicast mDNS needs. Same value as
                # /api/ping's "ip"; here it rides the poll the app already makes.
                try:
                    data["ip"] = self.connection.getsockname()[0]
                except OSError:
                    pass
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
                # create_enabled mirrors ALLOW_APP_LAUNCHERS so the app can
                # show/hide its "add launcher" control (like update apply_enabled).
                self._send(200, {"launchers": list_launchers(),
                                 "create_enabled": bool(ALLOW_APP_LAUNCHERS)},
                           started)
            elif path == "/api/downloads":
                # Always 200 (list may be empty). Old agents lack this route and
                # 404 -> the app hides the section (probe-and-appear via 404->null).
                downloads = mock_downloads() if self.mock else steam_downloads()
                self._send(200, {"downloads": downloads}, started)
            elif path == "/api/update/check":
                # Box-side update check (agent >= 2.9.5). The app reads this over
                # the LAN so the app never touches the internet; the box (already
                # internet-facing for updates) does the cached GitHub read. Old
                # agents 404 -> the app shows no banner (probe-and-appear).
                force = parse_qs(parsed.query).get("force", ["0"])[0] == "1"
                data = mock_update_check() if self.mock else update_check(force=force)
                # apply_enabled is read live (not from the cache) so the app
                # reflects the box-side toggle without waiting out the TTL.
                data = dict(data, apply_enabled=bool(ALLOW_APP_UPDATE))
                self._send(200, data, started)
            elif path.startswith("/api/steam/") and path.endswith("/cover"):
                appid = path[len("/api/steam/"):-len("/cover")]
                self._handle_steam_cover(appid, started)
            elif path == "/api/tv":
                # Probe-and-appear: 404 when no TV backend so the app shows no
                # TV strip; a body only when a backend is live.
                info = mock_tv() if self.mock else tv_info()
                if info is None:
                    self._send(404, {"error": "not found"}, started)
                else:
                    self._send(200, info, started)
            elif path == "/api/tv/discover":
                # LAN scan (mDNS + SSDP, ~3s) so the app can offer a "scan for
                # TVs" picker instead of a manual IP. Always 200 (possibly an
                # empty list) — it is an action, not a probe-and-appear cap.
                self._send(200, {"tvs": tv_discover(self.mock)}, started)
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
            elif path == "/api/couch-mode/status":
                # Full ceremony job every poll (never a delta) so a phone joining
                # mid-run catches up for free. Gated like the Couch Mode control
                # itself, so an OLD agent 404s here and the app degrades to the
                # synchronous path. Idle sentinel (id 0) before any run.
                if not (self.mock or couchmode_available()):
                    self._send(404, {"error": "couch mode unavailable"}, started)
                else:
                    self._send(200, couchmode_job_info(), started)
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
            elif path == "/api/steam/menus":
                # Steam settings deep links. Probe-and-appear: 404 without
                # Steam, so an older agent or a non-Steam box simply never
                # shows the surface. Static list, no scan, no cache needed.
                if steammenus_available() or self.mock:
                    self._send(200, steam_menus_payload(), started)
                else:
                    self._send(404, {"error": "unavailable"}, started)
            elif path == "/api/steamlink":
                # Steam Remote Play (in-home streaming) host list. Probe-and-
                # appear: 404 when no host has ever been streamed from (nothing
                # to offer) so the app hides the "Stream from PC" surface. Launch
                # is the existing POST /api/launchers/stream:<appid>.
                info = mock_steamlink() if self.mock else steamlink_info()
                if info["available"]:
                    self._send(200, info, started)
                else:
                    self._send(404, {"error": "no streamable hosts"}, started)
            elif path == "/api/gaming":
                # Live "what's running now" card. Probe-and-appear: 404 when this
                # box has no Steam (nothing to report) so old/non-gaming boxes
                # hide the card. The payload is per-field optional — a box with no
                # discrete GPU (Intel i915) simply omits the "gpu" key.
                if not self.mock and _steam_root() is None:
                    self._send(404, {"error": "no gaming context"}, started)
                else:
                    data = mock_gaming() if self.mock else _gaming_payload()
                    self._send(200, data, started)
            elif path == "/api/stream-host":
                # Steam Remote Play with this box as the HOST (phase 4a, detect
                # only — no session/display manipulation). Probe-and-appear: 404
                # without Steam. The app shows its card only while `active`.
                # Distinct from /api/steamlink, which is the CLIENT direction.
                if not self.mock and _steam_root() is None:
                    self._send(404, {"error": "no steam"}, started)
                else:
                    info = mock_stream_host() if self.mock else stream_host_info()
                    self._send(200, info, started)
            elif path == "/api/guide-hold":
                # Probe-and-appear like /api/screensaver: 404 when the box can't
                # do the handoff or can't read evdev, so the app hides the row.
                # Older apps that never ask are unaffected.
                if self.mock:
                    self._send(200, {
                        "available": True, "enabled": False, "hold_ms": 1200,
                        "uniq": "", "uniq_present": False, "session": "desktop",
                        "controllers": [
                            {"uniq": "44:16:22:1f:74:5d", "phys": "ac:f2:3c:8b:64:fe",
                             "name": "Xbox Wireless Controller", "readable": True}],
                    }, started)
                elif guide_hold_available():
                    self._send(200, guide_hold_info(), started)
                else:
                    self._send(404, {"error": "guide hold unavailable"}, started)
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

            # UNAUTHENTICATED PIN pairing (the only unauthenticated POSTs): a
            # phone that discovered this box enrolls via a PIN shown on the box's
            # own screen. Bounded: /start is debounced + displays the PIN
            # locally; /finish is TTL + attempt-capped and only returns the token
            # for the correct PIN. Handled here, before the bearer-token gate.
            if path in ("/api/pair/start", "/api/pair/finish"):
                if self._body_too_large():
                    self.close_connection = True
                    self._send(413, {"error": "request body too large"}, started)
                    return
                pair_body = self._read_body()
                if path == "/api/pair/start":
                    _pin, ttl = pair_pin_start()
                    pair_show_on_box(self.port)   # pop the PIN on the box screen
                    self._send(200, {"ok": True, "ttl": ttl}, started)
                    return
                try:
                    req = json.loads(pair_body.decode("utf-8")) if pair_body else {}
                    submitted = req.get("pin")
                except (ValueError, UnicodeDecodeError):
                    submitted = None
                try:
                    pair_pin_check(submitted)
                except ValueError as e:
                    self._send(403, {"ok": False, "error": str(e)}, started)
                    return
                self._send(200, {"ok": True, "token": self._current_token(),
                                 "port": self.port}, started)
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

            # POST /api/steam/menus {"id": "<panel>"}: open one Steam settings
            # page on the box's screen. 404 on an id that is not on the frozen
            # allowlist — Steam would silently open its DEFAULT page for an
            # unknown slug, so forwarding one would look like success while
            # landing somewhere else entirely.
            if path == "/api/steam/menus":
                # _read_body() hands back BYTES, not a parsed object — decode
                # like every other POST route here.
                try:
                    req = json.loads(body.decode("utf-8")) if body else {}
                    if not isinstance(req, dict):
                        raise ValueError("body must be a JSON object")
                except (ValueError, TypeError, UnicodeDecodeError):
                    self._send(400, {"error": "body must be a JSON object"},
                               started)
                    return
                menu_id = req.get("id")
                if not isinstance(menu_id, str) or menu_id not in _STEAM_MENU_IDS:
                    self._send(404, {"error": "unknown menu"}, started)
                    return
                if self.mock:
                    self._send(200, {"ok": True, "id": menu_id}, started)
                    return
                ok = open_steam_menu(menu_id)
                self._send(200 if ok else 500,
                           {"ok": ok, "id": menu_id}, started)
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

            # POST /api/update/apply: app-triggered box-side update. Gated by
            # ALLOW_APP_UPDATE (off by default, box-side opt-in only): 403 when
            # disabled so the capability doesn't exist for boxes that didn't
            # opt in. The installer verifies the release signature, so even an
            # authorized trigger can only install an authentic release.
            if path == "/api/update/apply":
                if not ALLOW_APP_UPDATE:
                    self._send(403, {"ok": False, "error":
                                     "app updates are disabled on this box "
                                     "(enable with: couchside allow-updates on)"},
                               started)
                    return
                result = ({"started": True, "log": "/tmp/couchside-update.log"}
                          if self.mock else update_apply())
                self._send(200, result, started)
                return

            # POST /api/wol {"mac": "..."}: broadcast a Wake-on-LAN magic packet
            # from THIS box, on behalf of a phone that cannot send one itself.
            # iOS blocks UDP for apps entirely (broadcast AND unicast), so the
            # phone's own magic packet never leaves the device; an already-awake
            # box on the same LAN relays it to wake a sleeping sibling. Reveals
            # nothing and needs the bearer token like any other control call.
            if path == "/api/wol":
                mac = body.get("mac") if isinstance(body, dict) else None
                if not isinstance(mac, str) or not mac.strip():
                    self._send(400, {"ok": False, "error": "mac required"}, started)
                    return
                result = ({"ok": True, "exit_code": 0, "stdout": "[mock] wol\n",
                           "stderr": "", "duration_ms": 1}
                          if self.mock else _wol_send(mac.strip()))
                self._send(200, result, started)
                return

            # POST /api/launchers: add a custom launcher from a JSON body. Gated
            # by ALLOW_APP_LAUNCHERS (off by default, box-side opt-in only): a
            # launcher argv is run verbatim as the desktop user, so remote CREATE
            # is arbitrary user-level command exec. 403 when disabled so a bare
            # token can only trigger owner-defined launchers, never mint new ones.
            if path == "/api/launchers":
                if not ALLOW_APP_LAUNCHERS:
                    self._send(403, {"ok": False, "error":
                                     "creating launchers from the app is disabled "
                                     "on this box (enable with: couchside "
                                     "allow-launchers on)"}, started)
                    return
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

            # POST /api/tv/key/<k>: factory-remote / nav key. The RS-232 panel
            # drives the Newline OSD; a paired webOS TV drives its pointer nav.
            # The active hardware backend selects the key vocabulary + sender.
            keyprefix = "/api/tv/key/"
            if path.startswith(keyprefix):
                k = unquote(path[len(keyprefix):])
                backend = _tv_hw_backend()
                if backend == "webos" and k in _WEBOS_KEYS:
                    result = (mock_webos("key %s" % k) if self.mock
                              else real_webos_key(k))
                elif backend == "samsung" and k in _SAMSUNG_KEYS:
                    result = (mock_samsung("key %s" % k) if self.mock
                              else real_samsung_key(k))
                elif backend == "roku" and k in _ROKU_KEYS:
                    result = (mock_roku("key %s" % k) if self.mock
                              else real_roku_key(k))
                elif backend == "androidtv" and k in _ATV_KEYS:
                    result = (mock_androidtv("key %s" % k) if self.mock
                              else real_androidtv_key(k))
                elif backend == "vidaa" and k in _VIDAA_KEYS:
                    result = (mock_vidaa("key %s" % k) if self.mock
                              else real_vidaa_key(k))
                elif backend == "panel" and k in PANEL_KEYS:
                    result = ({"ok": True, "exit_code": 0,
                               "stdout": "[mock panel] key %s" % k,
                               "stderr": "", "duration_ms": 100}
                              if self.mock else real_panel_key(k))
                else:
                    self._send(404, {"error": "unknown key"}, started)
                    return
                self._send(200, result, started)
                return

            # POST /api/tv/text: insert text into a focused on-TV field (webOS
            # IME). Body {"text": "..."}; webOS-only (tv_info.text gates it).
            if path == "/api/tv/text":
                backend = _tv_hw_backend()
                _TEXT_FNS = {
                    "webos": (mock_webos, real_webos_text),
                    "samsung": (mock_samsung, real_samsung_text),
                    "roku": (mock_roku, real_roku_text),
                }
                if backend not in _TEXT_FNS:
                    self._send(404, {"error": "no text backend"}, started)
                    return
                try:
                    req = json.loads(body.decode("utf-8")) if body else {}
                    text = req["text"]
                    if not isinstance(text, str):
                        raise ValueError("text must be a string")
                except (ValueError, TypeError, KeyError, UnicodeDecodeError):
                    self._send(400, {"error": "text must be a string"}, started)
                    return
                mock_fn, real_fn = _TEXT_FNS[backend]
                result = mock_fn("text") if self.mock else real_fn(text)
                self._send(200, result, started)
                return

            # POST /api/tv/webos/pair: pair with an LG webOS TV. Body {"host":
            # "<ip>", "mac": "<optional, for Wake-on-LAN power-on>"}. Blocks up
            # to ~60s while the TV shows an Accept prompt; on success the granted
            # client_key is persisted to config so later starts are silent.
            if path == "/api/tv/lgcommercial/add":
                # An LG commercial panel needs no pairing: the 9761 control port
                # is unauthenticated. So this just records the host after
                # confirming something actually answers there -- storing a host
                # that never responds is how a dead remote gets shipped.
                try:
                    req = json.loads(body.decode("utf-8")) if body else {}
                    host = req["host"]
                    if not isinstance(host, str) or not host:
                        raise ValueError("host required")
                    name = req.get("name")
                    if name is not None and not isinstance(name, str):
                        raise ValueError("name must be a string")
                except (ValueError, TypeError, KeyError, UnicodeDecodeError):
                    self._send(400, {"error": "host (string) required"}, started)
                    return
                if self.mock:
                    self._send(200, {"ok": True, "backend": "lgcom",
                                     "host": host}, started)
                    return
                st = lgcom_status(host)
                if not st:
                    self._send(502, {"ok": False, "error":
                                     "No LG commercial display answered on "
                                     "port %d at that address." % LGCOM_PORT},
                               started)
                    return
                try:
                    cfg = {"host": host}
                    if name:
                        cfg["name"] = name
                    global CONFIG_LGCOM
                    with CONFIG_LOCK:
                        _config_set_field("lg_commercial", cfg)
                        CONFIG_LGCOM = cfg
                except Exception as e:
                    self._send(500, {"error": "could not persist config: %s" % e},
                               started)
                    return
                self._send(200, {"ok": True, "backend": "lgcom", "host": host,
                                 "status": st}, started)
                return
            if path == "/api/tv/active":
                # Pick WHICH paired TV drives the remote. The priority chain
                # alone made a second paired TV unreachable, so this is the
                # switch that makes multiple TVs actually usable.
                try:
                    req = json.loads(body.decode("utf-8")) if body else {}
                    brand = req.get("backend")
                    if brand is not None and not isinstance(brand, str):
                        raise ValueError("backend must be a string or null")
                except (ValueError, TypeError, UnicodeDecodeError):
                    self._send(400, {"error": "backend (string or null) required"},
                               started)
                    return
                if self.mock:
                    self._send(200, {"ok": True, "tv_active": brand,
                                     "backend": brand or "webos",
                                     "backends": ["webos", "androidtv"]}, started)
                    return
                # Reject a brand this box cannot actually drive: silently
                # storing an unusable choice is how the original bug felt.
                avail = tv_backends_available()
                if brand is not None and brand not in avail:
                    self._send(400, {"error": "backend not available on this box",
                                     "backends": avail}, started)
                    return
                try:
                    set_tv_active(brand)
                except Exception as e:
                    self._send(500, {"error": "could not persist config: %s" % e},
                               started)
                    return
                self._send(200, {"ok": True, "tv_active": CONFIG_TV_ACTIVE,
                                 "backend": _tv_hw_backend(),
                                 "backends": avail}, started)
                return
            if path == "/api/tv/identify":
                # What kind of device is at this address? Lets the app pick the
                # pairing flow itself, and turn a wrong target into a sentence
                # instead of a raw TLS error.
                try:
                    req = json.loads(body.decode("utf-8")) if body else {}
                    host = req["host"]
                    if not isinstance(host, str) or not host:
                        raise ValueError("host required")
                except (ValueError, TypeError, KeyError, UnicodeDecodeError):
                    self._send(400, {"error": "host (string) required"}, started)
                    return
                if self.mock:
                    # Vary by address so the harness can drive BOTH outcomes.
                    # A mock that only ever returns "supported" leaves the
                    # unsupported path -- the whole reason identify exists --
                    # untestable outside real hardware.
                    if host.endswith(".178"):
                        self._send(200, {
                            "brand": "lg_commercial",
                            "label": "LG commercial display", "supported": False,
                            "reason": "This is an LG commercial/signage display, "
                                      "not a consumer webOS TV. It does not "
                                      "support webOS pairing."}, started)
                    elif host.endswith(".199"):
                        self._send(200, {
                            "brand": None, "label": "", "supported": False,
                            "reason": "Nothing answered at that address. Check "
                                      "the IP, and make sure the TV is powered "
                                      "on -- a TV in standby cannot be "
                                      "identified."}, started)
                    else:
                        self._send(200, {"brand": "webos", "label": "LG webOS",
                                         "supported": True,
                                         "reason": "webOS SSAP"}, started)
                    return
                self._send(200, identify_tv(host), started)
                self._send(200, {"ok": True, "tv_active": CONFIG_TV_ACTIVE,
                                 "backend": _tv_hw_backend(),
                                 "backends": avail}, started)
                return
            if path == "/api/tv/webos/pair":
                try:
                    req = json.loads(body.decode("utf-8")) if body else {}
                    host = req["host"]
                    if not isinstance(host, str) or not host:
                        raise ValueError("host required")
                    mac = req.get("mac")
                    if mac is not None and not isinstance(mac, str):
                        raise ValueError("mac must be a string")
                except (ValueError, TypeError, KeyError, UnicodeDecodeError):
                    self._send(400, {"error": "host (string) required"}, started)
                    return
                if self.mock:
                    self._send(200, {"ok": True, "paired": True,
                                     "backend": "webos", "host": host}, started)
                    return
                try:
                    client_key = webos_pair(host)
                except (IOError, OSError) as e:
                    self._send(502, {"ok": False,
                                     "error": "pairing failed: %s" % e}, started)
                    return
                try:
                    _webos_save(host, client_key, mac)
                except OSError as e:
                    self._send(500, {"ok": False,
                                     "error": "could not persist config: %s" % e},
                               started)
                    return
                set_webos(False)      # drop stale session; reconnect uses the key
                set_caps(False)       # the 'tv' capability may have turned on
                self._send(200, {"ok": True, "paired": True,
                                 "backend": "webos", "host": host}, started)
                return

            # POST /api/tv/samsung/pair: pair with a Samsung Tizen TV. Body
            # {"host": "<ip>", "mac": "<optional, for Wake-on-LAN>"}. Blocks up
            # to ~60s while the TV shows an Allow prompt; on success the granted
            # token is persisted so later starts reconnect silently.
            if path == "/api/tv/samsung/pair":
                try:
                    req = json.loads(body.decode("utf-8")) if body else {}
                    host = req["host"]
                    if not isinstance(host, str) or not host:
                        raise ValueError("host required")
                    mac = req.get("mac")
                    if mac is not None and not isinstance(mac, str):
                        raise ValueError("mac must be a string")
                except (ValueError, TypeError, KeyError, UnicodeDecodeError):
                    self._send(400, {"error": "host (string) required"}, started)
                    return
                if self.mock:
                    self._send(200, {"ok": True, "paired": True,
                                     "backend": "samsung", "host": host}, started)
                    return
                try:
                    token = samsung_pair(host)
                except (IOError, OSError) as e:
                    self._send(502, {"ok": False,
                                     "error": "pairing failed: %s" % e}, started)
                    return
                try:
                    _samsung_save(host, token, mac)
                except OSError as e:
                    self._send(500, {"ok": False,
                                     "error": "could not persist config: %s" % e},
                               started)
                    return
                set_samsung(False)
                set_caps(False)
                self._send(200, {"ok": True, "paired": True,
                                 "backend": "samsung", "host": host}, started)
                return

            # POST /api/tv/roku/add: register a Roku by host. Body {"host":
            # "<ip>"}. Roku needs no pairing — we just verify it answers ECP,
            # capture its friendly name, and persist. Returns the name.
            if path == "/api/tv/roku/add":
                try:
                    req = json.loads(body.decode("utf-8")) if body else {}
                    host = req["host"]
                    if not isinstance(host, str) or not host:
                        raise ValueError("host required")
                except (ValueError, TypeError, KeyError, UnicodeDecodeError):
                    self._send(400, {"error": "host (string) required"}, started)
                    return
                if self.mock:
                    self._send(200, {"ok": True, "added": True, "backend": "roku",
                                     "host": host, "name": "Mock Roku"}, started)
                    return
                try:
                    name = roku_add(host)
                except (IOError, OSError) as e:
                    self._send(502, {"ok": False,
                                     "error": "not a reachable Roku: %s" % e},
                               started)
                    return
                try:
                    _roku_save(host, name)
                except OSError as e:
                    self._send(500, {"ok": False,
                                     "error": "could not persist config: %s" % e},
                               started)
                    return
                set_roku(False)
                set_caps(False)
                self._send(200, {"ok": True, "added": True, "backend": "roku",
                                 "host": host, "name": name}, started)
                return

            # POST /api/tv/androidtv/pair/start: begin Android TV pairing. Body
            # {"host": "<ip>"}. Opens the pairing socket and makes the TV show a
            # 6-digit code; the socket is held for pair/finish. ~15 s.
            if path == "/api/tv/androidtv/pair/start":
                try:
                    req = json.loads(body.decode("utf-8")) if body else {}
                    host = req["host"]
                    if not isinstance(host, str) or not host:
                        raise ValueError("host required")
                except (ValueError, TypeError, KeyError, UnicodeDecodeError):
                    self._send(400, {"error": "host (string) required"}, started)
                    return
                if self.mock:
                    self._send(200, {"ok": True, "code_shown": True,
                                     "backend": "androidtv", "host": host}, started)
                    return
                try:
                    androidtv_pair_start(host)
                except (IOError, OSError, ssl.SSLError) as e:
                    self._send(502, {"ok": False,
                                     "error": "could not start pairing: %s" % e},
                               started)
                    return
                self._send(200, {"ok": True, "code_shown": True,
                                 "backend": "androidtv", "host": host}, started)
                return

            # POST /api/tv/androidtv/pair/finish: complete Android TV pairing.
            # Body {"code": "<6 hex digits from the TV>", "mac": "<optional>"}.
            if path == "/api/tv/androidtv/pair/finish":
                try:
                    req = json.loads(body.decode("utf-8")) if body else {}
                    code = req["code"]
                    if not isinstance(code, str):
                        raise ValueError("code required")
                    mac = req.get("mac")
                    if mac is not None and not isinstance(mac, str):
                        raise ValueError("mac must be a string")
                except (ValueError, TypeError, KeyError, UnicodeDecodeError):
                    self._send(400, {"error": "code (string) required"}, started)
                    return
                if self.mock:
                    self._send(200, {"ok": True, "paired": True,
                                     "backend": "androidtv"}, started)
                    return
                try:
                    cert_pem, key_pem, host = androidtv_pair_finish(code)
                except (IOError, OSError, ssl.SSLError) as e:
                    self._send(400, {"ok": False, "error": "pairing failed: %s" % e},
                               started)
                    return
                try:
                    _androidtv_save(host, cert_pem, key_pem, mac=mac)
                except OSError as e:
                    self._send(500, {"ok": False,
                                     "error": "could not persist config: %s" % e},
                               started)
                    return
                set_androidtv(False)
                set_caps(False)
                self._send(200, {"ok": True, "paired": True,
                                 "backend": "androidtv", "host": host}, started)
                return

            # POST /api/tv/vidaa/add: register a Hisense VIDAA TV by host. Body
            # {"host": "<ip>"}. No pairing — verify the MQTT broker answers, then
            # persist. Optional "mac" for Wake-on-LAN power-on.
            if path == "/api/tv/vidaa/add":
                try:
                    req = json.loads(body.decode("utf-8")) if body else {}
                    host = req["host"]
                    if not isinstance(host, str) or not host:
                        raise ValueError("host required")
                    mac = req.get("mac")
                    if mac is not None and not isinstance(mac, str):
                        raise ValueError("mac must be a string")
                except (ValueError, TypeError, KeyError, UnicodeDecodeError):
                    self._send(400, {"error": "host (string) required"}, started)
                    return
                if self.mock:
                    self._send(200, {"ok": True, "added": True, "backend": "vidaa",
                                     "host": host}, started)
                    return
                try:
                    vidaa_add(host)
                except (IOError, OSError, ssl.SSLError) as e:
                    self._send(502, {"ok": False,
                                     "error": "not a reachable VIDAA TV: %s" % e},
                               started)
                    return
                try:
                    _vidaa_save(host, host, mac)
                except OSError as e:
                    self._send(500, {"ok": False,
                                     "error": "could not persist config: %s" % e},
                               started)
                    return
                set_vidaa(False)
                set_caps(False)
                self._send(200, {"ok": True, "added": True, "backend": "vidaa",
                                 "host": host}, started)
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
                # Kick the staged ceremony and return the initial job snapshot
                # immediately; the app polls GET /api/couch-mode/status. The
                # snapshot also carries {ok, steps}, so an OLD app reading the old
                # synchronous shape is unaffected. --mock is honored inside the
                # engine (COUCHMODE_MOCK), animating a believable ceremony.
                self._send(200, couch_ceremony_start(output, hdr), started)
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
                self._send(200, couchmode_exit(), started)
                return

            # POST /api/guide-hold: opt into (or out of) the controller trigger.
            # Partial patch — omitted keys keep their current value. No box-only
            # gate: this is a user preference, not a security capability, and a
            # bearer-token holder can already switch sessions via /api/couch-mode.
            if path == "/api/guide-hold":
                if not (self.mock or guide_hold_available()):
                    self._send(404, {"error": "guide hold unavailable"}, started)
                    return
                try:
                    req = json.loads(body.decode("utf-8")) if body else {}
                    if not isinstance(req, dict):
                        raise ValueError
                except (ValueError, UnicodeDecodeError):
                    self._send(400, {"error": "json body required"}, started)
                    return
                cur = dict(CONFIG_GUIDE)
                enabled = req.get("enabled", cur.get("enabled"))
                hold_ms = req.get("hold_ms", cur.get("hold_ms"))
                uniq = req.get("uniq", cur.get("uniq"))
                if not isinstance(enabled, bool):
                    self._send(400, {"error": "enabled must be a boolean"}, started)
                    return
                if isinstance(hold_ms, bool) or not isinstance(hold_ms, int):
                    self._send(400, {"error": "hold_ms must be an integer"}, started)
                    return
                if not GUIDE_MIN_HOLD_MS <= hold_ms <= GUIDE_MAX_HOLD_MS:
                    self._send(400, {"error": "hold_ms must be %d..%d"
                                     % (GUIDE_MIN_HOLD_MS, GUIDE_MAX_HOLD_MS)},
                               started)
                    return
                if not isinstance(uniq, str):
                    self._send(400, {"error": "uniq must be a string"}, started)
                    return
                if self.mock:
                    self._send(200, {"ok": True, "enabled": enabled,
                                     "hold_ms": hold_ms, "uniq": uniq.strip()},
                               started)
                    return
                try:
                    _guide_save(enabled, hold_ms, uniq)
                except Exception as e:
                    self._send(500, {"error": "could not save: %s" % e}, started)
                    return
                set_guide(False)     # re-arm (or retire) the watcher in place
                info = guide_hold_info()
                info["ok"] = True
                self._send(200, info, started)
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
            # Pre-create mouse/keyboard NOW: the settle window burns while the
            # holder decides (human seconds), so a grant hands over devices
            # that are already past it — first input after a pass measured
            # 524ms with create-at-grant, ~7ms with create-at-wait. Input
            # stays gated on entry["held"]; a create failure just falls back
            # to the lazy path on first use.
            for slot, factory in (
                    ("mouse", MockMouse if self.mock else UInputMouse),
                    ("keyboard", MockKeyboard if self.mock else UInputKeyboard)):
                if entry.get(slot) is None:
                    try:
                        entry[slot] = factory()
                    except Exception as e:
                        print("[gamepad] waiter %s pre-create failed: %s"
                              % (slot, e), flush=True)
            print("[gamepad] %s waiting (holder %s)"
                  % (name, holder.get("name")), flush=True)

        # ---- recv loop --------------------------------------------------------
        try:
            conn.settimeout(GAMEPAD_IDLE_TIMEOUT_S)
            buf = bytearray()
            while True:
                try:
                    frame = ws_recv_frame(conn, buf)
                except ValueError as e:
                    print("[gamepad] protocol violation: %s" % e, flush=True)
                    _wsend_op(entry, WS_OP_CLOSE)
                    return
                if frame is None:  # EOF / idle timeout / socket error -> dead
                    # Tell the app cleanly (best-effort — a no-op on an already-
                    # dead socket) so an idle-reaped, half-dead session reconnects
                    # promptly instead of waiting out the app's own watchdog.
                    _wsend_op(entry, WS_OP_CLOSE)
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
    if not args.mock:
        check_config_writable()  # warn loudly if pairings/launchers can't persist
    _inject_session_actions()
    _inject_suspend_action(args.mock)
    _inject_decky_action(args.mock)
    _inject_bluetooth_action(args.mock)
    set_tv(args.mock)
    set_mpris(args.mock)
    set_screen(args.mock)
    set_power_schedule(args.mock)
    set_screensaver(args.mock)
    set_guide(args.mock)  # arms the guide-hold watcher when opted in
    set_couchmode(args.mock)  # ceremony engine honors --mock
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
    threading.Thread(target=_udp_discovery_responder, args=(port,),
                     daemon=True, name="discover").start()
    mode = "mock" if args.mock else "real"
    print("%s %s listening on %s:%d (%s mode)" % (
        APP_NAME, VERSION, args.host, port, mode), flush=True)
    info = tv_info()
    print("tv: %s" % ("%s (%s)" % (info["backend"], info["adapter"])
                      if info else "unavailable"), flush=True)
    print("mpris: %s" % ("available" if BUSCTL else "unavailable"), flush=True)
    # Report the LIVE view: the startup dict now holds only static capability,
    # and the banner should say what would actually be captured right now.
    _scr = _screen_live()
    print("screen: %s" % (("%s (%s)" % (_scr["session"], ",".join(_scr["backends"])))
                          if _scr else "unavailable"), flush=True)
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
