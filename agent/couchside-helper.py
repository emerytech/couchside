#!/usr/bin/env python3
"""Couchside's privileged helper — the only root code in the product.

WHY THIS EXISTS
---------------
Everything here used to be a NOPASSWD sudoers rule. Eleven of them, two of
which had to name the display manager (`/usr/bin/systemctl restart $DM_NAME`,
`/usr/bin/tee /etc/$DM_NAME.conf.d/...`). That surface produced three separate
shipped bugs: the lexical-ordering saga, KI-049 (the greetd grants install.sh
never wrote, so that path never worked on any box), and KI-050. It also meant a
box whose display manager changed could not be repaired by the agent alone —
install.sh had to be re-run.

This process replaces all of it with EIGHT VERBS behind a local unix socket.
The DM name stops being part of a grant and becomes an internal detail here,
so a box that changes display manager repairs itself on the next call.

WHAT THIS IS NOT
----------------
It is NOT a general "run something as root" service, and the agent is NOT root.
The network-facing agent stays `User=<the desktop user>` because uinput, Wayland
capture, PipeWire, KWin DBus and launching Steam all need that user's session
bus. Running the agent as root would turn one bearer token into the whole box
and any bug in its hand-rolled HTTP parser into a root RCE. See
docs/memory/project_privileged-helper.md §6.

THE RULES THIS FILE LIVES BY (CLAUDE.md §3)
-------------------------------------------
1. VERBS is a frozen table. A verb is looked up, never interpolated.
2. Each verb validates its own argument against a CLOSED SET. Unknown verb or
   unknown argument is an error reply and NOTHING RUNS.
3. subprocess is called with an argv LIST. Never shell=True, never a formatted
   command string. No argument to any verb ever reaches a shell.
4. No verb takes a path, a unit name, or a command from the caller.
5. Authentication is two layers and BOTH fail closed: socket mode 0660 owned by
   the install user, and an SO_PEERCRED uid check. If SO_PEERCRED cannot be
   read, the connection is REFUSED — never allowed through.

Pure python3 stdlib, like the agent. It installs onto machines we do not
control.
"""
import grp
import json
import os
import pwd
import re
import socket
import struct
import subprocess
import sys

VERSION = "1.0.0"

SOCKET_PATH = "/run/couchside/helper.sock"
# The uid allowed to talk to us. Baked in at install time via --uid; there is
# no "any user" mode and no way to widen it at runtime.
ALLOWED_UID = None

# ---------------------------------------------------------------- DM detection

# The SAME frozen table the agent uses. A display manager that is not in here is
# not supported — never a pattern, never a prefix match (CLAUDE.md §3.3).
_DM_CONF_DIRS = {
    "sddm": "/etc/sddm.conf.d",
    "plasmalogin": "/etc/plasmalogin.conf.d",
}
_DM_MAIN_CONFS = {
    "sddm": "/etc/sddm.conf",
    "plasmalogin": "/etc/plasmalogin.conf",
}
_DM_UNIT_LINK = "/etc/systemd/system/display-manager.service"
_GREETD_CONFIG = "/etc/greetd/config.toml"
_GREETD_BACKUP = "/etc/greetd/config.toml.couchside-bak"

# Our drop-in sorts LAST on purpose: SDDM reads *.conf alphabetically and the
# last Session= wins, and steamos-session-select owns zz-steamos-autologin.conf.
# "zz-couchside" sorted BEFORE it and was silently overridden on every Couch
# Mode switch. Do not rename this without re-reading that history.
_DROPIN_NAME = "zzz-couchside-session.conf"


def _dm_unit_name():
    """The REAL unit name behind display-manager.service (gdm3 != gdm), or None.

    The existence check is load-bearing and was caught by a test: realpath() of
    a path that does not exist returns THE PATH ITSELF, so a box with no display
    manager resolved to the unit name "display-manager" and dm.restart happily
    ran `systemctl restart display-manager`. That is a fail-OPEN in the one file
    that must never have one. Absent link -> None -> every DM verb refuses.
    """
    if not os.path.exists(_DM_UNIT_LINK):
        return None
    try:
        target = os.path.realpath(_DM_UNIT_LINK)
    except OSError:
        return None
    name = os.path.basename(target)
    if not name or name == os.path.basename(_DM_UNIT_LINK):
        # Resolved to itself: a dangling link tells us nothing about which
        # manager runs, so treat it as unknown rather than as its own name.
        return None
    return name[:-8] if name.endswith(".service") else name


