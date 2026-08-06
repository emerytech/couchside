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
# ONE already-validated value.

# Where sessions live. The set of acceptable Session= values is DERIVED FROM
# THESE DIRECTORIES at call time — a box-owned closed set, not a caller-owned
# one. The caller names a basename; if it is not a file in one of these dirs,
# the verb refuses. This is deliberate and load-bearing: a hardcoded
# mode->file table here would re-create the 2026-07-27 stranding, where
# "plasmax11.desktop" (a SteamOS name) was written on a Bazzite box that ships
# no such session — SDDM logged "Autologin failed!" and the box came up at the
# GREETER, with no agent and no way for the phone to undo it. The agent owns
# the mode->file selection because its version is the one that learned that
# lesson; the helper only verifies and writes.
_SESSION_DIRS = ("/usr/share/wayland-sessions", "/usr/share/xsessions")


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


def _session_installed(name):
    """True when `name` is a session file that exists on THIS box.

    The validation is by membership in a directory listing, never by cleaning
    the input (CLAUDE.md §3.6): a basename containing a separator or a dot-dot
    can never equal a listdir() entry, so traversal is structurally impossible
    rather than filtered."""
    if not isinstance(name, str) or not name.endswith(".desktop"):
        return False
    for d in _SESSION_DIRS:
        try:
            if name in os.listdir(d):
                return True
        except OSError:
            continue
    return False


def verb_session_set_boot(session_file):
    """Point the display manager's autologin at an INSTALLED session for the
    next boot. The caller (the agent) picks which; we verify it exists and
    build the file body ourselves — nothing from the caller lands in the file
    except the verified basename."""
    dm = detect_display_manager()
    if dm is None:
        return False, "no supported display manager detected"

    if dm == "greetd":
        # DELIBERATELY UNSUPPORTED for now (KI-049 stays open). The agent's own
        # greetd writer validates the session's Exec and composes around the
        # operator's config; duplicating a lesser version of that here would be
        # a worse copy of code that has never run on any real box — there is no
        # greetd machine on this LAN to verify against. Refusing is honest;
        # Phase 2 owns it.
        return False, "greetd: not yet supported by the helper"

    if not _session_installed(session_file):
        # The 2026-07-27 stranding rule: never write an autologin for a session
        # this box does not have. SDDM fails the autologin and parks the box at
        # the greeter — where there is no agent and no way back from the phone.
        return False, "session %r is not installed on this box" % (session_file,)

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
    # greetd is DELIBERATELY not touched here. The helper never writes greetd
    # (see verb_session_set_boot), and "restore a backup we did not make" could
    # clobber operator edits made since the agent's own writer took it. Phase 2
    # owns greetd end to end.
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


# WHERE install.sh ACTUALLY PUTS THESE. They were /usr/local/libexec/... here
# while the installer has always written them to /etc/couchside/ — so
# os.path.exists() below was False on every box and both update verbs reported
# "unavailable" forever. Degrading closed kept it SAFE, which is exactly why it
# went unnoticed. Keep these in step with FLATPAK_UPDATE_WRAPPER / OS_UPDATE_WRAPPER
# in install.sh; that directory is root-owned, so the user can execute but never
# modify what root runs.
_FLATPAK_WRAPPER = "/etc/couchside/couchside-flatpak-update"
_OS_WRAPPER = "/etc/couchside/couchside-os-update"


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


def _session_file_arg(v):
    """A session-file BASENAME. Shape only — existence is checked by the verb
    against the box's own session dirs. A separator or a traversal component
    can never match a listdir() entry, but reject the shape here too so the
    refusal is visible at the boundary."""
    if not isinstance(v, str) or not v.endswith(".desktop"):
        return None
    if "/" in v or "\\" in v or v.startswith("."):
        return None
    return v


VERBS = {
    "session.set-boot":   (verb_session_set_boot, _session_file_arg),
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

    # systemd socket activation: the socket unit owns the listening socket and
    # hands it to us as fd 3 (LISTEN_FDS). Binding our own here would UNLINK
    # systemd's socket out from under it and the two would fight over the path.
    # The env check is the standard sd_listen_fds contract, pure stdlib.
    srv = None
    if os.environ.get("LISTEN_PID") == str(os.getpid()) and \
            int(os.environ.get("LISTEN_FDS", "0") or 0) >= 1:
        srv = socket.socket(fileno=3)
    if srv is None:
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