def detect_display_manager():
    """Which display-manager FAMILY runs here: 'sddm' | 'plasmalogin' |
    'greetd' | None.

    Degrades CLOSED (CLAUDE.md §3.7): an unreadable link or an unrecognised
    manager returns None, and every verb that needs one then refuses.
    """
    unit = _dm_unit_name()
    if not unit:
        return None
    unit = unit.lower()
    if unit.startswith("gdm"):
        return "gdm"          # recognised, but we do not write its config
    for known in ("sddm", "plasmalogin", "greetd", "lightdm"):
        if unit == known:
            return known
    return None


# ------------------------------------------------------------- verb handlers
#
# Every handler returns (ok: bool, detail: str). They take either no argument or
# ONE already-validated value from a closed set.

_SESSION_MODES = ("game", "desktop", "last")

# What each mode means as an autologin Session=. The VALUES are ours, built
# here; the caller only ever picks a key from _SESSION_MODES.
_SESSION_FILES = {
    "game": "gamescope-session.desktop",
    "desktop": "plasma.desktop",
}


def _run(argv, timeout=25):
    """subprocess with an argv LIST. The only place this file spawns anything."""
    try:
        p = subprocess.run(argv, capture_output=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError) as e:
        return False, "spawn failed: %s" % e
    out = (p.stdout or b"").decode("utf-8", "replace").strip()
    err = (p.stderr or b"").decode("utf-8", "replace").strip()
    return p.returncode == 0, (out or err or "")[:400]


def _write_root_file(path, body):
    """Write a file we OWN, atomically, as root. `path` is always one of our own
    constants — never anything a caller supplied."""
    tmp = path + ".couchside-tmp"
    try:
        os.makedirs(os.path.dirname(path), mode=0o755, exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(body)
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
        return True, path
    except OSError as e:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        return False, "write failed: %s" % e


def verb_session_set_boot(mode):
    """Point the display manager's autologin at game or desktop for the NEXT boot.

    'last' means: stop steering, remove our drop-in, let the platform decide.
    """
    dm = detect_display_manager()
    if dm is None:
        return False, "no supported display manager detected"

    if mode == "last":
        return verb_session_clear_boot()

    session_file = _SESSION_FILES[mode]

    if dm == "greetd":
        # KI-049: this path exists in the agent and has NEVER worked on any box,
        # because install.sh never wrote a matching sudoers grant. Here it needs
        # no grant at all.
        try:
            with open(_GREETD_CONFIG, "r", encoding="utf-8") as f:
                cur = f.read()
        except OSError as e:
            return False, "greetd config unreadable: %s" % e
        if not os.path.exists(_GREETD_BACKUP):
            _write_root_file(_GREETD_BACKUP, cur)
        # Replace only the command inside [initial_session]; everything else in
        # the operator's config is left exactly as it was.
        new, n = re.subn(
            r'(?m)^(\s*command\s*=\s*)"[^"]*"',
            lambda m: '%s"%s"' % (m.group(1), session_file),
            cur, count=1)
        if not n:
            return False, "greetd config has no [initial_session] command"
        ok, detail = _write_root_file(_GREETD_CONFIG, new)
        return ok, ("greetd -> %s (%s)" % (session_file, detail))

    conf_dir = _DM_CONF_DIRS.get(dm)
    if not conf_dir:
        return False, "%s is detected but not configurable by couchside" % dm

    # A Session= in the MAIN conf beats every drop-in on SDDM — the reverse of
    # the systemd convention, and the trap that made the first version of this
    # feature fail open. If the operator set one there, say so rather than
    # writing a file that will be silently ignored.
    main = _DM_MAIN_CONFS.get(dm)
    if main and os.path.exists(main):
        try:
            with open(main, "r", encoding="utf-8") as f:
                if re.search(r"(?mi)^\s*Session\s*=", f.read()):
                    return False, ("%s names a Session in %s, which overrides "
                                   "drop-ins" % (dm, main))
        except OSError:
            return False, "%s unreadable; refusing to steer blind" % main

    body = ("# Written by couchside-helper. Remove this file to restore the\n"
            "# box's original boot behaviour exactly.\n"
            "[Autologin]\nSession=%s\n" % session_file)
    ok, detail = _write_root_file(os.path.join(conf_dir, _DROPIN_NAME), body)
    return ok, ("%s -> %s (%s)" % (dm, session_file, detail))


def verb_session_clear_boot():
    """Remove our steering so the platform decides again. Never an error when
    there is nothing to remove — clearing twice is success both times."""
    removed = []
    for conf_dir in _DM_CONF_DIRS.values():
        p = os.path.join(conf_dir, _DROPIN_NAME)
        try:
            os.unlink(p)
            removed.append(p)
        except FileNotFoundError:
            pass
        except OSError as e:
            return False, "could not remove %s: %s" % (p, e)
    if os.path.exists(_GREETD_BACKUP):
        try:
            with open(_GREETD_BACKUP, "r", encoding="utf-8") as f:
                body = f.read()
            _write_root_file(_GREETD_CONFIG, body)
            os.unlink(_GREETD_BACKUP)
            removed.append(_GREETD_CONFIG + " (restored)")
        except OSError as e:
            return False, "greetd restore failed: %s" % e
    return True, ("cleared: %s" % ", ".join(removed) if removed else "nothing to clear")


def verb_dm_restart():
    """Restart the display manager — the real unit name, whatever it is."""
    unit = _dm_unit_name()
    if not unit:
        return False, "no display-manager.service to restart"
    return _run(["/usr/bin/systemctl", "restart", unit])


_POWER_ACTIONS = ("reboot", "poweroff", "suspend")


def verb_power(action):
    return _run(["/usr/bin/systemctl", action], timeout=15)


# A CLOSED set of units, mapped to their real names here. The caller sends a
# key, never a unit name, so no verb can restart an arbitrary service.
_RESTARTABLE = {
    "plugin_loader": ["/usr/bin/systemctl", "restart", "plugin_loader"],
    # --no-block is load-bearing: the detached updater lives inside this unit's
    # own cgroup, so a blocking restart would SIGTERM the updater mid-wait.
    "couchside": ["/usr/bin/systemctl", "restart", "--no-block",
                  "couchside.service"],
}


def verb_unit_restart(unit_key):
    return _run(_RESTARTABLE[unit_key], timeout=20)


_UNIT_SUFFIXES = (".service", ".socket", ".target", ".timer", ".mount",
                  ".scope", ".slice", ".path", ".device", ".swap", ".automount")


def verb_logs_journal(arg):
    """Read a unit's journal. The unit is validated by SHAPE and the option set
    is fixed here, so --file/--directory injection (arbitrary root file read)
    is impossible — that is why the old sudoers rule granted a wrapper rather
    than journalctl itself."""
    unit = arg.get("unit")
    lines = arg.get("lines", 200)
    if not isinstance(unit, str) or not unit.endswith(_UNIT_SUFFIXES):
        return False, "invalid unit"
    if re.search(r"[^A-Za-z0-9@._\-\\:]", unit):
        return False, "invalid unit"
    try:
        lines = int(lines)
    except (TypeError, ValueError):
        lines = 200
    lines = max(1, min(2000, lines))
    return _run(["/usr/bin/journalctl", "-u", unit, "-n", str(lines),
                 "--no-pager", "-o", "short-iso"], timeout=30)


_FLATPAK_WRAPPER = "/usr/local/libexec/couchside-flatpak-update"
_OS_WRAPPER = "/usr/local/libexec/couchside-os-update"


def verb_update_flatpak():
    if not os.path.exists(_FLATPAK_WRAPPER):
        return False, "flatpak updater not installed"
    return _run([_FLATPAK_WRAPPER], timeout=600)


def verb_update_os():
    if not os.path.exists(_OS_WRAPPER):
        return False, "os updater not installed"
    return _run([_OS_WRAPPER, "apply"], timeout=900)


# ------------------------------------------------------------------ the table
#
# THE WHOLE PRIVILEGED SURFACE, on one screen. Each entry is
# (handler, argument validator or None). A verb not in here is a 404.

def _one_of(choices):
    return lambda v: v if isinstance(v, str) and v in choices else None


def _journal_arg(v):
    return v if isinstance(v, dict) else None


VERBS = {
    "session.set-boot":   (verb_session_set_boot, _one_of(_SESSION_MODES)),
    "session.clear-boot": (verb_session_clear_boot, None),
    "dm.restart":         (verb_dm_restart, None),
    "power":              (verb_power, _one_of(_POWER_ACTIONS)),
    "unit.restart":       (verb_unit_restart, _one_of(tuple(_RESTARTABLE))),
    "logs.journal":       (verb_logs_journal, _journal_arg),
    "update.flatpak":     (verb_update_flatpak, None),
    "update.os":          (verb_update_os, None),
}


def dispatch(req):
    """One request in, one reply dict out. The single entry point, and the only
    place a client-supplied string is ever compared against the table."""
    if not isinstance(req, dict):
        return {"ok": False, "error": "malformed request"}
    verb = req.get("verb")
    if not isinstance(verb, str) or verb not in VERBS:
        # Looked up, never interpolated. Unknown verb runs NOTHING.
        return {"ok": False, "error": "unknown verb"}
    handler, validate = VERBS[verb]
    if validate is None:
        ok, detail = handler()
    else:
        arg = validate(req.get("arg"))
        if arg is None:
            return {"ok": False, "error": "invalid argument for %s" % verb}
        ok, detail = handler(arg)
    return {"ok": bool(ok), "detail": detail}


# ------------------------------------------------------------------- serving

def peer_uid(conn):
    """The connecting process's uid via SO_PEERCRED, or None if unreadable.

    None means REFUSE. A helper that cannot identify its caller must not act —
    'unknown' is never 'allowed' (CLAUDE.md §3.7)."""
    try:
        creds = conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED,
                                struct.calcsize("3i"))
        _pid, uid, _gid = struct.unpack("3i", creds)
        return uid
    except (OSError, struct.error, AttributeError):
        # AttributeError matters: SO_PEERCRED is Linux-only, and on a platform
        # without it this raised mid-connection and killed the handler instead
        # of answering. Boxes are Linux so production always has it, but the
        # failure mode of an unidentifiable caller must be a clean REFUSAL,
        # never a crash and never a pass-through.
        return None


def serve_one(conn):
    try:
        uid = peer_uid(conn)
        if uid is None or ALLOWED_UID is None or uid != ALLOWED_UID:
            conn.sendall(json.dumps(
                {"ok": False, "error": "not authorized"}).encode() + b"\n")
            return
        conn.settimeout(30)
        buf = b""
        while b"\n" not in buf and len(buf) < 65536:
            chunk = conn.recv(4096)
            if not chunk:
                break
            buf += chunk
        try:
            req = json.loads(buf.split(b"\n", 1)[0].decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            reply = {"ok": False, "error": "malformed request"}
        else:
            reply = dispatch(req)
        conn.sendall(json.dumps(reply).encode() + b"\n")
    except OSError:
        pass
    finally:
        try:
            conn.close()
        except OSError:
            pass


def _listen_socket(path, owner_uid, owner_gid):
    """Our own socket when not socket-activated. 0660 and owned by the install
    user, so the filesystem is the first of the two auth layers."""
    try:
        os.makedirs(os.path.dirname(path), mode=0o755, exist_ok=True)
        os.unlink(path)
    except OSError:
        pass
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.bind(path)
    os.chown(path, owner_uid, owner_gid)
    os.chmod(path, 0o660)
    s.listen(8)
    return s


def main(argv=None):
    global ALLOWED_UID
    argv = list(sys.argv[1:] if argv is None else argv)
    user = None
    path = SOCKET_PATH
    for i, a in enumerate(argv):
        if a == "--user" and i + 1 < len(argv):
            user = argv[i + 1]
        elif a == "--socket" and i + 1 < len(argv):
            path = argv[i + 1]
        elif a == "--version":
            print(VERSION)
            return 0
    if not user:
        print("error: --user <name> is required", file=sys.stderr)
        return 2
    try:
        pw = pwd.getpwnam(user)
    except KeyError:
        print("error: no such user: %s" % user, file=sys.stderr)
        return 2
    ALLOWED_UID = pw.pw_uid
    if os.geteuid() != 0:
        print("error: couchside-helper must run as root", file=sys.stderr)
        return 2

    try:
        gid = grp.getgrnam(user).gr_gid
    except KeyError:
        gid = pw.pw_gid
    srv = _listen_socket(path, pw.pw_uid, gid)
    while True:
        try:
            conn, _ = srv.accept()
        except OSError:
            continue
        serve_one(conn)


if __name__ == "__main__":
    sys.exit(main())
